'use strict';

// Shell UI: tab strip, tool sidebar with search, recent files. Talks to the
// main process only through window.bentoShell (shell-preload.js). DOM is built
// with textContent only; no HTML strings.
(() => {
  const shell = window.bentoShell;
  const $ = (id) => document.getElementById(id);
  let tools = [];

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of children) node.append(child);
    return node;
  };

  const report = (err) => {
    $('status').textContent = err ? String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '';
  };
  const run = (promise) => promise.then(() => report(null), report);

  function tabTitle(tab) {
    const tool = tab.toolName || 'Home';
    return tab.docName ? `${tab.docName} - ${tool}` : tool;
  }

  function renderTabs(state) {
    const strip = $('tabstrip');
    strip.replaceChildren(
      ...state.tabs.map((tab) =>
        el('div', { className: 'tab', role: 'presentation' }, [
          el('button', {
            className: tab.live ? 'title' : 'title discarded',
            role: 'tab',
            title: tab.live ? tabTitle(tab) : `${tabTitle(tab)} (unloaded by the live-view limit; reloads when selected)`,
            textContent: tabTitle(tab),
            onclick: () => run(shell.switchTab(tab.id)),
          }),
          el('button', { textContent: 'x', title: 'Close tab', ariaLabel: `Close ${tabTitle(tab)}`, onclick: () => run(shell.closeTab(tab.id)) }),
        ])
      )
    );
    for (const [i, tab] of state.tabs.entries()) strip.children[i].setAttribute('aria-selected', String(tab.active));
    $('empty').hidden = state.tabs.length > 0;
  }

  function renderRecents(state) {
    const items = state.recents.map((r) => el('li', {}, [el('button', { textContent: r.name, title: r.name, onclick: () => run(shell.openRecent(r.id)) })]));
    $('recents').replaceChildren(...(items.length ? items : [el('li', { className: 'muted', textContent: 'None yet' })]));
  }

  function renderTools() {
    const query = $('tool-search').value.trim().toLowerCase();
    const shown = tools.filter((t) => !query || t.name.toLowerCase().includes(query) || t.id.includes(query));
    const groups = new Map();
    for (const tool of shown) {
      const key = tool.category || 'Other';
      groups.set(key, [...(groups.get(key) || []), tool]);
    }
    $('tools').replaceChildren(
      ...[...groups].map(([category, list]) =>
        el('section', {}, [
          el('h3', { textContent: category }),
          el('ul', {}, list.map((t) => el('li', {}, [el('button', { textContent: t.name, title: t.name, onclick: () => run(shell.openTool(t.id, null)) })]))),
        ])
      )
    );
    if (shown.length === 0) $('tools').replaceChildren(el('p', { className: 'muted', textContent: 'No tool matches.' }));
  }

  // Progress / failure of handing the active tab's document to its tool (from the main process).
  function renderDocStatus(state) {
    const active = state.tabs.find((t) => t.active);
    const status = active && active.status;
    const line = $('doc-status');
    line.textContent = status ? status.text : '';
    line.className = status ? status.kind : '';
  }

  const render = (state) => {
    renderTabs(state);
    renderDocStatus(state);
    renderRecents(state);
  };

  $('open-file').addEventListener('click', () =>
    run(
      shell.openFileDialog().then((result) => {
        if (result.refused.length) throw new Error(result.refused.map((r) => `${r.name}: ${r.reason}`).join('; '));
      })
    )
  );
  $('tool-search').addEventListener('input', renderTools);
  shell.onStateChanged(render);

  Promise.all([shell.listTools(), shell.getState()]).then(([list, state]) => {
    tools = list;
    renderTools();
    render(state);
    document.body.dataset.ready = 'true';
  }, report);
})();
