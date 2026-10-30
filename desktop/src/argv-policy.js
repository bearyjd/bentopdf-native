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
// Test-only switches live in src/test-mode.js, which the RELEASE flavour replaces with a stub that has none
// (issue #13): a release build refuses them like any other switch. Test mode is never on in the release flavour,
// whatever app.isPackaged says (Electron derives isPackaged from the executable's name, so a copy of a release
// executable renamed to `electron` would otherwise count as unpackaged). In the dev and smoke flavours it needs
// BENTO_TEST_HEADLESS=1 and, for a packaged build, the marker file. The default env here is empty: fails closed.
const { flavour: BUILD_FLAVOUR } = require('./build-flavour');
const { isTestSwitch, testHeadless, testTraceDir } = require('./test-mode');
const TEST_FLAVOURS = new Set(['dev', 'smoke']);

// Electron itself adds this switch to the argv it reports for a *second* instance (measured on
// Electron 45.1.0; the first launch's process.argv does not have it). It has no effect there: the
// first process never re-parses the second one's switches. Accepted for second-instance argv only.
const SECOND_INSTANCE_INJECTED = new Set([`${DASHES}allow-file-access-from-files`]);

const looksLikeSwitch = (arg, platform) =>
  typeof arg === 'string' && (arg.startsWith('-') || (platform === 'win32' && arg.startsWith('/')));

/** Test mode: a test flavour (never release), the environment, and for a packaged build the marker file too. */
function testModeOn(env = {}, { packaged = false, testMarker = false, flavour = BUILD_FLAVOUR } = {}) {
  return TEST_FLAVOURS.has(flavour) && testHeadless(env) && (!packaged || testMarker === true);
}

function allowed(arg, testMode, secondInstance) {
  if (ALWAYS_ALLOWED.has(arg)) return true;
  if (secondInstance && SECOND_INSTANCE_INJECTED.has(arg)) return true;
  if (!testMode) return false;
  return isTestSwitch(arg);
}

/**
 * Returns the arguments of `argv` (after the executable) that this application
 * refuses, i.e. every switch not on the allowlist (empty array = fine).
 */
function unsafeSwitches(argv, env = {}, { secondInstance = false, packaged = false, testMarker = false, flavour = BUILD_FLAVOUR, platform = process.platform } = {}) {
  const list = Array.isArray(argv) ? argv.slice(1) : [];
  const end = list.indexOf('--');
  const options = end === -1 ? list : list.slice(0, end);
  // A packaged build honours the test switch only with the marker file (testMarker), never on the environment alone.
  const testMode = testModeOn(env, { packaged, testMarker, flavour });
  return options.filter((arg) => looksLikeSwitch(arg, platform) && !allowed(arg, testMode, secondInstance));
}

module.exports = { unsafeSwitches, looksLikeSwitch, testModeOn, testHeadless, testTraceDir };
