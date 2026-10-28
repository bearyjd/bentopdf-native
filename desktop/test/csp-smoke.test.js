'use strict';

// Loads every top-level bundle page (and runs script-source probes) in headless Electron on the
// scheme transport; fails on any CSP violation not in test/csp-smoke/allowlist.json.
// Needs dist/ (skipped without it). ~90 s.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const electronBinary = require('electron');

const dist = process.env.BENTO_DIST || path.resolve(__dirname, '..', '..', 'dist');
const allowlist = JSON.parse(fs.readFileSync(path.join(__dirname, 'csp-smoke', 'allowlist.json'), 'utf8')).entries;

const matches = (entry, v) =>
  (entry.page === '*' || entry.page === v.page) &&
  (!entry.directive || (v.directive || '').includes(entry.directive)) &&
  (!entry.blocked || (v.blocked || '').includes(entry.blocked));

test('csp-smoke allowlist entries all carry a reason', () => {
  for (const entry of allowlist) assert.ok(typeof entry.reason === 'string' && entry.reason.length >= 10, JSON.stringify(entry));
});

test('every bundle page loads without CSP violations; script-source probes work', { skip: !fs.existsSync(path.join(dist, 'index.html')) && 'no dist' }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bento-csp-')), 'result.json');
  const run = spawnSync(electronBinary, [`--ozone-platform=${process.env.BENTO_E2E_OZONE || 'headless'}`, path.join(__dirname, 'csp-smoke', 'main.js')], {
    env: { ...process.env, BENTO_TEST_OUT: out, BENTO_DIST: dist },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  assert.ok(fs.existsSync(out), `no result (status ${run.status}): ${(run.stderr || '').slice(-600)}`);
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(!report.fatal, report.fatal);
  assert.ok(report.pages.length >= 100, `only ${report.pages.length} pages found`);
  assert.deepEqual(report.loadErrors, []);
  const unexpected = report.violations.filter((v) => !allowlist.some((entry) => matches(entry, v)));
  assert.deepEqual(unexpected, [], 'CSP violations outside the allowlist');
  const stale = allowlist.filter((entry) => !report.violations.some((v) => matches(entry, v)));
  assert.deepEqual(stale, [], 'allowlist entries that matched nothing');
  for (const probe of report.probeResults) assert.ok(probe.ok, `probe ${probe.name}: ${probe.error}`);
  assert.ok(report.probeResults.length >= 1);
});
