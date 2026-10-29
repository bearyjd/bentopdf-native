'use strict';

// Shell (M3a) scenarios. Each gets {handle, workDir, dialogState, requests} from
// shell-main.js and drives the shell through its REAL IPC (the shell page calls
// window.bentoShell), then inspects each tab's view directly.
const fs = require('node:fs');
const path = require('node:path');
const { WebContentsView } = require('electron');
const { secureWebPreferences } = require('../../src/security');
const { SHELL_PARTITION } = require('../../src/shell/shell-app');
const brand = require('../../brand.json');

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
  // TWO documents open; the tool is opened for the one that is NOT the active tab's.
  const opened = await openPdfs(ctx, ['merge-me.pdf', 'other.pdf']);
  const id = Object.fromEntries(opened.docs.map((d) => [d.name, d.id]));
  const before = handle.store.get(id['merge-me.pdf']).lastUsed;
  const started = Date.now();
  const state = await mustCall(handle, `window.bentoShell.openTool('merge-pdf', ${JSON.stringify(id['merge-me.pdf'])})`);
  const returnedAfterMs = Date.now() - started;
  const tab = state.tabs.find((t) => t.active);
  if (tab.toolId !== 'merge-pdf' || tab.docName !== 'merge-me.pdf') throw new Error(`tab ${JSON.stringify(tab)}`);
  const wc = handle.tabs.viewOf(tab.id).webContents;
  const listed = await waitIn(wc, fileListed('merge-me.pdf'), 20000, 'Merge PDF lists merge-me.pdf');
  const problems = [];
  if (await js(wc, fileListed('other.pdf'))) problems.push('the OTHER document was handed to the tool');
  for (let i = 0; i < 100 && handle.handoffs.length < 1; i += 1) await sleep(100); // the record follows the page's own list
  await sleep(300);
  const handoffs = handle.handoffs.slice();
  if (handoffs.length !== 1 || handoffs[0].count !== 1) problems.push(`handoffs ${JSON.stringify(handoffs)}`);
  if (handoffs[0] && handoffs[0].docId !== id['merge-me.pdf']) problems.push(`handed off doc ${handoffs[0].docId}, wanted ${id['merge-me.pdf']}`);
  if (!(handle.store.get(id['merge-me.pdf']).lastUsed > before)) problems.push('store.touch not called by the handoff');
  if (handle.store.has(id['other.pdf'])) problems.push('document no tab shows any more was not released');
  const after = await mustCall(handle, 'window.bentoShell.getState()');
  if (after.tabs.some((t) => t.status)) problems.push(`status left behind ${JSON.stringify(after.tabs.map((t) => t.status))}`);
  if (problems.length) throw new Error(problems.join(' | '));
  return { listed, handoffs, returnedAfterMs, network: assertNoExternalRequests(ctx) };
}

/**
 * A handoff that is still waiting (here: held in the beforeInject seam, where the grant is done) when
 * its tab navigates in-view to another tool must NOT inject into the new page, record a success or
 * leave an error behind.
 */
async function shellHandoffNavigated(ctx) {
  const { handle, hooks } = ctx;
  const opened = await openPdfs(ctx, ['stale.pdf']);
  let navigatedTo = null;
  hooks.beforeInject = async ({ tabId }) => {
    if (navigatedTo) return;
    const wc = handle.tabs.viewOf(tabId).webContents;
    await wc.loadURL('bento://app/split-pdf.html'); // as a link click inside the page would
    navigatedTo = wc.getURL();
  };
  await mustCall(handle, `window.bentoShell.openTool('merge-pdf', ${JSON.stringify(opened.docs[0].id)})`);
  for (let i = 0; i < 100 && !navigatedTo; i += 1) await sleep(100);
  if (!navigatedTo) throw new Error('the handoff never reached the injection seam');
  await sleep(4000); // longer than the settle delay a (wrongly) injected script would wait
  const tab = handle.tabs.list().find((t) => t.active);
  const wc = handle.tabs.viewOf(tab.id).webContents;
  const injected = await js(wc, `Array.from(document.querySelectorAll('input[type="file"]')).reduce((n, i) => n + i.files.length, 0)`);
  const status = (await mustCall(handle, 'window.bentoShell.getState()')).tabs.find((t) => t.id === tab.id).status;
  const problems = [];
  if (!navigatedTo.endsWith('/split-pdf.html')) problems.push(`navigated to ${navigatedTo}`);
  if (injected !== 0) problems.push(`${injected} file(s) were injected into the second page`);
  if (handle.handoffs.length !== 0) problems.push(`a stale handoff was recorded ${JSON.stringify(handle.handoffs)}`);
  if (status !== null) problems.push(`status ${JSON.stringify(status)}`);
  if (tab.toolId !== 'split-pdf') problems.push(`tab tool ${tab.toolId}`);
  if (problems.length) throw new Error(problems.join(' | '));
  return { navigatedTo };
}

/** Park a handoff in the beforeInject seam, run `disturb(wc, tabId)` there, then report what it left behind. */
async function runDisturbedHandoff(ctx, pdfName, disturb) {
  const { handle, hooks } = ctx;
  const opened = await openPdfs(ctx, [pdfName]);
  let reached = null;
  hooks.beforeInject = async ({ tabId }) => {
    if (reached) return;
    const wc = handle.tabs.viewOf(tabId).webContents;
    reached = { tabId, epoch: handle.tabs.get(tabId).epoch };
    await disturb(wc, tabId);
  };
  await mustCall(handle, `window.bentoShell.openTool('merge-pdf', ${JSON.stringify(opened.docs[0].id)})`);
  for (let i = 0; i < 100 && !reached; i += 1) await sleep(100);
  if (!reached) throw new Error('the handoff never reached the injection seam');
  await sleep(4500); // longer than the settle delay a (wrongly) injected script would wait
  const tab = handle.tabs.list().find((t) => t.id === reached.tabId);
  const wc = handle.tabs.viewOf(tab.id).webContents;
  const injected = await js(wc, `Array.from(document.querySelectorAll('input[type="file"]')).reduce((n, i) => n + i.files.length, 0)`);
  const status = (await mustCall(handle, 'window.bentoShell.getState()')).tabs.find((t) => t.id === tab.id).status;
  return { reached, tab, wc, injected, status, handoffs: handle.handoffs.length };
}

/**
 * A hash-only navigation while the handoff waits fires no did-navigate (so nothing else clears 'Loading...'),
 * keeps the URL on the target page (only the navigation epoch drops the handoff), and must leave no status behind.
 */
async function shellHandoffHashNav(ctx) {
  const r = await runDisturbedHandoff(ctx, 'hash.pdf', async (wc) => {
    await js(wc, `location.hash = '#moved'; true`);
    await sleep(300);
  });
  const problems = [];
  if (!r.wc.getURL().endsWith('/merge-pdf.html#moved')) problems.push(`url ${r.wc.getURL()}`);
  if (r.status !== null) problems.push(`status left behind ${JSON.stringify(r.status)}`);
  if (r.injected !== 0 || r.handoffs !== 0) problems.push(`stale handoff injected=${r.injected} recorded=${r.handoffs}`);
  if (problems.length) throw new Error(problems.join(' | '));
  return { url: r.wc.getURL() };
}

/** Same-URL reload while the handoff waits: the URL still matches, so only the navigation-epoch guard drops it. */
async function shellHandoffReload(ctx) {
  const r = await runDisturbedHandoff(ctx, 'reload.pdf', (wc) => new Promise((resolve) => {
    wc.once('did-finish-load', resolve);
    wc.reload();
  }));
  const problems = [];
  if (!r.wc.getURL().endsWith('/merge-pdf.html')) problems.push(`url ${r.wc.getURL()}`);
  if (r.tab.epoch <= r.reached.epoch) problems.push(`epoch did not move: ${r.reached.epoch} -> ${r.tab.epoch}`);
  if (r.injected !== 0 || r.handoffs !== 0) problems.push(`the handoff meant for the old page injected=${r.injected} recorded=${r.handoffs}`);
  if (r.status !== null) problems.push(`status ${JSON.stringify(r.status)}`);
  if (problems.length) throw new Error(problems.join(' | '));
  return { epoch: [r.reached.epoch, r.tab.epoch] };
}

/**
 * Stubbed wc: the epoch does NOT move, only getURL() reports another page, so only the URL re-check
 * before injecting can drop the handoff.
 */
async function shellHandoffUrlChanged(ctx) {
  let calls = 0;
  let stubbed = null;
  let r;
  try {
    r = await runDisturbedHandoff(ctx, 'url.pdf', async (wc) => {
      stubbed = wc;
      wc.getURL = () => 'bento://app/split-pdf.html'; // instance property shadows the prototype method
      const real = wc.executeJavaScript.bind(wc);
      wc.executeJavaScript = (code, ...rest) => {
        if (String(code).includes('handoffToInput')) calls += 1;
        return real(code, ...rest);
      };
    });
  } finally {
    if (stubbed) {
      delete stubbed.getURL; // restore the prototype methods even when the scenario threw
      delete stubbed.executeJavaScript;
    }
  }
  const problems = [];
  if (r.tab.epoch !== r.reached.epoch) problems.push(`epoch moved: ${r.reached.epoch} -> ${r.tab.epoch}`);
  if (calls !== 0 || r.injected !== 0 || r.handoffs !== 0) problems.push(`injected despite the URL change: calls=${calls} injected=${r.injected} recorded=${r.handoffs}`);
  if (r.status !== null) problems.push(`status left behind ${JSON.stringify(r.status)}`);
  if (problems.length) throw new Error(problems.join(' | '));
  return { epoch: r.tab.epoch };
}

/** A page can request a huge URL: the blocked-request log line must be bounded and one line. */
async function shellBlockedUrlLog(ctx) {
  const { handle } = ctx;
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return original(chunk, ...rest);
  };
  try {
    await mustCall(handle, `window.bentoShell.openTool('merge-pdf', null)`);
    const wc = handle.tabs.viewOf(handle.tabs.activeId()).webContents;
    await wc.loadURL(`https://example.invalid/${'a'.repeat(5000)}`).catch(() => {}); // ERR_ABORTED: the request is cancelled
    for (let i = 0; i < 50 && !lines.some((l) => l.includes('blocked request')); i += 1) await sleep(100);
  } finally {
    process.stderr.write = original;
  }
  const line = lines.find((l) => l.includes('blocked request'));
  const problems = [];
  if (!line) problems.push('no blocked-request log line');
  else {
    if (line.length > 450) problems.push(`log line is ${line.length} characters`);
    if (!line.includes('https://example.invalid/')) problems.push(`line ${line.slice(0, 100)}`);
    if (line.trimEnd().split('\n').length !== 1) problems.push('log line spans several lines');
  }
  if (problems.length) throw new Error(problems.join(' | '));
  return { length: line.length };
}

/** A failed handoff must reach the shell UI state, and the IPC must return before the handoff ends. */
async function shellHandoffError(ctx) {
  const { handle } = ctx;
  const file = writeMinimalPdf(path.join(ctx.workDir, 'swap.pdf'), 'original');
  ctx.dialogState.next = [file];
  await mustCall(handle, 'window.bentoShell.openFileDialog()');
  // Replace the file behind the same path (new inode): the grant must refuse it.
  const replacement = writeMinimalPdf(path.join(ctx.workDir, 'swap.tmp'), 'replacement with another inode');
  fs.renameSync(replacement, file);
  const started = Date.now();
  await mustCall(handle, `window.bentoShell.openTool('merge-pdf', null)`);
  const returnedAfterMs = Date.now() - started;
  const deadline = Date.now() + 20000;
  let status = null;
  while (Date.now() < deadline) {
    const tab = (await mustCall(handle, 'window.bentoShell.getState()')).tabs.find((t) => t.active);
    status = tab.status;
    if (status && status.kind === 'error') break;
    await sleep(200);
  }
  const problems = [];
  if (!status || status.kind !== 'error' || !status.text.includes('file changed since it was opened')) problems.push(`status ${JSON.stringify(status)}`);
  if (handle.handoffs.length !== 0) problems.push('a handoff was recorded for a refused grant');
  // The shell page itself must show it (the status line is what a person sees).
  const shown = await waitIn(handle.window.webContents, `document.getElementById('doc-status').textContent`, 5000, 'doc-status line');
  if (!shown.includes('file changed')) problems.push(`doc-status line ${shown}`);
  if (problems.length) throw new Error(problems.join(' | '));
  return { status, shown, returnedAfterMs };
}

/** Live-view limit (a weighted slot budget; the default weight of an ordinary tab is 1). */
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

  // The lockdown must still hold on the partition AFTER discard-and-reload (the session object is reused).
  const partition = handle.tabs.get(first).partition;
  const refusals = () => handle.permissionDecisions.filter((d) => d.partition === partition && d.permission === 'notifications' && d.granted === false).length;
  const refusalsBefore = refusals();
  const facts = await viewFacts(reloaded);
  if (facts.crossOriginIsolated !== true || facts.coop !== 'same-origin' || facts.coep !== 'require-corp' || !facts.csp.startsWith("default-src 'self'")) problems.push(`reloaded view headers ${JSON.stringify(facts)}`);
  if (facts.notification !== 'denied' || refusals() <= refusalsBefore) problems.push('permission lock not applied after reload');
  if (facts.shellBridge !== 'undefined' || facts.nodeLeak !== 'undefined,undefined,undefined') problems.push('reloaded view bridge/node leak');
  const network = assertNoExternalRequests(ctx);
  const blockedBefore = handle.blocked.length;
  const external = await reloaded.loadURL('https://example.invalid/').then(() => 'LOADED', (e) => e.code || e.message);
  // ERR_ABORTED: the failure handler replaces the blocked page with its error page; the proof is the blocked record.
  if (external === 'LOADED' || !handle.blocked.slice(blockedBefore).some((b) => b.partition === partition && b.url.startsWith('https://example.invalid'))) {
    problems.push(`external request after reload: ${external}`);
  }
  if (problems.length) throw new Error(problems.join(' | '));
  return { first, liveAfterOpen: live, listed, handoffs: handle.handoffs.length, network, lockdownAfterReload: { facts, external } };
}
shellMemcap.liveBudget = 2;

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

  // Native dialogs belong to the ACTIVE tab only: a hidden background tab gets nothing.
  await openPdfs(ctx, ['y.pdf']); // tab 2 is now active, tab 1 is a hidden background tab
  const background = handle.tabs.viewOf(tab.id).webContents;
  const foreground = handle.tabs.viewOf(handle.tabs.activeId()).webContents;
  out.dialogBackgroundOpen = await js(background, `window.bentoDesktop.openFile().then(() => 'ALLOWED', (e) => e.message)`);
  out.dialogBackgroundSave = await js(background, `window.bentoDesktop.saveFile('a.pdf', new Uint8Array(1)).then(() => 'ALLOWED', (e) => e.message)`);
  out.dialogActiveOpen = await js(foreground, `window.bentoDesktop.openFile().then((r) => 'OK:' + r.length, (e) => e.message)`);

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
  for (const key of ['dialogBackgroundOpen', 'dialogBackgroundSave']) if (!String(out[key]).includes('only available to the active tab')) bad.push(`${key}: ${out[key]}`);
  if (out.dialogActiveOpen !== 'OK:1') bad.push(`dialogActiveOpen: ${out.dialogActiveOpen}`);
  if (out.toolViewHasShellBridge !== 'undefined') bad.push('tool view has bentoShell');
  for (const key of ['shellIpcFromToolOrigin', 'shellIpcFromSecondShellPage', 'toolIpcFromShellOrigin', 'toolReadFromShellOrigin']) {
    if (!refused(out[key])) bad.push(`${key}: ${out[key]}`);
  }
  if (out.defaultSessionLoad !== 'ERR_BLOCKED_BY_CLIENT' || !out.defaultSessionBlocked) bad.push('default session not locked');
  if (bad.length) throw new Error(`${bad.join(' | ')} :: ${JSON.stringify(out)}`);
  return out;
}

/** Documents are freed, concurrent opens do not duplicate, closed tabs' sessions are emptied, the title is the brand. */
async function shellLifecycle(ctx) {
  const { handle } = ctx;
  const problems = [];
  const file = writeMinimalPdf(path.join(ctx.workDir, 'same.pdf'), 'same');
  await Promise.all([handle.openPath(file), handle.openPath(file), handle.openPath(file)]);
  if (handle.store.list().length !== 1 || handle.tabs.list().length !== 1) problems.push(`concurrent opens: ${handle.store.list().length} documents, ${handle.tabs.list().length} tabs`);
  await mustCall(handle, `window.bentoShell.closeTab(${handle.tabs.activeId()})`);
  if (handle.store.list().length !== 0) problems.push('document kept after its last tab closed');

  // 33 distinct PDFs opened and closed one after another: the old store refused the 33rd forever.
  for (let i = 0; i < 33; i += 1) {
    const doc = await handle.openPath(writeMinimalPdf(path.join(ctx.workDir, `many-${i}.pdf`), String(i)));
    const tab = handle.tabs.list().find((t) => t.docId === doc.id);
    if (!tab) throw new Error(`no tab for document ${i}`);
    await mustCall(handle, `window.bentoShell.closeTab(${tab.id})`);
    if (handle.store.has(doc.id)) problems.push(`document ${i} not released`);
  }
  if (handle.store.list().length !== 0 || handle.tabs.list().length !== 0) problems.push('documents or tabs left over');

  // A closed tab's session is emptied (best effort; Electron cannot destroy a Session).
  const opened = await openPdfs(ctx, ['storage.pdf']);
  const tab = handle.tabs.get(opened.activeTabId);
  await js(handle.tabs.viewOf(tab.id).webContents, `localStorage.setItem('k', 'secret'); true`);
  await mustCall(handle, `window.bentoShell.closeTab(${tab.id})`);
  const probe = await rogueView(tab.partition, TOOL_PRELOAD, `${handle.origin}/index.html`);
  try {
    const left = await js(probe.webContents, `localStorage.getItem('k')`);
    if (left !== null) problems.push(`closed tab's localStorage survived: ${left}`);
  } finally {
    probe.webContents.close();
  }

  if (handle.window.getTitle() !== brand.productName) problems.push(`window title ${handle.window.getTitle()}`);
  if (problems.length) throw new Error(problems.join(' | '));
  return { title: handle.window.getTitle() };
}

/** Closing the shell destroys every tab's WebContents and removes the resize listener before the window goes. */
async function shellTeardown(ctx) {
  const { handle } = ctx;
  await openPdfs(ctx, ['t1.pdf', 't2.pdf', 't3.pdf']);
  const contents = handle.tabs.list().map((t) => handle.tabs.viewOf(t.id).webContents);
  const win = handle.window;
  const resizeBefore = win.listenerCount('resize');
  let resizeAtDestroy = null;
  const realDestroy = win.destroy.bind(win);
  win.destroy = () => {
    resizeAtDestroy = win.listenerCount('resize');
    realDestroy();
  };
  try {
    await handle.close();
  } finally {
    delete win.destroy; // drop the instance stub so the prototype method is back
  }
  const deadline = Date.now() + 5000;
  while (contents.some((wc) => !wc.isDestroyed()) && Date.now() < deadline) await sleep(100);
  const problems = [];
  if (contents.length !== 3) problems.push(`expected 3 tab views, saw ${contents.length}`);
  if (contents.some((wc) => !wc.isDestroyed())) problems.push('a tab WebContents outlived the window teardown');
  if (!(resizeBefore > 0) || resizeAtDestroy !== 0) problems.push(`resize listeners: ${resizeBefore} before, ${resizeAtDestroy} when the window was destroyed`);
  if (!win.isDestroyed()) problems.push('window not destroyed');
  if (problems.length) throw new Error(problems.join(' | '));
  return { resizeBefore, resizeAtDestroy };
}

module.exports = { shellTabs, shellHandoff, shellHandoffError, shellHandoffNavigated, shellHandoffHashNav, shellHandoffReload, shellHandoffUrlChanged, shellBlockedUrlLog, shellMemcap, shellIpcReject, shellLifecycle, shellTeardown };
