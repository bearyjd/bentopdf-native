'use strict';

// Run with: electron test/runner/main.js  (env: BENTO_TEST_TRANSPORT, BENTO_TEST_OUT,
// BENTO_TEST_SCENARIOS, BENTO_TEST_SHOW). Writes a JSON result file; never exits non-zero
// because a scenario failed (the node:test wrapper judges the results).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-userdata-'));
app.setPath('userData', tmpUser);
app.commandLine.appendSwitch('disable-dev-shm-usage');

const { prepare, startApp } = require('../../src/app');
const { createContext } = require('./context');
const core = require('./scenarios-core');
const heavy = require('./scenarios-heavy');
const page = require('./scenarios-page');

const ALL = { ...core, ...page, ...heavy };
const transport = process.env.BENTO_TEST_TRANSPORT || 'scheme';
const outFile = process.env.BENTO_TEST_OUT;
const names = (process.env.BENTO_TEST_SCENARIOS || Object.keys(ALL).join(',')).split(',');
const distDir = process.env.BENTO_DIST || path.resolve(__dirname, '..', '..', '..', 'dist');

prepare({ allowServiceWorkers: process.env.BENTO_TEST_SW === '1' });

async function runAll() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-work-'));
  const dialogState = { next: [] };
  const dialogs = {
    showOpenDialog: async () => ({ canceled: false, filePaths: dialogState.next }),
    showSaveDialog: async () => ({ canceled: true }),
  };
  const results = [];
  const appHandle = await startApp({
    distDir,
    transport,
    show: process.env.BENTO_TEST_SHOW !== '0',
    dialogs,
    url: '/index.html',
  });
  const ctx = createContext({ app: appHandle, workDir, dialogState, transport });
  for (const name of names) {
    const started = Date.now();
    try {
      const detail = await ALL[name](ctx);
      results.push({ name, ok: true, ms: Date.now() - started, detail });
    } catch (err) {
      results.push({ name, ok: false, ms: Date.now() - started, error: String(err.message || err), consoleErrors: ctx.events.consoleErrors.slice(-6), httpErrors: ctx.events.httpErrors.slice(-6) });
    }
  }
  await appHandle.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  return results;
}

app.whenReady().then(async () => {
  let payload;
  try {
    payload = { transport, electron: process.versions.electron, chrome: process.versions.chrome, results: await runAll() };
  } catch (err) {
    payload = { transport, fatal: String(err.stack || err) };
  }
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  fs.rmSync(tmpUser, { recursive: true, force: true });
  app.exit(0);
});
