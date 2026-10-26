'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PS_PREFIX = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8'
].join('; ');

function ps(script) {
  const encoded = Buffer.from(`${PS_PREFIX}; ${script}`, 'utf16le').toString('base64');
  try {
    return execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (error) {
    const stderr = (error.stderr || '').toString().trim();
    const stdout = (error.stdout || '').toString().trim();
    throw new Error(`PowerShell failed: ${stderr || stdout || error.message}`);
  }
}

function psJson(script) {
  const text = ps(script);
  if (!text) throw new Error('PowerShell returned no JSON');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse PowerShell JSON: ${error.message}\n${text.slice(0, 2000)}`);
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function sha256Hex(data) {
  return sha256(data).toString('hex');
}

function sha256Base64(data) {
  return sha256(data).toString('base64');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
}

function log(...args) {
  console.log(...args);
}

function warn(...args) {
  console.error(...args);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(imageName) {
  const result = spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${imageName}`, '/NH'], {
    encoding: 'utf8', windowsHide: true
  });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  return text.toLowerCase().includes(imageName.toLowerCase());
}

function robocopy(source, destination) {
  ensureDir(destination);
  const result = spawnSync('robocopy.exe', [
    source, destination,
    '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1',
    '/NFL', '/NDL', '/NJH', '/NJS', '/NP'
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status === null || result.status >= 8) {
    throw new Error(`robocopy failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.status;
}

function clearReadOnly(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  try {
    fs.chmodSync(target, stat.isDirectory() ? 0o777 : 0o666);
  } catch {}
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) clearReadOnly(path.join(target, name));
  }
}

function copyRange(fdIn, fdOut, sourceOffset, destOffset, length) {
  const chunk = 4 * 1024 * 1024;
  const buffer = Buffer.allocUnsafe(Math.min(chunk, Math.max(length, 1)));
  let copied = 0;
  while (copied < length) {
    const size = Math.min(buffer.length, length - copied);
    const read = fs.readSync(fdIn, buffer, 0, size, sourceOffset + copied);
    if (read === 0) throw new Error('Unexpected end of file while copying ASAR payload');
    fs.writeSync(fdOut, buffer, 0, read, destOffset + copied);
    copied += read;
  }
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function userDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'CodexPP');
}

function localAppDir() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexPP');
}

function toolRoot() {
  return path.join(__dirname, '..');
}

function assetPath(...parts) {
  return path.join(toolRoot(), ...parts);
}

module.exports = {
  ps, psJson, sha256, sha256Hex, sha256Base64,
  ensureDir, readJson, writeJson, log, warn, formatBytes, sleep,
  isProcessRunning, robocopy, clearReadOnly, copyRange, u32, userDataDir, localAppDir,
  toolRoot, assetPath
};
