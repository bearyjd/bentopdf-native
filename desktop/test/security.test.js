'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { CHANNELS } = require('../src/channels');
const { safeFileName, parseOpenOptions, isTrustedSender } = require('../src/ipc');

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
