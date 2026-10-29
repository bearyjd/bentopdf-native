'use strict';

// Test mode: SMOKE flavour and unpackaged runs only (issue #13). A RELEASE build does not contain this file:
// electron-builder packs flavours/release/test-mode.js in its place (tools/flavour.js), a stub with no marker
// logic and no test-only switch, and the release gate (tools/check-asar-policy.js --flavour release) asserts the
// stub byte for byte. In a packaged SMOKE build test mode needs BENTO_TEST_HEADLESS=1 AND a marker file next to
// the app resources; the packaged smoke tests create it inside a disposable copy of the smoke artifact.
// Chromium still parses the debug-port switch before any JavaScript runs: the marker only decides whether our own
// argv policy then lets it through (src/argv-policy.js).
const fs = require('node:fs');
const path = require('node:path');

const MARKER_NAME = '.bento-test-mode';
const MARKER_CONTENT = 'bento-test-mode-v1\n';

// The test harness drives the app headless over the debug port. These switches pass the argv policy only in test
// mode (argv-policy.js); switch names are built from parts so the release gate's grep for forbidden flag literals
// stays meaningful.
const DASHES = '--';
const TEST_EXACT = new Set([`${DASHES}ozone-platform=headless`, `${DASHES}remote-debugging-pipe`]);
const TEST_PREFIX = [`${DASHES}remote-debugging-port=`, `${DASHES}user-data-dir=`];
/** A switch that only test mode may use. */
const isTestSwitch = (arg) => TEST_EXACT.has(arg) || TEST_PREFIX.some((p) => arg.startsWith(p) && arg.length > p.length);

/** Test mode asked for by the environment (still needs a test flavour, and the marker when packaged). */
const testHeadless = (env = {}) => env.BENTO_TEST_HEADLESS === '1';

/** Test mode only: directory for per-process trace files (BENTO_TEST_TRACE_DIR), or undefined. */
const testTraceDir = (env = {}) => (testHeadless(env) ? env.BENTO_TEST_TRACE_DIR : undefined);

// Closing the descriptor must never throw out of the fail-closed path: a throw in `finally` would replace the verdict.
function closeQuietly(fsImpl, fd) {
  if (fd === null) return;
  try { fsImpl.closeSync(fd); } catch { /* the verdict is already decided */ }
}

/**
 * True only for a regular file (not a symlink) owned by us, with a single hard link, not group/world-writable,
 * with exactly the token, inside a resources directory that is its own real path. Everything else fails closed.
 * win32 has its own branch (hasTestMarkerWin32); `platform` is injectable so it is unit-tested on any host.
 */
function hasTestMarker(resourcesPath, { fsImpl = fs, uid = process.getuid && process.getuid(), platform = process.platform } = {}) {
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return false;
  if (platform === 'win32') return hasTestMarkerWin32(resourcesPath, fsImpl);
  if (typeof uid !== 'number') return false; // no uid semantics: test mode unavailable
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
    closeQuietly(fsImpl, fd);
  }
}

// NTFS names are case-insensitive: a different spelling of the same path is the same file. Anything that
// resolves elsewhere (symlink, junction, other reparse point, 8.3 short name) differs and fails closed.
const sameWin32Path = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * win32: there is no uid or mode bit to check. What CAN be checked: the resources directory is its own native
 * real path; the marker, found by lstat directly inside it, is a regular file and not a symlink or junction;
 * its native real path is exactly <resources>\.bento-test-mode (so no other reparse point redirects it); the
 * handle we read is the file we lstat'ed (dev/ino); it has one hard link, exactly the token's size and exactly
 * the token. Ownership and write permission are left to the install directory's ACLs: a per-machine install
 * under Program Files is writable only by administrators; a per-user install under %LOCALAPPDATA% is writable
 * by that user, who can equally replace the application itself, so the marker grants nothing extra there.
 */
function hasTestMarkerWin32(resourcesPath, fsImpl) {
  const P = path.win32;
  let fd = null;
  try {
    const res = fsImpl.realpathSync.native(resourcesPath);
    if (!sameWin32Path(res, P.resolve(resourcesPath))) return false;
    const marker = P.join(res, MARKER_NAME);
    const lst = fsImpl.lstatSync(marker, { bigint: true }); // bigint: NTFS file ids are 64 bit
    if (lst.isSymbolicLink() || !lst.isFile()) return false;
    if (!sameWin32Path(fsImpl.realpathSync.native(marker), marker)) return false;
    fd = fsImpl.openSync(marker, fsImpl.constants.O_RDONLY);
    const st = fsImpl.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== lst.dev || st.ino !== lst.ino) return false;
    if (Number(st.nlink) !== 1 || Number(st.size) !== MARKER_CONTENT.length) return false;
    const buf = Buffer.alloc(MARKER_CONTENT.length + 1);
    const n = fsImpl.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n) === MARKER_CONTENT;
  } catch {
    return false;
  } finally {
    closeQuietly(fsImpl, fd);
  }
}

module.exports = { hasTestMarker, isTestSwitch, testHeadless, testTraceDir, MARKER_NAME, MARKER_CONTENT };
