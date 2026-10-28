'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { buildAppHeaders, scriptSources } = require('../src/headers');

const dirs = [];
function dist(headerLines, extra = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-headers-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, '_headers'), `/*\n${headerLines.map((l) => `  ${l}`).join('\n')}\n`);
  extra(dir);
  return dir;
}
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const SAFE_CSP = "Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:";

test('shell COOP/COEP/CORP always win over the bundle values, whatever their case', () => {
  const headers = buildAppHeaders(
    dist([SAFE_CSP, 'Cross-Origin-Embedder-Policy: credentialless', 'cross-origin-resource-policy: cross-origin', 'Cross-Origin-Opener-Policy: unsafe-none'])
  );
  assert.equal(headers['Cross-Origin-Embedder-Policy'], 'require-corp');
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(Object.keys(headers).filter((k) => /^cross-origin-/i.test(k)).length, 3);
});

test('fails closed on unsafe-eval / unsafe-inline in script-src unless allowlisted with a reason', () => {
  const evalCsp = "Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval'";
  assert.throws(() => buildAppHeaders(dist([evalCsp]), { allowedUnsafe: {} }), /unsafe-eval/);
  assert.throws(() => buildAppHeaders(dist(["Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline'"])), /unsafe-inline/, 'the default allowlist covers only unsafe-eval');
  assert.throws(() => buildAppHeaders(dist(["Content-Security-Policy: default-src 'self' 'unsafe-eval'"]), { allowedUnsafe: {} }), /unsafe-eval/, 'default-src applies when script-src is absent');
  assert.doesNotThrow(() => buildAppHeaders(dist([evalCsp]), { allowedUnsafe: { "'unsafe-eval'": 'test reason' } }));
  assert.doesNotThrow(() => buildAppHeaders(dist(["Content-Security-Policy: default-src 'self'; style-src 'unsafe-inline'; script-src 'self'"])));
});

test('reasoned unsafe exceptions need a non-empty reason; code sources reject https: directly', () => {
  const evalCsp = "Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval'";
  assert.throws(() => buildAppHeaders(dist([evalCsp]), { allowedUnsafe: { "'unsafe-eval'": '' } }), /unsafe-eval/);
  // Direct call: the allowlist itself must refuse https: even if the external-origin guard were removed.
  const { assertCodeSourcesFailClosed } = require('../src/headers');
  assert.throws(() => assertCodeSourcesFailClosed("script-src 'self'; script-src-elem 'self' https:", {}), /script-src-elem/);
  assert.throws(() => assertCodeSourcesFailClosed("script-src 'self'; worker-src 'self' https://cdn.example", {}), /worker-src/);
});

const REJECTED = {
  'unsafe-inline': "'unsafe-inline'",
  'unsafe-hashes': "'unsafe-hashes'",
  'strict-dynamic': "'strict-dynamic'",
  wildcard: '*',
  'data:': 'data:',
  'filesystem:': 'filesystem:',
  'scheme source': 'wss:',
  'host source': '//evil.com',
  'bare host': 'evil.com',
  hash: "'sha256-AAAA'",
  nonce: "'nonce-abc'",
  'blob: outside worker-src': 'blob:',
};
for (const directive of ['script-src', 'script-src-elem', 'script-src-attr', 'worker-src']) {
  for (const [label, token] of Object.entries(REJECTED)) {
    // blob: has its own tests: accepted in worker-src, reasoned allowlist in script-src.
    if (token === 'blob:' && (directive === 'worker-src' || directive === 'script-src')) continue;
    test(`${directive} rejects ${label}`, () => {
      const csp = `Content-Security-Policy: default-src 'self'; ${directive} 'self' ${token}`;
      assert.throws(() => buildAppHeaders(dist([csp])), /allowlist/, csp);
    });
  }
}

test('default-src is held to the allowlist only when script-src is absent', () => {
  for (const token of Object.values(REJECTED)) {
    assert.throws(() => buildAppHeaders(dist([`Content-Security-Policy: default-src 'self' ${token}`])), /allowlist/, token);
  }
  assert.doesNotThrow(() => buildAppHeaders(dist([`Content-Security-Policy: default-src 'self' data:; script-src 'self'`])));
});

test('allowlisted tokens pass; blob: is accepted in worker-src only', () => {
  assert.doesNotThrow(() => buildAppHeaders(dist(["Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; script-src-elem 'self'; script-src-attr 'none'; worker-src 'self' blob:"])));
});

test('only the first occurrence of a directive counts, as in the browser', () => {
  assert.throws(() => buildAppHeaders(dist(["Content-Security-Policy: script-src 'self' *; script-src 'self'"])), /allowlist/);
});

test('refuses missing CSP, external origins and a dist/docs directory', () => {
  assert.throws(() => buildAppHeaders(dist(['X-Frame-Options: DENY'])), /no Content-Security-Policy/);
  assert.throws(() => buildAppHeaders(dist(["Content-Security-Policy: default-src 'self' https://cdn.example"])), /external/);
  assert.throws(() => buildAppHeaders(dist([SAFE_CSP], (d) => fs.mkdirSync(path.join(d, 'docs')))), /dist\/docs/);
});

test('scriptSources falls back to default-src', () => {
  assert.deepEqual(scriptSources("default-src 'self'; img-src data:"), ["'self'"]);
  assert.deepEqual(scriptSources("default-src 'none'; script-src 'self' blob:"), ["'self'", 'blob:']);
});

test('blob: is served in script-src only via the reasoned allowlist, and never in script-src-elem/-attr', () => {
  const csp = "Content-Security-Policy: default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:";
  assert.throws(() => buildAppHeaders(dist([csp]), { allowedUnsafe: {} }), /script-src has blob:/);
  assert.equal(buildAppHeaders(dist([csp]))['Content-Security-Policy'], csp.replace('Content-Security-Policy: ', ''));
  for (const directive of ['script-src-elem', 'script-src-attr']) {
    assert.throws(() => buildAppHeaders(dist([`Content-Security-Policy: default-src 'self'; ${directive} blob:`])), /allowlist/, directive);
  }
});

test('the real dist CSP is accepted only through the documented unsafe-eval allowlist', () => {
  const real = path.resolve(__dirname, '..', '..', 'dist');
  if (!fs.existsSync(path.join(real, '_headers'))) return;
  assert.throws(() => buildAppHeaders(real, { allowedUnsafe: {} }), /unsafe-eval/);
  const csp = buildAppHeaders(real)['Content-Security-Policy'];
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:;/);
});
