#!/usr/bin/env bash
# Hard assertions on a built local bundle. Exits non-zero on the first failure.
# Usage: scripts/check-dist.sh [dist-dir]
#  - separately licensed products (hyper-compress-wasm, Kura) must not be present
#  - AGPL source offer files (SOURCE.txt, LICENSE, NOTICE) must be present
#  - generated CSP must not allow any external origin
#  - no bundle path may trip the Windows-unsafe name rules the desktop file server applies on every platform
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${1:-$ROOT/dist}"
die() { echo "CHECK FAILED: $*" >&2; exit 1; }
[ -d "$DIST" ] || die "no such dir: $DIST"

DIST="$(cd "$DIST" && pwd)"   # canonical, so the NOTICE exemption below compares exact paths

# NOTICE legitimately names the excluded products, but only the one at the bundle root: a NOTICE (or any
# other file) deeper in the tree must not. grep exit codes: 0 match, 1 none, >=2 error (not "none").
rc=0; matches="$(grep -ril -- 'hyper-compress-wasm' "$DIST")" || rc=$?
[ "$rc" -le 1 ] || die "grep failed while scanning $DIST"
hits="$(printf '%s\n' "$matches" | awk -v root="$DIST/NOTICE" 'NF && $0 != root')"
[ -z "$hits" ] || die "excluded product 'hyper-compress-wasm' referenced in: $(echo "$hits" | awk 'NR<=5')"

found="$(find "$DIST" \( -iname '*kura*' -o -iname '*hyper-compress*' \) -print)"
[ -z "$found" ] || die "excluded product files present: $(echo "$found" | awk 'NR<=5')"

if [ -f "$DIST/sitemap.xml" ]; then
  rc=0; hits="$(grep -Ein '<loc>[^<]*/(kura|hyper-compress)(\.html)?</loc>' "$DIST/sitemap.xml")" || rc=$?
  [ "$rc" -le 1 ] || die "grep failed on sitemap.xml"
  [ -z "$hits" ] || die "sitemap.xml still lists excluded pages: $(echo "$hits" | awk 'NR<=3')"
fi

for f in SOURCE.txt LICENSE NOTICE; do [ -s "$DIST/$f" ] || die "missing $f in $DIST (AGPL source offer)"; done

if [ -f "$DIST/_headers" ]; then
  rc=0; hits="$(grep -E '^[[:space:]]*Content-Security-Policy:' "$DIST/_headers" | grep -E 'https?:')" || rc=$?
  [ "$rc" -le 1 ] || die "grep failed on _headers"
  [ -z "$hits" ] || die "_headers CSP still allows external origins"
fi
# The desktop file server refuses Windows-unsafe names on every platform: no bundle path may trip them.
command -v node >/dev/null || die "node is required for the bundle path-name check"
node "$ROOT/desktop/tools/check-dist-names.js" "$DIST" >/dev/null || die "a bundle path trips the Windows-unsafe name rules (desktop/tools/check-dist-names.js)"
echo "check-dist: OK ($DIST)"
