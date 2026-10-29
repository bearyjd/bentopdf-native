'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDocumentOpener, createDocumentReleaser } = require('../src/shell/open-document');

function fakes({ evict = false } = {}) {
  const records = new Map();
  const remembered = [];
  const opened = [];
  const store = {
    addFromPath: async (p) => {
      const doc = { id: `id-${p}`, name: p.split('/').pop() };
      records.set(doc.id, { ...doc, filePath: p });
      return doc;
    },
    get: (id) => (evict ? undefined : records.get(id)),
  };
  const recents = { add: (p) => remembered.push(p) };
  const tabs = {
    list: () => opened.map((docId, i) => ({ id: i + 1, docId })),
    activate: async () => {},
    open: async ({ docId }) => { opened.push(docId); },
  };
  let pushes = 0;
  return { store, recents, tabs, pushState: () => { pushes += 1; }, remembered, opened, pushes: () => pushes };
}

test('opener: a validated path becomes one tab and one recent entry, concurrent opens of the same path share it', async () => {
  const f = fakes();
  const open = createDocumentOpener(f);
  const [a, b] = await Promise.all([open('/d/a.pdf'), open('/d/a.pdf')]);
  assert.equal(a.id, b.id);
  assert.deepEqual(f.opened, ['id-/d/a.pdf'], 'second open activates the existing tab');
  assert.deepEqual(f.remembered, ['/d/a.pdf', '/d/a.pdf']);
  assert.equal(f.pushes(), 2);
});

test('opener: a document closed or evicted while it is being opened is an explicit error, not a TypeError', async () => {
  const f = fakes({ evict: true });
  const open = createDocumentOpener(f);
  await assert.rejects(open('/d/gone.pdf'), (err) => !(err instanceof TypeError) && /closed while it was being opened/.test(err.message));
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.remembered, []);
});

function releaseFakes() {
  const docs = new Set(['d1']);
  const shownBy = []; // doc ids tabs show
  const store = { remove: (id) => docs.delete(id), has: (id) => docs.has(id) };
  const tabs = { list: () => shownBy.map((docId, i) => ({ id: i + 1, docId })) };
  return { docs, shownBy, store, tabs };
}

test('releaser: removes a document no tab shows, keeps one a tab shows, ignores empty ids', async () => {
  const f = releaseFakes();
  const release = createDocumentReleaser(f);
  await release(null);
  await release('d1');
  assert.equal(f.docs.has('d1'), false);
  f.docs.add('d2');
  f.shownBy.push('d2');
  await release('d2');
  assert.equal(f.docs.has('d2'), true);
});

test('releaser: a tab that appears while the release waits (a concurrent open) keeps the document', async () => {
  const f = releaseFakes();
  const release = createDocumentReleaser({ ...f, yieldTurn: async () => { f.shownBy.push('d1'); } });
  await release('d1');
  assert.equal(f.docs.has('d1'), true);
});

test('releaser + opener: a release landing in the gap between the store accepting a path and its tab is not an error', async () => {
  const records = new Map();
  const tabList = [];
  const store = {
    addFromPath: async (p) => {
      const doc = { id: 'd-1', name: p.split('/').pop() };
      records.set(doc.id, { ...doc, filePath: p });
      queueMicrotask(() => { releasing = release(doc.id); }); // the other flow's release, before the opener resumes
      return doc;
    },
    get: (id) => records.get(id),
    remove: (id) => records.delete(id),
  };
  const tabs = { list: () => tabList, activate: async () => {}, open: async ({ docId }) => { tabList.push({ id: 1, docId }); } };
  let releasing = null;
  const release = createDocumentReleaser({ store, tabs });
  const open = createDocumentOpener({ store, recents: { add: () => {} }, tabs, pushState: () => {} });
  const doc = await open('/d/gap.pdf');
  await releasing;
  assert.equal(doc.id, 'd-1');
  assert.ok(records.has('d-1'), 'the document the new tab shows was kept');
});
