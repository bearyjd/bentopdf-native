'use strict';

const { Readable } = require('node:stream');
const { protocol } = require('electron');
const { serveStatic } = require('./static-files');

const SCHEME = 'bento';
const ORIGIN = `${SCHEME}://app`;

/**
 * Privileges of the app scheme. Service workers are OFF: sw.js calls
 * Cache.put() on every asset, which rejects non-http(s) URLs, so with the
 * privilege granted every cached asset fetch fails (see docs/m2-findings.md).
 * Pinned by test/security.test.js.
 */
function schemePrivileges({ allowServiceWorkers = false } = {}) {
  return {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    allowServiceWorkers,
  };
}

/** Must run before app 'ready'. */
function registerScheme(options = {}) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: schemePrivileges(options) }]);
}

function toWebBody(body) {
  if (body === null) return null;
  return Buffer.isBuffer(body) ? body : Readable.toWeb(body);
}

/**
 * After 'ready'. Returns {origin, close}. `target` is the protocol object to
 * register on (default session's `protocol`, or `session.protocol` of a
 * partition); `host` is the only host served (`app`, or `shell` for the shell UI).
 */
function startSchemeTransport({ rootReal, headers, target = protocol, host = 'app' }) {
  target.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== host) {
      return new Response('Forbidden', { status: 403, headers });
    }
    const result = await serveStatic({
      rootReal,
      method: request.method,
      urlPath: url.pathname,
      range: request.headers.get('range'),
      baseHeaders: headers,
    });
    return new Response(toWebBody(result.body), {
      status: result.status,
      headers: result.headers,
    });
  });
  return { origin: `${SCHEME}://${host}`, close: () => target.unhandle(SCHEME) };
}

module.exports = { registerScheme, schemePrivileges, startSchemeTransport, SCHEME, ORIGIN };
