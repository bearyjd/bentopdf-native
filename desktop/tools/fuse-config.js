'use strict';

const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// One list drives both the afterPack hook and the check script, so they cannot drift.
// Every fuse is pinned, including the two that only restate Electron's default (V8 snapshot off, wasm trap handlers
// on), so the gate fails on any drift in any index.
const EXPECTED_FUSES = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // Harmless, but believed to be a no-op on Linux (docs/desktop-linux.md): not relied upon.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
});

module.exports = { EXPECTED_FUSES, FuseVersion };
