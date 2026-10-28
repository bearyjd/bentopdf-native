'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const brand = require('../brand.json');
const pkg = require('../package.json');
const config = require('../electron-builder.config');
const { SOURCE_URL } = require('../src/menu');

test('brand.json is the single source: builder config and About agree with it', () => {
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
