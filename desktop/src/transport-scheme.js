'use strict';

const { Readable } = require('node:stream');
const { protocol } = require('electron');
const { serveStatic } = require('./static-files');

const SCHEME = 'bento';
const ORIGIN = `${SCHEME}://app`;

/**
 * Must run before app 'ready'. Service workers are OFF by default: sw.js
 * calls Cache.put() on every asset, which rejects non-http(s) URLs, so with
 * the privilege granted every cached asset fetch fails (see docs/m2-findings.md).
 */
function registerScheme({ allowServiceWorkers = false } = {}) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        allowServiceWorkers,
      },
    },
  ]);
}

function toWebBody(body) {
  if (body === null) return null;
  return Buffer.isBuffer(body) ? body : Readable.toWeb(body);
}

/** After 'ready'. Returns {origin, close}. */
function startSchemeTransport({ rootReal, headers }) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') {
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
  return { origin: ORIGIN, close: () => protocol.unhandle(SCHEME) };
}

module.exports = { registerScheme, startSchemeTransport, SCHEME, ORIGIN };
