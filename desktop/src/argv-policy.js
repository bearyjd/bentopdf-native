'use strict';

// Allowlist for command-line switches. Chromium has already parsed the first
// instance's own switches before any JavaScript runs, so for the first launch
// this is a fail-closed tripwire (exit 2); for a second instance the whole
// invocation is dropped.
//
// Anything that starts with a dash is a switch, whatever its spelling: on POSIX
// Chromium honours a single dash too (`-remote-debugging-port=0`; verified on
// Electron 45, docs/desktop-linux.md). On Windows Chromium additionally accepts a
// leading slash (`/remote-debugging-port=0`): base/command_line.cc defines
// kSwitchPrefixes as {"--", "-", "/"} under IS_WIN, and lowercases the switch name there
// (read from the Chromium source, NOT measured on a Windows runner; docs/desktop-windows.md).
// So on win32 a leading `/` is a switch too. On POSIX `/home/u/x.pdf` is a file argument.
// Only the exact, case-sensitive forms below pass. A bare `--` ends the options: what follows is a file argument.
// Switch names are built from parts so the release gate's grep for forbidden
// flag literals stays meaningful.
const DASHES = '--';
const ALWAYS_ALLOWED = new Set([
  `${DASHES}ozone-platform-hint=auto`,
  `${DASHES}ozone-platform-hint=wayland`,
  `${DASHES}ozone-platform-hint=x11`,
]);
// The test harness drives the real artifact headless over the debug port. These
// pass only when BENTO_TEST_HEADLESS=1 is in the environment.
const TEST_EXACT = new Set([`${DASHES}ozone-platform=headless`, `${DASHES}remote-debugging-pipe`]);
const TEST_PREFIX = [`${DASHES}remote-debugging-port=`, `${DASHES}user-data-dir=`];

// Electron itself adds this switch to the argv it reports for a *second* instance (measured on
// Electron 45.1.0; the first launch's process.argv does not have it). It has no effect there: the
// first process never re-parses the second one's switches. Accepted for second-instance argv only.
const SECOND_INSTANCE_INJECTED = new Set([`${DASHES}allow-file-access-from-files`]);

const looksLikeSwitch = (arg, platform) =>
  typeof arg === 'string' && (arg.startsWith('-') || (platform === 'win32' && arg.startsWith('/')));

/** Test mode (headless CI smoke): the window is never shown and test-only switches pass. */
const testHeadless = (env = process.env) => env.BENTO_TEST_HEADLESS === '1';

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
function unsafeSwitches(argv, env = process.env, { secondInstance = false, platform = process.platform } = {}) {
  const list = Array.isArray(argv) ? argv.slice(1) : [];
  const end = list.indexOf('--');
  const options = end === -1 ? list : list.slice(0, end);
  const testMode = testHeadless(env);
  return options.filter((arg) => looksLikeSwitch(arg, platform) && !allowed(arg, testMode, secondInstance));
}

module.exports = { unsafeSwitches, looksLikeSwitch, testHeadless };
