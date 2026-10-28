'use strict';

// Sandboxed preload: may only require 'electron'. Channel names are mirrored
// from channels.js (checked by test/security.test.js).
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  openFile: 'bento:open-file',
  readFile: 'bento:read-file',
  saveFile: 'bento:save-file',
});

/**
 * @typedef {{token: string, name: string, size: number}} PickedFile
 * @typedef {{
 *   openFile(options?: {multiple?: boolean, extensions?: string[]}): Promise<PickedFile[]>,
 *   readFile(token: string): Promise<Uint8Array>,
 *   saveFile(suggestedName: string, bytes: Uint8Array): Promise<{saved: boolean, name?: string}>,
 *   handoffToInput(files: PickedFile[], selector?: string): Promise<number>
 * }} BentoDesktop
 */

const MIME_BY_EXT = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
});

const mimeFor = (name) => MIME_BY_EXT[String(name).split('.').pop().toLowerCase()] || '';

/**
 * Document handoff: reads files the user picked in this session and sets them
 * on an <input type=file> of the page, then fires `change`, exactly as if the
 * user had chosen them. Returns the number of files set.
 */
async function handoffToInput(files, selector) {
  const input = document.querySelector(typeof selector === 'string' ? selector : 'input[type="file"]');
  if (!(input instanceof HTMLInputElement) || input.type !== 'file') {
    throw new TypeError('selector does not match an <input type=file>');
  }
  if (!Array.isArray(files) || files.length === 0) throw new TypeError('no files');
  const transfer = new DataTransfer();
  for (const picked of files) {
    const bytes = await ipcRenderer.invoke(CHANNELS.readFile, String(picked.token));
    transfer.items.add(new File([bytes], String(picked.name), { type: mimeFor(picked.name) }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return transfer.files.length;
}

/** @type {BentoDesktop} */
const bridge = {
  handoffToInput,
  openFile: (options) => ipcRenderer.invoke(CHANNELS.openFile, options),
  readFile: (token) => {
    if (typeof token !== 'string') return Promise.reject(new TypeError('token must be a string'));
    return ipcRenderer.invoke(CHANNELS.readFile, token);
  },
  saveFile: (suggestedName, bytes) => {
    if (!(bytes instanceof Uint8Array)) {
      return Promise.reject(new TypeError('bytes must be a Uint8Array'));
    }
    return ipcRenderer.invoke(CHANNELS.saveFile, String(suggestedName), bytes);
  },
};

contextBridge.exposeInMainWorld('bentoDesktop', Object.freeze(bridge));
