'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const brand = require('../../brand.json');
const { buildAppHeaders } = require('../headers');
const { installFailureHandlers } = require('../failure');
const { registerIpc } = require('../ipc');
const { lockSession, lockWebContents, secureWebPreferences } = require('../security');
const { createDocumentStore } = require('./document-store');
const { createRecents } = require('./recents');
const { buildToolRegistry } = require('./tool-registry');
const { createTabManager } = require('./tab-manager');
const { createViewAdapter } = require('./tab-views');
const { prepareSession, releaseSession, SHELL_HEADERS, SHELL_HOST } = require('./sessions');
const { pushCapped, addCapped, createLogLimiter, serialByKey } = require('./bounded');
const { isPermanentOpenFailure } = require('./recents');
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
 * @param {{distDir: string, dialogs?: object, show?: boolean, liveBudget?: number, homeTab?: boolean,
 *          recentsFile?: string, onSession?: (ses: object, partition: string) => void,
 *          onStateChanged?: (state: object) => void}} options
 */
async function startShell(options) {
  const { distDir, dialogs = dialog, show = true, liveBudget, homeTab = true, onSession = () => {}, onStateChanged = () => {} } = options;
  const rootReal = fs.realpathSync(distDir);
  if (!fs.existsSync(path.join(rootReal, 'index.html'))) throw new Error(`${rootReal} does not look like a BentoPDF bundle (no index.html)`);
  const headers = buildAppHeaders(rootReal);
  const registry = buildToolRegistry(rootReal);
  let tabs = null;
  const store = createDocumentStore({ inUse: (id) => tabs !== null && tabs.list().some((t) => t.docId === id) });
  const recents = createRecents({
    file: options.recentsFile || path.join(app.getPath('userData'), 'recents.json'),
    onError: (err) => log(`recents: ${err.message}`),
  });

  // Everything below is fed by renderer behaviour, so each is bounded (bounded.js).
  const blocked = [];
  const permissionDecisions = [];
  const handoffs = [];
  const extraAllowed = new Set();
  const allowUrl = (url) => addCapped(extraAllowed, url);
  const shouldLog = createLogLimiter();
  const logLimited = (partition, message) => {
    const verdict = shouldLog(partition);
    if (verdict === 'log') log(message);
    else if (verdict === 'notice') log(`(${partition}) further blocked/permission lines suppressed for a minute`);
  };
  const prepared = new WeakSet();
  const observers = (partition) => ({
    allowDevtools: !app.isPackaged,
    extraAllowed,
    onBlocked: (url) => {
      pushCapped(blocked, { partition, url });
      logLimited(partition, `blocked request (${partition}): ${url}`);
    },
    onPermission: (decision) => {
      pushCapped(permissionDecisions, { ...decision, partition });
      logLimited(partition, `permission ${decision.kind} ${decision.permission} (${partition}): ${decision.granted ? 'GRANTED' : 'denied'}`);
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
  // Native dialogs: only the ACTIVE tab's WebContents (a hidden background tab must not open one).
  const isActiveContents = (wc) => {
    const view = tabs && tabs.activeId() !== null ? tabs.viewOf(tabs.activeId()) : undefined;
    return Boolean(view) && !view.webContents.isDestroyed() && view.webContents.id === wc.id;
  };
  const toolIpc = registerIpc({ ipcMain, origin: APP_ORIGIN, dialogs, getWindow: () => win, canUseDialogs: isActiveContents });

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: brand.productName,
    show: false,
    webPreferences: { ...secureWebPreferences(SHELL_PRELOAD), partition: SHELL_PARTITION, backgroundThrottling: false },
  });
  shellId = win.webContents.id;
  win.on('page-title-updated', (event) => event.preventDefault()); // the title is the brand, not shell.html's <title>
  installFailureHandlers(win, log, allowUrl);

  const toolIdOfPage = (page) => {
    const id = page.replace(/^\//, '').replace(/\.html$/, '');
    return registry.has(id) ? id : null;
  };

  // Per-tab document status for the shell UI ('loading document...', or why a handoff failed).
  let statuses = new Map(); // tab id -> frozen {kind: 'loading'|'error', text}
  const handoffSeq = new Map(); // tab id -> latest handoff number (older ones are superseded)
  const setStatus = (tabId, status) => {
    const next = new Map(statuses);
    if (status) next.set(tabId, Object.freeze(status));
    else next.delete(tabId);
    statuses = next;
    pushState();
  };

  /**
   * Hand the tab's document to its tool page through the M2 grant + preload path.
   * Runs in the background (the tab manager does not await it): progress and
   * failure go to the tab's status, never to the caller of activate/openTool.
   */
  async function handoff(tab, view) {
    const seq = (handoffSeq.get(tab.id) || 0) + 1;
    handoffSeq.set(tab.id, seq);
    const doc = tab.docId && tab.toolId ? store.get(tab.docId) : undefined;
    if (!doc) {
      if (statuses.has(tab.id)) setStatus(tab.id, null);
      return;
    }
    const wc = view.webContents;
    const latest = () => handoffSeq.get(tab.id) === seq && tabs.viewOf(tab.id) === view && !wc.isDestroyed();
    const toolName = registry.get(tab.toolId).name;
    setStatus(tab.id, { kind: 'loading', text: `Loading ${doc.name} into ${toolName}...` });
    try {
      const entry = doc.bytes
        ? toolIpc.grantBytes(wc, doc.name, doc.bytes)
        : await toolIpc.grantPath(wc, doc.filePath, { dev: doc.dev, ino: doc.ino });
      // userGesture=false: the page must not get transient user activation from us.
      const count = await wc.executeJavaScript(handoffScript([entry], adapterFor(tab.toolId)), false);
      if (!latest()) return;
      if (store.has(doc.id)) store.touch(doc.id);
      pushCapped(handoffs, Object.freeze({ tabId: tab.id, toolId: tab.toolId, docId: doc.id, count }));
      setStatus(tab.id, null);
    } catch (err) {
      log(`handoff ${doc.name} -> ${tab.toolId} (tab ${tab.id}): ${err.message}`);
      if (latest()) setStatus(tab.id, { kind: 'error', text: `Could not open ${doc.name} in ${toolName}: ${err.message}` });
    }
  }

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
      status: statuses.get(t.id) || null,
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
    allowUrl,
    onNavigated: (id, page) => tabs.recordPage(id, page, toolIdOfPage(page)),
  });
  tabs = createTabManager({
    views,
    liveBudget,
    onLoaded: handoff,
    onChange: pushState,
    onError: (err, tab) => log(`tab ${tab.id}: ${err.message}`),
  });

  /** A path from the OS, a dialog or recents: validated by the store, then shown in a tab. */
  async function openNow(filePath) {
    const doc = await store.addFromPath(filePath);
    recents.add(store.get(doc.id).filePath);
    const existing = tabs.list().find((t) => t.docId === doc.id);
    if (existing) await tabs.activate(existing.id);
    else await tabs.open({ docId: doc.id });
    pushState();
    return doc;
  }
  // One open at a time per path: concurrent opens of the same file end in one document and one tab.
  const openDocument = (() => {
    const serial = serialByKey((filePath) => openNow(filePath));
    return (filePath) => serial(String(filePath));
  })();

  /** Remove a document nothing shows any more (its last tab closed or navigated away). */
  const releaseDocument = (docId) => {
    if (docId && !tabs.list().some((t) => t.docId === docId)) store.remove(docId);
  };

  const activeView = () => (tabs.activeId() === null ? undefined : tabs.viewOf(tabs.activeId()));
  const actions = {
    listTools: () => registry.tools.map(({ id, name, category }) => ({ id, name, category })),
    state,
    async openTool(toolId, docId) {
      const tool = registry.get(toolId);
      const active = tabs.activeId();
      if (active === null) await tabs.open({ page: tool.path, toolId, docId });
      else {
        const previousDoc = tabs.get(active).docId;
        await tabs.navigate(active, { page: tool.path, toolId, docId: docId || previousDoc });
        releaseDocument(previousDoc);
      }
      return state();
    },
    async switchTab(id) {
      await tabs.activate(id);
      return state();
    },
    async closeTab(id) {
      const { partition, docId } = tabs.get(id);
      await tabs.close(id);
      handoffSeq.delete(id);
      if (statuses.has(id)) setStatus(id, null);
      releaseDocument(docId);
      await releaseSession(session.fromPartition(partition), log);
      pushState();
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
        if (!isPermanentOpenFailure(err)) {
          throw new Error(`${path.basename(filePath)} could not be opened (kept in recent files, try again): ${err.message}`, { cause: err });
        }
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

  // Window teardown, once: every view's WebContents closed, listeners and IPC handlers removed.
  // Runs on handle.close() and when the user closes the window.
  let tornDown = false;
  function teardown() {
    if (tornDown) return;
    tornDown = true;
    tabs.closeAll();
    views.dispose();
    disposeShellIpc();
    toolIpc();
  }
  win.once('closed', teardown);

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
      const partitions = tabs.list().map((t) => t.partition);
      teardown();
      await Promise.all(partitions.map((partition) => releaseSession(session.fromPartition(partition), log)));
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = { startShell, APP_ORIGIN, SHELL_PARTITION };
