'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { looksLikeSwitch } = require('./argv-policy');

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
    if (local === null || local.includes('\0') || hasNetworkPrefix(local)) continue;
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
 * The one validator behind every path that becomes a document or a grant (OS open, recents, the
 * native open dialog): no network prefix, no NUL, on win32 no windowsPathProblem, absolute, resolves (symlinks followed; the
 * target is checked for a network prefix again) to a regular file within `maxBytes`, opened
 * O_NOFOLLOW and measured on that handle so a swap after the check cannot change what was
 * measured. With `pdf` the name must end in `.pdf` and the first bytes must be `%PDF-`.
 * Returns the resolved `filePath` plus `dev`/`ino`; the caller stores them in the grant and
 * readRegularFile compares them with the handle it opens at read time.
 */
async function validateLocalFile(filePath, maxBytes, { pdf = false, platform = process.platform } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) throw new Error('not a usable path');
  if (hasNetworkPrefix(filePath)) throw new Error('network paths are not allowed');
  if (platform === 'win32') {
    const problem = windowsPathProblem(stripExtendedPrefix(filePath));
    if (problem !== null) throw new Error(`refused Windows path: ${problem}`);
  }
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
const validateOpenPath = (filePath, maxBytes, { platform = process.platform } = {}) => validateLocalFile(filePath, maxBytes, { pdf: true, platform });

module.exports = { pdfPathsFromArgv, validateOpenPath, validateLocalFile, hasPdfMagic, hasNetworkPrefix, windowsPathProblem, MAX_OPEN_ARGS };
