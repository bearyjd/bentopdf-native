#!/usr/bin/env bash
# Builds the Flatpak into packaging/flatpak/.build/ and exports a single-file
# bundle. User scope only; needs the 25.08 runtime, SDK and Electron2.BaseApp
# from flathub (flatpak install --user flathub ...). Run scripts/package-linux.sh first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ID=io.github.bearyjd.BentoPDFNative
[ -x "$HERE/../../desktop/release/linux-unpacked/bentopdf-native" ] || { echo "run scripts/package-linux.sh first" >&2; exit 1; }

cd "$HERE"
flatpak-builder --user --force-clean --disable-rofiles-fuse --repo=.build/repo --state-dir=.build/state .build/app "$ID.yml"
flatpak build-bundle .build/repo ".build/bentopdf-native-0.1.0.flatpak" "$ID"
ls -l .build/*.flatpak
