'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { unsafeSwitches } = require('../src/argv-policy');
const { pdfPathsFromArgv } = require('../src/open-file');

test('unsafeSwitches: sandbox-off, inspect, js-flags and web-security switches are refused in every spelling', () => {
  const bad = ['--no-sandbox', '--disable-gpu-sandbox', '--disable-setuid-sandbox', '--inspect', '--inspect=9229', '--inspect-brk=0',
    '--js-flags=--allow-natives-syntax', '--js-flags', '--disable-web-security', '--remote-debugging-address=0.0.0.0',
    '--remote-allow-origins=*', '--NO-SANDBOX', '--host-resolver-rules=MAP * 1.2.3.4', '--load-extension=/tmp/x'];
  for (const arg of bad) assert.deepEqual(unsafeSwitches(['exe', arg]), [arg], arg);
});

test('unsafeSwitches: the debug port/pipe is refused unless the headless ozone backend is selected', () => {
  assert.deepEqual(unsafeSwitches(['exe', '--remote-debugging-port=0']), ['--remote-debugging-port=0']);
  assert.deepEqual(unsafeSwitches(['exe', '--remote-debugging-pipe']), ['--remote-debugging-pipe']);
  assert.deepEqual(unsafeSwitches(['exe', '--ozone-platform=headless', '--remote-debugging-port=0']), []);
  assert.deepEqual(unsafeSwitches(['exe', '--ozone-platform=headless', '--remote-debugging-address=0.0.0.0']), ['--remote-debugging-address=0.0.0.0']);
  assert.deepEqual(unsafeSwitches(['exe', '--ozone-platform=wayland', '--remote-debugging-port=0']), ['--remote-debugging-port=0']);
});

test('unsafeSwitches: ordinary launches, file arguments and junk pass through', () => {
  assert.deepEqual(unsafeSwitches(['exe', '--ozone-platform-hint=auto', '--user-data-dir=/tmp/p', '/home/u/a.pdf', 'file:///x.pdf']), []);
  assert.deepEqual(unsafeSwitches(undefined), []);
  assert.deepEqual(unsafeSwitches(['exe', 42, null]), []);
});

test('open-with still accepts only file arguments and file:// URLs next to refused switches', () => {
  assert.deepEqual(pdfPathsFromArgv(['exe', '--no-sandbox', 'https://x.example/a.pdf', '/d/a.pdf'], { cwd: '/' }), ['/d/a.pdf']);
});
