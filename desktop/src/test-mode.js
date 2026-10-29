'use strict';

// A packaged build honours BENTO_TEST_HEADLESS only if a marker file ships next to the app
// resources. Release artifacts never contain it (packaging/verify-artifact.sh fails if they do);
// the packaged smoke test creates it inside a disposable extracted COPY of an AppImage.
// This is a tripwire, not a boundary: Chromium parses the debug-port switch before any
// JavaScript runs. The marker only decides whether our own argv policy then lets it through.
const fs = require('node:fs');
const path = require('node:path');

const MARKER_NAME = '.bento-test-mode';
const MARKER_CONTENT = 'bento-test-mode-v1\n';

/**
 * True only for a regular file (not a symlink) owned by us, with a single hard link, not group/world-writable,
 * with exactly the token, inside a resources directory that is its own real path. Everything else, including
 * platforms without uid/mode semantics (win32), fails closed.
 */
function hasTestMarker(resourcesPath, { fsImpl = fs, uid = process.getuid && process.getuid() } = {}) {
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return false;
  if (typeof uid !== 'number') return false; // win32: no uid semantics, test mode unavailable
  let fd = null;
  try {
    // A symlinked resources directory (or parent) could point at an attacker-controlled tree: refuse it.
    if (fsImpl.realpathSync(resourcesPath) !== path.resolve(resourcesPath)) return false;
    // O_NOFOLLOW: a symlink at the final component fails to open; fstat on the fd avoids a check/use gap.
    fd = fsImpl.openSync(path.join(resourcesPath, MARKER_NAME), fsImpl.constants.O_RDONLY | fsImpl.constants.O_NOFOLLOW);
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== uid || (st.mode & 0o022) !== 0 || st.size !== MARKER_CONTENT.length) return false;
    const buf = Buffer.alloc(MARKER_CONTENT.length + 1);
    const n = fsImpl.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n) === MARKER_CONTENT;
  } catch {
    return false; // absent, symlink, unreadable: all mean "not test mode"
  } finally {
    if (fd !== null) fsImpl.closeSync(fd);
  }
}

module.exports = { hasTestMarker, MARKER_NAME, MARKER_CONTENT };
