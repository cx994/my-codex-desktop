'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const trust = require('./trust');
const asar = require('./asar');
const pe = require('./pe');
const {
  ps, psJson, ensureDir, readJson, writeJson, log, warn, formatBytes, sleep,
  isProcessRunning, robocopy, clearReadOnly, sha256Hex, userDataDir, localAppDir,
  toolRoot, assetPath
} = require('./util');

const BOOTSTRAP_ENTRY = 'codexpp-bootstrap.js';
const ASAR_RESOURCE_FILE = 'resources\\app.asar';

function loadPins() {
  return readJson(assetPath('pins.json'));
}

function appDir() {
  return path.join(localAppDir(), 'app');
}

function receiptFile() {
  return path.join(localAppDir(), 'receipt.json');
}

function extensionsDir() {
  return path.join(userDataDir(), 'extensions');
}

function configFile() {
  return path.join(userDataDir(), 'config.json');
}

function logFile() {
  return path.join(userDataDir(), 'codexpp.log');
}

function assertAppClosed() {
  if (isProcessRunning('ChatGPT.exe')) {
    throw new Error('ChatGPT.exe is running. Quit Codex (including tray/background windows) and retry.');
  }
}

function readPackageJson(asarPath) {
  return JSON.parse(asar.readAsarFile(asarPath, 'package.json').toString('utf8'));
}

function electronAsarResource(exePath) {
  const resource = pe.readResource(exePath, 'INTEGRITY', 'ELECTRONASAR');
  const text = resource.data.toString('utf8');
  let entries;
  try {
    entries = JSON.parse(text);
  } catch (error) {
    throw new Error(`Unexpected ELECTRONASAR resource: ${error.message}`);
  }
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error('Unexpected ELECTRONASAR resource shape');
  }
  const entry = entries[0];
  if (entry.file !== ASAR_RESOURCE_FILE || entry.alg !== 'SHA256' || typeof entry.value !== 'string') {
    throw new Error(`Unexpected ELECTRONASAR entry: ${text}`);
  }
  return { resource, entries, entry, text };
}

function writeElectronAsarHash(exePath, headerHash) {
  const { resource, entries, entry } = electronAsarResource(exePath);
  const next = [{ ...entry, value: headerHash }];
  const text = JSON.stringify(next);
  const data = Buffer.from(text, 'utf8');
  if (data.length !== resource.size) {
    throw new Error(`ELECTRONASAR replacement is ${data.length} bytes, expected ${resource.size}`);
  }
  pe.writeResource(exePath, 'INTEGRITY', 'ELECTRONASAR', data);
  const verify = electronAsarResource(exePath);
  if (verify.entry.value !== headerHash) {
    throw new Error('ELECTRONASAR resource did not accept the new ASAR hash');
  }
  return { entries, resourceSize: resource.size };
}

function buildNativeSettingsPatches(asarPath) {
  const adapterDir = assetPath('adapters');
  const runtimeFile = path.join(adapterDir, 'native-settings.js');
  if (!fs.existsSync(runtimeFile)) return null;
  const header = asar.readHeader(asarPath);
  try {
    const entries = asar.collectEntries(header.header);
    const prefixes = ['settings-', 'general-settings-', 'appearance-settings-', 'browser-use-settings-', 'account-settings-', 'use-visible-settings-sections-', 'app-initial-', 'app-shared-', 'app-primary-'];
    const picked = entries.filter((entry) =>
      entry.path.startsWith('webview/assets/') &&
      entry.path.endsWith('.js') &&
      prefixes.some((prefix) => path.basename(entry.path).startsWith(prefix))
    );
    if (picked.length === 0) throw new Error('no Settings modules found');
    if (picked.length > 64) throw new Error(`unexpected Settings module count ${picked.length}`);
    const modules = {};
    for (const entry of picked) modules[entry.path] = asar.readEntry(header, entry.node).toString('utf8');
    const runtime = fs.readFileSync(runtimeFile, 'utf8');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpp-settings-'));
    try {
      const input = path.join(work, 'input.json');
      const output = path.join(work, 'output.json');
      fs.writeFileSync(input, JSON.stringify({ modules, runtime }));
      const adapterArgs = process.env.CODEXPP_PACKAGED === '1'
        ? ['--run-adapter', 'settings', input, output]
        : [path.join(__dirname, 'cli.js'), '--run-adapter', 'settings', input, output];
      const result = spawnSync(process.execPath, adapterArgs, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      });
      if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || 'settings adapter failed').trim());
      }
      const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
      if (!Array.isArray(parsed.patches) || parsed.patches.length === 0) {
        throw new Error('settings adapter returned no patches');
      }
      return new Map(parsed.patches.map((patch) => [patch.path, Buffer.from(patch.source, 'utf8')]));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  } finally {
    fs.closeSync(header.fd);
  }
}

const STARTUP_CHUNKS = [
  { key: 'shared', dir: 'webview/assets', prefix: 'app-shared-' },
  { key: 'initial', dir: 'webview/assets', prefix: 'app-initial-' },
  { key: 'requirements', dir: '.vite/build', prefix: 'startup-requirements-' },
  { key: 'main', dir: '.vite/build', prefix: 'main-' },
  { key: 'network', dir: '.vite/build', prefix: 'application-network-startup-' },
  { key: 'remoteSettings', dir: 'webview/assets', prefix: 'remote-connections-settings-' },
  { key: 'appServer', dir: '.vite/build', prefix: 'src-', markers: ['(`AppServerConnection`)'] },
  { key: 'primary', dir: 'webview/assets', prefix: 'app-primary-' },
  { key: 'ambient', dir: '.vite/build', prefix: 'src-', markers: ['ambientSuggestionsModel', 'first-plugin-connect'] },
  { key: 'xtermOutput', dir: 'webview/assets', prefix: 'xterm-output-panel-' },
  { key: 'terminalPanel', dir: 'webview/assets', prefix: 'terminal-panel-', markers: ['TerminalPanel', 'ResizeObserver'] },
  { key: 'checkout', dir: 'webview/assets', prefix: 'webview-page-', markers: ['CheckoutPricingWebviewHost'] },
  { key: 'trash', dir: 'webview/assets', prefix: 'space-trash-items-', markers: ['`/pages/archived`'] },
  { key: 'appearance', dir: 'webview/assets', prefix: 'space-appearance-button-', markers: ['/spaces/v2/{space_id}/appearance'] }
];

const STARTUP_MAIN_CHUNKS = new Set(['main', 'requirements', 'network', 'appServer', 'ambient']);

function buildStartupPatches(asarPath, options = {}) {
  const selected = options.startupChunks
    ? new Set(String(options.startupChunks).split(',').map((value) => value.trim()).filter(Boolean))
    : null;
  const includeChunk = (key) => !selected || selected.has(key);
  const adapterDir = assetPath('adapters');
  if (!fs.existsSync(path.join(adapterDir, 'startup-adapter.js'))) return null;
  const header = asar.readHeader(asarPath);
  try {
    const entries = asar.collectEntries(header.header);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const read = (name) => asar.readEntry(header, byPath.get(name).node).toString('utf8');
    const input = { diagnostics: false, aliases: {} };
    const paths = {};
    for (const chunk of STARTUP_CHUNKS) {
      const candidates = entries.filter((entry) =>
        entry.path.startsWith(`${chunk.dir}/${chunk.prefix}`) && entry.path.endsWith('.js')
      );
      let matches = candidates;
      if (chunk.markers) {
        matches = candidates.filter((entry) => {
          const source = read(entry.path);
          return chunk.markers.every((marker) => source.includes(marker));
        });
      }
      if (matches.length !== 1) continue;
      const found = matches[0];
      const owner = Object.entries(paths).find(([, value]) => value === found.path);
      if (owner) {
        input.aliases[chunk.key] = owner[0];
        continue;
      }
      paths[chunk.key] = found.path;
      input[chunk.key] = read(found.path);
    }
    const htmlPath = 'webview/index.html';
    if (byPath.has(htmlPath)) {
      const html = read(htmlPath);
      input.html = html;
      paths.html = htmlPath;
      const match = /<script type="module" crossorigin src="\.\/assets\/([\w.-]+\.js)">/.exec(html);
      if (match) {
        const entryPath = `webview/assets/${match[1]}`;
        if (byPath.has(entryPath)) input.entry = read(entryPath);
      }
    }
    const css = {};
    for (const entry of entries) {
      if (!entry.path.startsWith('webview/assets/') || !entry.path.endsWith('.css')) continue;
      if (entry.node.size > 8 * 1024 * 1024) continue;
      css[entry.path] = read(entry.path);
    }
    input.css = css;

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpp-startup-'));
    try {
      const inputFile = path.join(work, 'input.json');
      const outputFile = path.join(work, 'output.json');
      fs.writeFileSync(inputFile, JSON.stringify(input));
      const adapterArgs = process.env.CODEXPP_PACKAGED === '1'
        ? ['--run-adapter', 'startup', inputFile, outputFile]
        : [path.join(__dirname, 'cli.js'), '--run-adapter', 'startup', inputFile, outputFile];
      const result = spawnSync(process.execPath, adapterArgs, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      });
      if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || 'startup adapter failed').trim());
      }
      const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      const replacements = new Map();
      for (const [key, source] of Object.entries(output)) {
        if (key === 'applied' || key === 'skipped' || key === 'css') continue;
        if (!includeChunk(key)) continue;
        if (typeof source !== 'string') continue;
        const target = paths[key];
        if (target) replacements.set(target, Buffer.from(source, 'utf8'));
      }
      for (const [target, source] of Object.entries(output.css || {})) {
        if (typeof source === 'string') replacements.set(target, Buffer.from(source, 'utf8'));
      }
      return {
        replacements,
        applied: Object.fromEntries(Object.entries(output.applied || {}).filter(([, chunk]) => includeChunk(chunk))),
        skipped: output.skipped || {}
      };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  } finally {
    fs.closeSync(header.fd);
  }
}

function patchApplication(directory, options = {}) {
  const asarPath = path.join(directory, 'app', 'resources', 'app.asar');
  const exePath = path.join(directory, 'app', 'ChatGPT.exe');
  if (!fs.existsSync(asarPath)) throw new Error(`Missing ${asarPath}`);
  if (!fs.existsSync(exePath)) throw new Error(`Missing ${exePath}`);
  clearReadOnly(asarPath);
  clearReadOnly(exePath);

  const packageObject = readPackageJson(asarPath);
  const mainPath = packageObject.main;
  if (!mainPath) throw new Error('Codex package.json has no main entry');
  const originalHeader = asar.readHeader(asarPath);
  const originalHeaderHash = sha256Hex(originalHeader.json);
  fs.closeSync(originalHeader.fd);

  const template = fs.readFileSync(assetPath('runtime', 'bootstrap.js'), 'utf8');
  const version = readJson(assetPath('package.json')).version;
  const bootstrapSource = template
    .split('__CODEXPP_ORIGINAL_MAIN__').join(JSON.stringify(mainPath))
    .split('__CODEXPP_VERSION__').join(JSON.stringify(version));
  log('Adapting native Settings…');
  let settingsReplacements = null;
  try {
    settingsReplacements = buildNativeSettingsPatches(asarPath);
  } catch (error) {
    warn(`native Settings adapter failed: ${error.message}`);
  }
  let startup = null;
  if (!options.noStartup) {
    log('Adapting startup performance…');
    try {
      startup = buildStartupPatches(asarPath, {
        ...options,
        startupChunks: options.startupChunks || 'shared,initial'
      });
    } catch (error) {
      warn(`startup adapter failed: ${error.message}`);
    }
  }
  const replacements = new Map([
    ...(startup ? startup.replacements : []),
    ...(settingsReplacements || [])
  ]);
  const patched = asar.rebuildAsar(asarPath, {
    mainPath,
    bootstrapPath: BOOTSTRAP_ENTRY,
    bootstrapSource,
    replacements
  });
  log(`native Settings patches: ${settingsReplacements ? settingsReplacements.size : 0}`);
  log(`startup patches: ${startup ? startup.replacements.size : 0} (applied ${startup ? Object.keys(startup.applied).length : 0})`);
  if (startup) {
    writeJson(path.join(directory, 'app', 'resources', 'codexpp-startup-discovery.json'), {
      applied: startup.applied,
      skipped: startup.skipped,
      patchedAt: new Date().toISOString()
    });
  }

  const resource = writeElectronAsarHash(exePath, patched.headerHash);
  const verifyHeader = asar.readHeader(asarPath);
  const verifiedHash = sha256Hex(verifyHeader.json);
  fs.closeSync(verifyHeader.fd);
  if (verifiedHash !== patched.headerHash) {
    throw new Error('Patched ASAR header hash does not match the receipt');
  }
  const verifiedResource = electronAsarResource(exePath);
  if (verifiedResource.entry.value !== patched.headerHash) {
    throw new Error('ELECTRONASAR does not match the patched ASAR header');
  }
  const bootstrap = asar.readAsarFile(asarPath, BOOTSTRAP_ENTRY).toString('utf8');
  if (!bootstrap.includes('Codex++ Windows bootstrap')) {
    throw new Error('Injected bootstrap is missing from the patched ASAR');
  }

  return {
    asarPath,
    exePath,
    mainPath,
    originalHeaderHash,
    ...patched,
    nativeSettingsPatches: settingsReplacements ? settingsReplacements.size : 0,
    startupPatches: startup ? startup.replacements.size : 0,
    startupApplied: startup ? Object.keys(startup.applied).length : 0,
    resourceSize: resource.resourceSize
  };
}

function shortcutPath() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Codex++.lnk'
  );
}

function createShortcut() {
  const target = path.join(appDir(), 'app', 'ChatGPT.exe');
  if (!fs.existsSync(target)) throw new Error(`Missing ${target}`);
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const link = shortcutPath();
  fs.mkdirSync(path.dirname(link), { recursive: true });
  ps(`
    $ws = New-Object -ComObject WScript.Shell;
    $sc = $ws.CreateShortcut(${quote(link)});
    $sc.TargetPath = ${quote(target)};
    $sc.WorkingDirectory = ${quote(path.join(appDir(), 'app'))};
    $sc.IconLocation = ${quote(`${target},0`)};
    $sc.Description = 'Codex++ (patched Codex copy)';
    $sc.Save()
  `);
  return link;
}

function trayScript() {
  const source = assetPath('tray.ps1');
  if (!process.pkg) return source;
  const target = path.join(localAppDir(), 'tool', readJson(assetPath('package.json')).version, 'tray.ps1');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const data = fs.readFileSync(source);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(data)) {
    fs.writeFileSync(target, data);
  }
  return target;
}

function trayShortcutPath() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Codex++ Tray.lnk'
  );
}

function createTrayShortcut() {
  const script = trayScript();
  if (!fs.existsSync(script)) return null;
  const link = trayShortcutPath();
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  const icon = path.join(appDir(), 'app', 'ChatGPT.exe');
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const args = `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}"`;
  fs.mkdirSync(path.dirname(link), { recursive: true });
  ps(`
    $ws = New-Object -ComObject WScript.Shell;
    $sc = $ws.CreateShortcut(${quote(link)});
    $sc.TargetPath = ${quote(powershell)};
    $sc.Arguments = ${quote(args)};
    $sc.WorkingDirectory = ${quote(path.dirname(script))};
    $sc.IconLocation = ${quote(`${icon},0`)};
    $sc.Description = 'Codex++ tray helper';
    $sc.Save()
  `);
  return link;
}

function trayCommand() {
  const script = trayScript();
  if (!fs.existsSync(script)) throw new Error(`Missing tray script: ${script}`);
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  ps(`Start-Process -FilePath 'powershell.exe' -ArgumentList ${quote(`-NoProfile -ExecutionPolicy Bypass -File "${script}"`)} -WindowStyle Hidden`);
  log('Tray started.');
  return true;
}

function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((part) => parseInt(part, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map((part) => parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const difference = (pa[index] || 0) - (pb[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function copyAssetTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyAssetTree(from, to);
    else fs.writeFileSync(to, fs.readFileSync(from));
  }
}

function installBuiltinExtension(name) {
  ensureDir(extensionsDir());
  const source = assetPath('extensions', name);
  const target = path.join(extensionsDir(), name);
  const bundled = readJson(path.join(source, 'manifest.json'), {}).version || '0';
  const installedFile = path.join(target, 'manifest.json');
  const installed = fs.existsSync(installedFile) ? (readJson(installedFile, {}).version || '0') : null;
  if (installed !== null && compareVersions(bundled, installed) <= 0) return false;
  clearReadOnly(target);
  fs.rmSync(target, { recursive: true, force: true });
  copyAssetTree(source, target);
  return true;
}

function installBuiltinExtensions() {
  return {
    settings: installBuiltinExtension('settings'),
    'hide-logo': installBuiltinExtension('hide-logo')
  };
}

function writeReceipt(receipt) {
  writeJson(receiptFile(), receipt);
}

function readReceipt() {
  return readJson(receiptFile(), null);
}

async function verifyCommand(options = {}) {
  const pins = loadPins();
  const result = trust.verifyPackage(pins, {
    full: options.full !== false,
    onProgress: (message) => log(`  ${message}`)
  });
  log('');
  log(`Package:    ${result.pkg.PackageFullName}`);
  log(`Version:    ${result.manifest.version} (${result.manifest.architecture})`);
  log(`Install:    ${result.pkg.InstallLocation}`);
  log(`Signature:  ${result.signature.Status} (${result.pkg.SignatureKind})`);
  log(`Signer:     ${result.signature.Subject}`);
  log(`Issuer:     ${result.signature.Issuer}`);
  log(`Block map:  ${result.blockMapSha256}`);
  log(`Verified:   ${result.filesVerified} files, ${formatBytes(result.bytesVerified)}`);
  return result;
}

async function installCommand(options = {}) {
  const pins = loadPins();
  log('Verifying the installed Store package...');
  const verified = await verifyCommand({ full: options.full !== false });
  assertAppClosed();

  const staging = `${appDir()}.new`;
  clearReadOnly(staging);
  fs.rmSync(staging, { recursive: true, force: true });
  ensureDir(path.dirname(staging));
  log(`Copying ${verified.pkg.InstallLocation} -> ${staging}`);
  robocopy(verified.pkg.InstallLocation, staging);

  log('Patching app.asar and ELECTRONASAR...');
  const patched = patchApplication(staging, options);

  const receipt = {
    schema: 1,
    packageFullName: verified.pkg.PackageFullName,
    version: verified.manifest.version,
    architecture: verified.manifest.architecture,
    publisher: verified.signature.Subject,
    signerThumbprint: verified.signature.Thumbprint,
    installLocation: verified.pkg.InstallLocation,
    appDir: appDir(),
    patchedAt: new Date().toISOString(),
    mainPath: patched.mainPath,
    bootstrapPath: patched.bootstrapPath,
    asarHeaderHash: patched.headerHash,
    originalAsarHeaderHash: patched.originalHeaderHash,
    asarSize: patched.asarSize,
    blockMapSha256: verified.blockMapSha256,
    nativeSettingsPatches: patched.nativeSettingsPatches,
    startupPatches: patched.startupPatches,
    startupApplied: patched.startupApplied,
    electronAsarResourceSize: patched.resourceSize
  };

  clearReadOnly(appDir());
  fs.rmSync(appDir(), { recursive: true, force: true });
  fs.renameSync(staging, appDir());
  writeReceipt(receipt);
  if (options.sign) signCommand();
  ensureDir(userDataDir());
  if (!fs.existsSync(configFile())) writeJson(configFile(), { enabled: {} });
  const builtins = installBuiltinExtensions();
  const shortcut = createShortcut();
  const trayShortcut = createTrayShortcut();

  log('');
  log('Installed.');
  log(`  app:      ${appDir()}`);
  log(`  shortcut: ${shortcut}`);
  log(`  tray:     ${trayShortcut || 'tray.ps1 missing'}`);
  log(`  receipt:  ${receiptFile()}`);
  log(`  log:      ${logFile()}`);
  log(`  asar:     ${patched.headerHash}`);
  log(`  builtins: ${Object.entries(builtins).map(([name, added]) => `${name}${added ? ' (new)' : ''}`).join(', ')}`);
  if (options.launch) {
    await launchCommand();
  } else {
    log('');
    log('Launch with: node src/cli.js launch');
  }
  return receipt;
}

async function repatchCommand(options = {}) {
  const receipt = readReceipt();
  if (!receipt) throw new Error('Codex++ is not installed. Run: node src/cli.js install');
  const pins = loadPins();
  const verified = await verifyCommand({ full: options.full !== false });
  if (verified.manifest.version !== receipt.version) {
    throw new Error(`Store package is now ${verified.manifest.version}; run install to re-copy the app.`);
  }
  assertAppClosed();
  const directory = appDir();
  if (!fs.existsSync(directory)) throw new Error(`Missing app copy: ${directory}`);
  for (const relative of [['app', 'resources', 'app.asar'], ['app', 'ChatGPT.exe']]) {
    const source = path.join(verified.pkg.InstallLocation, ...relative);
    const target = path.join(directory, ...relative);
    clearReadOnly(target);
    fs.copyFileSync(source, target);
  }
  const patched = patchApplication(directory, options);
  const builtins = installBuiltinExtensions();
  const trayShortcut = createTrayShortcut();
  writeReceipt({
    ...receipt,
    patchedAt: new Date().toISOString(),
    asarHeaderHash: patched.headerHash,
    originalAsarHeaderHash: patched.originalHeaderHash,
    asarSize: patched.asarSize,
    nativeSettingsPatches: patched.nativeSettingsPatches,
    startupPatches: patched.startupPatches,
    startupApplied: patched.startupApplied,
    electronAsarResourceSize: patched.resourceSize
  });
  if (options.sign || receipt.signed || fs.existsSync(path.join(userDataDir(), 'signing.json'))) {
    try {
      signCommand();
    } catch (error) {
      warn(`signing failed: ${error.message}`);
    }
  }
  log('Repatched.');
  log(`  asar: ${patched.headerHash}`);
  log(`  tray: ${trayShortcut || 'tray.ps1 missing'}`);
  log(`  builtins: ${Object.entries(builtins).map(([name, added]) => `${name}${added ? ' (new)' : ''}`).join(', ')}`);
  return patched;
}

async function launchCommand() {
  const receipt = readReceipt();
  if (!receipt) throw new Error('Codex++ is not installed. Run: node src/cli.js install');
  const exe = path.join(receipt.appDir, 'app', 'ChatGPT.exe');
  if (!fs.existsSync(exe)) throw new Error(`Missing patched executable: ${exe}`);
  assertAppClosed();
  ensureDir(userDataDir());
  const launchLog = path.join(userDataDir(), 'launch.log');
  const before = fs.existsSync(logFile()) ? fs.statSync(logFile()).size : 0;
  const output = fs.openSync(launchLog, 'a');
  const child = spawn(exe, [], {
    cwd: path.join(receipt.appDir, 'app'),
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: false
  });
  fs.closeSync(output);
  child.unref();
  log(`Launched ${exe} (pid ${child.pid})`);

  let running = true;
  let injected = false;
  let noneEnabled = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await sleep(1000);
    running = isProcessRunning('ChatGPT.exe');
    const text = fs.existsSync(logFile()) ? fs.readFileSync(logFile()).subarray(before).toString('utf8') : '';
    if (/injected \d+ extension/.test(text) || text.includes('extension failed') || text.includes('injection failed') || text.includes('no enabled extensions')) {
      injected = /injected \d+ extension/.test(text);
      noneEnabled = text.includes('no enabled extensions');
      break;
    }
    if (!running) break;
  }
  running = running && isProcessRunning('ChatGPT.exe');
  log(running ? 'ChatGPT.exe is running.' : 'ChatGPT.exe is not running (startup failed?).');
  log(injected ? 'Extensions injected.' : noneEnabled ? 'No enabled extensions.' : 'No injection observed yet.');
  const lines = fs.existsSync(logFile())
    ? fs.readFileSync(logFile()).subarray(before).toString('utf8').trim().split(/\r?\n/).filter(Boolean).slice(-20)
    : [];
  if (lines.length) {
    log('');
    log('Runtime log:');
    for (const line of lines) log(`  ${line}`);
  }
  if (!running && fs.existsSync(launchLog)) {
    log('');
    log('Process output:');
    for (const line of fs.readFileSync(launchLog, 'utf8').trim().split(/\r?\n/).slice(-20)) log(`  ${line}`);
  }
  return { running, injected, log: logFile(), launchLog };
}

function statusCommand() {
  const receipt = readReceipt();
  if (!receipt) {
    log('Not installed. Run: node src/cli.js install');
    return { installed: false };
  }
  const exe = path.join(receipt.appDir, 'app', 'ChatGPT.exe');
  const asarPath = path.join(receipt.appDir, 'app', 'resources', 'app.asar');
  const exists = fs.existsSync(exe) && fs.existsSync(asarPath);
  let headerHash = null;
  let resourceHash = null;
  let error = null;
  try {
    if (exists) {
      const header = asar.readHeader(asarPath);
      headerHash = sha256Hex(header.json);
      fs.closeSync(header.fd);
      resourceHash = electronAsarResource(exe).entry.value;
    }
  } catch (caught) {
    error = caught.message;
  }
  const pins = loadPins();
  let installedVersion = null;
  try {
    installedVersion = trust.getPackage(pins).Version;
  } catch {}
  const healthy = exists && headerHash === receipt.asarHeaderHash && resourceHash === receipt.asarHeaderHash;
  log(`Installed:  ${exists ? 'yes' : 'no'}`);
  log(`App:        ${receipt.appDir}`);
  log(`Patched:    ${receipt.patchedAt}`);
  log(`Source:     ${receipt.packageFullName}`);
  log(`Store now:  ${installedVersion || 'unknown'}`);
  log(`ASAR:       ${headerHash || 'unreadable'}`);
  log(`Resource:   ${resourceHash || 'unreadable'}`);
  log(`Health:     ${healthy ? 'ok' : 'broken'}${error ? ` (${error})` : ''}`);
  let signatureStatus = 'unknown';
  try {
    if (exists) {
      const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
      const signature = psJson(`$s=Get-AuthenticodeSignature -FilePath ${quote(exe)}; [pscustomobject]@{Status=$s.Status.ToString()} | ConvertTo-Json -Compress`);
      signatureStatus = signature.Status;
    }
  } catch {}
  log(`Signature:  ${signatureStatus}`);
  if (installedVersion && installedVersion !== receipt.version) {
    log(`Update:     Store package is ${installedVersion}; patched copy is ${receipt.version}. Re-run install.`);
  }
  log(`Running:    ${isProcessRunning('ChatGPT.exe') ? 'yes' : 'no'}`);
  log(`Extensions: ${extensionsDir()}`);
  log(`Log:        ${logFile()}`);
  return { installed: true, healthy, headerHash, resourceHash, receipt };
}

function restoreCommand() {
  assertAppClosed();
  const existed = fs.existsSync(appDir());
  const pidFile = path.join(userDataDir(), 'tray.pid');
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid > 0) process.kill(pid);
  } catch {}
  fs.rmSync(pidFile, { force: true });
  clearReadOnly(appDir());
  fs.rmSync(appDir(), { recursive: true, force: true });
  fs.rmSync(receiptFile(), { force: true });
  fs.rmSync(shortcutPath(), { force: true });
  fs.rmSync(trayShortcutPath(), { force: true });
  fs.rmSync(path.join(userDataDir(), 'signing.json'), { force: true });
  log(existed ? 'Restored: removed the patched copy. The Store app was never modified.' : 'Nothing to restore.');
  return { existed };
}

function extensionConfig() {
  return readJson(configFile(), { enabled: {} });
}

function listExtensions() {
  const config = extensionConfig();
  const directory = extensionsDir();
  if (!fs.existsSync(directory)) {
    log('No extensions directory yet.');
    return [];
  }
  const rows = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, entry.name, 'manifest.json'), 'utf8'));
    } catch {}
    const id = manifest?.id || entry.name;
    rows.push({
      directory: entry.name,
      id,
      name: manifest?.name || entry.name,
      version: manifest?.version || '?',
      enabled: !config.enabled || config.enabled[id] !== false
    });
  }
  for (const row of rows) {
    log(`${row.enabled ? 'on ' : 'off'}  ${row.id}  ${row.name} ${row.version}  (${row.directory})`);
  }
  if (rows.length === 0) log('No extensions installed.');
  return rows;
}

function setExtensionEnabled(id, enabled) {
  const config = extensionConfig();
  config.enabled = config.enabled || {};
  config.enabled[id] = enabled;
  writeJson(configFile(), config);
  log(`${id}: ${enabled ? 'enabled' : 'disabled'}`);
}

const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function validateExtensionId(id) {
  if (typeof id !== 'string') throw new Error('manifest.json id must be a string');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`Unsafe extension id ${JSON.stringify(id)}: use letters, digits, dot, dash or underscore`);
  }
  if (id === '.' || id === '..' || id.endsWith('.') || id.endsWith(' ')) {
    throw new Error(`Unsafe extension id ${JSON.stringify(id)}`);
  }
  if (RESERVED_DEVICE_NAMES.test(id.split('.')[0])) {
    throw new Error(`Unsafe extension id ${JSON.stringify(id)}: reserved Windows device name`);
  }
  return id;
}

function resolveInside(root, relative, label) {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0')) {
    throw new Error(`Invalid ${label}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`${label} escapes ${resolvedRoot}`);
  }
  return resolved;
}

function addExtension(source) {
  const directory = path.resolve(source);
  const manifestFile = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`No manifest.json in ${directory}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (!manifest.id) throw new Error('manifest.json has no id');
  const id = validateExtensionId(manifest.id);
  const main = resolveInside(directory, manifest.main || 'index.js', 'Extension entry');
  if (!fs.existsSync(main) || !fs.statSync(main).isFile()) throw new Error(`Missing entry file: ${main}`);

  const root = path.resolve(extensionsDir());
  const target = path.resolve(root, id);
  if (target === root || path.dirname(target) !== root) {
    throw new Error(`Extension target escapes ${root}`);
  }
  if (directory === root || directory.startsWith(root + path.sep)) {
    throw new Error('Extension source must be outside the extensions directory');
  }
  if (target === directory) throw new Error('Extension source and target are the same directory');

  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(directory, target, { recursive: true });
  log(`Installed ${id} -> ${target}`);
  return target;
}

function signCommand() {
  const receipt = readReceipt();
  if (!receipt) throw new Error('Codex++ is not installed. Run: node src/cli.js install');
  assertAppClosed();
  const exe = path.join(receipt.appDir, 'app', 'ChatGPT.exe');
  if (!fs.existsSync(exe)) throw new Error(`Missing patched executable: ${exe}`);
  clearReadOnly(exe);
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const result = psJson(`
    $subject = 'CN=CodexPP Local Signing';
    $cert = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq $subject -and $_.HasPrivateKey } | Select-Object -First 1;
    if (-not $cert) {
      $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(5);
    }
    $tmp = Join-Path $env:TEMP ('codexpp-cert-' + [guid]::NewGuid().ToString('N') + '.cer');
    Export-Certificate -Cert $cert -FilePath $tmp | Out-Null;
    $null = & certutil.exe -addstore -user Root $tmp 2>&1;
    $null = & certutil.exe -addstore -user TrustedPublisher $tmp 2>&1;
    Remove-Item $tmp -Force;
    $null = Set-AuthenticodeSignature -FilePath ${quote(exe)} -Certificate $cert -HashAlgorithm SHA256;
    $verify = Get-AuthenticodeSignature -FilePath ${quote(exe)};
    [pscustomobject]@{
      Status = $verify.Status.ToString();
      Subject = $verify.SignerCertificate.Subject;
      Thumbprint = $verify.SignerCertificate.Thumbprint;
      NotAfter = $cert.NotAfter.ToString('o')
    } | ConvertTo-Json -Compress
  `);
  log(`Signed: ${result.Status} (${result.Subject})`);
  log(`Cert:   ${result.Thumbprint}, expires ${result.NotAfter}`);
  writeReceipt({
    ...receipt,
    signed: result.Status === 'Valid',
    signerThumbprint: result.Thumbprint,
    signedAt: new Date().toISOString()
  });
  writeJson(path.join(userDataDir(), 'signing.json'), {
    thumbprint: result.Thumbprint,
    subject: result.Subject,
    signedAt: new Date().toISOString()
  });
  return result;
}

function checkUpdateCommand() {
  const receipt = readReceipt();
  if (!receipt) throw new Error('Codex++ is not installed. Run: node src/cli.js install');
  const pkg = trust.getPackage(loadPins());
  const current = receipt.version;
  const latest = pkg.Version;
  const update = current !== latest;
  log(`Patched: ${current}`);
  log(`Store:   ${latest}`);
  log(update ? 'Update available. Run: node src/cli.js update' : 'Up to date.');
  return { current, latest, update };
}

async function updateCommand(options = {}) {
  const check = checkUpdateCommand();
  if (!check.update) return check;
  assertAppClosed();
  log('Reinstalling the patched copy from the new Store package...');
  await installCommand({ full: options.full !== false, launch: options.launch });
  return check;
}

async function appshotCommand(options = {}) {
  const directory = path.join(userDataDir(), 'appshots');
  ensureDir(directory);
  const out = options.out
    ? path.resolve(options.out)
    : path.join(directory, `appshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  ensureDir(path.dirname(out));
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

  if (isProcessRunning('ChatGPT.exe')) {
    const commandFile = path.join(userDataDir(), 'command.json');
    const ts = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    fs.writeFileSync(commandFile, JSON.stringify({ ts, appshot: true, out }));
    for (let index = 0; index < 40; index += 1) {
      if (fs.existsSync(out) && fs.statSync(out).size > 0) break;
      await sleep(500);
    }
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      const meta = readJson(`${out}.json`, {});
      log(`Appshot: ${out} (${meta.width || '?'}x${meta.height || '?'}, ${meta.title || 'ChatGPT'})`);
      if (options.open) ps(`Start-Process ${quote(out)}`);
      return { ...meta, path: out };
    }
    warn('The running app did not answer the Appshot command; using PrintWindow.');
  } else {
    throw new Error('ChatGPT.exe is not running');
  }

  const result = psJson(`
    Add-Type -AssemblyName System.Drawing;
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CodexPPAppshot {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@;
    $p = Get-Process ChatGPT -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
    if (-not $p) { throw 'ChatGPT window not found' };
    $h = $p.MainWindowHandle;
    $r = New-Object CodexPPAppshot+RECT;
    [CodexPPAppshot]::GetWindowRect($h, [ref]$r) | Out-Null;
    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top;
    if ($w -le 0 -or $ht -le 0) { throw 'Invalid window size' };
    $bmp = New-Object System.Drawing.Bitmap $w, $ht;
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $hdc = $g.GetHdc();
    $ok = [CodexPPAppshot]::PrintWindow($h, $hdc, 2);
    $g.ReleaseHdc($hdc);
    $bmp.Save(${quote(out)}, [System.Drawing.Imaging.ImageFormat]::Png);
    [pscustomobject]@{Path=${quote(out)};Width=$w;Height=$ht;Title=$p.MainWindowTitle;Pid=$p.Id;PrintWindow=$ok} | ConvertTo-Json -Compress
  `);
  writeJson(`${out}.json`, { ...result, capturedAt: new Date().toISOString() });
  log(`Appshot: ${out} (${result.Width}x${result.Height}, ${result.Title})`);
  if (options.open) ps(`Start-Process ${quote(out)}`);
  return { ...result, path: out };
}

function doctorCommand() {
  log(`Node:        ${process.version}`);
  log(`Platform:    ${process.platform} ${process.arch}`);
  log(`Pins:        ${JSON.stringify(loadPins())}`);
  try {
    const pkg = trust.getPackage(loadPins());
    log(`Package:     ${pkg.PackageFullName}`);
    log(`Install:     ${pkg.InstallLocation}`);
    log(`Status:      ${pkg.Status}`);
  } catch (error) {
    warn(`Package:     ${error.message}`);
  }
  log(`Running:     ${isProcessRunning('ChatGPT.exe') ? 'ChatGPT.exe is running' : 'no ChatGPT.exe'}`);
  log(`App copy:    ${fs.existsSync(appDir()) ? appDir() : 'not installed'}`);
  log(`Extensions:  ${extensionsDir()}`);
  log(`Log:         ${logFile()}`);
}

module.exports = {
  loadPins,
  appDir,
  receiptFile,
  extensionsDir,
  configFile,
  logFile,
  verifyCommand,
  installCommand,
  repatchCommand,
  launchCommand,
  statusCommand,
  restoreCommand,
  listExtensions,
  setExtensionEnabled,
  addExtension,
  signCommand,
  appshotCommand,
  checkUpdateCommand,
  updateCommand,
  trayCommand,
  doctorCommand,
  patchApplication,
  shortcutPath,
  createShortcut,
  trayScript,
  trayShortcutPath,
  createTrayShortcut
};
