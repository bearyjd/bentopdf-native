'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { CHANNELS } = require('../src/channels');
const { registerIpc } = require('../src/ipc');
const { pushCapped, addCapped, createLogLimiter, serialByKey, DEFAULT_CAP } = require('../src/shell/bounded');
const { releaseSession } = require('../src/shell/sessions');
const { DEFAULT_TRANSPORT, startKindFor } = require('../src/start-mode');

test('bounded: accumulators keep only the newest entries', () => {
  const list = [];
  for (let i = 0; i < DEFAULT_CAP * 3; i += 1) pushCapped(list, i);
  assert.equal(list.length, DEFAULT_CAP);
  assert.equal(list[0], DEFAULT_CAP * 2);
  assert.equal(list.at(-1), DEFAULT_CAP * 3 - 1);
  const set = new Set();
  for (let i = 0; i < 50; i += 1) addCapped(set, `u${i}`, 10);
  assert.equal(set.size, 10);
  assert.equal(set.has('u49') && !set.has('u39'), true);
  addCapped(set, 'u40', 10); // re-adding refreshes, does not grow
  assert.equal(set.size, 10);
  assert.equal([...set].at(-1), 'u40');
});

test('bounded: log limiter allows N lines per window per key, one notice, then drops; the window rolls over', () => {
  let t = 0;
  const verdict = createLogLimiter({ limit: 3, windowMs: 1000, now: () => t });
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => verdict('p1')), ['log', 'log', 'log', 'notice', 'drop', 'drop']);
  assert.equal(verdict('p2'), 'log', 'another partition has its own budget');
  t = 1000;
  assert.equal(verdict('p1'), 'log', 'new window');
  const bounded = createLogLimiter({ maxKeys: 5, now: () => t });
  for (let i = 0; i < 100; i += 1) bounded(`k${i}`);
});

test('bounded: serialByKey runs one task at a time per key, other keys in parallel, and isolates failures', async () => {
  const running = new Map();
  let overlap = false;
  const order = [];
  const run = serialByKey(async (key) => {
    running.set(key, (running.get(key) || 0) + 1);
    if (running.get(key) > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 15));
    order.push(key);
    running.set(key, running.get(key) - 1);
    if (key === 'bad') throw new Error('boom');
    return key;
  });
  const results = await Promise.allSettled([run('a'), run('a'), run('a'), run('b'), run('bad'), run('bad')]);
  assert.equal(overlap, false);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'rejected']);
  assert.equal(order.indexOf('b') < order.lastIndexOf('a'), true, 'a different key did not wait for the whole a queue');
  assert.equal(await run('a'), 'a', 'queue still usable after a rejection');
});

test('releaseSession: every release step runs, a failing step is logged and does not stop the others', async () => {
  const calls = [];
  const step = (name, fail) => async () => {
    calls.push(name);
    if (fail) throw new Error(`${name} failed`);
  };
  const ses = {
    clearStorageData: step('storage'),
    clearCache: step('cache', true),
    clearHostResolverCache: step('dns'),
    clearAuthCache: step('auth'),
    closeAllConnections: step('connections'),
  };
  const logged = [];
  await releaseSession(ses, (m) => logged.push(m));
  assert.deepEqual(calls.sort(), ['auth', 'cache', 'connections', 'dns', 'storage']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /cache/);
});

test('start mode: the default start path is the tabbed shell; http is only the test harness', () => {
  assert.equal(DEFAULT_TRANSPORT, 'scheme');
  assert.equal(startKindFor(DEFAULT_TRANSPORT), 'shell');
  assert.equal(startKindFor('http'), 'single-window-test-harness');
});

function dialogHarness(allowed) {
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  const opened = [];
  const dialogs = {
    showOpenDialog: async () => (opened.push('open'), { canceled: true }),
    showSaveDialog: async () => (opened.push('save'), { canceled: true }),
  };
  const sender = (id) => Object.assign(new EventEmitter(), { id });
  const event = (id) => ({ sender: sender(id), senderFrame: { url: 'bento://app/index.html', parent: null } });
  registerIpc({ ipcMain, origin: 'bento://app', dialogs, getWindow: () => null, canUseDialogs: (wc) => allowed.has(wc.id) });
  return { call: (channel, id, ...args) => handlers.get(channel)(event(id), ...args), opened };
}

test('dialogs: openFile and saveFile are refused for a sender that is not allowed (hidden background tab)', async () => {
  const h = dialogHarness(new Set([1]));
  assert.deepEqual(await h.call(CHANNELS.openFile, 1, {}), []);
  assert.deepEqual(await h.call(CHANNELS.saveFile, 1, 'a.pdf', new Uint8Array(1)), { saved: false });
  await assert.rejects(Promise.resolve().then(() => h.call(CHANNELS.openFile, 2, {})), /only available to the active tab/);
  await assert.rejects(Promise.resolve().then(() => h.call(CHANNELS.saveFile, 2, 'a.pdf', new Uint8Array(1))), /only available to the active tab/);
  assert.deepEqual(h.opened, ['open', 'save'], 'no dialog was opened for the refused sender');
});

test('sanitizeText: page-originated text is capped and loses control and bidi characters', () => {
  const { sanitizeText, MAX_TEXT } = require('../src/shell/bounded');
  assert.equal(MAX_TEXT, 300);
  assert.equal(sanitizeText('a\nb\r\nc\td\u0000e\u001b[31mf\u007fg\u0085h i‮j'), 'a b c d e [31mf g h i j');
  assert.equal(sanitizeText('x'.repeat(5000)).length, 300);
  assert.ok(sanitizeText('x'.repeat(5000)).endsWith('…'));
  assert.equal(sanitizeText('y'.repeat(300)), 'y'.repeat(300));
  assert.equal(sanitizeText(undefined), '');
  assert.equal(sanitizeText(null), '');
  assert.equal(sanitizeText({ toString: () => 'obj\nline' }), 'obj line');
  assert.equal(sanitizeText('  padded  '), 'padded');
});

test('createLimitedLogger: limits per key, one notice, keys are independent, and the notice does not repeat the dropped text', () => {
  const { createLimitedLogger, createLogLimiter } = require('../src/shell/bounded');
  const lines = [];
  const logLimited = createLimitedLogger((m) => lines.push(m), createLogLimiter({ limit: 2, now: () => 0 }));
  for (let i = 0; i < 5; i += 1) logLimited('a', `line ${i}`);
  logLimited('b', 'other key');
  assert.deepEqual(lines, ['line 0', 'line 1', '(a) further log lines suppressed for a minute', 'other key']);
});
