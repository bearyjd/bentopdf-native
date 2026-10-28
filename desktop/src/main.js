'use strict';

const path = require('node:path');
const { app } = require('electron');
const { prepare, startApp, TRANSPORTS } = require('./app');

// Decided by experiment, see docs/m2-findings.md.
const DEFAULT_TRANSPORT = 'scheme';

const distDir = process.env.BENTO_DIST || path.resolve(__dirname, '..', '..', 'dist');
const transport = process.env.BENTO_TRANSPORT || DEFAULT_TRANSPORT;

if (!TRANSPORTS.includes(transport)) {
  process.stderr.write(`BENTO_TRANSPORT must be one of ${TRANSPORTS.join(', ')}\n`);
  app.exit(2);
} else {
  prepare();
  app
    .whenReady()
    .then(() => startApp({ distDir, transport }))
    .catch((err) => {
      process.stderr.write(`Failed to start: ${err.message}\n`);
      app.exit(1);
    });
  app.on('window-all-closed', () => app.quit());
}
