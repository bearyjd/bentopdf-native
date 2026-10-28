'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS } = require('./channels');
const { validateOpenPath } = require('./open-file');

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
 * Open once, fstat the handle (so a swap after the dialog cannot change what
 * was checked), refuse anything that is not a regular file within the cap, and
 * read at most that many bytes. O_NONBLOCK keeps a FIFO from hanging open().
 */
async function readRegularFile(filePath, maxBytes = MAX_BYTES) {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > maxBytes) throw new Error('file too large');
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, offset);
  } finally {
    await handle.close();
  }
}

/**
 * IPC handlers. A renderer can only read files whose opaque token this
 * module issued after the user picked them in a native dialog for that same
 * WebContents; it never supplies a path. Grants expire (TTL), are capped per
 * window and die with the window. `dialogs` and `now` are injected for tests.
 */
function registerIpc({ ipcMain, origin, dialogs, getWindow, now = Date.now }) {
  const grants = new Map(); // webContents.id -> Map(token -> {filePath,name,size,expires})

  const tableFor = (webContents) => {
    const id = webContents.id;
    if (!grants.has(id)) {
      grants.set(id, new Map());
      webContents.once('destroyed', () => grants.delete(id));
    }
    return grants.get(id);
  };
  const grantsFor = (event) => tableFor(event.sender);

  const issue = (table, filePath, size) => {
    for (const [token, grant] of table) if (grant.expires <= now()) table.delete(token);
    while (table.size >= MAX_GRANTS_PER_WINDOW) table.delete(table.keys().next().value);
    const token = crypto.randomUUID();
    const name = path.basename(filePath);
    table.set(token, { filePath, name, size, expires: now() + GRANT_TTL_MS });
    return { token, name, size };
  };

  ipcMain.handle(CHANNELS.openFile, async (event, raw) => {
    assertTrusted(event, origin);
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
      if (stat.isFile()) result.push(issue(table, filePath, stat.size));
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
    return readRegularFile(grant.filePath);
  });

  ipcMain.handle(CHANNELS.saveFile, async (event, rawName, bytes) => {
    assertTrusted(event, origin);
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
  const openPath = async (webContents, filePath) => {
    const { size } = await validateOpenPath(filePath, MAX_BYTES);
    const entry = issue(tableFor(webContents), filePath, size);
    const state = openedFor(webContents);
    if (state.listening) webContents.send(CHANNELS.fileOpened, entry);
    else state.queue.push(entry);
    return entry;
  };

  const dispose = () => {
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
  };
  return Object.assign(dispose, { openPath });
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
