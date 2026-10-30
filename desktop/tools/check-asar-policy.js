'use strict';

// Usage: node tools/check-asar-policy.js [--flavour release|smoke] <dir-of-extracted-app.asar>   (default: release)
// Release-gate helper (packaging/verify-artifact.sh, verify-artifact-win.sh). Checks on the code that shipped:
//   0. Build flavour (issue #13). src/build-flavour.js must be the requested flavour's file, byte for byte.
//      release: src/test-mode.js must be the stub flavours/release/test-mode.js byte for byte, and no code token
//      (comments do not count) anywhere under src/ may name a test-only switch, the marker or a test variable.
//      smoke: src/test-mode.js must NOT be the stub (a smoke build without test mode tests nothing).
//   1. process.env is read only on five exact, known lines (found by parsing, so comments never count and a read
//      appended to a known line is a different line text and fails).
//   2. The packaged src/test-mode.js and src/argv-policy.js BEHAVE as designed: run, not grepped.
//      release: no marker, environment or isPackaged value turns test mode on; every test switch is refused.
//      smoke: a marker function that returns true, or an argv policy that ignores the marker, fails here. Real files
//      exercise the host's own branch (POSIX on Linux, win32 on windows-latest); the win32 branch also runs against
//      a fake fs on every host.
// Exits non-zero on the first violated rule. Needs espree (a dependency of eslint) from desktop/node_modules.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fail = (msg) => { process.stderr.write(`FAIL: ${msg}\n`); process.exit(1); };
const args = process.argv.slice(2);
const FLAVOUR = args[0] === '--flavour' ? args[1] : 'release';
const dir = args[0] === '--flavour' ? args[2] : args[0];
if (!dir || !['release', 'smoke'].includes(FLAVOUR)) throw new Error('usage: check-asar-policy.js [--flavour release|smoke] <extracted-asar-dir>');
const src = path.resolve(dir, 'src');
const espree = require('espree');

// ---- 0. build flavour ------------------------------------------------------------------------------------
const FLAVOUR_DIR = path.join(__dirname, '..', 'flavours');
const readOr = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const packed = (name) => readOr(path.join(src, name));
if (packed('build-flavour.js') !== readOr(path.join(FLAVOUR_DIR, FLAVOUR, 'build-flavour.js'))) fail(`build flavour: src/build-flavour.js is not the ${FLAVOUR} flavour file (flavours/${FLAVOUR}/build-flavour.js)`);
if (require(path.join(src, 'build-flavour.js')).flavour !== FLAVOUR) fail(`build flavour: src/build-flavour.js does not say ${FLAVOUR}`);
// Both flavours: the argv policy keeps its own flavour rule (a second layer behind the stub).
for (const needle of ["const TEST_FLAVOURS = new Set(['dev', 'smoke']);", 'return TEST_FLAVOURS.has(flavour) && testHeadless(env) && ']) {
  if (!(packed('argv-policy.js') || '').includes(needle)) fail(`build flavour: argv-policy.js lost the flavour rule: ${needle}`);
}
// DevTools never open in a release build, even when app.isPackaged is false (issue #13).
for (const [file, needle] of [['main.js', 'devtools: !app.isPackaged && flavour !== \'release\''], ['app.js', 'allowDevtools: !app.isPackaged && flavour !== \'release\''], [path.join('shell', 'shell-app.js'), 'allowDevtools: !app.isPackaged && flavour !== \'release\'']]) {
  const text = packed(file) || '';
  if (!text.includes(needle)) fail(`build flavour: src/${file} lost the release DevTools gate: ${needle}`);
}
const isStub = packed('test-mode.js') === readOr(path.join(FLAVOUR_DIR, 'release', 'test-mode.js'));
// Code tokens that exist only for test mode. Comments are not tokens: argv-policy.js may still EXPLAIN the refusal.
const TEST_TOKENS = ['remote-debugging', 'ozone-platform=headless', 'user-data-dir', 'bento-test-mode', 'BENTO_TEST_HEADLESS', 'BENTO_TEST_TRACE_DIR', 'hasTestMarkerWin32'];
if (FLAVOUR === 'release') {
  if (!isStub) fail('build flavour: release src/test-mode.js is not the release stub (flavours/release/test-mode.js)');
  for (const f of fs.readdirSync(src, { recursive: true }).filter((x) => x.endsWith('.js'))) {
    for (const t of espree.tokenize(fs.readFileSync(path.join(src, f), 'utf8'), { ecmaVersion: 'latest', loc: true })) {
      const hit = TEST_TOKENS.find((needle) => t.value.includes(needle));
      if (hit) fail(`build flavour: release src/${f} has test-only code (${hit} in ${t.type} token at line ${t.loc.start.line})`);
    }
  }
  process.stdout.write('ok   release flavour: build-flavour.js says release, test-mode.js is the stub, no test-only token in src/\n');
} else {
  if (isStub) fail('build flavour: smoke src/test-mode.js is the release stub, so the smoke tests could not enter test mode');
  process.stdout.write('ok   smoke flavour: build-flavour.js says smoke, test-mode.js carries the real marker logic\n');
}

// ---- 1. process.env reads --------------------------------------------------------------------------------
const EXEMPT = new Map([
  ['main.js|const sandboxOff = SANDBOX_OFF_ENV.filter((name) => process.env[name]);', 1],
  ["main.js|const overrides = app.isPackaged || flavour === 'release' ? {} : process.env;", 1],
  ['main.js|const testEnv = testModeOn(process.env, policyOptions) ? process.env : null;', 1],
  ['main.js|const refused = unsafeSwitches(process.argv, process.env, policyOptions);', 1],
  ['main.js|const unsafe = unsafeSwitches(argv, process.env, { ...policyOptions, secondInstance: true });', 1],
]);
const isGlobalObject = (n) => n && n.type === 'Identifier' && (n.name === 'globalThis' || n.name === 'global');
// `process`, `globalThis.process` and `global.process` all name the same object.
const isProcess = (n) => n && ((n.type === 'Identifier' && n.name === 'process') ||
  (n.type === 'MemberExpression' && !n.computed && isGlobalObject(n.object) && n.property.name === 'process'));
const isEnvKey = (m) => (!m.computed && m.property.name === 'env') || (m.computed && m.property.type === 'Literal' && m.property.value === 'env');

function envReads(node, out) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'MemberExpression' && isProcess(node.object) && isEnvKey(node)) out.push(node.loc.start.line);
  // `const { env } = process` and `{ env } = process` also read it
  if ((node.type === 'VariableDeclarator' && isProcess(node.init) && node.id.type === 'ObjectPattern') ||
      (node.type === 'AssignmentExpression' && isProcess(node.right) && node.left.type === 'ObjectPattern')) out.push(node.loc.start.line);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => envReads(c, out));
    else if (v && typeof v === 'object') envReads(v, out);
  }
}
const files = fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.js'));
if (files.length < 5) fail(`only ${files.length} .js files under src/: wrong directory?`);
const seen = new Map();
for (const f of files) {
  const text = fs.readFileSync(path.join(src, f), 'utf8');
  const lines = text.split('\n');
  const reads = [];
  envReads(espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script', loc: true }), reads);
  for (const line of new Set(reads)) {
    const key = `${f}|${lines[line - 1].trim()}`;
    seen.set(key, (seen.get(key) || 0) + 1);
    if (!EXEMPT.has(key) || seen.get(key) > EXEMPT.get(key)) fail(`process.env read at src/${f}:${line} is not one of the known guarded lines: ${lines[line - 1].trim()}`);
  }
}
process.stdout.write(`ok   process.env is read only on ${[...seen.values()].reduce((a, b) => a + b, 0)} known lines (comments ignored)\n`);

// ---- 2. behaviour of the shipped marker logic and argv policy --------------------------------------------
// Argv policy, both flavours: a leading "/" is a switch on win32 ONLY (rule dropped -> /no-sandbox slips through; rule widened -> POSIX paths refused).
function argvPlatformChecks(unsafeSwitches, expect) {
  expect('argv policy: /no-sandbox is refused on win32', unsafeSwitches(['exe', '/no-sandbox'], {}, { platform: 'win32' }).length, 1);
  expect('argv policy: /remote-debugging-port=0 is refused on win32', unsafeSwitches(['exe', '/remote-debugging-port=0'], {}, { platform: 'win32' }).length, 1);
  expect('argv policy: a POSIX path is not a switch on linux', unsafeSwitches(['exe', '/home/u/x.pdf'], {}, { platform: 'linux' }).length, 0);
  expect('argv policy: a POSIX path is not a switch on darwin', unsafeSwitches(['exe', '/Users/u/x.pdf'], {}, { platform: 'darwin' }).length, 0);
  expect('argv policy: a drive path is not a switch on win32', unsafeSwitches(['exe', 'C:\\u\\x.pdf', 'plain.pdf'], {}, { platform: 'win32' }).length, 0);
  expect('argv policy: --no-sandbox is refused everywhere', unsafeSwitches(['exe', '--no-sandbox'], {}, { platform: 'linux' }).length, 1);
}

if (FLAVOUR === 'release') {
  const { hasTestMarker } = require(path.join(src, 'test-mode.js'));
  const { unsafeSwitches, testModeOn } = require(path.join(src, 'argv-policy.js'));
  const { MARKER_NAME, MARKER_CONTENT } = require('../src/test-mode'); // the real token: plant a marker the smoke build would accept
  const expect = (name, got, want) => { if (got !== want) fail(`release flavour: ${name} (got ${got}, want ${want})`); };
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bento-gate-')));
  try {
    fs.writeFileSync(path.join(tmp, MARKER_NAME), MARKER_CONTENT, { mode: 0o644 });
    expect('hasTestMarker with a valid marker file', hasTestMarker(tmp), false);
    expect('hasTestMarker with a valid marker file (win32 branch asked for)', hasTestMarker(tmp, { platform: 'win32' }), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true }); // tmp was created by mkdtemp above
  }
  argvPlatformChecks(unsafeSwitches, expect);
  const ENV = { BENTO_TEST_HEADLESS: '1', BENTO_TEST_TRACE_DIR: os.tmpdir() };
  for (const packaged of [false, true]) {
    for (const testMarker of [false, true]) {
      const opts = { packaged, testMarker };
      expect(`testModeOn with env, packaged=${packaged}, marker=${testMarker}`, testModeOn(ENV, opts), false);
      for (const sw of ['--remote-debugging-port=0', '--remote-debugging-pipe', '--ozone-platform=headless', '--user-data-dir=/x']) {
        expect(`${sw} refused with env, packaged=${packaged}, marker=${testMarker}`, unsafeSwitches(['exe', sw], ENV, opts).length, 1);
      }
    }
  }
  process.stdout.write('ok   release flavour: no marker, environment or isPackaged value enables test mode; every test switch is refused\n');
  process.exit(0);
}

const { hasTestMarker, MARKER_NAME, MARKER_CONTENT } = require(path.join(src, 'test-mode.js'));
const { unsafeSwitches } = require(path.join(src, 'argv-policy.js'));
// .native: on Windows the JS realpath keeps 8.3 short names (RUNNER~1), which the win32 marker check refuses.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bento-gate-')));
const aliases = [];
try {
  const marker = path.join(tmp, MARKER_NAME);
  const write = (content = MARKER_CONTENT, mode = 0o644) => { fs.rmSync(marker, { recursive: true, force: true }); fs.writeFileSync(marker, content); fs.chmodSync(marker, mode); };
  const expect = (name, got, want) => { if (got !== want) fail(`packaged marker logic: ${name} (got ${got}, want ${want})`); };

  if (process.platform === 'win32') {
    // win32 host (packaging/verify-artifact-win.sh on windows-latest): the shipped win32 branch on real NTFS files.
    const write = (content = MARKER_CONTENT) => { fs.rmSync(marker, { recursive: true, force: true }); fs.writeFileSync(marker, content); };
    expect('no marker file', hasTestMarker(tmp), false);
    write(); expect('valid marker', hasTestMarker(tmp), true);
    write(MARKER_CONTENT + 'x'); expect('marker with extra bytes', hasTestMarker(tmp), false);
    write(MARKER_CONTENT.replace('v1', 'v2')); expect('marker with a same-length, same-prefix token', hasTestMarker(tmp), false);
    write(); fs.linkSync(marker, path.join(tmp, 'second-name')); expect('hard-linked marker', hasTestMarker(tmp), false);
    fs.unlinkSync(path.join(tmp, 'second-name'));
    write(); fs.renameSync(marker, path.join(tmp, 'real')); fs.symlinkSync(path.join(tmp, 'real'), marker, 'file'); expect('symlinked marker', hasTestMarker(tmp), false);
    fs.rmSync(marker); fs.rmSync(path.join(tmp, 'real'));
    fs.mkdirSync(marker); expect('directory as marker', hasTestMarker(tmp), false); fs.rmdirSync(marker);
    write(); const alias = `${tmp}-junction`; fs.symlinkSync(tmp, alias, 'junction'); aliases.push(alias);
    expect('resources path through a junction', hasTestMarker(alias), false);
    expect('resources path undefined', hasTestMarker(undefined), false);
  } else {
    expect('no marker file', hasTestMarker(tmp), false);
    write(); expect('valid marker', hasTestMarker(tmp), true);
    expect('marker owned by another uid', hasTestMarker(tmp, { uid: process.getuid() + 1 }), false);
    write(MARKER_CONTENT + 'x'); expect('marker with extra bytes', hasTestMarker(tmp), false);
    write('wrong-token-of-the-same-length\n'.slice(0, MARKER_CONTENT.length)); expect('marker with another token', hasTestMarker(tmp), false);
    write(MARKER_CONTENT.replace('v1', 'v2')); expect('marker with a same-length, same-prefix token', hasTestMarker(tmp), false);
    write(MARKER_CONTENT, 0o664); expect('group-writable marker', hasTestMarker(tmp), false);
    write(MARKER_CONTENT, 0o602); expect('world-writable marker', hasTestMarker(tmp), false);
    write(); fs.linkSync(marker, path.join(tmp, 'second-name')); expect('hard-linked marker', hasTestMarker(tmp), false);
    fs.unlinkSync(path.join(tmp, 'second-name'));
    write(); fs.renameSync(marker, path.join(tmp, 'real')); fs.symlinkSync(path.join(tmp, 'real'), marker); expect('symlinked marker', hasTestMarker(tmp), false);
    fs.rmSync(marker); fs.rmSync(path.join(tmp, 'real'));
    fs.mkdirSync(marker); expect('directory as marker', hasTestMarker(tmp), false); fs.rmdirSync(marker);
    write(); const alias = `${tmp}-alias`; fs.symlinkSync(tmp, alias); aliases.push(alias);
    expect('resources path through a symlink', hasTestMarker(alias), false);
    expect('resources path undefined', hasTestMarker(undefined), false);
  }
  // Any host: the shipped win32 branch against a fake fs (one valid case, then one bad fact at a time).
  const winRes = 'C:\\BentoPDF\\resources';
  const winMarker = `${winRes}\\${MARKER_NAME}`;
  // File ids and sizes are BIGINT on win32 (the shipped branch asks for {bigint:true}); overrides must be bigint too.
  const fakeWin = ({ resReal = winRes, markerReal = winMarker, lstat = {}, fstat = {}, token = MARKER_CONTENT } = {}) => {
    const st = { isFile: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n ** 60n, nlink: 1n, size: BigInt(MARKER_CONTENT.length) };
    const fold = (q) => q.toLowerCase();
    const realpathSync = () => { throw new Error('win32 branch must use realpathSync.native'); };
    realpathSync.native = (q) => (fold(q) === fold(winRes) ? resReal : fold(q) === fold(`${resReal}\\${MARKER_NAME}`) ? markerReal : q);
    return {
      constants: { O_RDONLY: 0 }, realpathSync, closeSync: () => {}, openSync: () => 3,
      lstatSync: () => ({ ...st, ...lstat }), fstatSync: () => ({ ...st, ...fstat }), readSync: (_fd, b) => b.write(token),
    };
  };
  const win = (f, res = winRes) => hasTestMarker(res, { fsImpl: f, platform: 'win32' });
  expect('win32 branch: valid marker (fake fs)', win(fakeWin()), true);
  expect('win32 branch: path compare is case-insensitive (resources spelled in upper case)', win(fakeWin(), winRes.toUpperCase()), true);
  expect('win32 branch: path compare is case-insensitive (marker real path in lower case)', win(fakeWin({ markerReal: winMarker.toLowerCase() })), true);
  expect('win32 branch: resources through a junction (fake fs)', win(fakeWin({ resReal: 'D:\\x\\resources', markerReal: `D:\\x\\resources\\${MARKER_NAME}` })), false);
  expect('win32 branch: symlinked marker (fake fs)', win(fakeWin({ lstat: { isSymbolicLink: () => true } })), false);
  expect('win32 branch: marker redirected by a reparse point (fake fs)', win(fakeWin({ markerReal: 'D:\\y\\m' })), false);
  expect('win32 branch: handle has another file id (ino) than the lstat\'ed file (fake fs)', win(fakeWin({ fstat: { ino: 9n } })), false);
  expect('win32 branch: ids differing only beyond 2^53 are different (fake fs)', win(fakeWin({ fstat: { ino: 2n ** 60n + 1n } })), false);
  expect('win32 branch: handle is on another volume (dev) than the lstat\'ed file (fake fs)', win(fakeWin({ fstat: { dev: 9n } })), false);
  expect('win32 branch: handle is not a file (fake fs)', win(fakeWin({ fstat: { isFile: () => false } })), false);
  expect('win32 branch: hard-linked marker (fake fs)', win(fakeWin({ fstat: { nlink: 2n } })), false);
  expect('win32 branch: size larger (fake fs)', win(fakeWin({ fstat: { size: BigInt(MARKER_CONTENT.length + 1) } })), false);
  expect('win32 branch: size smaller (fake fs)', win(fakeWin({ fstat: { size: 0n } })), false);
  expect('win32 branch: another token (fake fs)', win(fakeWin({ token: MARKER_CONTENT.replace('v1', 'v2') })), false);

  // Any host: the shipped POSIX branch against a fake fs, because real files cannot isolate size or isFile.
  const UID = 1000;
  const fakePosix = (over = {}, token = MARKER_CONTENT) => {
    const st = { isFile: () => true, nlink: 1, uid: UID, mode: 0o100644, size: MARKER_CONTENT.length, ...over };
    return { constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 }, realpathSync: (q) => path.resolve(q), openSync: () => 3, fstatSync: () => st, readSync: (_fd, b) => b.write(token), closeSync: () => {} };
  };
  const posix = (f) => hasTestMarker('/opt/app/resources', { fsImpl: f, uid: UID, platform: 'linux' });
  expect('posix branch: valid marker (fake fs)', posix(fakePosix()), true);
  expect('posix branch: not a regular file (fake fs)', posix(fakePosix({ isFile: () => false })), false);
  expect('posix branch: hard link (fake fs)', posix(fakePosix({ nlink: 2 })), false);
  expect('posix branch: foreign owner (fake fs)', posix(fakePosix({ uid: UID + 1 })), false);
  expect('posix branch: group-writable (fake fs)', posix(fakePosix({ mode: 0o100664 })), false);
  expect('posix branch: world-writable (fake fs)', posix(fakePosix({ mode: 0o100602 })), false);
  expect('posix branch: size larger (fake fs)', posix(fakePosix({ size: MARKER_CONTENT.length + 1 })), false);
  expect('posix branch: size smaller (fake fs)', posix(fakePosix({ size: 0 })), false);
  expect('posix branch: another token (fake fs)', posix(fakePosix({}, MARKER_CONTENT.replace('v1', 'v2'))), false);

  argvPlatformChecks(unsafeSwitches, expect);

  const ENV = { BENTO_TEST_HEADLESS: '1' };
  const port = ['exe', '--remote-debugging-port=0'];
  const refused = (env, opts) => unsafeSwitches(port, env, opts).length > 0;
  expect('packaged + env, no marker', refused(ENV, { packaged: true, testMarker: false }), true);
  expect('packaged + env, truthy non-true marker', refused(ENV, { packaged: true, testMarker: 'yes' }), true);
  expect('packaged + env, default options', refused(ENV, { packaged: true }), true);
  expect('packaged + marker, no env', refused({}, { packaged: true, testMarker: true }), true);
  expect('packaged + env + marker (the one allowed combination)', refused(ENV, { packaged: true, testMarker: true }), false);
  expect('unpackaged + env', refused(ENV, { packaged: false }), false);
  expect('no env, no options', refused({}, {}), true);
} finally {
  for (const a of aliases) fs.unlinkSync(a);
  fs.rmSync(tmp, { recursive: true, force: true }); // tmp was created by mkdtemp above
}
process.stdout.write('ok   packaged test-mode marker logic and argv policy behave as designed\n');
