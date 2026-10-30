'use strict';

// SMOKE flavour (issue #13): carries the real src/test-mode.js. Built only for the packaged smoke tests and never
// distributed (artifacts are named SMOKE-ONLY-NOT-FOR-DISTRIBUTION). Packed as src/build-flavour.js.
module.exports = Object.freeze({ flavour: 'smoke' });
