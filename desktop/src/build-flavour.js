'use strict';

// Build flavour (issue #13). This committed file says 'dev': unpackaged runs and the unit tests. Packaged builds never
// ship it: electron-builder packs flavours/<release|smoke>/build-flavour.js in its place (tools/flavour.js), and the
// release gate fails any artifact whose flavour is not the one it was asked to verify.
module.exports = Object.freeze({ flavour: 'dev' });
