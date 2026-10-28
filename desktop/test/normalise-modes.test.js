'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { normaliseModes } = require('../tools/normalise-modes');

test('normaliseModes: no group/world-writable or setuid entries survive; exec bit decides 0755/0644', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-modes-'));
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'bin'), 'x');
    fs.writeFileSync(path.join(root, 'sub', 'data.pak'), 'x');
    fs.writeFileSync(path.join(root, 'chrome-sandbox'), 'x');
    fs.symlinkSync('bin', path.join(root, 'link'));
    fs.chmodSync(root, 0o777);
    fs.chmodSync(path.join(root, 'sub'), 0o775);
    fs.chmodSync(path.join(root, 'bin'), 0o777);
    fs.chmodSync(path.join(root, 'sub', 'data.pak'), 0o666);
    fs.chmodSync(path.join(root, 'chrome-sandbox'), 0o4755);
    assert.ok(normaliseModes(root) >= 4);
    const mode = (p) => fs.lstatSync(path.join(root, p)).mode & 0o7777;
    assert.equal(mode('.'), 0o755);
    assert.equal(mode('sub'), 0o755);
    assert.equal(mode('bin'), 0o755);
    assert.equal(mode('sub/data.pak'), 0o644);
    assert.equal(mode('chrome-sandbox'), 0o755);
    assert.equal(normaliseModes(root), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
