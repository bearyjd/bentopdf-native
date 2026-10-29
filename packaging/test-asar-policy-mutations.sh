#!/usr/bin/env bash
# Linux-runnable red/green test of tools/check-asar-policy.js (the behavioural half of the Windows gate): the
# unmutated src/ must pass, and every mutation in asar-policy-mutations.sh must make the check FAIL.
# Needs desktop/node_modules (espree). Does not touch the real tree: it works on a copy in a mktemp dir.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=packaging/asar-policy-mutations.sh
. "$ROOT/packaging/asar-policy-mutations.sh"
T="$(mktemp -d)"
trap 'rm -r "$T"' EXIT
CHECK="${CHECK:-$ROOT/desktop/tools/check-asar-policy.js}"
# espree resolves from the checker's own location (desktop/), the checked tree is just data.
run() { node "$CHECK" "$1" >"$T/out" 2>&1; }

mkdir "$T/base"
cp -a "$ROOT/desktop/src" "$T/base/src"
run "$T/base" || { cat "$T/out" >&2; echo "positive control FAILED: the unmutated src must pass" >&2; exit 1; }
echo "positive control: unmutated src passes"

caught=0 missed=0
for entry in "${POLICY_MUTATIONS[@]}"; do
  IFS='|' read -r name file expr <<<"$entry"
  [ ! -e "$T/work" ] || rm -r "$T/work"
  cp -a "$T/base" "$T/work"
  sed -i "$expr" "$T/work/src/$file"
  grep -q 'MUTATED' "$T/work/src/$file" || { echo "mutation '$name' did not change $file" >&2; exit 2; }
  node --check "$T/work/src/$file" || { echo "mutation '$name' is not valid JavaScript (it would be caught for the wrong reason)" >&2; exit 2; }
  if run "$T/work"; then missed=$((missed + 1)); echo "MISSED $name"; else caught=$((caught + 1)); echo "caught $name: $(grep -m1 '^FAIL' "$T/out" | cut -c1-90)"; fi
done
echo "asar-policy mutation test: $caught caught, $missed missed"
[ "$missed" = 0 ]
