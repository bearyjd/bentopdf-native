'use strict';

// RELEASE flavour (issue #13): no test mode at all. Packed as src/build-flavour.js; the release gate requires it.
module.exports = Object.freeze({ flavour: 'release' });
