'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Weakening script sources the shell tolerates; each needs a reason (proven by
 * experiment, see docs/m2-findings.md "CSP experiment").
 */
const ALLOWED_UNSAFE_SCRIPT_SOURCES = Object.freeze({
  "'unsafe-eval'":
    'LibreOffice WASM (Word/Excel/PowerPoint to PDF): without it the page throws "EvalError: Evaluating a string as ' +
    'JavaScript violates ... unsafe-eval" and the conversion dies with "WASM initialization timeout" ' +
    '(experiment in docs/m2-findings.md). Everything else exercised works with only wasm-unsafe-eval.',
});

/**
 * Token ALLOWLIST for every directive that decides where code may come from.
 * Anything not listed (unsafe-inline, unsafe-hashes, strict-dynamic, *, data:,
 * filesystem:, https:, hosts, hashes, nonces, ...) is refused. 'none' only
 * tightens. blob: is allowed in worker-src alone (workers are spawned from
 * blob URLs; script-src has it stripped by tightenCsp).
 */
const SAFE_CODE_SOURCES = Object.freeze(["'self'", "'wasm-unsafe-eval'", "'none'"]);
const CODE_DIRECTIVES = Object.freeze(['script-src', 'script-src-elem', 'script-src-attr', 'worker-src']);

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

function parseDirectives(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values);
  }
  return directives;
}

/** Sources of the effective script directive (script-src, else default-src). */
function scriptSources(csp) {
  const directives = parseDirectives(csp);
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

function assertCodeSourcesFailClosed(csp, allowed) {
  const directives = parseDirectives(csp);
  const checked = CODE_DIRECTIVES.filter((name) => directives.has(name));
  // default-src is the fallback for script-src, so it is held to the same list when script-src is absent.
  if (!directives.has('script-src')) checked.push('default-src');
  for (const name of checked.filter((n) => directives.has(n))) {
    for (const source of directives.get(name)) {
      const lower = source.toLowerCase();
      if (SAFE_CODE_SOURCES.includes(lower) || allowed[lower]) continue;
      if (name === 'worker-src' && lower === 'blob:') continue;
      throw new Error(`CSP ${name} has ${source}, which is not on the code-source allowlist; refusing to serve`);
    }
  }
}

/**
 * Response headers for every app response. The CSP comes from the bundle's
 * own `_headers` (fail closed if absent, external, or any code-source directive leaves the allowlist).
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
  assertCodeSourcesFailClosed(csp, allowedUnsafe);
  const forced = new Set(Object.keys(ISOLATION_HEADERS).map((k) => k.toLowerCase()));
  const kept = Object.fromEntries(
    Object.entries(parsed).filter(([name]) => !forced.has(name.toLowerCase()))
  );
  return Object.freeze({ ...kept, 'Content-Security-Policy': csp, ...ISOLATION_HEADERS });
}

module.exports = { buildAppHeaders, tightenCsp, parseGlobalHeaders, scriptSources, ISOLATION_HEADERS };
