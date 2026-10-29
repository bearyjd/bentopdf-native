'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { CHANNELS } = require('../src/channels');
const { MAX_OPEN_ARGS, pdfPathsFromArgv, validateOpenPath, validateLocalFile } = require('../src/open-file');
const { registerIpc } = require('../src/ipc');
const { aboutDetail, buildMenuTemplate, SOURCE_URL } = require('../src/menu');

const ORIGIN = 'bento://app';
const WIN = process.platform === 'win32';
const POSIX_ONLY = WIN && 'POSIX-only: named pipes (mkfifo) do not exist on Windows';
// The lexical argv rules take an explicit platform, so the POSIX cases do not depend on the host.
const posix = { platform: 'linux' };
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-open-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('pdfPathsFromArgv: keeps only .pdf names, skips flags and the executable, resolves against cwd', () => {
  const argv = ['/opt/app/bentopdf', '--ozone-platform-hint=auto', 'a.PDF', '/abs/b.pdf', 'notes.txt', '--x.pdf', '', 'evil\0.pdf', 42];
  assert.deepEqual(pdfPathsFromArgv(argv, { cwd: '/work', ...posix }), ['/work/a.PDF', '/abs/b.pdf']);
});

test('pdfPathsFromArgv: file:// URLs (the %U field code) are decoded; remote hosts and non-pdf URLs are dropped', () => {
  const argv = ['exe', 'file:///home/u/My%20Doc.pdf', 'file://evil.example/share/x.pdf', 'file:///etc/passwd', 'https://x.example/a.pdf', 'file:///bad%00.pdf'];
  assert.deepEqual(pdfPathsFromArgv(argv, posix), ['/home/u/My Doc.pdf']);
  // the same on win32 with a drive path; a POSIX-style file URL is not a local Windows path
  assert.deepEqual(pdfPathsFromArgv(['exe', 'file:///C:/Users/u/My%20Doc.pdf', 'file:///home/u/x.pdf', 'file://evil.example/share/x.pdf'], { platform: 'win32' }), ['C:\\Users\\u\\My Doc.pdf']);
});

test('pdfPathsFromArgv: an upper-case FILE:// URL is another scheme on POSIX, a file URL on win32', () => {
  assert.deepEqual(pdfPathsFromArgv(['exe', 'FILE:///home/u/x.pdf'], posix), []);
  assert.deepEqual(pdfPathsFromArgv(['exe', 'FILE:///C:/u/x.pdf'], { platform: 'win32' }), ['C:\\u\\x.pdf']);
});

test('pdfPathsFromArgv: unpackaged argv also skips the app path; non-arrays and huge lists are bounded', () => {
  assert.deepEqual(pdfPathsFromArgv(['electron', '/app/main.pdf', 'x.pdf'], { cwd: '/w', defaultApp: true, ...posix }), ['/w/x.pdf']);
  assert.deepEqual(pdfPathsFromArgv(undefined, posix), []);
  const many = ['exe', ...Array.from({ length: 100 }, (_, i) => `/f${i}.pdf`)];
  assert.equal(pdfPathsFromArgv(many, posix).length, MAX_OPEN_ARGS);
  assert.deepEqual(pdfPathsFromArgv(['exe', `/${'a'.repeat(5000)}.pdf`], posix), []);
});

test('validateOpenPath: accepts a small pdf; rejects wrong extension, directory, oversize, FIFO, missing', async () => {
  const ok = path.join(tmp, 'ok.pdf');
  fs.writeFileSync(ok, '%PDF-1.4');
  const { dev, ino } = fs.statSync(ok, { bigint: true });
  assert.deepEqual(await validateOpenPath(ok, 100), { size: 8, filePath: fs.realpathSync.native(ok), dev, ino });
  await assert.rejects(validateOpenPath(ok, 4), /too large/);
  const txt = path.join(tmp, 'a.txt');
  fs.writeFileSync(txt, 'x');
  await assert.rejects(validateOpenPath(txt, 100), /not a \.pdf/);
  const dir = path.join(tmp, 'dir.pdf');
  fs.mkdirSync(dir);
  await assert.rejects(validateOpenPath(dir, 100), /not a regular file/);
  await assert.rejects(validateOpenPath(path.join(tmp, 'missing.pdf'), 100), /ENOENT/);
});

test('validateOpenPath: rejects a FIFO', { skip: POSIX_ONLY }, async () => {
  const fifo = path.join(tmp, 'fifo.pdf');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(validateOpenPath(fifo, 100), /not a regular file/);
});

test('validateOpenPath: requires the %PDF- header and resolves symlinks (a link to a secret is refused)', async () => {
  const secret = path.join(tmp, 'secret.txt');
  fs.writeFileSync(secret, 'root:x:0:0');
  const link = path.join(tmp, 'link.pdf');
  fs.symlinkSync(secret, link);
  await assert.rejects(validateOpenPath(link, 1000), /missing %PDF- header/);
  const fake = path.join(tmp, 'fake.pdf');
  fs.writeFileSync(fake, 'GIF89a');
  await assert.rejects(validateOpenPath(fake, 1000), /missing %PDF- header/);
  const short = path.join(tmp, 'short.pdf');
  fs.writeFileSync(short, '%PD');
  await assert.rejects(validateOpenPath(short, 1000), /missing %PDF- header/);
  const real = path.join(tmp, 'real.pdf');
  fs.writeFileSync(real, '%PDF-1.7 x');
  const okLink = path.join(tmp, 'oklink.pdf');
  fs.symlinkSync(real, okLink);
  assert.equal((await validateOpenPath(okLink, 1000)).filePath, fs.realpathSync.native(real));
});

function harness() {
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  const sent = [];
  const sender = Object.assign(new EventEmitter(), { id: 7, send: (channel, payload) => sent.push([channel, payload]) });
  const event = { sender, senderFrame: { url: `${ORIGIN}/index.html`, parent: null } };
  const dispose = registerIpc({ ipcMain, origin: ORIGIN, dialogs: {}, getWindow: () => null });
  return { dispose, sender, sent, take: () => handlers.get(CHANNELS.takeOpened)(event), read: (t) => handlers.get(CHANNELS.readFile)(event, t) };
}

test('openPath: queued until the page listens, then pushed; token is readable by that window only', async () => {
  const h = harness();
  const p = path.join(tmp, 'doc.pdf');
  fs.writeFileSync(p, '%PDF-doc');
  const first = await h.dispose.openPath(h.sender, p);
  assert.equal(first.name, 'doc.pdf');
  assert.deepEqual(h.sent, []);
  const taken = await h.take();
  assert.deepEqual(taken, [first]);
  assert.deepEqual(await h.take(), [], 'queue is drained');
  assert.equal(Buffer.from(await h.read(first.token)).toString(), '%PDF-doc');
  const second = await h.dispose.openPath(h.sender, p);
  assert.deepEqual(h.sent, [[CHANNELS.fileOpened, second]]);
  assert.deepEqual(await h.take(), [], 'pushed entries are not queued again');
});

test('openPath: a main-frame navigation makes the page re-subscribe; same-document navigation does not', async () => {
  const h = harness();
  const p = path.join(tmp, 'nav.pdf');
  fs.writeFileSync(p, '%PDF-');
  await h.dispose.openPath(h.sender, p);
  await h.take();
  h.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  await h.dispose.openPath(h.sender, p);
  assert.equal(h.sent.length, 1);
  h.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  const queued = await h.dispose.openPath(h.sender, p);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(await h.take(), [queued]);
});

test('openPath: refuses non-pdf and non-regular files without issuing a grant', async () => {
  const h = harness();
  const txt = path.join(tmp, 'x.txt');
  fs.writeFileSync(txt, 'x');
  await assert.rejects(h.dispose.openPath(h.sender, txt), /not a \.pdf/);
  await assert.rejects(h.dispose.openPath(h.sender, '/etc/passwd'), /not a \.pdf/);
  assert.deepEqual(await h.take(), []);
});

test('open-with grant: a file swapped or rewritten after the grant is refused at read time', async () => {
  const h = harness();
  const p = path.join(tmp, 'swap.pdf');
  fs.writeFileSync(p, '%PDF-1.4 original');
  const ok = await h.dispose.openPath(h.sender, p);
  assert.match(Buffer.from(await h.read(ok.token)).toString(), /original/);
  // different inode under the same name
  const other = path.join(tmp, 'swap-other.pdf');
  fs.writeFileSync(other, '%PDF-1.4 other');
  fs.renameSync(other, p);
  await assert.rejects(h.read(ok.token), /changed since it was granted/);
  // same inode, content no longer a PDF
  const again = await h.dispose.openPath(h.sender, p);
  fs.writeFileSync(p, 'secret, not a pdf');
  await assert.rejects(h.read(again.token), /missing %PDF- header/);
});

test('open-with grant: a symlink put in place of the resolved path is not followed', async () => {
  const h = harness();
  const p = path.join(tmp, 'nofollow.pdf');
  fs.writeFileSync(p, '%PDF-1.4 x');
  const g = await h.dispose.openPath(h.sender, p);
  const secret = path.join(tmp, 'nofollow-secret.pdf');
  fs.writeFileSync(secret, '%PDF-1.4 secret');
  fs.unlinkSync(p);
  fs.symlinkSync(secret, p);
  // POSIX refuses the link itself (O_NOFOLLOW -> ELOOP); Windows has no O_NOFOLLOW: the lstat/realpath/identity checks refuse it.
  await assert.rejects(h.read(g.token), WIN ? /refusing to follow a link|resolves elsewhere|file changed/ : /ELOOP/);
});

test('pdfPathsFromArgv: after a bare -- every argument is a file argument', () => {
  assert.deepEqual(pdfPathsFromArgv(['exe', '--', '-weird.pdf', '--no-sandbox.pdf'], { cwd: '/d', ...posix }), ['/d/-weird.pdf', '/d/--no-sandbox.pdf']);
  assert.deepEqual(pdfPathsFromArgv(['exe', '-weird.pdf', '/d/a.pdf'], { cwd: '/d', ...posix }), ['/d/a.pdf']);
});

test('takeOpened rejects untrusted senders', () => {
  const handlers = new Map();
  registerIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler() {} }, origin: ORIGIN, dialogs: {}, getWindow: () => null });
  const evil = { sender: new EventEmitter(), senderFrame: { url: 'https://evil.example/', parent: null } };
  assert.throws(() => handlers.get(CHANNELS.takeOpened)(evil), /untrusted sender/);
});

test('Help menu carries the About item and the source link; devtools only when asked', () => {
  const calls = [];
  const tpl = buildMenuTemplate({ showAbout: () => calls.push('about'), openSource: () => calls.push('src') });
  const help = tpl.find((m) => m.label === 'Help').submenu;
  help.forEach((i) => i.click());
  assert.deepEqual(calls, ['about', 'src']);
  const roles = (t) => t.flatMap((m) => m.submenu.map((i) => i.role));
  assert.ok(!roles(tpl).includes('toggleDevTools'));
  assert.ok(roles(buildMenuTemplate({ showAbout() {}, openSource() {}, devtools: true })).includes('toggleDevTools'));
});

test('About text states the licence, the no-warranty line and the corresponding-source URL', () => {
  const text = aboutDetail();
  assert.match(text, /AGPL-3\.0-only/);
  assert.match(text, /NO WARRANTY/);
  assert.ok(text.includes(SOURCE_URL));
  assert.match(text, /Unofficial/);
});

test('network paths (UNC, //host) are refused on every platform: validateOpenPath and argv', async () => {
  const { hasNetworkPrefix } = require('../src/open-file');
  for (const p of ['\\\\host\\share\\a.pdf', '//host/share/a.pdf', '\\\\?\\UNC\\h\\s\\a.pdf', '/\\host/a.pdf', '\\\\.\\pipe\\x.pdf', '//./pipe/x.pdf', '//?/UNC/h/s/a.pdf', '\\\\?\\\\h\\s\\a.pdf', '\\\\?\\Volume{1}\\a.pdf', 'smb://h/s/a.pdf', 'SMB:\\\\h\\s\\a.pdf', 'file://host/share/a.pdf']) {
    assert.equal(hasNetworkPrefix(p), true, p);
    await assert.rejects(validateOpenPath(p, 1024), /network paths are not allowed/, p);
  }
  for (const p of ['/home/u/a.pdf', 'C:\\docs\\a.pdf', 'a.pdf', '', null, '\\\\?\\C:\\docs\\a.pdf', '//?/c:/docs/a.pdf', 'file:///home/u/a.pdf', 'file://localhost/home/u/a.pdf']) {
    assert.equal(hasNetworkPrefix(p), false, `legitimate: ${String(p)}`);
  }
  assert.deepEqual(pdfPathsFromArgv(['app', '//host/share/a.pdf', '\\\\host\\s\\b.pdf', '\\\\.\\pipe\\x.pdf', 'file://host/share/d.pdf', '/ok/c.pdf'], { cwd: '/', ...posix }), ['/ok/c.pdf']);
  assert.deepEqual(pdfPathsFromArgv(['app', '\\\\host\\s\\b.pdf', '\\\\.\\pipe\\x.pdf', 'file://host/share/d.pdf', 'C:\\ok\\c.pdf'], { cwd: 'C:\\', platform: 'win32' }), ['C:\\ok\\c.pdf']);
});

// ---- win32 open rules against a fake fs (no O_NOFOLLOW there: lstat + realpath before/after + handle id) ----
const WFILE = 'C:\\docs\\a.pdf';
function fakeWinOpen({ lstat = {}, real = [WFILE], hstat = {}, closed = [] } = {}) {
  const base = { isFile: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n ** 62n, size: 8n };
  const reals = [...real];
  const calls = { open: [], realpath: 0 };
  return {
    calls,
    closed,
    realpath: async () => { calls.realpath += 1; return reals.length > 1 ? reals.shift() : reals[0]; },
    lstat: async () => ({ ...base, ...lstat }),
    open: async (p, flags) => {
      calls.open.push(flags);
      return { stat: async (o) => { assert.deepEqual(o, { bigint: true }); return { ...base, ...hstat }; }, read: async (b) => { b.write('%PDF-'); return { bytesRead: 5 }; }, close: async () => { closed.push(1); } };
    },
  };
}
const winOpts = (fsImpl) => ({ pdf: true, platform: 'win32', fsImpl });

test('win32 open (fake fs): a regular file passes; ids stay bigint beyond 2^53', async () => {
  const r = await validateLocalFile(WFILE, 100, winOpts(fakeWinOpen()));
  assert.deepEqual(r, { size: 8, filePath: WFILE, dev: 1n, ino: 2n ** 62n });
});
test('win32 open (fake fs): the compensating no-link checks each refuse on their own', async () => {
  await assert.rejects(validateLocalFile(WFILE, 100, winOpts(fakeWinOpen({ lstat: { isSymbolicLink: () => true } }))), /refusing to follow a link/);
  const swapped = fakeWinOpen({ hstat: { ino: 2n ** 62n + 1n } }); // equal as doubles, different as 64-bit ids
  await assert.rejects(validateLocalFile(WFILE, 100, winOpts(swapped)), /file changed while opening/);
  assert.equal(swapped.closed.length, 1, 'the handle is closed on refusal');
  await assert.rejects(validateLocalFile(WFILE, 100, winOpts(fakeWinOpen({ real: [WFILE, 'C:\\other\\a.pdf'] }))), /resolves elsewhere/);
});
test('win32 open (fake fs): realpath is compared case-insensitively', async () => {
  const r = await validateLocalFile(WFILE.toUpperCase(), 100, winOpts(fakeWinOpen({ real: [WFILE.toUpperCase()] })));
  assert.equal(r.filePath, WFILE.toUpperCase());
});
test('win32 open (fake fs): a path that RESOLVES to UNC / a device / a stream is refused (mapped drive)', async () => {
  for (const real of ['\\\\fileserver\\share\\a.pdf', '\\\\?\\UNC\\fileserver\\share\\a.pdf', 'C:\\docs\\a.pdf:evil', 'C:\\docs\\con.pdf']) {
    const fake = fakeWinOpen({ real: [real] });
    await assert.rejects(validateLocalFile('Z:\\a.pdf', 100, winOpts(fake)), /network paths|refused Windows path after resolving/, real);
    assert.equal(fake.calls.open.length, 0, 'nothing was opened');
  }
});
test('win32 open (fake fs): size cap and type are measured on the handle', async () => {
  await assert.rejects(validateLocalFile(WFILE, 4, winOpts(fakeWinOpen())), /too large/);
  await assert.rejects(validateLocalFile(WFILE, 100, winOpts(fakeWinOpen({ hstat: { isFile: () => false } }))), /not a regular file/);
});
test('posix open: O_NOFOLLOW is part of the flags, and dev/ino are bigint', { skip: WIN && 'O_NOFOLLOW does not exist on win32' }, async () => {
  const flags = [];
  const fake = { realpath: async (p) => p, open: async (p, f) => { flags.push(f); return fs.promises.open(p, f); } };
  const p = path.join(tmp, 'flags.pdf');
  fs.writeFileSync(p, '%PDF-1.4');
  const r = await validateLocalFile(p, 100, { pdf: true, platform: 'linux', fsImpl: fake });
  assert.equal(flags[0] & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
  assert.equal(typeof r.ino, 'bigint');
  assert.equal(typeof r.dev, 'bigint');
});
