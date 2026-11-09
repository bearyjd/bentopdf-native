'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandoff } = require('../src/shell/handoff-runner');

const ORIGIN = 'app://bento';

// One tab (id 1) on /merge-pdf.html showing doc d1; `beforeInject` lets a test change the world mid-handoff.
function harness({ beforeInject = async () => {}, url = `${ORIGIN}/merge-pdf.html` } = {}) {
  const tab = { id: 1, page: '/merge-pdf.html', toolId: 'merge-pdf', docId: 'd1', partition: 'p1', epoch: 0 };
  const state = { epoch: 0, url, view: null, statuses: new Map(), injected: 0, logs: [] };
  const wc = { isDestroyed: () => false, getURL: () => state.url, executeJavaScript: async () => { state.injected += 1; return 1; } };
  state.view = { webContents: wc };
  const handoffSeq = new Map();
  const handoffs = [];
  const run = createHandoff({
    tabs: { get: () => ({ ...tab, epoch: state.epoch }), has: () => true, viewOf: () => state.view },
    store: { get: () => ({ id: 'd1', name: 'a.pdf', bytes: new Uint8Array(1) }), has: () => true, touch: () => {} },
    registry: { get: () => ({ name: 'Merge PDF' }) },
    toolIpc: { grantBytes: () => ({ token: 't' }), grantPath: async () => ({ token: 't' }) },
    origin: ORIGIN,
    handoffSeq,
    handoffs,
    beforeInject: (info) => beforeInject(info, state),
    logLimited: (_k, m) => state.logs.push(m),
    getStatus: (id) => state.statuses.get(id),
    setStatus: (id, s) => (s ? state.statuses.set(id, s) : state.statuses.delete(id)),
    adapterFor: () => ({ selector: 'input', multiple: false }),
    handoffScript: () => 'script',
    isTargetPage: (url2, origin, page) => url2 === `${origin}${page}`,
    pushCapped: (arr, v) => arr.push(v),
    sanitizeText: (t) => String(t),
  });
  return { tab, state, handoffs, run: () => run(tab, state.view) };
}

test('handoff: an undisturbed handoff injects once, records itself and clears its status', async () => {
  const h = harness();
  await h.run();
  assert.equal(h.state.injected, 1);
  assert.equal(h.handoffs.length, 1);
  assert.equal(h.state.statuses.size, 0);
});

test('handoff: a same-page reload during the settle (epoch moves, URL unchanged) is dropped by the epoch guard alone', async () => {
  const h = harness({ beforeInject: async (_i, s) => { s.epoch += 1; } });
  await h.run();
  assert.equal(h.state.injected, 0);
  assert.equal(h.handoffs.length, 0);
  assert.equal(h.state.statuses.size, 0, 'a superseded handoff clears its own Loading status');
});

test('handoff: a URL that changed with the epoch unchanged is dropped by the URL re-check alone', async () => {
  const h = harness({ beforeInject: async (_i, s) => { s.url = `${ORIGIN}/split-pdf.html`; } });
  await h.run();
  assert.equal(h.state.injected, 0);
  assert.equal(h.handoffs.length, 0);
  assert.equal(h.state.statuses.size, 0);
});

test('handoff: a newer handoff owns the status; the older dropped one does not clear it', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const h = harness({ beforeInject: async () => { calls += 1; if (calls === 1) await gate; } });
  const first = h.run(); // parked in its settle
  await new Promise((r) => setImmediate(r));
  h.state.epoch += 1; // the tab navigated: the first handoff is now stale
  h.tab.epoch = 1; // the second handoff is for the new navigation
  const second = h.run();
  await second; // injects and clears
  assert.equal(h.state.injected, 1);
  h.state.statuses.set(1, { kind: 'loading', text: 'newer owner' });
  release();
  await first;
  assert.equal(h.state.injected, 1, 'the stale handoff never injects');
  assert.equal(h.state.statuses.get(1)?.text, 'newer owner', 'the stale handoff leaves the newer status alone');
});
