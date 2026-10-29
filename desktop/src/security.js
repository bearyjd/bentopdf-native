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

// data: is only for inline images and fonts (CSP img-src/font-src allow them);
// no data: document, script or fetch is let through.
const DATA_PREFIXES = ['data:image/', 'data:font/', 'data:application/font', 'data:application/x-font'];

/** Requests the page may make: app origin, its blob: URLs, inline image/font data: URLs. */
function isAllowedRequestUrl(url, origin, { allowDevtools = false } = {}) {
  return (
    isAppUrl(url, origin) ||
    url.startsWith(`blob:${origin}/`) ||
    DATA_PREFIXES.some((prefix) => url.startsWith(prefix)) ||
    (allowDevtools && url.startsWith('devtools:'))
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

/** Every permission is denied. Kept as one function so tests can see it decide. */
const decidePermission = () => false;

/**
 * Per-session lockdown: deny all permissions and devices, and cancel every
 * request that is not to the app itself (defence in depth next to the CSP,
 * which an Electron custom scheme does not get from `_headers`).
 * `onPermission({kind, permission, granted})` observes each decision;
 * `extraAllowed` holds exact URLs (the shell's own error page) let through.
 */
function lockSession(session, origin, onBlocked, { allowDevtools = false, onPermission = () => {}, extraAllowed = new Set() } = {}) {
  const decide = (kind, permission) => {
    const granted = decidePermission(permission);
    onPermission({ kind, permission, granted });
    return granted;
  };
  session.setPermissionRequestHandler((_wc, permission, callback) => callback(decide('request', permission)));
  session.setPermissionCheckHandler((_wc, permission) => decide('check', permission));
  session.setDevicePermissionHandler((details) => decide('device', details && details.deviceType));
  session.setDisplayMediaRequestHandler((_request, callback) => {
    decide('display-media', 'display-capture');
    callback({});
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    if (extraAllowed.has(details.url) || isAllowedRequestUrl(details.url, origin, { allowDevtools })) {
      return callback({});
    }
    onBlocked(details.url);
    return callback({ cancel: true });
  });
}

/**
 * Guards for every WebContents the app ever creates: no new windows (external
 * https opens in the system browser only if allowlisted), navigation and
 * redirects pinned to the app origin, no <webview>. `originFor(contents)`
 * picks the one origin a given WebContents is pinned to (the shell UI has its
 * own); it defaults to `origin` for every WebContents.
 */
function lockWebContents({ origin, externalAllowlist = [], log, openExternal = shell.openExternal, originFor = () => origin }) {
  const allowed = new Set(externalAllowlist);
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        if (url.startsWith('https://') && allowed.has(new URL(url).host)) {
          openExternal(url).catch((err) => log(`openExternal failed: ${err.message}`));
        } else {
          log(`denied window.open: ${url}`);
        }
      } catch (err) {
        log(`denied window.open (${err.message}): ${url}`);
      }
      return { action: 'deny' };
    });
    // Default deny: anything that is not provably the app origin is blocked.
    const pin = (event, url) => {
      try {
        if (isAppUrl(url, originFor(contents))) return;
        log(`blocked navigation: ${url}`);
      } catch (err) {
        log(`blocked navigation (${err.message})`);
      }
      event.preventDefault();
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
