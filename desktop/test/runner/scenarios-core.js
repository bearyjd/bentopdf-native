'use strict';

const path = require('node:path');
const { session } = require('electron');
const fixtures = require('../fixtures');

const MERGE = '/merge-pdf.html';

async function isolation(ctx) {
  await ctx.load('/index.html');
  const r = await ctx.js(`({
    crossOriginIsolated: window.crossOriginIsolated,
    sab: typeof SharedArrayBuffer,
    secure: window.isSecureContext,
    origin: location.origin,
    bridge: Object.keys(window.bentoDesktop || {}).sort(),
    nodeLeak: [typeof require, typeof process, typeof module].join(',')
  })`);
  if (r.crossOriginIsolated !== true) throw new Error(`crossOriginIsolated=${r.crossOriginIsolated}`);
  if (r.sab !== 'function') throw new Error(`typeof SharedArrayBuffer=${r.sab}`);
  if (!r.secure) throw new Error('not a secure context');
  if (r.nodeLeak !== 'undefined,undefined,undefined') throw new Error(`node globals leaked: ${r.nodeLeak}`);
  return r;
}

async function transport(ctx) {
  const ses = session.defaultSession;
  const get = async (p, headers = {}, method = 'GET') => {
    const res = await ses.fetch(`${ctx.origin}${p}`, { headers, method });
    const body = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
    return { status: res.status, h: res.headers, body };
  };
  const out = {};
  const page = await get('/merge-pdf');
  out.cleanUrl = page.status;
  out.coop = page.h.get('cross-origin-opener-policy');
  out.coep = page.h.get('cross-origin-embedder-policy');
  out.csp = (page.h.get('content-security-policy') || '').slice(0, 60);
  const wasm = await get('/assets/' + (await firstWasm(ctx)), { Range: 'bytes=0-3' });
  out.wasmRange = { status: wasm.status, type: wasm.h.get('content-type'), range: wasm.h.get('content-range'), magic: wasm.body.toString('latin1') };
  const gz = await get('/libreoffice-wasm/soffice.wasm.gz', { Range: 'bytes=0-1' });
  out.gz = { status: gz.status, type: gz.h.get('content-type'), encoding: gz.h.get('content-encoding'), magic: [...gz.body].map((b) => b.toString(16)) };
  out.range416 = (await get('/assets/' + (await firstWasm(ctx)), { Range: 'bytes=999999999-' })).status;
  out.notFound = (await get('/definitely-missing.js')).status;
  out.traversal = [];
  for (const p of ['/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd', '/%2e%2e%5c%2e%2e%5cetc', '/a%00b']) {
    out.traversal.push({ p, status: (await get(p)).status });
  }
  out.post = (await get('/index.html', {}, 'POST')).status;

  const bad = [];
  if (out.cleanUrl !== 200) bad.push('clean url');
  if (out.coop !== 'same-origin' || out.coep !== 'require-corp') bad.push('COOP/COEP');
  if (!out.csp.startsWith("default-src 'self'")) bad.push('CSP');
  if (out.wasmRange.status !== 206 || out.wasmRange.type !== 'application/wasm' || out.wasmRange.magic.slice(1) !== 'asm') bad.push('wasm range/mime');
  if (out.gz.status !== 206 || out.gz.encoding || out.gz.magic.join() !== '1f,8b') bad.push('gz');
  if (out.range416 !== 416) bad.push('416');
  if (out.notFound !== 404) bad.push('404');
  if (out.traversal.some((t) => t.status !== 404)) bad.push('traversal');
  if (out.post !== 405) bad.push('405');
  if (bad.length) throw new Error(`failed: ${bad.join(', ')} :: ${JSON.stringify(out)}`);
  return out;
}

async function firstWasm(ctx) {
  const fs = require('node:fs');
  const dir = path.join(ctx.app.rootReal, 'assets');
  const name = fs.readdirSync(dir).find((f) => f.endsWith('.wasm'));
  if (!name) throw new Error('no .wasm in dist/assets');
  return name;
}

async function worker(ctx) {
  await ctx.load('/index.html');
  const probe = '/wasm/cpdf/coherentpdf.browser.min.js';
  const r = await ctx.js(`(async () => {
    const run = (src, msg) => new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url);
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 15000);
      w.onmessage = (e) => { clearTimeout(timer); resolve({ ok: true, data: e.data }); w.terminate(); };
      w.onerror = (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message) }); };
      if (msg) w.postMessage(msg);
    });
    const abs = await run('try { importScripts(${JSON.stringify(ctx.origin + probe)}); postMessage("imported:" + typeof self.coherentpdf); } catch (e) { postMessage("error:" + e.message); }');
    const rel = await run('try { importScripts("${probe}"); postMessage("imported"); } catch (e) { postMessage("error:" + e.message); }');
    const sab = new SharedArrayBuffer(8);
    const shared = await run('onmessage = (e) => { const a = new Int32Array(e.data); Atomics.store(a, 0, 42); postMessage("atomics:" + Atomics.load(a, 0)); }', sab);
    const direct = await new Promise((resolve) => {
      const w = new Worker('/assets/' + ${JSON.stringify(await firstWorkerScript(ctx))}, { type: 'module' });
      w.onerror = (e) => resolve({ ok: false, error: String(e.message) });
      setTimeout(() => resolve({ ok: true }), 1500);
    });
    return { abs, rel, shared, sabSeen: new Int32Array(sab)[0], direct };
  })()`);
  const problems = [];
  if (!r.abs.ok || !String(r.abs.data).startsWith('imported')) problems.push(`absolute importScripts: ${JSON.stringify(r.abs)}`);
  if (!r.shared.ok || r.sabSeen !== 42) problems.push(`SharedArrayBuffer to worker: ${JSON.stringify(r.shared)} seen=${r.sabSeen}`);
  if (!r.direct.ok) problems.push(`URL worker: ${JSON.stringify(r.direct)}`);
  if (problems.length) throw new Error(problems.join(' | '));
  return r;
}

async function firstWorkerScript(ctx) {
  const fs = require('node:fs');
  const dir = path.join(ctx.app.rootReal, 'assets');
  const name = fs.readdirSync(dir).find((f) => /^pdf\.worker.*\.js$/.test(f));
  if (!name) throw new Error('no pdf.worker in dist/assets');
  return name;
}

async function serviceWorker(ctx) {
  await ctx.load(MERGE);
  const registration = await ctx.js(`(async () => {
    const waitReady = () => Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('ready timeout 8s')), 8000)),
    ]);
    const out = { byPage: false, manual: null };
    try {
      const reg = await waitReady();
      return { ...out, byPage: true, scope: reg.scope, script: (reg.active || {}).scriptURL };
    } catch (e) { out.pageReason = String(e.message); }
    try {
      await navigator.serviceWorker.register('/sw.js');
      const reg = await waitReady();
      return { ...out, manual: true, scope: reg.scope, script: (reg.active || {}).scriptURL };
    } catch (e) { return { ...out, manual: false, manualReason: String(e.message) }; }
  })()`);
  // Reload so a registered worker controls the page, then fetch cacheable assets.
  await ctx.load(MERGE);
  await ctx.sleep(1500);
  const assets = await ctx.js(`(async () => {
    const out = { controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller) };
    for (const u of ['/assets/${await firstWorkerScript(ctx)}', '/wasm/cpdf/coherentpdf.browser.min.js']) {
      out[u] = await fetch(u).then((r) => r.status, (e) => 'ERR ' + e.message);
    }
    return out;
  })()`);
  return { ...registration, afterReload: assets };
}

async function mergeOffline(ctx) {
  const blockedBefore = ctx.app.blocked.length;
  ctx.events.httpErrors.length = 0;
  ctx.events.consoleErrors.length = 0;
  ctx.events.netErrors.length = 0;
  await ctx.load(MERGE);
  await ctx.waitFor(`document.readyState === 'complete' && !!document.querySelector('#file-input')`, 30000);
  await ctx.sleep(4000);
  const external = ctx.app.blocked.slice(blockedBefore);
  const title = await ctx.js('location.pathname + " | " + document.title');
  if (!title.startsWith('/merge-pdf')) throw new Error(`not the merge page: ${title}`);
  if (external.length) throw new Error(`external requests attempted: ${external.join(', ')}`);
  return { title, appOrigin404or5xx: ctx.events.httpErrors.slice(0, 10), consoleErrors: ctx.events.consoleErrors.slice(0, 10), netErrors: ctx.events.netErrors.slice(0, 10) };
}

async function handoff(ctx) {
  const pdf = path.join(ctx.workDir, 'two-page.pdf');
  await fixtures.writeSmallPdf(pdf);
  await ctx.load(MERGE);
  await ctx.waitFor(`!!document.querySelector('#file-input')`, 30000);
  await ctx.sleep(1500);
  const count = await ctx.handoff('#file-input', [pdf]);
  const listed = await ctx.waitFor(
    `(() => { const t = document.querySelector('#file-list')?.textContent || ''; return t.includes('two-page.pdf') ? t.replace(/\\s+/g, ' ').trim().slice(0, 160) : ''; })()`,
    20000,
    '#file-list to show two-page.pdf'
  );
  return { injected: count, fileList: listed };
}

async function denied(ctx) {
  await ctx.load('/index.html');
  const r = await ctx.js(`(async () => {
    const out = {};
    out.readUnknownToken = await window.bentoDesktop.readFile('/etc/passwd').then(() => 'READ', (e) => 'rejected');
    out.readForgedUuid = await window.bentoDesktop.readFile('00000000-0000-4000-8000-000000000000').then(() => 'READ', () => 'rejected');
    out.open = window.open('https://example.com/') === null ? 'null' : 'window';
    out.perm = await new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('granted'), (e) => res('denied:' + e.code)));
    out.fetchExternal = await fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'ok', () => 'failed');
    return out;
  })()`);
  const before = ctx.win.webContents.getURL();
  await ctx.js(`location.href = 'https://example.com/'`).catch(() => {});
  await ctx.sleep(1500);
  r.navigatedAway = ctx.win.webContents.getURL() !== before;
  const bad = [];
  if (r.readUnknownToken !== 'rejected' || r.readForgedUuid !== 'rejected') bad.push('read');
  if (r.open !== 'null') bad.push('window.open');
  if (!String(r.perm).startsWith('denied')) bad.push('permission');
  if (r.fetchExternal !== 'failed') bad.push('external fetch');
  if (r.navigatedAway) bad.push('navigation');
  if (bad.length) throw new Error(`failed: ${bad.join(', ')} :: ${JSON.stringify(r)}`);
  return r;
}

module.exports = { isolation, transport, worker, mergeOffline, handoff, denied, serviceWorker };
