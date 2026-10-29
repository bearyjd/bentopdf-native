'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS } = require('./channels');
const { validateOpenPath, hasPdfMagic } = require('./open-file');

const MAX_BYTES = 512 * 1024 * 1024;
const GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_GRANTS_PER_WINDOW = 64;
const MAX_NAME = 255;
const EXTENSION = /^[a-z0-9]{1,10}$/;

// Only formats the tools produce. Anything else is refused on save.
const SAVE_EXTENSIONS = Object.freeze([
  'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'png', 'jpg', 'jpeg', 'webp',
  'bmp', 'tif', 'tiff', 'gif', 'svg', 'zip', 'txt', 'json', 'csv', 'md', 'html', 'xml',
  'epub', 'mobi', 'fb2', 'cbz', 'xps',
]);

/** Only the app's own top-level page may call IPC. */
function isTrustedSender(event, origin) {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  try {
    return new URL(frame.url).origin === origin || frame.url.startsWith(`${origin}/`);
  } catch {
    return false;
  }
}

function assertTrusted(event, origin) {
  if (!isTrustedSender(event, origin)) throw new Error('untrusted sender');
}

function parseOpenOptions(raw) {
  const opts = raw && typeof raw === 'object' ? raw : {};
  const extensions = Array.isArray(opts.extensions)
    ? opts.extensions.filter((e) => typeof e === 'string' && EXTENSION.test(e))
    : [];
  return { multiple: opts.multiple === true, extensions };
}

function safeFileName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'document.pdf';
  return path.basename(name.replace(/\\/g, '/')).slice(0, MAX_NAME) || 'document.pdf';
}

const extensionOf = (name) => path.extname(name).slice(1).toLowerCase();

/**
 * Open once, fstat the handle (so a swap after the check cannot change what
 * was measured), refuse anything that is not a regular file within the cap, and
 * read at most that many bytes. O_NONBLOCK keeps a FIFO from hanging open().
 * `expect` (from the grant): `{dev, ino}` must match the opened file, `nofollow`
 * adds O_NOFOLLOW (resolved paths only), `pdf` re-checks the `%PDF-` header.
 */
async function readRegularFile(filePath, maxBytes = MAX_BYTES, expect = {}) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (expect.nofollow ? fs.constants.O_NOFOLLOW : 0);
  const handle = await fs.promises.open(filePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (expect.ino !== undefined && (stat.ino !== expect.ino || stat.dev !== expect.dev)) throw new Error('file changed since it was granted');
    if (stat.size > maxBytes) throw new Error('file too large');
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, offset);
    if (expect.pdf && !hasPdfMagic(bytes)) throw new Error('not a PDF (missing %PDF- header)');
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * IPC handlers. A renderer can only read files whose opaque token this
 * module issued after the user picked them in a native dialog for that same
 * WebContents; it never supplies a path. Grants expire (TTL), are capped per
 * window and die with the window. `dialogs` and `now` are injected for tests.
 * `canUseDialogs(webContents)` decides whether a sender may open a native
 * dialog (the tabbed shell allows only the ACTIVE tab, so a hidden background
 * tab cannot pop one up); it defaults to "yes" for the single-window app.
 */
function registerIpc({ ipcMain, origin, dialogs, getWindow, now = Date.now, canUseDialogs = () => true }) {
  const grants = new Map(); // webContents.id -> Map(token -> {filePath,name,size,expires,dev,ino,...})

  const tableFor = (webContents) => {
    const id = webContents.id;
    if (!grants.has(id)) {
      grants.set(id, new Map());
      webContents.once('destroyed', () => grants.delete(id));
    }
    return grants.get(id);
  };
  const assertMayOpenDialog = (event) => {
    if (!canUseDialogs(event.sender)) throw new Error('dialogs are only available to the active tab');
  };
  const grantsFor = (event) => tableFor(event.sender);

  const issue = (table, filePath, size, identity = {}) => {
    for (const [token, grant] of table) if (grant.expires <= now()) table.delete(token);
    while (table.size >= MAX_GRANTS_PER_WINDOW) table.delete(table.keys().next().value);
    const token = crypto.randomUUID();
    const name = path.basename(filePath);
    table.set(token, { filePath, name, size, expires: now() + GRANT_TTL_MS, ...identity });
    return { token, name, size };
  };

  ipcMain.handle(CHANNELS.openFile, async (event, raw) => {
    assertTrusted(event, origin);
    assertMayOpenDialog(event);
    const { multiple, extensions } = parseOpenOptions(raw);
    const picked = await dialogs.showOpenDialog(getWindow(), {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: extensions.length ? [{ name: 'Files', extensions }] : [],
    });
    if (picked.canceled) return [];
    const table = grantsFor(event);
    const result = [];
    for (const filePath of picked.filePaths) {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile()) result.push(issue(table, filePath, stat.size, { dev: stat.dev, ino: stat.ino }));
    }
    return result;
  });

  ipcMain.handle(CHANNELS.readFile, async (event, token) => {
    assertTrusted(event, origin);
    const table = grantsFor(event);
    const grant = typeof token === 'string' ? table.get(token) : undefined;
    if (!grant) throw new Error('unknown file token');
    if (grant.expires <= now()) {
      table.delete(token);
      throw new Error('file token expired');
    }
    if (grant.bytes) return grant.bytes;
    return readRegularFile(grant.filePath, MAX_BYTES, grant);
  });

  ipcMain.handle(CHANNELS.saveFile, async (event, rawName, bytes) => {
    assertTrusted(event, origin);
    assertMayOpenDialog(event);
    if (!(bytes instanceof Uint8Array)) throw new Error('bytes must be a Uint8Array');
    if (bytes.byteLength > MAX_BYTES) throw new Error('data too large');
    const suggested = safeFileName(rawName);
    const ext = extensionOf(suggested);
    if (!SAVE_EXTENSIONS.includes(ext)) throw new Error(`file type not allowed: .${ext}`);
    const chosen = await dialogs.showSaveDialog(getWindow(), {
      defaultPath: suggested,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (chosen.canceled || !chosen.filePath) return { saved: false };
    const chosenExt = extensionOf(chosen.filePath);
    if (!SAVE_EXTENSIONS.includes(chosenExt)) throw new Error(`file type not allowed: .${chosenExt}`);
    await fs.promises.writeFile(chosen.filePath, bytes);
    return { saved: true, name: path.basename(chosen.filePath) };
  });

  // OS-initiated opens (command line, "open with"): queued until the page
  // says it is listening (takeOpened), then pushed. A reload resets that.
  const opened = new Map(); // webContents.id -> {listening, queue}
  const openedFor = (webContents) => {
    if (!opened.has(webContents.id)) {
      const state = { listening: false, queue: [] };
      opened.set(webContents.id, state);
      webContents.once('destroyed', () => opened.delete(webContents.id));
      webContents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) state.listening = false;
      });
    }
    return opened.get(webContents.id);
  };

  ipcMain.handle(CHANNELS.takeOpened, (event) => {
    assertTrusted(event, origin);
    const state = openedFor(event.sender);
    state.listening = true;
    return state.queue.splice(0);
  });

  /**
   * Main-process-initiated grant for a path that came from the OS, never from
   * the renderer. Same checks as the dialog path (.pdf, regular file, size cap).
   */
  /**
   * Main-process grant of a path for one WebContents, without pushing it to the
   * page (the shell's document handoff). Same checks as openPath; `expect`
   * ({dev, ino}, from the document store) must still match the file.
   */
  const grantPath = async (webContents, filePath, expect = {}) => {
    const { size, filePath: resolved, dev, ino } = await validateOpenPath(filePath, MAX_BYTES);
    if (expect.ino !== undefined && (expect.ino !== ino || expect.dev !== dev)) throw new Error('file changed since it was opened');
    return issue(tableFor(webContents), resolved, size, { dev, ino, nofollow: true, pdf: true });
  };

  /** Grant for an in-memory PDF (bytes held by the main process, never a path). */
  const grantBytes = (webContents, name, bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES || !hasPdfMagic(bytes)) throw new Error('not a PDF within the size cap');
    return issue(tableFor(webContents), safeFileName(name), bytes.byteLength, { bytes });
  };

  const openPath = async (webContents, filePath) => {
    const entry = await grantPath(webContents, filePath);
    const state = openedFor(webContents);
    if (state.listening) webContents.send(CHANNELS.fileOpened, entry);
    else state.queue.push(entry);
    return entry;
  };

  const dispose = () => {
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
  };
  return Object.assign(dispose, { openPath, grantPath, grantBytes });
}

module.exports = {
  registerIpc,
  isTrustedSender,
  safeFileName,
  parseOpenOptions,
  readRegularFile,
  SAVE_EXTENSIONS,
  MAX_BYTES,
  MAX_GRANTS_PER_WINDOW,
  GRANT_TTL_MS,
};
