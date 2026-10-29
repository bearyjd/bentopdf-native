'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { createDocumentStore } = require('../src/shell/document-store');
const { createRecents, parseRecents, isPlausiblePath, isPermanentOpenFailure } = require('../src/shell/recents');

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
  assert.equal(store.get(a.id).filePath, fs.realpathSync.native(path.join(dir, 'a.pdf')), 'path kept main-side');
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
  const one = createDocumentStore({ maxDocs: 1, inUse: () => true });
  await one.addFromPath(path.join(dir, 'a.pdf'));
  await assert.rejects(one.addFromPath(path.join(dir, 'b.pdf')), /too many open documents \(max 1\); close a tab first/);
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

// ---- review fixes ----

test('store: opening and releasing 33 distinct PDFs works (documents are freed, nothing is stuck at the cap)', async () => {
  const store = createDocumentStore();
  for (let i = 0; i < 33; i += 1) {
    const file = path.join(dir, `many-${i}.pdf`);
    fs.writeFileSync(file, PDF);
    const doc = await store.addFromPath(file);
    assert.equal(store.remove(doc.id), true);
  }
  assert.equal(store.list().length, 0);
  assert.equal(store.remove('gone'), false);
});

test('store: when full, the least recently used document NOT in use is evicted; documents in use are never evicted', async () => {
  let t = 0;
  const inUse = new Set();
  const store = createDocumentStore({ maxDocs: 2, now: () => (t += 1), inUse: (id) => inUse.has(id) });
  const a = await store.addFromPath(path.join(dir, 'a.pdf'));
  const b = await store.addFromPath(path.join(dir, 'b.pdf'));
  inUse.add(a.id); // a is the older one but shown in a tab
  const c = await store.addFromPath(path.join(dir, 'many-0.pdf'));
  assert.equal(store.has(a.id), true, 'in-use document survives');
  assert.equal(store.has(b.id), false, 'unused LRU document evicted');
  assert.equal(store.has(c.id), true);
  inUse.add(c.id);
  await assert.rejects(store.addFromPath(path.join(dir, 'many-1.pdf')), /close a tab first/);
});

test('store: file identity (dev/ino), not only the path, decides whether a file is the same document', async () => {
  let ino = 1;
  const validate = async () => ({ size: 10, filePath: '/docs/x.pdf', dev: 7, ino });
  const store = createDocumentStore({ validate });
  const first = await store.addFromPath('/docs/x.pdf');
  const same = await store.addFromPath('/docs/x.pdf');
  assert.equal(same.id, first.id, 'same path and same inode: same document');
  ino = 2; // the file was replaced behind the same path
  const replaced = await store.addFromPath('/docs/x.pdf');
  assert.notEqual(replaced.id, first.id, 'same path but another file: a new document');
  assert.equal(store.get(first.id).ino, 1, 'the old record keeps the identity it was validated with');
  assert.equal(store.list().length, 2);
});

test('store: touch moves a document to the front of the most-recently-used order and rejects unknown ids', async () => {
  let t = 0;
  const store = createDocumentStore({ now: () => (t += 1) });
  const a = await store.addFromPath(path.join(dir, 'a.pdf'));
  await store.addFromPath(path.join(dir, 'b.pdf'));
  assert.equal(store.list()[0].name, 'b.pdf');
  store.touch(a.id);
  assert.equal(store.list()[0].name, 'a.pdf');
  assert.throws(() => store.touch('nope'), /unknown document/);
});

test('network paths (UNC and //host) are refused by the store and recents on every platform', async () => {
  const store = createDocumentStore({ validate: async () => assert.fail('must be refused before validation') });
  for (const p of ['\\\\server\\share\\a.pdf', '//server/share/a.pdf', '\\\\?\\UNC\\server\\share\\a.pdf', '/\\server/a.pdf', '\\\\.\\pipe\\x.pdf', '//./pipe/x.pdf', '//?/UNC/server/share/a.pdf', 'smb://server/share/a.pdf', 'file://server/share/a.pdf']) {
    await assert.rejects(store.addFromPath(p), /network paths/, p);
    assert.equal(isPlausiblePath(p), false, p);
  }
  assert.equal(isPlausiblePath('/home/u/a.pdf'), true);
  assert.deepEqual(parseRecents(JSON.stringify({ recents: [{ path: '//server/a.pdf' }, { path: '\\\\h\\s\\b.pdf' }, { path: '/ok/c.pdf' }] })), ['/ok/c.pdf']);
  const recents = createRecents({ file: path.join(dir, 'unc-recents.json') });
  recents.add('//server/share/a.pdf');
  assert.deepEqual(recents.list(), []);
});

test('openRecent failure classes: only a confirmed missing/invalid file is permanent; transient errors are not', () => {
  const coded = (code) => Object.assign(new Error(code), { code });
  for (const e of [coded('ENOENT'), coded('ENOTDIR'), coded('ELOOP'), new Error('not a .pdf file'), new Error('not a PDF (missing %PDF- header)'),
    new Error('not a regular file'), new Error('file too large'), new Error('network paths are not allowed')]) {
    assert.equal(isPermanentOpenFailure(e), true, e.message);
  }
  for (const e of [coded('EACCES'), coded('EIO'), coded('EBUSY'), coded('EMFILE'), coded('ETIMEDOUT'), new Error('something odd'),
    new Error('too many open documents (max 32); close a tab first'), null, undefined]) {
    assert.equal(isPermanentOpenFailure(e), false, String(e && e.message));
  }
});
