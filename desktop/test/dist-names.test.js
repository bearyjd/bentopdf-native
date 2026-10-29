'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { unsafeNames } = require('../tools/check-dist-names');

const DIST = path.join(__dirname, '..', '..', 'dist');

test('unsafeNames: lists paths with a Windows-unsafe segment, accepts ordinary bundle names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-names-'));
  try {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets', 'index-Ab1_-9.js'), '');
    fs.writeFileSync(path.join(root, 'v1.2.3.wasm'), '');
    assert.deepEqual(unsafeNames(root), []);
    fs.writeFileSync(path.join(root, 'assets', 'x~1.js'), '');
    fs.writeFileSync(path.join(root, 'assets', 'con.js'), '');
    fs.writeFileSync(path.join(root, 'trailing.'), '');
    assert.deepEqual(unsafeNames(root).sort(), ['assets/con.js', 'assets/x~1.js', 'trailing.']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the built bundle (dist/) contains no path that static-files.js refuses on Windows-name grounds', { skip: !fs.existsSync(path.join(DIST, 'index.html')) && 'no dist/ bundle built here' }, () => {
  assert.deepEqual(unsafeNames(DIST), []);
});
