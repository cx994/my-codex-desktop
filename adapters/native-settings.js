(() => {
  if (globalThis.__codexPPNativeSettings) return;
  const initial = globalThis.__codexppSnapshot || {
    extensions: [],
    extensionsPaused: false,
    intent: 0,
    selectedExtensionId: null
  };
  let snapshot = initial;
  let fingerprint = JSON.stringify(snapshot);
  let navigate;
  const listeners = new Set();

  function emit() {
    for (const listener of listeners) listener();
  }

  function update(value) {
    if (!value || typeof value !== 'object') return;
    const next = JSON.stringify(value);
    if (next === fingerprint) return;
    snapshot = value;
    fingerprint = next;
    emit();
  }

  function toggle(id, enabled) {
    console.log(`[CodexPP:cmd] toggle:${id}:${enabled}`);
    update({
      ...snapshot,
      extensions: snapshot.extensions.map((extension) =>
        extension.id === id ? { ...extension, enabled } : extension
      )
    });
  }

  function icon(jsx) {
    return jsx.jsx('svg', {
      viewBox: '0 0 16 16',
      width: 20,
      height: 20,
      fill: 'currentColor',
      'aria-hidden': true,
      children: [[1, 9, 6], [9, 9, 6], [1, 1, 6], [10, 2, 4]].map(([x, y, size], index) =>
        jsx.jsx('rect', { x, y, width: size, height: size, rx: 1.5 }, index)
      )
    });
  }

  function Page({ React, value, components }) {
    const { Page: SettingsPage, Title, Section, Card, Row, Toggle, Button } = components;
    const h = React.createElement;
    return h(
      SettingsPage,
      { title: h(Title, { slug: 'codexpp-extensions' }), 'data-codexpp-native-page': '' },
      h(
        Section,
        null,
        h(Section.Header, { title: 'Extensions' }),
        h(
          Section.Content,
          null,
          h(
            Card,
            null,
            value.extensions.length === 0 && h(Row, { label: 'No extensions installed.' }),
            ...value.extensions.map((extension) =>
              h(Row, {
                key: extension.id,
                label: extension.name || extension.id,
                description: `${extension.id}${extension.version ? ` · ${extension.version}` : ''}`,
                control: (props) =>
                  h(Toggle, {
                    ...props,
                    checked: extension.enabled,
                    onChange: (enabled) => toggle(extension.id, enabled)
                  })
              })
            )
          )
        )
      ),
      h(
        Section,
        null,
        h(Section.Header, { title: 'Codex++' }),
        h(
          Section.Content,
          null,
          h(
            Card,
            null,
            h(Row, {
              label: 'Extensions folder',
              control: h(
                Button,
                { color: 'secondary', size: 'compact', onClick: () => console.log('[CodexPP:cmd] open-extensions') },
                'Open'
              )
            }),
            h(Row, {
              label: 'Reload window',
              control: h(
                Button,
                { color: 'secondary', size: 'compact', onClick: () => console.log('[CodexPP:cmd] reload') },
                'Reload'
              )
            })
          )
        )
      )
    );
  }

  globalThis.__codexPPNativeSettings = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachNavigate(handler) {
      navigate = handler;
      return () => {
        if (navigate === handler) navigate = undefined;
      };
    },
    update,
    render: (React, value, components) => React.createElement(Page, { React, value, components }),
    icon
  };
})();
