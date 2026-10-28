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
  // The isolation that matters is what the shell sends, not what the bundle asked for.
  r.headers = await ctx.js(`fetch(location.href).then((res) => ({
    coop: res.headers.get('cross-origin-opener-policy'),
    coep: res.headers.get('cross-origin-embedder-policy'),
    corp: res.headers.get('cross-origin-resource-policy'),
  }))`);
  const want = { coop: 'same-origin', coep: 'require-corp', corp: 'same-origin' };
  if (JSON.stringify(r.headers) !== JSON.stringify(want)) throw new Error(`isolation headers ${JSON.stringify(r.headers)} != ${JSON.stringify(want)}`);
  if (r.crossOriginIsolated !== true) throw new Error(`crossOriginIsolated=${r.crossOriginIsolated}`);
  if (r.sab !== 'function') throw new Error(`typeof SharedArrayBuffer=${r.sab}`);
  if (!r.secure) throw new Error('not a secure context');
  if (r.bridge.join() !== 'handoffToInput,openFile,readFile,saveFile') throw new Error(`bridge API is ${r.bridge.join()}`);
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
  out.corp = page.h.get('cross-origin-resource-policy');
  out.nosniff = page.h.get('x-content-type-options');
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
  out.hidden = [];
  for (const p of ['/_headers', '/.env', '/.git/config']) out.hidden.push({ p, status: (await get(p)).status });
  out.invalidRange = (await get('/index.html', { Range: 'bytes=5-2' })).status;

  const bad = [];
  if (out.cleanUrl !== 200) bad.push('clean url');
  if (out.coop !== 'same-origin' || out.coep !== 'require-corp' || out.corp !== 'same-origin') bad.push('COOP/COEP/CORP exact values');
  if (out.nosniff !== 'nosniff') bad.push('nosniff');
  if (!out.csp.startsWith("default-src 'self'")) bad.push('CSP');
  if (out.wasmRange.status !== 206 || out.wasmRange.type !== 'application/wasm' || out.wasmRange.magic.slice(1) !== 'asm') bad.push('wasm range/mime');
  if (out.gz.status !== 206 || out.gz.encoding || out.gz.magic.join() !== '1f,8b') bad.push('gz');
  if (out.range416 !== 416) bad.push('416');
  if (out.notFound !== 404) bad.push('404');
  if (out.traversal.some((t) => t.status !== 404)) bad.push('traversal');
  if (out.post !== 405) bad.push('405');
  if (out.hidden.some((t) => t.status !== 404)) bad.push('hidden files served');
  if (out.invalidRange !== 200) bad.push('invalid range must be ignored');
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
  const workerUrl = `${ctx.origin}/assets/${await firstWorkerScript(ctx)}`;
  const r = await ctx.js(`(async () => {
    const run = (src, msg) => new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url);
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 15000);
      w.onmessage = (e) => { clearTimeout(timer); resolve({ ok: true, data: e.data }); w.terminate(); };
      w.onerror = (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message) }); w.terminate(); };
      if (msg) w.postMessage(msg);
    });
    const abs = await run('try { importScripts(${JSON.stringify(ctx.origin + probe)}); postMessage("imported:" + typeof self.coherentpdf); } catch (e) { postMessage("error:" + e.message); }');
    const rel = await run('try { importScripts("${probe}"); postMessage("imported"); } catch (e) { postMessage("error:" + e.message); }');
    const sab = new SharedArrayBuffer(8);
    const shared = await run('onmessage = (e) => { const a = new Int32Array(e.data); Atomics.store(a, 0, 42); postMessage("atomics:" + Atomics.load(a, 0)); }', sab);
    // Module worker straight from the app origin. pdf.js's worker posts a "ready" message
    // when it has loaded; success is that message, failure is onerror. The only timer is
    // a hard failure deadline.
    const direct = await new Promise((resolve) => {
      const w = new Worker(${JSON.stringify(workerUrl)}, { type: 'module' });
      const timer = setTimeout(() => resolve({ ok: false, error: 'no ready message in 15s' }), 15000);
      w.onmessage = (e) => { clearTimeout(timer); resolve({ ok: true, data: e.data }); w.terminate(); };
      w.onerror = (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message) }); w.terminate(); };
    });
    return { abs, rel, shared, sabSeen: new Int32Array(sab)[0], direct };
  })()`);
  const problems = [];
  if (!r.abs.ok || r.abs.data !== 'imported:object') problems.push(`absolute importScripts: ${JSON.stringify(r.abs)}`);
  // Documented limit (m2-findings): a blob worker cannot resolve root-relative URLs.
  if (!r.rel.ok || !/^error:.*(invalid|Failed)/i.test(String(r.rel.data))) problems.push(`relative importScripts must fail with a URL error: ${JSON.stringify(r.rel)}`);
  if (!r.shared.ok || r.shared.data !== 'atomics:42' || r.sabSeen !== 42) problems.push(`SharedArrayBuffer to worker: ${JSON.stringify(r.shared)} seen=${r.sabSeen}`);
  if (!r.direct.ok || r.direct.data.action !== 'ready') problems.push(`module worker from /assets: ${JSON.stringify(r.direct)}`);
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
  const decisionsBefore = ctx.app.permissionDecisions.length;
  const r = await ctx.js(`(async () => {
    const out = {};
    out.readUnknownToken = await window.bentoDesktop.readFile('/etc/passwd').then(() => 'READ', (e) => 'rejected');
    out.readForgedUuid = await window.bentoDesktop.readFile('00000000-0000-4000-8000-000000000000').then(() => 'READ', () => 'rejected');
    out.open = window.open('https://example.com/') === null ? 'null' : 'window';
    // Deterministic probes: the answer is the permission state, not "no hardware".
    out.geoQuery = (await navigator.permissions.query({ name: 'geolocation' })).state;
    out.notificationQuery = (await navigator.permissions.query({ name: 'notifications' })).state;
    out.notificationRequest = await Notification.requestPermission();
    // Geolocation is already denied by the bundle's Permissions-Policy before the main process is asked.
    // clipboard-read only reaches the handler when the document is focused (not so in every headless
    // run), so it is recorded and must never be granted, but is not required to have been seen.
    out.clipboard = await navigator.clipboard.readText().then(() => 'READ', (e) => e.name);
    out.geoCode = await new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('granted'), (e) => res(e.code === e.PERMISSION_DENIED ? 'PERMISSION_DENIED' : 'code ' + e.code)));
    out.fetchExternal = await fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'ok', () => 'failed');
    return out;
  })()`);
  r.decisions = ctx.app.permissionDecisions.slice(decisionsBefore);
  const before = ctx.win.webContents.getURL();
  await ctx.js(`location.href = 'https://example.com/'`).catch(() => {});
  await ctx.sleep(1500);
  r.navigatedAway = ctx.win.webContents.getURL() !== before;
  const bad = [];
  if (r.readUnknownToken !== 'rejected' || r.readForgedUuid !== 'rejected') bad.push('read');
  if (r.open !== 'null') bad.push('window.open');
  if (r.geoQuery !== 'denied' || r.notificationQuery !== 'denied') bad.push('permissions.query not denied');
  if (r.notificationRequest !== 'denied') bad.push('Notification.requestPermission not denied');
  if (r.geoCode !== 'PERMISSION_DENIED') bad.push('geolocation was not denied by permission');
  // Notification.requestPermission() reaches the main-process request handler deterministically
  // (focus-independent); it must have been consulted, and every observed decision must be a refusal.
  if (!r.decisions.some((d) => d.kind === 'request' && d.permission === 'notifications')) bad.push('main-process request handler never saw notifications');
  if (r.clipboard === 'READ') bad.push('clipboard read allowed');
  if (r.decisions.length === 0 || r.decisions.some((d) => d.granted !== false)) bad.push('a permission decision was not false');
  if (r.fetchExternal !== 'failed') bad.push('external fetch');
  if (r.navigatedAway) bad.push('navigation');
  if (bad.length) throw new Error(`failed: ${bad.join(', ')} :: ${JSON.stringify(r)}`);
  return r;
}

module.exports = { isolation, transport, worker, handoff, denied };
