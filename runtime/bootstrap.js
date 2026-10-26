'use strict';

// Codex++ Windows bootstrap. This file is injected as the ASAR main entry and
// loads the original entry after installing the renderer extension host.
(function () {
  if (globalThis.__codexppBootstrap) {
    require('./' + __CODEXPP_ORIGINAL_MAIN__);
    return;
  }
  globalThis.__codexppBootstrap = true;

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { app, webContents, BrowserWindow, shell } = require('electron');

  const VERSION = __CODEXPP_VERSION__;
  const root = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'CodexPP');
  const extensionsDir = path.join(root, 'extensions');
  const configFile = path.join(root, 'config.json');
  const logFile = path.join(root, 'codexpp.log');
  const commandFile = path.join(root, 'command.json');

  function log(message) {
    const line = `[${new Date().toISOString()}] [bootstrap] ${message}\n`;
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.appendFileSync(logFile, line);
    } catch {}
  }

  function readConfig() {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
      return {};
    }
  }

  function isEnabled(id, config) {
    if (!config || !config.enabled) return true;
    return config.enabled[id] !== false;
  }

  function readExtensionEntries() {
    const config = readConfig();
    let entries;
    try {
      entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const extensions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(extensionsDir, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      } catch (error) {
        log(`skip ${entry.name}: ${error.message}`);
        continue;
      }
      const id = manifest.id || entry.name;
      const main = path.join(directory, manifest.main || 'index.js');
      let source;
      try {
        source = fs.readFileSync(main, 'utf8');
      } catch (error) {
        log(`skip ${id}: ${error.message}`);
        continue;
      }
      extensions.push({ id, manifest, source, enabled: isEnabled(id, config) });
    }
    return extensions;
  }

  function buildInjection(enabled, all) {
    const panel = JSON.stringify(all.map(({ id, manifest, enabled: isEnabledValue }) => ({
      id,
      name: manifest.name || id,
      version: manifest.version || '',
      enabled: isEnabledValue
    })));
    const body = enabled.map((extension) => `
(function () {
  const manifest = ${JSON.stringify(extension.manifest)};
  const cleanups = [];
  function findWebviews() {
    const found = [];
    const seen = new Set();
    const walk = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      for (const element of root.querySelectorAll('*')) {
        if (element.tagName === 'WEBVIEW') found.push(element);
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    walk(document);
    return found;
  }
  const api = {
    id: ${JSON.stringify(extension.id)},
    manifest,
    version: ${JSON.stringify(VERSION)},
    extensions: ${panel},
    browser: {
      list() {
        return findWebviews().map((webview, index) => ({ index, src: webview.src || '' }));
      },
      async eval(index, code) {
        const webview = findWebviews()[index];
        if (!webview) throw new Error('webview not found');
        return webview.executeJavaScript(String(code));
      },
      async load(index, url) {
        const webview = findWebviews()[index];
        if (!webview) throw new Error('webview not found');
        return webview.loadURL(String(url));
      },
      async fill(index, selector, value) {
        const webview = findWebviews()[index];
        if (!webview) throw new Error('webview not found');
        return webview.executeJavaScript(
          '(() => { const el = document.querySelector(' + JSON.stringify(String(selector)) + ');' +
          ' if (!el) return false; el.focus(); el.value = ' + JSON.stringify(String(value)) + ';' +
          ' el.dispatchEvent(new Event("input", { bubbles: true }));' +
          ' el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()'
        );
      }
    },
    addStyle(css) {
      const element = document.createElement('style');
      element.textContent = String(css);
      (document.head || document.documentElement).appendChild(element);
      const remove = () => element.remove();
      cleanups.push(remove);
      return remove;
    },
    on(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      const remove = () => target.removeEventListener(type, listener, options);
      cleanups.push(remove);
      return remove;
    },
    onCleanup(fn) {
      if (typeof fn === 'function') cleanups.push(fn);
    },
    log(...args) {
      console.log('[CodexPP][' + (manifest.id || 'extension') + ']', ...args);
    }
  };
  try {
    const result = (function (api) {
${extension.source}
    })(api);
    if (typeof result === 'function') api.onCleanup(result);
  } catch (error) {
    api.log('extension failed', error && error.stack ? error.stack : String(error));
  }
  window.addEventListener('pagehide', () => {
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch {}
    }
  }, { once: true });
})();
`).join('\n');
    return `(function () {
      if (window.__codexppInjected) return;
      window.__codexppInjected = true;
${body}
    })();`;
  }

  function inject(contents) {
    if (!contents || contents.isDestroyed()) return;
    let url = '';
    try { url = contents.getURL(); } catch {}
    if (!url.startsWith('app://')) return;
    const all = readExtensionEntries();
    const enabled = all.filter((extension) => extension.enabled);
    if (enabled.length === 0) {
      log('no enabled extensions for app://');
      return;
    }
    const code = buildInjection(enabled, all);
    contents.executeJavaScript(code, true)
      .then(() => {
        log(`injected ${enabled.length} extension(s) into app://`);
        setTimeout(() => {
          if (contents.isDestroyed()) return;
          contents.executeJavaScript(
            '({ready: document.readyState, codexppNodes: document.querySelectorAll("[id^=codexpp-]").length})',
            true
          ).then((info) => log(`dom ${JSON.stringify(info)}`))
            .catch((error) => log(`dom probe failed: ${error && error.message ? error.message : error}`));
        }, 2500);
      })
      .catch((error) => log(`injection failed for app://: ${error && error.message ? error.message : error}`));
  }

  function settingsSnapshot() {
    const all = readExtensionEntries();
    return {
      extensions: all.map(({ id, manifest, enabled }) => ({
        id,
        name: manifest.name || id,
        version: manifest.version || '',
        description: manifest.description || '',
        enabled
      })),
      extensionsPaused: false,
      intent: 0,
      selectedExtensionId: null
    };
  }

  function pushSettingsSnapshot(contents) {
    if (!contents || contents.isDestroyed()) return;
    const snapshot = JSON.stringify(settingsSnapshot());
    contents.executeJavaScript(
      `window.__codexppSnapshot=${snapshot};globalThis.__codexPPNativeSettings&&globalThis.__codexPPNativeSettings.update(window.__codexppSnapshot);`,
      true
    ).catch(() => {});
  }

  function handleCommand(contents, command) {
    if (command === 'reload') {
      try { contents.reload(); } catch {}
      return;
    }
    if (command === 'open-log') {
      shell.openPath(logFile);
      return;
    }
    if (command === 'open-extensions') {
      shell.openPath(extensionsDir);
      return;
    }
    const toggle = command.match(/^toggle:(.+):(true|false)$/);
    if (toggle) {
      const config = readConfig();
      config.enabled = config.enabled || {};
      config.enabled[toggle[1]] = toggle[2] === 'true';
      try {
        fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
      } catch (error) {
        log(`config write failed: ${error.message}`);
      }
      log(`extension ${toggle[1]} -> ${toggle[2]}`);
      pushSettingsSnapshot(contents);
      return;
    }
    log(`unknown command ${command}`);
  }

  function handleConsole(contents, message) {
    if (typeof message !== 'string') return;
    if (message.includes('[CodexPP]')) log(`renderer ${message}`);
    const command = message.match(/\[CodexPP:cmd\]\s*(.+)$/);
    if (command) handleCommand(contents, command[1].trim());
  }

  function togglePanelAll() {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      let url = '';
      try { url = contents.getURL(); } catch {}
      if (!url.startsWith('app://')) continue;
      contents.executeJavaScript('window.__codexppSettingsToggle && window.__codexppSettingsToggle()', true)
        .catch(() => {});
    }
    log('panel toggled');
  }

  function applyFocus(on) {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.setFullScreen(on);
        win.setMenuBarVisibility(!on);
      } catch {}
    }
    log(`focus ${on ? 'on' : 'off'}`);
  }

  function attach(contents) {
    contents.on('did-finish-load', () => {
      log(`did-finish-load ${describe(contents)}`);
      inject(contents);
      pushSettingsSnapshot(contents);
    });
    contents.on('console-message', (eventOrLevel, levelOrMessage, maybeMessage) => {
      const message = typeof maybeMessage === 'string' ? maybeMessage : (eventOrLevel && eventOrLevel.message);
      handleConsole(contents, message);
    });
  }

  function describe(contents) {
    let type = '?';
    let scheme = '';
    try { type = contents.getType(); } catch {}
    try { scheme = new URL(contents.getURL()).protocol; } catch {}
    return `id=${contents.id} type=${type} scheme=${scheme}`;
  }

  app.on('web-contents-created', (event, contents) => {
    log(`web-contents-created ${describe(contents)}`);
    attach(contents);
  });

  try {
    const existing = webContents.getAllWebContents();
    log(`existing webContents ${existing.length}`);
    for (const contents of existing) {
      log(`existing ${describe(contents)}`);
      attach(contents);
      let url = '';
      try { url = contents.getURL(); } catch {}
      if (url.startsWith('app://')) inject(contents);
    }
  } catch (error) {
    log(`webContents enumeration failed: ${error && error.message ? error.message : error}`);
  }

  async function captureAppshot(out) {
    try {
      const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
      const window = windows.find((candidate) => candidate.isVisible()) || windows[0];
      if (!window) {
        log('appshot: no window');
        return;
      }
      const image = await window.webContents.capturePage();
      const png = image.toPNG();
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, png);
      let text = '';
      try {
        text = await window.webContents.executeJavaScript('document.body.innerText.slice(0, 200000)', true);
      } catch {}
      const size = image.getSize();
      fs.writeFileSync(`${out}.json`, JSON.stringify({
        path: out,
        width: size.width,
        height: size.height,
        title: window.getTitle(),
        text,
        capturedAt: new Date().toISOString()
      }, null, 2));
      log(`appshot ${out} ${size.width}x${size.height}`);
    } catch (error) {
      log(`appshot failed: ${error && error.message ? error.message : error}`);
    }
  }

  let lastCommandTs = 0;
  try {
    const existingCommand = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
    if (existingCommand && existingCommand.ts) lastCommandTs = existingCommand.ts;
  } catch {}
  function pollCommand() {
    let command;
    try {
      command = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
    } catch {
      return;
    }
    if (!command || !command.ts || command.ts === lastCommandTs) return;
    lastCommandTs = command.ts;
    if (command.panel) togglePanelAll();
    if (typeof command.focus === 'boolean') applyFocus(command.focus);
    if (command.appshot) {
      const out = command.out || path.join(root, 'appshots', `appshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      captureAppshot(out);
    }
  }

  try {
    fs.watchFile(commandFile, { interval: 1000 }, pollCommand);
  } catch {}
  setTimeout(pollCommand, 2000);

  log('bootstrap loaded');
  require('./' + __CODEXPP_ORIGINAL_MAIN__);
})();
