'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ensureDir, readJson, log, sha256Hex, userDataDir, assetPath, toolRoot } = require('./util');

function currentVersion() {
  return readJson(assetPath('package.json')).version;
}

function defaultManifest() {
  return path.join(userDataDir(), 'update.json');
}

async function readManifest(source) {
  const target = source || defaultManifest();
  if (/^https?:\/\//i.test(target)) {
    const response = await fetch(target, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

async function download(url, destination) {
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
    fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
    return;
  }
  if (url.startsWith('file://')) {
    fs.copyFileSync(new URL(url), destination);
    return;
  }
  fs.copyFileSync(path.resolve(url), destination);
}

async function selfUpdateCommand(options = {}) {
  if (process.pkg || process.env.CODEXPP_PACKAGED === '1') {
    throw new Error('self-update is not available in the packaged exe; download the new exe from Releases.');
  }
  const manifest = await readManifest(options.manifest);
  const version = String(manifest.version || '');
  if (!version || !manifest.url || !manifest.sha256) {
    throw new Error('Update manifest needs version, url and sha256');
  }
  const current = currentVersion();
  log(`Current: ${current}`);
  log(`Latest:  ${version}`);
  if (options.check) {
    log(version === current ? 'Up to date.' : 'Update available.');
    return { current, latest: version, update: version !== current };
  }
  if (version === current) {
    log('Up to date.');
    return { current, latest: version, update: false };
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpp-self-update-'));
  try {
    const archive = path.join(work, 'update.zip');
    await download(manifest.url, archive);
    const actual = sha256Hex(fs.readFileSync(archive));
    if (actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
      throw new Error(`SHA-256 mismatch: ${actual}`);
    }
    const extract = path.join(work, 'extract');
    ensureDir(extract);
    const result = spawnSync('tar.exe', ['-xf', archive, '-C', extract], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'Could not extract the update archive').trim());
    }
    const source = fs.existsSync(path.join(extract, 'package.json'))
      ? extract
      : path.join(extract, 'win');
    if (!fs.existsSync(path.join(source, 'package.json'))) {
      throw new Error('Update archive has no package.json');
    }
    const archiveVersion = readJson(path.join(source, 'package.json')).version;
    if (archiveVersion !== version) {
      throw new Error(`Archive version ${archiveVersion} does not match manifest ${version}`);
    }
    const target = path.resolve(options.target || toolRoot());
    if (!fs.existsSync(target)) throw new Error(`Update target not found: ${target}`);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      fs.cpSync(path.join(source, entry.name), path.join(target, entry.name), {
        recursive: true,
        force: true
      });
    }
    log(`Updated ${target} to ${version}.`);
    log('Run: node src/cli.js repatch   (or install after a Store update)');
    return { current, latest: version, updated: true };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { selfUpdateCommand, readManifest, currentVersion };
