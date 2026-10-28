'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MERGE = '/merge-pdf.html';

// Known benign noise on the merge page, each with the reason it is tolerated.
// Anything not matching fails mergeOffline. Applied per transport.
const BENIGN = {
  console: [
    {
      transports: ['scheme'],
      pattern: /\[SW\] Service Worker registration failed/,
      reason: 'sw-register.ts tries to register; the bento: scheme has no service-worker privilege by design',
    },
  ],
  net: [
    {
      transports: ['http'],
      pattern: /^net::ERR_CACHE_MISS .*\.woff2$/,
      reason: 'Chromium reports a cache-only font preload miss on loopback http; the page still renders (docs/m2-findings.md)',
    },
  ],
  http: [],
};

function unexpected(list, allow, transport) {
  return list.filter((entry) => !allow.some((a) => (!a.transports || a.transports.includes(transport)) && a.pattern.test(entry)));
}

async function firstWorkerScript(ctx) {
  const dir = path.join(ctx.app.rootReal, 'assets');
  const name = fs.readdirSync(dir).find((f) => /^pdf\.worker.*\.js$/.test(f));
  if (!name) throw new Error('no pdf.worker in dist/assets');
  return name;
}

const withTimeout = (promiseExpr, ms, what) =>
  `Promise.race([${promiseExpr}, new Promise((_, rej) => setTimeout(() => rej(new Error('${what} timeout ${ms}ms')), ${ms}))])`;

/**
 * scheme: service workers are unavailable BY DESIGN (allowServiceWorkers false,
 * pinned in test/security.test.js), so assert exactly that.
 * http: assert the full chain: register, active, controls the page after reload,
 * assets still load. Nothing is swallowed: a failing step throws with its reason.
 */
async function serviceWorker(ctx) {
  await ctx.load(MERGE);
  const attempt = await ctx.js(`(async () => {
    const out = { apiPresent: 'serviceWorker' in navigator };
    if (!out.apiPresent) return out;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      out.registered = true;
      const ready = await ${withTimeout('navigator.serviceWorker.ready', 15000, 'ready')};
      const active = ready.active;
      if (active && active.state !== 'activated') {
        await ${withTimeout("new Promise((res) => active.addEventListener('statechange', () => active.state === 'activated' && res()))", 15000, 'activation')};
      }
      out.activeState = active && active.state;
      out.scope = ready.scope;
    } catch (e) { out.registered = out.registered || false; out.error = String(e && e.message); }
    return out;
  })()`);
  if (ctx.transport === 'scheme') {
    const unavailable = !attempt.apiPresent || attempt.registered === false;
    if (!unavailable) throw new Error(`scheme transport unexpectedly allows service workers: ${JSON.stringify(attempt)}`);
    const controlled = await ctx.js('!!(navigator.serviceWorker && navigator.serviceWorker.controller)');
    if (controlled) throw new Error('page is controlled by a service worker on the scheme transport');
    return { expected: 'unavailable by design', ...attempt, controlled };
  }
  if (!attempt.registered || attempt.error) throw new Error(`sw.js registration failed on http: ${JSON.stringify(attempt)}`);
  if (attempt.activeState !== 'activated') throw new Error(`sw.js not active: ${JSON.stringify(attempt)}`);
  await ctx.load(MERGE);
  const controlled = await ctx.waitFor('!!(navigator.serviceWorker && navigator.serviceWorker.controller)', 10000, 'page controlled after reload').catch(() => false);
  const statuses = await ctx.js(`(async () => {
    const out = {};
    for (const u of ['/assets/${await firstWorkerScript(ctx)}', '/wasm/cpdf/coherentpdf.browser.min.js']) {
      out[u] = await fetch(u).then((r) => r.status, (e) => 'ERR ' + e.message);
    }
    return out;
  })()`);
  if (!controlled) throw new Error(`registered and active, but the page is not controlled after reload: ${JSON.stringify({ attempt, statuses })}`);
  if (!Object.values(statuses).every((s) => s === 200)) throw new Error(`assets failed once sw.js controls the page: ${JSON.stringify(statuses)}`);
  return { ...attempt, controlled, statuses };
}

async function mergeOffline(ctx) {
  const blockedBefore = ctx.app.blocked.length;
  await ctx.load(MERGE);
  await ctx.waitFor(`document.readyState === 'complete' && !!document.querySelector('#file-input')`, 30000);
  await ctx.sleep(4000);
  const external = ctx.app.blocked.slice(blockedBefore);
  const title = await ctx.js('location.pathname + " | " + document.title');
  if (!title.startsWith('/merge-pdf')) throw new Error(`not the merge page: ${title}`);
  if (external.length) throw new Error(`external requests attempted: ${external.join(', ')}`);
  const found = {
    httpErrors: unexpected(ctx.events.httpErrors, BENIGN.http, ctx.transport),
    consoleErrors: unexpected(ctx.events.consoleErrors, BENIGN.console, ctx.transport),
    netErrors: unexpected(ctx.events.netErrors, BENIGN.net, ctx.transport),
  };
  if (Object.values(found).some((l) => l.length)) throw new Error(`unexpected errors on the merge page: ${JSON.stringify(found)}`);
  return { title, tolerated: { console: ctx.events.consoleErrors, net: ctx.events.netErrors } };
}

/** A dead renderer must leave an error page, not a blank window. */
async function crash(ctx) {
  await ctx.load('/index.html');
  const gone = new Promise((resolve) => ctx.win.webContents.once('render-process-gone', (_e, d) => resolve(d.reason)));
  process.kill(ctx.win.webContents.getOSProcessId(), 'SIGKILL');
  const reason = await gone;
  const heading = await ctx.waitFor(`document.querySelector('h1') && document.querySelector('h1').textContent`, 10000, 'error page heading');
  if (!/stopped working/.test(heading)) throw new Error(`unexpected page after crash: ${heading}`);
  const url = ctx.win.webContents.getURL();
  if (!url.startsWith('data:text/html')) throw new Error(`expected the error page, got ${url}`);
  const bridgeUsable = await ctx.js(`window.bentoDesktop.readFile('x').then(() => true, () => false)`);
  if (bridgeUsable) throw new Error('error page must not be able to use the file bridge');
  return { reason, heading };
}

module.exports = { serviceWorker, mergeOffline, crash };
