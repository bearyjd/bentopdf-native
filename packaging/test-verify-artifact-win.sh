#!/usr/bin/env bash
# Mutation test of the Windows release gate (packaging/verify-artifact-win.sh).
# Builds a SMALL base tree from a real electron-builder Windows output (one fused
# executable, the real app.asar, licences, SOURCE.txt, a stub bundle), then for every
# mutation copies it, breaks one thing and asserts that the gate FAILS. A positive control
# (the unmodified tree must pass) runs first. Exit 0 only if every mutation was caught.
#
#   packaging/test-verify-artifact-win.sh [--seed <win-unpacked dir>] [--installer F --portable F]
# Default seed: desktop/release/win-unpacked. With --installer/--portable the artifact-level
# paths (7z extraction) are exercised too; without them those cases are reported as SKIPPED.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="${GATE:-$ROOT/packaging/verify-artifact-win.sh}"
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
SEED="$ROOT/desktop/release/win-unpacked" INSTALLER="" PORTABLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) SEED="$2"; shift ;;
    --installer) INSTALLER="$2"; shift ;;
    --portable) PORTABLE="$2"; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
PRODUCT="$(node -p "require(process.argv[1]).productName" "$(native "$ROOT/desktop/brand.json")")"
[ -d "$SEED/resources" ] && [ -s "$SEED/$PRODUCT.exe" ] || { echo "seed '$SEED' is not an unpacked Windows build (pass --seed)" >&2; exit 2; }
ASAR_JS="$(native "$ROOT/desktop/node_modules/@electron/asar/bin/asar.js")"

T="$(mktemp -d)"
cleanup() { chmod -R u+w "$T" 2>/dev/null || true; rm -r "$T" 2>/dev/null || true; }
trap cleanup EXIT

BASE="$T/base"
mkdir -p "$BASE/resources/dist"
cp "$SEED/$PRODUCT.exe" "$BASE/"
cp "$SEED/LICENSE.electron.txt" "$SEED/LICENSES.chromium.html" "$BASE/"
cp "$SEED/resources/app.asar" "$SEED/resources/LICENSE" "$SEED/resources/NOTICE" "$SEED/resources/SOURCE.txt" "$BASE/resources/"
# A seed built on Linux (cross-build) carries the Linux SOURCE.txt; only the platform words are
# adjusted here so the fixture has the shape a Windows CI build produces. Real SOURCE.txt content is
# produced by packaging/gen-source-txt.sh on the Windows runner.
sed -i 's/Linux package/Windows package/; s/linux-x64\.zip/win32-x64.zip/' "$BASE/resources/SOURCE.txt"
echo '<html></html>' > "$BASE/resources/dist/index.html"
echo 'bundle provenance' > "$BASE/resources/dist/SOURCE.txt"
EXPECT="$(sed -n 's/^  commit: *//p' "$BASE/resources/SOURCE.txt" | head -n1)"
[ -n "$EXPECT" ] || { echo "seed SOURCE.txt has no commit line" >&2; exit 2; }
GATE_ARGS=(--expect-commit "$EXPECT")
grep -q 'dirty=yes' "$BASE/resources/SOURCE.txt" && GATE_ARGS+=(--allow-dirty)

run_gate() { # tree [extra gate args] -> sets GATE_OUT, returns the gate's status
  local tree="$1"; shift
  set +e
  GATE_OUT="$("$GATE" "${GATE_ARGS[@]}" --tree "$tree" --kind unpacked "$@" 2>&1)"
  local rc=$?
  set -e
  return $rc
}

PASSED=0 MISSED=0 SKIPPED=0
declare -a MISSED_NAMES=()
TABLE=""
record_caught() { PASSED=$((PASSED + 1)); TABLE+="$(printf '%-48s caught: %s' "$1" "$(printf '%s\n' "$GATE_OUT" | grep -m1 '^FAIL' | cut -c1-100)")"$'\n'; }
record_missed() { MISSED=$((MISSED + 1)); MISSED_NAMES+=("$1"); TABLE+="$(printf '%-48s MISSED (gate passed)' "$1")"$'\n'; }

attempt() { # name mutation-function [gate args]
  local name="$1" fn="$2"; shift 2
  local w="$T/work"
  [ ! -e "$w" ] || { chmod -R u+w "$w"; rm -r "$w"; }
  cp -a "$BASE" "$w"
  "$fn" "$w"
  if run_gate "$w" "$@"; then record_missed "$name"; else record_caught "$name"; fi
}

edit_asar() { # tree sed-expression file-in-asar
  local tree="$1" expr="$2" file="$3" x="$T/asar-x"
  [ ! -e "$x" ] || { chmod -R u+w "$x"; rm -r "$x"; }
  node "$ASAR_JS" extract "$(native "$tree/resources/app.asar")" "$(native "$x")"
  sed -i "$expr" "$x/$file"
  grep -q 'MUTATED' "$x/$file" || { echo "mutation '$expr' did not change $file" >&2; exit 2; }
  node "$ASAR_JS" pack "$(native "$x")" "$(native "$tree/resources/app.asar")"
}

# ---- positive control -------------------------------------------------------------
if ! run_gate "$BASE"; then printf '%s\n' "$GATE_OUT" | tail -5 >&2; echo "positive control FAILED: the unmodified tree must pass" >&2; exit 1; fi
echo "positive control: unmodified tree passes ($(printf '%s\n' "$GATE_OUT" | grep -c '^ok:') checks)"

PX="$PRODUCT.exe"
m_no_electron_licence() { rm "$1/LICENSE.electron.txt"; }
m_empty_chromium_licences() { : > "$1/LICENSES.chromium.html"; }
m_no_licence() { rm "$1/resources/LICENSE"; }
m_notice_emptied() { : > "$1/resources/NOTICE"; }
m_notice_missing() { rm "$1/resources/NOTICE"; }
m_notice_unresolved() { echo 'Foo library - NEEDS REVIEW' >> "$1/resources/NOTICE"; }
m_source_missing() { rm "$1/resources/SOURCE.txt"; }
m_source_wrong_commit() { sed -i "s/^  commit: .*/  commit:        0000000000000000000000000000000000000000/" "$1/resources/SOURCE.txt"; }
m_source_no_sha() { sed -i '/sha256 of/d' "$1/resources/SOURCE.txt"; }
m_source_linux() { sed -i 's/Windows package/Linux package/' "$1/resources/SOURCE.txt"; }
# Everything else a --release build needs is made valid first, so only the tag rule can fail.
release_ready() {
  sed -i '/needs[ _-]*review\|todo\|tbd\|unverified/Id' "$1/resources/NOTICE"
  sed -i "s/\(win32-x64\.zip:\) .*/\1 $(printf 'a%.0s' {1..64})/" "$1/resources/SOURCE.txt"
}
m_source_tag_none() { release_ready "$1"; sed -i 's/^  release tag: .*/  release tag:   none/' "$1/resources/SOURCE.txt"; }
m_release_ready_control() { release_ready "$1"; sed -i 's/^  release tag: .*/  release tag:   v9.9.9/' "$1/resources/SOURCE.txt"; }
m_no_exe() { rm "$1/$PX"; }
m_flipped_fuse() { node -e "
const { flipFuses, FuseVersion, FuseV1Options } = require(require.resolve('@electron/fuses', { paths: [process.argv[1]] }));
flipFuses(process.argv[2], { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: true }).catch((e) => { console.error(e); process.exit(1); });
" "$(native "$ROOT/desktop")" "$(native "$1/$PX")"; }
m_no_asar() { rm "$1/resources/app.asar"; }
m_big_asar() { head -c 6000000 /dev/zero >> "$1/resources/app.asar"; }
m_no_bundle() { rm "$1/resources/dist/index.html"; }
m_no_bundle_source() { rm "$1/resources/dist/SOURCE.txt"; }
m_override_honoured() { edit_asar "$1" 's/app.isPackaged ? {} : process.env/process.env \/\/ MUTATED/' src/main.js; }
m_sandbox_env_not_refused() { edit_asar "$1" "s/'CHROME_DEVEL_SANDBOX'/'CHROME_DEVEL_SANDBOX_MUTATED'/" src/main.js; }
m_no_sandbox_in_code() { edit_asar "$1" 's/^.use strict.;/"use strict"; \/\/ MUTATED --no-sandbox/' src/menu.js; }
m_window_always_shown() { edit_asar "$1" 's/show: !testHeadless()/show: true \/\/ MUTATED/' src/main.js; }
m_no_slash_switch_rule() { edit_asar "$1" "s/platform === 'win32' \&\& arg.startsWith('\/')/false \/\/ MUTATED/" src/argv-policy.js; }
m_no_windows_path_rules() { edit_asar "$1" 's/windowsPathProblem/wpp_MUTATED/g' src/open-file.js; }
m_no_static_rules() { edit_asar "$1" 's/isWindowsUnsafeSegment/iwus_MUTATED/g' src/static-files.js; }
m_js_realpath() { edit_asar "$1" 's/realpathSync.native/realpathSync \/\/ MUTATED/' src/app.js; }
m_second_instance_unchecked() { edit_asar "$1" 's/unsafeSwitches(argv, undefined, { secondInstance: true })/[] \/\/ MUTATED/' src/main.js; }
m_no_sandbox_lnk() { printf -- '--no-sandbox' | iconv -f utf-8 -t utf-16le > "$1/shortcut.lnk"; }
m_no_sandbox_bat() { echo '"%~dp0app.exe" --no-sandbox' > "$1/launch.bat"; }
m_inspect_ps1() { echo 'Start-Process app.exe -ArgumentList "--remote-debugging-port=9222"' > "$1/start.ps1"; }
m_pdb() { echo x > "$1/app.pdb"; }
m_pfx() { echo x > "$1/resources/sign.pfx"; }
m_pem() { echo x > "$1/resources/dist/cert.pem"; }
m_env_file() { echo SECRET=1 > "$1/resources/.env"; }
m_symlink() { ln -s /etc/passwd "$1/resources/link"; }

attempt "missing LICENSE.electron.txt" m_no_electron_licence
attempt "empty LICENSES.chromium.html" m_empty_chromium_licences
attempt "missing LICENSE" m_no_licence
attempt "NOTICE emptied" m_notice_emptied
attempt "NOTICE missing" m_notice_missing
attempt "NOTICE unresolved under --release" m_notice_unresolved --release
attempt "SOURCE.txt missing" m_source_missing
attempt "SOURCE.txt names the wrong commit" m_source_wrong_commit
attempt "SOURCE.txt has no sha256 lines" m_source_no_sha
attempt "SOURCE.txt is the Linux variant" m_source_linux
attempt "SOURCE.txt release tag none under --release" m_source_tag_none --release
# Control for the line above: with a tag the very same tree must PASS --release, so the previous catch was the tag rule.
w="$T/work"; [ ! -e "$w" ] || { chmod -R u+w "$w"; rm -r "$w"; }; cp -a "$BASE" "$w"; m_release_ready_control "$w"
run_gate "$w" --release || { printf '%s\n' "$GATE_OUT" | tail -3 >&2; echo "release control FAILED" >&2; exit 1; }
attempt "executable missing" m_no_exe
attempt "fuse flipped (RunAsNode on)" m_flipped_fuse
attempt "app.asar missing" m_no_asar
attempt "app.asar swallowed the bundle (big)" m_big_asar
attempt "offline bundle index.html missing" m_no_bundle
attempt "bundle SOURCE.txt missing" m_no_bundle_source
attempt "BENTO_* override honoured when packaged" m_override_honoured
attempt "sandbox-off env no longer refused" m_sandbox_env_not_refused
attempt "--no-sandbox inside app.asar" m_no_sandbox_in_code
attempt "window always shown (no test mode)" m_window_always_shown
attempt "/switch no longer a switch on win32" m_no_slash_switch_rule
attempt "Windows open-with path rules removed" m_no_windows_path_rules
attempt "Windows static path rules removed" m_no_static_rules
attempt "bundle root not canonicalised natively" m_js_realpath
attempt "second-instance argv unchecked" m_second_instance_unchecked
attempt "--no-sandbox in a UTF-16 .lnk shortcut" m_no_sandbox_lnk
attempt "--no-sandbox in a .bat launcher" m_no_sandbox_bat
attempt "remote debugging in a .ps1" m_inspect_ps1
attempt ".pdb debug symbols in payload" m_pdb
attempt ".pfx signing key in payload" m_pfx
attempt ".pem inside the bundle" m_pem
attempt ".env file in payload" m_env_file
attempt "symlink in payload" m_symlink

# Gate arguments that are themselves broken inputs.
CFG="$T/effective-config.yaml"
printf 'win:\n  args: --no-sandbox\n' > "$CFG"
w="$T/work"; [ ! -e "$w" ] || { chmod -R u+w "$w"; rm -r "$w"; }; cp -a "$BASE" "$w"
if run_gate "$w" --config "$CFG"; then record_missed "--no-sandbox in the builder config"; else record_caught "--no-sandbox in the builder config"; fi
: > "$CFG"
if run_gate "$w" --config "$CFG"; then record_missed "empty builder config file"; else record_caught "empty builder config file"; fi
mkdir -p "$T/empty"
if run_gate "$T/empty"; then record_missed "empty tree (nothing to match)"; else record_caught "empty tree (nothing to match)"; fi
if "$GATE" "${GATE_ARGS[@]}" "$T/does-not-exist-setup-1.exe" >/dev/null 2>&1; then GATE_OUT=""; record_missed "nonexistent artifact"; else GATE_OUT="FAIL: nonexistent"; record_caught "nonexistent artifact"; fi
printf 'not an installer' > "$T/bogus-setup-x64.exe"
if command -v 7z >/dev/null 2>&1 || command -v 7zz >/dev/null 2>&1 || command -v 7za >/dev/null 2>&1; then
  set +e; GATE_OUT="$("$GATE" "${GATE_ARGS[@]}" "$T/bogus-setup-x64.exe" 2>&1)"; rc=$?; set -e
  if [ "$rc" = 0 ]; then record_missed "garbage file named *-setup-*.exe"; else record_caught "garbage file named *-setup-*.exe"; fi
else
  SKIPPED=$((SKIPPED + 1)); TABLE+="garbage file named *-setup-*.exe                SKIPPED (no 7z)"$'\n'
fi

if [ -n "$INSTALLER" ] && [ -n "$PORTABLE" ]; then
  for pair in "installer:$INSTALLER" "portable:$PORTABLE"; do
    set +e; GATE_OUT="$("$GATE" "${GATE_ARGS[@]}" "${pair#*:}" 2>&1)"; rc=$?; set -e
    if [ "$rc" = 0 ]; then PASSED=$((PASSED + 1)); TABLE+="$(printf '%-48s positive control on the real %s passes' "real ${pair%%:*} (7z extraction)" "${pair%%:*}")"$'\n'
    else printf '%s\n' "$GATE_OUT" | tail -5 >&2; MISSED=$((MISSED + 1)); MISSED_NAMES+=("positive control on the real ${pair%%:*}"); fi
  done
else
  SKIPPED=$((SKIPPED + 1)); TABLE+="real installer / portable extraction                SKIPPED (pass --installer and --portable)"$'\n'
fi

printf '%s' "$TABLE"
echo "mutation test: $PASSED caught, $MISSED missed, $SKIPPED skipped"
if [ "$MISSED" != 0 ]; then printf 'MISSED: %s\n' "${MISSED_NAMES[@]}" >&2; exit 1; fi
