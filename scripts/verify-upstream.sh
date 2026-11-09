#!/usr/bin/env bash
# Gate: the upstream checkout is exactly UPSTREAM_COMMIT plus patches/*.patch, and nothing else.
# Usage: scripts/verify-upstream.sh <upstream-dir>
# Runs after fetch-upstream.sh AND on every build, including SKIP_FETCH=true, because a reused
# ./upstream is untrusted input: it may be at another commit, hand-edited, or carry planted files.
#  1. HEAD resolves to the commit pinned in UPSTREAM_COMMIT
#  2. no tracked file is hidden from git (assume-unchanged / skip-worktree)
#  3. every modified / untracked path is a path some patch touches. Ignore rules are NOT honoured:
#     core.excludesFile is neutralised, .gitignore / .git/info/exclude are not consulted
#     (untracked files come from "git ls-files --others" without --exclude-standard), and any
#     .env* file is refused outright.
#  4. each of those paths has the content and exec bit of "pristine commit + patches" (rebuilt in a temp dir)
# Out of scope, and NOT verified here: the top-level node_modules/ and dist/ directories. "npm ci" rebuilds
# node_modules and "npm run build" rebuilds dist ONLY when they run; with SKIP_INSTALL=true (build-local.sh)
# a pre-existing node_modules is used as-is, unverified, and so is anything the build reads from it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "UPSTREAM CHECK FAILED: $*" >&2; exit 1; }
UP="${1:-}"
[ -n "$UP" ] || die "usage: verify-upstream.sh <upstream-dir>"
[ -d "$UP/.git" ] || die "$UP is not a git checkout"
UP="$(cd "$UP" && pwd)"
COMMIT="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "UPSTREAM_COMMIT must be a 40-char lowercase hex sha"
g() { git -C "$UP" -c core.excludesFile=/dev/null "$@"; }

got="$(g rev-parse 'HEAD^{commit}')"
[ "$got" = "$COMMIT" ] || die "$UP is at $got, expected $COMMIT (UPSTREAM_COMMIT)"

hidden="$(g ls-files -v | awk '/^[a-zS]/ {print substr($0, 3)}')"
[ -z "$hidden" ] || die "tracked files hidden from git status (assume-unchanged/skip-worktree): $(echo "$hidden" | awk 'NR<=3')"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
shopt -s nullglob
patches=("$ROOT"/patches/*.patch)

# Paths the patches touch (NUL-separated numstat; a rename has an empty path field then old, new).
: > "$T/expected"
for p in "${patches[@]}"; do
  git apply --numstat -z "$p" > "$T/numstat" || die "cannot read $(basename "$p")"
  while IFS= read -r -d '' rec; do
    path="${rec#*$'\t'}"; path="${path#*$'\t'}"
    if [ -z "$path" ]; then
      IFS= read -r -d '' old; IFS= read -r -d '' new
      printf '%s\n%s\n' "$old" "$new" >> "$T/expected"
    else
      printf '%s\n' "$path" >> "$T/expected"
    fi
  done < "$T/numstat"
done
sort -u -o "$T/expected" "$T/expected"

# Paths that differ from the commit: tracked changes plus ALL untracked files (no ignore rules applied;
# only the top-level node_modules/ and dist/ are skipped, see the header).
: > "$T/changed"
g diff --no-renames --name-only -z HEAD -- > "$T/tracked"
g ls-files --others -z -- . ':(exclude,top)node_modules' ':(exclude,top)dist' > "$T/untracked"
while IFS= read -r -d '' path; do printf '%s\n' "$path" >> "$T/changed"; done < "$T/tracked"
while IFS= read -r -d '' path; do
  case "${path##*/}" in .env*) die "$UP contains an environment file ($path); refusing" ;; esac
  printf '%s\n' "$path" >> "$T/changed"
done < "$T/untracked"
sort -u -o "$T/changed" "$T/changed"

stray="$(comm -13 "$T/expected" "$T/changed")"
[ -z "$stray" ] || die "$UP has changes that no patch accounts for: $(echo "$stray" | awk 'NR<=5')"

# Rebuild "pristine + patches" for the patched paths only, then compare content and exec bit.
mkdir "$T/ref"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if g cat-file -e "HEAD:$path" 2>/dev/null; then printf '%s\0' "$path"; fi
done < "$T/expected" | xargs -0 -r git -C "$UP" archive HEAD -- 2>/dev/null | tar -x -C "$T/ref" 2>/dev/null || true
for p in "${patches[@]}"; do
  (cd "$T/ref" && git apply "$p") || die "$(basename "$p") does not apply to the pinned commit"
done
while IFS= read -r path; do
  [ -n "$path" ] || continue
  want="$T/ref/$path"; have="$UP/$path"
  if [ ! -e "$want" ] && [ ! -e "$have" ]; then continue; fi
  { [ -f "$want" ] && [ -f "$have" ] && cmp -s -- "$want" "$have"; } || die "$path does not match pinned commit + patches"
  { [ -x "$want" ] && [ -x "$have" ]; } || { [ ! -x "$want" ] && [ ! -x "$have" ]; } || die "$path exec bit does not match pinned commit + patches"
done < "$T/expected"
echo "verify-upstream: OK ($UP = ${COMMIT:0:12} + ${#patches[@]} patch(es))"
