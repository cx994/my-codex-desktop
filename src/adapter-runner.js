'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { assetPath } = require('./util');

function runAdapter(adapter, requestFile, outputFile) {
  if (adapter !== 'settings' && adapter !== 'startup') {
    throw new Error(`Unknown parser adapter: ${adapter}`);
  }
  const directory = assetPath('adapters');
  const context = vm.createContext({});
  for (const name of ['acorn', `${adapter}-adapter`]) {
    vm.runInContext(fs.readFileSync(path.join(directory, `${name}.js`), 'utf8'), context, {
      filename: name
    });
  }
  context.input = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  const calls = {
    settings: 'CodexPPSettingsAdapter.adapt(input)',
    startup: 'CodexPPStartupAdapter.adapt(input)'
  };
  const result = vm.runInContext(calls[adapter], context, { timeout: 55000 });
  fs.writeFileSync(outputFile, JSON.stringify(result));
}

module.exports = { runAdapter };
