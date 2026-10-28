'use strict';

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Static, script-free page so a crashed or failed window is never blank. */
function errorPageUrl(title, detail) {
  const html =
    '<!doctype html><meta charset="utf-8"><title>BentoPDF</title>' +
    '<body style="font:16px system-ui;margin:3rem;max-width:40rem">' +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
    '<p>Close this window and start BentoPDF again. If it keeps happening, ' +
    'please report it together with the terminal output.</p>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const ABORTED = -3; // net::ERR_ABORTED: a navigation superseded by another

/** Show an error page instead of a blank window on renderer or load failure. */
function installFailureHandlers(win, log, allowUrl) {
  const show = (title, detail) => {
    log(`${title}: ${detail}`);
    const url = errorPageUrl(title, detail);
    allowUrl(url);
    if (!win.isDestroyed()) win.loadURL(url).catch(() => {});
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.webContents.on('render-process-gone', (_event, details) => {
    show('The window stopped working', `The renderer process ended (${details.reason}).`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === ABORTED || url.startsWith('data:')) return;
    show('The page could not be loaded', `${description} (${code})`);
  });
}

module.exports = { errorPageUrl, installFailureHandlers };
