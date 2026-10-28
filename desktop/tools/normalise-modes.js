'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Electron's download keeps whatever modes the zip carried (0777 / 0666 on several
// files). Every package would inherit that, so normalise before packing:
// directories 0755, files 0755 when any execute bit is set, else 0644.
// chrome-sandbox is 0755 here on purpose: only the deb/rpm post-install script
// makes it setuid, and only where user namespaces do not work.
function normaliseModes(root) {
  let changed = 0;
  const visit = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    const want = stat.isDirectory() ? 0o755 : (stat.mode & 0o111) ? 0o755 : 0o644;
    if ((stat.mode & 0o7777) !== want) {
      fs.chmodSync(entry, want);
      changed += 1;
    }
    if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
  };
  visit(root);
  return changed;
}

module.exports = { normaliseModes };
