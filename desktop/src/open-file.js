'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { looksLikeSwitch } = require('./argv-policy');

const MAX_OPEN_ARGS = 16;
const MAX_PATH_LENGTH = 4096;

// Device names Windows resolves in every directory, with or without an extension (CON.pdf is the console).
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/**
 * Why a Windows path must not be opened, or null. Purely lexical, so it runs (and is tested)
 * on every platform. Rejects: UNC and device namespaces (`\\server\share`, `\\?\UNC\...`, `\\.\...`;
 * remote files are refused by default), drive-relative `C:x.pdf`, any `:` after the drive
 * (alternate data streams: `x.pdf::$DATA`), wildcard characters, control characters,
 * segments with a trailing dot or space (Windows strips them, which defeats name checks)
 * and device names. A mapped network drive (`Z:\`) cannot be told from a local one lexically:
 * it is NOT detected.
 */
function windowsPathProblem(p) {
  if ([...p].some((c) => c.charCodeAt(0) < 32)) return 'control character';
  if (/^[\\/]{2}/.test(p)) return 'UNC or device path';
  const drive = /^[A-Za-z]:/.test(p) ? 2 : 0;
  if (drive && !/^[\\/]/.test(p.slice(2))) return 'drive-relative path';
  const rest = p.slice(drive);
  if (/[:<>"|?*]/.test(rest)) return 'reserved character (alternate data stream or wildcard)';
  for (const segment of rest.split(/[\\/]+/)) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    if (/[. ]$/.test(segment)) return 'trailing dot or space';
    if (WINDOWS_DEVICE.test(segment.split('.')[0].trimEnd())) return 'reserved device name';
  }
  return null;
}

/** `\\?\C:\long\path` is the extended-length spelling of a LOCAL drive path: strip the prefix. Other `\\?\` forms stay and are rejected. */
const stripExtendedPrefix = (p) => p.replace(/^\\\\\?\\(?=[A-Za-z]:[\\/])/, '');

function localPathOfFileUrl(url, platform) {
  try {
    // POSIX: throws for a non-local host. Windows: a host becomes a UNC path, rejected by windowsPathProblem.
    return fileURLToPath(url, { windows: platform === 'win32' });
  } catch {
    return null;
  }
}

/**
 * Candidate document paths from a command line (first launch or the argv of a
 * second instance). Flags (until a bare `--`; on win32 a leading `/` is a flag too, see
 * argv-policy.js), the executable and (when running unpackaged) the app path are skipped;
 * only `.pdf` names survive, relative ones are resolved against `cwd`. This is a filter,
 * not a check: validateOpenPath decides. `platform` exists so the Windows rules are
 * testable anywhere.
 */
function pdfPathsFromArgv(argv, { cwd = process.cwd(), defaultApp = false, platform = process.platform } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const rest = Array.isArray(argv) ? argv.slice(defaultApp ? 2 : 1) : [];
  const found = [];
  let optionsEnded = false;
  for (const arg of rest) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_PATH_LENGTH) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true; // after a bare `--` everything is a file argument (still filtered and validated below)
      continue;
    }
    if ((!optionsEnded && looksLikeSwitch(arg, platform)) || arg.includes('\0')) continue;
    const isFileUrl = /^file:\/\//i.test(arg);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) && !isFileUrl) continue; // other URL schemes
    let local = isFileUrl ? localPathOfFileUrl(arg, platform) : arg; // %U launchers pass file:// URLs
    if (local === null || local.includes('\0')) continue;
    if (platform === 'win32') {
      local = stripExtendedPrefix(local);
      if (windowsPathProblem(local) !== null) continue;
    }
    if (P.extname(local).toLowerCase() !== '.pdf') continue;
    found.push(P.resolve(cwd, local));
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
async function validateOpenPath(filePath, maxBytes, { platform = process.platform } = {}) {
  if (path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('not a .pdf file');
  const problem = platform === 'win32' ? windowsPathProblem(filePath) : null;
  if (problem !== null) throw new Error(`refused Windows path: ${problem}`);
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

module.exports = { pdfPathsFromArgv, validateOpenPath, hasPdfMagic, windowsPathProblem, MAX_OPEN_ARGS };
