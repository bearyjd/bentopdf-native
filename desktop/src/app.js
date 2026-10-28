'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { buildAppHeaders } = require('./headers');
const { registerIpc } = require('./ipc');
const { lockSession, lockWebContents, secureWebPreferences } = require('./security');
const { registerScheme, startSchemeTransport } = require('./transport-scheme');
const { startHttpTransport } = require('./transport-http');

const TRANSPORTS = Object.freeze(['scheme', 'http']);
const PRELOAD = path.join(__dirname, 'preload.js');

const log = (message) => process.stderr.write(`[bento] ${message}\n`);

/** Call before app 'ready' (privileged schemes must be registered early). */
function prepare(options = {}) {
  registerScheme(options);
}

/**
 * @param {{distDir: string, transport: 'scheme'|'http', onBlocked?: (url: string) => void,
 *          show?: boolean, dialogs?: object, url?: string}} options
 */
async function startApp(options) {
  const { distDir, transport, onBlocked = () => {}, show = true, dialogs = dialog } = options;
  if (!TRANSPORTS.includes(transport)) throw new Error(`unknown transport: ${transport}`);
  const rootReal = fs.realpathSync(distDir);
  if (!fs.existsSync(path.join(rootReal, 'index.html'))) {
    throw new Error(`${rootReal} does not look like a BentoPDF bundle (no index.html)`);
  }
  const headers = buildAppHeaders(rootReal);
  const transportHandle =
    transport === 'scheme'
      ? startSchemeTransport({ rootReal, headers })
      : await startHttpTransport({ rootReal, headers });
  const { origin } = transportHandle;

  const blocked = [];
  lockSession(session.defaultSession, origin, (url) => {
    blocked.push(url);
    log(`blocked request: ${url}`);
    onBlocked(url);
  });
  lockWebContents({ origin, log });

  let win = null;
  const disposeIpc = registerIpc({ ipcMain, origin, dialogs, getWindow: () => win });

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { ...secureWebPreferences(PRELOAD), backgroundThrottling: false },
  });
  if (show) win.once('ready-to-show', () => win.show());
  await win.loadURL(options.url ? `${origin}${options.url}` : `${origin}/index.html`);

  return {
    origin,
    rootReal,
    window: win,
    blocked,
    close: async () => {
      disposeIpc();
      if (!win.isDestroyed()) win.destroy();
      await transportHandle.close();
    },
  };
}

module.exports = { prepare, startApp, TRANSPORTS, app };
