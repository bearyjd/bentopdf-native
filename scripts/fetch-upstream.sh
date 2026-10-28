#!/usr/bin/env bash
# Clone upstream BentoPDF at the pinned tag into ./upstream and apply patches/*.patch.
# The tag is NOT trusted: the checked-out commit must equal UPSTREAM_COMMIT.
# Idempotent: re-running re-fetches the tag, resets ./upstream and re-applies patches.
# Destructive git commands (reset --hard, clean -fd) only run in a checkout this
# script created: origin must equal UPSTREAM_REPO and <dir>/.git/upstream-managed must exist.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="${UPSTREAM_DIR:-$ROOT/upstream}"
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/alam00000/bentopdf.git}"
TAG="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_VERSION")"
COMMIT="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")"
die() { echo "ERROR: $*" >&2; exit 1; }
[ -n "$TAG" ] || die "UPSTREAM_VERSION is empty"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "UPSTREAM_COMMIT must be a 40-char lowercase hex sha"
[[ "$TAG" =~ ^[A-Za-z0-9._-]+$ ]] || die "UPSTREAM_VERSION has unexpected characters"
[ -n "$UPSTREAM_DIR" ] || die "UPSTREAM_DIR is empty"

verify_commit() {
  local got
  got="$(git -C "$UPSTREAM_DIR" rev-parse 'HEAD^{commit}')"
  [ "$got" = "$COMMIT" ] || die "upstream $TAG resolves to $got, expected $COMMIT (UPSTREAM_COMMIT); refusing to build"
}

if [ ! -e "$UPSTREAM_DIR" ]; then
  echo "==> cloning $UPSTREAM_REPO @ $TAG"
  git clone --quiet --depth 1 --branch "$TAG" "$UPSTREAM_REPO" "$UPSTREAM_DIR"
  verify_commit
  : > "$UPSTREAM_DIR/.git/upstream-managed"
else
  [ -d "$UPSTREAM_DIR/.git" ] || die "$UPSTREAM_DIR exists but is not a git checkout; refusing to touch it"
  origin="$(git -C "$UPSTREAM_DIR" remote get-url origin 2>/dev/null || true)"
  [ "$origin" = "$UPSTREAM_REPO" ] || die "$UPSTREAM_DIR origin is '$origin', expected $UPSTREAM_REPO; refusing reset/clean"
  [ -f "$UPSTREAM_DIR/.git/upstream-managed" ] || die "$UPSTREAM_DIR lacks .git/upstream-managed (not created by this script); refusing reset/clean. Remove the directory or create the marker yourself if you are sure"
  echo "==> reusing $UPSTREAM_DIR; re-fetching $TAG and resetting"
  # Always re-fetch (forced): a stale or moved local tag must not be trusted.
  git -C "$UPSTREAM_DIR" fetch --quiet --depth 1 origin "+refs/tags/$TAG:refs/tags/$TAG"
  git -C "$UPSTREAM_DIR" checkout --quiet --force "refs/tags/$TAG"
  verify_commit
  # Drop tracked changes (previous patches) and untracked, non-ignored files.
  git -C "$UPSTREAM_DIR" reset --quiet --hard "$COMMIT"
  git -C "$UPSTREAM_DIR" clean --quiet -fd
fi

shopt -s nullglob
patches=("$ROOT"/patches/*.patch)
for p in "${patches[@]}"; do
  echo "==> checking $(basename "$p")"
  git -C "$UPSTREAM_DIR" apply --check "$p"
  git -C "$UPSTREAM_DIR" apply "$p"
  echo "    applied"
done
echo "==> upstream $TAG ($COMMIT) ready (${#patches[@]} patch(es))"
