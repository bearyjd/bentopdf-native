'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hasNetworkPrefix } = require('../open-file');

const MAX_RECENTS = 10;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4096;

/** A stored path is only kept if it could be a PDF we opened: absolute, .pdf, sane length. */
function isPlausiblePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0') &&
    !hasNetworkPrefix(value) &&
    path.isAbsolute(value) &&
    path.extname(value).toLowerCase() === '.pdf'
  );
}

const GONE_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);
// Thrown by validateOpenPath / the store when the file is there but is not an acceptable document.
const INVALID_MESSAGE = /^(not a \.pdf file|not a regular file|file too large|not a PDF|not an absolute path|network paths)/;

/**
 * True only when opening a recent failed for a CONFIRMED reason (the file is
 * gone, or it is not an acceptable PDF). Anything else (EACCES, EIO, EBUSY,
 * EMFILE, a network hiccup, an unexpected error) may be transient: the entry stays.
 */
const isPermanentOpenFailure = (err) => Boolean(err) && (GONE_CODES.has(err.code) || INVALID_MESSAGE.test(String(err.message)));

/**
 * Parse the recents file defensively: it lives in userData and is treated as
 * hostile (wrong types, duplicates, huge lists). Returns plain paths, newest
 * first, at most `max`. Never throws.
 */
function parseRecents(text, max = MAX_RECENTS) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = data && Array.isArray(data.recents) ? data.recents : [];
  const paths = [];
  for (const entry of entries.slice(0, max * 4)) {
    const value = entry && typeof entry === 'object' ? entry.path : undefined;
    if (isPlausiblePath(value) && !paths.includes(value)) paths.push(value);
    if (paths.length >= max) break;
  }
  return paths;
}

/**
 * Recently opened files, persisted as JSON in userData. The renderer gets
 * `{id, name}` only; ids are random per run and map back to a path here.
 * Opening a recent is NOT a grant: the caller must pass the path through the
 * document store (validateOpenPath) again, and `remove` it if that fails.
 * `onError` receives load/save failures (never thrown to the caller).
 */
function createRecents({ file, max = MAX_RECENTS, onError = () => {} }) {
  const withIds = (paths) => Object.freeze(paths.map((p) => Object.freeze({ id: crypto.randomUUID(), path: p })));
  let entries = withIds(load());

  function load() {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        onError(new Error('recents file ignored (not a regular file or too large)'));
        return [];
      }
      return parseRecents(fs.readFileSync(file, 'utf8'), max);
    } catch (err) {
      if (err.code !== 'ENOENT') onError(err);
      return [];
    }
  }

  function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ recents: entries.map((e) => ({ path: e.path })) }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      onError(err);
    }
  }

  /** Record a resolved path that just opened successfully. */
  function add(filePath) {
    if (!isPlausiblePath(filePath)) return;
    const kept = entries.filter((e) => e.path !== filePath);
    const previous = entries.find((e) => e.path === filePath);
    entries = Object.freeze([Object.freeze({ id: previous ? previous.id : crypto.randomUUID(), path: filePath }), ...kept].slice(0, max));
    save();
  }

  function remove(id) {
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    entries = Object.freeze(next);
    save();
    return true;
  }

  const pathOf = (id) => {
    const hit = typeof id === 'string' ? entries.find((e) => e.id === id) : undefined;
    return hit ? hit.path : undefined;
  };
  const list = () => entries.map((e) => Object.freeze({ id: e.id, name: path.basename(e.path) }));

  return Object.freeze({ add, remove, pathOf, list });
}

module.exports = { createRecents, parseRecents, isPlausiblePath, isPermanentOpenFailure, MAX_RECENTS };
