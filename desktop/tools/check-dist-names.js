'use strict';

// Gate: no path in the offline bundle trips the Windows-unsafe segment rules of src/static-files.js
// (alternate-stream colon, ~digit short names, trailing dot/space, device names, wildcards, control characters).
// The server applies those rules on EVERY platform, so a bundle asset named like that would be unreachable
// (404) in the packaged app on all of them. Usage: node tools/check-dist-names.js <dist-dir>
const fs = require('node:fs');
const path = require('node:path');
const { isWindowsUnsafeSegment } = require('../src/static-files');

/** Relative paths under `root` (files and directories) with at least one unsafe segment. Symlinks are listed, not followed. */
function unsafeNames(root) {
  const bad = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const here = rel ? `${rel}/${entry.name}` : entry.name;
      if (isWindowsUnsafeSegment(entry.name)) bad.push(here);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), here);
    }
  };
  walk(root, '');
  return bad;
}

if (require.main === module) {
  const root = process.argv[2];
  if (!root || !fs.existsSync(root)) {
    process.stderr.write('usage: check-dist-names.js <dist-dir>\n');
    process.exit(2);
  }
  const bad = unsafeNames(root);
  if (bad.length > 0) {
    process.stderr.write(`CHECK FAILED: ${bad.length} bundle path(s) trip the Windows-unsafe name rules (static-files.js): ${bad.slice(0, 5).join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`check-dist-names: OK (${root})\n`);
}

module.exports = { unsafeNames };
