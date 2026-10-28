#!/usr/bin/env bash
# Counts unresolved licence lines ("NEEDS REVIEW") in NOTICE.
#   packaging/check-notice.sh            prints the count, exits 0
#   packaging/check-notice.sh --release  exits 1 unless the count is 0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTICE="$ROOT/NOTICE"
[ -s "$NOTICE" ] || { echo "check-notice: NOTICE missing or empty" >&2; exit 2; }
COUNT="$(grep -c 'NEEDS REVIEW' "$NOTICE" || true)"
echo "$COUNT"
if [ "${1:-}" = "--release" ] && [ "$COUNT" != 0 ]; then
  echo "check-notice: NOT FOR RELEASE: NOTICE has $COUNT unresolved NEEDS REVIEW line(s):" >&2
  grep -n 'NEEDS REVIEW' "$NOTICE" >&2
  exit 1
fi
