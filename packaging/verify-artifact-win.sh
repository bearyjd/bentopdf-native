#!/usr/bin/env bash
# Release gate for the Windows x64 artifacts. Inspects a built installer / portable exe by
# extraction (7-Zip), or an already extracted / installed tree, WITHOUT running anything, and
# fails on the first violated rule. Missing or empty inputs are failures, never skipped checks.
# Runs under Git Bash on windows-latest and on Linux (7z or --tree).
#
#   packaging/verify-artifact-win.sh [options] <setup.exe | portable.exe>
#   packaging/verify-artifact-win.sh [options] --tree <dir> --kind <installer|portable|installed|unpacked>
#
# Options:
#   --release            also require: release tag in SOURCE.txt, Electron zip sha256, zero unresolved NOTICE lines
#   --allow-dirty        accept SOURCE.txt saying dirty=yes (local experiments only)
#   --expect-commit SHA  commit SOURCE.txt must name (default: git HEAD of this checkout)
#   --config FILE        electron-builder effective config (scanned for sandbox-off flags)
#
# Checks: licences and SOURCE.txt provenance; offline bundle outside app.asar; Electron fuses;
# BENTO_* overrides gated on app.isPackaged; Windows path/argv hardening present; no sandbox-off or
# devtools flags in code, shortcuts, scripts or configs; no signing material, debug symbols or
# symlinks in the payload. Names come from desktop/brand.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok:   $*"; }
# Paths handed to native Windows programs (node, 7z) must be Windows paths under Git Bash.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

RELEASE=0 ALLOW_DIRTY=0 EXPECT_COMMIT="" TREE="" KIND="" CONFIG_ARG="" ART_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --expect-commit) EXPECT_COMMIT="${2:?--expect-commit needs a SHA}"; shift ;;
    --tree) TREE="${2:?--tree needs a directory}"; shift ;;
    --kind) KIND="${2:?--kind needs a value}"; shift ;;
    --config) CONFIG_ARG="${2:?--config needs a file}"; shift ;;
    -*) fail "unknown option $1" ;;
    *) ART_ARG="$1" ;;
  esac
  shift
done

BRAND_JSON="$(native "$ROOT/desktop/brand.json")"
brand() { node -p "require(process.argv[1]).$1" "$BRAND_JSON"; }
PRODUCT="$(brand productName)"
APP_ID="$(brand appId)"
SOURCE_URL="$(brand sourceUrl)"
[ -n "$PRODUCT" ] && [ -n "$APP_ID" ] && [ -n "$SOURCE_URL" ] || fail "desktop/brand.json is incomplete"
EXE_FILE="$PRODUCT.exe"

WORK="$(mktemp -d)"
cleanup() { chmod -R u+w "$WORK" 2>/dev/null || true; rm -r "$WORK" 2>/dev/null || true; }
trap cleanup EXIT
OUT="$WORK/app"
OUTER="$WORK/outer"
mkdir -p "$OUT" "$OUTER"
ART="(tree)"

find_7z() {
  local c
  for c in 7z 7zz 7za "/c/Program Files/7-Zip/7z.exe"; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

if [ -n "$TREE" ]; then
  [ -d "$TREE" ] || fail "no such directory: $TREE"
  [ -n "$KIND" ] || fail "--tree needs --kind"
  OUT="$(readlink -f "$TREE")"
else
  [ -n "$ART_ARG" ] || fail "usage: verify-artifact-win.sh [options] <setup.exe|portable.exe>"
  ART="$(readlink -f "$ART_ARG")"
  [ -f "$ART" ] || fail "no such file: $ART"
  case "$ART" in
    *-setup-*.exe) KIND=installer ;;
    *-portable-*.exe) KIND=portable ;;
    *) fail "cannot tell the artifact kind from its name (want *-setup-*.exe or *-portable-*.exe): $ART" ;;
  esac
  SEVENZ="$(find_7z)" || fail "7-Zip not found (7z, 7zz, 7za)"
  # NSIS installers and the portable stub both carry the app as $PLUGINSDIR/app-64.7z (a second archive).
  "$SEVENZ" x -y "-o$(native "$OUTER")" "$(native "$ART")" >"$WORK/7z-outer.log" 2>&1 || { tail -5 "$WORK/7z-outer.log" >&2; fail "7z could not extract $ART"; }
  INNER="$(find "$OUTER" -name 'app-64.7z' -print -quit)"
  [ -n "$INNER" ] && [ -s "$INNER" ] || fail "no app-64.7z inside $ART (not an electron-builder NSIS payload?)"
  "$SEVENZ" x -y "-o$(native "$OUT")" "$(native "$INNER")" >"$WORK/7z-inner.log" 2>&1 || { tail -5 "$WORK/7z-inner.log" >&2; fail "7z could not extract app-64.7z"; }
fi
case "$KIND" in installer|portable|installed|unpacked) ;; *) fail "unknown kind: $KIND" ;; esac

# ---- layout ----------------------------------------------------------------
ASAR_PATH="$(find "$OUT" -path '*/resources/app.asar' -print -quit)"
[ -n "$ASAR_PATH" ] || fail "no resources/app.asar found"
RES="$(dirname "$ASAR_PATH")"
APP="$(dirname "$RES")"
EXE="$APP/$EXE_FILE"
[ -s "$EXE" ] || fail "missing or empty executable $EXE_FILE"
pass "$KIND layout: app root $(basename "$APP"), executable $EXE_FILE present"

for f in "$APP/LICENSE.electron.txt" "$APP/LICENSES.chromium.html" "$RES/LICENSE" "$RES/NOTICE" "$RES/SOURCE.txt"; do
  [ -s "$f" ] || fail "missing or empty: ${f#"$OUT"/}"
done
pass "Electron LICENSE, LICENSES.chromium.html, our LICENSE, NOTICE and SOURCE.txt are inside"

# ---- provenance -------------------------------------------------------------
SRC="$RES/SOURCE.txt"
if [ -z "$EXPECT_COMMIT" ]; then
  EXPECT_COMMIT="$(git -C "$(native "$ROOT")" rev-parse HEAD 2>/dev/null)" || fail "cannot determine git HEAD; pass --expect-commit"
fi
UP_COMMIT="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")"
[ -n "$UP_COMMIT" ] || fail "UPSTREAM_COMMIT is empty"
grep -q "$UP_COMMIT" "$SRC" || fail "SOURCE.txt does not name the upstream commit $UP_COMMIT"
grep -q 'Windows package' "$SRC" || fail "SOURCE.txt is not the Windows variant (no 'Windows package' header)"
grep -Eq 'version: +[0-9]+\.[0-9]+\.[0-9]+' "$SRC" || fail "SOURCE.txt has no Electron version"
grep -Eq 'sha256 of the electron binary as installed: [0-9a-f]{64}$' "$SRC" || fail "SOURCE.txt lacks the Electron binary sha256"
grep -Eq "sha256 of electron-v[0-9.]+-win32-x64\.zip: ([0-9a-f]{64}|not found in the electron download cache.*)$" "$SRC" || fail "SOURCE.txt lacks the Electron win32-x64 zip sha256 line"
grep -Eq "^  commit: +$EXPECT_COMMIT\$" "$SRC" || fail "SOURCE.txt does not name the built commit $EXPECT_COMMIT (stale or foreign build)"
grep -Fq "$SOURCE_URL" "$SRC" || fail "SOURCE.txt does not name the repository $SOURCE_URL"
grep -Eq '^  release tag: +\S+' "$SRC" || fail "SOURCE.txt has no 'release tag:' line"
grep -q '^  describe: ' "$SRC" || fail "SOURCE.txt has no 'describe:' line"
if grep -q "dirty=no" "$SRC"; then :; elif [ "$ALLOW_DIRTY" = 1 ]; then echo "warn: SOURCE.txt says the tree was dirty (allowed by --allow-dirty)" >&2; else fail "SOURCE.txt says the build tree was dirty"; fi
pass "SOURCE.txt names commit $EXPECT_COMMIT, repository, upstream $UP_COMMIT, Electron version and sha256"

NEEDS_REVIEW="$(grep -Eic 'needs[ _-]*review|todo|tbd|unverified' "$RES/NOTICE" || true)"
if [ "$RELEASE" = 1 ]; then
  [ "$NEEDS_REVIEW" = 0 ] || fail "release build but NOTICE has $NEEDS_REVIEW unresolved line(s)"
  grep -Eq '^  release tag: +none' "$SRC" && fail "release build but SOURCE.txt says it was not built from a release tag"
  grep -Eq 'sha256 of electron-v[0-9.]+-win32-x64\.zip: [0-9a-f]{64}$' "$SRC" || fail "release build but SOURCE.txt has no Electron zip sha256"
  pass "release: NOTICE has no unresolved lines, SOURCE.txt names a release tag and the Electron zip hash"
else
  echo "note: NOT FOR RELEASE: NOTICE has $NEEDS_REVIEW unresolved line(s)" >&2
fi

# ---- bundle and asar ----------------------------------------------------------
[ -f "$RES/dist/index.html" ] || fail "offline bundle missing at resources/dist"
[ -s "$RES/dist/SOURCE.txt" ] || fail "bundle SOURCE.txt missing"
ASAR_SIZE="$(wc -c < "$ASAR_PATH" | tr -d ' ')"
[ "$ASAR_SIZE" -lt 5000000 ] || fail "app.asar is suspiciously large: the bundle must stay outside it"
pass "offline bundle is an extraResource outside app.asar; app.asar is $ASAR_SIZE bytes"

ASAR_JS="$ROOT/desktop/node_modules/@electron/asar/bin/asar.js"
[ -f "$ASAR_JS" ] || fail "asar tool missing (run npm ci in desktop/)"
node "$(native "$ASAR_JS")" extract "$(native "$ASAR_PATH")" "$(native "$WORK/asar")" || fail "asar extract failed"
for f in src/main.js src/menu.js src/argv-policy.js src/open-file.js src/static-files.js src/app.js brand.json; do
  [ -s "$WORK/asar/$f" ] || fail "app.asar lacks $f"
done
M="$WORK/asar/src/main.js"
grep -q 'app.isPackaged ? {} : process.env' "$M" || fail "main.js does not gate BENTO_* overrides on app.isPackaged"
if grep -rn 'process\.env' "$WORK/asar/src" | grep -Ev 'src/main.js:.*(overrides = app.isPackaged|process\.env\[name\])|src/argv-policy.js:.*env = process\.env'; then
  fail "process.env is read somewhere other than the guarded overrides line, the sandbox-env refusal and the argv policy defaults"
fi
pass "BENTO_* overrides are read only through the app.isPackaged guard"

grep -q "'ELECTRON_DISABLE_SANDBOX'" "$M" && grep -q "'CHROME_DEVEL_SANDBOX'" "$M" || fail "main.js does not refuse to start when ELECTRON_DISABLE_SANDBOX / CHROME_DEVEL_SANDBOX is set"
grep -q 'app.exit(2)' "$M" || fail "main.js has no exit-2 refusal"
grep -q 'unsafeSwitches(process.argv)' "$M" || fail "main.js does not check its own argv"
grep -q "unsafeSwitches(argv, undefined, { secondInstance: true })" "$M" || fail "main.js does not check second-instance argv"
grep -q 'show: !testHeadless()' "$M" || fail "main.js does not hide the window in test mode (show: !testHeadless())"
grep -q '%PDF-' "$WORK/asar/src/open-file.js" || fail "open-file.js does not check the %PDF- header"
grep -q 'realpath' "$WORK/asar/src/open-file.js" || fail "open-file.js does not resolve symlinks"
grep -q 'windowsPathProblem' "$WORK/asar/src/open-file.js" || fail "open-file.js lacks the Windows path rules (UNC, streams, device names)"
grep -q "platform === 'win32' && arg.startsWith('/')" "$WORK/asar/src/argv-policy.js" || fail "argv-policy.js does not treat /switch as a switch on win32"
grep -q 'isWindowsUnsafeSegment' "$WORK/asar/src/static-files.js" || fail "static-files.js lacks the Windows path-segment rules"
grep -q 'realpathSync.native' "$WORK/asar/src/app.js" || fail "app.js does not canonicalise the bundle root with realpathSync.native"
pass "argv policy (own and second-instance, incl. /switch), Windows path rules and open-with header/symlink checks are present"

grep -q 'ABSOLUTELY NO WARRANTY' "$WORK/asar/src/menu.js" || fail "About text lacks the no-warranty line"
grep -q 'AGPL-3.0-only' "$WORK/asar/src/menu.js" || fail "About text lacks the AGPL notice"
grep -q 'brand.sourceUrl' "$WORK/asar/src/menu.js" || fail "About text does not offer the source URL"
grep -Fq "$SOURCE_URL" "$WORK/asar/brand.json" || fail "packaged brand.json lacks the source URL"
grep -Fq "$APP_ID" "$WORK/asar/brand.json" || fail "packaged brand.json lacks the app id"
pass "About dialog carries the AGPL notice, no-warranty line and the corresponding-source URL"

# ---- forbidden flags -------------------------------------------------------------
FORBIDDEN='--no-sandbox|--disable-web-security|--remote-debugging|--inspect|--enable-logging|--disable-gpu-sandbox|--disable-setuid-sandbox|--auto-open-devtools'
# UTF-16 files (.lnk, .ps1, .reg) are made greppable by dropping NULs.
scan_file() { tr -d '\0' < "$1" | grep -En -- "$FORBIDDEN" >&2; }
if grep -rEn -- "$FORBIDDEN" "$WORK/asar"; then fail "forbidden flag inside app.asar"; fi
SCANNED=0
while IFS= read -r f; do
  SCANNED=$((SCANNED + 1))
  if scan_file "$f"; then fail "forbidden flag in ${f#"$WORK"/}"; fi
done < <(find "$OUT" "$OUTER" -type f \( -iname '*.lnk' -o -iname '*.bat' -o -iname '*.cmd' -o -iname '*.ps1' -o -iname '*.vbs' -o -iname '*.reg' -o -iname '*.nsi' -o -iname '*.nsh' -o -iname '*.yml' -o -iname '*.yaml' \) -not -path '*/resources/dist/*' 2>/dev/null)
if [ -n "$CONFIG_ARG" ]; then
  [ -s "$CONFIG_ARG" ] || fail "missing or empty config file: $CONFIG_ARG"
  SCANNED=$((SCANNED + 1))
  if scan_file "$CONFIG_ARG"; then fail "forbidden flag in $CONFIG_ARG"; fi
fi
if scan_file "$ROOT/packaging/windows/installer.nsh"; then fail "forbidden flag in packaging/windows/installer.nsh"; fi
if scan_file "$ROOT/desktop/electron-builder.win.config.js"; then fail "forbidden flag in electron-builder.win.config.js"; fi
pass "no sandbox-off / devtools / inspect flags in app code, installer scripts, configs or $SCANNED shortcut/script/config files"

# ---- file association policy (repo-level: the NSIS script is compiled into the installer) --------------
NSH="$ROOT/packaging/windows/installer.nsh"
[ -s "$NSH" ] || fail "packaging/windows/installer.nsh missing"
if grep -Eq 'Software\\Classes\\\.pdf"[[:space:]]+""' "$NSH"; then fail "installer.nsh writes the default value of .pdf (would hijack the user's PDF handler)"; fi
grep -q 'OpenWithProgids' "$NSH" || fail "installer.nsh does not register under OpenWithProgids"
grep -q 'DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.pdf\\OpenWithProgids"' "$NSH" || fail "uninstaller does not remove the OpenWithProgids value"
grep -q 'DeleteRegKey SHELL_CONTEXT "Software\\Classes\\${APP_ID}.pdf"' "$NSH" || fail "uninstaller does not remove the ProgID key"
pass "installer.nsh registers .pdf only under OpenWithProgids and the uninstaller removes both keys"

# ---- payload hygiene -------------------------------------------------------------------
BAD="$(find "$OUT" \( -iname '*.pdb' -o -iname '*.pfx' -o -iname '*.p12' -o -iname '*.pem' -o -iname '*.key' -o -iname '*.snk' -o -iname '*.jks' -o -iname '*.keystore' -o -iname '*.p8' -o -iname '.env' -o -iname '.env.*' -o -iname '.npmrc' -o -iname 'id_rsa*' \) -print | head -5)"
[ -z "$BAD" ] || { echo "$BAD" >&2; fail "forbidden file (debug symbols or signing/secret material) in the payload"; }
LINKS="$(find "$OUT" -type l -print | head -5)"
[ -z "$LINKS" ] || { echo "$LINKS" >&2; fail "symbolic link in the payload"; }
pass "no .pdb / signing keys / certificates / secrets / symlinks in the payload"

# ---- fuses ------------------------------------------------------------------------------
node "$(native "$ROOT/desktop/tools/check-fuses.js")" "$(native "$EXE")" >"$WORK/fuses.txt" || { cat "$WORK/fuses.txt"; fail "fuse state mismatch"; }
[ "$(grep -c '^ok' "$WORK/fuses.txt")" -ge 7 ] || fail "fewer than 7 fuses were checked"
pass "Electron fuses: $(grep -c '^ok' "$WORK/fuses.txt") of $(wc -l < "$WORK/fuses.txt") as required"
echo "VERIFIED: $ART ($KIND)"
