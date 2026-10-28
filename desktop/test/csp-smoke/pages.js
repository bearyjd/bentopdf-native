'use strict';

const fs = require('node:fs');

// Pages that are not part of the offline bundle (and must never be loaded if they appear).
const EXCLUDED = new Set(['404', 'kura', 'hyper-compress']);

/** Every top-level HTML page in dist (tools, index, content pages), as clean URL paths. */
function listPages(distDir) {
  return fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith('.html') && !EXCLUDED.has(f.slice(0, -5)))
    .map((f) => (f === 'index.html' ? '/index.html' : `/${f.slice(0, -5)}`))
    .sort();
}

module.exports = { listPages, EXCLUDED };
