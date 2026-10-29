'use strict';

// Windows-specific rules, exercised through the `platform` parameters so they run on every OS.
// These are lexical checks: they prove the policy, not Windows file-system behaviour (docs/desktop-windows.md).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { looksLikeSwitch, testHeadless, unsafeSwitches } = require('../src/argv-policy');
const { pdfPathsFromArgv, validateOpenPath, validateLocalFile, windowsPathProblem } = require('../src/open-file');
const { isWindowsUnsafeSegment, resolveFile } = require('../src/static-files');

const WIN = { platform: 'win32', cwd: 'C:\\work' };
const open = (arg, options = WIN) => pdfPathsFromArgv(['C:\\app\\app.exe', arg], options);

test('argv policy: on win32 a leading slash is a switch (Chromium accepts /switch there); on POSIX it is a path', () => {
  for (const arg of ['/no-sandbox', '/NO-SANDBOX', '/remote-debugging-port=9222', '/js-flags=--allow-natives-syntax', '/', '/ozone-platform-hint=auto']) {
    assert.deepEqual(unsafeSwitches(['exe', arg], {}, { platform: 'win32' }), [arg], arg);
    assert.deepEqual(unsafeSwitches(['exe', arg], {}, { platform: 'linux' }), [], `${arg} is a file argument on linux`);
  }
  assert.deepEqual(unsafeSwitches(['exe', '/x.pdf'], {}, { platform: 'win32' }), ['/x.pdf'], 'a slash-leading path is indistinguishable from a switch: refused');
  assert.deepEqual(unsafeSwitches(['exe', '--', '/x.pdf'], {}, { platform: 'win32' }), [], 'after a bare -- it is a file argument');
  for (const arg of ['--no-sandbox', '-no-sandbox', '--NO-SANDBOX']) assert.deepEqual(unsafeSwitches(['exe', arg], {}, { platform: 'win32' }), [arg]);
  assert.deepEqual(unsafeSwitches(['exe', 'C:\\Users\\a\\x.pdf', '\\\\server\\share\\x.pdf', 'file:///C:/x.pdf'], {}, { platform: 'win32' }), []);
});

test('argv policy: test-only switches and the show flag behave the same on win32', () => {
  assert.deepEqual(unsafeSwitches(['exe', '--remote-debugging-port=0'], {}, { platform: 'win32' }), ['--remote-debugging-port=0']);
  assert.deepEqual(unsafeSwitches(['exe', '--remote-debugging-port=0'], { BENTO_TEST_HEADLESS: '1' }, { platform: 'win32' }), []);
  assert.deepEqual(unsafeSwitches(['exe', '/remote-debugging-port=0'], { BENTO_TEST_HEADLESS: '1' }, { platform: 'win32' }), ['/remote-debugging-port=0']);
  assert.equal(testHeadless({ BENTO_TEST_HEADLESS: '1' }), true);
  assert.equal(testHeadless({ BENTO_TEST_HEADLESS: 'true' }), false);
  assert.equal(testHeadless({}), false);
  assert.equal(looksLikeSwitch(42, 'win32'), false);
});

test('open-with on win32: drive letters, backslashes, forward slashes, file URLs and long-path prefixes become local paths', () => {
  assert.deepEqual(open('C:\\Users\\a\\x.pdf'), ['C:\\Users\\a\\x.pdf']);
  assert.deepEqual(open('c:/Users/a/x.PDF'), ['c:\\Users\\a\\x.PDF']);
  assert.deepEqual(open('file:///C:/Users/a/My%20Doc.pdf'), ['C:\\Users\\a\\My Doc.pdf']);
  assert.deepEqual(open('FILE:///D:/a%23b.pdf'), ['D:\\a#b.pdf']);
  assert.deepEqual(open('\\\\?\\C:\\very\\long\\x.pdf'), ['C:\\very\\long\\x.pdf']);
  assert.deepEqual(open('rel\\y.pdf'), ['C:\\work\\rel\\y.pdf']);
  assert.deepEqual(open('C:\\a\\..\\b\\x.pdf'), ['C:\\b\\x.pdf']);
  const long = `C:\\${'d\\'.repeat(200)}x.pdf`;
  assert.deepEqual(open(long), [long], 'a path past the classic 260 character limit is passed on unchanged');
});

test('open-with on win32: UNC, device namespaces, remote file URLs, streams, reserved names, trailing dots are dropped', () => {
  const hostile = [
    '\\\\server\\share\\x.pdf', '//server/share/x.pdf', '\\\\?\\UNC\\server\\share\\x.pdf', '\\\\.\\C:\\x.pdf', '\\\\?\\GLOBALROOT\\x.pdf',
    'file://server/share/x.pdf', 'file:////server/share/x.pdf', 'file://evil.example/x.pdf',
    'C:x.pdf', 'C:\\a\\x.pdf::$DATA', 'C:\\a\\x.pdf:stream', 'C:\\a\\x.txt:y.pdf', 'C:\\a:b\\x.pdf',
    'C:\\a\\CON.pdf', 'C:\\a\\con', 'C:\\NUL\\x.pdf', 'C:\\a\\Lpt1.pdf', 'C:\\a\\COM9.x.pdf', 'C:\\a\\aux .pdf',
    'C:\\a\\x.pdf.', 'C:\\a\\x.pdf ', 'C:\\a. \\x.pdf', 'C:\\a\\x*.pdf', 'C:\\a\\x?.pdf', 'C:\\a\\<x>.pdf', 'C:\\a\\x\u0001.pdf',
    'https://example.com/x.pdf', 'C:\\a\\x.txt',
  ];
  for (const arg of hostile) assert.deepEqual(open(arg), [], JSON.stringify(arg));
  assert.deepEqual(open('/x.pdf'), [], 'a leading slash is a switch on win32');
  assert.deepEqual(open('/x.pdf', { ...WIN }), []);
});

test('open-with on win32: a bare -- makes slash-leading names file arguments; flags before it are skipped', () => {
  assert.deepEqual(pdfPathsFromArgv(['app.exe', '/flag', '-x', '--', '\\only.pdf', 'C:\\k.pdf'], WIN), ['C:\\only.pdf', 'C:\\k.pdf']);
});

test('windowsPathProblem names the reason', () => {
  assert.equal(windowsPathProblem('C:\\ok\\a b.pdf'), null);
  assert.equal(windowsPathProblem('\\\\h\\s\\a.pdf'), 'UNC or device path');
  assert.equal(windowsPathProblem('C:a.pdf'), 'drive-relative path');
  assert.match(windowsPathProblem('C:\\a.pdf::$DATA'), /alternate data stream/);
  assert.equal(windowsPathProblem('C:\\a\\nul.pdf'), 'reserved device name');
  assert.equal(windowsPathProblem('C:\\a\\b.'), 'trailing dot or space');
});

test('validateOpenPath refuses Windows-hostile paths before touching the file system', async () => {
  for (const bad of ['\\\\server\\share\\x.pdf', 'C:\\a\\x.pdf::$DATA.pdf', 'C:\\a\\CON.pdf']) {
    await assert.rejects(validateOpenPath(bad, 1e6, { platform: 'win32' }), /refused Windows path|network paths are not allowed/, bad);
  }
  // the extended-length prefix of a local drive is stripped before the Windows rules run, so it cannot smuggle a stream or device name
  for (const bad of ['\\\\?\\C:\\a\\x.pdf::$DATA.pdf', '\\\\?\\C:\\a\\NUL.pdf', '\\\\?\\C:\\a\\x.pdf.']) {
    await assert.rejects(validateOpenPath(bad, 1e6, { platform: 'win32' }), /refused Windows path/, bad);
  }
  // validateLocalFile (dialog / recents grants) applies the same rules
  await assert.rejects(validateLocalFile('C:\\a\\CON.png', 1e6, { platform: 'win32' }), /refused Windows path/);
});

test('static files: Windows path-traversal variants are rejected before any file is looked up', async () => {
  const bad = [
    '/..\\..\\secret', '/a\\b.html', '/%5c..%5csecret', '/%2e%2e%5csecret', '/..%5c', '/C:/Windows/win.ini', '/C%3A/Windows/win.ini', '/c:\\x',
    '/index.html::$DATA', '/index.html:stream', '/index.html::%24DATA', '/_headers.', '/_headers%20', '/index.html.', '/index.html%20',
    '/CON', '/con.html', '/NUL', '/nul.txt', '/PRN.js', '/AUX', '/COM1', '/lpt9.css', '/sub/CON/index.html', '/CONIN$', '/_HEADE~1', '/PROGRA~1/x',
    '/a*b', '/a%3Fb', '/a%22b', '/a%3Cb', '/a%7Cb', '/a%01b', '/\\\\server\\share\\x', '/..%2f..%2fsecret', '/%00',
  ];
  for (const urlPath of bad) assert.equal(await resolveFile('/nonexistent-root', urlPath), null, urlPath);
  for (const name of ['CON', 'con.html', 'Nul.txt', 'COM1', 'lpt3.x', 'a:b', 'a.', 'a ', 'x~1', 'q?', 'CONOUT$']) assert.equal(isWindowsUnsafeSegment(name), true, name);
  for (const name of ['index.html', 'console.js', 'com.js', 'communication', 'a.b.c', 'v1.2.3.js', 'x-y_z.wasm', 'com10', 'null.js2', '']) assert.equal(isWindowsUnsafeSegment(name), false, name);
});

test('static files: host-config names are hidden whatever their case (NTFS is case-insensitive)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bento-win-static-')));
  try {
    fs.writeFileSync(path.join(root, '_Headers'), 'secret');
    fs.writeFileSync(path.join(root, 'index.html'), 'ok');
    assert.equal(await resolveFile(root, '/_Headers'), null);
    assert.equal(await resolveFile(root, '/_HEADERS'), null);
    assert.notEqual(await resolveFile(root, '/index.html'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
