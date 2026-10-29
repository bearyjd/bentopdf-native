'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { validateOpenPath, hasPdfMagic, hasNetworkPrefix } = require('../open-file');
const { MAX_BYTES, safeFileName } = require('../ipc');

const MAX_DOCS = 32;

/**
 * @typedef {{id: string, name: string, size: number, source: 'file'|'memory', lastUsed: number}} PublicDoc
 * @typedef {PublicDoc & {filePath?: string, dev?: bigint, ino?: bigint, bytes?: Uint8Array}} DocRecord
 */

/**
 * Main-process store of open documents. Renderers only ever see PublicDoc
 * (id, display name, size); the path and file identity stay here. A path is
 * accepted only through `validateOpenPath` (.pdf name, realpath, regular file,
 * size cap, `%PDF-` magic); in-memory documents must carry the magic too.
 * Records are frozen and replaced, never mutated. Pure Node: `validate` and
 * `now` are injected for tests.
 *
 * Capacity: when `maxDocs` documents are held, the least recently used one that
 * `inUse(id)` does not report (the shell: shown in a tab) is evicted to make
 * room; if every document is in use the call fails with a clear error. The
 * shell also `remove`s a document when its last tab closes.
 */
function createDocumentStore({
  validate = (p) => validateOpenPath(p, MAX_BYTES),
  now = Date.now,
  maxDocs = MAX_DOCS,
  maxBytes = MAX_BYTES,
  inUse = () => false,
} = {}) {
  let docs = new Map(); // id -> frozen DocRecord

  const toPublic = ({ id, name, size, source, lastUsed }) => Object.freeze({ id, name, size, source, lastUsed });
  const put = (record) => {
    docs = new Map(docs).set(record.id, Object.freeze(record));
    return toPublic(record);
  };
  const makeRoom = () => {
    if (docs.size < maxDocs) return;
    const victim = [...docs.values()].filter((d) => !inUse(d.id)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) throw new Error(`too many open documents (max ${maxDocs}); close a tab first`);
    remove(victim.id);
  };

  /** Validate an OS/dialog/recents path and add it (or touch the already-open same file). */
  async function addFromPath(filePath) {
    if (hasNetworkPrefix(filePath)) throw new Error('network paths are not allowed');
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
      throw new Error('not an absolute path');
    }
    const { size, filePath: resolved, dev, ino } = await validate(filePath);
    const existing = [...docs.values()].find((d) => d.filePath === resolved && d.dev === dev && d.ino === ino);
    if (existing) return put({ ...existing, size, lastUsed: now() });
    makeRoom();
    return put({ id: crypto.randomUUID(), name: path.basename(resolved), size, source: 'file', lastUsed: now(), filePath: resolved, dev, ino });
  }

  /** Add a PDF produced in memory (e.g. a tool result). */
  function addFromBytes(name, bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
    if (bytes.byteLength > maxBytes) throw new Error('document too large');
    if (!hasPdfMagic(bytes)) throw new Error('not a PDF (missing %PDF- header)');
    makeRoom();
    return put({ id: crypto.randomUUID(), name: safeFileName(name), size: bytes.byteLength, source: 'memory', lastUsed: now(), bytes: Uint8Array.from(bytes) });
  }

  const get = (id) => (typeof id === 'string' ? docs.get(id) : undefined);
  const has = (id) => get(id) !== undefined;

  function touch(id) {
    const doc = get(id);
    if (!doc) throw new Error('unknown document');
    return put({ ...doc, lastUsed: now() });
  }

  function remove(id) {
    if (!has(id)) return false;
    const next = new Map(docs);
    next.delete(id);
    docs = next;
    return true;
  }

  /** Public view, most recently used first. */
  const list = () => [...docs.values()].sort((a, b) => b.lastUsed - a.lastUsed).map(toPublic);

  return Object.freeze({ addFromPath, addFromBytes, get, has, touch, remove, list });
}

module.exports = { createDocumentStore, MAX_DOCS };
