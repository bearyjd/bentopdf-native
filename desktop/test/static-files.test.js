'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { serveStatic, parseRange, mimeFor } = require('../src/static-files');
const { parseGlobalHeaders } = require('../src/headers');

let tmp;
let root;
const headers = { 'X-Test': '1' };

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-static-'));
  root = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>home</h1>');
  fs.writeFileSync(path.join(root, 'tool.html'), '<h1>tool</h1>');
  fs.writeFileSync(path.join(root, '404.html'), 'nope');
  fs.writeFileSync(path.join(root, 'sub', 'index.html'), 'sub');
  fs.writeFileSync(path.join(root, 'data.bin'), Buffer.from('0123456789'));
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'top secret');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'link-out.txt'));
  fs.symlinkSync(tmp, path.join(root, 'dir-out'));
  fs.symlinkSync(path.join(root, 'data.bin'), path.join(root, 'link-in.bin'));
  root = fs.realpathSync(root);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const get = (urlPath, extra = {}) =>
  serveStatic({ rootReal: root, method: 'GET', urlPath, baseHeaders: headers, ...extra });

async function text(result) {
  if (result.body === null) return '';
  if (Buffer.isBuffer(result.body)) return result.body.toString();
  const chunks = [];
  for await (const chunk of result.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('serves index, clean URLs and directory index with base headers', async () => {
  for (const [p, body] of [['/', '<h1>home</h1>'], ['/tool', '<h1>tool</h1>'], ['/sub/', 'sub'], ['/sub', 'sub']]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['X-Test'], '1');
    assert.equal(await text(r), body);
  }
});

test('missing file gives 404 with the 404 page and base headers', async () => {
  const r = await get('/missing.js');
  assert.equal(r.status, 404);
  assert.equal(r.headers['X-Test'], '1');
  assert.equal(await text(r), 'nope');
});

test('path traversal and escapes are 404', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/sub/../../secret.txt', '/a\\..\\secret.txt', '/x%00', '/%zz']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('symlinks pointing outside the root are 404, inside are served', async () => {
  assert.equal((await get('/link-out.txt')).status, 404);
  assert.equal((await get('/dir-out/secret.txt')).status, 404);
  const inside = await get('/link-in.bin');
  assert.equal(inside.status, 200);
  assert.equal(await text(inside), '0123456789');
});

test('range requests: 206, suffix, open-ended, 416', async () => {
  const a = await get('/data.bin', { range: 'bytes=2-4' });
  assert.equal(a.status, 206);
  assert.equal(a.headers['Content-Range'], 'bytes 2-4/10');
  assert.equal(await text(a), '234');
  assert.equal(await text(await get('/data.bin', { range: 'bytes=-3' })), '789');
  assert.equal(await text(await get('/data.bin', { range: 'bytes=8-' })), '89');
  assert.equal((await get('/data.bin', { range: 'bytes=50-' })).status, 416);
  assert.equal((await get('/data.bin', { range: 'bytes=-0' })).status, 416);
});

test('range requests: syntactically invalid or unsupported ranges are ignored (RFC 9110)', async () => {
  for (const range of ['bytes=5-2', 'items=1-2', 'bytes=-', 'bytes=a-b', 'bytes=0-1,3-4', 'bytes=', '', 'bytes=99999999999999999999-']) {
    const r = await get('/data.bin', { range });
    assert.equal(r.status, 200, range);
    assert.equal(r.headers['Content-Range'], undefined, range);
    assert.equal(await text(r), '0123456789', range);
  }
});

test('dotfiles, _headers and _redirects are never served', async () => {
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, '_headers'), '/*\n  A: 1');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), 'x');
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.txt'));
  for (const p of ['/.env', '/_headers', '/_redirects', '/.git/config', '/sub/../.env', '/innocent.txt']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('non GET/HEAD is 405; HEAD has no body', async () => {
  assert.equal((await get('/index.html', { method: 'POST' })).status, 405);
  const head = await get('/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
});

test('mime types: wasm, js, gz are served without content-encoding', () => {
  assert.equal(mimeFor('a.wasm'), 'application/wasm');
  assert.match(mimeFor('a.js'), /^text\/javascript/);
  assert.equal(mimeFor('soffice.wasm.gz'), 'application/gzip');
  assert.equal(mimeFor('x.unknown'), 'application/octet-stream');
});

test('parseRange classifies ignore / unsatisfiable / ok', () => {
  assert.equal(parseRange('bytes=0-1,3-4', 10), null);
  assert.equal(parseRange('bytes=5-2', 10), null);
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
  assert.deepEqual(parseRange('bytes=-100', 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=2-99', 10), { start: 2, end: 9 });
});

test('parseGlobalHeaders reads only the /* block', () => {
  const parsed = parseGlobalHeaders('/*\n  A: 1\n  B: x: y\n\n/docs\n  ! A\n  A: 2\n');
  assert.deepEqual(parsed, { A: '1', B: 'x: y' });
});
