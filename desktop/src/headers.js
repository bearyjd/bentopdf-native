'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Parse the `/*` block of a Cloudflare/Netlify style `_headers` file. */
function parseGlobalHeaders(text) {
  const headers = {};
  let inGlobal = false;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    if (!/^\s/.test(raw)) {
      inGlobal = raw.trim() === '/*';
      continue;
    }
    if (!inGlobal) continue;
    const line = raw.trim();
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/**
 * Response headers for every app response. The CSP comes from the bundle's
 * own `_headers` (fail closed if absent). Isolation headers are forced:
 * COEP require-corp (stricter than the bundle's credentialless: nothing in
 * the app is cross-origin) and CORP same-origin.
 */
function buildAppHeaders(distDir) {
  const text = fs.readFileSync(path.join(distDir, '_headers'), 'utf8');
  const parsed = parseGlobalHeaders(text);
  if (!parsed['Content-Security-Policy']) {
    throw new Error('dist/_headers has no Content-Security-Policy for /*');
  }
  if (/\bhttps?:/.test(parsed['Content-Security-Policy'])) {
    throw new Error('dist CSP contains an external http(s) origin; refusing to serve');
  }
  return Object.freeze({
    ...parsed,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
}

module.exports = { buildAppHeaders, parseGlobalHeaders };
