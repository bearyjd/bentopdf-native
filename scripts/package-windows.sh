#!/usr/bin/env bash
# Builds the Windows x64 packages (NSIS installer + portable exe) into desktop/release/.
# Runs under Git Bash on a Windows host (CI: windows-latest). Needs desktop/node_modules
# installed ON WINDOWS (npm ci) and a finished offline bundle in dist/ (built by
# scripts/build-local.sh on Linux; CI passes it in as an artifact). It does not build the bundle.
# BENTO_FLAVOUR=smoke builds the SMOKE flavour (test mode inside, never distributed, refuses to run with signing
# material in the environment) into desktop/release-smoke/ (desktop/tools/flavour.js, issue #13).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f dist/index.html ]; then
  echo "package-windows: dist/ is missing. Build the bundle with scripts/build-local.sh (Linux/macOS) and copy dist/ here." >&2
  exit 1
fi
bash scripts/check-dist.sh dist

bash packaging/gen-source-txt.sh
cd desktop
npx --no-install electron-builder --win nsis portable --x64 --config electron-builder.win.config.js
OUT="$(node tools/flavour.js output-dir)"
ls -l "$OUT"/*.exe
