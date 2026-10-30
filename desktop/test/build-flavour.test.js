'use strict';

// Build flavours (issue #13): tools/flavour.js, the release stub of src/test-mode.js and the argv policy's flavour rule.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { FLAVOUR_DIR, SIGNING_ENV, appFiles, flavourOf, nameTag, outputDir } = require('../tools/flavour');
const real = require('../src/test-mode');
const stub = require('../flavours/release/test-mode');
const { unsafeSwitches, testModeOn } = require('../src/argv-policy');

const ENV = { BENTO_TEST_HEADLESS: '1' };
const PORT = ['exe', '--remote-debugging-port=0'];
const refused = (env, opts) => unsafeSwitches(PORT, env, opts).length > 0;

test('BENTO_FLAVOUR: unset or empty is release; smoke; anything else throws', () => {
  assert.equal(flavourOf({}), 'release');
  assert.equal(flavourOf({ BENTO_FLAVOUR: '' }), 'release');
  assert.equal(flavourOf({ BENTO_FLAVOUR: 'release' }), 'release');
  assert.equal(flavourOf({ BENTO_FLAVOUR: 'smoke' }), 'smoke');
  for (const bad of ['dev', 'SMOKE', 'Release', 'smoke ', 'debug']) assert.throws(() => flavourOf({ BENTO_FLAVOUR: bad }), /BENTO_FLAVOUR/);
});

test('a smoke build refuses any signing material in the environment; a release build does not care', () => {
  for (const key of ['CSC_NAME', 'CSC_KEY', 'CSC_INSTALLER_LINK', 'WIN_CSC_NAME', 'CSC_IDENTITY_AUTO_DISCOVERY', 'AZURE_CLIENT_CERTIFICATE_PATH',
    'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_FEDERATED_TOKEN_FILE', 'AZURE_USERNAME', 'AZURE_PASSWORD']) assert.ok(SIGNING_ENV.includes(key), key);
  for (const key of SIGNING_ENV) {
    assert.throws(() => flavourOf({ BENTO_FLAVOUR: 'smoke', [key]: 'x' }), new RegExp(key));
    assert.equal(flavourOf({ [key]: 'x' }), 'release');
  }
  assert.equal(flavourOf({ BENTO_FLAVOUR: 'smoke', CSC_LINK: '' }), 'smoke');
});

test('file list: release packs both flavour files over src/, smoke only the flavour constant', () => {
  const rel = appFiles('release');
  assert.ok(rel.includes('!src/test-mode.js') && rel.includes('!src/build-flavour.js'));
  assert.deepEqual(rel.at(-1), { from: 'flavours/release', to: 'src', filter: ['build-flavour.js', 'test-mode.js'] });
  const smoke = appFiles('smoke');
  assert.ok(!smoke.includes('!src/test-mode.js') && smoke.includes('!src/build-flavour.js'));
  assert.deepEqual(smoke.at(-1), { from: 'flavours/smoke', to: 'src', filter: ['build-flavour.js'] });
  assert.equal(outputDir('release'), 'release');
  assert.equal(outputDir('smoke'), 'release-smoke');
  assert.equal(nameTag('release'), '');
  assert.match(nameTag('smoke'), /SMOKE-ONLY-NOT-FOR-DISTRIBUTION/);
});

test('flavour constants: the committed source says dev, the flavour files say what they are', () => {
  assert.equal(require('../src/build-flavour').flavour, 'dev');
  assert.equal(require(path.join(FLAVOUR_DIR, 'release', 'build-flavour.js')).flavour, 'release');
  assert.equal(require(path.join(FLAVOUR_DIR, 'smoke', 'build-flavour.js')).flavour, 'smoke');
});

test('release stub: same API as the real module (minus the marker constants), and every answer is "no test mode"', () => {
  const realApi = Object.keys(real).filter((k) => !k.startsWith('MARKER_')).sort();
  assert.deepEqual(Object.keys(stub).sort(), realApi);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-stub-'));
  try {
    fs.writeFileSync(path.join(dir, real.MARKER_NAME), real.MARKER_CONTENT, { mode: 0o644 });
    if (process.platform !== 'win32') assert.equal(real.hasTestMarker(dir), true, 'control: the real logic accepts this marker');
    assert.equal(stub.hasTestMarker(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // dir was created by mkdtemp above
  }
  for (const arg of ['--remote-debugging-port=0', '--remote-debugging-pipe', '--ozone-platform=headless', '--user-data-dir=/tmp/x']) {
    assert.equal(real.isTestSwitch(arg), true, arg);
    assert.equal(stub.isTestSwitch(arg), false, arg);
  }
  assert.equal(stub.testHeadless(ENV), false);
  assert.equal(stub.testTraceDir({ ...ENV, BENTO_TEST_TRACE_DIR: '/tmp' }), undefined);
});

test('release stub source has no marker logic and no test-only switch name', () => {
  const text = fs.readFileSync(path.join(FLAVOUR_DIR, 'release', 'test-mode.js'), 'utf8');
  for (const token of ['O_NOFOLLOW', 'getuid', 'bento-test-mode', 'remote-debugging', 'ozone-platform', 'user-data-dir', 'BENTO_TEST', 'require(']) {
    assert.ok(!text.includes(token), token);
  }
});

test('argv policy: the release flavour never enters test mode, whatever isPackaged and the marker say', () => {
  for (const packaged of [false, true]) {
    for (const testMarker of [false, true]) {
      assert.equal(testModeOn(ENV, { packaged, testMarker, flavour: 'release' }), false);
      assert.equal(refused(ENV, { packaged, testMarker, flavour: 'release' }), true, `packaged=${packaged} marker=${testMarker}`);
    }
  }
  // Unknown flavours fail closed; the test flavours keep today's rules.
  assert.equal(refused(ENV, { packaged: false, flavour: 'other' }), true);
  assert.equal(refused(ENV, { packaged: false, flavour: 'dev' }), false);
  assert.equal(refused(ENV, { packaged: true, testMarker: true, flavour: 'smoke' }), false);
  assert.equal(refused(ENV, { packaged: true, testMarker: false, flavour: 'smoke' }), true);
  assert.equal(refused({}, { packaged: false, flavour: 'smoke' }), true);
});

test('a release-flavoured copy of src/ refuses test switches with the default options (as the packaged app does)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-release-src-'));
  try {
    fs.cpSync(path.join(__dirname, '..', 'src'), path.join(dir, 'src'), { recursive: true });
    for (const f of ['build-flavour.js', 'test-mode.js']) fs.copyFileSync(path.join(FLAVOUR_DIR, 'release', f), path.join(dir, 'src', f));
    const policy = require(path.join(dir, 'src', 'argv-policy.js'));
    assert.equal(policy.unsafeSwitches(PORT, ENV, { packaged: false }).length, 1, 'unpackaged-looking (renamed executable)');
    assert.equal(policy.unsafeSwitches(PORT, ENV, { packaged: true, testMarker: true }).length, 1, 'packaged with a marker');
    assert.equal(policy.unsafeSwitches(['exe', '--ozone-platform-hint=auto'], ENV, { packaged: false }).length, 0, 'normal switches still pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // dir was created by mkdtemp above
  }
});
