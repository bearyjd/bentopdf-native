#!/usr/bin/env bash
# Fails if any symlink in an extracted artifact tree resolves outside that tree (e.g. resources/evil -> /etc/passwd).
#   packaging/check-symlinks.sh <tree>       prints "FAIL: ..." and exits 1; prints the link count on success
# Relative links that stay inside the tree pass. Absolute links never do: in an extracted tree they resolve on the
# host, and after install they would point wherever the host puts them. Dangling links inside the tree pass.
set -euo pipefail
TREE="${1:?usage: check-symlinks.sh <tree>}"
[ -d "$TREE" ] || { echo "FAIL: no such directory: $TREE" >&2; exit 1; }
ROOT="$(readlink -f "$TREE")"
COUNT=0 BAD=0
while IFS= read -r -d '' l; do
  COUNT=$((COUNT + 1))
  target="$(readlink "$l")"
  case "$target" in
    /*) : ;; # absolute: always an escape
    *)
      resolved="$(readlink -m -- "$(dirname "$l")/$target")"
      if [ "$resolved" = "$ROOT" ] || [[ "$resolved" == "$ROOT"/* ]]; then continue; fi ;;
  esac
  echo "symlink escapes the tree: ${l#"$ROOT"/} -> $target" >&2
  BAD=$((BAD + 1))
done < <(find "$ROOT" -type l -print0)
[ "$BAD" = 0 ] || { echo "FAIL: $BAD symlink(s) resolve outside the artifact tree" >&2; exit 1; }
echo "$COUNT"
