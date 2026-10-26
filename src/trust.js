'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { psJson, sha256, sha256Base64, formatBytes } = require('./util');

const BLOCK_SIZE = 64 * 1024;

function quotePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getPackage(pins) {
  const name = quotePs(pins.packageName);
  return psJson(`
    $p = Get-AppxPackage -Name ${name} | Where-Object { $_.Status -eq 'Ok' } | Select-Object -First 1
    if (-not $p) { throw '${pins.packageName} is not installed for this user' }
    $p | Select-Object PackageFullName, InstallLocation,
      @{n='Version';e={$_.Version.ToString()}},
      PublisherId,
      @{n='Architecture';e={$_.Architecture.ToString()}},
      @{n='SignatureKind';e={$_.SignatureKind.ToString()}},
      @{n='Status';e={$_.Status.ToString()}},
      @{n='IsDevelopmentMode';e={$_.IsDevelopmentMode}} |
      ConvertTo-Json -Compress
  `);
}

function readManifest(installLocation) {
  const file = path.join(installLocation, 'AppxManifest.xml');
  const xml = fs.readFileSync(file, 'utf8');
  const identity = xml.match(/<Identity\s+([^>]+?)\s*\/?>/);
  if (!identity) throw new Error('AppxManifest.xml has no Identity element');
  const attrs = {};
  for (const match of identity[1].matchAll(/([A-Za-z0-9]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  return {
    file,
    xml,
    name: attrs.Name,
    version: attrs.Version,
    publisher: attrs.Publisher,
    architecture: attrs.ProcessorArchitecture
  };
}

function verifySignature(installLocation, manifest, pins) {
  const p7x = path.join(installLocation, 'AppxSignature.p7x');
  if (!fs.existsSync(p7x)) throw new Error(`Missing package signature: ${p7x}`);
  const signature = psJson(`
    $s = Get-AuthenticodeSignature -FilePath ${quotePs(p7x)};
    if (-not $s.SignerCertificate) { throw 'Package signature has no signer certificate' };
    [pscustomobject]@{
      Status = $s.Status.ToString();
      Subject = $s.SignerCertificate.Subject;
      Issuer = $s.SignerCertificate.Issuer;
      Thumbprint = $s.SignerCertificate.Thumbprint;
      NotBefore = $s.SignerCertificate.NotBefore.ToString('o');
      NotAfter = $s.SignerCertificate.NotAfter.ToString('o')
    } | ConvertTo-Json -Compress
  `);
  if (signature.Status !== 'Valid') {
    throw new Error(`Package signature is not valid: ${signature.Status}`);
  }
  if (!signature.Subject || !signature.Issuer) {
    throw new Error('Package signature has no signer certificate');
  }
  const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
  if (normalize(signature.Subject) !== normalize(pins.publisher)) {
    throw new Error(`Package signer ${signature.Subject} does not match pinned publisher ${pins.publisher}`);
  }
  if (!signature.Issuer.toLowerCase().includes(pins.issuerContains.toLowerCase())) {
    throw new Error(`Package signer issuer ${signature.Issuer} is not ${pins.issuerContains}`);
  }
  if (manifest.publisher && normalize(manifest.publisher) !== normalize(signature.Subject)) {
    throw new Error(`Manifest publisher ${manifest.publisher} does not match signer ${signature.Subject}`);
  }
  return signature;
}

function verifyAxbm(installLocation, signature) {
  const p7x = path.join(installLocation, 'AppxSignature.p7x');
  const blockMapFile = path.join(installLocation, 'AppxBlockMap.xml');
  const bytes = fs.readFileSync(p7x);
  const tag = Buffer.from('AXBM', 'latin1');
  const first = bytes.indexOf(tag);
  if (first < 0) throw new Error('Package signature has no AXBM (block map) digest');
  if (bytes.indexOf(tag, first + 1) >= 0) throw new Error('Package signature has more than one AXBM digest');
  if (first + 4 + 32 > bytes.length) throw new Error('Truncated AXBM digest');
  const digest = bytes.subarray(first + 4, first + 4 + 32);
  const actual = sha256(fs.readFileSync(blockMapFile));
  if (!digest.equals(actual)) {
    throw new Error('AXBM digest in the package signature does not match AppxBlockMap.xml');
  }
  return { blockMapFile, blockMapSha256: actual.toString('hex'), signature };
}

function parseBlockMap(installLocation) {
  const file = path.join(installLocation, 'AppxBlockMap.xml');
  const xml = fs.readFileSync(file, 'utf8');
  const files = new Map();
  const filePattern = /<File\s+Name="([^"]+)"([^>]*?)(\/?)>/g;
  let match;
  while ((match = filePattern.exec(xml))) {
    const name = match[1].replace(/\\/g, '/');
    const attributes = match[2];
    const selfClosing = match[3] === '/';
    let body = '';
    if (!selfClosing) {
      const end = xml.indexOf('</File>', filePattern.lastIndex);
      if (end < 0) throw new Error(`Unterminated <File> entry for ${name}`);
      body = xml.slice(filePattern.lastIndex, end);
      filePattern.lastIndex = end + '</File>'.length;
    }
    const sizeMatch = attributes.match(/\bSize="(\d+)"/);
    if (!sizeMatch) continue;
    const blocks = [...body.matchAll(/<Block\s+Hash="([^"]+)"(?:\s+Size="(\d+)")?\s*\/>/g)]
      .map((block) => ({ hash: block[1], compressed: block[2] ? Number(block[2]) : null }));
    files.set(name, { size: Number(sizeMatch[1]), blocks });
  }
  if (files.size === 0) throw new Error('AppxBlockMap.xml has no file entries');
  return files;
}

function verifyFileBlocks(installLocation, name, entry) {
  const file = path.join(installLocation, ...name.split('/'));
  const stat = fs.statSync(file);
  if (stat.size !== entry.size) {
    throw new Error(`${name}: size ${stat.size} does not match block map ${entry.size}`);
  }
  const expectedBlocks = Math.ceil(stat.size / BLOCK_SIZE);
  if (entry.blocks.length !== expectedBlocks) {
    throw new Error(`${name}: ${entry.blocks.length} blocks in block map, expected ${expectedBlocks}`);
  }
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(BLOCK_SIZE);
  try {
    for (let index = 0; index < entry.blocks.length; index += 1) {
      const offset = index * BLOCK_SIZE;
      const length = Math.min(BLOCK_SIZE, stat.size - offset);
      const read = fs.readSync(fd, buffer, 0, length, offset);
      if (read !== length) throw new Error(`${name}: short read at block ${index}`);
      const hash = sha256Base64(buffer.subarray(0, length));
      if (hash !== entry.blocks[index].hash) {
        throw new Error(`${name}: block ${index} hash does not match the signed block map`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function verifyPackage(pins, options = {}) {
  const full = options.full !== false;
  const onProgress = options.onProgress || (() => {});
  const pkg = getPackage(pins);
  const manifest = readManifest(pkg.InstallLocation);
  if (manifest.name !== pins.packageName) {
    throw new Error(`Unexpected package identity ${manifest.name}`);
  }
  if (manifest.version !== pkg.Version) {
    throw new Error(`Manifest version ${manifest.version} does not match installed ${pkg.Version}`);
  }
  onProgress(`package ${pkg.PackageFullName}`);
  onProgress(`signature ${pkg.SignatureKind}`);
  const signature = verifySignature(pkg.InstallLocation, manifest, pins);
  onProgress(`signer ${signature.Subject}`);
  const axbm = verifyAxbm(pkg.InstallLocation, signature);
  onProgress(`block map ${axbm.blockMapSha256.slice(0, 16)}…`);

  const blockMap = parseBlockMap(pkg.InstallLocation);
  const keyFiles = [
    'AppxManifest.xml',
    'AppxBlockMap.xml',
    'app/ChatGPT.exe',
    'app/resources/app.asar'
  ];
  const targets = full ? [...blockMap.keys()] : keyFiles.filter((name) => blockMap.has(name));
  let total = 0;
  let checked = 0;
  for (const name of targets) {
    const entry = blockMap.get(name);
    verifyFileBlocks(pkg.InstallLocation, name, entry);
    total += entry.size;
    checked += 1;
    if (checked % 500 === 0) onProgress(`verified ${checked}/${targets.length} files (${formatBytes(total)})`);
  }
  onProgress(`verified ${checked}/${targets.length} files (${formatBytes(total)})`);
  return { pkg, manifest, signature, blockMap, blockMapSha256: axbm.blockMapSha256, filesVerified: checked, bytesVerified: total };
}

module.exports = {
  BLOCK_SIZE,
  getPackage,
  readManifest,
  verifySignature,
  verifyAxbm,
  parseBlockMap,
  verifyFileBlocks,
  verifyPackage
};
