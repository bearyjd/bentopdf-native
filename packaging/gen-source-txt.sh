#!/usr/bin/env bash
# Generates packaging/generated/SOURCE.txt: the AGPL corresponding-source
# pointer shipped inside every Linux and Windows artifact, including Electron provenance.
# Usage: packaging/gen-source-txt.sh [output-file]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/packaging/generated/SOURCE.txt}"
ELECTRON_DIST="$ROOT/desktop/node_modules/electron/dist"

die() { echo "gen-source-txt: $*" >&2; exit 1; }
# The platform is whatever the installed Electron is: electron.exe means the Windows build
# (npm ci ran on Windows), plain electron means Linux.
if [ -f "$ELECTRON_DIST/electron.exe" ]; then
  PLATFORM_LABEL="Windows package"; ZIP_PLATFORM="win32-x64"; ELECTRON_BIN="$ELECTRON_DIST/electron.exe"
elif [ -x "$ELECTRON_DIST/electron" ]; then
  PLATFORM_LABEL="Linux package"; ZIP_PLATFORM="linux-x64"; ELECTRON_BIN="$ELECTRON_DIST/electron"
else
  die "electron not installed (run npm ci in desktop/)"
fi

ELECTRON_VERSION="$(tr -d '[:space:]' < "$ELECTRON_DIST/version")"
# Hash from stdin: given a path with backslashes (Windows), sha256sum prefixes the digest with "\".
ELECTRON_BIN_SHA="$(sha256sum < "$ELECTRON_BIN" | cut -d' ' -f1)"
ELECTRON_ZIP=""
for cache in "${ELECTRON_CACHE:-}" "$HOME/.cache/electron" "${LOCALAPPDATA:-}/electron/Cache"; do
  [ -n "$cache" ] && [ -d "$cache" ] || continue
  ELECTRON_ZIP="$(find "$cache" -name "electron-v${ELECTRON_VERSION}-${ZIP_PLATFORM}.zip" -print -quit 2>/dev/null || true)"
  [ -z "$ELECTRON_ZIP" ] || break
done
if [ -n "$ELECTRON_ZIP" ]; then
  ELECTRON_ZIP_SHA="$(sha256sum < "$ELECTRON_ZIP" | cut -d' ' -f1)"
else
  ELECTRON_ZIP_SHA="not found in the electron download cache (binary hash above still applies)"
fi

BRAND="$ROOT/desktop/brand.json"
# The path is a separate argv entry (not spliced into the JS) so Git Bash converts it for node.
SOURCE_URL="$(node -p "require(process.argv[1]).sourceUrl" "$BRAND")"
UPSTREAM_URL="$(node -p "require(process.argv[1]).upstreamUrl" "$BRAND")"
OUR_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
DESCRIBE="$(git -C "$ROOT" describe --tags --always --long 2>/dev/null || echo unknown)"
BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
RELEASE_TAG="$(git -C "$ROOT" describe --tags --exact-match HEAD 2>/dev/null || echo none)"
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then DIRTY=yes; else DIRTY=no; fi
UP_TAG="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_VERSION")"
UP_COMMIT="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")"
BUILD_DATE="$(date -u -d "@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$(dirname "$OUT")"
{
  echo "Corresponding source / AGPL-3.0 notice (BentoPDF Native, $PLATFORM_LABEL)"
  echo "======================================================================="
  echo "Licensed under the GNU Affero General Public License v3.0 only (LICENSE)."
  echo "Third-party components and licences: NOTICE; Electron: LICENSE.electron.txt;"
  echo "Chromium and its bundled components: LICENSES.chromium.html."
  echo "Unofficial packaging; not affiliated with or endorsed by the BentoPDF project."
  echo
  echo "Build recipe (this project): $SOURCE_URL"
  echo "  commit:        $OUR_COMMIT"
  echo "  describe:      $DESCRIBE"
  echo "  release tag:   $RELEASE_TAG"
  echo "  working tree:  dirty=$DIRTY"
  echo "  built from branch: ${BRANCH:-"(detached)"}${SOURCE_PR:+, pull request $SOURCE_URL/pull/$SOURCE_PR}"
  echo "  Corresponding source of a RELEASE is the commit of its tag on main (git checkout <tag>)."
  echo "  Release builds are made only from a tagged commit on main, never from a PR branch. This"
  echo "  repository squash-merges pull requests, so a commit that exists only on a PR branch is not a"
  echo "  durable source reference: if \"release tag\" above is none, this is NOT a release build and the"
  echo "  commit may disappear after merge; use the tag that contains the same changes."
  if [ "$DIRTY" = yes ]; then
    echo "  WARNING: built from uncommitted changes; the commit above does not reproduce this package."
  fi
  echo "Upstream BentoPDF source:    $UPSTREAM_URL"
  echo "  tag:           $UP_TAG"
  echo "  commit:        $UP_COMMIT"
  echo
  echo "Electron runtime (https://github.com/electron/electron, source for the matching tag):"
  echo "  version:       $ELECTRON_VERSION"
  echo "  sha256 of the electron binary as installed: $ELECTRON_BIN_SHA"
  echo "  sha256 of electron-v${ELECTRON_VERSION}-${ZIP_PLATFORM}.zip: $ELECTRON_ZIP_SHA"
  echo "  (the binary inside this package has Electron fuses flipped, so its hash differs from the above)"
  echo
  echo "Build date (UTC): $BUILD_DATE"
  echo "Rebuild: scripts/package-linux.sh (Linux) or scripts/package-windows.sh (Windows) in the recipe repository at the commit above."
  echo "Bundle provenance (WASM payloads and versions): resources/dist/SOURCE.txt."
} > "$OUT"
echo "wrote $OUT"
