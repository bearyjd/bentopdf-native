'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { hasTestMarker, MARKER_NAME, MARKER_CONTENT } = require('../src/test-mode');

const WIN = process.platform === 'win32';
// The POSIX branch checks uid and mode bits and is exercised with real files: not meaningful on a win32 host
// (no getuid, chmod is a read-only flag). The win32 branch is tested below with a fake fs everywhere and with
// real files on a win32 host.
const POSIX_ONLY = WIN && 'POSIX branch (uid/mode bits, real files): not applicable on a win32 host';

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

test('hasTestMarker: a regular, owned, non-writable file with exactly the token line is accepted', { skip: POSIX_ONLY }, () => {
  withResources((dir, file) => {
    writeMarker(file);
    assert.equal(hasTestMarker(dir), true);
    writeMarker(file, MARKER_CONTENT, 0o600);
    assert.equal(hasTestMarker(dir), true);
  });
});

test('hasTestMarker: absent file, bad resources path', { skip: POSIX_ONLY }, () => {
  withResources((dir) => assert.equal(hasTestMarker(dir), false));
  for (const bad of [undefined, null, '', 42, '/nonexistent/dir']) assert.equal(hasTestMarker(bad), false, String(bad));
});

test('hasTestMarker: wrong content is refused (extra bytes, missing newline, other token, empty, prefix)', { skip: POSIX_ONLY }, () => {
  withResources((dir, file) => {
    for (const content of ['', 'bento-test-mode-v1', `${MARKER_CONTENT}x`, `${MARKER_CONTENT}${MARKER_CONTENT}`, 'something-else\n', ' bento-test-mode-v1\n', MARKER_CONTENT.replace('v1', 'v2'), MARKER_CONTENT.replace('bento', 'other'), 'x'.repeat(100000)]) {
      writeMarker(file, content);
      assert.equal(hasTestMarker(dir), false, JSON.stringify(content.slice(0, 30)));
    }
  });
});

test('hasTestMarker: group- or world-writable is refused', { skip: POSIX_ONLY }, () => {
  withResources((dir, file) => {
    for (const mode of [0o664, 0o666, 0o620, 0o602, 0o777]) {
      writeMarker(file, MARKER_CONTENT, mode);
      assert.equal(hasTestMarker(dir), false, mode.toString(8));
    }
  });
});

test('hasTestMarker: a symlink to a valid marker is refused', { skip: POSIX_ONLY }, () => {
  withResources((dir, file) => {
    const real = path.join(dir, 'real-marker');
    writeMarker(real);
    fs.symlinkSync(real, file);
    assert.equal(hasTestMarker(dir), false);
  });
});

test('hasTestMarker: a directory in its place is refused', { skip: POSIX_ONLY }, () => {
  withResources((dir, file) => {
    fs.mkdirSync(file);
    assert.equal(hasTestMarker(dir), false);
  });
});

test('hasTestMarker: a file owned by someone else is refused', { skip: POSIX_ONLY }, () => {
  withResources((dir, file) => {
    writeMarker(file);
    assert.equal(hasTestMarker(dir, { uid: process.getuid() + 1 }), false);
    assert.equal(hasTestMarker(dir, { uid: process.getuid() }), true);
  });
});

test('hasTestMarker: a hard-linked marker (nlink > 1) is refused', { skip: POSIX_ONLY }, () => {
  withResources((dir, file) => {
    writeMarker(file);
    assert.equal(hasTestMarker(dir), true);
    fs.linkSync(file, path.join(dir, 'second-name'));
    assert.equal(hasTestMarker(dir), false);
  });
});

test('hasTestMarker: a resources path reached through a symlink is refused', { skip: POSIX_ONLY }, () => {
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

test('hasTestMarker: a non-numeric uid (win32 has no uid semantics) fails closed', { skip: POSIX_ONLY }, () => {
  withResources((dir, file) => {
    writeMarker(file);
    assert.equal(hasTestMarker(dir, { uid: null }), false);
  });
});

test('hasTestMarker: an oversized regular file is refused (real file)', { skip: POSIX_ONLY }, () => {
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
test('hasTestMarker: fake-fs control accepts a fully valid stat', { skip: POSIX_ONLY }, () => {
  assert.equal(hasTestMarker(os.tmpdir(), { fsImpl: fakeFs({}) }), true);
});
test('hasTestMarker: each single bad stat field is refused on its own (isFile, nlink, uid, mode, size)', { skip: POSIX_ONLY }, () => {
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
test('hasTestMarker: the marker is opened with O_NOFOLLOW', { skip: POSIX_ONLY }, () => {
  let flags = null;
  const spy = { ...fakeFs({}), openSync: (_p, f) => { flags = f; return 99; } };
  assert.equal(hasTestMarker(os.tmpdir(), { fsImpl: spy }), true);
  assert.equal((flags & fs.constants.O_NOFOLLOW), fs.constants.O_NOFOLLOW);
});

// ---- win32 branch -------------------------------------------------------------------------------------------
// A fake fs that models one Windows resources directory. Each test changes one fact; removing any single check
// from hasTestMarkerWin32 turns exactly the matching assertion red (packaging/test-verify-artifact-win.sh and the
// mutation run in docs/desktop-windows.md).
const WIN_RES = 'C:\\Users\\u\\AppData\\Local\\Programs\\BentoPDF\\resources';
const WIN_MARKER = `${WIN_RES}\\${MARKER_NAME}`;
function fakeWinFs({ resReal = WIN_RES, markerReal, lstat = {}, fstat = {}, token = MARKER_CONTENT, missing = false, opened = [], closeThrows = false } = {}) {
  const seen = [];
  // The directory the resources path really is (resReal) holds a perfectly valid marker, so a refusal can only
  // come from the check under test, never from the fake not knowing a path.
  const realMarker = `${resReal}\\${MARKER_NAME}`;
  // bigint stats, as the real win32 branch asks for them ({bigint:true}); overrides may be numbers or bigints.
  const file = { isFile: () => true, isSymbolicLink: () => false, dev: 7n, ino: 4242n, nlink: 1n, size: BigInt(MARKER_CONTENT.length) };
  const enoent = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
  const realpathSync = () => { throw new Error('the win32 branch must use realpathSync.native'); };
  realpathSync.native = (p) => {
    if (p.toLowerCase() === WIN_RES.toLowerCase()) return resReal;
    if (p.toLowerCase() === realMarker.toLowerCase()) return markerReal || realMarker;
    throw enoent(p);
  };
  return {
    constants: { O_RDONLY: 0 },
    realpathSync,
    lstatSync: (p, o) => {
      seen.push(o);
      if (missing || p.toLowerCase() !== realMarker.toLowerCase()) throw enoent(p);
      return { ...file, ...lstat };
    },
    openSync: (p) => { opened.push(p); return 99; },
    fstatSync: (_fd, o) => { seen.push(o); return { ...file, ...fstat }; },
    readSync: (_fd, buf) => buf.write(token),
    closeSync: () => { if (closeThrows) throw new Error('EIO on close'); },
    seen,
  };
}
const win = (fsImpl, res = WIN_RES) => hasTestMarker(res, { fsImpl, platform: 'win32' });

test('hasTestMarker win32 (fake fs): a valid marker is accepted, a different-case spelling of the same path too', () => {
  assert.equal(win(fakeWinFs()), true);
  assert.equal(win(fakeWinFs(), WIN_RES.toUpperCase()), true);
});
test('hasTestMarker win32 (fake fs): absent marker, empty or non-string resources path', () => {
  assert.equal(win(fakeWinFs({ missing: true })), false);
  for (const bad of [undefined, null, '', 42]) assert.equal(hasTestMarker(bad, { fsImpl: fakeWinFs(), platform: 'win32' }), false, String(bad));
});
test('hasTestMarker win32 (fake fs): resources directory reached through a junction/symlink/short name is refused', () => {
  assert.equal(win(fakeWinFs({ resReal: 'D:\\elsewhere\\resources' })), false);
  assert.equal(win(fakeWinFs({ resReal: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Programs\\BentoPDF\\resources' })), false);
});
test('hasTestMarker win32 (fake fs): a symlink or a non-file at the marker name is refused', () => {
  assert.equal(win(fakeWinFs({ lstat: { isSymbolicLink: () => true } })), false, 'symlink/junction');
  assert.equal(win(fakeWinFs({ lstat: { isFile: () => false } })), false, 'directory');
});
test('hasTestMarker win32 (fake fs): a marker whose native real path is elsewhere (other reparse point) is refused', () => {
  assert.equal(win(fakeWinFs({ markerReal: 'D:\\attacker\\.bento-test-mode' })), false);
});
test('hasTestMarker win32 (fake fs): each bad handle fact is refused on its own (swap, type, nlink, size, token)', () => {
  assert.equal(win(fakeWinFs({ fstat: { ino: 1 } })), false, 'ino swapped after lstat');
  assert.equal(win(fakeWinFs({ fstat: { dev: 8 } })), false, 'dev swapped after lstat');
  assert.equal(win(fakeWinFs({ fstat: { isFile: () => false } })), false, 'handle not a file');
  assert.equal(win(fakeWinFs({ fstat: { nlink: 2 } })), false, 'hard link');
  assert.equal(win(fakeWinFs({ fstat: { size: MARKER_CONTENT.length + 1 } })), false, 'size larger');
  assert.equal(win(fakeWinFs({ fstat: { size: 0 } })), false, 'size smaller');
  assert.equal(win(fakeWinFs({ token: MARKER_CONTENT.replace('v1', 'v2') })), false, 'token');
  assert.equal(win(fakeWinFs({ token: `${MARKER_CONTENT}x` })), false, 'extra bytes');
});
test('hasTestMarker win32 (fake fs): the file opened is exactly <native resources>\\.bento-test-mode', () => {
  const opened = [];
  assert.equal(win(fakeWinFs({ opened }), WIN_RES.toUpperCase()), true);
  assert.deepEqual(opened, [WIN_MARKER]);
});
test('hasTestMarker: the POSIX branch never runs the win32 checks and vice versa', () => {
  // win32 fake fs on the POSIX branch: no lstat/realpath.native semantics, uid missing -> refused
  assert.equal(hasTestMarker(WIN_RES, { fsImpl: fakeWinFs(), platform: 'linux', uid: null }), false);
});

// ---- win32 branch, real files on a win32 host ---------------------------------------------------------------
const WIN_ONLY = !WIN && 'real NTFS semantics: runs on windows-latest only';
test('hasTestMarker win32 (real files): valid accepted; extra bytes, other token, directory, hard link, symlink, junction refused', { skip: WIN_ONLY }, () => {
  withResources((dir, file) => {
    const res = fs.realpathSync.native(dir);
    assert.equal(hasTestMarker(res), false, 'absent');
    fs.writeFileSync(file, MARKER_CONTENT);
    assert.equal(hasTestMarker(res), true, 'valid');
    fs.writeFileSync(file, `${MARKER_CONTENT}x`);
    assert.equal(hasTestMarker(res), false, 'extra bytes');
    fs.writeFileSync(file, MARKER_CONTENT.replace('v1', 'v2'));
    assert.equal(hasTestMarker(res), false, 'other token');
    fs.writeFileSync(file, MARKER_CONTENT);
    fs.linkSync(file, path.join(dir, 'second-name'));
    assert.equal(hasTestMarker(res), false, 'hard link');
    fs.unlinkSync(path.join(dir, 'second-name'));
    assert.equal(hasTestMarker(res), true, 'valid again');
    fs.renameSync(file, path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), file, 'file');
    assert.equal(hasTestMarker(res), false, 'symlink');
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.equal(hasTestMarker(res), false, 'directory');
    fs.rmdirSync(file);
    fs.renameSync(path.join(dir, 'real'), file);
    const alias = `${res}-junction`;
    fs.symlinkSync(res, alias, 'junction');
    try {
      assert.equal(hasTestMarker(alias), false, 'resources through a junction');
      assert.equal(hasTestMarker(res), true, 'valid through the real path');
    } finally {
      fs.unlinkSync(alias);
    }
  });
});

test('hasTestMarker win32 (fake fs): file ids are compared as 64-bit bigints (a difference beyond 2^53 is still a swap)', () => {
  const big = 2n ** 60n;
  assert.equal(win(fakeWinFs({ lstat: { ino: big }, fstat: { ino: big } })), true, 'same large id');
  assert.equal(win(fakeWinFs({ lstat: { ino: big }, fstat: { ino: big + 1n } })), false, 'low bit differs, equal as doubles');
  const fake = fakeWinFs();
  assert.equal(win(fake), true);
  assert.deepEqual(fake.seen, [{ bigint: true }, { bigint: true }], 'lstat and fstat both ask for bigint');
});
test('hasTestMarker: a throwing closeSync never turns a verdict into an exception (both branches)', () => {
  assert.equal(win(fakeWinFs({ closeThrows: true })), true, 'win32 accepted');
  assert.equal(win(fakeWinFs({ closeThrows: true, token: 'x'.repeat(MARKER_CONTENT.length) })), false, 'win32 refused');
  if (process.platform !== 'win32') {
    const throwing = { ...fakeFs({}), closeSync: () => { throw new Error('EIO on close'); } };
    assert.equal(hasTestMarker(os.tmpdir(), { fsImpl: throwing }), true, 'posix accepted');
    assert.equal(hasTestMarker(os.tmpdir(), { fsImpl: { ...throwing, fstatSync: () => ({ ...fakeFs({}).fstatSync(), nlink: 2 }) } }), false, 'posix refused');
  }
});
