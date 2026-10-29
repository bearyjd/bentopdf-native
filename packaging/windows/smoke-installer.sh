#!/usr/bin/env bash
# Windows lifecycle smoke test, for a CI runner (Git Bash on windows-latest). It INSTALLS, runs and
# UNINSTALLS the real artifacts on the machine it runs on: do not run it on a workstation.
#
#   packaging/windows/smoke-installer.sh <setup.exe> <portable.exe> [--expect-commit SHA] [--release]
#   packaging/windows/smoke-installer.sh --portable-second-instance <portable.exe>
#
# Steps: silent per-user install to a temp dir that already holds a canary file; assert files, shortcuts (no sandbox flags), registry
# (ProgID + OpenWithProgids only, the .pdf default untouched); run the release gate on the installed
# tree (no marker yet); run the headless packaged smoke test, which proves the copy refuses test mode without
# the marker, then creates the test-mode marker in this disposable installed copy only and removes it again;
# assert the marker is gone; silent uninstall; assert the app files, shortcuts and keys are gone and the canary survived; then the portable exe:
# the checks that need no test mode (its stub wipes the extraction directory, so no marker can be placed) and
# no registry/shortcut traces. Every check runs; the exit status is non-zero if any failed. Results are also
# appended to $GITHUB_STEP_SUMMARY when set.
# --portable-second-instance runs only the portable second-instance part (a KNOWN FAILURE, issue #11; the
# workflow runs it through portable-second-step.sh: exit 3 = the known #11 signature, anything else is red).
set -uo pipefail

# Git Bash would rewrite /S, /D=... and registry switches as if they were POSIX paths.
export MSYS2_ARG_CONV_EXCL='*'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "${1:-}" = --portable-second-instance ]; then
  PORTABLE="${2:?usage: smoke-installer.sh --portable-second-instance <portable.exe>}"
  node "$(cygpath -m "$ROOT/desktop/test/packaged-smoke-win.js")" "$(cygpath -w "$PORTABLE")" --portable --mode second-instance-only
  exit $?
fi
SETUP="${1:?usage: smoke-installer.sh <setup.exe> <portable.exe> [--expect-commit SHA] [--release]}"
PORTABLE="${2:?usage: smoke-installer.sh <setup.exe> <portable.exe>}"
shift 2
GATE_ARGS=("$@")
# Git for Windows is a native program: give it a Windows path (arguments are not converted, see above).
HEAD_COMMIT="$(git -C "$(cygpath -m "$ROOT")" rev-parse HEAD)"
win() { cygpath -w "$1"; }
native() { cygpath -m "$1"; }

PRODUCT="$(node -p "require(process.argv[1]).productName" "$(native "$ROOT/desktop/brand.json")")"
APP_ID="$(node -p "require(process.argv[1]).appId" "$(native "$ROOT/desktop/brand.json")")"
# Under RUNNER_TEMP when set: its path has no 8.3 short names, which the installer-written shortcut targets would not match.
if [ -n "${RUNNER_TEMP:-}" ]; then TMPROOT="$(mktemp -d -p "$(cygpath -u "$RUNNER_TEMP")")"; else TMPROOT="$(mktemp -d)"; fi
INSTALL_DIR="$TMPROOT/install dir"
EXE="$INSTALL_DIR/$PRODUCT.exe"
UNINSTALLER="$INSTALL_DIR/Uninstall $PRODUCT.exe"
DESKTOP_LNK="$(cygpath -u "$USERPROFILE")/Desktop/$PRODUCT.lnk"
START_LNK="$(cygpath -u "$APPDATA")/Microsoft/Windows/Start Menu/Programs/$PRODUCT.lnk"
PROGID_KEY="HKCU\\Software\\Classes\\$APP_ID.pdf"
OPENWITH_KEY='HKCU\Software\Classes\.pdf\OpenWithProgids'
UNINSTALL_ROOT='HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall'

FAILED=0
note() { echo "$*"; [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$*" >> "$GITHUB_STEP_SUMMARY"; }
check() { # description command...
  local what="$1"; shift
  if "$@" >"$TMPROOT/check.out" 2>&1; then note "ok   $what"; else note "FAIL $what"; sed "s/^/       /" "$TMPROOT/check.out" | tail -8 >&2; FAILED=$((FAILED + 1)); fi
}
absent() { ! "$@"; }
exists() { [ -e "$1" ]; }
reg_key() { reg query "$1"; }
reg_value() { reg query "$1" /v "$2"; }
uninstall_entry() { reg query "$UNINSTALL_ROOT" /s /f "$PRODUCT" /d | grep -q "DisplayName"; }
pdf_default() { # the DEFAULT value of HKCU\Software\Classes\.pdf ("none" when the key is missing or has no default value)
  powershell.exe -NoProfile -Command "\$k = Get-Item -LiteralPath 'HKCU:\Software\Classes\.pdf' -ErrorAction SilentlyContinue; if (\$k -and \$k.GetValue('')) { '[' + \$k.GetValue('') + ']' } else { 'none' }" | tr -d '\r'
}
lnk_field() { # file field
  powershell.exe -NoProfile -Command "(New-Object -ComObject WScript.Shell).CreateShortcut('$(win "$1")').$2" | tr -d '\r'
}
lnk_clean() { # file: target is the installed exe, arguments contain no sandbox/devtools switch
  local target args want
  target="$(lnk_field "$1" TargetPath)"; args="$(lnk_field "$1" Arguments)"; want="$(win "$EXE")"
  echo "  shortcut $(basename "$1"): target=[$target] arguments=[$args] expected target=[$want]" >&2
  [ "${target,,}" = "${want,,}" ] && ! printf '%s' "$args" | grep -Eq -- '--no-sandbox|--disable|--remote-debugging|--inspect'
}
command_line_clean() { # the shell\open\command default value runs the installed exe with "%1" only
  reg query "$PROGID_KEY\\shell\\open\\command" /ve | tr -d '\r' | grep -F "$(win "$EXE")" | grep -F '"%1"' | grep -vq -- '--'
}

note "### Windows lifecycle smoke ($(date -u +%FT%TZ))"
DEFAULT_BEFORE="$(pdf_default)"
note "HKCU .pdf default before install: $(echo "$DEFAULT_BEFORE" | tr '\n' ' ')"
check "ProgID key absent before install" absent reg_key "$PROGID_KEY"

# ---- install ------------------------------------------------------------------------------------
# CANARY: the install directory is user-chosen and already holds foreign files. The uninstaller must remove the
# app's files and leave these alone (electron-builder's default `RMDir /r $INSTDIR` would delete them: see installer.nsh).
mkdir -p "$INSTALL_DIR/foreign"
printf 'canary\n' > "$INSTALL_DIR/canary.txt"
printf 'canary\n' > "$INSTALL_DIR/foreign/keep.txt"
"$SETUP" /S "/D=$(win "$INSTALL_DIR")" >"$TMPROOT/install.log" 2>&1
note "installer exit status: $?"
for _ in $(seq 1 60); do [ -s "$EXE" ] && break; sleep 2; done
check "installed executable exists" exists "$EXE"
check "uninstaller exists" exists "$UNINSTALLER"
check "uninstall registry entry exists (per-user, HKCU)" uninstall_entry
check "desktop shortcut exists" exists "$DESKTOP_LNK"
check "start menu shortcut exists" exists "$START_LNK"
check "desktop shortcut: target is the installed exe, no sandbox/devtools arguments" lnk_clean "$DESKTOP_LNK"
check "start menu shortcut: target is the installed exe, no sandbox/devtools arguments" lnk_clean "$START_LNK"
check "OpenWithProgids registers $APP_ID.pdf" reg_value "$OPENWITH_KEY" "$APP_ID.pdf"
check "ProgID shell\\open\\command runs the installed exe with \"%1\" only" command_line_clean
if [ "$(pdf_default)" = "$DEFAULT_BEFORE" ]; then note "ok   the HKCU .pdf default value was left untouched"; else note "FAIL the HKCU .pdf default value changed: $(pdf_default)"; FAILED=$((FAILED + 1)); fi

# ---- gate and smoke on the installed tree ---------------------------------------------------------
check "release gate on the installed tree" bash "$ROOT/packaging/verify-artifact-win.sh" --expect-commit "$HEAD_COMMIT" "${GATE_ARGS[@]}" --tree "$INSTALL_DIR" --kind installed
note "--- packaged smoke (installed app)"
if node "$(native "$ROOT/desktop/test/packaged-smoke-win.js")" "$(win "$EXE")" | tee "$TMPROOT/smoke-installed.log"; then note "ok   packaged smoke (installed)"; else note "FAIL packaged smoke (installed)"; FAILED=$((FAILED + 1)); fi
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || { echo '```'; cat "$TMPROOT/smoke-installed.log"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
check "the test-mode marker is gone from the installed tree before uninstall" absent exists "$INSTALL_DIR/resources/.bento-test-mode"

# ---- uninstall --------------------------------------------------------------------------------------
# The uninstaller copies itself to %TEMP% and re-launches, so the process we start returns early: poll.
"$UNINSTALLER" /S >"$TMPROOT/uninstall.log" 2>&1
for _ in $(seq 1 90); do [ ! -e "$EXE" ] && ! uninstall_entry && break; sleep 2; done
check "executable removed by the uninstaller" absent exists "$EXE"
check "no application files left in the install directory (only the canaries)" bash -c '[ ! -d "$1" ] || [ -z "$(find "$1" -type f ! -path "$1/canary.txt" ! -path "$1/foreign/keep.txt" | head -n1)" ]' _ "$INSTALL_DIR"
check "canary file survived the uninstall (the uninstaller removes only its own files)" bash -c '[ "$(cat "$1/canary.txt")" = canary ] && [ "$(cat "$1/foreign/keep.txt")" = canary ]' _ "$INSTALL_DIR"
check "uninstall registry entry removed" absent uninstall_entry
check "desktop shortcut removed" absent exists "$DESKTOP_LNK"
check "start menu shortcut removed" absent exists "$START_LNK"
check "ProgID key removed" absent reg_key "$PROGID_KEY"
check "OpenWithProgids value removed" absent reg_value "$OPENWITH_KEY" "$APP_ID.pdf"
if [ "$(pdf_default)" = "$DEFAULT_BEFORE" ]; then note "ok   the HKCU .pdf default value is the same after uninstall"; else note "FAIL the HKCU .pdf default value differs after uninstall: $(pdf_default)"; FAILED=$((FAILED + 1)); fi

# ---- portable ----------------------------------------------------------------------------------------
PORT_DIR="$TMPROOT/portable"
mkdir -p "$PORT_DIR"
cp "$PORTABLE" "$PORT_DIR/portable.exe"
note "--- packaged smoke (portable exe)"
if node "$(native "$ROOT/desktop/test/packaged-smoke-win.js")" "$(win "$PORT_DIR/portable.exe")" --portable --mode no-second-instance | tee "$TMPROOT/smoke-portable.log"; then note "ok   packaged smoke (portable)"; else note "FAIL packaged smoke (portable)"; FAILED=$((FAILED + 1)); fi
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || { echo '```'; cat "$TMPROOT/smoke-portable.log"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
check "portable run left no ProgID key" absent reg_key "$PROGID_KEY"
check "portable run left no shortcut" absent exists "$DESKTOP_LNK"
check "portable run left no uninstall entry" absent uninstall_entry

note "lifecycle smoke: $FAILED failed check(s)"
[ "$FAILED" = 0 ]
