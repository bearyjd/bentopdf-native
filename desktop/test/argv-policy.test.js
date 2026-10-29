'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { unsafeSwitches } = require('../src/argv-policy');
const { pdfPathsFromArgv } = require('../src/open-file');

const NO_ENV = {};
const TEST_ENV = { BENTO_TEST_HEADLESS: '1' };
const refused = (arg, env = NO_ENV) => unsafeSwitches(['exe', arg], env);

test('unsafeSwitches: every switch not on the allowlist is refused, in every spelling', () => {
  const bad = ['--no-sandbox', '--NO-SANDBOX', '--No-Sandbox', '-no-sandbox', '-NO-SANDBOX', '-remote-debugging-port=9222', '-js-flags=--allow-natives-syntax',
    '--disable-gpu-sandbox', '--disable-setuid-sandbox', '--inspect', '--inspect=9229', '-inspect-brk=0', '--js-flags', '--disable-web-security',
    '--remote-debugging-address=0.0.0.0', '--remote-allow-origins=*', '--host-resolver-rules=MAP * 1.2.3.4', '--load-extension=/tmp/x',
    '--no-zygote', '--renderer-cmd-prefix=/tmp/evil', '--browser-subprocess-path=/tmp/evil', '--user-data-dir=/tmp/p', '--proxy-server=evil:1',
    '--allow-file-access-from-files', '--unsafely-treat-insecure-origin-as-secure=http://x', '--enable-features=Foo', '--disable-features=Foo',
    '--disable-blink-features=Foo', '--disable-blink-features', '--ozone-platform=headless', '--ozone-platform=x11', '--remote-debugging-port=0',
    '--remote-debugging-pipe', '--ozone-platform-hint=evil', '--OZONE-PLATFORM-HINT=auto', '-ozone-platform-hint=auto', '-', '---no-sandbox'];
  for (const arg of bad) assert.deepEqual(refused(arg), [arg], arg);
});

test('unsafeSwitches: test-only switches pass only with BENTO_TEST_HEADLESS=1, and only in their exact form', () => {
  for (const arg of ['--ozone-platform=headless', '--remote-debugging-port=0', '--remote-debugging-pipe', '--user-data-dir=/tmp/p']) {
    assert.deepEqual(refused(arg), [arg], `${arg} without the flag`);
    assert.deepEqual(refused(arg, TEST_ENV), [], `${arg} with the flag`);
  }
  for (const arg of ['--ozone-platform=wayland', '-remote-debugging-port=0', '--remote-debugging-port', '--user-data-dir=', '--remote-debugging-address=0.0.0.0',
    '--no-sandbox', '-ozone-platform=headless', '--remote-debugging-pipe=1']) {
    assert.deepEqual(refused(arg, TEST_ENV), [arg], `${arg} even with the flag`);
  }
  assert.deepEqual(refused('--ozone-platform=headless', { BENTO_TEST_HEADLESS: 'true' }), ['--ozone-platform=headless']);
});

test('unsafeSwitches: the platform hint, file arguments and junk pass; the executable is not inspected', () => {
  for (const hint of ['auto', 'wayland', 'x11']) assert.deepEqual(refused(`--ozone-platform-hint=${hint}`), []);
  assert.deepEqual(unsafeSwitches(['exe', '--ozone-platform-hint=auto', '/home/u/a.pdf', 'file:///x.pdf', 'rel/b.pdf'], NO_ENV), []);
  assert.deepEqual(unsafeSwitches(undefined), []);
  assert.deepEqual(unsafeSwitches(['exe', 42, null], NO_ENV), []);
});

test('unsafeSwitches: the switch Electron injects into second-instance argv passes there only', () => {
  const injected = ['exe', '--ozone-platform-hint=auto', '--allow-file-access-from-files', '/d/a.pdf'];
  assert.deepEqual(unsafeSwitches(injected, NO_ENV, { secondInstance: true }), []);
  assert.deepEqual(unsafeSwitches(injected, NO_ENV), ['--allow-file-access-from-files']);
  assert.deepEqual(unsafeSwitches(['exe', '--allow-file-access-from-files', '--no-sandbox'], NO_ENV, { secondInstance: true }), ['--no-sandbox']);
});

test('unsafeSwitches: a bare -- ends the options; refused switches before it still count', () => {
  assert.deepEqual(unsafeSwitches(['exe', '--', '--no-sandbox', '-x.pdf'], NO_ENV), []);
  assert.deepEqual(unsafeSwitches(['exe', '--no-sandbox', '--', 'a.pdf'], NO_ENV), ['--no-sandbox']);
  assert.deepEqual(unsafeSwitches(['exe', 'a.pdf', '-no-sandbox'], NO_ENV), ['-no-sandbox']);
});

test('open-with still accepts only file arguments and file:// URLs next to refused switches', () => {
  assert.deepEqual(pdfPathsFromArgv(['exe', '--no-sandbox', 'https://x.example/a.pdf', '/d/a.pdf'], { cwd: '/' }), ['/d/a.pdf']);
});

test('unsafeSwitches: a packaged build refuses the test switches even with BENTO_TEST_HEADLESS=1', () => {
  for (const arg of ['--ozone-platform=headless', '--remote-debugging-port=0', '--remote-debugging-pipe', '--user-data-dir=/tmp/p']) {
    assert.deepEqual(unsafeSwitches(['exe', arg], TEST_ENV, { packaged: true }), [arg], arg);
    assert.deepEqual(unsafeSwitches(['exe', arg], TEST_ENV, { packaged: true, secondInstance: true }), [arg], `${arg} (second instance)`);
    assert.deepEqual(unsafeSwitches(['exe', arg], TEST_ENV, { packaged: false }), [], `${arg} unpackaged`);
  }
  assert.deepEqual(unsafeSwitches(['exe', '--remote-debugging-port=0']), ['--remote-debugging-port=0'], 'no env argument: closed');
});

test('main.js feeds the policy the app.isPackaged-gated environment, and both launchers unset the test variables', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /unsafeSwitches\(process\.argv, overrides, \{ packaged: app\.isPackaged \}\)/);
  assert.match(main, /unsafeSwitches\(argv, overrides, \{ secondInstance: true, packaged: app\.isPackaged \}\)/);
  for (const launcher of ['linux/AppRun', 'flatpak/launcher.sh.in']) {
    const unset = fs.readFileSync(path.join(__dirname, '..', '..', 'packaging', launcher), 'utf8').split('\n').find((l) => l.startsWith('unset '));
    for (const v of ['BENTO_TEST_HEADLESS', 'BENTO_DIST', 'BENTO_TRANSPORT']) assert.match(unset, new RegExp(`\\b${v}\\b`), `${launcher} unsets ${v}`);
  }
});
