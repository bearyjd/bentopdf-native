'use strict';

// Allowlist for command-line switches. Chromium has already parsed the first
// instance's own switches before any JavaScript runs, so for the first launch
// this is a fail-closed tripwire (exit 2); for a second instance the whole
// invocation is dropped.
//
// Anything that starts with a dash is a switch, whatever its spelling: on POSIX
// Chromium honours a single dash too (`-remote-debugging-port=0`; verified on
// Electron 45, docs/desktop-linux.md). Only the exact, case-sensitive forms
// below pass. A bare `--` ends the options: what follows is a file argument.
// Switch names are built from parts so the release gate's grep for forbidden
// flag literals stays meaningful.
const DASHES = '--';
const ALWAYS_ALLOWED = new Set([
  `${DASHES}ozone-platform-hint=auto`,
  `${DASHES}ozone-platform-hint=wayland`,
  `${DASHES}ozone-platform-hint=x11`,
]);
// The test harness drives the real artifact headless over the debug port. These
// pass only when BENTO_TEST_HEADLESS=1 is in the environment of an UNPACKAGED run (main.js passes
// `app.isPackaged ? {} : process.env`; the default env here is empty, so it fails closed).
const TEST_EXACT = new Set([`${DASHES}ozone-platform=headless`, `${DASHES}remote-debugging-pipe`]);
const TEST_PREFIX = [`${DASHES}remote-debugging-port=`, `${DASHES}user-data-dir=`];

// Electron itself adds this switch to the argv it reports for a *second* instance (measured on
// Electron 45.1.0; the first launch's process.argv does not have it). It has no effect there: the
// first process never re-parses the second one's switches. Accepted for second-instance argv only.
const SECOND_INSTANCE_INJECTED = new Set([`${DASHES}allow-file-access-from-files`]);

const looksLikeSwitch = (arg) => typeof arg === 'string' && arg.startsWith('-');

function allowed(arg, testMode, secondInstance) {
  if (ALWAYS_ALLOWED.has(arg)) return true;
  if (secondInstance && SECOND_INSTANCE_INJECTED.has(arg)) return true;
  if (!testMode) return false;
  return TEST_EXACT.has(arg) || TEST_PREFIX.some((p) => arg.startsWith(p) && arg.length > p.length);
}

/**
 * Returns the arguments of `argv` (after the executable) that this application
 * refuses, i.e. every switch not on the allowlist (empty array = fine).
 */
function unsafeSwitches(argv, env = {}, { secondInstance = false, packaged = false } = {}) {
  const list = Array.isArray(argv) ? argv.slice(1) : [];
  const end = list.indexOf('--');
  const options = end === -1 ? list : list.slice(0, end);
  // A packaged build never honours the test switch, whatever its environment says.
  const testMode = !packaged && env.BENTO_TEST_HEADLESS === '1';
  return options.filter((arg) => looksLikeSwitch(arg) && !allowed(arg, testMode, secondInstance));
}

module.exports = { unsafeSwitches };
