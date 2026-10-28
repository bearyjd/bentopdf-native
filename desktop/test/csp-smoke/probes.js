'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Capability probes: run real code paths whose script source a plain page load never exercises.
// Each probe returns a small detail object or throws.
const TINY_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R/Size 4>>
%%EOF`;

module.exports = {
  // ghostscript-loader does import(URL.createObjectURL(new Blob([gs.js]))): a blob: module script.
  async ghostscript(wc, distDir) {
    const loader = fs.readdirSync(path.join(distDir, 'assets')).find((f) => /^ghostscript-loader-.*\.js$/.test(f));
    if (!loader) throw new Error('no ghostscript-loader asset in dist');
    return wc.executeJavaScript(
      `(async () => {
        const mod = await import('/assets/${loader}');
        const out = await mod.r(new TextEncoder().encode(${JSON.stringify(TINY_PDF)}));
        return { loader: '${loader}', outputBytes: out.length };
      })()`,
      true
    );
  },
};
