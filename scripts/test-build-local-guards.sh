#!/usr/bin/env bash
# Tests for the guards in scripts/build-local.sh, scripts/lib-artifacts.sh and scripts/check-dist.sh that
# can be exercised without network: OUT_DIR wipe guard, checksum proposal/accept flow, private verified
# copies, and the NOTICE exemption in check-dist. Usage: scripts/test-build-local-guards.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAILED=0
check() { if [ "$2" = "$3" ]; then echo "ok:   $1"; else echo "FAIL: $1 (got '$3', wanted '$2')" >&2; FAILED=1; fi; }
status_of() { local rc=0; "$@" >"$T/out" 2>"$T/err" || rc=$?; if [ "$rc" = 0 ]; then echo 0; else echo nonzero; fi; }
err_has() { grep -q -- "$1" "$T/err" && echo yes || echo no; }

# --- F5a: OUT_DIR wipe guard ----------------------------------------------------
bl() { UPSTREAM_DIR="$T/no-such-upstream" OUT_DIR="$1" CACHE_DIR="$T/cache" SKIP_FETCH=true SKIP_INSTALL=true "$HERE/build-local.sh"; }
refused() { status_of bl "$1" >/dev/null; err_has 'refusing to wipe'; }
mkdir "$T/o1"; echo hi > "$T/o1/index.html"; echo precious > "$T/o1/mine.txt"
snapshot() { (cd "$1" && find . -print0 | sort -z | xargs -0 sha256sum 2>/dev/null; find . | sort); }
before_o1="$(snapshot "$T/o1")"
check "OUT_DIR with only an index.html is refused" yes "$(refused "$T/o1")"
mkdir "$T/o2"; echo hi > "$T/o2/index.html"; printf 'Not our header\n' > "$T/o2/SOURCE.txt"
check "OUT_DIR with a foreign SOURCE.txt is refused" yes "$(refused "$T/o2")"
mkdir "$T/o3"; echo x > "$T/o3/file"
check "OUT_DIR without index.html is refused" yes "$(refused "$T/o3")"
mkdir "$T/o4"; echo hi > "$T/o4/index.html"; printf 'Corresponding source / AGPL-3.0 notice\n===\n' > "$T/o4/SOURCE.txt"
check "finished bundle (SOURCE.txt header) is accepted" no "$(refused "$T/o4")"
mkdir "$T/o5"; : > "$T/o5/.bentopdf-local-bundle"; echo partial > "$T/o5/assets"
check "interrupted bundle (marker) is accepted" no "$(refused "$T/o5")"
mkdir "$T/o6"
check "empty OUT_DIR is accepted" no "$(refused "$T/o6")"
check "refusal left the directory untouched (content hashes + listing)" "$before_o1" "$(snapshot "$T/o1")"
check "  ... snapshot is non-trivial" yes "$([ "$(printf '%s\n' "$before_o1" | wc -l)" -ge 4 ] && echo yes || echo no)"

# --- F6a: --update-checksums writes a proposal; --accept-checksums needs the reviewed digest ----
CS="$T/checksums.sha256"
acc() { CHECKSUMS_FILE="$CS" "$HERE/build-local.sh" "$@"; }
printf 'aaaa  old/key\n' > "$CS"; printf 'bbbb  new/key\n' > "$CS.proposed"
digest="$(sha256sum < "$CS.proposed" | awk '{print $1}')"
check "accept: no digest is refused" nonzero "$(status_of acc --accept-checksums=)"
check "accept: wrong digest is refused" nonzero "$(status_of acc --accept-checksums="$(printf '%064d' 0)")"
check "accept: pinned file untouched after refusal" "aaaa  old/key" "$(cat "$CS")"
printf 'cccc  evil/key\n' >> "$CS.proposed"
check "accept: proposal edited after review is refused" nonzero "$(status_of acc --accept-checksums="$digest")"
check "accept: pinned file still untouched" "aaaa  old/key" "$(cat "$CS")"
printf 'bbbb  new/key\n' > "$CS.proposed"
check "accept: reviewed digest installs the proposal" 0 "$(status_of acc --accept-checksums="$digest")"
check "accept: pinned file is the reviewed proposal" "bbbb  new/key" "$(cat "$CS")"
check "accept: proposal consumed" no "$([ -e "$CS.proposed" ] && echo yes || echo no)"
check "accept: nothing to accept is refused" nonzero "$(status_of acc --accept-checksums="$digest")"
# F6 review: the proposal is copied to a private dir; the copy is hashed AND installed.
printf 'bbbb  new/key\n' > "$CS.proposed"; printf 'aaaa  old/key\n' > "$CS"
mkdir "$T/shimbin"; REALSUM="$(command -v sha256sum)"
printf '#!/usr/bin/env bash\n%s "$@"; rc=$?\nif [ -n "${SWAP_AFTER_HASH:-}" ]; then rm -f "$SWAP_AFTER_HASH"; printf "cccc  evil/key\\n" > "$SWAP_AFTER_HASH"; fi\nexit $rc\n' "$REALSUM" > "$T/shimbin/sha256sum"; chmod +x "$T/shimbin/sha256sum"
check "accept: proposal swapped right after hashing still installs the reviewed copy" 0 "$(SWAP_AFTER_HASH="$CS.proposed" PATH="$T/shimbin:$PATH" status_of acc --accept-checksums="$digest")"
check "accept: installed file is the reviewed content, not the swapped one" "bbbb  new/key" "$(cat "$CS")"
printf 'bbbb  new/key\n' > "$T/real-proposal"; ln -s "$T/real-proposal" "$CS.proposed"; printf 'aaaa  old/key\n' > "$CS"
check "accept: symlinked proposal is refused" nonzero "$(status_of acc --accept-checksums="$digest")"
check "accept: pinned file untouched after symlink refusal" "aaaa  old/key" "$(cat "$CS")"
rm -f "$CS.proposed"
# Static: the digest printed by --update-checksums must come from the merged file, not a re-read of the proposal.
check "update: printed digest is computed from \$MERGED" yes "$(grep -q 'sum_of "\$MERGED"' "$HERE/build-local.sh" && ! grep -q 'sum_of "\$PROPOSED"' "$HERE/build-local.sh" && echo yes || echo no)"
check "update and accept together are refused" nonzero "$(status_of acc --update-checksums --accept-checksums="$digest")"

# --- F6b: artifacts are used from a private verified copy, never from the shared cache --------
(
  set -euo pipefail
  die() { echo "ERROR: $*" >&2; exit 1; }; info() { :; }
  P="$T/priv"; mkdir -p "$P/cache/ocr-fonts"; T="$P/tmp"; mkdir -p "$T"
  # shellcheck disable=SC2034  # variables are read by lib-artifacts.sh
  CACHE_DIR="$P/cache"; CHECKSUMS="$P/sums"; UPDATE_CHECKSUMS=false; CURL_OPTS=(); NEWSUMS="$P/new"
  printf 'font-bytes\n' > "$CACHE_DIR/ocr-fonts/f.ttf"
  printf '%s  ocr-fonts/f.ttf\n' "$(sha256sum "$CACHE_DIR/ocr-fonts/f.ttf" | awk '{print $1}')" > "$CHECKSUMS"
  # shellcheck source=scripts/lib-artifacts.sh
  . "$HERE/lib-artifacts.sh"
  acquire ocr-fonts/f.ttf url https://example.invalid/f.ttf
  [ "$ACQUIRED" != "$CACHE_DIR/ocr-fonts/f.ttf" ] || { echo "FAIL: acquire returned the shared cache path" >&2; exit 11; }
  case "$ACQUIRED" in "$T"/verified/*) ;; *) echo "FAIL: $ACQUIRED is not under the private verified dir" >&2; exit 12 ;; esac
  printf 'swapped-after-verify\n' > "$CACHE_DIR/ocr-fonts/f.ttf"      # attacker rewrites the cache after verification
  [ "$(cat "$ACQUIRED")" = "font-bytes" ] || { echo "FAIL: verified copy changed with the cache" >&2; exit 13; }
  rc=0; ( acquire ocr-fonts/f.ttf url https://example.invalid/f.ttf ) >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || { echo "FAIL: tampered cache entry accepted" >&2; exit 14; }
  [ ! -e "$CACHE_DIR/ocr-fonts/f.ttf" ] || { echo "FAIL: tampered cache entry not deleted" >&2; exit 15; }
  echo "ok:   private verified copy, tamper detection and cache eviction"
) || { echo "FAIL: lib-artifacts private-copy test (exit $?)" >&2; FAILED=1; }

# --- F5b: check-dist.sh exempts only the root NOTICE --------------------------------------------
dist_with() { # name relpath  -> dist whose given file names the excluded product
  local d="$T/d-$1"; mkdir -p "$d"
  printf 'x\n' > "$d/SOURCE.txt"; printf 'x\n' > "$d/LICENSE"; printf 'x\n' > "$d/NOTICE"; printf '<html></html>\n' > "$d/index.html"
  mkdir -p "$(dirname "$d/$2")"; printf 'uses hyper-compress-wasm here\n' >> "$d/$2"
  echo "$d"
}
cd_status() { status_of "$HERE/check-dist.sh" "$1"; }
check "check-dist: root NOTICE may name the product" 0 "$(cd_status "$(dist_with rootnotice NOTICE)")"
check "check-dist: nested NOTICE is not exempt" nonzero "$(cd_status "$(dist_with nested assets/NOTICE)")"
check "check-dist: deeper NOTICE is not exempt" nonzero "$(cd_status "$(dist_with nested2 a/b/NOTICE)")"
check "check-dist: any other file is not exempt" nonzero "$(cd_status "$(dist_with other assets/x.js)")"
check "check-dist: root NOTICE exempt via trailing-slash path" 0 "$(cd_status "$(dist_with slash NOTICE)/")"
exit "$FAILED"
