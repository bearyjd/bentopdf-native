'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  // Shipped compressed on purpose: the page inflates them itself with
  // DecompressionStream, so they must NOT carry Content-Encoding.
  '.gz': 'application/gzip',
});

const DEFAULT_MIME = 'application/octet-stream';

function mimeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || DEFAULT_MIME;
}

// Device names Windows resolves in every directory, with or without an extension (CON.html is the console).
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/**
 * Names that mean something other than themselves on Windows (NTFS/Win32): alternate data
 * streams and drive letters (`:`), wildcards, trailing dots/spaces (silently stripped, so
 * `_headers.` would open `_headers`), 8.3 short names (`_HEADE~1`) and device names.
 * Refused on EVERY platform: the bundle contains no such names (checked), and one rule
 * set is testable everywhere. Runs on the decoded URL path, before any file system call.
 */
function isWindowsUnsafeSegment(segment) {
  if ([...segment].some((c) => c.charCodeAt(0) < 32)) return true;
  if (/[:<>"|?*]/.test(segment)) return true;
  if (segment === '.' || segment === '') return false;
  if (/[. ]$/.test(segment)) return true;
  if (/~\d/.test(segment)) return true;
  return WINDOWS_DEVICE.test(segment.split('.')[0].trimEnd());
}

function decodePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '..' || isWindowsUnsafeSegment(segment))) return null;
  return decoded;
}

/** `_headers`/`_redirects` are host config, dotfiles are never app content. */
function isHiddenSegment(segment) {
  const name = segment.toLowerCase(); // NTFS and APFS are case-insensitive: `_HEADERS` is the same file
  return name.startsWith('.') || name === '_headers' || name === '_redirects';
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Resolve a URL path to a regular file strictly inside `rootReal`
 * (a realpath'd directory). Symlinks are resolved before the prefix check,
 * so a link pointing outside the root is treated as missing.
 * Tries: exact, `.html` suffix (clean URLs), `/index.html`.
 */
async function resolveFile(rootReal, urlPath) {
  const decoded = decodePath(urlPath);
  if (decoded === null) return null;
  const rel = decoded.replace(/^\/+/, '');
  // The URL-level hidden check, the realpath-level hidden check and isInside below
  // overlap on purpose: each guards a different stage (request path, symlink target,
  // root escape). Do not delete one because another "already covers" it.
  if (rel.split('/').some(isHiddenSegment)) return null;
  const candidates = decoded.endsWith('/')
    ? [path.join(rel, 'index.html')]
    : [rel, `${rel}.html`, path.join(rel, 'index.html')];

  for (const candidate of candidates) {
    const real = await fs.promises
      .realpath(path.join(rootReal, candidate))
      .catch(() => null);
    if (real === null || !isInside(rootReal, real)) continue;
    if (path.relative(rootReal, real).split(path.sep).some(isHiddenSegment)) continue;
    const stat = await fs.promises.stat(real).catch(() => null);
    if (stat && stat.isFile()) return { file: real, size: stat.size };
  }
  return null;
}

/**
 * Parse a single `bytes=` range per RFC 9110 section 14. Returns null when the
 * header must be ignored (absent, other unit, multiple ranges, syntactically
 * invalid, including last < first) so the caller answers 200 with the whole
 * file; 'unsatisfiable' when it is valid but outside the file (416); or
 * {start, end}.
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  const [first, last] = [match[1], match[2]].map((v) => (v === '' ? null : Number(v)));
  if ([first, last].some((v) => v !== null && !Number.isSafeInteger(v))) return null;
  if (first === null) {
    if (last === 0) return 'unsatisfiable';
    return size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - last), end: size - 1 };
  }
  if (last !== null && last < first) return null;
  if (first >= size) return 'unsatisfiable';
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

async function notFound(rootReal, method, baseHeaders) {
  const page = await resolveFile(rootReal, '/404.html');
  const headers = { ...baseHeaders, 'Cache-Control': 'no-store' };
  if (!page) {
    return {
      status: 404,
      headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
      body: method === 'HEAD' ? null : Buffer.from('Not found'),
    };
  }
  return {
    status: 404,
    headers: {
      ...headers,
      'Content-Type': mimeFor(page.file),
      'Content-Length': String(page.size),
    },
    body: method === 'HEAD' ? null : fs.createReadStream(page.file),
  };
}

/**
 * Transport-neutral static response: {status, headers, body}, body is a
 * Readable, a Buffer or null. `baseHeaders` (COOP/COEP/CSP...) go on every
 * response, including errors.
 */
async function serveStatic({ rootReal, method, urlPath, range, baseHeaders }) {
  if (method !== 'GET' && method !== 'HEAD') {
    return {
      status: 405,
      headers: { ...baseHeaders, Allow: 'GET, HEAD' },
      body: null,
    };
  }
  const found = await resolveFile(rootReal, urlPath);
  if (!found) return notFound(rootReal, method, baseHeaders);

  const headers = {
    ...baseHeaders,
    'Content-Type': mimeFor(found.file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const parsed = parseRange(range, found.size);
  if (parsed === 'unsatisfiable') {
    return {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${found.size}` },
      body: null,
    };
  }
  const part = parsed || { start: 0, end: found.size - 1 };
  const length = found.size === 0 ? 0 : part.end - part.start + 1;
  headers['Content-Length'] = String(length);
  if (parsed) {
    headers['Content-Range'] = `bytes ${part.start}-${part.end}/${found.size}`;
  }
  const body =
    method === 'HEAD' || length === 0
      ? null
      : fs.createReadStream(found.file, { start: part.start, end: part.end });
  return { status: parsed ? 206 : 200, headers, body };
}

module.exports = { serveStatic, resolveFile, parseRange, mimeFor, isInside, isWindowsUnsafeSegment };
