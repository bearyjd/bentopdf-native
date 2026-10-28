'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { session } = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Helpers shared by scenarios. `app` is the object returned by startApp. */
function createContext({ app, workDir, dialogState }) {
  const { window: win } = app;
  const events = { consoleErrors: [], httpErrors: [], netErrors: [], downloads: [] };

  win.webContents.on('console-message', (event) => {
    if (process.env.BENTO_TEST_VERBOSE) process.stderr.write(`[page ${event.level}] ${event.message.slice(0, 300)}\n`);
    if (event.level === 'error') events.consoleErrors.push(`${event.message}`.slice(0, 300));
  });
  const ses = session.defaultSession;
  ses.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400) events.httpErrors.push(`${d.statusCode} ${d.url}`);
  });
  ses.webRequest.onErrorOccurred((d) => {
    if (d.error !== 'net::ERR_ABORTED') events.netErrors.push(`${d.error} ${d.url}`);
  });
  ses.on('will-download', (_e, item) => {
    const target = path.join(workDir, `dl-${events.downloads.length}-${item.getFilename()}`);
    item.setSavePath(target);
    item.once('done', (_ev, state) => events.downloads.push({ name: item.getFilename(), state, target }));
  });

  const js = (code) => win.webContents.executeJavaScript(code, true);

  async function waitFor(expression, timeoutMs, label = expression) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await js(expression).catch(() => false);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for: ${label}`);
      await sleep(250);
    }
  }

  async function waitForDownload(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = events.downloads.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for download`);
      await sleep(250);
    }
  }

  async function load(urlPath) {
    await win.loadURL(`${app.origin}${urlPath}`);
  }

  /** Make the next native open dialog "pick" these paths. */
  function pickFiles(paths) {
    dialogState.next = paths;
  }

  async function handoff(inputSelector, paths) {
    pickFiles(paths);
    return js(`(async () => {
      const picked = await window.bentoDesktop.openFile({ multiple: true });
      return window.bentoDesktop.handoffToInput(picked, ${JSON.stringify(inputSelector)});
    })()`);
  }

  const read = (file) => fs.readFileSync(file);
  return { app, win, origin: app.origin, events, js, waitFor, waitForDownload, load, handoff, pickFiles, read, workDir, sleep };
}

module.exports = { createContext, sleep };
