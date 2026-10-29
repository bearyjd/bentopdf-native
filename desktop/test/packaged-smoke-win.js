'use strict';

// Headless smoke test of a PACKAGED Windows build (installed tree, win-unpacked or portable exe).
//   node test/packaged-smoke-win.js <path-to-exe>
// Launches the real executable in test mode (BENTO_TEST_HEADLESS=1: the window is created hidden and
// never shown), with hostile BENTO_* variables and a PDF argument, then drives the page over the
// Chromium DevTools protocol (port read from <profile>/DevToolsActivePort). Every check runs even
// after a failure; the exit code is non-zero if any failed. Windows only: it uses taskkill.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const exe = process.argv[2];
if (!exe || process.platform !== 'win32') {
  process.stderr.write('usage (Windows only): packaged-smoke-win.js <exe>\n');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-win-'));
const profile = path.join(work, 'profile');
const spaced = path.join(work, 'dir with space');
fs.mkdirSync(spaced);
const pdfA = path.join(work, 'first.pdf');
const pdfB = path.join(spaced, 'second \u00fc.pdf');
const pdfC = path.join(work, 'third.pdf');
for (const [file, text] of [[pdfA, 'first'], [pdfB, 'second'], [pdfC, 'third']]) fs.writeFileSync(file, `%PDF-1.4\n${text}\n`);

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

const traceDir = path.join(work, 'trace');
fs.mkdirSync(traceDir);
let launchCount = 0;
// Per-process trace files (BENTO_TEST_TRACE_DIR, test mode only) and Chromium's own log, so a process that
// dies early still leaves evidence.
const baseEnv = () => ({
  ...process.env,
  BENTO_DIST: 'Z:\\nonexistent',
  BENTO_TRANSPORT: 'carrier-pigeon',
  BENTO_TEST_TRACE_DIR: traceDir,
  ELECTRON_ENABLE_LOGGING: '1',
  ELECTRON_LOG_FILE: path.join(traceDir, `chromium-launch${++launchCount}.log`),
});
const testArgs = [`--user-data-dir=${profile}`];
function launch(args, { testMode = true } = {}) {
  const child = spawn(exe, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: testMode ? { ...baseEnv(), BENTO_TEST_HEADLESS: '1' } : baseEnv(),
  });
  const out = { stderr: '', child };
  child.stderr.on('data', (c) => (out.stderr += c));
  return out;
}
const killTree = (child) => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });

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

const eventsFile = path.join(profile, 'bento-test-events.log');
const readEvents = () => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '');

function dumpTraces() {
  for (const name of fs.readdirSync(traceDir).sort()) {
    process.stdout.write(`--- ${name}\n${fs.readFileSync(path.join(traceDir, name), 'utf8').slice(0, 2500)}\n`);
  }
}

const UNC = '\\\\127.0.0.1\\c$\\unc-refused.pdf';

// Process list, for the case where a launch does not exit: shows where a portable stub is stuck.
function describeProcesses() {
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'portable|BentoPDF|bento' } | ForEach-Object { '{0} ppid={1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
  process.stdout.write(`processes while a launch is stuck:\n${(r.stdout || r.stderr || '(none)').slice(0, 1500)}\n`);
}

// One second-instance launch. Returns the exit code, the events it produced in the first instance's log and
// whether it reached main.js (its own trace file appeared). Absence of an event is never read as a refusal.
async function launchSecond(args, label) {
  const eventsBefore = readEvents().length;
  const tracesBefore = new Set(fs.readdirSync(traceDir));
  const second = launch([...testArgs, ...args]);
  const exited = await until(() => second.child.exitCode !== null && { code: second.child.exitCode }, 30000, 'second instance exit').catch(() => ({ code: 'timeout' }));
  if (exited.code === 'timeout') describeProcesses();
  await wait(1500);
  const events = readEvents().slice(eventsBefore);
  const reachedMainJs = fs.readdirSync(traceDir).some((f) => f.startsWith('trace-') && !tracesBefore.has(f));
  process.stdout.write(`launch [${label}]: exit=${exited.code} reachedMainJs=${reachedMainJs} stderr=${second.stderr.slice(0, 160).replace(/\s+/g, ' ')}\n`);
  killTree(second.child);
  return { code: exited.code, events, reachedMainJs };
}

async function secondInstance(cdp) {
  await cdp.js('window.__opened = []; window.bentoDesktop.onFileOpened((f) => window.__opened.push(f.name)); true');
  // The registered open command passes exactly one "%1", so each argument kind is its own launch.
  const space = await launchSecond([pdfB], 'backslash path with space and non-ASCII');
  check('second instance (path with space + non-ASCII) exits cleanly', space.code === 0, `exit=${space.code}`);
  check('second-instance event for it arrived in the first instance (positive evidence)', /second-instance argv=.*second \u00fc\.pdf/.test(space.events), 'no event in the test event log');
  check('second instance: backslash path with space and non-ASCII reached the first instance (grant)', await until(() => cdp.js('window.__opened.includes("second \\u00fc.pdf")'), 20000, 'forwarded file').catch(() => false));

  const url = await launchSecond([pathToFileURL(pdfC).href], 'file:///C:/... URL');
  check('second instance (file URL) exits cleanly', url.code === 0, `exit=${url.code}`);
  check('second-instance event for the file URL arrived (positive evidence)', /second-instance argv=.*third\.pdf/.test(url.events), 'no event in the test event log');
  check('second instance: file:///C:/... URL reached the first instance (grant)', await until(() => cdp.js('window.__opened.includes("third.pdf")'), 20000, 'forwarded URL').catch(() => false));

  // UNC and the policy checks are only meaningful when the event provably arrived and was processed:
  // "nothing was granted" must never be mistaken for "refused".
  const unc = await launchSecond([UNC], 'UNC path');
  const delivered = /second-instance argv=.*unc-refused\.pdf/.test(unc.events);
  check('second-instance event for the UNC path arrived (positive evidence)', delivered, 'no event in the test event log');
  check('second instance: UNC path was refused (no grant)', delivered && !unc.events.includes('granted unc-refused.pdf') && !(await cdp.js('window.__opened.includes("unc-refused.pdf")')), delivered ? '' : 'nothing delivered, refusal not proven');
  const all = [space, url, unc].map((r) => r.events).join('');
  check('second instance: argv was not rejected by the switch policy (shows what Windows injects)', delivered && !/ignored second launch/.test(all), delivered ? (all.match(/ignored second launch.*/) || [''])[0] : 'nothing delivered, policy not exercised');

  // Diagnostic only (INFO, not a check): the exact multi-argument launch that died with exit 0xFFFFFFFF before
  // main.js in earlier runs, and its pairs. Explorer never produces it (the open command has one "%1").
  const combos = { 'space+url+unc': [pdfB, pathToFileURL(pdfC).href, UNC], 'space+url': [pdfB, pathToFileURL(pdfC).href], 'space+unc': [pdfB, UNC], 'url+unc': [pathToFileURL(pdfC).href, UNC] };
  for (const [name, args] of Object.entries(combos)) await launchSecond(args, `INFO multi-argument ${name}`);
}

async function slashSwitchRefused() {
  const probe = launch(['/no-sandbox'], { testMode: false });
  const exited = await until(() => probe.child.exitCode !== null && { code: probe.child.exitCode }, 60000, 'probe exit').catch(() => ({ code: 'timeout' }));
  // The portable stub does not forward stderr, so there only the exit code can be checked.
  check('/no-sandbox is refused at start (exit 2)', exited.code === 2 && (probe.stderr === '' || /refusing to start with unsafe switch/.test(probe.stderr)), `exit=${exited.code} ${probe.stderr.slice(0, 200).replace(/\s+/g, ' ')}`);
  killTree(probe.child);
}

async function main() {
  const first = launch([...testArgs, '--remote-debugging-port=0', pdfA]);
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const port = await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 120000, 'DevToolsActivePort');
    const pageInfo = await until(async () => {
      const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
      return list.find((t) => t.type === 'page' && t.url.startsWith('bento://app/'));
    }, 120000, 'a bento://app page');
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

    // OS-level sandbox, as reported by Electron's app.getAppMetrics() in test mode.
    const metricsFile = path.join(profile, 'bento-test-sandbox.json');
    const metrics = await until(() => fs.existsSync(metricsFile) && JSON.parse(fs.readFileSync(metricsFile, 'utf8')), 30000, 'sandbox metrics').catch(() => []);
    const tabs = metrics.filter((p) => p.type === 'Tab');
    check('at least one renderer (Tab) process reported', tabs.length > 0, JSON.stringify(metrics));
    for (const tab of tabs) check('renderer is sandboxed at a low integrity level', tab.sandboxed === true && ['untrusted', 'low'].includes(tab.integrityLevel), JSON.stringify(tab));
    check('no --no-sandbox on the launch command', !JSON.stringify(first.child.spawnargs).includes('no-sandbox'));

    const taken = await cdp.js('window.bentoDesktop.takeOpenedFiles()');
    check('launch-argument PDF delivered through the grant bridge', taken.length === 1 && taken[0].name === 'first.pdf', JSON.stringify(taken));
    const head = await cdp.js(`window.bentoDesktop.readFile(${JSON.stringify(taken[0] && taken[0].token)}).then((b) => new TextDecoder().decode(b.slice(0, 8)))`);
    check('granted file is readable via its token', head === '%PDF-1.4', head);

    await secondInstance(cdp);
  } finally {
    killTree(first.child);
    await wait(1500);
    process.stdout.write(`first instance stderr (first 3000 chars): ${first.stderr.slice(0, 3000).replace(/\s+/g, ' ')}\n`);
    process.stdout.write(`test events:\n${readEvents().slice(0, 4000) || '(none)'}\n`);
    dumpTraces();
  }
  await slashSwitchRefused();
}

main()
  .catch((err) => check(`smoke test ran to completion (${err.message})`, false))
  .finally(() => {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* profile still locked: the runner is discarded anyway */ }
    const failed = results.filter((r) => !r.ok).length;
    process.stdout.write(`${results.length - failed}/${results.length} checks passed\n`);
    process.exit(failed ? 1 : 0);
  });
