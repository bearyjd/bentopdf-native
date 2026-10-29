'use strict';

// Run with: electron --ozone-platform=headless test/runner/shell-main.js
// (env: BENTO_TEST_OUT, BENTO_TEST_SCENARIOS=<one name>). Starts the tabbed shell (M3a),
// runs that scenario from scenarios-shell.js, writes a JSON result file.
// Never exits non-zero because a scenario failed (test/shell-e2e.test.js judges).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-shell-userdata-'));
app.setPath('userData', tmpUser);
app.commandLine.appendSwitch('disable-dev-shm-usage');

const { prepare } = require('../../src/app');
const { startShell } = require('../../src/shell/shell-app');
const scenarios = require('./scenarios-shell');

const outFile = process.env.BENTO_TEST_OUT;
// One scenario per process: a shell registers its partitions' protocol handlers once.
const name = process.env.BENTO_TEST_SCENARIOS;
const distDir = process.env.BENTO_DIST || path.resolve(__dirname, '..', '..', '..', 'dist');

prepare();

async function runOne(name) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-shell-work-'));
  const dialogState = { next: [] };
  const requests = [];
  const handle = await startShell({
    distDir,
    show: false,
    homeTab: false,
    maxLive: scenarios[name].maxLive,
    dialogs: {
      showOpenDialog: async () => ({ canceled: false, filePaths: dialogState.next }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    // Observe every request of every partition (the shell's and each tab's).
    onSession: (ses, partition) => {
      ses.webRequest.onCompleted((d) => requests.push({ partition, url: d.url, status: d.statusCode }));
      ses.webRequest.onErrorOccurred((d) => requests.push({ partition, url: d.url, error: d.error }));
    },
  });
  const started = Date.now();
  try {
    const detail = await scenarios[name]({ handle, workDir, dialogState, requests });
    return { name, ok: true, ms: Date.now() - started, detail };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, error: String(err.message || err), blocked: handle.blocked.slice(-6) };
  } finally {
    await handle.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  let payload;
  try {
    if (!Object.hasOwn(scenarios, name)) throw new Error(`unknown scenario ${name}`);
    payload = { electron: process.versions.electron, results: [await runOne(name)] };
  } catch (err) {
    payload = { fatal: String(err.stack || err) };
  }
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  fs.rmSync(tmpUser, { recursive: true, force: true });
  app.exit(0);
});
