'use strict';

const { app, shell } = require('electron');

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
  } catch {
    return null;
  }
}

function isAppUrl(url, origin) {
  return originOf(url) === origin;
}

/** Requests the page may make: app origin, its blob: URLs, data: URLs. */
function isAllowedRequestUrl(url, origin) {
  return (
    isAppUrl(url, origin) ||
    url.startsWith(`blob:${origin}/`) ||
    url.startsWith('data:') ||
    url.startsWith('devtools:')
  );
}

function secureWebPreferences(preloadPath) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    enableBlinkFeatures: '',
  };
}

/**
 * Per-session lockdown: deny all permissions and devices, and cancel every
 * request that is not to the app itself (defence in depth next to the CSP,
 * which an Electron custom scheme does not get from `_headers`).
 */
function lockSession(session, origin, onBlocked) {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedRequestUrl(details.url, origin)) return callback({});
    onBlocked(details.url);
    return callback({ cancel: true });
  });
}

/**
 * Guards for every WebContents the app ever creates: no new windows (external
 * https opens in the system browser only if allowlisted), navigation and
 * redirects pinned to the app origin, no <webview>.
 */
function lockWebContents({ origin, externalAllowlist = [], log, openExternal = shell.openExternal }) {
  const allowed = new Set(externalAllowlist);
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') && allowed.has(new URL(url).host)) {
        openExternal(url).catch((err) => log(`openExternal failed: ${err.message}`));
      } else {
        log(`denied window.open: ${url}`);
      }
      return { action: 'deny' };
    });
    const pin = (event, url) => {
      if (!isAppUrl(url, origin)) {
        event.preventDefault();
        log(`blocked navigation: ${url}`);
      }
    };
    contents.on('will-navigate', pin);
    contents.on('will-frame-navigate', (event) => pin(event, event.url));
    contents.on('will-redirect', pin);
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

module.exports = {
  originOf,
  isAppUrl,
  isAllowedRequestUrl,
  secureWebPreferences,
  lockSession,
  lockWebContents,
};
