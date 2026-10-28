#!/usr/bin/env bash
# Rewrites the AppImage built by electron-builder in place so that it uses
# packaging/linux/AppRun (no silent --no-sandbox fallback).
# Usage: packaging/harden-appimage.sh <file.AppImage>
# Needs mksquashfs: $MKSQUASHFS, PATH, or the copy electron-builder caches.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMG="$(readlink -f "${1:?usage: harden-appimage.sh <file.AppImage>}")"
die() { echo "harden-appimage: $*" >&2; exit 1; }
[ -f "$IMG" ] || die "no such file: $IMG"

MKSQUASHFS="${MKSQUASHFS:-$(command -v mksquashfs || true)}"
if [ -z "$MKSQUASHFS" ]; then
  MKSQUASHFS="$(find "${ELECTRON_BUILDER_CACHE:-$HOME/.cache/electron-builder}" -path '*linux-x64/mksquashfs' -print -quit 2>/dev/null || true)"
fi
[ -n "$MKSQUASHFS" ] && [ -x "$MKSQUASHFS" ] || die "mksquashfs not found"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

OFFSET="$("$IMG" --appimage-offset)"
(cd "$WORK" && "$IMG" --appimage-extract >/dev/null)
install -m 755 "$HERE/linux/AppRun" "$WORK/squashfs-root/AppRun"
# electron-builder hardcodes %U for AppImage; one local file (%f) matches the other formats. file:// URLs are handled anyway.
sed -i -E 's/^(Exec=.*) %f %U$/\1 %f/; s/^(Exec=.*) %U$/\1 %f/' "$WORK"/squashfs-root/*.desktop

"$MKSQUASHFS" "$WORK/squashfs-root" "$WORK/new.AppImage" -offset "$OFFSET" -all-root -noappend -no-progress -quiet -no-xattrs -no-fragments
head -c "$OFFSET" "$IMG" | dd of="$WORK/new.AppImage" conv=notrunc status=none
chmod 755 "$WORK/new.AppImage"
mv "$WORK/new.AppImage" "$IMG"
echo "hardened $IMG"
