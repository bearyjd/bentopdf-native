'use strict';

const path = require('node:path');
const { WebContentsView, session } = require('electron');
const { secureWebPreferences } = require('../security');
const { installFailureHandlers } = require('../failure');

const TOOL_PRELOAD = path.join(__dirname, '..', 'preload.js');

/** Shell chrome geometry (CSS pixels); shell.css uses the same numbers. */
const LAYOUT = Object.freeze({ tabStrip: 40, sidebar: 280 });

function contentBounds(win) {
  const { width, height } = win.getContentBounds();
  return {
    x: LAYOUT.sidebar,
    y: LAYOUT.tabStrip,
    width: Math.max(0, width - LAYOUT.sidebar),
    height: Math.max(0, height - LAYOUT.tabStrip),
  };
}

/**
 * Electron ViewAdapter for the tab manager: one WebContentsView per live tab,
 * in the tab's own partition (prepared by `prepare(ses)` before anything
 * loads), with the M2 tool preload and web preferences, as a child of `win`.
 * `onNavigated(tabId, pathname)` reports in-page navigation to another tool.
 */
function createViewAdapter({ win, origin, prepare, log, allowUrl, onNavigated = () => {} }) {
  const tabOf = new Map(); // view -> tab id
  const relayout = () => {
    for (const view of tabOf.keys()) view.setBounds(contentBounds(win));
  };
  win.on('resize', relayout);

  return Object.freeze({
    create(tab) {
      prepare(session.fromPartition(tab.partition), tab.partition);
      const view = new WebContentsView({
        webPreferences: { ...secureWebPreferences(TOOL_PRELOAD), partition: tab.partition, backgroundThrottling: false },
      });
      const wc = view.webContents;
      installFailureHandlers(
        { webContents: wc, loadURL: (u) => wc.loadURL(u), isDestroyed: () => wc.isDestroyed(), isVisible: () => true, show: () => {} },
        log,
        allowUrl
      );
      wc.on('did-navigate', (_event, url) => {
        if (url.startsWith(`${origin}/`)) onNavigated(tab.id, new URL(url).pathname);
      });
      view.setVisible(false);
      view.setBounds(contentBounds(win));
      win.contentView.addChildView(view);
      tabOf.set(view, tab.id);
      return view;
    },
    load: (view, page) => view.webContents.loadURL(`${origin}${page}`),
    show(view) {
      view.setBounds(contentBounds(win));
      view.setVisible(true);
    },
    hide: (view) => view.setVisible(false),
    destroy(view) {
      tabOf.delete(view);
      if (!win.isDestroyed()) win.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    },
  });
}

module.exports = { createViewAdapter, contentBounds, LAYOUT };
