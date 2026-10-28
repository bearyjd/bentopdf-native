#!/usr/bin/env bash
# Builds the Flatpak into packaging/flatpak/.build/ and exports a single-file
# bundle. User scope only; needs the 25.08 runtime, SDK and Electron2.BaseApp
# from flathub (flatpak install --user flathub ...). Run scripts/package-linux.sh first.
#
# Default: assemble the app directly with `flatpak build-init/build-finish`
# (no build sandbox needed: the payload is already built). Set
# FLATPAK_USE_BUILDER=1 to use flatpak-builder with the manifest instead; that
# path failed on the development host (bwrap could not bind /etc/resolv.conf
# inside the agent sandbox), so it is NOT VERIFIED here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ID=io.github.bearyjd.BentoPDFNative
VERSION="$(node -p "require('$HERE/../../desktop/package.json').version")"
SRC="$HERE/../../desktop/release/linux-unpacked"
[ -x "$SRC/bentopdf-native" ] || { echo "run scripts/package-linux.sh first" >&2; exit 1; }

cd "$HERE"
if [ "${FLATPAK_USE_BUILDER:-0}" = 1 ]; then
  flatpak-builder --user --force-clean --disable-rofiles-fuse --repo=.build/repo --state-dir=.build/state .build/app "$ID.yml"
else
  rm -rf .build/app .build/repo
  mkdir -p .build
  flatpak build-init .build/app "$ID" org.freedesktop.Sdk org.freedesktop.Platform 25.08 \
    --base=org.electronjs.Electron2.BaseApp --base-version=25.08
  APP=.build/app/files
  mkdir -p "$APP/lib/bentopdf-native" "$APP/bin" "$APP/share/applications" "$APP/share/metainfo" "$APP/share/icons/hicolor/512x512/apps"
  cp -a "$SRC/." "$APP/lib/bentopdf-native/"
  rm -f "$APP/lib/bentopdf-native/chrome-sandbox" # zypak provides the sandbox in Flatpak
  install -m755 bentopdf-native.sh "$APP/bin/bentopdf-native"
  install -m644 "$ID.desktop" "$APP/share/applications/$ID.desktop"
  install -m644 "$ID.metainfo.xml" "$APP/share/metainfo/$ID.metainfo.xml"
  install -m644 ../icons/512x512.png "$APP/share/icons/hicolor/512x512/apps/$ID.png"
  # Keep in sync with finish-args in the manifest. No network, no filesystem access.
  # --nosocket=x11 removes the plain x11 socket that the BaseApp grants; fallback-x11 still
  # gives X11 only when no Wayland socket exists.
  flatpak build-finish .build/app --command=bentopdf-native \
    --share=ipc --nosocket=x11 --socket=wayland --socket=fallback-x11 --device=dri
  flatpak build-export .build/repo .build/app
fi
flatpak build-bundle .build/repo ".build/bentopdf-native-$VERSION.flatpak" "$ID"
ls -l .build/*.flatpak
