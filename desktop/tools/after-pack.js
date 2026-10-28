'use strict';

// electron-builder afterPack hook: flip the Electron fuses on the unpacked
// binary before it is packed into AppImage / deb / rpm.
const fs = require('node:fs');
const path = require('node:path');
const { flipFuses } = require('@electron/fuses');
const { EXPECTED_FUSES, FuseVersion } = require('./fuse-config');

module.exports = async function afterPack(context) {
  const exe = path.join(context.appOutDir, context.packager.executableName);
  await flipFuses(exe, { version: FuseVersion.V1, ...EXPECTED_FUSES });
  // Electron's placeholder app; unused once app.asar exists.
  fs.rmSync(path.join(context.appOutDir, 'resources', 'default_app.asar'), { force: true });
  process.stderr.write(`[fuses] flipped on ${exe}\n`);
};
