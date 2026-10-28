#!/usr/bin/env bash
# Clone upstream BentoPDF at the pinned tag into ./upstream and apply patches/*.patch.
# Idempotent: re-running resets ./upstream to the pinned tag and re-applies patches.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="${UPSTREAM_DIR:-$ROOT/upstream}"
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/alam00000/bentopdf.git}"
TAG="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_VERSION")"
[ -n "$TAG" ] || { echo "UPSTREAM_VERSION is empty" >&2; exit 1; }

if [ ! -d "$UPSTREAM_DIR/.git" ]; then
  echo "==> cloning $UPSTREAM_REPO @ $TAG"
  git clone --quiet --depth 1 --branch "$TAG" "$UPSTREAM_REPO" "$UPSTREAM_DIR"
else
  echo "==> reusing $UPSTREAM_DIR; resetting to $TAG"
  if ! git -C "$UPSTREAM_DIR" rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null; then
    git -C "$UPSTREAM_DIR" fetch --quiet --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
  fi
  git -C "$UPSTREAM_DIR" checkout --quiet --force "$TAG"
  # Drop tracked changes (previous patches) and untracked, non-ignored files.
  git -C "$UPSTREAM_DIR" reset --quiet --hard "$TAG"
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
echo "==> upstream $TAG ready (${#patches[@]} patch(es))"
