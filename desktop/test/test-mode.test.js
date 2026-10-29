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

test('hasTestMarker: a hard-linked marker (nlink > 1) is refused', () => {
  withResources((dir, file) => {
    writeMarker(file);
    assert.equal(hasTestMarker(dir), true);
    fs.linkSync(file, path.join(dir, 'second-name'));
    assert.equal(hasTestMarker(dir), false);
  });
});

test('hasTestMarker: a resources path reached through a symlink is refused', () => {
  withResources((dir, file) => {
    writeMarker(file);
    const alias = `${dir}-alias`;
    fs.symlinkSync(dir, alias);
    try {
      assert.equal(hasTestMarker(alias), false);
      assert.equal(hasTestMarker(dir), true);
    } finally {
      fs.unlinkSync(alias);
    }
  });
});

test('hasTestMarker: a non-numeric uid (win32 has no uid semantics) fails closed', () => {
  withResources((dir, file) => {
    writeMarker(file);
    assert.equal(hasTestMarker(dir, { uid: null }), false);
  });
});

test('hasTestMarker: an oversized regular file is refused (real file)', () => {
  withResources((dir, file) => {
    writeMarker(file, MARKER_CONTENT + 'x'.repeat(4096));
    assert.equal(hasTestMarker(dir), false);
  });
});

// Each check is exercised alone: a fake fs reports a stat that is valid except for one field and returns the
// exact token on read, so removing any single check from hasTestMarker turns exactly one of these red.
// (Real files cannot isolate size or isFile: the content comparison and the type already reject them.)
function fakeFs(statOverride, tokenOnRead = MARKER_CONTENT) {
  const good = { isFile: () => true, nlink: 1, uid: process.getuid(), mode: 0o100644, size: MARKER_CONTENT.length };
  return {
    constants: fs.constants,
    realpathSync: fs.realpathSync,
    openSync: () => 99,
    fstatSync: () => ({ ...good, ...statOverride }),
    readSync: (_fd, buf) => buf.write(tokenOnRead),
    closeSync: () => {},
  };
}
test('hasTestMarker: fake-fs control accepts a fully valid stat', () => {
  assert.equal(hasTestMarker(os.tmpdir(), { fsImpl: fakeFs({}) }), true);
});
test('hasTestMarker: each single bad stat field is refused on its own (isFile, nlink, uid, mode, size)', () => {
  const tmp = os.tmpdir();
  assert.equal(hasTestMarker(tmp, { fsImpl: fakeFs({ isFile: () => false }) }), false, 'isFile');
  assert.equal(hasTestMarker(tmp, { fsImpl: fakeFs({ nlink: 2 }) }), false, 'nlink');
  assert.equal(hasTestMarker(tmp, { fsImpl: fakeFs({ uid: process.getuid() + 1 }) }), false, 'uid');
  assert.equal(hasTestMarker(tmp, { fsImpl: fakeFs({ mode: 0o100664 }) }), false, 'group-writable');
  assert.equal(hasTestMarker(tmp, { fsImpl: fakeFs({ mode: 0o100602 }) }), false, 'world-writable');
  assert.equal(hasTestMarker(tmp, { fsImpl: fakeFs({ size: MARKER_CONTENT.length + 1 }) }), false, 'size larger');
  assert.equal(hasTestMarker(tmp, { fsImpl: fakeFs({ size: 0 }) }), false, 'size smaller');
  assert.equal(hasTestMarker(tmp, { fsImpl: fakeFs({}, 'other-token-of-same-len') }), false, 'token');
});
test('hasTestMarker: the marker is opened with O_NOFOLLOW', () => {
  let flags = null;
  const spy = { ...fakeFs({}), openSync: (_p, f) => { flags = f; return 99; } };
  assert.equal(hasTestMarker(os.tmpdir(), { fsImpl: spy }), true);
  assert.equal((flags & fs.constants.O_NOFOLLOW), fs.constants.O_NOFOLLOW);
});
