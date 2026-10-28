#!/usr/bin/env bash
# Inspects a built Linux artifact (.AppImage, .deb or .rpm) without installing
# or starting it, and fails on the first violated release rule:
#   - licence files and SOURCE.txt provenance are inside
#   - the offline bundle is outside app.asar and the app code is inside it
#   - Electron fuses are set (desktop/tools/check-fuses.js)
#   - environment overrides are guarded by app.isPackaged; no devtools or sandbox-off flags anywhere
#   - the desktop entry carries the PDF MIME type and a file field code
# Usage: packaging/verify-artifact.sh <artifact>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ART="$(readlink -f "${1:?usage: verify-artifact.sh <artifact>}")"
[ -f "$ART" ] || { echo "no such file: $ART" >&2; exit 2; }

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok:   $*"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/x"
mkdir -p "$OUT"

case "$ART" in
  *.AppImage)
    chmod +x "$ART"
    (cd "$OUT" && "$ART" --appimage-extract >/dev/null)
    OUT="$OUT/squashfs-root" ;;
  *.deb)
    if command -v dpkg-deb >/dev/null 2>&1; then
      dpkg-deb -x "$ART" "$OUT"
    else
      data="$(ar t "$ART" | grep '^data\.tar' | head -n1)"
      [ -n "$data" ] || fail "no data.tar.* member in $ART"
      (cd "$OUT" && ar p "$ART" "$data" | tar -x --no-same-owner --no-same-permissions -f -)
    fi ;;
  *.rpm)
    (cd "$OUT" && rpm2cpio "$ART" | cpio -idm --quiet --no-absolute-filenames) ;;
  *) fail "unsupported artifact type: $ART" ;;
esac

ASAR_PATH="$(find "$OUT" -path '*/resources/app.asar' -print -quit)"
[ -n "$ASAR_PATH" ] || fail "no resources/app.asar found"
RES="$(dirname "$ASAR_PATH")"
APP="$(dirname "$RES")"
EXE="$APP/bentopdf-native"
[ -f "$EXE" ] || fail "missing executable bentopdf-native"
pass "layout: app root $(basename "$APP"), executable present"

for f in "$APP/LICENSE.electron.txt" "$APP/LICENSES.chromium.html" "$RES/LICENSE" "$RES/NOTICE" "$RES/SOURCE.txt"; do
  [ -s "$f" ] || fail "missing or empty: ${f#"$OUT"/}"
done
pass "Electron LICENSE, LICENSES.chromium.html, our LICENSE, NOTICE and SOURCE.txt are inside"

UP_COMMIT="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")"
grep -q "$UP_COMMIT" "$RES/SOURCE.txt" || fail "SOURCE.txt does not name the upstream commit $UP_COMMIT"
grep -Eq 'version: +[0-9]+\.[0-9]+\.[0-9]+' "$RES/SOURCE.txt" || fail "SOURCE.txt has no Electron version"
[ "$(grep -Ec 'sha256 of .*: [0-9a-f]{64}$' "$RES/SOURCE.txt")" -ge 2 ] || fail "SOURCE.txt lacks the Electron sha256 lines"
grep -Eq 'commit: +[0-9a-f]{40}' "$RES/SOURCE.txt" || fail "SOURCE.txt has no git SHA"
grep -q "dirty=no" "$RES/SOURCE.txt" || echo "warn: SOURCE.txt says the tree was dirty (fine for a local build, never for a release)" >&2
pass "SOURCE.txt names repo SHA, upstream commit $UP_COMMIT, Electron version and sha256"

[ -f "$RES/dist/index.html" ] || fail "offline bundle missing at resources/dist"
[ -s "$RES/dist/SOURCE.txt" ] || fail "bundle SOURCE.txt missing"
[ "$(stat -c %s "$ASAR_PATH")" -lt 5000000 ] || fail "app.asar is suspiciously large: the bundle must stay outside it"
pass "offline bundle is an extraResource outside app.asar ($(du -sh "$RES/dist" | cut -f1)); app.asar is $(stat -c %s "$ASAR_PATH") bytes"

ASAR="$ROOT/desktop/node_modules/.bin/asar"
[ -x "$ASAR" ] || fail "asar tool missing (run npm ci in desktop/)"
"$ASAR" extract "$ASAR_PATH" "$WORK/asar"
grep -q 'app.isPackaged ? {} : process.env' "$WORK/asar/src/main.js" || fail "main.js does not gate BENTO_* overrides on app.isPackaged"
if grep -rn 'process\.env' "$WORK/asar/src" | grep -v 'src/main.js:.*overrides = app.isPackaged'; then
  fail "process.env is read somewhere other than the guarded overrides line"
fi
pass "BENTO_* overrides are read only through the app.isPackaged guard"

if grep -rEn -- '--no-sandbox|--disable-web-security|--remote-debugging|--inspect|--enable-logging|--disable-gpu-sandbox|--disable-setuid-sandbox' "$WORK/asar" ; then
  fail "forbidden flag inside app.asar"
fi
while IFS= read -r f; do
  if grep -En -- '--no-sandbox|--disable-web-security|--remote-debugging|--inspect|--auto-open-devtools|--disable-setuid-sandbox' "$f"; then
    fail "forbidden flag in ${f#"$OUT"/}"
  fi
done < <(find "$OUT" -type f \( -name '*.desktop' -o -name AppRun -o -name 'postinst' -o -name '*.sh' \) 2>/dev/null)
pass "no --no-sandbox / devtools / inspect flags in desktop entries, launchers or app code"

DESKTOP="$(find "$OUT" -name '*.desktop' -print -quit)"
if [ -n "$DESKTOP" ]; then
  grep -q '^MimeType=.*application/pdf' "$DESKTOP" || fail ".desktop lacks MimeType=application/pdf"
  grep -Eq '^Exec=.* %[fFuU]' "$DESKTOP" || fail ".desktop Exec lacks a file field code"
  grep -q '^Categories=Office;Utility;' "$DESKTOP" || fail ".desktop Categories is not Office;Utility;"
  grep -q '^StartupWMClass=' "$DESKTOP" || fail ".desktop lacks StartupWMClass"
  pass "desktop entry: PDF MIME type, file field code, Office;Utility, StartupWMClass"
else
  fail "no .desktop file in the artifact"
fi

if [[ "$ART" == *.AppImage ]]; then
  grep -q '^refuse()' "$OUT/AppRun" || fail "AppImage does not use the hardened AppRun"
  if grep -q 'NO_SANDBOX' "$OUT/AppRun"; then fail "AppRun still contains the --no-sandbox fallback"; fi
  pass "AppImage uses the hardened AppRun (no silent --no-sandbox fallback)"
fi

node "$ROOT/desktop/tools/check-fuses.js" "$EXE" >"$WORK/fuses.txt" || { cat "$WORK/fuses.txt"; fail "fuse state mismatch"; }
pass "Electron fuses: $(grep -c '^ok' "$WORK/fuses.txt") of $(wc -l < "$WORK/fuses.txt") as required"
echo "VERIFIED: $ART"
