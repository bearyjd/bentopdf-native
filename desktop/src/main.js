'use strict';

// Must stay first: refuse to start when the environment asks for the sandbox to be
// off. Chromium reads these before any JavaScript runs, so this is a fail-closed
// tripwire (no window, no renderer is ever created); the launchers also unset them.
const { app } = require('electron');
const SANDBOX_OFF_ENV = ['ELECTRON_DISABLE_SANDBOX', 'CHROME_DEVEL_SANDBOX'];
const sandboxOff = SANDBOX_OFF_ENV.filter((name) => process.env[name]);
if (sandboxOff.length > 0) {
  process.stderr.write(`[bento] refusing to start: ${sandboxOff.join(', ')} would weaken the sandbox. Unset it and start again.\n`);
  app.exit(2);
  process.exit(2);
}

const fs = require('node:fs');
const path = require('node:path');
const { dialog, Menu, shell } = require('electron');
const { prepare, startApp, TRANSPORTS, log } = require('./app');
const brand = require('../brand.json');
const { aboutDetail, buildMenuTemplate, SOURCE_URL } = require('./menu');
const { testHeadless, testTraceDir, unsafeSwitches } = require('./argv-policy');
const { pdfPathsFromArgv } = require('./open-file');

// Decided by experiment, see docs/m2-findings.md.
const DEFAULT_TRANSPORT = 'scheme';

// Dev overrides only: a packaged app must not be redirected by its environment.
// Packaged, the bundle is an extraResource outside app.asar (docs/desktop-linux.md).
const overrides = app.isPackaged ? {} : process.env;
const distDir =
  overrides.BENTO_DIST ||
  (app.isPackaged ? path.join(process.resourcesPath, 'dist') : path.resolve(__dirname, '..', '..', 'dist'));
const transport = overrides.BENTO_TRANSPORT || DEFAULT_TRANSPORT;

const die = (what, err) => {
  process.stderr.write(`[bento] ${what}: ${(err && err.stack) || err}\n`);
  app.exit(1);
};
process.on('uncaughtException', (err) => die('uncaughtException', err));
process.on('unhandledRejection', (err) => die('unhandledRejection', err));

// Test mode only: OS-level sandbox state of every Chromium process (Electron's
// ProcessMetric.sandboxed / integrityLevel are reported on Windows and macOS), written next to the
// profile and to stderr so the packaged smoke test can read it even when the launcher swallows stderr.
function logProcessSandbox() {
  const processes = app.getAppMetrics().map(({ type, sandboxed, integrityLevel }) => ({ type, sandboxed, integrityLevel }));
  const json = JSON.stringify(processes);
  process.stderr.write(`[bento-test] process-sandbox ${json}\n`);
  fs.writeFileSync(path.join(app.getPath('userData'), 'bento-test-sandbox.json'), json);
}

// Test mode only: append-and-flush events next to the profile. stderr from a process that exits right
// after writing can be lost on Windows pipes, and the second-instance smoke needs both sides' events.
function testLog(message) {
  if (!testHeadless()) return;
  fs.appendFileSync(path.join(app.getPath('userData'), 'bento-test-events.log'), `${process.pid} ${message}\n`);
}

// Test mode only, and only when the harness names a directory: one trace file per process, flushed on
// every line, so a process that dies early (the second instance) still leaves evidence behind.
function trace(message) {
  const dir = testTraceDir();
  if (!dir) return;
  try {
    fs.appendFileSync(path.join(dir, `trace-${process.pid}.log`), `${Date.now()} ${message}\n`);
  } catch (err) {
    process.stderr.write(`[bento-test] trace failed: ${err.message}\n`);
  }
}
trace(`start pid=${process.pid} ppid=${process.ppid} exec=${process.execPath} argv=${JSON.stringify(process.argv)} userData=${app.getPath('userData')}`);
process.on('exit', (code) => trace(`process exit code=${code}`));

function installMenu() {
  const showAbout = () =>
    dialog.showMessageBox({
      type: 'info',
      title: `About ${brand.productName}`,
      message: `${brand.productName} ${app.getVersion()}`,
      detail: aboutDetail(),
      buttons: ['OK', 'Open source code'],
      defaultId: 0,
      noLink: true,
    }).then(({ response }) => (response === 1 ? shell.openExternal(SOURCE_URL) : undefined));
  const openSource = () => shell.openExternal(SOURCE_URL);
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ showAbout, openSource, devtools: !app.isPackaged })));
}

const refused = unsafeSwitches(process.argv);
trace(`unsafeSwitches=${JSON.stringify(refused)}`);
if (refused.length > 0) {
  process.stderr.write(`[bento] refusing to start with unsafe switch(es): ${refused.join(' ')}\n`);
  app.exit(2);
} else if (!TRANSPORTS.includes(transport)) {
  process.stderr.write(`BENTO_TRANSPORT must be one of ${TRANSPORTS.join(', ')}\n`);
  app.exit(2);
} else if (!(trace('requesting single-instance lock'), app.requestSingleInstanceLock())) {
  trace('lock DENIED (this is the second instance)');
  log('another instance is already running; exiting');
  testLog('lock denied: this is the second instance, exiting');
  app.quit();
} else {
  trace('lock GRANTED (this is the first instance)');
  let handle = null;
  const waiting = []; // paths received before the window exists

  // Paths from the OS only; validated again (extension, regular file, size) before a grant is issued.
  const openPaths = (paths) => {
    for (const filePath of paths) {
      if (!handle) {
        waiting.push(filePath);
        continue;
      }
      handle.openPath(filePath).then(
        () => testLog(`granted ${path.basename(filePath)}`),
        (err) => { log(`refused to open ${path.basename(filePath)}: ${err.message}`); testLog(`refused ${path.basename(filePath)}: ${err.message}`); }
      );
    }
  };

  app.on('second-instance', (_event, argv, workingDirectory) => {
    trace(`second-instance event argv=${JSON.stringify(argv)} cwd=${workingDirectory}`);
    testLog(`second-instance argv=${JSON.stringify(argv)} cwd=${workingDirectory}`);
    const unsafe = unsafeSwitches(argv, undefined, { secondInstance: true });
    if (unsafe.length > 0) {
      log(`ignored a second launch with unsafe switch(es): ${unsafe.join(' ')}`);
      testLog(`ignored second launch: ${unsafe.join(' ')}`);
      return;
    }
    const win = handle && handle.window;
    if (win && !win.isDestroyed() && !testHeadless()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    openPaths(pdfPathsFromArgv(argv, { cwd: workingDirectory, defaultApp: process.defaultApp }));
  });
  // macOS delivers "open with" here; harmless elsewhere.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    openPaths(pdfPathsFromArgv(['', filePath]));
  });
  waiting.push(...pdfPathsFromArgv(process.argv, { defaultApp: process.defaultApp }));

  prepare();
  app
    .whenReady()
    .then(async () => {
      installMenu();
      // Test mode (BENTO_TEST_HEADLESS=1, see argv-policy.js): the window is created hidden and never shown,
      // so CI runners and developers see nothing on screen. Production launches never set it.
      handle = await startApp({ distDir, transport, show: !testHeadless() });
      if (testHeadless()) logProcessSandbox();
      openPaths(waiting.splice(0));
    })
    .catch((err) => die('Failed to start', err));
  app.on('window-all-closed', () => app.quit());
}
