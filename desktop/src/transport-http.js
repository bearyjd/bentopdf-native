'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { pipeline } = require('node:stream');
const { serveStatic } = require('./static-files');

const COOKIE_NAME = 'bento_token';

function hasToken(cookieHeader, token) {
  const wanted = Buffer.from(`${COOKIE_NAME}=${token}`);
  return String(cookieHeader || '')
    .split(';')
    .map((c) => Buffer.from(c.trim()))
    .some((c) => c.length === wanted.length && crypto.timingSafeEqual(c, wanted));
}

/**
 * Loopback-only HTTP server on a random port. Rejects requests whose Host
 * is not our exact loopback origin (DNS rebinding), whose Origin header names
 * a different origin, or that lack the per-run secret cookie. The caller
 * installs the cookie (`cookie` in the result) into the window's session
 * before loading, so other local processes that can reach the port but do not
 * know the token get 403.
 */
function startHttpTransport({ rootReal, headers }) {
  const token = crypto.randomBytes(24).toString('hex');
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
        if (!hasToken(req.headers.cookie, token)) return fail(403, 'Forbidden');
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
        // pipeline destroys the file stream if the client aborts.
        return pipeline(result.body, res, () => {});
      } catch (err) {
        process.stderr.write(`[transport-http] ${err && err.stack}\n`);
        if (!res.headersSent) return fail(500, 'Internal error');
        return res.destroy();
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        origin,
        cookie: { url: origin, name: COOKIE_NAME, value: token, httpOnly: true, sameSite: 'strict' },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

module.exports = { startHttpTransport, COOKIE_NAME };
