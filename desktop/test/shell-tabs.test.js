'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { tabsToDiscard } = require('../src/shell/tab-policy');
const { createTabManager, partitionFor } = require('../src/shell/tab-manager');

test('policy: nothing to discard under the cap', () => {
  const tabs = [{ id: 1, live: true, lastActive: 1 }, { id: 2, live: true, lastActive: 2 }];
  assert.deepEqual(tabsToDiscard(tabs, { activeId: 2, maxLive: 3 }), []);
  assert.deepEqual(tabsToDiscard([], { activeId: null }), []);
});

test('policy: least recently active background tabs go first; the active one never', () => {
  const tabs = [
    { id: 1, live: true, lastActive: 9 }, // active, but oldest by id
    { id: 2, live: true, lastActive: 3 },
    { id: 3, live: true, lastActive: 1 },
    { id: 4, live: false, lastActive: 0 },
    { id: 5, live: true, lastActive: 5 },
  ];
  assert.deepEqual(tabsToDiscard(tabs, { activeId: 1, maxLive: 2 }), [3, 2]);
  assert.deepEqual(tabsToDiscard(tabs, { activeId: 3, maxLive: 1 }), [2, 5, 1]);
  assert.ok(Object.isFrozen(tabs) === false && tabs[0].lastActive === 9, 'input untouched');
});

test('policy: rejects a nonsensical cap', () => {
  for (const maxLive of [0, -1, 1.5, '3', NaN]) assert.throws(() => tabsToDiscard([], { maxLive }), RangeError);
});

function fakeViews() {
  const events = [];
  let n = 0;
  return {
    events,
    adapter: {
      create: (tab) => {
        n += 1;
        const view = { n, partition: tab.partition, destroyed: false, loads: [] };
        events.push(['create', tab.id, tab.partition]);
        return view;
      },
      load: async (view, page) => {
        view.loads.push(page);
        events.push(['load', view.n, page]);
      },
      show: (view) => events.push(['show', view.n]),
      hide: (view) => events.push(['hide', view.n]),
      destroy: (view) => {
        view.destroyed = true;
        events.push(['destroy', view.n]);
      },
    },
  };
}

test('tabs: one view per tab, own partition, ids never reused', async () => {
  const v = fakeViews();
  const tm = createTabManager({ views: v.adapter, maxLive: 3 });
  const a = await tm.open();
  const b = await tm.open({ page: '/merge-pdf.html', toolId: 'merge-pdf', docId: 'd1' });
  assert.equal(a.partition, partitionFor(1));
  assert.equal(b.partition, 'bento-tab-2');
  assert.notEqual(tm.viewOf(a.id), tm.viewOf(b.id));
  await tm.close(b.id);
  const c = await tm.open();
  assert.equal(c.id, 3, 'closed tab id (and so its partition) is not reused');
  assert.deepEqual(tm.list().map((t) => [t.id, t.active]), [[1, false], [3, true]]);
});

test('tabs: memory cap discards the least recently used background view and reloads it on activation', async () => {
  const v = fakeViews();
  const loaded = [];
  const tm = createTabManager({ views: v.adapter, maxLive: 2, onLoaded: async (tab) => loaded.push([tab.id, tab.docId]) });
  await tm.open({ page: '/a.html', docId: 'doc-a' });
  await tm.open({ page: '/b.html', docId: 'doc-b' });
  const firstView = tm.viewOf(1);
  await tm.open({ page: '/c.html', docId: 'doc-c' });
  assert.equal(firstView.destroyed, true, 'oldest background view destroyed');
  assert.equal(tm.viewOf(1), undefined);
  assert.deepEqual(tm.list().map((t) => t.live), [false, true, true]);
  assert.equal(tm.get(1).docId, 'doc-a', 'discarded tab keeps its document');

  await tm.activate(1);
  const reloaded = tm.viewOf(1);
  assert.notEqual(reloaded, firstView);
  assert.deepEqual(reloaded.loads, ['/a.html'], 'same page reloaded');
  assert.deepEqual(loaded.at(-1), [1, 'doc-a'], 'handoff hook ran again for the document');
  assert.equal(tm.viewOf(2), undefined, 'now tab 2 is the least recently used and was discarded');
  assert.equal(tm.list().filter((t) => t.live).length, 2);
});

test('tabs: navigate, next/previous cycle, close activates the most recent', async () => {
  const v = fakeViews();
  const tm = createTabManager({ views: v.adapter, maxLive: 5 });
  await tm.open();
  await tm.open();
  await tm.open();
  await tm.navigate(2, { page: '/merge-pdf.html', toolId: 'merge-pdf', docId: 'x' });
  assert.equal(tm.get(2).toolId, 'merge-pdf');
  assert.deepEqual(tm.viewOf(2).loads, ['/index.html', '/merge-pdf.html']);
  await tm.next();
  assert.equal(tm.activeId(), 1, 'wraps around');
  await tm.previous();
  assert.equal(tm.activeId(), 3);
  await tm.activate(2);
  await tm.activate(3);
  await tm.close(3);
  assert.equal(tm.activeId(), 2);
  await assert.rejects(tm.activate(99), /unknown tab/);
  await assert.rejects(tm.close(3), /unknown tab/);
  await assert.rejects(tm.navigate('2', { page: '/x.html' }), /unknown tab/);
});

test('tabs: a failing load is reported, not thrown, and skips the handoff', async () => {
  const v = fakeViews();
  const errors = [];
  let handoffs = 0;
  v.adapter.load = async () => {
    throw new Error('ERR_FAILED');
  };
  const tm = createTabManager({ views: v.adapter, onLoaded: async () => (handoffs += 1), onError: (e) => errors.push(e.message) });
  await tm.open();
  assert.deepEqual(errors, ['ERR_FAILED']);
  assert.equal(handoffs, 0);
});

test('tabs: in-page navigation is remembered so a discarded tab reloads where the user was', async () => {
  const v = fakeViews();
  const tm = createTabManager({ views: v.adapter, maxLive: 1 });
  await tm.open({ docId: 'd' });
  tm.recordPage(1, '/split-pdf', 'split-pdf');
  tm.recordPage(99, '/x', null); // unknown tab: ignored
  assert.deepEqual([tm.get(1).page, tm.get(1).toolId, tm.get(1).docId], ['/split-pdf', 'split-pdf', 'd']);
  await tm.open();
  await tm.activate(1);
  assert.deepEqual(tm.viewOf(1).loads, ['/split-pdf']);
});
