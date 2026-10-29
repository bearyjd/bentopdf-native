'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { buildAppHeaders } = require('./headers');
const { installFailureHandlers } = require('./failure');
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
  // .native: the JS realpath keeps 8.3 short names (RUNNER~1) on Windows, which would never match the
  // canonical paths fs.promises.realpath returns for files inside the root.
  const rootReal = fs.realpathSync.native(distDir);
  if (!fs.existsSync(path.join(rootReal, 'index.html'))) {
    throw new Error(`${rootReal} does not look like a BentoPDF bundle (no index.html)`);
  }
  const headers = buildAppHeaders(rootReal);
  const transportHandle =
    transport === 'scheme'
      ? startSchemeTransport({ rootReal, headers })
      : await startHttpTransport({ rootReal, headers });
  const { origin } = transportHandle;

  if (transportHandle.cookie) await session.defaultSession.cookies.set(transportHandle.cookie);

  const blocked = [];
  const permissionDecisions = [];
  const extraAllowed = new Set();
  lockSession(
    session.defaultSession,
    origin,
    (url) => {
      blocked.push(url);
      log(`blocked request: ${url}`);
      onBlocked(url);
    },
    {
      allowDevtools: !app.isPackaged,
      extraAllowed,
      onPermission: (decision) => {
        permissionDecisions.push(decision);
        log(`permission ${decision.kind} ${decision.permission}: ${decision.granted ? 'GRANTED' : 'denied'}`);
      },
    }
  );
  lockWebContents({ origin, log });

  let win = null;
  const disposeIpc = registerIpc({ ipcMain, origin, dialogs, getWindow: () => win });

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { ...secureWebPreferences(PRELOAD), backgroundThrottling: false },
  });
  installFailureHandlers(win, log, (url) => extraAllowed.add(url));
  if (show) win.once('ready-to-show', () => win.show());
  await win.loadURL(options.url ? `${origin}${options.url}` : `${origin}/index.html`);

  return {
    origin,
    rootReal,
    window: win,
    openPath: (filePath) => disposeIpc.openPath(win.webContents, filePath),
    blocked,
    permissionDecisions,
    close: async () => {
      disposeIpc();
      if (!win.isDestroyed()) win.destroy();
      await transportHandle.close();
    },
  };
}

module.exports = { prepare, startApp, TRANSPORTS, app, log };
