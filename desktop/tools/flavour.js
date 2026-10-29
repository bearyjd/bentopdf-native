'use strict';

// Build flavours (issue #13). Both are built from the same source; they differ only in two packed files:
//   release (default)  src/test-mode.js <- flavours/release/test-mode.js (stub: no test mode at all)
//                      src/build-flavour.js <- flavours/release/build-flavour.js ('release')
//   smoke              src/test-mode.js as committed (real marker logic), src/build-flavour.js <- 'smoke'.
//                      For the packaged smoke tests only; never distributed, never signed.
// The swap happens in electron-builder's file list, i.e. BEFORE app.asar is written. Rewriting app.asar in afterPack
// would be too late: electron-builder computes the asar integrity hash (EnableEmbeddedAsarIntegrityValidation fuse)
// before afterPack runs (app-builder-lib platformPackager.js), so a rewritten asar would not match it.
const path = require('node:path');

const FLAVOURS = ['release', 'smoke'];
const FLAVOUR_DIR = path.join(__dirname, '..', 'flavours');
// Signing material electron-builder picks up from the environment: a smoke build must never see any of it.
const SIGNING_ENV = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'AZURE_SIGN_ENDPOINT',
  'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];

/** BENTO_FLAVOUR: unset or empty means release; anything other than release / smoke is an error. */
function flavourOf(env = process.env) {
  const value = env.BENTO_FLAVOUR === undefined || env.BENTO_FLAVOUR === '' ? 'release' : env.BENTO_FLAVOUR;
  if (!FLAVOURS.includes(value)) throw new Error(`BENTO_FLAVOUR must be one of ${FLAVOURS.join(', ')} (got ${JSON.stringify(value)})`);
  if (value === 'smoke') {
    const signing = SIGNING_ENV.filter((key) => env[key]);
    if (signing.length > 0) throw new Error(`refusing a smoke build with signing material in the environment: ${signing.join(', ')}`);
  }
  return value;
}

/** electron-builder `files` for a flavour: the app sources, with the flavour's own files packed over src/. */
function appFiles(flavour) {
  const replaced = flavour === 'release' ? ['!src/build-flavour.js', '!src/test-mode.js'] : ['!src/build-flavour.js'];
  const fromFlavour = flavour === 'release' ? ['build-flavour.js', 'test-mode.js'] : ['build-flavour.js'];
  return ['package.json', 'brand.json', 'src/**/*', ...replaced, '!**/*.map', { from: `flavours/${flavour}`, to: 'src', filter: fromFlavour }];
}

/** Output directory (relative to desktop/): smoke artifacts never land next to release ones. */
const outputDir = (flavour) => (flavour === 'release' ? 'release' : 'release-smoke');

/** Artifact name tag: smoke artifacts say what they are in their file name. */
const nameTag = (flavour) => (flavour === 'release' ? '' : '-SMOKE-ONLY-NOT-FOR-DISTRIBUTION');

module.exports = { FLAVOURS, FLAVOUR_DIR, SIGNING_ENV, flavourOf, appFiles, outputDir, nameTag };

// `node tools/flavour.js output-dir` prints the output directory for BENTO_FLAVOUR (used by the package scripts).
if (require.main === module) {
  if (process.argv[2] !== 'output-dir') { process.stderr.write('usage: flavour.js output-dir\n'); process.exit(2); }
  process.stdout.write(`${outputDir(flavourOf())}\n`);
}
