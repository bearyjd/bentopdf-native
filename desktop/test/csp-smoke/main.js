'use strict';

// Run with: electron --ozone-platform=headless test/csp-smoke/main.js (env: BENTO_TEST_OUT, BENTO_DIST).
// Loads every top-level page of the bundle on the scheme transport, records every CSP violation
// (page-level `securitypolicyviolation` events plus Chromium's "Content Security Policy" console
// messages) and then runs the capability probes that need script sources a page load never reaches.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'bento-userdata-')));
app.commandLine.appendSwitch('disable-dev-shm-usage');

const { prepare, startApp } = require('../../src/app');
const { listPages } = require('./pages');
const probes = require('./probes');

const distDir = process.env.BENTO_DIST || path.resolve(__dirname, '..', '..', '..', 'dist');
prepare({});

const SETTLE_MS = 600;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LISTENER = `(() => {
  window.__cspViolations = window.__cspViolations || [];
  document.addEventListener('securitypolicyviolation', (e) =>
    window.__cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile }));
})()`;

async function loadPage(win, origin, page, record) {
  const onMessage = (event) => {
    if (/Content Security Policy/i.test(event.message)) record({ page, via: 'console', directive: (/directive: "([^"]+)"/.exec(event.message) || [])[1] || '?', blocked: event.message.slice(0, 200) });
  };
  win.webContents.on('console-message', onMessage);
  try {
    await win.loadURL(`${origin}${page}`);
    await win.webContents.executeJavaScript(LISTENER, true);
    await sleep(SETTLE_MS);
    const late = await win.webContents.executeJavaScript('window.__cspViolations || []', true);
    for (const v of late) record({ page, via: 'event', directive: v.directive, blocked: v.blocked });
  } finally {
    win.webContents.off('console-message', onMessage);
  }
}

async function run() {
  const handle = await startApp({ distDir, transport: 'scheme', show: false, dialogs: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) } });
  const violations = [];
  const loadErrors = [];
  const pages = listPages(distDir);
  for (const page of pages) {
    try {
      await loadPage(handle.window, handle.origin, page, (v) => violations.push(v));
    } catch (err) {
      loadErrors.push({ page, error: String(err.message || err) });
    }
  }
  await handle.window.loadURL(`${handle.origin}/index.html`);
  const probeResults = [];
  for (const [name, probe] of Object.entries(probes)) {
    const before = violations.length;
    const onMessage = (event) => {
      if (/Content Security Policy/i.test(event.message)) violations.push({ page: `probe:${name}`, via: 'console', directive: (/directive: "([^"]+)"/.exec(event.message) || [])[1] || '?', blocked: event.message.slice(0, 200) });
    };
    handle.window.webContents.on('console-message', onMessage);
    try {
      probeResults.push({ name, ok: true, detail: await probe(handle.window.webContents, distDir) });
    } catch (err) {
      probeResults.push({ name, ok: false, error: String(err.message || err).slice(0, 300) });
    }
    handle.window.webContents.off('console-message', onMessage);
    probeResults[probeResults.length - 1].violations = violations.length - before;
  }
  await handle.close();
  return { pages, loadErrors, violations, probeResults };
}

app.whenReady().then(async () => {
  let payload;
  try {
    payload = await run();
  } catch (err) {
    payload = { fatal: String(err.stack || err) };
  }
  fs.writeFileSync(process.env.BENTO_TEST_OUT, JSON.stringify(payload, null, 2));
  app.exit(0);
});
