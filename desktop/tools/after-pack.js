'use strict';

// electron-builder afterPack hook: flip the Electron fuses on the unpacked
// binary before it is packed into AppImage / deb / rpm / NSIS / portable.
// electron-builder runs this BEFORE code signing, so the Windows signature (when
// there is one) covers the flipped binary.
const fs = require('node:fs');
const path = require('node:path');
const { extractFile } = require('@electron/asar');
const { flipFuses } = require('@electron/fuses');
const { EXPECTED_FUSES, FuseVersion } = require('./fuse-config');
const { normaliseModes } = require('./normalise-modes');
const { FLAVOUR_DIR, flavourOf } = require('./flavour');

/** Name of the main executable inside the unpacked app directory. */
function executableOf(context) {
  return context.electronPlatformName === 'win32'
    ? `${context.packager.appInfo.productFilename}.exe`
    : context.packager.executableName;
}

/** Fails the build when the packed flavour files are not the ones BENTO_FLAVOUR selects (tools/flavour.js). */
function assertFlavour(appOutDir) {
  const flavour = flavourOf();
  const asar = path.join(appOutDir, 'resources', 'app.asar');
  const packed = (name) => extractFile(asar, `src/${name}`).toString('utf8');
  const own = (name) => fs.readFileSync(path.join(FLAVOUR_DIR, flavour, name), 'utf8');
  if (packed('build-flavour.js') !== own('build-flavour.js')) throw new Error(`afterPack: packed src/build-flavour.js is not the ${flavour} one`);
  const stub = fs.readFileSync(path.join(FLAVOUR_DIR, 'release', 'test-mode.js'), 'utf8');
  if ((packed('test-mode.js') === stub) !== (flavour === 'release')) throw new Error(`afterPack: packed src/test-mode.js does not match the ${flavour} flavour`);
  return flavour;
}

module.exports = async function afterPack(context) {
  process.stderr.write(`[flavour] ${assertFlavour(context.appOutDir)} (app.asar checked)\n`);
  const exe = path.join(context.appOutDir, executableOf(context));
  if (!fs.existsSync(exe)) throw new Error(`afterPack: ${exe} does not exist`);
  await flipFuses(exe, { version: FuseVersion.V1, ...EXPECTED_FUSES });
  // Electron's placeholder app; unused once app.asar exists.
  fs.rmSync(path.join(context.appOutDir, 'resources', 'default_app.asar'), { force: true });
  process.stderr.write(`[fuses] flipped on ${exe}\n`);
  // POSIX modes mean nothing on Windows.
  if (context.electronPlatformName !== 'win32') {
    process.stderr.write(`[modes] normalised ${normaliseModes(context.appOutDir)} entries\n`);
  }
};
