'use strict';

// The loopback http transport is a TEST-ONLY harness for the legacy single-window app (src/start-mode.js);
// the tabbed shell never uses it. These tests keep it honest for as long as the harness exists.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { startHttpTransport } = require('../src/transport-http');

let tmp;
let transport;
let port;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bento-http-')));
  fs.writeFileSync(path.join(tmp, 'index.html'), 'home');
  transport = await startHttpTransport({ rootReal: tmp, headers: { 'X-Test': '1' } });
  port = new URL(transport.origin).port;
});
after(async () => {
  await transport.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const request = (headers) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/index.html', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });

test('requests without the per-run token cookie get 403', async () => {
  assert.equal((await request({})).status, 403);
  assert.equal((await request({ cookie: 'bento_token=guess' })).status, 403);
});

test('requests with the token and exact Host are served', async () => {
  const { name, value } = transport.cookie;
  assert.deepEqual(await request({ cookie: `${name}=${value}` }), { status: 200, body: 'home' });
  assert.equal(transport.cookie.httpOnly, true);
  assert.equal(transport.cookie.sameSite, 'strict');
  assert.ok(value.length >= 32);
});

test('wrong Host (rebinding) and foreign Origin are refused even with the token', async () => {
  const cookie = `${transport.cookie.name}=${transport.cookie.value}`;
  assert.equal((await request({ cookie, host: 'evil.example' })).status, 421);
  assert.equal((await request({ cookie, origin: 'http://evil.example' })).status, 403);
});
