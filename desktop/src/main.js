'use strict';

const path = require('node:path');
const { app } = require('electron');
const { prepare, startApp, TRANSPORTS, log } = require('./app');

// Decided by experiment, see docs/m2-findings.md.
const DEFAULT_TRANSPORT = 'scheme';

// Dev overrides only: a packaged app must not be redirected by its environment.
const overrides = app.isPackaged ? {} : process.env;
const distDir = overrides.BENTO_DIST || path.resolve(__dirname, '..', '..', 'dist');
const transport = overrides.BENTO_TRANSPORT || DEFAULT_TRANSPORT;

const die = (what, err) => {
  process.stderr.write(`[bento] ${what}: ${(err && err.stack) || err}\n`);
  app.exit(1);
};
process.on('uncaughtException', (err) => die('uncaughtException', err));
process.on('unhandledRejection', (err) => die('unhandledRejection', err));

if (!TRANSPORTS.includes(transport)) {
  process.stderr.write(`BENTO_TRANSPORT must be one of ${TRANSPORTS.join(', ')}\n`);
  app.exit(2);
} else if (!app.requestSingleInstanceLock()) {
  log('another instance is already running; exiting');
  app.quit();
} else {
  let handle = null;
  app.on('second-instance', () => {
    const win = handle && handle.window;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  prepare();
  app
    .whenReady()
    .then(async () => {
      handle = await startApp({ distDir, transport });
    })
    .catch((err) => die('Failed to start', err));
  app.on('window-all-closed', () => app.quit());
}
