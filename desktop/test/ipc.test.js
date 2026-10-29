'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { CHANNELS } = require('../src/channels');
const { registerIpc, readRegularFile, SAVE_EXTENSIONS, MAX_GRANTS_PER_WINDOW, GRANT_TTL_MS } = require('../src/ipc');

const ORIGIN = 'bento://app';
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-ipc-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function harness({ dialogs, now } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  const sender = Object.assign(new EventEmitter(), { id: 1 });
  const event = { sender, senderFrame: { url: `${ORIGIN}/index.html`, parent: null } };
  const dispose = registerIpc({ ipcMain, origin: ORIGIN, dialogs, getWindow: () => null, now });
  const call = (channel, ...args) => handlers.get(channel)(event, ...args);
  return { call, sender, dispose, handlers };
}
const file = (name, content = 'hello') => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
};
const picking = (paths) => ({ showOpenDialog: async () => ({ canceled: false, filePaths: paths }) });

test('readRegularFile reads a regular file and refuses oversize files', async () => {
  const p = file('a.bin', '0123456789');
  assert.equal(Buffer.from(await readRegularFile(p)).toString(), '0123456789');
  await assert.rejects(readRegularFile(p, 5), /too large/);
});

test('readRegularFile rejects FIFOs and device files without hanging', { skip: process.platform === 'win32' && 'POSIX-only: mkfifo and /dev/zero do not exist on Windows' }, async () => {
  const fifo = path.join(tmp, 'pipe');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(readRegularFile(fifo), /not a regular file/);
  await assert.rejects(readRegularFile('/dev/zero'), /not a regular file/);
});

test('a token reads only what the dialog issued; unknown tokens are rejected', async () => {
  const h = harness({ dialogs: picking([file('b.txt', 'abc')]) });
  const [picked] = await h.call(CHANNELS.openFile, {});
  assert.equal(Buffer.from(await h.call(CHANNELS.readFile, picked.token)).toString(), 'abc');
  await assert.rejects(h.call(CHANNELS.readFile, '/etc/passwd'), /unknown file token/);
  await assert.rejects(h.call(CHANNELS.readFile, 42), /unknown file token/);
});

test('grants expire after the TTL', async () => {
  let t = 1000;
  const h = harness({ dialogs: picking([file('c.txt')]), now: () => t });
  const [picked] = await h.call(CHANNELS.openFile, {});
  t += GRANT_TTL_MS - 1;
  assert.ok(await h.call(CHANNELS.readFile, picked.token));
  t += 2;
  await assert.rejects(h.call(CHANNELS.readFile, picked.token), /expired/);
});

test('grants are capped per window (oldest evicted) and revoked when the window is destroyed', async () => {
  const p = file('d.txt');
  const h = harness({ dialogs: picking(Array(MAX_GRANTS_PER_WINDOW + 5).fill(p)) });
  const picked = await h.call(CHANNELS.openFile, { multiple: true });
  await assert.rejects(h.call(CHANNELS.readFile, picked[0].token), /unknown file token/);
  const last = picked[picked.length - 1];
  assert.ok(await h.call(CHANNELS.readFile, last.token));
  h.sender.emit('destroyed');
  await assert.rejects(h.call(CHANNELS.readFile, last.token), /unknown file token/);
});

test('untrusted senders are rejected on every channel', async () => {
  const h = harness({ dialogs: picking([]) });
  const evil = { sender: h.sender, senderFrame: { url: 'https://evil.example/', parent: null } };
  for (const channel of Object.values(CHANNELS).filter((c) => h.handlers.has(c))) { // fileOpened is push-only
    await assert.rejects(Promise.resolve().then(() => h.handlers.get(channel)(evil, 'x', new Uint8Array(1))), /untrusted sender/);
  }
});

test('saveFile: extension allowlist on the suggested name and on the chosen path, dialog filter matches', async () => {
  const seen = [];
  const out = path.join(tmp, 'out.pdf');
  const h = harness({
    dialogs: { showSaveDialog: async (_w, opts) => { seen.push(opts); return { canceled: false, filePath: seen.length === 2 ? path.join(tmp, 'sneaky.sh') : out }; } },
  });
  const bytes = new Uint8Array([1, 2, 3]);
  for (const bad of ['evil.exe', 'run.sh', 'x.desktop', 'noext', '.bashrc', 'a.pdf.exe']) {
    await assert.rejects(h.call(CHANNELS.saveFile, bad, bytes), /not allowed/, bad);
  }
  assert.equal(seen.length, 0, 'dialog must not open for a rejected name');
  assert.deepEqual(await h.call(CHANNELS.saveFile, '../x/report.PDF', bytes), { saved: true, name: 'out.pdf' });
  assert.deepEqual(seen[0].filters, [{ name: 'PDF', extensions: ['pdf'] }]);
  assert.equal(seen[0].defaultPath, 'report.PDF');
  await assert.rejects(h.call(CHANNELS.saveFile, 'ok.pdf', bytes), /not allowed/, 'user cannot retype a dangerous extension');
  assert.ok(!fs.existsSync(path.join(tmp, 'sneaky.sh')));
  assert.deepEqual([...fs.readFileSync(out)], [1, 2, 3]);
});

test('save allowlist has no executable or script types', () => {
  for (const ext of ['exe', 'sh', 'bat', 'js', 'desktop', 'app', 'jar', 'py', 'lnk']) {
    assert.ok(!SAVE_EXTENSIONS.includes(ext), ext);
  }
});
