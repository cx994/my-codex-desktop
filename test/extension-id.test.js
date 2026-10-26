'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpp-extension-test-'));
process.env.APPDATA = path.join(temp, 'Roaming');
process.env.LOCALAPPDATA = path.join(temp, 'Local');

const install = require('../src/install');
const extensions = path.join(process.env.APPDATA, 'CodexPP', 'extensions');
fs.mkdirSync(extensions, { recursive: true });

const roamingSentinel = path.join(process.env.APPDATA, 'sentinel.txt');
const supportSentinel = path.join(process.env.APPDATA, 'CodexPP', 'sentinel.txt');
fs.writeFileSync(roamingSentinel, 'keep');
fs.writeFileSync(supportSentinel, 'keep');

let counter = 0;
function makeSource(manifest, main = 'index.js') {
  const directory = path.join(temp, `source-${++counter}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  if (main) fs.writeFileSync(path.join(directory, main), 'console.log("test");\n');
  return directory;
}

const badIds = [
  '..',
  '..\\..',
  '../evil',
  'C:\\Windows',
  'CON',
  'com1.foo',
  'a/b',
  'a\\b',
  'x.',
  '.hidden',
  ''
];

for (const id of badIds) {
  const source = makeSource({ id, name: 'bad', version: '0', main: 'index.js' });
  assert.throws(() => install.addExtension(source), /Unsafe|escapes|no id|Missing entry/);
  assert.ok(fs.existsSync(roamingSentinel), `roaming sentinel survived ${JSON.stringify(id)}`);
  assert.ok(fs.existsSync(supportSentinel), `support sentinel survived ${JSON.stringify(id)}`);
}

const traversalMain = makeSource({ id: 'com.test.traversal', name: 'bad', version: '0', main: '../../sentinel.txt' });
assert.throws(() => install.addExtension(traversalMain), /escapes|Missing entry/);
assert.ok(fs.existsSync(roamingSentinel));
assert.ok(!fs.existsSync(path.join(extensions, 'com.test.traversal')));

const absoluteMain = makeSource({ id: 'com.test.absolute', name: 'bad', version: '0', main: 'C:\\Windows\\notepad.exe' });
assert.throws(() => install.addExtension(absoluteMain), /escapes/);
assert.ok(!fs.existsSync(path.join(extensions, 'com.test.absolute')));

const valid = makeSource({ id: 'com.test.ok', name: 'ok', version: '1', main: 'index.js' });
const target = install.addExtension(valid);
assert.ok(target.startsWith(path.resolve(extensions) + path.sep));
assert.ok(fs.existsSync(path.join(target, 'index.js')));
assert.ok(fs.existsSync(path.join(target, 'manifest.json')));

console.log('extension id regression: ok');
fs.rmSync(temp, { recursive: true, force: true });
