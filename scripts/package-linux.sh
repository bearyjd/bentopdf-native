#!/usr/bin/env bash
# Builds the Linux x64 packages (AppImage, deb, rpm) into desktop/release/.
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
if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "package-linux: rpmbuild not found; skipping the .rpm (install the rpm package to build it)." >&2
  TARGETS=(AppImage deb)
fi

bash packaging/gen-source-txt.sh
cd desktop
npx --no-install electron-builder --linux "${TARGETS[@]}" --x64 --config electron-builder.config.js
bash ../packaging/harden-appimage.sh release/*.AppImage
ls -l release/*.AppImage release/*.deb release/*.rpm 2>/dev/null || true
