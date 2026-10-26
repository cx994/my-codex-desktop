'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.join(process.env.LOCALAPPDATA, 'CodexPP', 'app', 'app');
const exe = path.join(appDir, 'ChatGPT.exe');
const log = path.join(process.env.APPDATA, 'CodexPP', 'codexpp.log');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function kill() {
  spawnSync('taskkill.exe', ['/IM', 'ChatGPT.exe', '/T', '/F'], { windowsHide: true });
}

async function run() {
  kill();
  await sleep(2000);
  const before = fs.existsSync(log) ? fs.statSync(log).size : 0;
  const started = Date.now();
  const child = spawn(exe, [], { cwd: appDir, detached: true, stdio: 'ignore' });
  child.unref();
  let boot = null;
  let loaded = null;
  let dom = null;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(250);
    if (!fs.existsSync(log)) continue;
    const buffer = fs.readFileSync(log);
    if (buffer.length <= before) continue;
    const text = buffer.subarray(before).toString('utf8');
    if (boot === null && text.includes('bootstrap loaded')) boot = Date.now() - started;
    if (loaded === null && /did-finish-load id=/.test(text)) loaded = Date.now() - started;
    if (dom === null && /dom \{"ready":"complete"/.test(text)) {
      dom = Date.now() - started;
      break;
    }
  }
  kill();
  return { boot, loaded, dom };
}

(async () => {
  const runs = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await run();
    console.log(`run ${index + 1}`, result);
    runs.push(result);
  }
  const median = (key) => {
    const values = runs.map((run) => run[key]).filter((value) => typeof value === 'number').sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  };
  console.log('median', { boot: median('boot'), loaded: median('loaded'), dom: median('dom') });
})();
