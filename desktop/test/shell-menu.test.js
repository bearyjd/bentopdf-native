'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildShellMenuTemplate } = require('../src/shell/shell-menu');
const { adapterFor, handoffScript, DEFAULT_ADAPTER } = require('../src/shell/handoff');

const flatten = (items) => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])]);

function menu(options) {
  const calls = [];
  const names = ['openFile', 'openRecent', 'closeTab', 'nextTab', 'previousTab', 'reloadTool', 'zoom', 'showAbout', 'openSource'];
  const actions = Object.fromEntries(names.map((n) => [n, (...args) => calls.push([n, ...args])]));
  return { items: flatten(buildShellMenuTemplate(actions, options)), calls };
}

test('shell menu: accelerators and actions on Linux/Windows', () => {
  const { items, calls } = menu({ recents: [{ id: 'r1', name: 'a&b.pdf' }], platform: 'linux' });
  const byId = Object.fromEntries(items.filter((i) => i.id).map((i) => [i.id, i]));
  assert.equal(byId.open.accelerator, 'CmdOrCtrl+O');
  assert.equal(byId['close-tab'].accelerator, 'CmdOrCtrl+W');
  assert.equal(byId['next-tab'].accelerator, 'Ctrl+Tab');
  assert.equal(byId['previous-tab'].accelerator, 'Ctrl+Shift+Tab');
  assert.equal(byId['reload-tool'].accelerator, 'CmdOrCtrl+R');
  assert.ok(!items.some((i) => i.role === 'close' || i.role === 'reload' || i.role === 'zoomIn'), 'tab actions are explicit, not focus-based roles');
  assert.ok(items.some((i) => i.role === 'quit'));
  assert.ok(!items.some((i) => i.role === 'appMenu'));
  for (const id of ['open', 'close-tab', 'next-tab', 'previous-tab', 'reload-tool', 'zoom-in', 'zoom-out', 'zoom-reset', 'about', 'source']) byId[id].click();
  const recent = byId.recent.submenu[0];
  assert.equal(recent.label, 'a&&b.pdf', 'ampersand escaped (no accidental mnemonic)');
  recent.click();
  assert.deepEqual(calls.map((c) => c.join(':')), [
    'openFile', 'closeTab', 'nextTab', 'previousTab', 'reloadTool', 'zoom:1', 'zoom:-1', 'zoom:0', 'showAbout', 'openSource', 'openRecent:r1',
  ]);
});

test('shell menu: empty recents, macOS app menu, devtools only when asked', () => {
  const mac = menu({ platform: 'darwin' }).items;
  assert.ok(mac.some((i) => i.role === 'appMenu'));
  const recent = mac.find((i) => i.id === 'recent');
  assert.deepEqual(recent.submenu, [{ label: 'No recent files', enabled: false }]);
  assert.ok(!mac.some((i) => i.role === 'toggleDevTools'));
  assert.ok(menu({ devtools: true, platform: 'linux' }).items.some((i) => i.role === 'toggleDevTools'));
});

test('handoff adapters: Merge PDF is specific, everything else uses the default input', () => {
  assert.deepEqual(adapterFor('merge-pdf'), { toolId: 'merge-pdf', selector: '#file-input', multiple: true });
  assert.deepEqual(adapterFor('split-pdf'), { toolId: 'split-pdf', ...DEFAULT_ADAPTER });
  assert.deepEqual(adapterFor('__proto__'), { toolId: '__proto__', ...DEFAULT_ADAPTER });
});

test('handoffScript: only token/name/size from main, JSON-escaped, single file unless multiple', () => {
  const entries = [
    { token: 't1', name: "evil'); alert(1); ('.pdf", size: 3, filePath: '/secret/path.pdf' },
    { token: 't2', name: 'b.pdf', size: 4 },
  ];
  const single = handoffScript(entries, { selector: 'input[type="file"]', multiple: false });
  assert.ok(!single.includes('/secret/path.pdf'), 'no path reaches the page');
  assert.ok(!single.includes('t2'), 'single-file adapter gets one file');
  assert.ok(single.includes(JSON.stringify(entries[0].name)));
  assert.ok(single.includes(JSON.stringify('input[type="file"]')));
  const multi = handoffScript(entries, { selector: '#file-input', multiple: true });
  assert.ok(multi.includes('"t1"') && multi.includes('"t2"'));
  assert.doesNotThrow(() => new Function(multi), 'script parses');
});
