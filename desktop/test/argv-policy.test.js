'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { unsafeSwitches } = require('../src/argv-policy');
const { pdfPathsFromArgv } = require('../src/open-file');

const NO_ENV = {};
const TEST_ENV = { BENTO_TEST_HEADLESS: '1' };
// The platform is passed explicitly so the result does not depend on the host: on win32 Chromium treats a
// leading '/' as a switch prefix (base/command_line.cc), on POSIX '/x' is a file argument.
const refused = (arg, env = NO_ENV, platform = 'linux') => unsafeSwitches(['exe', arg], env, { platform });
const posix = { platform: 'linux' };

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
  assert.deepEqual(unsafeSwitches(['exe', '--ozone-platform-hint=auto', '/home/u/a.pdf', 'file:///x.pdf', 'rel/b.pdf'], NO_ENV, posix), []);
  assert.deepEqual(unsafeSwitches(['exe', 'C:\\Users\\u\\a.pdf', '\\\\server\\share\\b.pdf', 'file:///C:/x.pdf', 'rel\\b.pdf'], NO_ENV, { platform: 'win32' }), []);
  assert.deepEqual(unsafeSwitches(undefined), []);
  assert.deepEqual(unsafeSwitches(['exe', 42, null], NO_ENV), []);
});

test('unsafeSwitches: the switch Electron injects into second-instance argv passes there only', () => {
  for (const [platform, file] of [['linux', '/d/a.pdf'], ['win32', 'C:\\d\\a.pdf']]) {
    const injected = ['exe', '--ozone-platform-hint=auto', '--allow-file-access-from-files', file];
    assert.deepEqual(unsafeSwitches(injected, NO_ENV, { secondInstance: true, platform }), [], platform);
    assert.deepEqual(unsafeSwitches(injected, NO_ENV, { platform }), ['--allow-file-access-from-files'], platform);
  }
  assert.deepEqual(unsafeSwitches(['exe', '--allow-file-access-from-files', '--no-sandbox'], NO_ENV, { secondInstance: true, platform: 'linux' }), ['--no-sandbox']);
});

test('unsafeSwitches: on win32 a leading slash is a switch (Chromium prefix, read from source), on POSIX a path', () => {
  // A POSIX-looking /d/a.pdf is ambiguous on Windows; failing closed (dropping the launch) is the safe side.
  // Real Windows file arguments are C:\x.pdf or \\server\share, which never start with a slash.
  assert.deepEqual(refused('/no-sandbox', NO_ENV, 'win32'), ['/no-sandbox']);
  assert.deepEqual(refused('/d/a.pdf', NO_ENV, 'win32'), ['/d/a.pdf']);
  assert.deepEqual(refused('/no-sandbox', NO_ENV, 'linux'), []);
});

test('unsafeSwitches: a bare -- ends the options; refused switches before it still count', () => {
  assert.deepEqual(unsafeSwitches(['exe', '--', '--no-sandbox', '-x.pdf'], NO_ENV), []);
  assert.deepEqual(unsafeSwitches(['exe', '--no-sandbox', '--', 'a.pdf'], NO_ENV), ['--no-sandbox']);
  assert.deepEqual(unsafeSwitches(['exe', 'a.pdf', '-no-sandbox'], NO_ENV), ['-no-sandbox']);
});

test('open-with still accepts only file arguments and file:// URLs next to refused switches', () => {
  assert.deepEqual(pdfPathsFromArgv(['exe', '--no-sandbox', 'https://x.example/a.pdf', '/d/a.pdf'], { cwd: '/' }), ['/d/a.pdf']);
});
