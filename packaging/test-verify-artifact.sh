#!/usr/bin/env bash
# Mutation test of the release gate. Extracts built artifacts once, then for every
# mutation makes a COPY of the extracted tree, breaks one thing, and asserts that
# packaging/verify-artifact.sh FAILS. A positive control (the unmodified tree must pass)
# runs first. Exit 0 only if every mutation was caught.
#
#   packaging/test-verify-artifact.sh [--deb F] [--rpm F] [--appimage F] [--flatpak DIR | --no-flatpak]
#   packaging/test-verify-artifact.sh --appimage-only [--appimage F]   (partial run: no deb/rpm/flatpak cases; NOT a release check)
# Every mutation names the substring its FAIL line must contain: a case that fails for another reason counts as missed.
# Defaults: the newest files in desktop/release/ and packaging/flatpak/.build/app.
# GATE=<script> runs a different gate (used to show what an older gate missed); it must
# accept the same --tree/--kind/--scripts arguments.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="${GATE:-$ROOT/packaging/verify-artifact.sh}"
REL="$ROOT/desktop/release"
DEB="" RPM="" IMG="" FLAT="" WITH_FLATPAK=1 APPIMAGE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --deb) DEB="$2"; shift ;;
    --rpm) RPM="$2"; shift ;;
    --appimage) IMG="$2"; shift ;;
    --flatpak) FLAT="$2"; shift ;;
    --no-flatpak) WITH_FLATPAK=0 ;;
    --appimage-only) APPIMAGE_ONLY=1; WITH_FLATPAK=0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
newest() { find "$REL" -maxdepth 1 -name "$1" -print 2>/dev/null | sort | tail -n1; }
[ -n "$DEB" ] || DEB="$(newest '*.deb')"
[ -n "$RPM" ] || RPM="$(newest '*.rpm')"
[ -n "$IMG" ] || IMG="$(newest '*.AppImage')"
[ -n "$FLAT" ] || FLAT="$ROOT/packaging/flatpak/.build/app"
if [ "$APPIMAGE_ONLY" = 1 ]; then ARTIFACTS=("$IMG"); else ARTIFACTS=("$DEB" "$RPM" "$IMG"); fi
for f in "${ARTIFACTS[@]}"; do [ -f "$f" ] || { echo "missing artifact: '$f'" >&2; exit 2; }; done
if [ "$WITH_FLATPAK" = 1 ]; then
  [ -d "$FLAT/files" ] || { echo "missing flatpak build dir: $FLAT (pass --no-flatpak to test without it)" >&2; exit 2; }
fi
KINDS="deb rpm appimage"
[ "$APPIMAGE_ONLY" = 0 ] || { KINDS="appimage"; echo "note: --appimage-only: deb, rpm and flatpak cases are NOT run" >&2; }
FIRST="${KINDS%% *}"
[ "$WITH_FLATPAK" = 0 ] || KINDS="$KINDS flatpak"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
EXE_NAME="$(node -p "require('$ROOT/desktop/brand.json').executableName")"
ASAR="$ROOT/desktop/node_modules/.bin/asar"
[ -x "$ASAR" ] || { echo "asar tool missing (npm ci in desktop/)" >&2; exit 2; }

# ---- base trees (offline bundle trimmed to the two files the gate reads) -------------
slim() { # tree
  local d
  d="$(find "$1" -type d -path '*/resources/dist' -print -quit)"
  [ -n "$d" ] || { echo "no resources/dist in $1" >&2; exit 2; }
  mkdir "$T/keep"
  cp "$d/index.html" "$d/SOURCE.txt" "$T/keep/"
  rm -rf "$d"
  mkdir "$d"
  mv "$T/keep/index.html" "$T/keep/SOURCE.txt" "$d/"
  rmdir "$T/keep"
  # keep every mode and name, drop the bytes the gate does not read (the executable is kept for the fuse check)
  find "$1" -type f -size +1M ! -name "$EXE_NAME" -exec truncate -s 1 {} +
}
mkdir -p "$T/base/appimage"
if [ "$APPIMAGE_ONLY" = 0 ]; then
  mkdir -p "$T/base/deb" "$T/base/rpm"
  (umask 000 && dpkg-deb -x "$DEB" "$T/base/deb")
  mkdir "$T/base/deb.scripts"
  dpkg-deb -e "$DEB" "$T/base/deb.ctl"
  cp -a "$T/base/deb.ctl/." "$T/base/deb.scripts/"
  (umask 022 && cd "$T/base/rpm" && rpm2cpio "$RPM" | cpio -idm --quiet --no-absolute-filenames)
  mkdir "$T/base/rpm.scripts"
  rpm -qp --scripts "$RPM" > "$T/base/rpm.scripts/rpm-scripts.txt"
fi
(umask 000 && cd "$T/base/appimage" && cp "$IMG" ./img && chmod +x ./img && ./img --appimage-extract >/dev/null && rm ./img)
if [ "$WITH_FLATPAK" = 1 ]; then
  mkdir "$T/base/flatpak"
  cp -a "$FLAT/." "$T/base/flatpak/"
fi
for k in $KINDS; do slim "$T/base/$k"; done
mv "$T/base/appimage/squashfs-root" "$T/base/appimage.tree"
rmdir "$T/base/appimage"
mv "$T/base/appimage.tree" "$T/base/appimage"
mkdir "$T/base/appimage.scripts"

appdir() { dirname "$(dirname "$(find "$1" -path '*/resources/app.asar' -print -quit)")"; }
resdir() { dirname "$(find "$1" -path '*/resources/app.asar' -print -quit)"; }
EXPECT="$(sed -n 's/^  commit: *\([0-9a-f]\{40\}\)$/\1/p' "$(resdir "$T/base/$FIRST")/SOURCE.txt" | head -n1)"
[ -n "$EXPECT" ] || { echo "cannot read the built commit from SOURCE.txt" >&2; exit 2; }

run_gate() { # kind tree [extra gate args]  -> sets GATE_OUT, returns the gate's exit status
  local kind="$1" tree="$2"; shift 2
  local scripts="$T/base/$kind.scripts"
  [ -d "$scripts" ] || scripts="$T/base/appimage.scripts"
  set +e
  GATE_OUT="$("$GATE" --expect-commit "$EXPECT" --tree "$tree" --kind "$kind" --scripts "$scripts" "$@" 2>&1)"
  local rc=$?
  set -e
  return $rc
}

PASSED=0 MISSED=0
declare -a MISSED_NAMES=()
TABLE=""

# record NAME KIND GATE_RC WANT: a gate that passed is a miss; one that failed must say WANT in its first FAIL line.
record() {
  local name="$1" kind="$2" rc="$3" want="$4" first
  first="$(printf '%s\n' "$GATE_OUT" | grep -m1 '^FAIL' || true)"
  if [ "$rc" = 0 ]; then
    MISSED=$((MISSED + 1)); MISSED_NAMES+=("$name [$kind]")
    TABLE+="$(printf '%-52s %-9s MISSED (gate passed)' "$name" "$kind")"$'\n'
  elif [[ "$first" != *"$want"* ]]; then
    MISSED=$((MISSED + 1)); MISSED_NAMES+=("$name [$kind] failed for another reason: ${first:-<no FAIL line>} (wanted: $want)")
    TABLE+="$(printf '%-52s %-9s WRONG REASON: %s' "$name" "$kind" "$(printf '%s' "$first" | cut -c1-90)")"$'\n'
  else
    PASSED=$((PASSED + 1))
    TABLE+="$(printf '%-52s %-9s caught: %s' "$name" "$kind" "$(printf '%s' "$first" | cut -c1-90)")"$'\n'
  fi
}

attempt() { # name kind mutation-function want [gate args]
  local name="$1" kind="$2" fn="$3" want="${4:?attempt needs the expected failure substring}"; shift 4
  local w="$T/work" rc=0
  rm -rf "$w"
  cp -a --reflink=auto "$T/base/$kind" "$w"
  "$fn" "$w"
  run_gate "$kind" "$w" "$@" || rc=$?
  record "$name" "$kind" "$rc" "$want"
  rm -rf "$w"
}

# A change the gate must ACCEPT (e.g. a comment that merely mentions process.env).
attempt_ok() { # name kind mutation-function
  local name="$1" kind="$2" fn="$3" w="$T/work"
  rm -rf "$w"
  cp -a --reflink=auto "$T/base/$kind" "$w"
  "$fn" "$w"
  if run_gate "$kind" "$w"; then
    PASSED=$((PASSED + 1)); TABLE+="$(printf '%-52s %-9s accepted (correct)' "$name" "$kind")"$'\n'
  else
    MISSED=$((MISSED + 1)); MISSED_NAMES+=("$name [$kind] wrongly rejected: $(printf '%s\n' "$GATE_OUT" | grep -m1 '^FAIL')")
    TABLE+="$(printf '%-52s %-9s WRONGLY REJECTED' "$name" "$kind")"$'\n'
  fi
  rm -rf "$w"
}

# ---- positive controls -------------------------------------------------------------------------
for k in $KINDS; do
  if ! run_gate "$k" "$T/base/$k"; then printf '%s\n' "$GATE_OUT" | tail -5 >&2; echo "positive control failed: the unmodified $k tree must pass" >&2; exit 1; fi
done
echo "positive controls: unmodified $KINDS trees pass the gate"

# ---- mutations -----------------------------------------------------------------------------------
m_rm_chromium_lic() { rm "$(appdir "$1")/LICENSES.chromium.html"; }
m_empty_chromium_lic() { : > "$(appdir "$1")/LICENSES.chromium.html"; }
m_rm_electron_lic() { rm "$(appdir "$1")/LICENSE.electron.txt"; }
m_rm_notice() { rm "$(resdir "$1")/NOTICE"; }
m_empty_notice() { : > "$(resdir "$1")/NOTICE"; }
m_rm_source() { rm "$(resdir "$1")/SOURCE.txt"; }
m_source_commit() { sed -i -E '0,/^  commit: +[0-9a-f]{40}$/s//  commit:        0000000000000000000000000000000000000000/' "$(resdir "$1")/SOURCE.txt"; }
m_source_dirty() { sed -i 's/dirty=no/dirty=yes/' "$(resdir "$1")/SOURCE.txt"; }
m_source_no_url() { sed -i 's#https://github.com/[A-Za-z0-9_./-]*#https://example.invalid/x#g' "$(resdir "$1")/SOURCE.txt"; }
m_source_no_tagline() { sed -i '/release tag:/d' "$(resdir "$1")/SOURCE.txt"; }
m_source_no_upstream() { sed -i "s/$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")/deadbeef/" "$(resdir "$1")/SOURCE.txt"; }
m_flip_fuse() {
  node -e "
    const { flipFuses, FuseVersion, FuseV1Options } = require(require.resolve('@electron/fuses', { paths: ['$ROOT/desktop'] }));
    flipFuses(process.argv[1], { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: true }).catch((e) => { console.error(e); process.exit(1); });
  " "$(appdir "$1")/$EXE_NAME"
}
m_apprun_no_sandbox() { sed -i 's#^exec "\$HERE/\([^"]*\)" "\$@"#exec "$HERE/\1" --no-sandbox "$@"#' "$1/AppRun"; }
m_apprun_short_unset() { sed -i 's/ CHROME_DEVEL_SANDBOX//' "$1/AppRun"; }
m_apprun_short_unset_tail() { sed -i 's/ NODE_OPTIONS//' "$1/AppRun"; }
m_apprun_headless_kept() { sed -i 's/ BENTO_TEST_HEADLESS//' "$1/AppRun"; }
m_apprun_no_unset() { sed -i '/^unset /d' "$1/AppRun"; }
m_apprun_stock() { printf '#!/bin/sh\nexec "$APPDIR/%s" --no-sandbox "$@"\n' "$EXE_NAME" > "$1/AppRun"; }
m_desktop_no_sandbox() { find "$1" -name '*.desktop' -not -path '*/resources/*' -exec sed -i -E 's/^(Exec=.*) %f$/\1 --no-sandbox %f/' {} +; }
m_desktop_no_pdf() { find "$1" -name '*.desktop' -exec sed -i '/^MimeType=/d' {} +; }
m_desktop_no_percent_f() { find "$1" -name '*.desktop' -exec sed -i -E 's/^(Exec=.*) %f$/\1/' {} +; }
m_rm_desktop() { find "$1" -name '*.desktop' -delete; }
m_bin_0777() { chmod 0777 "$(appdir "$1")/$EXE_NAME"; }
m_file_0666() { chmod 0666 "$(resdir "$1")/resources.pak" 2>/dev/null || chmod 0666 "$(appdir "$1")/resources.pak"; }
m_dir_0777() { chmod 0777 "$(appdir "$1")/locales"; }
m_group_writable() { chmod 0775 "$(appdir "$1")/icudtl.dat"; }
m_setuid_file() { chmod 4755 "$(appdir "$1")/libffmpeg.so"; }
m_setgid_file() { chmod 2755 "$(appdir "$1")/libffmpeg.so"; }
m_sandbox_setuid() { chmod 4755 "$(appdir "$1")/chrome-sandbox"; }
m_sandbox_0700() { chmod 0700 "$(appdir "$1")/chrome-sandbox"; }
m_rm_sandbox() { rm "$(appdir "$1")/chrome-sandbox"; }
m_flatpak_add_sandbox() { cp "$(appdir "$1")/$EXE_NAME" "$(appdir "$1")/chrome-sandbox"; }
asar_edit() { # tree file sed-expression
  local ap x
  ap="$(resdir "$1")/app.asar"; x="$T/asar-edit"
  rm -rf "$x"; "$ASAR" extract "$ap" "$x"
  sed -i -E "$3" "$x/$2"
  "$ASAR" pack "$x" "$ap"; rm -rf "$x"
}
m_about_no_warranty() { asar_edit "$1" src/menu.js 's/ABSOLUTELY NO WARRANTY/NOTHING/'; }
m_about_no_source() { asar_edit "$1" src/menu.js 's/brand\.sourceUrl/"x"/g'; }
m_about_no_agpl() { asar_edit "$1" src/menu.js 's/AGPL-3\.0-only/GPL/g'; }
m_test_marker() { printf 'bento-test-mode-v1\n' > "$(resdir "$1")/.bento-test-mode"; }
m_test_marker_root() { printf 'bento-test-mode-v1\n' > "$1/.bento-test-mode"; }
m_test_marker_symlink() { ln -s /nonexistent "$(appdir "$1")/.bento-test-mode"; }
m_marker_gate_gone() { asar_edit "$1" src/main.js 's/testMarker: app\.isPackaged && hasTestMarker\(process\.resourcesPath\)/testMarker: true/'; }
# marker logic inside the packaged asar (the gate must RUN and READ it, not just see that the files exist)
m_marker_returns_true() { asar_edit "$1" src/test-mode.js 's/^(function hasTestMarker\(.*\{)$/\1\n  return true;/'; }
m_marker_nlink_removed() { asar_edit "$1" src/test-mode.js 's/ st\.nlink !== 1 \|\|//'; }
m_marker_nlink_weakened() { asar_edit "$1" src/test-mode.js 's/st\.nlink !== 1/st.nlink > 1/'; } # behaviour identical for real files, text differs: only the static layer sees it
m_marker_uid_removed() { asar_edit "$1" src/test-mode.js 's/ st\.uid !== uid \|\|//'; }
m_marker_mask_removed() { asar_edit "$1" src/test-mode.js 's/ \(st\.mode & 0o022\) !== 0 \|\|//'; }
m_marker_nofollow_removed() { asar_edit "$1" src/test-mode.js 's/ \| fsImpl\.constants\.O_NOFOLLOW//'; }
m_marker_token_loose() { asar_edit "$1" src/test-mode.js 's/=== MARKER_CONTENT;/.startsWith("bento");/'; }
m_marker_realpath_removed() { asar_edit "$1" src/test-mode.js '/fsImpl\.realpathSync\(resourcesPath\)/d'; }
m_argv_marker_dropped() { asar_edit "$1" src/argv-policy.js 's/\(!packaged \|\| testMarker === true\)/(!packaged || true)/'; }
m_argv_marker_truthy() { asar_edit "$1" src/argv-policy.js 's/testMarker === true\)/testMarker)/'; }
m_main_marker_constant() { asar_edit "$1" src/main.js 's/testMarker: app\.isPackaged && hasTestMarker\(process\.resourcesPath\)/testMarker: false/'; }
# process.env scan: comments are fine, a real read on an exempt-looking line is not
m_env_in_line_comment() { asar_edit "$1" src/argv-policy.js '1a // process.env is mentioned here only in a comment'; }
m_env_in_block_comment() { asar_edit "$1" src/menu.js '1a /* process.env, process.env.HOME: still only a comment */'; }
m_env_on_exempt_line() { asar_edit "$1" src/main.js 's/^(const refused = unsafeSwitches\(process\.argv, process\.env, policyOptions\);)$/\1 const leak = process.env.HOME;/'; }
m_env_on_exempt_line2() { asar_edit "$1" src/main.js 's/^(const overrides = app\.isPackaged \? \{\} : process\.env;)$/\1 const leak = process["env"].HOME;/'; }
m_env_destructured() { asar_edit "$1" src/menu.js '1a const { env } = process;'; }
m_env_override() { asar_edit "$1" src/main.js 's/app\.isPackaged \? \{\} : process\.env/process.env/'; }
m_env_elsewhere() { asar_edit "$1" src/app.js '1a const leak = process.env.HOME;'; }
m_argv_policy_gone() { asar_edit "$1" src/main.js 's/unsafeSwitches\(process\.argv, process\.env, policyOptions\)/[]/'; }
m_argv_second_gone() { asar_edit "$1" src/main.js 's/unsafeSwitches\(argv, process\.env, \{ \.\.\.policyOptions, secondInstance: true \}\)/[]/'; }
m_headless_env_honoured() { asar_edit "$1" src/main.js 's/unsafeSwitches\(process\.argv, process\.env, policyOptions\)/unsafeSwitches(process.argv, {BENTO_TEST_HEADLESS: "1"})/'; }
m_no_magic() { asar_edit "$1" src/open-file.js 's/%PDF-/%XXX-/g'; }
m_asar_no_sandbox_flag() { asar_edit "$1" src/main.js '1a const x = "--no-sandbox";'; }
m_rm_asar() { rm "$(resdir "$1")/app.asar"; }
m_rm_dist_index() { rm "$(resdir "$1")/dist/index.html"; }
m_rm_exe() { rm "$(appdir "$1")/$EXE_NAME"; }
m_big_asar() { head -c 6000000 /dev/zero >> "$(resdir "$1")/app.asar"; }
m_flatpak_x11() { sed -i 's/^sockets=!x11;/sockets=x11;/' "$1/metadata"; }
m_flatpak_no_nosocket() { sed -i 's/^sockets=!x11;/sockets=/' "$1/metadata"; }
m_flatpak_network() { sed -i 's/^shared=\(.*\)/shared=network;\1/' "$1/metadata"; }
m_flatpak_fs() { printf 'filesystems=home;\n' >> "$1/metadata"; }
m_flatpak_launcher_unset() { sed -i '/^unset /d' "$1/files/bin/$EXE_NAME"; }
m_flatpak_launcher_headless_kept() { sed -i 's/ BENTO_TEST_HEADLESS//' "$1/files/bin/$EXE_NAME"; }
m_flatpak_launcher_short_unset() { sed -i 's/ ELECTRON_ENABLE_LOGGING//' "$1/files/bin/$EXE_NAME"; }
m_main_no_refusal() { asar_edit "$1" src/main.js "s/'CHROME_DEVEL_SANDBOX'/'X'/"; }
m_main_no_refusal2() { asar_edit "$1" src/main.js "s/'ELECTRON_DISABLE_SANDBOX'/'X'/"; }
m_flatpak_launcher_nosandbox() { sed -i 's#exec zypak-wrapper#exec#' "$1/files/bin/$EXE_NAME"; }
none() { :; }

attempt_scripts() { # name kind file-in-scripts sed-expr|DELETE want
  local name="$1" kind="$2" file="$3" expr="$4" want="${5:?attempt_scripts needs the expected failure substring}"
  local w="$T/work" s="$T/base/$kind.scripts" bak="$T/scripts.bak"
  rm -rf "$w" "$bak"
  cp -a --reflink=auto "$T/base/$kind" "$w"
  cp -a "$s" "$bak"
  if [ "$expr" = DELETE ]; then rm "$s/$file"; elif [ "$expr" = EMPTY ]; then : > "$s/$file"; else sed -i -E "$expr" "$s/$file"; fi
  local rc=0
  run_gate "$kind" "$w" || rc=$?
  record "$name" "$kind" "$rc" "$want"
  rm -rf "$s" "$w"
  cp -a "$bak" "$s"
}

for k in $KINDS; do
  attempt "remove LICENSES.chromium.html" $k m_rm_chromium_lic "missing or empty"
  attempt "empty LICENSES.chromium.html" $k m_empty_chromium_lic "missing or empty"
  attempt "remove LICENSE.electron.txt" $k m_rm_electron_lic "missing or empty"
  attempt "remove NOTICE" $k m_rm_notice "missing or empty"
  attempt "empty NOTICE" $k m_empty_notice "missing or empty"
  attempt "remove SOURCE.txt" $k m_rm_source "missing or empty"
  attempt "change SOURCE.txt commit" $k m_source_commit "does not name the built commit"
  attempt "SOURCE.txt says dirty=yes" $k m_source_dirty "was dirty"
  attempt "SOURCE.txt without repository URL" $k m_source_no_url "does not name the repository"
  attempt "SOURCE.txt without release tag line" $k m_source_no_tagline "no 'release tag:' line"
  attempt "SOURCE.txt without upstream commit" $k m_source_no_upstream "does not name the upstream commit"
  attempt "flip a fuse (RunAsNode on)" $k m_flip_fuse "RunAsNode"
  attempt "remove all .desktop entries (empty glob)" $k m_rm_desktop "desktop"
  attempt "desktop entry loses MimeType" $k m_desktop_no_pdf "no MimeType=application/pdf"
  attempt "desktop Exec loses %f" $k m_desktop_no_percent_f "Exec does not end in %f"
  attempt "binary mode 0777" $k m_bin_0777 "group/world-writable"
  attempt "resources.pak mode 0666" $k m_file_0666 "group/world-writable"
  attempt "locales dir mode 0777" $k m_dir_0777 "group/world-writable"
  attempt "icudtl.dat group-writable" $k m_group_writable "group/world-writable"
  attempt "setuid file in payload" $k m_setuid_file "setuid/setgid"
  attempt "setgid file in payload" $k m_setgid_file "setuid/setgid"
  attempt "About text drops the no-warranty line" $k m_about_no_warranty "no-warranty line"
  attempt "About text drops the source URL" $k m_about_no_source "does not offer the source URL"
  attempt "About text drops the AGPL notice" $k m_about_no_agpl "lacks the AGPL notice"
  attempt "BENTO_* env override honoured when packaged" $k m_env_override "does not gate BENTO_* overrides on app.isPackaged"
  attempt "test-mode marker in resources/" $k m_test_marker "test-mode marker .bento-test-mode is present"
  attempt "test-mode marker at the tree root" $k m_test_marker_root "test-mode marker .bento-test-mode is present"
  attempt "test-mode marker as a symlink in the app dir" $k m_test_marker_symlink "test-mode marker .bento-test-mode is present"
  attempt "main.js stops gating test mode on the marker" $k m_marker_gate_gone "does not gate packaged test mode on the marker"
  attempt "process.env read outside the guard" $k m_env_elsewhere "not one of the known guarded lines"
  attempt "marker: hasTestMarker returns true" $k m_marker_returns_true "packaged marker logic"
  attempt "marker: nlink check removed" $k m_marker_nlink_removed "packaged marker logic: hard-linked marker"
  attempt "marker: nlink check reworded (static layer)" $k m_marker_nlink_weakened "lost the marker control: st.nlink"
  attempt "marker: owner check removed" $k m_marker_uid_removed "packaged marker logic: marker owned by another uid"
  attempt "marker: group/world-writable check removed" $k m_marker_mask_removed "packaged marker logic: group-writable marker"
  attempt "marker: O_NOFOLLOW removed" $k m_marker_nofollow_removed "packaged marker logic: symlinked marker"
  attempt "marker: token compare loosened" $k m_marker_token_loose "packaged marker logic: marker with a same-length, same-prefix token"
  attempt "marker: realpath check removed" $k m_marker_realpath_removed "packaged marker logic: resources path through a symlink"
  attempt "argv policy: marker condition dropped" $k m_argv_marker_dropped "packaged marker logic: packaged + env, no marker"
  attempt "argv policy: marker condition truthy, not === true" $k m_argv_marker_truthy "packaged marker logic: packaged + env, truthy non-true marker"
  attempt "main.js passes a constant false as the marker" $k m_main_marker_constant "does not gate packaged test mode on the marker"
  attempt "process.env read appended to the argv-check line" $k m_env_on_exempt_line "not one of the known guarded lines"
  attempt "process[\"env\"] read appended to the overrides line" $k m_env_on_exempt_line2 "not one of the known guarded lines"
  attempt "const { env } = process destructuring" $k m_env_destructured "not one of the known guarded lines"
  attempt_ok "line comment mentioning process.env is accepted" $k m_env_in_line_comment
  attempt_ok "block comment mentioning process.env is accepted" $k m_env_in_block_comment
  attempt "argv policy not applied to own argv" $k m_argv_policy_gone "does not check its own argv"
  attempt "argv policy not applied to second-instance argv" $k m_argv_second_gone "second-instance argv"
  attempt "BENTO_TEST_HEADLESS honoured when packaged" $k m_headless_env_honoured "does not check its own argv"
  attempt "open-with magic-byte check removed" $k m_no_magic "does not check the %PDF- header"
  attempt "main.js stops refusing CHROME_DEVEL_SANDBOX" $k m_main_no_refusal "does not refuse to start when"
  attempt "main.js stops refusing ELECTRON_DISABLE_SANDBOX" $k m_main_no_refusal2 "does not refuse to start when"
  attempt "forbidden flag literal inside app.asar" $k m_asar_no_sandbox_flag "forbidden flag inside app.asar"
  attempt "remove app.asar" $k m_rm_asar "no resources/app.asar found"
  attempt "remove resources/dist/index.html" $k m_rm_dist_index "offline bundle missing"
  attempt "remove the executable" $k m_rm_exe "missing executable"
  attempt "app.asar grows past 5 MB (bundle inside asar)" $k m_big_asar "suspiciously large"
done
for k in ${KINDS/flatpak/}; do
  attempt "chrome-sandbox setuid in the payload" $k m_sandbox_setuid "setuid/setgid"
  attempt "chrome-sandbox mode 0700" $k m_sandbox_0700 "chrome-sandbox payload mode"
  attempt "chrome-sandbox missing" $k m_rm_sandbox "no chrome-sandbox helper"
done
attempt "--no-sandbox added to AppRun" appimage m_apprun_no_sandbox "forbidden flag"
attempt "AppRun no longer unsets ELECTRON_DISABLE_SANDBOX" appimage m_apprun_no_unset "has no unset line"
attempt "AppRun unset list loses CHROME_DEVEL_SANDBOX" appimage m_apprun_short_unset "does not unset CHROME_DEVEL_SANDBOX"
attempt "AppRun unset list loses NODE_OPTIONS" appimage m_apprun_short_unset_tail "does not unset NODE_OPTIONS"
attempt "AppRun no longer unsets BENTO_TEST_HEADLESS" appimage m_apprun_headless_kept "does not unset BENTO_TEST_HEADLESS"
attempt "stock electron-builder AppRun" appimage m_apprun_stock "forbidden flag"
for k in ${KINDS/flatpak/}; do
  attempt "--no-sandbox added to the .desktop Exec" $k m_desktop_no_sandbox "forbidden flag"
done
if [ "$WITH_FLATPAK" = 1 ]; then
  attempt "--no-sandbox added to the .desktop Exec" flatpak m_desktop_no_sandbox "forbidden flag"
  attempt "flatpak payload ships chrome-sandbox" flatpak m_flatpak_add_sandbox "contains chrome-sandbox"
  attempt "flatpak grants the plain x11 socket" flatpak m_flatpak_x11 "grants the plain x11 socket"
  attempt "flatpak does not remove the x11 socket" flatpak m_flatpak_no_nosocket "does not remove the x11 socket"
  attempt "flatpak grants network" flatpak m_flatpak_network "grants network"
  attempt "flatpak grants a filesystem" flatpak m_flatpak_fs "grants filesystem access"
  attempt "flatpak launcher stops unsetting dangerous env" flatpak m_flatpak_launcher_unset "has no unset line"
  attempt "flatpak unset list loses ELECTRON_ENABLE_LOGGING" flatpak m_flatpak_launcher_short_unset "does not unset ELECTRON_ENABLE_LOGGING"
  attempt "flatpak launcher no longer unsets BENTO_TEST_HEADLESS" flatpak m_flatpak_launcher_headless_kept "does not unset BENTO_TEST_HEADLESS"
  attempt "flatpak launcher without zypak-wrapper" flatpak m_flatpak_launcher_nosandbox "does not use zypak-wrapper"
fi
attempt "--release with unresolved NOTICE / no release tag" "$FIRST" none "release build but" --release

# One marker definition (packaging/check-notice.sh): in an otherwise release-ready tree, every unresolved-marker
# spelling in NOTICE must fail --release. A positive control proves the tree is release-ready, so these fail only
# because of the marker.
m_release_ready() {
  sed -i -E 's/^  release tag: +none/  release tag:   v9.9.9/' "$(resdir "$1")/SOURCE.txt"
  printf 'Licensed under the GNU Affero General Public License v3.0\n' > "$(resdir "$1")/NOTICE"
}
m_release_marker() { m_release_ready "$1"; printf 'foo: %s\n' "$RELMARK" >> "$(resdir "$1")/NOTICE"; }
rm -rf "$T/work"; cp -a --reflink=auto "$T/base/$FIRST" "$T/work"; m_release_ready "$T/work"
if ! run_gate "$FIRST" "$T/work" --release; then
  printf '%s\n' "$GATE_OUT" | tail -5 >&2; echo "positive control failed: a release-ready $FIRST tree must pass --release" >&2; exit 1
fi
rm -rf "$T/work"
echo "positive control: release-ready $FIRST tree passes --release"
for RELMARK in "NEEDS REVIEW" "needs review" "Needs Review" "TODO" "todo" "TBD" "Unverified"; do
  attempt "release-ready tree with NOTICE marker '$RELMARK'" "$FIRST" m_release_marker "unresolved marker" --release
done

if [ "$APPIMAGE_ONLY" = 0 ]; then
  attempt_scripts "postinst missing" deb postinst DELETE "missing or empty maintainer script"
  attempt_scripts "postinst empty" deb postinst EMPTY "missing or empty maintainer script"
  attempt_scripts "postinst probes as root (no setpriv)" deb postinst 's/setpriv --reuid=65534/true/' "does not probe user namespaces"
  attempt_scripts "postinst without AppArmor check" deb postinst 's/apparmor_restrict_unprivileged_userns/x/g' "AppArmor userns restriction"
  attempt_scripts "postinst without setuid fallback" deb postinst 's/chmod 4755/chmod 0755/' "no setuid fallback"
  attempt_scripts "postinst adds --no-sandbox" deb postinst '$a echo --no-sandbox' "forbidden flag in a maintainer script"
  attempt_scripts "rpm scriptlet missing" rpm rpm-scripts.txt DELETE "missing or empty maintainer script"
  attempt_scripts "rpm scriptlet without setpriv probe" rpm rpm-scripts.txt 's/setpriv --reuid=65534/true/' "does not probe user namespaces"
fi

# an empty extracted tree must fail, never pass vacuously
mkdir "$T/empty"
rc=0
GATE_OUT="$("$GATE" --expect-commit "$EXPECT" --tree "$T/empty" --kind deb 2>&1)" || rc=$?
record "empty extracted tree" deb "$rc" "no resources/app.asar found"

printf '%s' "$TABLE"
echo "mutations caught: $PASSED, missed: $MISSED"
if [ "$MISSED" -gt 0 ]; then printf 'MISSED: %s\n' "${MISSED_NAMES[@]}" >&2; exit 1; fi
echo "ALL MUTATIONS CAUGHT"
