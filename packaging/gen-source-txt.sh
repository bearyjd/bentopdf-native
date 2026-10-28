#!/usr/bin/env bash
# Generates packaging/generated/SOURCE.txt: the AGPL corresponding-source
# pointer shipped inside every Linux artifact, including Electron provenance.
# Usage: packaging/gen-source-txt.sh [output-file]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/packaging/generated/SOURCE.txt}"
ELECTRON_DIST="$ROOT/desktop/node_modules/electron/dist"

die() { echo "gen-source-txt: $*" >&2; exit 1; }
[ -x "$ELECTRON_DIST/electron" ] || die "electron not installed (run npm ci in desktop/)"

ELECTRON_VERSION="$(tr -d '[:space:]' < "$ELECTRON_DIST/version")"
ELECTRON_BIN_SHA="$(sha256sum "$ELECTRON_DIST/electron" | cut -d' ' -f1)"
ELECTRON_ZIP="$(find "${ELECTRON_CACHE:-$HOME/.cache/electron}" -name "electron-v${ELECTRON_VERSION}-linux-x64.zip" -print -quit 2>/dev/null || true)"
if [ -n "$ELECTRON_ZIP" ]; then
  ELECTRON_ZIP_SHA="$(sha256sum "$ELECTRON_ZIP" | cut -d' ' -f1)"
else
  ELECTRON_ZIP_SHA="not found in the electron download cache (binary hash above still applies)"
fi

OUR_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then DIRTY=yes; else DIRTY=no; fi
UP_TAG="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_VERSION")"
UP_COMMIT="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")"
BUILD_DATE="$(date -u -d "@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$(dirname "$OUT")"
{
  echo "Corresponding source / AGPL-3.0 notice (BentoPDF Native, Linux package)"
  echo "======================================================================="
  echo "Licensed under the GNU Affero General Public License v3.0 only (LICENSE)."
  echo "Third-party components and licences: NOTICE; Electron: LICENSE.electron.txt;"
  echo "Chromium and its bundled components: LICENSES.chromium.html."
  echo "Unofficial packaging; not affiliated with or endorsed by the BentoPDF project."
  echo
  echo "Build recipe (this project): https://github.com/bearyjd/bentopdf-native"
  echo "  commit:        $OUR_COMMIT"
  echo "  working tree:  dirty=$DIRTY"
  if [ "$DIRTY" = yes ]; then
    echo "  WARNING: built from uncommitted changes; the commit above does not reproduce this package."
  fi
  echo "Upstream BentoPDF source:    https://github.com/alam00000/bentopdf"
  echo "  tag:           $UP_TAG"
  echo "  commit:        $UP_COMMIT"
  echo
  echo "Electron runtime (https://github.com/electron/electron, source for the matching tag):"
  echo "  version:       $ELECTRON_VERSION"
  echo "  sha256 of the electron binary as installed: $ELECTRON_BIN_SHA"
  echo "  sha256 of electron-v${ELECTRON_VERSION}-linux-x64.zip: $ELECTRON_ZIP_SHA"
  echo "  (the binary inside this package has Electron fuses flipped, so its hash differs from the above)"
  echo
  echo "Build date (UTC): $BUILD_DATE"
  echo "Rebuild: scripts/package-linux.sh in the recipe repository at the commit above."
  echo "Bundle provenance (WASM payloads and versions): resources/dist/SOURCE.txt."
} > "$OUT"
echo "wrote $OUT"
