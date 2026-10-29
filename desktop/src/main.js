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

const path = require('node:path');
const { dialog, Menu, shell } = require('electron');
const { prepare, startApp, TRANSPORTS, log } = require('./app');
const brand = require('../brand.json');
const { aboutDetail, buildMenuTemplate, SOURCE_URL } = require('./menu');
const { startShell } = require('./shell/shell-app');
const { buildShellMenuTemplate } = require('./shell/shell-menu');
const { unsafeSwitches } = require('./argv-policy');
const { pdfPathsFromArgv } = require('./open-file');

// Decided by experiment, see docs/m2-findings.md. The tabbed shell (M3a) needs the
// scheme; BENTO_TRANSPORT=http (dev only) still starts the single-window M2 app.
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

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ showAbout, openSource, devtools: !app.isPackaged })));
}

/** Rebuilt when the recent-files list changes (Open Recent submenu). */
let menuRecents = null;
function installShellMenu(menuActions, recents) {
  const key = JSON.stringify(recents);
  if (key === menuRecents) return;
  menuRecents = key;
  const template = buildShellMenuTemplate({ ...menuActions, showAbout, openSource }, { recents, devtools: !app.isPackaged });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const refused = unsafeSwitches(process.argv);
if (refused.length > 0) {
  process.stderr.write(`[bento] refusing to start with unsafe switch(es): ${refused.join(' ')}\n`);
  app.exit(2);
} else if (!TRANSPORTS.includes(transport)) {
  process.stderr.write(`BENTO_TRANSPORT must be one of ${TRANSPORTS.join(', ')}\n`);
  app.exit(2);
} else if (!app.requestSingleInstanceLock()) {
  log('another instance is already running; exiting');
  app.quit();
} else {
  let handle = null;
  const waiting = []; // paths received before the window exists

  // Paths from the OS only; validated again (extension, regular file, size) before a grant is issued.
  const openPaths = (paths) => {
    for (const filePath of paths) {
      if (!handle) {
        waiting.push(filePath);
        continue;
      }
      handle.openPath(filePath).catch((err) => log(`refused to open ${path.basename(filePath)}: ${err.message}`));
    }
  };

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const unsafe = unsafeSwitches(argv, undefined, { secondInstance: true });
    if (unsafe.length > 0) {
      log(`ignored a second launch with unsafe switch(es): ${unsafe.join(' ')}`);
      return;
    }
    const win = handle && handle.window;
    if (win && !win.isDestroyed()) {
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
      if (transport === 'scheme') {
        let menuActions = null;
        const onStateChanged = (state) => menuActions && installShellMenu(menuActions, state.recents);
        const started = await startShell({ distDir, homeTab: waiting.length === 0, onStateChanged });
        menuActions = started.menuActions;
        installShellMenu(menuActions, started.recents.list());
        handle = started;
      } else {
        installMenu();
        handle = await startApp({ distDir, transport });
      }
      openPaths(waiting.splice(0));
    })
    .catch((err) => die('Failed to start', err));
  app.on('window-all-closed', () => app.quit());
}
