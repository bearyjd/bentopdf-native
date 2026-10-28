'use strict';

// Spawns a real Electron window per transport against ../dist (needs a display).
// Default --ozone-platform=headless (set BENTO_E2E_OZONE=wayland|x11 for a real window; on the
// dev machine a real window gets no animation frames, which stalls pdf.js rendering).
// BENTO_E2E_TRANSPORTS=scheme,http (default both), BENTO_E2E_SCENARIOS=a,b to narrow.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before } = require('node:test');

const electronBinary = require('electron');
const resultsDir = path.join(__dirname, '..', '.test-results');
const transports = (process.env.BENTO_E2E_TRANSPORTS || 'scheme,http').split(',');
const only = process.env.BENTO_E2E_SCENARIOS;
const SCENARIOS = ['isolation', 'transport', 'worker', 'mergeOffline', 'handoff', 'denied', 'serviceWorker', 'libreoffice', 'ocr', 'bigPdf'];
const selected = only ? only.split(',') : SCENARIOS;

function runElectron(transport) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const out = path.join(resultsDir, `${transport}.json`);
  fs.rmSync(out, { force: true });
  const run = spawnSync(electronBinary, [`--ozone-platform=${process.env.BENTO_E2E_OZONE || 'headless'}`, path.join(__dirname, 'runner', 'main.js')], {
    env: {
      ...process.env,
      BENTO_TEST_TRANSPORT: transport,
      BENTO_TEST_OUT: out,
      BENTO_TEST_SCENARIOS: selected.join(','),
    },
    encoding: 'utf8',
    timeout: 25 * 60 * 1000,
  });
  if (!fs.existsSync(out)) {
    throw new Error(`electron produced no result file (status ${run.status}): ${(run.stderr || '').slice(-800)}`);
  }
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

for (const transport of transports) {
  describe(`electron e2e [${transport}]`, () => {
    let report;
    before(() => {
      report = runElectron(transport);
      assert.ok(!report.fatal, report.fatal);
    });

    for (const name of selected) {
      it(name, (t) => {
        const result = report.results.find((r) => r.name === name);
        assert.ok(result, `scenario ${name} did not run`);
        t.diagnostic(JSON.stringify(result.detail ?? result.error));
        assert.ok(result.ok, result.error);
        if (name === 'serviceWorker') {
          const statuses = Object.entries(result.detail.afterReload).filter(([key]) => key !== 'controlled');
          assert.ok(statuses.every(([, status]) => status === 200), `assets must load after SW takes over: ${JSON.stringify(result.detail.afterReload)}`);
          if (transport === 'http') assert.equal(result.detail.manual, true, 'sw.js registers over loopback http');
        }
      });
    }
  });
}
