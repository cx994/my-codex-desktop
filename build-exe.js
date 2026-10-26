'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = __dirname;
const build = path.join(root, 'build');
const staging = path.join(build, 'staging');
const zip = path.join(build, 'tool.zip');
const launcherFile = path.join(build, 'launcher.js');
const configFile = path.join(build, 'sea-config.json');
const blobFile = path.join(build, 'sea-prep.blob');
const output = path.join(root, '..', 'dist', 'my-codex-desktop.exe');
const pkg = require('./package.json');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result;
}

fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
for (const item of ['src', 'adapters', 'runtime', 'extensions', 'tray.ps1', 'pins.json', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'NODE-LICENSE']) {
  fs.cpSync(path.join(root, item), path.join(staging, item), { recursive: true });
}

run('powershell.exe', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zip}' -Force`
]);

const archive = fs.readFileSync(zip);
const hash = crypto.createHash('sha256').update(archive).digest('hex').slice(0, 8);
const launcher = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');

const version = ${JSON.stringify(pkg.version)};
const hash = ${JSON.stringify(hash)};
const embedded = ${JSON.stringify(archive.toString('base64'))};
const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const root = path.join(base, 'CodexPP', 'tool', version + '-' + hash);
const cli = path.join(root, 'src', 'cli.js');

if (!fs.existsSync(cli)) {
  fs.mkdirSync(root, { recursive: true });
  const archive = path.join(os.tmpdir(), 'my-codex-desktop-' + process.pid + '.zip');
  fs.writeFileSync(archive, Buffer.from(embedded, 'base64'));
  const tar = path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(tar, ['-xf', archive, '-C', root], { stdio: 'ignore' });
  try { fs.rmSync(archive, { force: true }); } catch {}
  if (result.status !== 0 || !fs.existsSync(cli)) {
    console.error('my-codex-desktop: could not unpack its runtime.');
    process.exit(1);
  }
}

process.env.CODEXPP_PACKAGED = '1';
const source = fs.readFileSync(cli, 'utf8');
const mod = new Module(cli, module);
mod.filename = cli;
mod.paths = Module._nodeModulePaths(path.dirname(cli));
mod._compile(source, cli);
`;
fs.writeFileSync(launcherFile, launcher);
fs.writeFileSync(configFile, JSON.stringify({
  main: launcherFile,
  output: blobFile,
  disableExperimentalSEAWarning: true
}, null, 2));

run(process.execPath, ['--experimental-sea-config', configFile]);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.rmSync(output, { force: true });
fs.copyFileSync(process.execPath, output);
run(process.execPath, [
  path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
  output,
  'NODE_SEA_BLOB',
  blobFile,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
]);

const size = fs.statSync(output).size;
console.log(`Built ${output} (${(size / 1024 / 1024).toFixed(1)} MB, tool ${pkg.version}-${hash})`);
