'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const MAX_OPEN_ARGS = 16;
const MAX_PATH_LENGTH = 4096;

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
    if (local === null || local.includes('\0') || path.extname(local).toLowerCase() !== '.pdf') continue;
    found.push(path.resolve(cwd, local));
    if (found.length >= MAX_OPEN_ARGS) break;
  }
  return found;
}

const PDF_MAGIC = Buffer.from('%PDF-');
const hasPdfMagic = (bytes) => bytes.length >= PDF_MAGIC.length && Buffer.from(bytes.buffer, bytes.byteOffset, PDF_MAGIC.length).equals(PDF_MAGIC);

/**
 * The file must be a `.pdf` name that resolves (symlinks followed) to a regular
 * file within `maxBytes` whose first bytes are `%PDF-`. Checked on an open
 * handle so a swap after the check cannot change what was measured. The caller
 * stores the returned `dev`/`ino` in the grant; readRegularFile compares them
 * with the handle it opens at read time and repeats the `%PDF-` check, so a
 * path swapped for another file between grant and read is refused. The returned
 * `filePath` is the resolved path: a symlink named x.pdf that points at a secret
 * is refused by the magic-byte check, and the grant never names the link.
 */
async function validateOpenPath(filePath, maxBytes) {
  if (path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('not a .pdf file');
  const resolved = await fs.promises.realpath(filePath);
  const handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > maxBytes) throw new Error('file too large');
    const head = Buffer.alloc(PDF_MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < head.length || !head.equals(PDF_MAGIC)) throw new Error('not a PDF (missing %PDF- header)');
    return { size: stat.size, filePath: resolved, dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
}

module.exports = { pdfPathsFromArgv, validateOpenPath, hasPdfMagic, MAX_OPEN_ARGS };
