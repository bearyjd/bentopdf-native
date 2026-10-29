'use strict';

// Shell (M3a) scenarios. Each gets {handle, workDir, dialogState, requests} from
// shell-main.js and drives the shell through its REAL IPC (the shell page calls
// window.bentoShell), then inspects each tab's view directly.
const fs = require('node:fs');
const path = require('node:path');
const { WebContentsView } = require('electron');
const { secureWebPreferences } = require('../../src/security');
const { SHELL_PARTITION } = require('../../src/shell/shell-app');

const SHELL_PRELOAD = path.join(__dirname, '..', '..', 'src', 'shell', 'shell-preload.js');
const TOOL_PRELOAD = path.join(__dirname, '..', '..', 'src', 'preload.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Smallest valid one-page PDF (correct xref), no dependency on upstream's node_modules. */
function writeMinimalPdf(file, label) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
  ];
  let out = `%PDF-1.4\n% ${label}\n`;
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, out);
  return file;
}

const js = (wc, code) => wc.executeJavaScript(code, true);

async function waitIn(wc, expression, timeoutMs, label = expression) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await js(wc, expression).catch(() => false);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for: ${label}`);
    await sleep(250);
  }
}

/** Call the shell bridge from the shell page itself (real IPC, real sender). */
async function shellCall(handle, code) {
  const wc = handle.window.webContents;
  await waitIn(wc, `document.body.dataset.ready === 'true'`, 15000, 'shell UI ready');
  return js(wc, `(async () => { try { return { ok: true, value: await (${code}) }; } catch (e) { return { ok: false, error: String(e.message) }; } })()`);
}

async function mustCall(handle, code) {
  const r = await shellCall(handle, code);
  if (!r.ok) throw new Error(`${code} failed: ${r.error}`);
  return r.value;
}

async function openPdfs(ctx, names) {
  ctx.dialogState.next = names.map((n) => writeMinimalPdf(path.join(ctx.workDir, n), n));
  const state = await mustCall(ctx.handle, 'window.bentoShell.openFileDialog()');
  if (state.refused.length) throw new Error(`refused: ${JSON.stringify(state.refused)}`);
  return state;
}

/** Per-view facts that must hold in EVERY tab (M2 proved them for one window only). */
async function viewFacts(wc) {
  return js(wc, `(async () => {
    const res = await fetch(location.href);
    return {
      url: location.href,
      crossOriginIsolated: window.crossOriginIsolated,
      sab: typeof SharedArrayBuffer,
      bridge: Object.keys(window.bentoDesktop || {}).sort().join(),
      shellBridge: typeof window.bentoShell,
      nodeLeak: [typeof require, typeof process, typeof module].join(),
      coop: res.headers.get('cross-origin-opener-policy'),
      coep: res.headers.get('cross-origin-embedder-policy'),
      csp: (res.headers.get('content-security-policy') || '').slice(0, 20),
      notification: await Notification.requestPermission(),
    };
  })()`);
}

function assertNoExternalRequests(ctx) {
  const internal = /^(bento:\/\/(app|shell)\/|blob:bento:\/\/(app|shell)\/|data:|devtools:)/;
  const external = ctx.requests.filter((r) => !internal.test(r.url));
  if (external.length || ctx.handle.blocked.length) {
    throw new Error(`external requests: ${JSON.stringify(external.slice(0, 5))} blocked: ${JSON.stringify(ctx.handle.blocked.slice(0, 5))}`);
  }
  return { observed: ctx.requests.length, partitions: [...new Set(ctx.requests.map((r) => r.partition))].sort() };
}

async function shellTabs(ctx) {
  const { handle } = ctx;
  const state = await openPdfs(ctx, ['first.pdf', 'second.pdf']);
  if (state.tabs.length !== 2 || state.tabs.map((t) => t.docName).join() !== 'first.pdf,second.pdf') throw new Error(`tabs ${JSON.stringify(state.tabs)}`);
  const [t1, t2] = state.tabs.map((t) => handle.tabs.get(t.id));
  const wc1 = handle.tabs.viewOf(t1.id).webContents;
  const wc2 = handle.tabs.viewOf(t2.id).webContents;
  const problems = [];
  if (wc1.session === wc2.session || t1.partition === t2.partition) problems.push('tabs share a session');
  if (wc1.session.getStoragePath() !== null) problems.push('tab partition is persistent');

  const facts = [];
  for (const [tab, wc] of [[t1, wc1], [t2, wc2]]) {
    const f = await viewFacts(wc);
    facts.push(f);
    if (f.crossOriginIsolated !== true || f.sab !== 'function') problems.push(`tab ${tab.id} not isolated`);
    if (f.coop !== 'same-origin' || f.coep !== 'require-corp' || !f.csp.startsWith("default-src 'self'")) problems.push(`tab ${tab.id} headers`);
    if (f.bridge !== 'handoffToInput,onFileOpened,openFile,readFile,saveFile,takeOpenedFiles') problems.push(`tab ${tab.id} bridge ${f.bridge}`);
    if (f.shellBridge !== 'undefined') problems.push(`tab ${tab.id} sees the shell bridge`);
    if (f.nodeLeak !== 'undefined,undefined,undefined') problems.push(`tab ${tab.id} node leak`);
    if (f.notification !== 'denied') problems.push(`tab ${tab.id} notification ${f.notification}`);
    // Electron grants permissions when a session has no handler: a refusal recorded for THIS partition proves lockSession ran on it.
    if (!handle.permissionDecisions.some((d) => d.partition === tab.partition && d.permission === 'notifications' && d.granted === false)) {
      problems.push(`no permission decision recorded for ${tab.partition}`);
    }
  }

  // Storage: tab vs tab, and tab vs shell.
  await js(wc1, `localStorage.setItem('probe', 'one'); sessionStorage.setItem('probe', 'one'); true`);
  const seenBy2 = await js(wc2, `[localStorage.getItem('probe'), sessionStorage.getItem('probe')].join()`);
  await js(wc2, `localStorage.setItem('probe', 'two'); true`);
  const stillOne = await js(wc1, `localStorage.getItem('probe')`);
  const seenByShell = await js(handle.window.webContents, `localStorage.getItem('probe')`);
  if (seenBy2 !== ',' || stillOne !== 'one' || seenByShell !== null) problems.push(`storage shared: ${seenBy2} / ${stillOne} / ${seenByShell}`);

  // Switching through the shell IPC.
  const switched = await mustCall(handle, `window.bentoShell.switchTab(${t1.id})`);
  if (switched.activeTabId !== t1.id) problems.push('switchTab');
  const shellFacts = await js(handle.window.webContents, `({ isolated: window.crossOriginIsolated, bridge: typeof window.bentoDesktop, url: location.href })`);
  if (shellFacts.isolated !== true || shellFacts.bridge !== 'undefined') problems.push(`shell ${JSON.stringify(shellFacts)}`);
  const network = assertNoExternalRequests(ctx);
  if (problems.length) throw new Error(problems.join(' | '));
  return { facts, shellFacts, network, partitions: [t1.partition, t2.partition] };
}

const fileListed = (name) => `(() => { const t = document.querySelector('#file-list')?.textContent || ''; return t.includes(${JSON.stringify(name)}) ? t.replace(/\\s+/g, ' ').trim().slice(0, 120) : ''; })()`;

async function shellHandoff(ctx) {
  const { handle } = ctx;
  await openPdfs(ctx, ['merge-me.pdf']);
  const state = await mustCall(handle, `window.bentoShell.openTool('merge-pdf', null)`);
  const tab = state.tabs.find((t) => t.active);
  if (tab.toolId !== 'merge-pdf' || tab.docName !== 'merge-me.pdf') throw new Error(`tab ${JSON.stringify(tab)}`);
  const wc = handle.tabs.viewOf(tab.id).webContents;
  const listed = await waitIn(wc, fileListed('merge-me.pdf'), 20000, 'Merge PDF lists merge-me.pdf');
  const handoffs = handle.handoffs.slice();
  if (handoffs.length !== 1 || handoffs[0].count !== 1) throw new Error(`handoffs ${JSON.stringify(handoffs)}`);
  return { listed, handoffs, network: assertNoExternalRequests(ctx) };
}

async function shellMemcap(ctx) {
  const { handle } = ctx;
  await openPdfs(ctx, ['a.pdf']);
  const first = (await mustCall(handle, `window.bentoShell.openTool('merge-pdf', null)`)).activeTabId;
  const firstWc = handle.tabs.viewOf(first).webContents;
  await waitIn(firstWc, fileListed('a.pdf'), 20000, 'a.pdf listed before discard');
  await openPdfs(ctx, ['b.pdf', 'c.pdf']); // 3 tabs, cap 2: the first must be discarded
  const afterOpen = await mustCall(handle, 'window.bentoShell.getState()');
  const live = afterOpen.tabs.filter((t) => t.live).map((t) => t.id);
  const problems = [];
  if (afterOpen.tabs.length !== 3 || live.length !== 2 || live.includes(first)) problems.push(`live after open ${JSON.stringify(live)}`);
  if (!firstWc.isDestroyed()) problems.push('discarded view still has a live WebContents');
  if (!handle.store.has(handle.tabs.get(first).docId)) problems.push('document lost on discard');

  await mustCall(handle, `window.bentoShell.switchTab(${first})`);
  const reloaded = handle.tabs.viewOf(first).webContents;
  if (reloaded === firstWc || reloaded.isDestroyed()) problems.push('no fresh view on activation');
  if (!reloaded.getURL().endsWith('/merge-pdf.html')) problems.push(`reloaded ${reloaded.getURL()}`);
  const listed = await waitIn(reloaded, fileListed('a.pdf'), 20000, 'a.pdf handed off again after reload');
  const after = await mustCall(handle, 'window.bentoShell.getState()');
  if (after.tabs.filter((t) => t.live).length !== 2) problems.push('cap not kept after activation');
  if (problems.length) throw new Error(problems.join(' | '));
  return { first, liveAfterOpen: live, listed, handoffs: handle.handoffs.length, network: assertNoExternalRequests(ctx) };
}
shellMemcap.maxLive = 2;

/** A view the shell did not create, with a chosen preload and partition (an attacker who got the "other" bridge). */
async function rogueView(partition, preload, url) {
  const view = new WebContentsView({ webPreferences: { ...secureWebPreferences(preload), partition } });
  await view.webContents.loadURL(url);
  return view;
}

async function shellIpcReject(ctx) {
  const { handle } = ctx;
  const state = await openPdfs(ctx, ['x.pdf']);
  const tab = handle.tabs.get(state.activeTabId);
  const out = {};
  out.positive = (await shellCall(handle, 'window.bentoShell.listTools().then((t) => t.length)')).value;
  out.toolViewHasShellBridge = await js(handle.tabs.viewOf(tab.id).webContents, 'typeof window.bentoShell');

  const views = [];
  try {
    // Shell bridge inside a tool partition at bento://app: refused (not the shell WebContents, wrong origin).
    const a = await rogueView(tab.partition, SHELL_PRELOAD, `${handle.origin}/index.html`);
    views.push(a);
    out.shellIpcFromToolOrigin = await js(a.webContents, `window.bentoShell.listTools().then(() => 'ALLOWED', (e) => e.message)`);
    // Shell bridge in a SECOND page at the shell origin: refused only by the WebContents id check.
    const b = await rogueView(SHELL_PARTITION, SHELL_PRELOAD, `${handle.shellOrigin}/shell.html`);
    views.push(b);
    out.shellIpcFromSecondShellPage = await js(b.webContents, `window.bentoShell.getState().then(() => 'ALLOWED', (e) => e.message)`);
    // Tool bridge in the shell's partition at bento://shell: tool IPC refused (origin check).
    const c = await rogueView(SHELL_PARTITION, TOOL_PRELOAD, `${handle.shellOrigin}/shell.html`);
    views.push(c);
    out.toolIpcFromShellOrigin = await js(c.webContents, `window.bentoDesktop.openFile().then(() => 'ALLOWED', (e) => e.message)`);
    out.toolReadFromShellOrigin = await js(c.webContents, `window.bentoDesktop.takeOpenedFiles().then(() => 'ALLOWED', (e) => e.message)`);
    // A WebContents in the default session (no partition): its session is still locked,
    // so even a data: document is cancelled (Electron would load it without the lock).
    const d = new WebContentsView({ webPreferences: secureWebPreferences(undefined) });
    views.push(d);
    out.defaultSessionLoad = await d.webContents.loadURL('data:text/html,<title>x</title>').then(() => 'LOADED', (e) => e.code || e.message);
    out.defaultSessionBlocked = handle.blocked.some((b) => b.partition === 'default');
  } finally {
    for (const v of views) v.webContents.close();
  }
  const refused = (v) => typeof v === 'string' && v.includes('untrusted sender');
  const bad = [];
  if (!(out.positive > 100)) bad.push('positive control');
  if (out.toolViewHasShellBridge !== 'undefined') bad.push('tool view has bentoShell');
  for (const key of ['shellIpcFromToolOrigin', 'shellIpcFromSecondShellPage', 'toolIpcFromShellOrigin', 'toolReadFromShellOrigin']) {
    if (!refused(out[key])) bad.push(`${key}: ${out[key]}`);
  }
  if (out.defaultSessionLoad !== 'ERR_BLOCKED_BY_CLIENT' || !out.defaultSessionBlocked) bad.push('default session not locked');
  if (bad.length) throw new Error(`${bad.join(' | ')} :: ${JSON.stringify(out)}`);
  return out;
}

module.exports = { shellTabs, shellHandoff, shellMemcap, shellIpcReject };
