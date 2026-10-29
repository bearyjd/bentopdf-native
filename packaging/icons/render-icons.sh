#!/usr/bin/env bash
# Renders packaging/icons/icon.svg to the 512x512 PNG used by electron-builder
# and the Flatpak. Needs rsvg-convert (librsvg). The PNG is committed; run this
# only after editing the SVG.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v rsvg-convert >/dev/null 2>&1 || { echo "render-icons: rsvg-convert not found" >&2; exit 1; }
rsvg-convert -w 512 -h 512 "$HERE/icon.svg" -o "$HERE/512x512.png"
echo "wrote $HERE/512x512.png"
