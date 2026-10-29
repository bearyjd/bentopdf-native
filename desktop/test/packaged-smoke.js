'use strict';

// Headless smoke test of a PACKAGED AppImage. Usage:
//   node test/packaged-smoke.js <file.AppImage>
// A packaged build honours test mode (the debug port, headless platform) only when BENTO_TEST_HEADLESS=1
// AND the file resources/.bento-test-mode exist (src/test-mode.js). So this runner extracts the AppImage
// into a disposable temp directory (--appimage-extract), creates the marker in that COPY only, and
// runs the extracted binary directly with the env (AppRun scrubs BENTO_* for normal launches; a
// separate check proves AppRun still does, and another that the copy without the marker refuses).
// Flatpak and deb/rpm are not supported here. The release artifact is never modified.
// Launches with --ozone-platform=headless, hostile BENTO_* environment variables and a PDF argument, then
// drives the pages (a tool tab and the shell UI, see docs/shell.md) over the Chromium DevTools protocol
// (a Chromium flag, so it needs no hook in the app).
// SMOKE_NO_PDF=1 starts it without a PDF argument (a home tab instead of a document tab).
// Nothing is ever shown on screen. Exit code is non-zero on any failed check.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = process.argv[2];
if (!target || !target.endsWith('.AppImage')) {
  process.stderr.write('usage: packaged-smoke.js <file.AppImage>\n');
  process.exit(2);
}
const { executableName } = require('../brand.json');
const { MARKER_NAME, MARKER_CONTENT } = require('../src/test-mode');
const tmpBase = os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(); // short: Chromium's single-instance socket path
const work = fs.mkdtempSync(path.join(tmpBase, 'bento-pkg-'));
const profile = path.join(work, 'profile');
const pdfA = path.join(work, 'first.pdf');
const pdfB = path.join(work, 'second.pdf');
const appRoot = path.join(work, 'squashfs-root'); // the disposable copy of the AppImage
const binary = path.join(appRoot, executableName);
const marker = path.join(appRoot, 'resources', MARKER_NAME);
fs.writeFileSync(pdfA, '%PDF-1.4\nfirst\n');
fs.writeFileSync(pdfB, '%PDF-1.4\nsecond\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}\n`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await wait(250);
  }
}

// SMOKE_EXTRA_ARGS exists only for negative controls (e.g. --no-sandbox must make this test fail).
const extra = (process.env.SMOKE_EXTRA_ARGS || '').split(' ').filter(Boolean);
const appArgs = ['--ozone-platform=headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...extra];
const extractCopy = () => {
  fs.chmodSync(target, 0o755);
  const r = spawnSync(path.resolve(target), ['--appimage-extract'], { cwd: work, stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(binary)) throw new Error('could not extract the AppImage');
};
const writeMarker = () => fs.writeFileSync(marker, MARKER_CONTENT, { mode: 0o644 });
// `exe` is the extracted binary (needs the marker) or the extracted AppRun (scrubs the env).
const launch = (files, { exe = binary, args = appArgs } = {}) => {
  const child = spawn(exe, [...args, ...files], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    // The packaged app must ignore all of these except the test mode, which the marker unlocks in this copy.
    env: { ...process.env, BENTO_TEST_HEADLESS: '1', TMPDIR: tmpBase, BENTO_DIST: '/nonexistent', BENTO_TRANSPORT: 'carrier-pigeon' },
  });
  const out = { stderr: '', child };
  child.stderr.on('data', (c) => (out.stderr += c));
  return out;
};
const exitOf = (run) => until(() => run.child.exitCode !== null && { code: run.child.exitCode }, 90000, 'exit').catch(() => ({ code: 'timeout' }));

// Negative controls: without the marker the binary refuses the debug port; and AppRun scrubs the env even with the marker.
async function refusalChecks() {
  const noMarker = await exitOf(launch([]));
  check('copy WITHOUT the marker refuses the test switches (exit 2)', noMarker.code === 2, `exit=${noMarker.code}`);
  writeMarker();
  const viaAppRun = launch([], { exe: path.join(appRoot, 'AppRun') });
  const scrubbed = await exitOf(viaAppRun);
  check('AppRun scrubs BENTO_TEST_HEADLESS: copy WITH the marker via AppRun refuses (exit 2, no debug port)',
    scrubbed.code === 2 && !/DevTools listening/.test(viaAppRun.stderr) && /unsafe switch/.test(viaAppRun.stderr), `exit=${scrubbed.code}`);
}

function descendants(rootPid) {
  const parent = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      parent.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* process exited */ }
  }
  const found = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent) if (found.has(ppid) && !found.has(pid)) { found.add(pid); grew = true; }
  }
  return [...found];
}
const proc = (pid, file) => fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
const statusField = (pid, key) => (proc(pid, 'status').match(new RegExp(`^${key}:\\s*(.*)$`, 'm')) || [])[1];

class Cdp {
  constructor(url) { this.id = 0; this.pending = new Map(); this.ws = new WebSocket(url); }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP socket error'));
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        const waiter = this.pending.get(msg.id);
        if (waiter) { this.pending.delete(msg.id); (msg.error ? waiter.reject : waiter.resolve)(msg.error ? new Error(msg.error.message) : msg.result); }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async js(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)}`);
    return r.result.value;
  }
}

// Since M3a the window is the tabbed shell: an opened PDF becomes a document tab,
// visible in the shell UI's state (bento://shell, its own bridge).
const shellHasDoc = (shellCdp, name) =>
  shellCdp.js(`window.bentoShell.getState().then((s) => s.tabs.some((t) => t.docName === ${JSON.stringify(name)}))`);

async function secondInstance(shellCdp) {
  const second = launch([pdfB]);
  const exited = await until(() => second.child.exitCode !== null && { code: second.child.exitCode }, 60000, 'second instance exit').catch(() => ({ code: 'timeout' }));
  check('second instance exits cleanly', exited.code === 0, `exit=${exited.code}`);
  check('second instance forwarded its PDF to the first (new document tab)', await until(() => shellHasDoc(shellCdp, 'second.pdf'), 20000, 'forwarded file').catch(() => false));
  try { process.kill(-second.child.pid, 'SIGKILL'); } catch { /* gone */ }
}

async function main() {
  extractCopy();
  await refusalChecks();
  const first = launch(process.env.SMOKE_NO_PDF ? [] : [pdfA]);
  try {
    const port = await until(() => (first.stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/) || [])[1], 90000, 'DevTools port');
    const findPage = (prefix) => until(async () => {
      const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
      return list.find((t) => t.type === 'page' && t.url.startsWith(prefix));
    }, 90000, `a ${prefix} page`);
    const pageInfo = await findPage('bento://app/');
    check('window loads bento://app', pageInfo.url.startsWith('bento://app/'), pageInfo.url);
    const cdp = new Cdp(pageInfo.webSocketDebuggerUrl);
    await cdp.open();

    const page = await cdp.js(`({
      isolated: window.crossOriginIsolated,
      origin: location.origin,
      external: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => !/^(bento:\\/\\/app\\/|blob:bento:\\/\\/app|data:)/.test(n)),
      leak: [typeof require, typeof process, typeof module].join(','),
      bridge: Object.keys(window.bentoDesktop || {}).sort().join(','),
      shellBridge: typeof window.bentoShell
    })`);
    check('crossOriginIsolated is true', page.isolated === true);
    check('no external resource requests', page.external.length === 0 && !/blocked request/.test(first.stderr), JSON.stringify(page.external));
    check('no Node globals in the page', page.leak === 'undefined,undefined,undefined', page.leak);
    check('file bridge exposed', /takeOpenedFiles/.test(page.bridge), page.bridge);
    check('tool page has no shell bridge', page.shellBridge === 'undefined', page.shellBridge);
    check('BENTO_DIST/BENTO_TRANSPORT in the environment were ignored (app started on the scheme transport)', page.origin === 'bento://app', page.origin);

    // Sandbox: every renderer must be seccomp-filtered, no-new-privs, capability-free, in its own user namespace.
    const pids = descendants(first.child.pid);
    // Chromium rewrites argv of forked children into one space-joined string, so split on both.
    const cmd = (pid) => { try { return proc(pid, 'cmdline').split(/[\0 ]/).filter(Boolean); } catch { return []; } };
    const renderers = pids.filter((pid) => cmd(pid).includes('--type=renderer'));
    check('at least one renderer process found', renderers.length > 0, `pids ${renderers.join(',')}`);
    const browserPid = pids.find((pid) => cmd(pid).some((a) => /bentopdf-native$/.test(a)) && !cmd(pid).some((a) => a.startsWith('--type=')));
    for (const pid of renderers) {
      const seccomp = statusField(pid, 'Seccomp');
      const nnp = statusField(pid, 'NoNewPrivs');
      const caps = statusField(pid, 'CapEff');
      const userNs = fs.readlinkSync(`/proc/${pid}/ns/user`);
      const browserNs = browserPid ? fs.readlinkSync(`/proc/${browserPid}/ns/user`) : '';
      check(`renderer ${pid} sandboxed`, seccomp === '2' && nnp === '1' && /^0+$/.test(caps), `Seccomp=${seccomp} NoNewPrivs=${nnp} CapEff=${caps} userns=${userNs === browserNs ? 'shared-with-browser' : 'separate'}`);
    }
    const allCmd = pids.flatMap(cmd);
    check('no --no-sandbox on any process', !allCmd.includes('--no-sandbox'));
    check('no --inspect/--remote-debugging-pipe/--enable-logging flags beyond the test\'s own', !allCmd.some((a) => /^--inspect|^--js-flags/.test(a)));

    // "Open with": the argv path was validated into the document store and opened in a tab.
    const shellCdp = new Cdp((await findPage('bento://shell/')).webSocketDebuggerUrl);
    await shellCdp.open();
    if (process.env.SMOKE_NO_PDF) {
      check('no argument: a home tab and no document', await until(() => shellCdp.js(`window.bentoShell.getState().then((s) => s.tabs.length === 1 && s.docs.length === 0)`), 20000, 'home tab').catch(() => false));
    } else {
      check('launch-argument PDF opened as a document tab', await until(() => shellHasDoc(shellCdp, 'first.pdf'), 20000, 'first.pdf tab').catch(() => false));
    }
    // The shell UI came out of the asar, with the brand title set by the main process (packaged-only facts).
    const shellFacts = await shellCdp.js(`({ origin: location.origin, ready: document.body.dataset.ready, tools: document.querySelectorAll('#tools button').length })`);
    check('shell UI served from the packaged asar (bento://shell, ready, tool list rendered)', shellFacts.origin === 'bento://shell' && shellFacts.ready === 'true' && shellFacts.tools > 100, JSON.stringify(shellFacts));

    // Second instance forwards its file to the first (single-instance lock).
    await secondInstance(shellCdp);
  } finally {
    try { process.kill(-first.child.pid, 'SIGTERM'); } catch { /* gone */ }
    await wait(1500);
    try { process.kill(-first.child.pid, 'SIGKILL'); } catch { /* gone */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main()
  .catch((err) => check(`smoke test ran to completion (${err.message})`, false))
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    process.stdout.write(`${results.length - failed}/${results.length} checks passed\n`);
    process.exit(failed ? 1 : 0);
  });
