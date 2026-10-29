'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const MAX_OPEN_ARGS = 16;
const MAX_PATH_LENGTH = 4096;

/**
 * UNC / network-share prefixes (`\\host\share`, `//host/share`, `\\.\pipe\x`, `\\?\UNC\...`, `smb:`,
 * `file://host/share`). Refused on every platform: reading one can leak credentials (NTLM) or hang
 * on a dead server, and POSIX treats a leading `//` as an ordinary path that other code would
 * normalise away. The one `\\?\` form that is allowed is the long-path prefix of a local drive
 * (`\\?\C:\...`): after the prefix is stripped the real target must be a drive letter, anything else
 * (`UNC\...`, `Volume{...}`, `GLOBALROOT`, a further `\\`) resolves to something other than a local file.
 */
function hasNetworkPrefix(value) {
  if (typeof value !== 'string') return false;
  if (/^smb:/i.test(value) || /^file:[\\/]{2}(?![\\/]|localhost[\\/])/i.test(value)) return true;
  if (!/^[\\/]{2}/.test(value)) return false;
  const longPath = /^[\\/]{2}\?[\\/]([\s\S]*)$/.exec(value);
  return longPath === null || !/^[A-Za-z]:([\\/]|$)/.test(longPath[1]);
}

function localPathOfFileUrl(url) {
  try {
    return fileURLToPath(url); // throws for a non-local host
  } catch {
    return null;
  }
}

/**
 * Candidate document paths from a command line (first launch or the argv of a
 * second instance). Flags (until a bare `--`), the executable and (when running unpackaged) the
 * app path are skipped; only `.pdf` names survive, relative ones are resolved
 * against `cwd`. This is a filter, not a check: validateOpenPath decides.
 */
function pdfPathsFromArgv(argv, { cwd = process.cwd(), defaultApp = false } = {}) {
  const rest = Array.isArray(argv) ? argv.slice(defaultApp ? 2 : 1) : [];
  const found = [];
  let optionsEnded = false;
  for (const arg of rest) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_PATH_LENGTH) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true; // after a bare `--` everything is a file argument (still filtered and validated below)
      continue;
    }
    if ((!optionsEnded && arg.startsWith('-')) || arg.includes('\0')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) && !arg.startsWith('file://')) continue; // other URL schemes
    const local = arg.startsWith('file://') ? localPathOfFileUrl(arg) : arg; // %U launchers pass file:// URLs
    if (local === null || local.includes('\0') || hasNetworkPrefix(local) || path.extname(local).toLowerCase() !== '.pdf') continue;
    found.push(path.resolve(cwd, local));
    if (found.length >= MAX_OPEN_ARGS) break;
  }
  return found;
}

const PDF_MAGIC = Buffer.from('%PDF-');
const hasPdfMagic = (bytes) => bytes.length >= PDF_MAGIC.length && Buffer.from(bytes.buffer, bytes.byteOffset, PDF_MAGIC.length).equals(PDF_MAGIC);

/**
 * The one validator behind every path that becomes a document or a grant (OS open, recents, the
 * native open dialog): no network prefix, no NUL, absolute, resolves (symlinks followed; the
 * target is checked for a network prefix again) to a regular file within `maxBytes`, opened
 * O_NOFOLLOW and measured on that handle so a swap after the check cannot change what was
 * measured. With `pdf` the name must end in `.pdf` and the first bytes must be `%PDF-`.
 * Returns the resolved `filePath` plus `dev`/`ino`; the caller stores them in the grant and
 * readRegularFile compares them with the handle it opens at read time.
 */
async function validateLocalFile(filePath, maxBytes, { pdf = false } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) throw new Error('not a usable path');
  if (hasNetworkPrefix(filePath)) throw new Error('network paths are not allowed');
  if (pdf && path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('not a .pdf file');
  const resolved = await fs.promises.realpath(filePath);
  if (hasNetworkPrefix(resolved)) throw new Error('network paths are not allowed');
  const handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > maxBytes) throw new Error('file too large');
    if (pdf) {
      const head = Buffer.alloc(PDF_MAGIC.length);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      if (bytesRead < head.length || !head.equals(PDF_MAGIC)) throw new Error('not a PDF (missing %PDF- header)');
    }
    return { size: stat.size, filePath: resolved, dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
}

/** A document: `validateLocalFile` with the `.pdf` name and `%PDF-` header required. */
const validateOpenPath = (filePath, maxBytes) => validateLocalFile(filePath, maxBytes, { pdf: true });

module.exports = { pdfPathsFromArgv, validateOpenPath, validateLocalFile, hasPdfMagic, hasNetworkPrefix, MAX_OPEN_ARGS };
