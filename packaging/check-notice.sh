#!/usr/bin/env bash
# Counts unresolved licence lines in NOTICE: NEEDS REVIEW, TODO, TBD, UNVERIFIED (any case).
#   packaging/check-notice.sh [file]            prints the count, exits 0
#   packaging/check-notice.sh --release [file]  exits 1 unless the count is 0
# `file` defaults to NOTICE at the repository root (a different file is for tests).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE=0
if [ "${1:-}" = "--release" ]; then RELEASE=1; shift; fi
NOTICE="${1:-$ROOT/NOTICE}"
MARKERS='needs[ _-]*review|todo|tbd|unverified'
[ -s "$NOTICE" ] || { echo "check-notice: NOTICE missing or empty" >&2; exit 2; }
COUNT="$(grep -Eic "$MARKERS" "$NOTICE" || true)"
echo "$COUNT"
if [ "$RELEASE" = 1 ] && [ "$COUNT" != 0 ]; then
  echo "check-notice: NOT FOR RELEASE: NOTICE has $COUNT unresolved line(s) (NEEDS REVIEW / TODO / TBD / UNVERIFIED):" >&2
  grep -Ein "$MARKERS" "$NOTICE" >&2
  exit 1
fi
