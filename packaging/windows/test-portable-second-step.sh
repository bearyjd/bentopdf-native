#!/usr/bin/env bash
# Linux-runnable test of portable-second-step.sh with fake commands: 3 is the only non-zero code that keeps the
# step green and it must say "KNOWN FAILURE #11"; every other outcome must be red and must NOT say it.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STEP="$HERE/portable-second-step.sh"
TMP="$(mktemp -d)"
trap 'rm -r "$TMP"' EXIT
fail=0
expect() { # description wanted-exit wanted-summary-regex forbidden-summary-regex command...
  local what="$1" want="$2" yes="$3" no="$4"; shift 4
  : > "$TMP/summary"
  GITHUB_STEP_SUMMARY="$TMP/summary" bash "$STEP" "$@" >"$TMP/out" 2>&1
  local rc=$?
  if [ "$rc" != "$want" ] || ! grep -Eq "$yes" "$TMP/summary" || { [ -n "$no" ] && grep -Eq "$no" "$TMP/summary"; }; then
    echo "FAIL $what (exit $rc, wanted $want)"; sed 's/^/     /' "$TMP/summary"; fail=$((fail + 1))
  else
    echo "ok   $what"
  fi
}
expect "exit 0 passes"                          0 'PASSED'              'KNOWN FAILURE|FAILED' bash -c 'exit 0'
expect "exit 3 is the known failure, step green" 0 'KNOWN FAILURE #11'   'FAILED'              bash -c 'exit 3'
expect "exit 1 is red"                          1 'FAILED.*exited 1'    'KNOWN FAILURE'        bash -c 'exit 1'
expect "exit 2 is red"                          1 'FAILED.*exited 2'    'KNOWN FAILURE'        bash -c 'exit 2'
expect "exit 4 is red (not 3)"                  1 'FAILED.*exited 4'    'KNOWN FAILURE'        bash -c 'exit 4'
expect "killed by a signal is red"              1 'FAILED'              'KNOWN FAILURE'        bash -c 'kill -9 $$'
expect "a missing command (127) is red"         1 'FAILED.*exited 127'  'KNOWN FAILURE'        /nonexistent/definitely-not-here
if bash "$STEP" >/dev/null 2>&1; then echo "FAIL no command must not pass"; fail=$((fail + 1)); else echo "ok   no command is an error"; fi
echo "portable-second-step: $fail failure(s)"
[ "$fail" = 0 ]
