'use strict';

// Real-Electron e2e of the tabbed shell (M3a): one headless Electron process per
// scenario (test/runner/shell-main.js), scheme transport only (the shell does not
// support the loopback transport). BENTO_E2E_SCENARIOS=shellTabs,... to narrow;
// names that are not shell scenarios are ignored here.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const electronBinary = require('electron');
const resultsDir = path.join(__dirname, '..', '.test-results');
const SCENARIOS = ['shellTabs', 'shellHandoff', 'shellHandoffError', 'shellMemcap', 'shellIpcReject', 'shellLifecycle', 'shellTeardown'];
const only = process.env.BENTO_E2E_SCENARIOS;
const selected = only ? SCENARIOS.filter((s) => only.split(',').includes(s)) : SCENARIOS;
const enabled = (process.env.BENTO_E2E_TRANSPORTS || 'scheme').split(',').includes('scheme');

function runShell(scenario) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const out = path.join(resultsDir, `shell-${scenario}.json`);
  fs.rmSync(out, { force: true });
  const run = spawnSync(electronBinary, [`--ozone-platform=${process.env.BENTO_E2E_OZONE || 'headless'}`, path.join(__dirname, 'runner', 'shell-main.js')], {
    env: { ...process.env, BENTO_TEST_OUT: out, BENTO_TEST_SCENARIOS: scenario },
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });
  if (!fs.existsSync(out)) throw new Error(`electron produced no result file (status ${run.status}): ${(run.stderr || '').slice(-800)}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

describe('shell e2e [scheme]', { skip: !enabled }, () => {
  for (const name of selected) {
    it(name, (t) => {
      const report = runShell(name);
      assert.ok(!report.fatal, report.fatal);
      const [result] = report.results;
      t.diagnostic(JSON.stringify(result.detail ?? result.error).slice(0, 2000));
      assert.ok(result.ok, `${result.error} ${JSON.stringify(result.blocked || [])}`);
    });
  }
});
