#!/usr/bin/env bash
# Tests for scripts/fetch-upstream.sh, scripts/verify-upstream.sh and the SKIP_FETCH path of
# scripts/build-local.sh, against a throw-away local "upstream" repository and a copied recipe root.
# Every guard has a case that must make it fail. Usage: scripts/test-upstream.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAILED=0
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

check() { # name wanted got
  if [ "$2" = "$3" ]; then echo "ok:   $1"; else echo "FAIL: $1 (got $3, wanted $2)" >&2; FAILED=1; fi
}
status_of() { local rc=0; "$@" >"$T/out" 2>"$T/err" || rc=$?; echo "$rc"; }
err_has() { grep -q -- "$1" "$T/err" && echo yes || echo no; }

# --- fake upstream: one commit, tag v1 -----------------------------------------
FAKE="$T/fake-upstream"
git init -q "$FAKE"
printf 'line1\n' > "$FAKE/a.txt"; echo untouched > "$FAKE/c.txt"; echo '{}' > "$FAKE/package.json"
git -C "$FAKE" add -A; git -C "$FAKE" commit -q -m one; git -C "$FAKE" tag v1
COMMIT="$(git -C "$FAKE" rev-parse HEAD)"

new_root() { # name -> recipe root with scripts, pins and one patch (modifies a.txt, adds b.txt)
  local r="$T/$1"; mkdir -p "$r/patches"; cp -r "$HERE" "$r/scripts"
  printf 'v1\n' > "$r/UPSTREAM_VERSION"; printf '%s\n' "$COMMIT" > "$r/UPSTREAM_COMMIT"
  local w="$T/w-$1"; git clone -q "$FAKE" "$w"
  printf 'line1\npatched\n' > "$w/a.txt"; printf 'new\n' > "$w/b.txt"; git -C "$w" add -A
  git -C "$w" diff --cached > "$r/patches/0001-test.patch"
  echo "$r"
}
fetch() { # root dir [repo]
  UPSTREAM_DIR="$2" UPSTREAM_REPO="${3:-file://$FAKE}" "$1/scripts/fetch-upstream.sh"
}
verify() { "$1/scripts/verify-upstream.sh" "$2"; }

R="$(new_root good)"; U="$T/up-good"
check "fetch: fresh clone + patches" 0 "$(status_of fetch "$R" "$U")"
check "fetch: marker written" yes "$([ -f "$U/.git/upstream-managed" ] && echo yes || echo no)"
check "verify: pinned commit + patches passes" 0 "$(status_of verify "$R" "$U")"
check "fetch: idempotent re-run" 0 "$(status_of fetch "$R" "$U")"

# --- F1: each tamper must be caught by verify-upstream.sh ----------------------
tamper() { # name command...  (applies the tamper to a fresh verified checkout, then verifies)
  local name=$1; shift
  local u="$T/up-$name"; cp -a "$U" "$u"
  ( cd "$u" && "$@" ) >/dev/null 2>&1
  check "verify rejects: $name" 1 "$(status_of verify "$R" "$u")"
}
tamper "edit to a patched file"          bash -c "echo evil >> a.txt"
tamper "patched file reverted"           git checkout -- a.txt
tamper "patch-added file edited"         bash -c "echo evil >> b.txt"
tamper "patch-added file missing"        rm b.txt
tamper "untracked planted file"          bash -c "echo evil > planted.js"
tamper "exec bit flipped on patched file" chmod +x b.txt
tamper "HEAD moved to another commit"    git commit -q --allow-empty -m other
tamper "unpatched file hidden by assume-unchanged" bash -c "echo evil >> c.txt; git update-index --assume-unchanged c.txt"
tamper "unpatched file hidden by skip-worktree"    bash -c "echo evil >> c.txt; git update-index --skip-worktree c.txt"
tamper "unpatched tracked file edited"             bash -c "echo evil >> c.txt"
R2="$(new_root wrongpin)"; printf '%040d\n' 1 > "$R2/UPSTREAM_COMMIT"
check "verify rejects: wrong UPSTREAM_COMMIT pin" 1 "$(status_of verify "$R2" "$U")"
check "verify: top-level node_modules/ and dist/ are out of scope (no ignore rule needed)" 0 "$(
  u="$T/up-ign"; cp -a "$U" "$u"; mkdir "$u/node_modules" "$u/dist"; echo x > "$u/node_modules/x.js"; echo x > "$u/dist/x.js"
  status_of verify "$R" "$u")"
# Ignore rules must not hide planted files (F1 review: .git/info/exclude, core.excludesFile, .gitignore).
u="$T/up-exclude"; cp -a "$U" "$u"; printf '*.js\n' >> "$u/.git/info/exclude"; echo evil > "$u/planted.js"
check "verify rejects: planted file hidden by .git/info/exclude" 1 "$(status_of verify "$R" "$u")"
printf 'planted2.js\n' > "$T/global-excludes"; printf '[core]\n\texcludesFile = %s\n' "$T/global-excludes" > "$T/gitconfig-ex"
u="$T/up-gex"; cp -a "$U" "$u"; echo evil > "$u/planted2.js"
check "verify rejects: planted file hidden by core.excludesFile" 1 "$(GIT_CONFIG_GLOBAL="$T/gitconfig-ex" status_of verify "$R" "$u")"
u="$T/up-gitignore"; cp -a "$U" "$u"; printf '*.js\n' > "$u/.gitignore"; echo evil > "$u/planted3.js"
check "verify rejects: planted file hidden by an untracked .gitignore" 1 "$(status_of verify "$R" "$u")"
u="$T/up-env"; cp -a "$U" "$u"; echo 'TOKEN=x' > "$u/.env.local"
check "verify rejects: .env* file" 1 "$(status_of verify "$R" "$u")"
check "  ... with the environment-file message" yes "$(err_has 'environment file')"
u="$T/up-env2"; cp -a "$U" "$u"; printf '.env*\n' >> "$u/.git/info/exclude"; echo 'TOKEN=x' > "$u/.env"
check "verify rejects: ignored .env file" 1 "$(status_of verify "$R" "$u")"
check "  ... with the environment-file message" yes "$(err_has 'environment file')"

# --- F1: SKIP_FETCH must not skip verification in build-local.sh ---------------
bl() { # root dir  (SKIP_FETCH build; expected to stop before building anything)
  UPSTREAM_DIR="$2" OUT_DIR="$T/out-$(basename "$2")" CACHE_DIR="$T/cache" SKIP_FETCH=true SKIP_INSTALL=true "$1/scripts/build-local.sh"
}
u="$T/up-skip-tampered"; cp -a "$U" "$u"; echo evil >> "$u/a.txt"
check "build-local SKIP_FETCH rejects tampered upstream" 1 "$(status_of bl "$R" "$u")"
check "  ... with the upstream-check message" yes "$(err_has 'UPSTREAM CHECK FAILED')"
u="$T/up-skip-moved"; cp -a "$U" "$u"; git -C "$u" commit -q --allow-empty -m other
check "build-local SKIP_FETCH rejects another commit" 1 "$(status_of bl "$R" "$u")"
check "  ... with the upstream-check message" yes "$(err_has 'UPSTREAM CHECK FAILED')"
status_of bl "$R" "$U" >/dev/null
check "build-local SKIP_FETCH accepts the verified checkout (stops later, on the fake upstream's missing cdn-version.ts)" "no yes" "$(err_has 'UPSTREAM CHECK FAILED') $(err_has 'cdn-version')"

# --- F4: fetch-upstream.sh ------------------------------------------------------
R3="$(new_root f4)"
check "empty UPSTREAM_DIR is refused" 1 "$(status_of env UPSTREAM_DIR= "$R3/scripts/fetch-upstream.sh")"
check "  ... with a clear message" yes "$(err_has 'UPSTREAM_DIR is empty')"
U4="$T/fresh/up"
check "failed clone (bad repo) fails" fail "$([ "$(status_of fetch "$R3" "$U4" "file://$T/does-not-exist")" != 0 ] && echo fail || echo ok)"
check "failed clone leaves no directory behind" "" "$(ls -A "$T/fresh" 2>/dev/null)"
check "next run succeeds after a failed clone" 0 "$(status_of fetch "$R3" "$U4")"
R5="$(new_root f4b)"; printf '%040d\n' 2 > "$R5/UPSTREAM_COMMIT"
U5="$T/fresh5/up"
check "clone at the wrong commit fails" 1 "$(status_of fetch "$R5" "$U5")"
check "wrong-commit clone leaves no directory behind" "" "$(ls -A "$T/fresh5" 2>/dev/null)"
# Destination appears while cloning: must be refused, never nested. (A git shim creates it during "clone".)
mkdir "$T/shim"; REALGIT="$(command -v git)"
printf '#!/usr/bin/env bash\nif [ "${1:-}" = clone ] && [ -n "${RACE_DIR:-}" ]; then mkdir -p "$RACE_DIR"; fi\nexec %s "$@"\n' "$REALGIT" > "$T/shim/git"; chmod +x "$T/shim/git"
U6="$T/fresh6/up"
check "destination appearing during clone is refused" 1 "$(RACE_DIR="$U6" PATH="$T/shim:$PATH" status_of fetch "$R3" "$U6")"
check "  ... and the clone was not nested into it" "" "$(ls -A "$U6" 2>/dev/null)"
check "fetch-upstream.sh uses no GNU-only mv -T" 0 "$(grep -c -- 'mv -T' "$HERE/fetch-upstream.sh" || true)"
exit "$FAILED"
