'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * script-src sources that weaken the policy. Each one the shell tolerates
 * needs a reason (proven by experiment, see docs/m2-findings.md "CSP
 * experiment"). Anything else fails closed.
 */
const UNSAFE_SCRIPT_SOURCES = Object.freeze(["'unsafe-eval'", "'unsafe-inline'"]);
const ALLOWED_UNSAFE_SCRIPT_SOURCES = Object.freeze({
  "'unsafe-eval'":
    'LibreOffice WASM (Word/Excel/PowerPoint to PDF): without it the page throws "EvalError: Evaluating a string as ' +
    'JavaScript violates ... unsafe-eval" and the conversion dies with "WASM initialization timeout" ' +
    '(experiment in docs/m2-findings.md). Everything else exercised works with only wasm-unsafe-eval.',
});

/** Forced on every response; the bundle's own values for these are ignored. */
const ISOLATION_HEADERS = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  // require-corp, not the bundle's credentialless: every subresource is
  // same-origin (the session hook cancels the rest), so the stricter value
  // costs nothing and nothing cross-origin can be pulled in unnoticed.
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

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

/** Sources of the effective script directive (script-src, else default-src). */
function scriptSources(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values);
  }
  return directives.get('script-src') || directives.get('default-src') || [];
}

/**
 * Drop `blob:` from script-src: nothing exercised needs it (workers are
 * governed by worker-src, which keeps blob:), and it lets page-created blobs
 * run as scripts. Re-add per tool only with a failing test as evidence.
 */
function tightenCsp(csp) {
  return csp
    .split(';')
    .map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      if (name.toLowerCase() !== 'script-src') return part.trim();
      return [name, ...values.filter((v) => v.toLowerCase() !== 'blob:')].join(' ');
    })
    .filter(Boolean)
    .join('; ');
}

function assertScriptSrcFailsClosed(csp, allowed) {
  for (const source of scriptSources(csp)) {
    const lower = source.toLowerCase();
    if (UNSAFE_SCRIPT_SOURCES.includes(lower) && !allowed[lower]) {
      throw new Error(`CSP script-src has ${source} without an allowlisted reason; refusing to serve`);
    }
  }
}

/**
 * Response headers for every app response. The CSP comes from the bundle's
 * own `_headers` (fail closed if absent, external, or weakened in script-src).
 * Only the `/*` block is applied, so a bundle with a `docs/` directory (which
 * `_headers` gives a different CSP) is refused rather than served wrongly.
 */
function buildAppHeaders(distDir, { allowedUnsafe = ALLOWED_UNSAFE_SCRIPT_SOURCES } = {}) {
  if (fs.existsSync(path.join(distDir, 'docs'))) {
    throw new Error('dist/docs exists but the shell does not apply _headers overrides for /docs');
  }
  const parsed = parseGlobalHeaders(fs.readFileSync(path.join(distDir, '_headers'), 'utf8'));
  const bundleCsp = parsed['Content-Security-Policy'];
  if (!bundleCsp) throw new Error('dist/_headers has no Content-Security-Policy for /*');
  if (/\bhttps?:/.test(bundleCsp)) {
    throw new Error('dist CSP contains an external http(s) origin; refusing to serve');
  }
  const csp = tightenCsp(bundleCsp);
  assertScriptSrcFailsClosed(csp, allowedUnsafe);
  const forced = new Set(Object.keys(ISOLATION_HEADERS).map((k) => k.toLowerCase()));
  const kept = Object.fromEntries(
    Object.entries(parsed).filter(([name]) => !forced.has(name.toLowerCase()))
  );
  return Object.freeze({ ...kept, 'Content-Security-Policy': csp, ...ISOLATION_HEADERS });
}

module.exports = { buildAppHeaders, tightenCsp, parseGlobalHeaders, scriptSources, ISOLATION_HEADERS };
