'use strict';

// Usage: node tools/render-template.js <template> <output> [mode]
// Replaces @APP_ID@, @PRODUCT_NAME@, @EXECUTABLE@, @SUMMARY@, @SOURCE_URL@ and
// @VERSION@ from brand.json / package.json. Unknown @NAME@ tokens are an error.
const fs = require('node:fs');
const brand = require('../brand.json');
const pkg = require('../package.json');

const VALUES = {
  APP_ID: brand.appId,
  PRODUCT_NAME: brand.productName,
  EXECUTABLE: brand.executableName,
  SUMMARY: brand.summary,
  SOURCE_URL: brand.sourceUrl,
  VERSION: pkg.version,
};

function render(text) {
  return text.replace(/@([A-Z_]+)@/g, (match, name) => {
    if (!(name in VALUES)) throw new Error(`unknown template token ${match}`);
    return VALUES[name];
  });
}

if (require.main === module) {
  const [template, output, mode] = process.argv.slice(2);
  if (!template || !output) throw new Error('usage: render-template.js <template> <output> [mode]');
  fs.writeFileSync(output, render(fs.readFileSync(template, 'utf8')), { mode: mode ? parseInt(mode, 8) : 0o644 });
}

module.exports = { render };
