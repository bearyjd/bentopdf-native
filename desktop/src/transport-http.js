'use strict';

const http = require('node:http');
const { serveStatic } = require('./static-files');

/**
 * Loopback-only HTTP server on a random port. Rejects requests whose Host
 * is not our exact loopback origin (DNS rebinding) or whose Origin header
 * names a different origin (other local web pages).
 */
function startHttpTransport({ rootReal, headers }) {
  return new Promise((resolve, reject) => {
    let origin = '';
    const server = http.createServer(async (req, res) => {
      const fail = (status, text) => {
        res.writeHead(status, { ...headers, 'Content-Type': 'text/plain' });
        res.end(text);
      };
      try {
        const host = new URL(origin).host;
        if (req.headers.host !== host) return fail(421, 'Misdirected');
        if (req.headers.origin && req.headers.origin !== origin) {
          return fail(403, 'Forbidden');
        }
        const url = new URL(req.url, origin);
        const result = await serveStatic({
          rootReal,
          method: req.method,
          urlPath: url.pathname,
          range: req.headers.range,
          baseHeaders: headers,
        });
        res.writeHead(result.status, result.headers);
        if (result.body === null) return res.end();
        if (Buffer.isBuffer(result.body)) return res.end(result.body);
        result.body.on('error', () => res.destroy());
        result.body.pipe(res);
      } catch (err) {
        process.stderr.write(`[transport-http] ${err && err.stack}\n`);
        if (!res.headersSent) fail(500, 'Internal error');
        else res.destroy();
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        origin,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startHttpTransport };
