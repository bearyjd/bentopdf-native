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
DESKTOP="$HERE/../../desktop"
# Names and ids come from desktop/brand.json (docs/desktop-linux.md, "Renaming").
ID="$(node -p "require('$DESKTOP/brand.json').appId")"
EXE="$(node -p "require('$DESKTOP/brand.json').executableName")"
VERSION="$(node -p "require('$DESKTOP/package.json').version")"
SRC="$DESKTOP/release/linux-unpacked"
[ -x "$SRC/$EXE" ] || { echo "run scripts/package-linux.sh first" >&2; exit 1; }

cd "$HERE"
# Render the templates (ids, names, version) into .build/render.
R=.build/render
rm -rf "$R"
mkdir -p "$R"
render() { node "$DESKTOP/tools/render-template.js" "$1" "$2" "${3:-644}"; }
render app.desktop.in "$R/$ID.desktop"
render app.metainfo.xml.in "$R/$ID.metainfo.xml"
render app.yml.in "$R/$ID.yml"
render launcher.sh.in "$R/$EXE.sh" 755
if [ "${FLATPAK_USE_BUILDER:-0}" = 1 ]; then
  flatpak-builder --user --force-clean --disable-rofiles-fuse --repo=.build/repo --state-dir=.build/state .build/app "$R/$ID.yml"
else
  rm -rf .build/app .build/repo
  mkdir -p .build
  flatpak build-init .build/app "$ID" org.freedesktop.Sdk org.freedesktop.Platform 25.08 \
    --base=org.electronjs.Electron2.BaseApp --base-version=25.08
  APP=.build/app/files
  mkdir -p "$APP/lib/$EXE" "$APP/bin" "$APP/share/applications" "$APP/share/metainfo" "$APP/share/icons/hicolor/512x512/apps"
  cp -a "$SRC/." "$APP/lib/$EXE/"
  rm -f "$APP/lib/$EXE/chrome-sandbox" # zypak provides the sandbox in Flatpak
  install -m755 "$R/$EXE.sh" "$APP/bin/$EXE"
  install -m644 "$R/$ID.desktop" "$APP/share/applications/$ID.desktop"
  install -m644 "$R/$ID.metainfo.xml" "$APP/share/metainfo/$ID.metainfo.xml"
  install -m644 ../icons/512x512.png "$APP/share/icons/hicolor/512x512/apps/$ID.png"
  # Keep in sync with finish-args in the manifest. No network, no filesystem access.
  # build-finish adds a plain x11 socket for fallback-x11 on its own. --nosocket=x11 removes it, but ONLY
  # when it comes after --socket=fallback-x11 (given before, fallback-x11 re-adds x11). Keep it last.
  # Result: sockets=!x11;wayland;fallback-x11 (X11 only when there is no Wayland socket).
  flatpak build-finish .build/app --command="$EXE" \
    --share=ipc --socket=wayland --socket=fallback-x11 --device=dri --nosocket=x11
  flatpak build-export .build/repo .build/app
fi
flatpak build-bundle .build/repo ".build/$EXE-$VERSION.flatpak" "$ID"
ls -l .build/*.flatpak
