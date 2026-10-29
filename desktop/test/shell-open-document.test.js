'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDocumentOpener } = require('../src/shell/open-document');

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
