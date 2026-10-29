'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { tabsToDiscard } = require('../src/shell/tab-policy');
const { createTabManager, partitionFor } = require('../src/shell/tab-manager');

test('policy: nothing to discard under the cap', () => {
  const tabs = [{ id: 1, live: true, lastActive: 1 }, { id: 2, live: true, lastActive: 2 }];
  assert.deepEqual(tabsToDiscard(tabs, { activeId: 2, budget: 3 }), []);
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
  assert.deepEqual(tabsToDiscard(tabs, { activeId: 1, budget: 2 }), [3, 2]);
  assert.deepEqual(tabsToDiscard(tabs, { activeId: 3, budget: 1 }), [2, 5, 1]);
  assert.ok(Object.isFrozen(tabs) === false && tabs[0].lastActive === 9, 'input untouched');
});

test('policy: rejects a nonsensical cap', () => {
  for (const budget of [0, -1, 1.5, '3', NaN]) assert.throws(() => tabsToDiscard([], { budget }), RangeError);
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
  const tm = createTabManager({ views: v.adapter, liveBudget: 3 });
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
  const tm = createTabManager({ views: v.adapter, liveBudget: 2, onLoaded: async (tab) => loaded.push([tab.id, tab.docId]) });
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
  const tm = createTabManager({ views: v.adapter, liveBudget: 5 });
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
  const tm = createTabManager({ views: v.adapter, liveBudget: 1 });
  await tm.open({ docId: 'd' });
  tm.recordPage(1, '/split-pdf', 'split-pdf');
  tm.recordPage(99, '/x', null); // unknown tab: ignored
  assert.deepEqual([tm.get(1).page, tm.get(1).toolId, tm.get(1).docId], ['/split-pdf', 'split-pdf', 'd']);
  await tm.open();
  await tm.activate(1);
  assert.deepEqual(tm.viewOf(1).loads, ['/split-pdf']);
});

// ---- review fixes: lifecycle, weights, async handoff ----

const { LIVE_VIEW_BUDGET, LIBREOFFICE_WEIGHT, OCR_WEIGHT, weightOfTool } = require('../src/shell/live-budget');

test('policy: heavy tools weigh several slots, so fewer of them stay live', () => {
  assert.equal(weightOfTool('merge-pdf'), 1);
  assert.equal(weightOfTool(null), 1);
  assert.equal(weightOfTool('__proto__'), 1, 'hostile ids get the default weight');
  assert.equal(weightOfTool('word-to-pdf'), LIBREOFFICE_WEIGHT);
  assert.equal(weightOfTool('ocr-pdf'), OCR_WEIGHT);
  assert.ok(LIBREOFFICE_WEIGHT * 2 > LIVE_VIEW_BUDGET, 'two LibreOffice tabs cannot both be live in the default budget');
  const tabs = [
    { id: 1, live: true, lastActive: 1, toolId: 'word-to-pdf' },
    { id: 2, live: true, lastActive: 2, toolId: 'merge-pdf' },
    { id: 3, live: true, lastActive: 3, toolId: 'excel-to-pdf' }, // active
  ];
  assert.deepEqual(tabsToDiscard(tabs, { activeId: 3 }), [1], 'oldest heavy tab goes; 4+1+4 > 6, 1+4 <= 6');
  assert.deepEqual(tabsToDiscard(tabs, { activeId: 3, budget: 4 }), [1, 2], 'the active tab stays even when alone it fills the budget');
  assert.deepEqual(tabsToDiscard(tabs.map((t) => ({ ...t, toolId: 'merge-pdf' })), { activeId: 3 }), [], 'light tabs all fit');
});

test('tabs: a heavy tool tab pushes light background tabs out of the budget (navigate re-checks)', async () => {
  const v = fakeViews();
  const tm = createTabManager({ views: v.adapter, liveBudget: 6 });
  for (let i = 0; i < 3; i += 1) await tm.open({ page: '/index.html' });
  assert.deepEqual(tm.list().map((t) => t.live), [true, true, true]);
  await tm.navigate(3, { page: '/word-to-pdf.html', toolId: 'word-to-pdf' }); // 1 + 1 + 4 = 6: fits
  assert.deepEqual(tm.list().map((t) => t.live), [true, true, true]);
  await tm.open({ page: '/index.html' }); // 7 > 6: tab 1 goes
  assert.deepEqual(tm.list().map((t) => t.live), [false, true, true, true]);
});

test('tabs: close() destroys the view (and closeAll() every view) instead of just forgetting it', async () => {
  const v = fakeViews();
  const tm = createTabManager({ views: v.adapter, liveBudget: 5 });
  await tm.open();
  await tm.open();
  await tm.open();
  const [one, two, three] = [1, 2, 3].map((id) => tm.viewOf(id));
  await tm.close(2);
  assert.equal(two.destroyed, true, 'close() must destroy the tab view');
  assert.equal(tm.viewOf(2), undefined);
  assert.equal(one.destroyed || three.destroyed, false);
  tm.closeAll();
  assert.equal(one.destroyed && three.destroyed, true, 'closeAll() destroys every remaining view');
  assert.deepEqual(tm.list(), []);
  assert.equal(tm.activeId(), null);
  assert.equal(v.events.filter((e) => e[0] === 'destroy').length, 3, 'each view destroyed exactly once');
});

test('tabs: activating another tab hides the previous view and shows the new one', async () => {
  const v = fakeViews();
  const tm = createTabManager({ views: v.adapter, liveBudget: 5 });
  await tm.open();
  await tm.open();
  v.events.length = 0;
  await tm.activate(1);
  assert.deepEqual(v.events.filter((e) => e[0] === 'hide' || e[0] === 'show'), [['hide', 2], ['show', 1]]);
});

test('tabs: navigate keeps the document id it is given and hands it to onLoaded', async () => {
  const v = fakeViews();
  const seen = [];
  const tm = createTabManager({ views: v.adapter, onLoaded: async (tab) => seen.push([tab.id, tab.toolId, tab.docId]) });
  await tm.open({ docId: 'first' });
  await tm.navigate(1, { page: '/merge-pdf.html', toolId: 'merge-pdf', docId: 'second' });
  assert.equal(tm.get(1).docId, 'second');
  assert.deepEqual(seen.at(-1), [1, 'merge-pdf', 'second']);
});

test('tabs: a handoff for a view that was discarded (or replaced) while its page loaded is skipped', async () => {
  const v = fakeViews();
  const releases = new Map();
  const realLoad = v.adapter.load;
  v.adapter.load = (view, page) =>
    page === '/slow.html' ? new Promise((resolve) => releases.set(view.n, () => realLoad(view, page).then(resolve))) : realLoad(view, page);
  const handedOff = [];
  const tm = createTabManager({ views: v.adapter, liveBudget: 1, onLoaded: async (tab) => handedOff.push(tab.id) });
  const slow = tm.open({ page: '/slow.html', docId: 'a' }); // tab 1, load pending
  await Promise.resolve();
  await tm.open({ page: '/b.html', docId: 'b' }); // budget 1: tab 1's view is destroyed mid-load
  assert.equal(tm.viewOf(1), undefined);
  for (const release of releases.values()) release();
  await slow;
  assert.deepEqual(handedOff, [2], 'no handoff into the destroyed view of tab 1');
});

test('tabs: a handoff that never finishes does not block open, activate or navigate', async () => {
  const v = fakeViews();
  const tm = createTabManager({ views: v.adapter, liveBudget: 1, onLoaded: () => new Promise(() => {}) });
  const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('blocked on the handoff')), ms));
  await Promise.race([tm.open({ docId: 'a' }), timeout(2000)]);
  await Promise.race([tm.open({ docId: 'b' }), timeout(2000)]);
  await Promise.race([tm.activate(1), timeout(2000)]);
  await Promise.race([tm.navigate(1, { page: '/x.html', toolId: null, docId: 'a' }), timeout(2000)]);
});

test('tabs: a throwing or rejecting onLoaded is reported through onError, not thrown', async () => {
  for (const onLoaded of [() => Promise.reject(new Error('async boom')), () => { throw new Error('sync boom'); }]) {
    const v = fakeViews();
    const errors = [];
    const tm = createTabManager({ views: v.adapter, onLoaded, onError: (e) => errors.push(e.message) });
    await tm.open();
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
  }
});

// ---- final round: navigation epoch, recordPage weight ----

const { isTargetPage } = require('../src/shell/handoff');

test('tabs: every navigation (navigate, recordPage, noteNavigation) bumps the tab epoch; others are untouched', async () => {
  const v = fakeViews();
  const seen = [];
  const tm = createTabManager({ views: v.adapter, onLoaded: async (tab) => seen.push(tab.epoch) });
  await tm.open({ page: '/merge-pdf.html', toolId: 'merge-pdf', docId: 'd' });
  await tm.open();
  assert.equal(tm.get(1).epoch, 0);
  assert.deepEqual(seen, [0, 0]);
  await tm.navigate(1, { page: '/split-pdf.html', toolId: 'split-pdf', docId: 'd' });
  assert.equal(tm.get(1).epoch, 1);
  tm.recordPage(1, '/rotate-pdf.html', 'rotate-pdf');
  assert.equal(tm.get(1).epoch, 2);
  tm.recordPage(1, '/rotate-pdf.html', 'rotate-pdf'); // same page again (did-navigate after a reload): still a navigation
  assert.equal(tm.get(1).epoch, 3);
  tm.noteNavigation(1);
  tm.noteNavigation(99); // unknown tab: ignored
  assert.equal(tm.get(1).epoch, 4);
  assert.equal(tm.get(2).epoch, 0, 'the other tab is untouched');
});

test('handoff: only the page the handoff was started for is a valid target', () => {
  const o = 'bento://app';
  assert.equal(isTargetPage('bento://app/merge-pdf.html', o, '/merge-pdf.html'), true);
  assert.equal(isTargetPage('bento://app/merge-pdf.html?x=1#y', o, '/merge-pdf.html'), true);
  assert.equal(isTargetPage('bento://app/split-pdf.html', o, '/merge-pdf.html'), false);
  assert.equal(isTargetPage('bento://evil/merge-pdf.html', o, '/merge-pdf.html'), false);
  assert.equal(isTargetPage('https://app/merge-pdf.html', o, '/merge-pdf.html'), false);
  assert.equal(isTargetPage('', o, '/merge-pdf.html'), false);
  assert.equal(isTargetPage(undefined, o, '/merge-pdf.html'), false);
});

test('tabs: a page that navigated itself to a heavy tool is re-weighed (recordPage enforces the cap)', async () => {
  const v = fakeViews();
  const tm = createTabManager({ views: v.adapter, liveBudget: 6 });
  for (let i = 0; i < 3; i += 1) await tm.open({ page: '/index.html' });
  assert.deepEqual(tm.list().map((t) => t.live), [true, true, true]);
  tm.recordPage(3, '/word-to-pdf.html', 'word-to-pdf'); // 1 + 1 + 4 = 6: fits
  assert.deepEqual(tm.list().map((t) => t.live), [true, true, true]);
  tm.recordPage(2, '/excel-to-pdf.html', 'excel-to-pdf'); // 1 + 4 + 4 = 9 > 6: tab 1 goes, still 8 > 6: tab 2 goes too (the active tab never does)
  assert.deepEqual(tm.list().map((t) => t.live), [false, false, true]);
  assert.equal(tm.get(2).toolId, 'excel-to-pdf');
});
