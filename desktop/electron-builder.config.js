'use strict';

// Linux x64 packaging. Run via `npm run dist:linux` (scripts/package-linux.sh).
// Names, ids and URLs come from brand.json (see docs/desktop-linux.md, "Renaming").
// Layout decision (docs/desktop-linux.md): app code in app.asar, the ~370 MB
// offline bundle as an extraResource OUTSIDE the asar (Range reads, no 4 GiB
// asar-offset concerns, no unpack-on-read copies).
const brand = require('./brand.json');

module.exports = {
  appId: brand.appId,
  productName: brand.productName,
  copyright: 'Copyright (C) 2026 bearyjd and contributors. AGPL-3.0-only.',
  artifactName: `${brand.executableName}-\${version}-\${arch}.\${ext}`,
  directories: { output: 'release' },
  electronDist: 'node_modules/electron/dist',
  electronVersion: '45.1.0',
  npmRebuild: false,
  nodeGypRebuild: false,
  asar: true,
  compression: 'normal',
  afterPack: 'tools/after-pack.js',
  // The window class / Wayland app_id comes from desktopName in package.json.
  extraMetadata: { desktopName: `${brand.appId}.desktop`, homepage: brand.sourceUrl },
  files: ['package.json', 'brand.json', 'src/**/*', '!**/*.map'],
  extraResources: [
    { from: '../dist', to: 'dist', filter: ['**/*'] },
    { from: '../LICENSE', to: 'LICENSE' },
    { from: '../NOTICE', to: 'NOTICE' },
    { from: '../packaging/generated/SOURCE.txt', to: 'SOURCE.txt' },
  ],
  linux: {
    target: [
      { target: 'AppImage', arch: 'x64' },
      { target: 'deb', arch: 'x64' },
      { target: 'rpm', arch: 'x64' },
    ],
    executableName: brand.executableName,
    category: 'Office;Utility',
    icon: '../packaging/icons/512x512.png',
    syncDesktopName: true,
    // No --no-sandbox, ever. Exec field codes are set per target below.
    mimeTypes: ['application/pdf'],
    desktop: {
      entry: {
        Comment: brand.summary,
        Categories: 'Office;Utility;',
        Keywords: 'PDF;document;',
      },
    },
  },
  appImage: {
    // electron-builder appends %U itself for AppImage (file:// URLs are handled in src/open-file.js).
    // Its generated AppRun silently adds --no-sandbox when user namespaces are
    // unavailable, so packaging/harden-appimage.sh replaces it after the build.
    executableArgs: ['--ozone-platform-hint=auto'],
  },
  deb: {
    executableArgs: ['--ozone-platform-hint=auto', '%f'],
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0'],
    // Picks the sandbox mode at install time; the payload's chrome-sandbox is NOT setuid.
    afterInstall: '../packaging/linux/after-install.sh',
  },
  rpm: {
    afterInstall: '../packaging/linux/after-install.sh',
    executableArgs: ['--ozone-platform-hint=auto', '%f'],
    // Fedora/RHEL package names (electron-builder's defaults are SUSE/Debian-ish).
    depends: ['gtk3', 'libnotify', 'nss', 'libXScrnSaver', 'libXtst', 'xdg-utils', 'at-spi2-core', 'libuuid'],
  },
};
