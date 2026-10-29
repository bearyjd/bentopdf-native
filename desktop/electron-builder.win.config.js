'use strict';

// Windows x64 packaging (NSIS installer + portable exe). Run via `npm run dist:win`.
// Derived from the Linux config so the app payload, licences and hardening stay identical;
// the Linux-only keys (electronDist points at the Linux Electron, linux/deb/rpm/appImage) are dropped.
// Signing: none configured here. electron-builder signs only when CSC_LINK/CSC_KEY_PASSWORD
// (or WIN_CSC_*) are present in the environment, or when all AZURE_* variables below are set.
const brand = require('./brand.json');
const base = require('./electron-builder.config');
const { flavourOf, nameTag } = require('./tools/flavour');

// eslint-disable-next-line no-unused-vars
const { electronDist, linux, appImage, deb, rpm, artifactName, extraMetadata, ...shared } = base;

// A smoke build (BENTO_FLAVOUR=smoke) refuses to run with signing material in the environment (tools/flavour.js).
const name = `${brand.executableName}${nameTag(flavourOf())}`;
const azure = ['AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER'];
const azureSignOptions = azure.every((key) => process.env[key])
  ? {
      endpoint: process.env.AZURE_SIGN_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_SIGN_ACCOUNT,
      certificateProfileName: process.env.AZURE_SIGN_PROFILE,
      publisherName: process.env.AZURE_SIGN_PUBLISHER,
    }
  : undefined;

module.exports = {
  ...shared,
  extraMetadata: { homepage: brand.sourceUrl },
  win: {
    target: [
      { target: 'nsis', arch: 'x64' },
      { target: 'portable', arch: 'x64' },
    ],
    icon: brand.iconIco,
    ...(azureSignOptions ? { azureSignOptions } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false, // per-user by default; the wizard can still offer all-users
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: brand.productName,
    deleteAppDataOnUninstall: false, // user settings/profile are not installed files; see docs/desktop-windows.md
    differentialPackage: false,
    runAfterFinish: false,
    include: '../packaging/windows/installer.nsh',
    artifactName: `${name}-\${version}-setup-\${arch}.\${ext}`,
  },
  portable: {
    artifactName: `${name}-\${version}-portable-\${arch}.\${ext}`,
    requestExecutionLevel: 'user',
  },
};
