#!/usr/bin/env bash
# Builds the Linux x64 packages (AppImage, deb, rpm) into desktop/release/.
# BENTO_FLAVOUR=smoke builds only a SMOKE-flavour AppImage (test mode inside; for the packaged smoke test, never
# distributed) into desktop/release-smoke/ (desktop/tools/flavour.js, issue #13).
# Builds the offline bundle first when dist/ is missing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f dist/index.html ]; then
  echo "package-linux: dist/ missing, running scripts/build-local.sh" >&2
  bash scripts/build-local.sh
fi
bash scripts/check-dist.sh dist

TARGETS=(AppImage deb rpm)
OUT="$(cd desktop && node tools/flavour.js output-dir)"
if [ "$OUT" != release ]; then
  TARGETS=(AppImage)
elif ! command -v rpmbuild >/dev/null 2>&1; then
  echo "package-linux: rpmbuild not found; skipping the .rpm (install the rpm package to build it)." >&2
  TARGETS=(AppImage deb)
fi

bash packaging/gen-source-txt.sh
cd desktop
npx --no-install electron-builder --linux "${TARGETS[@]}" --x64 --config electron-builder.config.js
bash ../packaging/harden-appimage.sh "$OUT"/*.AppImage
ls -l "$OUT"/*.AppImage "$OUT"/*.deb "$OUT"/*.rpm 2>/dev/null || true
