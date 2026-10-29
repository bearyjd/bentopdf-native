'use strict';

// brand.json values end up in shell scripts, a YAML manifest, .desktop files and
// XML. Anything outside these patterns is rejected rather than escaped.
const PATTERNS = {
  productName: /^[A-Za-z0-9 ._-]+$/,
  appId: /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_-]*){2,}$/,
  executableName: /^[a-z0-9][a-z0-9-]*$/,
  iconPng: /^[A-Za-z0-9._/-]+$/,
  summary: /^[A-Za-z0-9 ._,()-]+$/,
  sourceUrl: /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~-]+)*$/,
  upstreamUrl: /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~-]+)*$/,
};

/** Throws naming the first offending key; returns `brand` when every value is acceptable. */
function validateBrand(brand) {
  for (const [key, pattern] of Object.entries(PATTERNS)) {
    const value = brand && brand[key];
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new Error(`brand.json: "${key}" has an unacceptable value (must match ${pattern})`);
    }
  }
  return brand;
}

const xmlEscape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

module.exports = { validateBrand, xmlEscape, PATTERNS };
