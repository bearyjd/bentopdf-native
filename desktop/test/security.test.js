'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { CHANNELS } = require('../src/channels');
const { safeFileName, parseOpenOptions, isTrustedSender } = require('../src/ipc');
const { schemePrivileges } = require('../src/transport-scheme');
const { isAllowedRequestUrl, lockSession } = require('../src/security');

test('preload channel names mirror channels.js', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const [key, value] of Object.entries(CHANNELS)) {
    assert.ok(source.includes(`${key}: '${value}'`), `${key} missing/different in preload.js`);
  }
});

test('safeFileName strips directories', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\x\\y.pdf'), 'y.pdf');
  assert.equal(safeFileName(42), 'document.pdf');
  assert.equal(safeFileName(''), 'document.pdf');
});

test('parseOpenOptions only keeps sane extensions', () => {
  assert.deepEqual(parseOpenOptions({ multiple: true, extensions: ['pdf', '../x', 'a b', 5] }), {
    multiple: true,
    extensions: ['pdf'],
  });
  assert.deepEqual(parseOpenOptions(null), { multiple: false, extensions: [] });
});

test('isTrustedSender accepts only the top-level frame of the app origin', () => {
  const origin = 'bento://app';
  const frame = (url, parent = null) => ({ senderFrame: { url, parent } });
  assert.equal(isTrustedSender(frame('bento://app/merge-pdf.html'), origin), true);
  assert.equal(isTrustedSender(frame('https://evil.example/'), origin), false);
  assert.equal(isTrustedSender(frame('bento://app.evil/'), origin), false);
  assert.equal(isTrustedSender(frame('bento://app/x', {}), origin), false);
  assert.equal(isTrustedSender({ senderFrame: null }, origin), false);
  assert.equal(isTrustedSender(frame('not a url'), origin), false);
});

test('scheme privileges: service workers are off by design, only an explicit opt-in turns them on', () => {
  assert.equal(schemePrivileges().allowServiceWorkers, false);
  assert.equal(schemePrivileges({}).allowServiceWorkers, false);
  assert.equal(schemePrivileges({ allowServiceWorkers: true }).allowServiceWorkers, true);
});

test('request allowlist: app origin, own blob:, inline image/font data: only', () => {
  const origin = 'bento://app';
  for (const url of ['bento://app/a.js', 'blob:bento://app/uuid', 'data:image/png;base64,AA', 'data:font/woff2;base64,AA']) {
    assert.equal(isAllowedRequestUrl(url, origin), true, url);
  }
  for (const url of ['https://example.com/', 'data:text/html,x', 'data:application/javascript,1', 'devtools://devtools/x', 'blob:https://evil/x', 'file:///etc/passwd']) {
    assert.equal(isAllowedRequestUrl(url, origin), false, url);
  }
  assert.equal(isAllowedRequestUrl('devtools://devtools/x', origin, { allowDevtools: true }), true);
});

test('lockSession denies every permission kind and reports each decision', () => {
  const handlers = {};
  const session = {
    setPermissionRequestHandler: (f) => (handlers.request = f),
    setPermissionCheckHandler: (f) => (handlers.check = f),
    setDevicePermissionHandler: (f) => (handlers.device = f),
    setDisplayMediaRequestHandler: (f) => (handlers.display = f),
    webRequest: { onBeforeRequest: (f) => (handlers.before = f) },
  };
  const seen = [];
  lockSession(session, 'bento://app', () => {}, { onPermission: (d) => seen.push(d) });
  let answered;
  handlers.request({}, 'geolocation', (v) => (answered = v));
  assert.equal(answered, false);
  assert.equal(handlers.check({}, 'notifications'), false);
  assert.equal(handlers.device({ deviceType: 'usb' }), false);
  assert.deepEqual(seen.map((d) => d.granted), [false, false, false]);
  let result;
  handlers.before({ url: 'https://example.com/' }, (r) => (result = r));
  assert.deepEqual(result, { cancel: true });
});
