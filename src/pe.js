'use strict';

const fs = require('node:fs');

function parsePe(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const read = (offset, length) => {
    const buffer = Buffer.alloc(length);
    const readBytes = fs.readSync(fd, buffer, 0, length, offset);
    if (readBytes !== length) throw new Error(`Truncated PE file at ${offset}`);
    return buffer;
  };
  try {
    const dos = read(0, 64);
    const peOffset = dos.readUInt32LE(0x3c);
    const pe = read(peOffset, 24);
    if (pe.toString('latin1', 0, 4) !== 'PE\0\0') throw new Error('Not a PE file');
    const coff = peOffset + 4;
    const numberOfSections = read(coff + 2, 2).readUInt16LE(0);
    const optionalHeaderSize = read(coff + 16, 2).readUInt16LE(0);
    const optional = coff + 20;
    const magic = read(optional, 2).readUInt16LE(0);
    const dataDirectory = optional + (magic === 0x20b ? 112 : 96);
    const resourceRva = read(dataDirectory + 2 * 8, 4).readUInt32LE(0);
    const resourceSize = read(dataDirectory + 2 * 8 + 4, 4).readUInt32LE(0);
    if (!resourceRva || !resourceSize) throw new Error('PE file has no resource directory');
    const sectionOffset = optional + optionalHeaderSize;
    const sections = [];
    for (let index = 0; index < numberOfSections; index += 1) {
      const header = read(sectionOffset + index * 40, 40);
      sections.push({
        name: header.toString('latin1', 0, 8).replace(/\0+$/, ''),
        virtualSize: header.readUInt32LE(8),
        virtualAddress: header.readUInt32LE(12),
        rawSize: header.readUInt32LE(16),
        rawOffset: header.readUInt32LE(20)
      });
    }
    const rvaToOffset = (rva) => {
      for (const section of sections) {
        const span = Math.max(section.virtualSize, section.rawSize);
        if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
          return section.rawOffset + (rva - section.virtualAddress);
        }
      }
      throw new Error(`RVA ${rva} is not inside any PE section`);
    };
    return { fd, size, read, sections, resourceRva, resourceSize, rvaToOffset };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readResourceName(read, offset) {
  const length = read(offset, 2).readUInt16LE(0);
  return read(offset + 2, length * 2).toString('utf16le');
}

function findResource(file, typeName, name) {
  const pe = parsePe(file);
  try {
    const base = pe.rvaToOffset(pe.resourceRva);
    const wanted = new Set([String(typeName).toLowerCase(), String(name).toLowerCase()]);
    let found = null;
    const walk = (directoryOffset, depth, trail) => {
      if (found || depth > 3) return;
      const namedEntries = pe.read(directoryOffset + 12, 2).readUInt16LE(0);
      const idEntries = pe.read(directoryOffset + 14, 2).readUInt16LE(0);
      for (let index = 0; index < namedEntries + idEntries; index += 1) {
        if (found) return;
        const entry = pe.read(directoryOffset + 16 + index * 8, 8);
        const nameField = entry.readUInt32LE(0);
        const offsetField = entry.readUInt32LE(4);
        const entryName = (nameField & 0x80000000)
          ? readResourceName(pe.read, base + (nameField & 0x7fffffff))
          : String(nameField);
        const target = base + (offsetField & 0x7fffffff);
        const nextTrail = [...trail, entryName];
        if (offsetField & 0x80000000) {
          walk(target, depth + 1, nextTrail);
        } else {
          const dataRva = pe.read(target, 4).readUInt32LE(0);
          const dataSize = pe.read(target + 4, 4).readUInt32LE(0);
          const matched = trail.length >= 2
            && wanted.has(String(trail[0]).toLowerCase())
            && wanted.has(String(trail[1]).toLowerCase());
          if (matched && !found) {
            found = {
              type: trail[0],
              name: entryName,
              language: null,
              rva: dataRva,
              size: dataSize,
              fileOffset: pe.rvaToOffset(dataRva)
            };
          }
        }
      }
    };
    walk(base, 0, []);
    if (!found) throw new Error(`Resource ${typeName}/${name} not found in ${file}`);
    return found;
  } finally {
    fs.closeSync(pe.fd);
  }
}

function readResource(file, typeName, name) {
  const resource = findResource(file, typeName, name);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(resource.size);
    fs.readSync(fd, buffer, 0, resource.size, resource.fileOffset);
    return { ...resource, data: buffer };
  } finally {
    fs.closeSync(fd);
  }
}

function writeResource(file, typeName, name, data) {
  const resource = findResource(file, typeName, name);
  if (data.length !== resource.size) {
    throw new Error(`Resource ${typeName}/${name} is ${resource.size} bytes; replacement is ${data.length} bytes`);
  }
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, data, 0, data.length, resource.fileOffset);
  } finally {
    fs.closeSync(fd);
  }
  return resource;
}

module.exports = { parsePe, findResource, readResource, writeResource };
