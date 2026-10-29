'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { hasTestMarker, MARKER_NAME, MARKER_CONTENT } = require('../src/test-mode');

function withResources(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-marker-'));
  try {
    return fn(dir, path.join(dir, MARKER_NAME));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const writeMarker = (file, content = MARKER_CONTENT, mode = 0o644) => {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
};

test('hasTestMarker: a regular, owned, non-writable file with exactly the token line is accepted', () => {
  withResources((dir, file) => {
    writeMarker(file);
    assert.equal(hasTestMarker(dir), true);
    writeMarker(file, MARKER_CONTENT, 0o600);
    assert.equal(hasTestMarker(dir), true);
  });
});

test('hasTestMarker: absent file, bad resources path', () => {
  withResources((dir) => assert.equal(hasTestMarker(dir), false));
  for (const bad of [undefined, null, '', 42, '/nonexistent/dir']) assert.equal(hasTestMarker(bad), false, String(bad));
});

test('hasTestMarker: wrong content is refused (extra bytes, missing newline, other token, empty, prefix)', () => {
  withResources((dir, file) => {
    for (const content of ['', 'bento-test-mode-v1', `${MARKER_CONTENT}x`, `${MARKER_CONTENT}${MARKER_CONTENT}`, 'something-else\n', ' bento-test-mode-v1\n', MARKER_CONTENT.replace('v1', 'v2'), MARKER_CONTENT.replace('bento', 'other'), 'x'.repeat(100000)]) {
      writeMarker(file, content);
      assert.equal(hasTestMarker(dir), false, JSON.stringify(content.slice(0, 30)));
    }
  });
});

test('hasTestMarker: group- or world-writable is refused', () => {
  withResources((dir, file) => {
    for (const mode of [0o664, 0o666, 0o620, 0o602, 0o777]) {
      writeMarker(file, MARKER_CONTENT, mode);
      assert.equal(hasTestMarker(dir), false, mode.toString(8));
    }
  });
});

test('hasTestMarker: a symlink to a valid marker is refused', () => {
  withResources((dir, file) => {
    const real = path.join(dir, 'real-marker');
    writeMarker(real);
    fs.symlinkSync(real, file);
    assert.equal(hasTestMarker(dir), false);
  });
});

test('hasTestMarker: a directory in its place is refused', () => {
  withResources((dir, file) => {
    fs.mkdirSync(file);
    assert.equal(hasTestMarker(dir), false);
  });
});

test('hasTestMarker: a file owned by someone else is refused', () => {
  withResources((dir, file) => {
    writeMarker(file);
    assert.equal(hasTestMarker(dir, { uid: process.getuid() + 1 }), false);
    assert.equal(hasTestMarker(dir, { uid: process.getuid() }), true);
  });
});
