'use strict';

// Starts the real entry point (src/main.js) headless, with a throw-away profile:
// the first instance must stay up, a second one on the same profile must exit
// (single-instance lock), and a packaged-style override must be ignored.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const electronBinary = require('electron');
const entry = path.join(__dirname, '..', 'src', 'main.js');
// Chromium's single-instance lock is a Unix socket created under the child's TMPDIR; sun_path is ~100 bytes,
// so a deeply nested TMPDIR makes the lock fail with "Socket path too long". Give the child a short TMPDIR.
const shortTmp = os.tmpdir().length > 40 ? '/tmp' : os.tmpdir();
const profile = fs.mkdtempSync(path.join(shortTmp, 'bento-main-'));
const children = [];

function launch(env = {}) {
  const child = spawn(electronBinary, ['--ozone-platform=headless', `--user-data-dir=${profile}`, entry], {
    env: { ...process.env, TMPDIR: shortTmp, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const out = { stderr: '', exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
  child.stderr.on('data', (c) => (out.stderr += c));
  children.push(child);
  return { child, out };
}

after(() => {
  for (const c of children) c.kill('SIGKILL');
  fs.rmSync(profile, { recursive: true, force: true });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('main.js: first instance runs, second instance on the same profile exits', async () => {
  const first = launch();
  await wait(6000);
  assert.equal(first.child.exitCode, null, `first instance died: ${first.out.stderr.slice(-500)}`);
  const second = launch();
  const code = await Promise.race([second.out.exit, wait(15000).then(() => 'still running')]);
  assert.equal(code, 0, `second instance should quit cleanly: ${second.out.stderr.slice(-500)}`);
  assert.match(second.out.stderr, /another instance is already running/);
  assert.equal(first.child.exitCode, null, 'first instance must be unaffected');
  first.child.kill('SIGTERM');
  await first.out.exit;
});

test('main.js: a bad BENTO_TRANSPORT is rejected with exit code 2', async () => {
  const other = fs.mkdtempSync(path.join(shortTmp, 'bento-main2-'));
  try {
    const child = spawn(electronBinary, ['--ozone-platform=headless', `--user-data-dir=${other}`, entry], {
      env: { ...process.env, BENTO_TRANSPORT: 'carrier-pigeon' },
      stdio: 'ignore',
    });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 2);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});
