'use strict';

// Command-line switches this application refuses. Chromium has already parsed
// the first instance's own switches before any JavaScript runs, so for the
// first launch this is a fail-closed tripwire (exit 2); for a second instance
// the whole invocation is dropped. The names are listed without their leading
// dashes so that the release gate's grep for forbidden flags stays meaningful.
const ALWAYS_REFUSED = [
  'no-sandbox',
  'disable-gpu-sandbox',
  'disable-setuid-sandbox',
  'disable-namespace-sandbox',
  'disable-seccomp-filter-sandbox',
  'disable-web-security',
  'disable-site-isolation-trials',
  'allow-running-insecure-content',
  'ignore-certificate-errors',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
  'js-flags',
  'remote-debugging-address',
  'remote-allow-origins',
  'auto-open-devtools-for-tabs',
  'load-extension',
  'host-rules',
  'host-resolver-rules',
];
// Debug port/pipe: only alongside the headless ozone backend, which cannot show
// a window (this is how the packaged smoke test drives the real artifact).
const HEADLESS_ONLY = ['remote-debugging-port', 'remote-debugging-pipe'];

const switchName = (arg) => arg.slice(2).split('=')[0].toLowerCase();

/** Returns the arguments of `argv` that this application refuses (empty array = fine). */
function unsafeSwitches(argv) {
  const switches = (Array.isArray(argv) ? argv : []).filter((a) => typeof a === 'string' && a.startsWith('--'));
  const headless = switches.some((a) => a.toLowerCase() === '--ozone-platform=headless');
  return switches.filter((arg) => {
    const name = switchName(arg);
    if (ALWAYS_REFUSED.includes(name) || name.startsWith('inspect')) return true;
    return HEADLESS_ONLY.includes(name) && !headless;
  });
}

module.exports = { unsafeSwitches };
