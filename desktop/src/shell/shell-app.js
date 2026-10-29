'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { buildAppHeaders } = require('../headers');
const { installFailureHandlers } = require('../failure');
const { registerIpc } = require('../ipc');
const { lockSession, lockWebContents, secureWebPreferences } = require('../security');
const { createDocumentStore } = require('./document-store');
const { createRecents } = require('./recents');
const { buildToolRegistry } = require('./tool-registry');
const { createTabManager } = require('./tab-manager');
const { createViewAdapter } = require('./tab-views');
const { prepareSession, SHELL_HEADERS, SHELL_HOST } = require('./sessions');
const { registerShellIpc } = require('./shell-ipc');
const { SHELL_CHANNELS } = require('./shell-channels');
const { adapterFor, handoffScript } = require('./handoff');

const APP_ORIGIN = 'bento://app';
const SHELL_PARTITION = 'bento-shell'; // in-memory, like every tab partition
const SHELL_PRELOAD = path.join(__dirname, 'shell-preload.js');
const UI_DIR = path.join(__dirname, 'ui');

const log = (message) => process.stderr.write(`[bento] ${message}\n`);

/**
 * The tabbed shell (M3a): one BrowserWindow whose own WebContents is the shell
 * UI (bento://shell, partition `bento-shell`, shell preload), plus one
 * WebContentsView per tab (bento://app tool pages, partition `bento-tab-<id>`,
 * M2 tool preload). Scheme transport only.
 * @param {{distDir: string, dialogs?: object, show?: boolean, maxLive?: number, homeTab?: boolean,
 *          recentsFile?: string, onSession?: (ses: object, partition: string) => void,
 *          onStateChanged?: (state: object) => void}} options
 */
async function startShell(options) {
  const { distDir, dialogs = dialog, show = true, maxLive, homeTab = true, onSession = () => {}, onStateChanged = () => {} } = options;
  const rootReal = fs.realpathSync(distDir);
  if (!fs.existsSync(path.join(rootReal, 'index.html'))) throw new Error(`${rootReal} does not look like a BentoPDF bundle (no index.html)`);
  const headers = buildAppHeaders(rootReal);
  const registry = buildToolRegistry(rootReal);
  const store = createDocumentStore();
  const recents = createRecents({
    file: options.recentsFile || path.join(app.getPath('userData'), 'recents.json'),
    onError: (err) => log(`recents: ${err.message}`),
  });

  const blocked = [];
  const permissionDecisions = [];
  const handoffs = [];
  const extraAllowed = new Set();
  const prepared = new WeakSet();
  const observers = (partition) => ({
    allowDevtools: !app.isPackaged,
    extraAllowed,
    onBlocked: (url) => {
      blocked.push({ partition, url });
      log(`blocked request (${partition}): ${url}`);
    },
    onPermission: (decision) => {
      permissionDecisions.push({ ...decision, partition });
      log(`permission ${decision.kind} ${decision.permission} (${partition}): ${decision.granted ? 'GRANTED' : 'denied'}`);
    },
  });
  const prepare = (ses, partition, { host = 'app', root = rootReal, hdrs = headers } = {}) => {
    const origin = prepareSession(ses, { prepared, rootReal: root, headers: hdrs, host, ...observers(partition) });
    onSession(ses, partition);
    return origin;
  };

  // Nothing of the shell loads in the default session, but anything that ever did must
  // still be locked (deny permissions, cancel non-app requests), as in the M2 app.
  const defaultObservers = observers('default');
  lockSession(session.defaultSession, APP_ORIGIN, defaultObservers.onBlocked, defaultObservers);
  const shellOrigin = prepare(session.fromPartition(SHELL_PARTITION), SHELL_PARTITION, { host: SHELL_HOST, root: fs.realpathSync(UI_DIR), hdrs: SHELL_HEADERS });
  let win = null;
  let shellId = null;
  lockWebContents({ origin: APP_ORIGIN, log, originFor: (contents) => (contents.id === shellId ? shellOrigin : APP_ORIGIN) });
  const toolIpc = registerIpc({ ipcMain, origin: APP_ORIGIN, dialogs, getWindow: () => win });

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { ...secureWebPreferences(SHELL_PRELOAD), partition: SHELL_PARTITION, backgroundThrottling: false },
  });
  shellId = win.webContents.id;
  installFailureHandlers(win, log, (url) => extraAllowed.add(url));

  const toolIdOfPage = (page) => {
    const id = page.replace(/^\//, '').replace(/\.html$/, '');
    return registry.has(id) ? id : null;
  };

  /** Hand the tab's document to its tool page through the M2 grant + preload path. */
  async function handoff(tab, view) {
    const doc = tab.docId && tab.toolId ? store.get(tab.docId) : undefined;
    if (!doc) return;
    const wc = view.webContents;
    const entry = doc.bytes
      ? toolIpc.grantBytes(wc, doc.name, doc.bytes)
      : await toolIpc.grantPath(wc, doc.filePath, { dev: doc.dev, ino: doc.ino });
    const count = await wc.executeJavaScript(handoffScript([entry], adapterFor(tab.toolId)), true);
    store.touch(doc.id);
    handoffs.push(Object.freeze({ tabId: tab.id, toolId: tab.toolId, docId: doc.id, count }));
  }

  let tabs = null;
  const state = () => ({
    activeTabId: tabs.activeId(),
    tabs: tabs.list().map((t) => ({
      id: t.id,
      toolId: t.toolId,
      toolName: t.toolId ? registry.get(t.toolId).name : null,
      docId: t.docId,
      docName: (t.docId && store.has(t.docId) && store.get(t.docId).name) || null,
      active: t.active,
      live: t.live,
    })),
    docs: store.list(),
    recents: recents.list(),
  });
  const pushState = () => {
    const current = state();
    if (!win.isDestroyed()) win.webContents.send(SHELL_CHANNELS.stateChanged, current);
    onStateChanged(current);
  };

  const views = createViewAdapter({
    win,
    origin: APP_ORIGIN,
    prepare: (ses, partition) => prepare(ses, partition),
    log,
    allowUrl: (url) => extraAllowed.add(url),
    onNavigated: (id, page) => tabs.recordPage(id, page, toolIdOfPage(page)),
  });
  tabs = createTabManager({
    views,
    maxLive,
    onLoaded: handoff,
    onChange: pushState,
    onError: (err, tab) => log(`tab ${tab.id}: ${err.message}`),
  });

  /** A path from the OS, a dialog or recents: validated by the store, then shown in a tab. */
  async function openDocument(filePath) {
    const doc = await store.addFromPath(filePath);
    recents.add(store.get(doc.id).filePath);
    const existing = tabs.list().find((t) => t.docId === doc.id);
    if (existing) await tabs.activate(existing.id);
    else await tabs.open({ docId: doc.id });
    pushState();
    return doc;
  }

  const activeView = () => (tabs.activeId() === null ? undefined : tabs.viewOf(tabs.activeId()));
  const actions = {
    listTools: () => registry.tools.map(({ id, name, category }) => ({ id, name, category })),
    state,
    async openTool(toolId, docId) {
      const tool = registry.get(toolId);
      const active = tabs.activeId();
      if (active === null) await tabs.open({ page: tool.path, toolId, docId });
      else await tabs.navigate(active, { page: tool.path, toolId, docId: docId || tabs.get(active).docId });
      return state();
    },
    async switchTab(id) {
      await tabs.activate(id);
      return state();
    },
    async closeTab(id) {
      const { partition } = tabs.get(id);
      await tabs.close(id);
      session.fromPartition(partition).clearStorageData().catch((err) => log(`clear ${partition}: ${err.message}`));
      return state();
    },
    async openFileDialog() {
      const picked = await dialogs.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      const refused = [];
      for (const filePath of picked.canceled ? [] : picked.filePaths) {
        await openDocument(filePath).catch((err) => refused.push({ name: path.basename(String(filePath)), reason: err.message }));
      }
      return { ...state(), refused };
    },
    async openRecent(recentId) {
      const filePath = recents.pathOf(recentId);
      try {
        await openDocument(filePath);
      } catch (err) {
        recents.remove(recentId);
        pushState();
        throw new Error(`${path.basename(filePath)} could not be opened and was removed from recent files: ${err.message}`, { cause: err });
      }
      return state();
    },
  };
  const disposeShellIpc = registerShellIpc({ ipcMain, shellOrigin, getShellId: () => shellId, registry, store, tabs, recents, actions });

  // Menu actions: always the active tab, never "whatever has focus".
  const menuActions = {
    openFile: () => actions.openFileDialog().catch((err) => log(`open: ${err.message}`)),
    openRecent: (id) => actions.openRecent(id).catch((err) => log(`open recent: ${err.message}`)),
    closeTab: () => tabs.activeId() !== null && actions.closeTab(tabs.activeId()).catch((err) => log(`close tab: ${err.message}`)),
    nextTab: () => tabs.next().catch((err) => log(err.message)),
    previousTab: () => tabs.previous().catch((err) => log(err.message)),
    reloadTool() {
      const id = tabs.activeId();
      if (id === null) return;
      const { page, toolId, docId } = tabs.get(id);
      tabs.navigate(id, { page, toolId, docId }).catch((err) => log(`reload: ${err.message}`));
    },
    zoom(step) {
      const view = activeView();
      if (!view) return;
      const wc = view.webContents;
      wc.setZoomLevel(step === 0 ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + step * 0.5)));
    },
  };

  if (show) win.once('ready-to-show', () => win.show());
  await win.loadURL(`${shellOrigin}/shell.html`);
  if (homeTab) await tabs.open();

  return {
    origin: APP_ORIGIN,
    shellOrigin,
    rootReal,
    window: win,
    tabs,
    store,
    registry,
    recents,
    actions,
    menuActions,
    blocked,
    permissionDecisions,
    handoffs,
    openPath: openDocument,
    close: async () => {
      disposeShellIpc();
      toolIpc();
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = { startShell, APP_ORIGIN, SHELL_PARTITION };
