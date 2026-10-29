'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { SHELL_CHANNELS } = require('../src/shell/shell-channels');
const { CHANNELS } = require('../src/channels');
const { registerShellIpc, isShellSender } = require('../src/shell/shell-ipc');

const SHELL = 'bento://shell';
const DOC = '0b6f2a52-6a3e-4c6e-9d37-3f1f7f0c2a11';
const RECENT = '5d9a8a3e-1111-4c6e-9d37-3f1f7f0c2a11';

test('shell preload channel names mirror shell-channels.js and do not overlap the tool bridge', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell', 'shell-preload.js'), 'utf8');
  for (const [key, value] of Object.entries(SHELL_CHANNELS)) {
    assert.ok(source.includes(`${key}: '${value}'`), `${key} missing/different in shell-preload.js`);
  }
  const toolChannels = new Set(Object.values(CHANNELS));
  assert.ok(Object.values(SHELL_CHANNELS).every((c) => !toolChannels.has(c)));
  const toolPreload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.ok(!toolPreload.includes('shell:'), 'tool preload must not reach shell channels');
});

test('isShellSender: only the registered shell WebContents, top frame, shell origin', () => {
  const ev = (id, url, parent = null) => ({ sender: { id }, senderFrame: { url, parent } });
  const ok = { shellOrigin: SHELL, shellId: 7 };
  assert.equal(isShellSender(ev(7, 'bento://shell/shell.html'), ok), true);
  assert.equal(isShellSender(ev(8, 'bento://shell/shell.html'), ok), false, 'another view at the shell origin');
  assert.equal(isShellSender(ev(7, 'bento://app/index.html'), ok), false, 'shell WebContents navigated to a tool page');
  assert.equal(isShellSender(ev(7, 'bento://shell.evil/x'), ok), false);
  assert.equal(isShellSender(ev(7, 'bento://shell/x', {}), ok), false, 'subframe');
  assert.equal(isShellSender(ev(7, 'not a url'), ok), false);
  assert.equal(isShellSender(ev(7, 'bento://shell/shell.html'), { shellOrigin: SHELL, shellId: null }), false, 'before the shell exists');
  assert.equal(isShellSender({ sender: { id: 7 } }, ok), false, 'no frame');
  assert.equal(isShellSender(null, ok), false);
});

function harness() {
  const handlers = new Map();
  const calls = [];
  const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const dispose = registerShellIpc({
    ipcMain,
    shellOrigin: SHELL,
    getShellId: () => 7,
    registry: { has: (id) => id === 'merge-pdf' },
    store: { has: (id) => id === DOC },
    tabs: { has: (id) => id === 1 || id === 2 },
    recents: { pathOf: (id) => (id === RECENT ? '/x/a.pdf' : undefined) },
    actions: Object.fromEntries(['listTools', 'state', 'openTool', 'switchTab', 'closeTab', 'openFileDialog', 'openRecent'].map((n) => [n, record(n)])),
  });
  const shellEvent = { sender: { id: 7 }, senderFrame: { url: `${SHELL}/shell.html`, parent: null } };
  const call = (channel, event, ...args) => Promise.resolve().then(() => handlers.get(channel)(event, ...args));
  return { handlers, calls, dispose, shellEvent, call };
}

test('shell IPC: every channel refuses a tool view, a second shell-origin view and a subframe', async () => {
  const h = harness();
  const hostile = [
    { sender: { id: 3 }, senderFrame: { url: 'bento://app/merge-pdf.html', parent: null } },
    { sender: { id: 8 }, senderFrame: { url: `${SHELL}/shell.html`, parent: null } },
    { sender: { id: 7 }, senderFrame: { url: `${SHELL}/shell.html`, parent: {} } },
  ];
  const invokable = Object.values(SHELL_CHANNELS).filter((c) => c !== SHELL_CHANNELS.stateChanged);
  assert.deepEqual([...h.handlers.keys()].sort(), invokable.sort());
  for (const channel of invokable) {
    for (const event of hostile) await assert.rejects(h.call(channel, event, 'merge-pdf', DOC), /untrusted sender/, channel);
  }
  assert.deepEqual(h.calls, []);
  h.dispose();
  assert.equal(h.handlers.size, 0);
});

test('shell IPC: arguments are validated against main-side state (hostile inputs)', async () => {
  const h = harness();
  const ev = h.shellEvent;
  assert.equal(await h.call(SHELL_CHANNELS.openTool, ev, 'merge-pdf', DOC), 'openTool');
  assert.equal(await h.call(SHELL_CHANNELS.openTool, ev, 'merge-pdf', null), 'openTool');
  assert.equal(await h.call(SHELL_CHANNELS.openTool, ev, 'merge-pdf'), 'openTool');
  for (const tool of ['../index', '__proto__', 'constructor', 'merge-pdf.html', '', 42, null, {}, ['merge-pdf'], 'https://example.com/']) {
    await assert.rejects(h.call(SHELL_CHANNELS.openTool, ev, tool, null), /unknown tool/, String(tool));
  }
  for (const doc of ['/etc/passwd', '__proto__', DOC.toUpperCase(), `${DOC} `, 1, {}, [DOC], '0b6f2a52-6a3e-4c6e-9d37-000000000000']) {
    await assert.rejects(h.call(SHELL_CHANNELS.openTool, ev, 'merge-pdf', doc), /unknown document/, String(doc));
  }
  for (const tab of [0, -1, 3, 1.5, '1', null, {}, Number.MAX_SAFE_INTEGER + 2, NaN]) {
    await assert.rejects(h.call(SHELL_CHANNELS.switchTab, ev, tab), /unknown tab/, String(tab));
    await assert.rejects(h.call(SHELL_CHANNELS.closeTab, ev, tab), /unknown tab/, String(tab));
  }
  for (const recent of ['/x/a.pdf', '__proto__', 0, null, RECENT.slice(1)]) {
    await assert.rejects(h.call(SHELL_CHANNELS.openRecent, ev, recent), /unknown recent/, String(recent));
  }
  assert.equal(await h.call(SHELL_CHANNELS.switchTab, ev, 2), 'switchTab');
  assert.equal(await h.call(SHELL_CHANNELS.openRecent, ev, RECENT), 'openRecent');
  assert.deepEqual(h.calls.map((c) => c[0]), ['openTool', 'openTool', 'openTool', 'switchTab', 'openRecent']);
  assert.deepEqual(h.calls[0], ['openTool', 'merge-pdf', DOC]);
  assert.deepEqual(h.calls[2], ['openTool', 'merge-pdf', null]);
});
