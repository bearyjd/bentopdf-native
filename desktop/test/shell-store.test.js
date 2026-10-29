'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { createDocumentStore } = require('../src/shell/document-store');
const { createRecents, parseRecents } = require('../src/shell/recents');

let dir;
const PDF = Buffer.from('%PDF-1.4\n%fixture\n');
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-store-'));
  fs.writeFileSync(path.join(dir, 'a.pdf'), PDF);
  fs.writeFileSync(path.join(dir, 'b.pdf'), PDF);
  fs.writeFileSync(path.join(dir, 'fake.pdf'), 'not a pdf');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
  fs.mkdirSync(path.join(dir, 'folder.pdf'));
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, 'link.pdf'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('store: adds validated files, exposes no path, reuses the id of an already open file', async () => {
  let t = 1000;
  const store = createDocumentStore({ now: () => t });
  const a = await store.addFromPath(path.join(dir, 'a.pdf'));
  assert.deepEqual(Object.keys(a).sort(), ['id', 'lastUsed', 'name', 'size', 'source']);
  assert.equal(a.name, 'a.pdf');
  assert.equal(a.size, PDF.length);
  t = 2000;
  const b = await store.addFromPath(path.join(dir, 'b.pdf'));
  assert.deepEqual(store.list().map((d) => d.name), ['b.pdf', 'a.pdf'], 'most recently used first');
  t = 3000;
  const again = await store.addFromPath(path.join(dir, '.', 'a.pdf'));
  assert.equal(again.id, a.id, 'same file, same document');
  assert.equal(store.list().length, 2);
  assert.deepEqual(store.list().map((d) => d.id), [a.id, b.id]);
  assert.equal(store.get(a.id).filePath, fs.realpathSync(path.join(dir, 'a.pdf')), 'path kept main-side');
  assert.ok(Object.isFrozen(store.get(a.id)));
});

test('store: refuses hostile paths (relative, NUL, non-pdf, fake pdf, directory, symlink to non-pdf, missing)', async () => {
  const store = createDocumentStore();
  const bad = ['a.pdf', '', `${dir}/a.pdf\0.txt`, path.join(dir, 'secret.txt'), path.join(dir, 'fake.pdf'),
    path.join(dir, 'folder.pdf'), path.join(dir, 'link.pdf'), path.join(dir, 'missing.pdf'), 42, null, { path: '/x.pdf' }];
  for (const p of bad) await assert.rejects(store.addFromPath(p), undefined, String(p));
  assert.equal(store.list().length, 0);
});

test('store: size cap and document cap', async () => {
  const small = createDocumentStore({ validate: (p) => require('../src/open-file').validateOpenPath(p, 4) });
  await assert.rejects(small.addFromPath(path.join(dir, 'a.pdf')), /too large/);
  const one = createDocumentStore({ maxDocs: 1 });
  await one.addFromPath(path.join(dir, 'a.pdf'));
  await assert.rejects(one.addFromPath(path.join(dir, 'b.pdf')), /too many/);
  await one.addFromPath(path.join(dir, 'a.pdf')); // re-open of the same file is not a new document
});

test('store: in-memory documents need the PDF magic, are copied, and are capped', () => {
  const store = createDocumentStore({ maxBytes: 64 });
  const bytes = new Uint8Array(PDF);
  const doc = store.addFromBytes('../../out.pdf', bytes);
  assert.equal(doc.name, 'out.pdf');
  assert.equal(doc.source, 'memory');
  bytes[0] = 0;
  assert.equal(store.get(doc.id).bytes[0], 0x25, 'stored bytes are a copy');
  assert.throws(() => store.addFromBytes('x.pdf', new Uint8Array(4)), /not a PDF/);
  assert.throws(() => store.addFromBytes('x.pdf', 'string'), /Uint8Array/);
  assert.throws(() => store.addFromBytes('x.pdf', new Uint8Array(65)), /too large/);
});

test('store: lookups by hostile ids', async () => {
  const store = createDocumentStore();
  await store.addFromPath(path.join(dir, 'a.pdf'));
  for (const id of ['__proto__', 'constructor', '', null, 1, {}, ['x']]) {
    assert.equal(store.has(id), false);
    assert.equal(store.get(id), undefined);
    assert.throws(() => store.touch(id), /unknown document/);
    assert.equal(store.remove(id), false);
  }
});

test('recents: parse treats the file as hostile', () => {
  assert.deepEqual(parseRecents('not json'), []);
  assert.deepEqual(parseRecents('{"recents": "x"}'), []);
  assert.deepEqual(parseRecents('null'), []);
  const hostile = JSON.stringify({
    recents: [
      { path: '/ok/a.pdf' }, { path: '/ok/a.pdf' }, { path: 'relative.pdf' }, { path: '/etc/passwd' },
      { path: '/x\u0000.pdf' }, { path: 42 }, null, '/str.pdf', { path: `/${'a'.repeat(5000)}.pdf` },
      { path: '/__proto__.PDF' }, { path: '/ok/b.pdf', extra: true },
    ],
  });
  assert.deepEqual(parseRecents(hostile), ['/ok/a.pdf', '/__proto__.PDF', '/ok/b.pdf']);
  const many = JSON.stringify({ recents: Array.from({ length: 50 }, (_, i) => ({ path: `/d/${i}.pdf` })) });
  assert.equal(parseRecents(many).length, 10);
});

test('recents: capped, deduplicated, persisted, ids map back to paths, no path in list()', () => {
  const file = path.join(dir, 'state', 'recents.json');
  const errors = [];
  const recents = createRecents({ file, onError: (e) => errors.push(e) });
  for (let i = 0; i < 12; i += 1) recents.add(`/docs/${i}.pdf`);
  recents.add('/docs/5.pdf');
  recents.add('relative.pdf');
  const listed = recents.list();
  assert.equal(listed.length, 10);
  assert.equal(listed[0].name, '5.pdf');
  assert.deepEqual(Object.keys(listed[0]).sort(), ['id', 'name']);
  assert.equal(recents.pathOf(listed[0].id), '/docs/5.pdf');
  assert.equal(recents.pathOf('__proto__'), undefined);
  assert.equal(recents.pathOf({}), undefined);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const reloaded = createRecents({ file });
  assert.deepEqual(reloaded.list().map((r) => r.name), listed.map((r) => r.name));
  assert.equal(reloaded.remove(reloaded.list()[0].id), true);
  assert.equal(createRecents({ file }).list().length, 9);
  assert.deepEqual(errors, []);
});

test('recents: oversized or non-regular file is ignored, not trusted', () => {
  const big = path.join(dir, 'big.json');
  fs.writeFileSync(big, JSON.stringify({ recents: [{ path: '/a.pdf' }], pad: 'x'.repeat(70 * 1024) }));
  const errors = [];
  assert.equal(createRecents({ file: big, onError: (e) => errors.push(e) }).list().length, 0);
  assert.equal(errors.length, 1);
  assert.equal(createRecents({ file: path.join(dir, 'folder.pdf') }).list().length, 0);
});
