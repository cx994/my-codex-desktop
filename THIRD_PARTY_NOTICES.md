# Third-party notices

My Codex Desktop is MIT licensed. It includes or derives from the following
projects:

## b-nnett/codex-plusplus

`adapters/acorn.js`, `adapters/settings-adapter.js`,
`adapters/startup-adapter.js`, `adapters/parser-runner.js` and the Settings
adapter contract are derived from
[b-nnett/codex-plusplus](https://github.com/b-nnett/codex-plusplus), MIT
licensed. The full license is in `adapters/LICENSE.codex-plusplus`.

`adapters/native-settings.js` is a Windows rewrite of the upstream native
Settings runtime; it uses the local console command channel instead of the
macOS helper bridge.

## Acorn

Acorn is MIT licensed. The full license is in `adapters/ACORN-LICENSE`.

## Node.js

The single-file `my-codex-desktop.exe` is built with Node.js Single Executable
Applications and embeds the Node.js runtime. Node.js is MIT licensed; its
license text is included as `NODE-LICENSE` in the extracted tool directory and
in this repository.

## OpenAI Codex / ChatGPT

This project is not affiliated with OpenAI. It operates on a locally installed
copy of the Microsoft Store Codex app and does not redistribute OpenAI
software.
