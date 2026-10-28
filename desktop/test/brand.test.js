'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const brand = require('../brand.json');
const pkg = require('../package.json');
const config = require('../electron-builder.config');
const { SOURCE_URL } = require('../src/menu');
const { validateBrand, xmlEscape } = require('../tools/brand-check');
const { render } = require('../tools/render-template');

test('brand.json is the single source: builder config and About agree with it', () => {
  validateBrand(brand);
  assert.match(brand.appId, /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_-]*){2,}$/);
  assert.match(brand.executableName, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(pkg.desktopName, undefined, 'desktopName comes from brand.json via electron-builder extraMetadata, not package.json');
  assert.equal(config.appId, brand.appId);
  assert.equal(config.productName, brand.productName);
  assert.equal(config.linux.executableName, brand.executableName);
  assert.equal(config.extraMetadata.desktopName, `${brand.appId}.desktop`);
  assert.equal(config.deb.packageName, brand.executableName);
  assert.equal(config.rpm.packageName, brand.executableName);
  assert.equal(config.linux.icon, brand.iconPng);
  assert.equal(SOURCE_URL, brand.sourceUrl);
});

test('validateBrand rejects shell, YAML, XML and newline injection in every value', () => {
  const hostile = ['$(touch /tmp/x)', '`id`', 'a"b', "a'b", 'a&b', 'a<b>', 'a\nb', 'a;b', 'a|b', 'a\\b', '${HOME}', ''];
  for (const key of Object.keys(brand)) {
    for (const bad of hostile) {
      assert.throws(() => validateBrand({ ...brand, [key]: bad }), /brand\.json/, `${key}=${JSON.stringify(bad)}`);
      if (bad) assert.throws(() => validateBrand({ ...brand, [key]: `${brand[key]}${bad}` }), /brand\.json/, `${key}+${JSON.stringify(bad)}`);
    }
  }
  assert.throws(() => validateBrand({ ...brand, sourceUrl: 'http://github.com/x/y' }), /sourceUrl/);
  assert.throws(() => validateBrand({ ...brand, sourceUrl: 'https://github.com/x/y\n' }), /sourceUrl/);
  assert.throws(() => validateBrand({ ...brand, sourceUrl: 'https://u:p@github.com/x' }), /sourceUrl/);
  assert.throws(() => validateBrand({ ...brand, productName: undefined }), /productName/);
});

test('render escapes substituted values for XML templates and rejects unknown tokens', () => {
  assert.equal(xmlEscape(`<&>"'`), '&lt;&amp;&gt;&quot;&apos;');
  assert.equal(render('<name>@PRODUCT_NAME@</name>', { xml: true }), `<name>${brand.productName}</name>`);
  assert.throws(() => render('@NOPE@'), /unknown template token/);
});
