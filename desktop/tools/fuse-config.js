'use strict';

const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// One list drives both the afterPack hook and the check script, so they cannot drift.
// Fuses not listed (LoadBrowserProcessSpecificV8Snapshot, WasmTrapHandlers) keep Electron's default.
const EXPECTED_FUSES = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});

module.exports = { EXPECTED_FUSES, FuseVersion };
