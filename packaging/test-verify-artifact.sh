#!/usr/bin/env bash
# Mutation test of the release gate. Extracts built artifacts once, then for every
# mutation makes a COPY of the extracted tree, breaks one thing, and asserts that
# packaging/verify-artifact.sh FAILS. A positive control (the unmodified tree must pass)
# runs first. Exit 0 only if every mutation was caught.
#
#   packaging/test-verify-artifact.sh [--deb F] [--rpm F] [--appimage F] [--flatpak DIR | --no-flatpak]
# Defaults: the newest files in desktop/release/ and packaging/flatpak/.build/app.
# GATE=<script> runs a different gate (used to show what an older gate missed); it must
# accept the same --tree/--kind/--scripts arguments.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="${GATE:-$ROOT/packaging/verify-artifact.sh}"
REL="$ROOT/desktop/release"
DEB="" RPM="" IMG="" FLAT="" WITH_FLATPAK=1
while [ $# -gt 0 ]; do
  case "$1" in
    --deb) DEB="$2"; shift ;;
    --rpm) RPM="$2"; shift ;;
    --appimage) IMG="$2"; shift ;;
    --flatpak) FLAT="$2"; shift ;;
    --no-flatpak) WITH_FLATPAK=0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
newest() { find "$REL" -maxdepth 1 -name "$1" -print 2>/dev/null | sort | tail -n1; }
[ -n "$DEB" ] || DEB="$(newest '*.deb')"
[ -n "$RPM" ] || RPM="$(newest '*.rpm')"
[ -n "$IMG" ] || IMG="$(newest '*.AppImage')"
[ -n "$FLAT" ] || FLAT="$ROOT/packaging/flatpak/.build/app"
for f in "$DEB" "$RPM" "$IMG"; do [ -f "$f" ] || { echo "missing artifact: '$f'" >&2; exit 2; }; done
if [ "$WITH_FLATPAK" = 1 ]; then
  [ -d "$FLAT/files" ] || { echo "missing flatpak build dir: $FLAT (pass --no-flatpak to test without it)" >&2; exit 2; }
fi
KINDS="deb rpm appimage"
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
mkdir -p "$T/base/deb" "$T/base/rpm" "$T/base/appimage"
(umask 000 && dpkg-deb -x "$DEB" "$T/base/deb")
mkdir "$T/base/deb.scripts"
dpkg-deb -e "$DEB" "$T/base/deb.ctl"
cp -a "$T/base/deb.ctl/." "$T/base/deb.scripts/"
(umask 022 && cd "$T/base/rpm" && rpm2cpio "$RPM" | cpio -idm --quiet --no-absolute-filenames)
mkdir "$T/base/rpm.scripts"
rpm -qp --scripts "$RPM" > "$T/base/rpm.scripts/rpm-scripts.txt"
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
EXPECT="$(sed -n 's/^  commit: *\([0-9a-f]\{40\}\)$/\1/p' "$(resdir "$T/base/deb")/SOURCE.txt" | head -n1)"
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

attempt() { # name kind mutation-function [gate args]
  local name="$1" kind="$2" fn="$3"; shift 3
  local w="$T/work"
  rm -rf "$w"
  cp -a --reflink=auto "$T/base/$kind" "$w"
  "$fn" "$w"
  if run_gate "$kind" "$w" "$@"; then
    MISSED=$((MISSED + 1)); MISSED_NAMES+=("$name [$kind]")
    TABLE+="$(printf '%-52s %-9s MISSED (gate passed)' "$name" "$kind")"$'\n'
  else
    PASSED=$((PASSED + 1))
    TABLE+="$(printf '%-52s %-9s caught: %s' "$name" "$kind" "$(printf '%s\n' "$GATE_OUT" | grep -m1 '^FAIL' | cut -c1-90)")"$'\n'
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
m_env_override() { asar_edit "$1" src/main.js 's/app\.isPackaged \? \{\} : process\.env/process.env/'; }
m_env_elsewhere() { asar_edit "$1" src/app.js '1a const leak = process.env.HOME;'; }
m_argv_policy_gone() { asar_edit "$1" src/main.js 's/unsafeSwitches\(process\.argv\)/[]/'; }
m_argv_second_gone() { asar_edit "$1" src/main.js 's/unsafeSwitches\(argv\)/[]/'; }
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
m_flatpak_launcher_nosandbox() { sed -i 's#exec zypak-wrapper#exec#' "$1/files/bin/$EXE_NAME"; }
none() { :; }

attempt_scripts() { # name kind file-in-scripts sed-expr|DELETE
  local name="$1" kind="$2" file="$3" expr="$4"
  local w="$T/work" s="$T/base/$kind.scripts" bak="$T/scripts.bak"
  rm -rf "$w" "$bak"
  cp -a --reflink=auto "$T/base/$kind" "$w"
  cp -a "$s" "$bak"
  if [ "$expr" = DELETE ]; then rm "$s/$file"; elif [ "$expr" = EMPTY ]; then : > "$s/$file"; else sed -i -E "$expr" "$s/$file"; fi
  if run_gate "$kind" "$w"; then
    MISSED=$((MISSED + 1)); MISSED_NAMES+=("$name [$kind]")
    TABLE+="$(printf '%-52s %-9s MISSED (gate passed)' "$name" "$kind")"$'\n'
  else
    PASSED=$((PASSED + 1))
    TABLE+="$(printf '%-52s %-9s caught: %s' "$name" "$kind" "$(printf '%s\n' "$GATE_OUT" | grep -m1 '^FAIL' | cut -c1-90)")"$'\n'
  fi
  rm -rf "$s" "$w"
  cp -a "$bak" "$s"
}

for k in $KINDS; do
  attempt "remove LICENSES.chromium.html" $k m_rm_chromium_lic
  attempt "empty LICENSES.chromium.html" $k m_empty_chromium_lic
  attempt "remove LICENSE.electron.txt" $k m_rm_electron_lic
  attempt "remove NOTICE" $k m_rm_notice
  attempt "empty NOTICE" $k m_empty_notice
  attempt "remove SOURCE.txt" $k m_rm_source
  attempt "change SOURCE.txt commit" $k m_source_commit
  attempt "SOURCE.txt says dirty=yes" $k m_source_dirty
  attempt "SOURCE.txt without repository URL" $k m_source_no_url
  attempt "SOURCE.txt without release tag line" $k m_source_no_tagline
  attempt "SOURCE.txt without upstream commit" $k m_source_no_upstream
  attempt "flip a fuse (RunAsNode on)" $k m_flip_fuse
  attempt "remove all .desktop entries (empty glob)" $k m_rm_desktop
  attempt "desktop entry loses MimeType" $k m_desktop_no_pdf
  attempt "desktop Exec loses %f" $k m_desktop_no_percent_f
  attempt "binary mode 0777" $k m_bin_0777
  attempt "resources.pak mode 0666" $k m_file_0666
  attempt "locales dir mode 0777" $k m_dir_0777
  attempt "icudtl.dat group-writable" $k m_group_writable
  attempt "setuid file in payload" $k m_setuid_file
  attempt "setgid file in payload" $k m_setgid_file
  attempt "About text drops the no-warranty line" $k m_about_no_warranty
  attempt "About text drops the source URL" $k m_about_no_source
  attempt "About text drops the AGPL notice" $k m_about_no_agpl
  attempt "BENTO_* env override honoured when packaged" $k m_env_override
  attempt "process.env read outside the guard" $k m_env_elsewhere
  attempt "argv policy not applied to own argv" $k m_argv_policy_gone
  attempt "argv policy not applied to second-instance argv" $k m_argv_second_gone
  attempt "open-with magic-byte check removed" $k m_no_magic
  attempt "forbidden flag literal inside app.asar" $k m_asar_no_sandbox_flag
  attempt "remove app.asar" $k m_rm_asar
  attempt "remove resources/dist/index.html" $k m_rm_dist_index
  attempt "remove the executable" $k m_rm_exe
  attempt "app.asar grows past 5 MB (bundle inside asar)" $k m_big_asar
done
for k in deb rpm appimage; do
  attempt "chrome-sandbox setuid in the payload" $k m_sandbox_setuid
  attempt "chrome-sandbox mode 0700" $k m_sandbox_0700
  attempt "chrome-sandbox missing" $k m_rm_sandbox
done
attempt "--no-sandbox added to AppRun" appimage m_apprun_no_sandbox
attempt "AppRun no longer unsets ELECTRON_DISABLE_SANDBOX" appimage m_apprun_no_unset
attempt "stock electron-builder AppRun" appimage m_apprun_stock
attempt "--no-sandbox added to the .desktop Exec" deb m_desktop_no_sandbox
attempt "--no-sandbox added to the .desktop Exec" rpm m_desktop_no_sandbox
attempt "--no-sandbox added to the .desktop Exec" appimage m_desktop_no_sandbox
if [ "$WITH_FLATPAK" = 1 ]; then
  attempt "--no-sandbox added to the .desktop Exec" flatpak m_desktop_no_sandbox
  attempt "flatpak payload ships chrome-sandbox" flatpak m_flatpak_add_sandbox
  attempt "flatpak grants the plain x11 socket" flatpak m_flatpak_x11
  attempt "flatpak does not remove the x11 socket" flatpak m_flatpak_no_nosocket
  attempt "flatpak grants network" flatpak m_flatpak_network
  attempt "flatpak grants a filesystem" flatpak m_flatpak_fs
  attempt "flatpak launcher stops unsetting dangerous env" flatpak m_flatpak_launcher_unset
  attempt "flatpak launcher without zypak-wrapper" flatpak m_flatpak_launcher_nosandbox
fi
attempt "--release with unresolved NOTICE / no release tag" deb none --release

attempt_scripts "postinst missing" deb postinst DELETE
attempt_scripts "postinst empty" deb postinst EMPTY
attempt_scripts "postinst probes as root (no setpriv)" deb postinst 's/setpriv --reuid=65534/true/'
attempt_scripts "postinst without AppArmor check" deb postinst 's/apparmor_restrict_unprivileged_userns/x/g'
attempt_scripts "postinst without setuid fallback" deb postinst 's/chmod 4755/chmod 0755/'
attempt_scripts "postinst adds --no-sandbox" deb postinst '$a echo --no-sandbox'
attempt_scripts "rpm scriptlet missing" rpm rpm-scripts.txt DELETE
attempt_scripts "rpm scriptlet without setpriv probe" rpm rpm-scripts.txt 's/setpriv --reuid=65534/true/'

# an empty extracted tree must fail, never pass vacuously
mkdir "$T/empty"
if "$GATE" --expect-commit "$EXPECT" --tree "$T/empty" --kind deb >/dev/null 2>&1; then
  MISSED=$((MISSED + 1)); MISSED_NAMES+=("empty tree")
  TABLE+="$(printf '%-52s %-9s MISSED (gate passed)' "empty extracted tree" deb)"$'\n'
else
  PASSED=$((PASSED + 1)); TABLE+="$(printf '%-52s %-9s caught' "empty extracted tree" deb)"$'\n'
fi

printf '%s' "$TABLE"
echo "mutations caught: $PASSED, missed: $MISSED"
if [ "$MISSED" -gt 0 ]; then printf 'MISSED: %s\n' "${MISSED_NAMES[@]}" >&2; exit 1; fi
echo "ALL MUTATIONS CAUGHT"
