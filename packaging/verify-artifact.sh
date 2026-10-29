#!/usr/bin/env bash
# Release gate. Inspects a built Linux artifact without installing or starting it
# and fails on the first violated rule. Missing or empty inputs are failures,
# never skipped checks.
#
#   packaging/verify-artifact.sh [options] <file.AppImage | file.deb | file.rpm | flatpak-build-dir>
#   packaging/verify-artifact.sh [options] --tree <extracted-dir> --kind <appimage|deb|rpm|flatpak> [--scripts <dir>]
#
# Options:
#   --release            also require: clean tree, a release tag in SOURCE.txt, zero unresolved markers in NOTICE (packaging/check-notice.sh)
#   --allow-dirty        accept SOURCE.txt saying dirty=yes (local experiments only)
#   --expect-commit SHA  commit SOURCE.txt must name (default: git HEAD of this checkout)
#
# Checks: licence files and SOURCE.txt provenance; offline bundle outside app.asar;
# Electron fuses; BENTO_* overrides gated on app.isPackaged; no sandbox-off or devtools
# flags; argv policy and About/source offer present; desktop entries; launchers unset
# sandbox-off env; deb/rpm post-install policy; Flatpak permissions; file modes (nothing
# group/world-writable, nothing setuid or setgid, chrome-sandbox exactly 0755 and absent
# from the Flatpak). Names come from desktop/brand.json.
# Packaged test mode: the packaged test-mode.js / argv-policy.js are RUN (desktop/tools/check-asar-policy.js), not just
# grepped, and no .bento-test-mode may exist. deb/rpm launchers start the binary with no env scrub, so for them the
# root-owned install tree (every entry root:root, nothing group/world-writable) is the only defence: see docs/desktop-linux.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok:   $*"; }

RELEASE=0 ALLOW_DIRTY=0 EXPECT_COMMIT="" TREE="" KIND="" SCRIPTS_ARG="" ART_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --expect-commit) EXPECT_COMMIT="${2:?--expect-commit needs a SHA}"; shift ;;
    --tree) TREE="${2:?--tree needs a directory}"; shift ;;
    --kind) KIND="${2:?--kind needs a value}"; shift ;;
    --scripts) SCRIPTS_ARG="${2:?--scripts needs a directory}"; shift ;;
    -*) fail "unknown option $1" ;;
    *) ART_ARG="$1" ;;
  esac
  shift
done

brand() { node -p "require('$ROOT/desktop/brand.json').$1"; }
EXE_NAME="$(brand executableName)"
APP_ID="$(brand appId)"
SOURCE_URL="$(brand sourceUrl)"
[ -n "$EXE_NAME" ] && [ -n "$APP_ID" ] && [ -n "$SOURCE_URL" ] || fail "desktop/brand.json is incomplete"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/x"
SCRIPTS="$WORK/scripts"
mkdir -p "$OUT" "$SCRIPTS"
ART="(tree)"

if [ -n "$TREE" ]; then
  [ -d "$TREE" ] || fail "no such directory: $TREE"
  [ -n "$KIND" ] || fail "--tree needs --kind"
  OUT="$(readlink -f "$TREE")"
  [ -z "$SCRIPTS_ARG" ] || SCRIPTS="$(readlink -f "$SCRIPTS_ARG")"
else
  [ -n "$ART_ARG" ] || fail "usage: verify-artifact.sh [options] <artifact>"
  ART="$(readlink -f "$ART_ARG")"
  if [ -d "$ART" ]; then
    KIND=flatpak
    OUT="$ART"
  else
    [ -f "$ART" ] || fail "no such file: $ART"
    case "$ART" in
      *.AppImage)
        KIND=appimage
        chmod +x "$ART"
        (umask 000 && cd "$OUT" && "$ART" --appimage-extract >/dev/null)
        OUT="$OUT/squashfs-root" ;;
      *.deb)
        KIND=deb
        (umask 000 && dpkg-deb -x "$ART" "$OUT")
        ctrl="$WORK/control"
        mkdir -p "$ctrl"
        dpkg-deb -e "$ART" "$ctrl"
        cp -a "$ctrl/." "$SCRIPTS/" ;;
      *.rpm)
        KIND=rpm
        (umask 022 && cd "$OUT" && rpm2cpio "$ART" | cpio -idm --quiet --no-absolute-filenames)
        rpm -qp --scripts "$ART" > "$SCRIPTS/rpm-scripts.txt" ;;
      *) fail "unsupported artifact type: $ART" ;;
    esac
  fi
fi
case "$KIND" in appimage|deb|rpm|flatpak) ;; *) fail "unknown kind: $KIND" ;; esac

PAYLOAD="$OUT"
FLATPAK_METADATA=""
if [ "$KIND" = flatpak ]; then
  [ -d "$OUT/files" ] || fail "flatpak build dir has no files/ directory"
  FLATPAK_METADATA="$OUT/metadata"
  PAYLOAD="$OUT/files"
fi

# ---- layout ----------------------------------------------------------------
ASAR_PATH="$(find "$PAYLOAD" -path '*/resources/app.asar' -print -quit)"
[ -n "$ASAR_PATH" ] || fail "no resources/app.asar found"
RES="$(dirname "$ASAR_PATH")"
APP="$(dirname "$RES")"
EXE="$APP/$EXE_NAME"
[ -f "$EXE" ] && [ -x "$EXE" ] || fail "missing executable $EXE_NAME"
pass "$KIND layout: app root $(basename "$APP"), executable $EXE_NAME present"

for f in "$APP/LICENSE.electron.txt" "$APP/LICENSES.chromium.html" "$RES/LICENSE" "$RES/NOTICE" "$RES/SOURCE.txt"; do
  [ -s "$f" ] || fail "missing or empty: ${f#"$PAYLOAD"/}"
done
pass "Electron LICENSE, LICENSES.chromium.html, our LICENSE, NOTICE and SOURCE.txt are inside"

# ---- provenance -------------------------------------------------------------
SRC="$RES/SOURCE.txt"
if [ -z "$EXPECT_COMMIT" ]; then
  EXPECT_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || fail "cannot determine git HEAD; pass --expect-commit"
fi
UP_COMMIT="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")"
[ -n "$UP_COMMIT" ] || fail "UPSTREAM_COMMIT is empty"
grep -q "$UP_COMMIT" "$SRC" || fail "SOURCE.txt does not name the upstream commit $UP_COMMIT"
grep -Eq 'version: +[0-9]+\.[0-9]+\.[0-9]+' "$SRC" || fail "SOURCE.txt has no Electron version"
[ "$(grep -Ec 'sha256 of .*: [0-9a-f]{64}$' "$SRC")" -ge 2 ] || fail "SOURCE.txt lacks the Electron sha256 lines"
grep -Eq "^  commit: +$EXPECT_COMMIT\$" "$SRC" || fail "SOURCE.txt does not name the built commit $EXPECT_COMMIT (stale or foreign build)"
grep -Fq "$SOURCE_URL" "$SRC" || fail "SOURCE.txt does not name the repository $SOURCE_URL"
grep -Eq '^  release tag: +\S+' "$SRC" || fail "SOURCE.txt has no 'release tag:' line"
grep -q '^  describe: ' "$SRC" || fail "SOURCE.txt has no 'describe:' line"
if grep -q "dirty=no" "$SRC"; then :; elif [ "$ALLOW_DIRTY" = 1 ]; then echo "warn: SOURCE.txt says the tree was dirty (allowed by --allow-dirty)" >&2; else fail "SOURCE.txt says the build tree was dirty"; fi
pass "SOURCE.txt names commit $EXPECT_COMMIT, repository, upstream $UP_COMMIT, Electron version and sha256"

# one marker definition for both gates: check-notice.sh (NEEDS REVIEW / TODO / TBD / UNVERIFIED, any case)
NEEDS_REVIEW="$("$ROOT/packaging/check-notice.sh" "$RES/NOTICE")"
if [ "$RELEASE" = 1 ]; then
  [ "$NEEDS_REVIEW" = 0 ] || fail "release build but NOTICE has $NEEDS_REVIEW unresolved marker line(s) (see packaging/check-notice.sh)"
  grep -Eq '^  release tag: +none' "$SRC" && fail "release build but SOURCE.txt says it was not built from a release tag"
  pass "release: NOTICE has no unresolved lines and SOURCE.txt names a release tag"
else
  echo "note: NOT FOR RELEASE: NOTICE has $NEEDS_REVIEW unresolved marker line(s) (see packaging/check-notice.sh)" >&2
fi

# ---- bundle and asar ----------------------------------------------------------
[ -f "$RES/dist/index.html" ] || fail "offline bundle missing at resources/dist"
[ -s "$RES/dist/SOURCE.txt" ] || fail "bundle SOURCE.txt missing"
[ "$(stat -c %s "$ASAR_PATH")" -lt 5000000 ] || fail "app.asar is suspiciously large: the bundle must stay outside it"
pass "offline bundle is an extraResource outside app.asar; app.asar is $(stat -c %s "$ASAR_PATH") bytes"

ASAR="$ROOT/desktop/node_modules/.bin/asar"
[ -x "$ASAR" ] || fail "asar tool missing (run npm ci in desktop/)"
"$ASAR" extract "$ASAR_PATH" "$WORK/asar"
for f in src/main.js src/menu.js src/argv-policy.js src/test-mode.js src/open-file.js brand.json; do
  [ -s "$WORK/asar/$f" ] || fail "app.asar lacks $f"
done
grep -q 'app.isPackaged ? {} : process.env' "$WORK/asar/src/main.js" || fail "main.js does not gate BENTO_* overrides on app.isPackaged"
# process.env: parsed, not grepped. Comments never count; the four known lines must match exactly, so a read
# appended to one of them fails. The same helper RUNS the packaged marker logic and argv policy (see below).
node "$ROOT/desktop/tools/check-asar-policy.js" "$WORK/asar" || fail "process.env is read outside the known guarded lines, or the packaged marker logic / argv policy misbehaves"
pass "BENTO_* overrides are read only through the app.isPackaged guard; packaged marker logic and argv policy behave as designed"

grep -q "'ELECTRON_DISABLE_SANDBOX'" "$WORK/asar/src/main.js" && grep -q "'CHROME_DEVEL_SANDBOX'" "$WORK/asar/src/main.js" || fail "main.js does not refuse to start when ELECTRON_DISABLE_SANDBOX / CHROME_DEVEL_SANDBOX is set"
grep -q 'app.exit(2)' "$WORK/asar/src/main.js" || fail "main.js has no exit-2 refusal"
grep -q "require('./argv-policy')" "$WORK/asar/src/main.js" || fail "main.js does not load the argv policy"
grep -qF 'unsafeSwitches(process.argv, process.env, policyOptions)' "$WORK/asar/src/main.js" || fail "main.js does not check its own argv"
grep -qF 'unsafeSwitches(argv, process.env, { ...policyOptions, secondInstance: true })' "$WORK/asar/src/main.js" || fail "main.js does not check second-instance argv"
grep -qF 'packaged: app.isPackaged, testMarker: app.isPackaged && hasTestMarker(process.resourcesPath)' "$WORK/asar/src/main.js" || fail "main.js does not gate packaged test mode on the marker file"
# The marker logic itself, as text (the helper above also runs it): each control must still be spelled out in test-mode.js,
# the argv policy must require the marker for packaged builds, and main.js must feed it the marker result.
for needle in 'fsImpl.constants.O_NOFOLLOW' 'fsImpl.fstatSync(fd)' '!st.isFile()' 'st.nlink !== 1' 'st.uid !== uid' '(st.mode & 0o022) !== 0' 'st.size !== MARKER_CONTENT.length' '=== MARKER_CONTENT' 'fsImpl.realpathSync(resourcesPath) !== path.resolve(resourcesPath)' "typeof uid !== 'number'"; do
  grep -qF -- "$needle" "$WORK/asar/src/test-mode.js" || fail "test-mode.js lost the marker control: $needle"
done
grep -qF "const MARKER_CONTENT = 'bento-test-mode-v1\\n';" "$WORK/asar/src/test-mode.js" || fail "test-mode.js marker token changed"
grep -qF "(!packaged || testMarker === true)" "$WORK/asar/src/argv-policy.js" || fail "argv-policy.js does not require testMarker === true for a packaged build"
pass "test-mode.js carries every marker control (O_NOFOLLOW, fstat, regular file, nlink, owner, mode, size, token, realpath); argv policy requires testMarker === true"
grep -q '%PDF-' "$WORK/asar/src/open-file.js" || fail "open-file.js does not check the %PDF- header"
grep -q 'realpath' "$WORK/asar/src/open-file.js" || fail "open-file.js does not resolve symlinks"
pass "argv policy (own and second-instance argv) and open-with header/symlink checks are present"

grep -q 'ABSOLUTELY NO WARRANTY' "$WORK/asar/src/menu.js" || fail "About text lacks the no-warranty line"
grep -q 'AGPL-3.0-only' "$WORK/asar/src/menu.js" || fail "About text lacks the AGPL notice"
grep -q 'brand.sourceUrl' "$WORK/asar/src/menu.js" || fail "About text does not offer the source URL"
grep -Fq "$SOURCE_URL" "$WORK/asar/brand.json" || fail "packaged brand.json lacks the source URL"
grep -Fq "$APP_ID" "$WORK/asar/brand.json" || fail "packaged brand.json lacks the app id"
pass "About dialog carries the AGPL notice, no-warranty line and the corresponding-source URL"

FORBIDDEN='--no-sandbox|--disable-web-security|--remote-debugging|--inspect|--enable-logging|--disable-gpu-sandbox|--disable-setuid-sandbox|--auto-open-devtools'
if grep -rEn -- "$FORBIDDEN" "$WORK/asar"; then
  fail "forbidden flag inside app.asar"
fi
SCANNED=0
while IFS= read -r f; do
  SCANNED=$((SCANNED + 1))
  if grep -En -- "$FORBIDDEN" "$f"; then fail "forbidden flag in ${f#"$OUT"/}"; fi
done < <(find "$PAYLOAD" -type f \( -name '*.desktop' -o -name AppRun -o -name '*.sh' -o -name "$EXE_NAME" -path '*/bin/*' \) -not -path '*/resources/dist/*' 2>/dev/null)
[ "$SCANNED" -gt 0 ] || fail "found no desktop entry or launcher to scan for forbidden flags"
if [ -d "$SCRIPTS" ] && [ -n "$(ls -A "$SCRIPTS")" ]; then
  if grep -rEn -- "$FORBIDDEN" "$SCRIPTS"; then fail "forbidden flag in a maintainer script"; fi
fi
pass "no sandbox-off / devtools / inspect flags in app code, $SCANNED desktop entries or launchers, or maintainer scripts"

# A release artifact must never carry the packaged test-mode marker (desktop/src/test-mode.js), anywhere in the tree.
MARKERS="$(find "$OUT" -name .bento-test-mode -print 2>/dev/null | head -3)"
[ -z "$MARKERS" ] || { printf '%s\n' "$MARKERS" >&2; fail "the test-mode marker .bento-test-mode is present in the artifact"; }
pass "no .bento-test-mode marker anywhere in the artifact"

# ---- desktop entries ----------------------------------------------------------
DESKTOPS=0
while IFS= read -r d; do
  DESKTOPS=$((DESKTOPS + 1))
  grep -q '^MimeType=.*application/pdf' "$d" || fail "${d#"$OUT"/}: no MimeType=application/pdf"
  grep -Eq '^Exec=.* %f$' "$d" || fail "${d#"$OUT"/}: Exec does not end in %f"
  grep -q '^Categories=Office;Utility;' "$d" || fail "${d#"$OUT"/}: Categories is not Office;Utility;"
  grep -qx "StartupWMClass=$APP_ID" "$d" || fail "${d#"$OUT"/}: StartupWMClass is not $APP_ID"
  if [ "$KIND" = appimage ]; then LAUNCH="AppRun"; else LAUNCH="$EXE_NAME"; fi
  grep -q "^Exec=.*$LAUNCH" "$d" || fail "${d#"$OUT"/}: Exec does not start $LAUNCH"
  if grep -Eq -- '--no-sandbox|--disable-setuid-sandbox' "$d"; then fail "${d#"$OUT"/}: sandbox-off flag in Exec"; fi
done < <(find "$PAYLOAD" -name '*.desktop' -not -path '*/resources/dist/*')
[ "$DESKTOPS" -gt 0 ] || fail "no .desktop file in the artifact"
pass "$DESKTOPS desktop entry(ies): PDF MIME type, Exec ... %f, Office;Utility, StartupWMClass"

# Every launcher must unset all of these; the list is the policy (docs/desktop-linux.md).
UNSET_VARS="ELECTRON_DISABLE_SANDBOX CHROME_DEVEL_SANDBOX ELECTRON_EXTRA_LAUNCH_ARGS ELECTRON_ENABLE_LOGGING ELECTRON_RUN_AS_NODE NODE_OPTIONS BENTO_TEST_HEADLESS BENTO_DIST BENTO_TRANSPORT"
check_unset() { # file label
  local line v
  line="$(grep -m1 '^unset ' "$1")" || fail "$2 has no unset line"
  for v in $UNSET_VARS; do [[ " $line " == *" $v "* ]] || fail "$2 does not unset $v"; done
}

# ---- launchers and install scripts ----------------------------------------------
case "$KIND" in
  appimage)
    [ -s "$OUT/AppRun" ] || fail "AppImage has no AppRun"
    grep -q '^refuse()' "$OUT/AppRun" || fail "AppImage does not use the hardened AppRun"
    grep -q 'NO_SANDBOX' "$OUT/AppRun" && fail "AppRun still contains the --no-sandbox fallback"
    check_unset "$OUT/AppRun" "AppRun"
    grep -q "exec \"\$HERE/$EXE_NAME\"" "$OUT/AppRun" || fail "AppRun does not exec $EXE_NAME"
    pass "AppImage uses the hardened AppRun (refuses without sandbox, unsets dangerous env)" ;;
  deb|rpm)
    if [ "$KIND" = deb ]; then POST="$SCRIPTS/postinst"; else POST="$SCRIPTS/rpm-scripts.txt"; fi
    [ -s "$POST" ] || fail "missing or empty maintainer script ${POST#"$WORK"/}"
    grep -q 'setpriv --reuid=65534' "$POST" || fail "post-install does not probe user namespaces as an unprivileged user"
    grep -q 'apparmor_restrict_unprivileged_userns' "$POST" || fail "post-install does not look at the AppArmor userns restriction"
    grep -q 'chmod 4755' "$POST" || fail "post-install has no setuid fallback for the sandbox helper"
    grep -q 'chmod 0755' "$POST" || fail "post-install does not reset the sandbox helper to 0755 first"
    pass "post-install: non-root userns probe, AppArmor-aware, setuid helper only as fallback"
    # deb/rpm launchers start the binary directly, with NO env scrub. For these the only defence for the packaged
    # test mode is that the install tree is root-owned (a user cannot create the marker in it): see docs/desktop-linux.md.
    if [ -z "$TREE" ]; then
      if [ "$KIND" = deb ]; then NOT_ROOT="$(dpkg-deb -c "$ART" | awk '$2 != "root/root"' | wc -l)"; else NOT_ROOT="$(rpm -qp --queryformat '[%{FILEUSERNAME}:%{FILEGROUPNAME}\n]' "$ART" | grep -vxc 'root:root' || true)"; fi
      [ "$NOT_ROOT" = 0 ] || fail "$NOT_ROOT package entr(ies) not owned by root:root (the root-owned install tree is the only marker defence for $KIND)"
      pass "$KIND payload: every entry owned by root:root, so no unprivileged user can plant the test-mode marker"
    fi ;;
  flatpak)
    L="$PAYLOAD/bin/$EXE_NAME"
    [ -s "$L" ] || fail "flatpak launcher bin/$EXE_NAME missing"
    check_unset "$L" "flatpak launcher"
    grep -q '^exec zypak-wrapper ' "$L" || fail "flatpak launcher does not use zypak-wrapper"
    [ -s "$FLATPAK_METADATA" ] || fail "flatpak metadata missing"
    sockets="$(sed -n 's/^sockets=//p' "$FLATPAK_METADATA")"
    shared="$(sed -n 's/^shared=//p' "$FLATPAK_METADATA")"
    [[ ";$sockets" == *";!x11;"* ]] || fail "flatpak metadata does not remove the x11 socket (--nosocket=x11): sockets=$sockets"
    [[ ";$sockets" != *";x11;"* ]] || fail "flatpak metadata grants the plain x11 socket: sockets=$sockets"
    [[ ";$shared" != *";network;"* ]] || fail "flatpak metadata grants network"
    grep -q '^filesystems=' "$FLATPAK_METADATA" && fail "flatpak metadata grants filesystem access"
    grep -Eq '^devices=.*all' "$FLATPAK_METADATA" && fail "flatpak metadata grants all devices"
    pass "flatpak: launcher unsets dangerous env; sockets=$sockets, no network, no filesystem" ;;
esac

# ---- file modes ---------------------------------------------------------------------
WRITABLE="$(find "$PAYLOAD" ! -type l \( -perm -g+w -o -perm -o+w \) | wc -l)"
[ "$WRITABLE" = 0 ] || { find "$PAYLOAD" ! -type l \( -perm -g+w -o -perm -o+w \) | head -5 >&2; fail "$WRITABLE group/world-writable file(s) or director(ies) in the payload"; }
SETID="$(find "$PAYLOAD" ! -type l -perm /6000 | wc -l)"
[ "$SETID" = 0 ] || { find "$PAYLOAD" ! -type l -perm /6000 | head -5 >&2; fail "$SETID setuid/setgid entr(ies) in the payload (the sandbox helper is made setuid only by the post-install script)"; }
if [ "$KIND" = flatpak ]; then
  [ -z "$(find "$PAYLOAD" -name chrome-sandbox -print -quit)" ] || fail "flatpak payload contains chrome-sandbox (zypak is the sandbox there)"
else
  [ -f "$APP/chrome-sandbox" ] || fail "payload has no chrome-sandbox helper"
  [ "$(stat -c %a "$APP/chrome-sandbox")" = 755 ] || fail "chrome-sandbox payload mode is $(stat -c %a "$APP/chrome-sandbox"), want 755"
fi
pass "modes: 0 group/world-writable, 0 setuid/setgid; chrome-sandbox $([ "$KIND" = flatpak ] && echo absent || echo 0755 in the payload)"

# The package's own file listing is checked too: extraction applies the umask and can hide modes.
if [ -z "$TREE" ] && { [ "$KIND" = deb ] || [ "$KIND" = rpm ]; }; then
  if [ "$KIND" = deb ]; then dpkg-deb -c "$ART" > "$WORK/listing.txt"; else rpm -qp --queryformat '[%{FILEMODES:perms} %{FILENAMES}\n]' "$ART" > "$WORK/listing.txt"; fi
  [ -s "$WORK/listing.txt" ] || fail "empty package file listing"
  if [ "$KIND" = deb ]; then PKG="$(dpkg-deb -f "$ART" Package)"; else PKG="$(rpm -qp --qf '%{NAME}' "$ART")"; fi
  [ "$PKG" = "$EXE_NAME" ] || fail "package name is '$PKG', want $EXE_NAME (brand.json)"
  BAD="$(awk '$1 !~ /^l/ && (substr($1,6,1)=="w" || substr($1,9,1)=="w" || substr($1,4,1) ~ /[sS]/ || substr($1,7,1) ~ /[sS]/) {n++} END {print n+0}' "$WORK/listing.txt")"
  [ "$BAD" = 0 ] || fail "package listing has $BAD group/world-writable or setuid/setgid entr(ies)"
  pass "package listing ($(wc -l < "$WORK/listing.txt") entries): no group/world-writable, setuid or setgid modes"
fi

# ---- fuses ------------------------------------------------------------------------------
node "$ROOT/desktop/tools/check-fuses.js" "$EXE" >"$WORK/fuses.txt" || { cat "$WORK/fuses.txt"; fail "fuse state mismatch"; }
[ "$(grep -c '^ok' "$WORK/fuses.txt")" -ge 7 ] || fail "fewer than 7 fuses were checked"
pass "Electron fuses: $(grep -c '^ok' "$WORK/fuses.txt") of $(wc -l < "$WORK/fuses.txt") as required"
echo "VERIFIED: $ART ($KIND)"
