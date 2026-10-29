#!/usr/bin/env bash
# Mutation test for check-notice.sh: every unresolved-marker spelling must fail --release.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -r "$T"' EXIT
FAILED=0
expect() { # name expected-exit text
  local f="$T/NOTICE" got=0
  printf 'clean line\n%s\n' "$3" > "$f"
  "$HERE/check-notice.sh" --release "$f" >/dev/null 2>&1 || got=$?
  if [ "$got" = "$2" ]; then echo "ok:   $1"; else echo "FAIL: $1 (exit $got, wanted $2)" >&2; FAILED=1; fi
}
expect "clean NOTICE passes" 0 "ffmpeg: LGPL-2.1, verified"
expect "NEEDS REVIEW fails" 1 "foo: NEEDS REVIEW"
expect "lowercase 'needs review' fails" 1 "foo: needs review"
expect "mixed case 'Needs Review' fails" 1 "foo: Needs Review"
expect "TODO fails" 1 "foo: TODO licence"
expect "tbd fails" 1 "foo: tbd"
expect "UNVERIFIED fails" 1 "foo: Unverified"
expect "lowercase todo fails" 1 "foo: todo"
expect "TBD fails" 1 "foo: TBD"
expect "needs-review spelling fails" 1 "foo: needs-review"
expect "NEEDS_REVIEW spelling fails" 1 "foo: NEEDS_REVIEW"
# the release gate must use this script's marker definition, not its own
if grep -q 'check-notice.sh' "$HERE/verify-artifact.sh" && ! grep -Eq "grep.*'NEEDS REVIEW'" "$HERE/verify-artifact.sh"; then
  echo "ok:   verify-artifact.sh delegates to check-notice.sh"
else
  echo "FAIL: verify-artifact.sh has its own marker definition" >&2; FAILED=1
fi
exit "$FAILED"
