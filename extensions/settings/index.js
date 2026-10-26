const host = document.createElement('div');
host.id = 'codexpp-settings-host';
host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;pointer-events:none;';
const shadow = host.attachShadow({ mode: 'open' });

const extensions = Array.isArray(api.extensions) ? api.extensions : [];
const rows = extensions.map((extension) => `
  <div class="row" data-id="${escapeHtml(extension.id)}">
    <div class="meta">
      <div class="name">${escapeHtml(extension.name || extension.id)}</div>
      <div class="id">${escapeHtml(extension.id)}${extension.version ? ` · ${escapeHtml(extension.version)}` : ''}</div>
    </div>
    <button class="toggle ${extension.enabled ? 'on' : 'off'}" data-enabled="${extension.enabled}">
      ${extension.enabled ? 'On' : 'Off'}
    </button>
  </div>
`).join('');

shadow.innerHTML = `
  <style>
    :host { all: initial; }
    .panel {
      position: fixed;
      top: 56px;
      right: 16px;
      bottom: 56px;
      width: 360px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      border-radius: 14px;
      border: 1px solid rgba(120, 130, 160, 0.28);
      background: #ffffff;
      color: #1d2330;
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 18px 50px rgba(15, 20, 35, 0.24);
      pointer-events: auto;
      overflow: auto;
    }
    @media (prefers-color-scheme: dark) {
      .panel { background: #171a22; color: #e6e9f2; border-color: rgba(140, 150, 190, 0.3); }
      .row { border-color: rgba(140, 150, 190, 0.18); }
      .id { color: #9aa3b8; }
      .toggle.off { background: rgba(255,255,255,0.08); color: #cfd5e4; }
      .action { background: rgba(255,255,255,0.06); color: #e6e9f2; border-color: rgba(255,255,255,0.12); }
      .hint { color: #9aa3b8; }
    }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .title { font-size: 15px; font-weight: 650; letter-spacing: 0.01em; }
    .version { font-size: 11px; opacity: 0.6; margin-left: 6px; }
    .close { border: 0; background: transparent; color: inherit; font-size: 18px; cursor: pointer; opacity: 0.65; padding: 2px 6px; border-radius: 6px; }
    .close:hover { opacity: 1; background: rgba(120,130,160,0.12); }
    .section { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.55; margin-top: 2px; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(120,130,160,0.18); }
    .row:last-child { border-bottom: 0; }
    .name { font-weight: 600; }
    .id { font-size: 11px; color: #6b7488; }
    .toggle { border: 1px solid transparent; border-radius: 999px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; }
    .toggle.on { background: #2f6fed; color: #fff; }
    .toggle.off { background: #eef1f7; color: #4a5368; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: auto; }
    .action { border: 1px solid rgba(120,130,160,0.28); background: #f6f8fc; color: #1d2330; border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
    .action:hover { border-color: #2f6fed; }
    .hint { font-size: 11px; color: #6b7488; }
    .notice { font-size: 11px; color: #2f6fed; min-height: 14px; }
  </style>
  <div class="panel" role="dialog" aria-label="Codex++ settings">
    <div class="head">
      <div>
        <span class="title">Codex++</span>
        <span class="version">${escapeHtml(api.version || '')}</span>
      </div>
      <button class="close" title="Close">×</button>
    </div>
    <div class="section">Extensions</div>
    <div class="list">${rows || '<div class="hint">No extensions installed.</div>'}</div>
    <div class="notice" id="notice"></div>
    <div class="actions">
      <button class="action" data-action="reload">Reload window</button>
      <button class="action" data-action="open-extensions">Extensions folder</button>
      <button class="action" data-action="open-log">Open log</button>
    </div>
    <div class="hint">Toggle writes config; reload the window to apply. Settings live in %APPDATA%\\CodexPP\\config.json.</div>
  </div>
`;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function togglePanel(force) {
  const open = force === undefined ? host.style.display === 'none' : force === true;
  host.style.display = open ? 'block' : 'none';
  host.style.pointerEvents = 'none';
  return open;
}

const notice = shadow.getElementById('notice');

shadow.querySelector('.close').addEventListener('click', () => togglePanel(false));
shadow.querySelectorAll('.toggle').forEach((button) => {
  button.addEventListener('click', () => {
    const row = button.closest('.row');
    const id = row?.dataset.id;
    if (!id) return;
    const enabled = button.dataset.enabled !== 'true';
    button.dataset.enabled = String(enabled);
    button.className = `toggle ${enabled ? 'on' : 'off'}`;
    button.textContent = enabled ? 'On' : 'Off';
    api.log(`[CodexPP:cmd] toggle:${id}:${enabled}`);
    if (notice) notice.textContent = 'Saved. Reload the window to apply.';
  });
});
shadow.querySelectorAll('.action').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'reload') api.log('[CodexPP:cmd] reload');
    if (action === 'open-extensions') api.log('[CodexPP:cmd] open-extensions');
    if (action === 'open-log') api.log('[CodexPP:cmd] open-log');
  });
});

api.on(window, 'keydown', (event) => {
  if (event.ctrlKey && event.altKey && event.shiftKey && (event.key === ',' || event.key === '<' || event.code === 'Comma')) {
    event.preventDefault();
    togglePanel();
  }
  if (event.key === 'Escape' && host.style.display === 'block') {
    togglePanel(false);
  }
}, true);

window.__codexppSettingsToggle = () => togglePanel();
document.documentElement.appendChild(host);
api.onCleanup(() => {
  if (window.__codexppSettingsToggle) delete window.__codexppSettingsToggle;
  host.remove();
});
api.log('settings panel ready');
