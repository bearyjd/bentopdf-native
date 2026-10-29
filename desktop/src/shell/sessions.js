'use strict';

const { ISOLATION_HEADERS } = require('../headers');
const { lockSession } = require('../security');
const { startSchemeTransport } = require('../transport-scheme');

const SHELL_HOST = 'shell';

/** The shell UI is our own code: no eval, no inline script or style, nothing external. */
const SHELL_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  ...ISOLATION_HEADERS,
});

/**
 * Give a session the full treatment the default session gets in the M2 app:
 * the bento:// handler for exactly one host (COOP/COEP/CORP + CSP on every
 * response), all permissions denied, every request outside that origin
 * cancelled. Idempotent per session (protocol.handle throws when repeated).
 * @returns {string} the origin the session is locked to
 */
function prepareSession(ses, { prepared, rootReal, headers, host = 'app', onBlocked, onPermission, allowDevtools, extraAllowed }) {
  const origin = `bento://${host}`;
  if (prepared.has(ses)) return origin;
  startSchemeTransport({ rootReal, headers, target: ses.protocol, host });
  lockSession(ses, origin, onBlocked, { allowDevtools, onPermission, extraAllowed });
  prepared.add(ses);
  return origin;
}

module.exports = { prepareSession, SHELL_HEADERS, SHELL_HOST };
