'use strict';

// LEGACY SINGLE-WINDOW HARNESS (M2 app, src/app.js startApp; no tabs, no shell UI). Kept on purpose: the
// per-tool scenarios (merge, OCR, LibreOffice, ...) still run in it. The product start path is the tabbed
// shell, covered by shell-e2e.test.js; BENTO_TRANSPORT=http is TEST-ONLY (src/start-mode.js).
// Spawns a real Electron process (one per transport and scenario) against ../dist (needs a display).
// Default --ozone-platform=headless (set BENTO_E2E_OZONE=wayland|x11 for a real window; on the
// dev machine a real window gets no animation frames, which stalls pdf.js rendering).
// BENTO_E2E_TRANSPORTS=scheme,http (default both), BENTO_E2E_SCENARIOS=a,b to narrow.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const electronBinary = require('electron');
const resultsDir = path.join(__dirname, '..', '.test-results');
const transports = (process.env.BENTO_E2E_TRANSPORTS || 'scheme,http').split(',');
const only = process.env.BENTO_E2E_SCENARIOS;
const SCENARIOS = ['isolation', 'transport', 'worker', 'mergeOffline', 'handoff', 'denied', 'serviceWorker', 'crash', 'libreoffice', 'ocr', 'bigPdf'];
const selected = only ? only.split(',') : SCENARIOS;

// One fresh Electron process per scenario: no state or memory leaks between scenarios.
function runElectron(transport, scenario) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const out = path.join(resultsDir, `${transport}-${scenario}.json`);
  fs.rmSync(out, { force: true });
  const run = spawnSync(electronBinary, [`--ozone-platform=${process.env.BENTO_E2E_OZONE || 'headless'}`, path.join(__dirname, 'runner', 'main.js')], {
    env: {
      ...process.env,
      BENTO_TEST_TRANSPORT: transport,
      BENTO_TEST_OUT: out,
      BENTO_TEST_SCENARIOS: scenario,
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
  describe(`single-window harness e2e [${transport}] (test-only, not the shell)`, () => {
    for (const name of selected) {
      it(name, (t) => {
        const report = runElectron(transport, name);
        assert.ok(!report.fatal, report.fatal);
        const result = report.results.find((r) => r.name === name);
        assert.ok(result, `scenario ${name} did not run`);
        t.diagnostic(JSON.stringify(result.detail ?? result.error));
        assert.ok(result.ok, `${result.error} ${JSON.stringify({ consoleErrors: result.consoleErrors, httpErrors: result.httpErrors })}`);
      });
    }
  });
}
