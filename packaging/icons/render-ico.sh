#!/usr/bin/env bash
# Renders packaging/icons/icon.svg to packaging/icons/icon.ico (16..256 px, PNG entries)
# for the Windows build. Needs rsvg-convert (librsvg) and node. The .ico is committed;
# run this only after editing the SVG.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v rsvg-convert >/dev/null 2>&1 || { echo "render-ico: rsvg-convert not found" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -f "$TMP"/*.png; rmdir "$TMP"' EXIT
specs=()
for size in 16 24 32 48 64 128 256; do
  rsvg-convert -w "$size" -h "$size" "$HERE/icon.svg" -o "$TMP/$size.png"
  specs+=("$size:$TMP/$size.png")
done
node "$HERE/make-ico.js" "$HERE/icon.ico" "${specs[@]}"
