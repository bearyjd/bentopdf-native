'use strict';

// Headless smoke test of a PACKAGED build. Usage:
//   node test/packaged-smoke.js <AppImage | path/to/bentopdf-native | flatpak:<app-id>>
// For flatpak: the app is run with test-only overrides (--share=network so the
// host can reach the DevTools port, --filesystem=<temp dir> for the test PDFs);
// the shipped manifest grants neither. The second-instance check is skipped there
// (each `flatpak run` has its own sandbox /tmp, so Chromium's singleton socket is not shared).
// Launches the real artifact with --ozone-platform=headless, hostile BENTO_*
// environment variables and a PDF argument, then drives the page over the
// Chromium DevTools protocol (a Chromium flag, so it needs no hook in the app).
// Nothing is ever shown on screen. Exit code is non-zero on any failed check.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  process.stderr.write('usage: packaged-smoke.js <AppImage|binary>\n');
  process.exit(2);
}
const tmpBase = os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(); // short: Chromium's single-instance socket path
const work = fs.mkdtempSync(path.join(tmpBase, 'bento-pkg-'));
const profile = path.join(work, 'profile');
const pdfA = path.join(work, 'first.pdf');
const pdfB = path.join(work, 'second.pdf');
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
const isFlatpak = target.startsWith('flatpak:');
const launch = (files) => {
  const isImage = target.endsWith('.AppImage');
  const command = isFlatpak ? 'flatpak' : target;
  const args = isFlatpak
    ? ['run', '--user', '--share=network', '--env=BENTO_TEST_HEADLESS=1', `--filesystem=${work}`, target.slice('flatpak:'.length), ...appArgs, ...files]
    : [...(isImage ? ['--appimage-extract-and-run'] : []), ...appArgs, ...files];
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    // The packaged app must ignore all of these.
    env: { ...process.env, BENTO_TEST_HEADLESS: '1', TMPDIR: tmpBase, BENTO_DIST: '/nonexistent', BENTO_TRANSPORT: 'carrier-pigeon' },
  });
  const out = { stderr: '', child };
  child.stderr.on('data', (c) => (out.stderr += c));
  return out;
};

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

async function secondInstance(cdp) {
  await cdp.js('window.__opened = []; window.bentoDesktop.onFileOpened((f) => window.__opened.push(f.name)); true');
  const second = launch([pdfB]);
  const exited = await until(() => second.child.exitCode !== null && { code: second.child.exitCode }, 60000, 'second instance exit').catch(() => ({ code: 'timeout' }));
  check('second instance exits cleanly', exited.code === 0, `exit=${exited.code}`);
  check('second instance forwarded its PDF to the first', await until(() => cdp.js('window.__opened.includes("second.pdf")'), 20000, 'forwarded file').catch(() => false));
  try { process.kill(-second.child.pid, 'SIGKILL'); } catch { /* gone */ }
}

async function main() {
  const first = launch([pdfA]);
  try {
    const port = await until(() => (first.stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/) || [])[1], 90000, 'DevTools port');
    const pageInfo = await until(async () => {
      const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
      return list.find((t) => t.type === 'page' && t.url.startsWith('bento://app/'));
    }, 90000, 'a bento://app page');
    check('window loads bento://app', pageInfo.url.startsWith('bento://app/'), pageInfo.url);
    const cdp = new Cdp(pageInfo.webSocketDebuggerUrl);
    await cdp.open();

    const page = await cdp.js(`({
      isolated: window.crossOriginIsolated,
      origin: location.origin,
      external: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => !/^(bento:\\/\\/app\\/|blob:bento:\\/\\/app|data:)/.test(n)),
      leak: [typeof require, typeof process, typeof module].join(','),
      bridge: Object.keys(window.bentoDesktop || {}).sort().join(',')
    })`);
    check('crossOriginIsolated is true', page.isolated === true);
    check('no external resource requests', page.external.length === 0 && !/blocked request/.test(first.stderr), JSON.stringify(page.external));
    check('no Node globals in the page', page.leak === 'undefined,undefined,undefined', page.leak);
    check('file bridge exposed', /takeOpenedFiles/.test(page.bridge), page.bridge);
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

    // "Open with": argv path became a grant that the page can take and read.
    const taken = await cdp.js('window.bentoDesktop.takeOpenedFiles()');
    check('launch-argument PDF delivered through the grant bridge', taken.length === 1 && taken[0].name === 'first.pdf', JSON.stringify(taken));
    const head = await cdp.js(`window.bentoDesktop.readFile(${JSON.stringify(taken[0] && taken[0].token)}).then((b) => new TextDecoder().decode(b.slice(0, 8)))`);
    check('granted file is readable via its token', head === '%PDF-1.4', head);

    // Second instance forwards its file to the first (single-instance lock).
    if (!isFlatpak) await secondInstance(cdp);
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
