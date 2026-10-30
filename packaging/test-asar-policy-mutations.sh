#!/usr/bin/env bash
# Linux-runnable red/green test of tools/check-asar-policy.js (the behavioural half of the Windows gate): src/ made
# into a smoke tree and a release tree (desktop/flavours/, as electron-builder packs them) must pass, and every
# mutation in asar-policy-mutations.sh must make the check FAIL.
# Needs desktop/node_modules (espree). Does not touch the real tree: it works on a copy in a mktemp dir.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=packaging/asar-policy-mutations.sh
. "$ROOT/packaging/asar-policy-mutations.sh"
T="$(mktemp -d)"
trap 'rm -r "$T"' EXIT
CHECK="${CHECK:-$ROOT/desktop/tools/check-asar-policy.js}"
# espree resolves from the checker's own location (desktop/), the checked tree is just data.
run() { node "$CHECK" --flavour "$1" "$2" >"$T/out" 2>&1; }

for f in smoke release; do
  mkdir "$T/$f"
  cp -a "$ROOT/desktop/src" "$T/$f/src"
  cp "$ROOT/desktop/flavours/$f/"*.js "$T/$f/src/"
  run "$f" "$T/$f" || { cat "$T/out" >&2; echo "positive control FAILED: the unmutated $f tree must pass" >&2; exit 1; }
  echo "positive control: unmutated $f tree passes"
done

caught=0 missed=0
try() { # flavour entry
  local name file expr
  IFS='|' read -r name file expr <<<"$2"
  [ ! -e "$T/work" ] || rm -r "$T/work"
  cp -a "$T/$1" "$T/work"
  apply_policy_mutation "$T/work/src" "$file" "$expr" || exit 2
  if run "$1" "$T/work"; then missed=$((missed + 1)); echo "MISSED $name"; else caught=$((caught + 1)); echo "caught $name: $(grep -m1 '^FAIL' "$T/out" | cut -c1-90)"; fi
}
for entry in "${POLICY_MUTATIONS[@]}"; do try smoke "$entry"; done
for entry in "${RELEASE_MUTATIONS[@]}"; do try release "$entry"; done
echo "asar-policy mutation test: $caught caught, $missed missed"
[ "$missed" = 0 ]
