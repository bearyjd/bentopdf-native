'use strict';

// electron-builder afterPack hook: flip the Electron fuses on the unpacked
// binary before it is packed into AppImage / deb / rpm / NSIS / portable.
// electron-builder runs this BEFORE code signing, so the Windows signature (when
// there is one) covers the flipped binary.
const fs = require('node:fs');
const path = require('node:path');
const { flipFuses } = require('@electron/fuses');
const { EXPECTED_FUSES, FuseVersion } = require('./fuse-config');
const { normaliseModes } = require('./normalise-modes');

/** Name of the main executable inside the unpacked app directory. */
function executableOf(context) {
  return context.electronPlatformName === 'win32'
    ? `${context.packager.appInfo.productFilename}.exe`
    : context.packager.executableName;
}

module.exports = async function afterPack(context) {
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
