#!/usr/bin/env node
'use strict';

const adapterOffset = process.argv[1] === '--run-adapter' ? 1
  : process.argv[2] === '--run-adapter' ? 2 : -1;
if (adapterOffset > 0) {
  try {
    require('./adapter-runner').runAdapter(
      process.argv[adapterOffset + 1],
      process.argv[adapterOffset + 2],
      process.argv[adapterOffset + 3]
    );
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const install = require('./install');
const { selfUpdateCommand } = require('./selfupdate');

function usage() {
  console.log(`Codex++ for Windows

Usage:
  node src/cli.js verify [--fast]        Verify the installed Store package and its signature
  node src/cli.js install [--fast] [--sign] [--no-startup] [--startup-chunks shared,initial] [--launch]
                                        Verify, copy, patch and record a private Codex copy
  node src/cli.js repatch [--fast] [--sign] [--no-startup] [--startup-chunks shared,initial]
                                        Restore the two patched files from the Store package and patch again
  node src/cli.js sign                  Sign the patched exe with a locally trusted self-signed certificate
  node src/cli.js appshot [--out path] [--open]
                                        Capture the Codex window to a PNG
  node src/cli.js check-update          Compare the patched copy with the installed Store package
  node src/cli.js update [--launch]     Reinstall from the new Store package when it changed
  node src/cli.js self-update [--manifest path|url] [--target dir] [--check]
                                        Verify and install a Codex++ source update
  node src/cli.js tray                  Start the tray helper
  node src/cli.js launch                Launch the patched copy
  node src/cli.js status                Show patch health and Store version drift
  node src/cli.js restore               Delete the patched copy (the Store app is untouched)
  node src/cli.js ext list              List extensions
  node src/cli.js ext enable <id>       Enable an extension
  node src/cli.js ext disable <id>      Disable an extension
  node src/cli.js ext add <directory>   Install a local extension folder
  node src/cli.js doctor                Print environment diagnostics
`);
}

function flags(args) {
  const set = new Set(args.filter((arg) => arg.startsWith('--')));
  return {
    fast: set.has('--fast'),
    launch: set.has('--launch'),
    sign: set.has('--sign'),
    noStartup: set.has('--no-startup'),
    startup: set.has('--startup'),
    startupMain: set.has('--startup-main'),
    startupChunks: args.includes('--startup-chunks') ? args[args.indexOf('--startup-chunks') + 1] : undefined,
    open: set.has('--open'),
    check: set.has('--check'),
    out: args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined,
    manifest: args.includes('--manifest') ? args[args.indexOf('--manifest') + 1] : undefined,
    target: args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined,
    full: !set.has('--fast')
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = flags(rest);
  try {
    switch (command) {
      case 'verify':
        await install.verifyCommand(options);
        break;
      case 'install':
        await install.installCommand(options);
        break;
      case 'repatch':
        await install.repatchCommand(options);
        break;
      case 'sign':
        install.signCommand();
        break;
      case 'appshot':
        await install.appshotCommand(options);
        break;
      case 'check-update':
        install.checkUpdateCommand();
        break;
      case 'update':
        await install.updateCommand(options);
        break;
      case 'self-update':
        await selfUpdateCommand(options);
        break;
      case 'tray':
        install.trayCommand();
        break;
      case 'launch':
        await install.launchCommand();
        break;
      case 'status':
        install.statusCommand();
        break;
      case 'restore':
        install.restoreCommand();
        break;
      case 'doctor':
        install.doctorCommand();
        break;
      case 'ext':
        await extensions(rest.filter((arg) => !arg.startsWith('--')));
        break;
      case '--help':
      case '-h':
      case 'help':
      case undefined:
        usage();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        usage();
        process.exitCode = 2;
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    if (process.env.CODEXPP_DEBUG) console.error(error.stack);
    process.exitCode = 1;
  }
}

async function extensions(args) {
  const [action, value] = args;
  switch (action) {
    case 'list':
    case undefined:
      install.listExtensions();
      break;
    case 'enable':
      if (!value) throw new Error('Usage: ext enable <id>');
      install.setExtensionEnabled(value, true);
      break;
    case 'disable':
      if (!value) throw new Error('Usage: ext disable <id>');
      install.setExtensionEnabled(value, false);
      break;
    case 'add':
      if (!value) throw new Error('Usage: ext add <directory>');
      install.addExtension(value);
      break;
    default:
      throw new Error(`Unknown ext action: ${action}`);
  }
}

main();
