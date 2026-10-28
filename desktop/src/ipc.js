'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS } = require('./channels');

const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_NAME = 255;
const EXTENSION = /^[a-z0-9]{1,10}$/;

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

/**
 * IPC handlers. A renderer can only read files whose opaque token this
 * module issued after the user picked them in a native dialog for that same
 * WebContents; it never supplies a path. `dialogs` is injected for tests.
 */
function registerIpc({ ipcMain, origin, dialogs, getWindow }) {
  const grants = new Map(); // webContents.id -> Map(token -> {path,name,size})

  const grantsFor = (event) => {
    const id = event.sender.id;
    if (!grants.has(id)) {
      grants.set(id, new Map());
      event.sender.once('destroyed', () => grants.delete(id));
    }
    return grants.get(id);
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
      if (!stat.isFile()) continue;
      const token = crypto.randomUUID();
      table.set(token, { filePath, name: path.basename(filePath), size: stat.size });
      result.push({ token, name: path.basename(filePath), size: stat.size });
    }
    return result;
  });

  ipcMain.handle(CHANNELS.readFile, async (event, token) => {
    assertTrusted(event, origin);
    const grant = typeof token === 'string' ? grantsFor(event).get(token) : undefined;
    if (!grant) throw new Error('unknown file token');
    if (grant.size > MAX_BYTES) throw new Error('file too large');
    const data = await fs.promises.readFile(grant.filePath);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  });

  ipcMain.handle(CHANNELS.saveFile, async (event, rawName, bytes) => {
    assertTrusted(event, origin);
    if (!(bytes instanceof Uint8Array)) throw new Error('bytes must be a Uint8Array');
    if (bytes.byteLength > MAX_BYTES) throw new Error('data too large');
    const chosen = await dialogs.showSaveDialog(getWindow(), {
      defaultPath: safeFileName(rawName),
    });
    if (chosen.canceled || !chosen.filePath) return { saved: false };
    await fs.promises.writeFile(chosen.filePath, bytes);
    return { saved: true, name: path.basename(chosen.filePath) };
  });

  return () => {
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerIpc, isTrustedSender, safeFileName, parseOpenOptions };
