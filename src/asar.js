'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { copyRange, sha256, sha256Hex, u32 } = require('./util');

const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const stat = fs.fstatSync(fd);
  const prefix = Buffer.alloc(16);
  fs.readSync(fd, prefix, 0, 16, 0);
  const headerSize = prefix.readUInt32LE(4);
  const jsonLength = prefix.readUInt32LE(12);
  if (jsonLength <= 0 || 16 + jsonLength > stat.size) {
    fs.closeSync(fd);
    throw new Error('Invalid ASAR header');
  }
  const json = Buffer.alloc(jsonLength);
  fs.readSync(fd, json, 0, jsonLength, 16);
  let header;
  try {
    header = JSON.parse(json.toString('utf8'));
  } catch (error) {
    fs.closeSync(fd);
    throw new Error(`Invalid ASAR header JSON: ${error.message}`);
  }
  const payloadBase = 8 + headerSize;
  if (!header.files || payloadBase > stat.size) {
    fs.closeSync(fd);
    throw new Error('Invalid ASAR directory');
  }
  return { fd, stat, headerSize, jsonLength, json, header, payloadBase };
}

function collectEntries(header) {
  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, full);
      else entries.push({ path: full, node: child });
    }
  };
  walk(header, '');
  return entries;
}

function integrityFor(data) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += INTEGRITY_BLOCK_SIZE) {
    blocks.push(sha256Hex(data.subarray(offset, Math.min(offset + INTEGRITY_BLOCK_SIZE, data.length))));
  }
  return {
    algorithm: 'SHA256',
    hash: sha256Hex(data),
    blockSize: INTEGRITY_BLOCK_SIZE,
    blocks
  };
}

function readEntry(asar, node) {
  const offset = asar.payloadBase + Number(node.offset);
  const buffer = Buffer.alloc(node.size);
  const read = fs.readSync(asar.fd, buffer, 0, node.size, offset);
  if (read !== node.size) throw new Error('Truncated ASAR entry');
  return buffer;
}

function findEntry(entries, wanted) {
  const found = entries.find((entry) => entry.path === wanted);
  if (!found) throw new Error(`ASAR entry not found: ${wanted}`);
  return found;
}

function rebuildAsar(asarPath, options) {
  const { bootstrapPath, bootstrapSource, packageJsonPath = 'package.json' } = options;
  const asar = readHeader(asarPath);
  const entries = collectEntries(asar.header);
  const replacements = options.replacements instanceof Map
    ? options.replacements
    : new Map(Object.entries(options.replacements || {}));
  const packageEntry = findEntry(entries, packageJsonPath);
  const packageObject = JSON.parse(readEntry(asar, packageEntry.node).toString('utf8'));
  const mainPath = options.mainPath || packageObject.main;
  if (!mainPath) throw new Error('package.json has no main entry');
  const mainEntry = findEntry(entries, mainPath);
  if (mainEntry.node.unpacked || mainEntry.node.link) throw new Error('Main entry must be a packed regular file');

  const bootstrap = Buffer.from(bootstrapSource, 'utf8');
  const nextPackage = { ...packageObject, main: bootstrapPath };
  const packageBuffer = Buffer.from(`${JSON.stringify(nextPackage, null, 2)}\n`, 'utf8');

  const originalSizes = new Map(entries.map((entry) => [entry.path, entry.node.size]));
  packageEntry.node.size = packageBuffer.length;
  packageEntry.node.integrity = integrityFor(packageBuffer);

  if (asar.header.files[path.basename(bootstrapPath)]) {
    throw new Error(`ASAR already contains ${bootstrapPath}`);
  }
  const bootstrapNode = { size: bootstrap.length, integrity: integrityFor(bootstrap) };
  asar.header.files[path.basename(bootstrapPath)] = bootstrapNode;

  const originalOffsets = new Map(entries.map((entry) => [entry.path, entry.node.offset]));

  for (const [replacePath, data] of replacements) {
    const entry = findEntry(entries, replacePath);
    if (entry.node.unpacked || entry.node.link) {
      throw new Error(`Replacement target must be a packed regular file: ${replacePath}`);
    }
    if (replacePath === mainPath || replacePath === packageJsonPath || replacePath === bootstrapPath) {
      throw new Error(`Replacement cannot target ${replacePath}`);
    }
    entry.node.size = data.length;
    entry.node.integrity = integrityFor(data);
  }

  let cursor = 0;
  const writes = [];
  for (const entry of entries) {
    if (entry.node.link || entry.node.unpacked) continue;
    entry.node.offset = String(cursor);
    cursor += entry.node.size;
    writes.push(entry);
  }
  bootstrapNode.offset = String(cursor);
  cursor += bootstrapNode.size;
  writes.push({ path: bootstrapPath, node: bootstrapNode });

  const json = Buffer.from(JSON.stringify(asar.header), 'utf8');
  const padding = (4 - (json.length % 4)) % 4;
  const headerSize = 8 + json.length + padding;
  const payloadBase = 8 + headerSize;

  const temporary = `${asarPath}.codexpp-new`;
  const output = fs.openSync(temporary, 'w');
  try {
    fs.writeSync(output, Buffer.concat([
      u32(4),
      u32(headerSize),
      u32(4 + json.length + padding),
      u32(json.length),
      json,
      Buffer.alloc(padding)
    ]), 0, 16 + json.length + padding, 0);

    for (const entry of writes) {
      const destination = payloadBase + Number(entry.node.offset);
      const replacement = replacements.get(entry.path);
      if (replacement) {
        fs.writeSync(output, replacement, 0, replacement.length, destination);
      } else if (entry.path === packageJsonPath) {
        fs.writeSync(output, packageBuffer, 0, packageBuffer.length, destination);
      } else if (entry.path === bootstrapPath) {
        fs.writeSync(output, bootstrap, 0, bootstrap.length, destination);
      } else {
        copyRange(
          asar.fd, output,
          asar.payloadBase + Number(originalOffsets.get(entry.path)),
          destination,
          originalSizes.get(entry.path)
        );
      }
    }
    fs.fsyncSync(output);
  } finally {
    fs.closeSync(output);
    fs.closeSync(asar.fd);
  }

  const headerHash = sha256Hex(json);
  fs.rmSync(asarPath, { force: true });
  fs.renameSync(temporary, asarPath);

  const verify = readHeader(asarPath);
  try {
    if (sha256Hex(verify.json) !== headerHash) throw new Error('ASAR header hash changed after write');
    const verifiedMain = findEntry(collectEntries(verify.header), bootstrapPath);
    if (!verifiedMain.node.size) throw new Error('ASAR bootstrap entry is empty');
  } finally {
    fs.closeSync(verify.fd);
  }

  return {
    headerHash,
    headerSize,
    jsonLength: json.length,
    payloadBase,
    mainPath,
    bootstrapPath,
    mainSize: mainEntry.node.size,
    asarSize: fs.statSync(asarPath).size
  };
}

function readAsarFile(asarPath, wantedPath) {
  const asar = readHeader(asarPath);
  try {
    const entry = findEntry(collectEntries(asar.header), wantedPath);
    return readEntry(asar, entry.node);
  } finally {
    fs.closeSync(asar.fd);
  }
}

module.exports = {
  readHeader,
  collectEntries,
  integrityFor,
  rebuildAsar,
  readAsarFile,
  readEntry,
  findEntry
};
