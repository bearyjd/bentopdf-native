#!/usr/bin/env bash
# Tests for scripts/verify-offline.sh: every scanner/allowlist guard must be able to FAIL.
# Each "bad" case plants one offending construct in an otherwise clean bundle and expects exit 1;
# each "good" case is the nearest legitimate construct and expects exit 0 (no false positives).
# Usage: scripts/test-verify-offline.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAILED=0
echo '# no entries' > "$T/empty-allow.txt"
: > "$T/zero-byte-allow.txt"

run() { # dist allowlist -> exit code (output discarded)
  local rc=0
  ALLOWLIST="$2" STRICT=1 "$HERE/verify-offline.sh" "$1" >/dev/null 2>&1 || rc=$?
  echo "$rc"
}
new_dist() { # name -> path of a clean bundle
  local d="$T/$1"; mkdir -p "$d/assets" "$d/wasm/gs"
  printf '<html><head><script src="/assets/a.js"></script></head><body><a href="https://github.com/x">x</a></body></html>\n' > "$d/index.html"
  printf 'const a = 1;\n' > "$d/assets/a.js"
  echo "$d"
}
check() { # name wanted got
  if [ "$2" = "$3" ]; then echo "ok:   $1"; else echo "FAIL: $1 (exit $3, wanted $2)" >&2; FAILED=1; fi
}
case_file() { # name wanted relpath content   (default empty allowlist)
  local d; d="$(new_dist "$1")"
  mkdir -p "$(dirname "$d/$3")"; printf '%s\n' "$4" > "$d/$3"
  check "$1" "$2" "$(run "$d" "$T/empty-allow.txt")"
}

case_file "clean bundle passes"                         0 extra.html '<p>hello</p>'
# --- F2: constructs the old scanner missed (all must fail) ---
case_file "inline <script> fetch(https)"                1 extra.html '<script>fetch("https://evil.test/x")</script>'
case_file "inline <script> protocol-relative fetch"     1 extra.html '<script>fetch("//evil.test/x")</script>'
case_file "<style> @import url(https)"                  1 extra.html '<style>@import url(https://evil.test/a.css);</style>'
case_file "<style> @import protocol-relative"           1 extra.html '<style>@import "//evil.test/a.css";</style>'
case_file "meta refresh to https"                       1 extra.html '<meta http-equiv="refresh" content="0;url=https://evil.test/">'
case_file "meta refresh protocol-relative"              1 extra.html '<meta http-equiv="refresh" content="0;url=//evil.test/">'
case_file "script src protocol-relative"                1 extra.html '<script src="//evil.test/x.js"></script>'
case_file "style attribute url(https)"                  1 extra.html '<div style="background:url(https://evil.test/i.png)"></div>'
case_file "css @import protocol-relative"               1 assets/s.css '@import "//evil.test/a.css";'
case_file "js protocol-relative string"                 1 assets/b.js 'const u = "//evil.test/x.js";'
case_file "engine dir: non-CDN fetch(https)"            1 wasm/gs/g.js 'fetch("https://evil.test/x")'
case_file "engine dir: importScripts protocol-relative" 1 wasm/gs/g.js "importScripts('//evil.test/x.js')"
case_file "engine dir: XHR open(GET, https)"            1 wasm/gs/g.js 'x.open("GET", "https://evil.test/x")'
case_file "engine dir: script.src = https"              1 wasm/gs/g.js 's.src = "https://evil.test/x.js"'
case_file "engine dir: CDN host anywhere (still)"       1 wasm/gs/g.js 'var u = "https://cdn.jsdelivr.net/npm/x";'
# --- no false positives ---
case_file "JSON-LD URLs are metadata"                   0 extra.html '<script type="application/ld+json">{"url":"https://evil.test/x"}</script>'
case_file "plain <a href> is navigation"                0 extra.html '<a href="https://evil.test/x">x</a>'
case_file "engine dir: doc link outside a fetch"        0 wasm/gs/g.js 'var d = "https://docs.python.org/3/"; // see https://evil.test/doc'
case_file "// comment without a quote is not a URL"     0 assets/c.js 'var x = 1; //evil.example/not-a-url'
case_file "inline script without URLs"                  0 extra.html '<script>console.log(1)</script>'

# --- F3: allowlist strictness ---
allow() { printf '%s\t%s\t%s%s\n' "$1" "$2" "test entry" "${3:+	$3}" > "$T/allow.txt"; }
d="$(new_dist allow1)"; echo 'x("https://h.test/ok/a")' > "$d/assets/main-1.js"
allow h.test '^assets/main-'
check "prefix entry covers assets/main-1.js"            0 "$(run "$d" "$T/allow.txt")"
d="$(new_dist allow2)"; mkdir -p "$d/assets/main-x"; echo 'x("https://h.test/ok/a")' > "$d/assets/main-x/evil.js"
check "prefix entry does NOT cover assets/main-x/evil.js" 1 "$(run "$d" "$T/allow.txt")"
d="$(new_dist allow3)"; echo 'x("https://h.test/ok/a")' > "$d/assets/main-1.js"
allow h.test 'assets/main-'
check "unanchored file regex is a malformed allowlist"  2 "$(run "$d" "$T/allow.txt")"
allow h.test '^assets/main-' 'ok/'
check "unanchored url-path regex is malformed"          2 "$(run "$d" "$T/allow.txt")"
allow h.test '^assets/main-' '^/ok/.*'
check "url-path regex matches the URL path"             0 "$(run "$d" "$T/allow.txt")"
d="$(new_dist allow4)"; echo 'x("https://h.test/bad/a")' > "$d/assets/main-1.js"
check "url-path regex rejects another path on the host" 1 "$(run "$d" "$T/allow.txt")"
d="$(new_dist allow5)"; echo 'x("https://h.test/okay")' > "$d/assets/main-1.js"
allow h.test '^assets/main-' '^/ok'
check "url-path regex must match the whole path"        1 "$(run "$d" "$T/allow.txt")"
d="$(new_dist allow6)"; echo 'x("https://other.test/ok/a")' > "$d/assets/main-1.js"
allow h.test '^assets/main-' '^/ok/.*'
check "host must still match exactly"                   1 "$(run "$d" "$T/allow.txt")"
d="$(new_dist zero)"; echo 'x("https://evil.test/a")' > "$d/assets/a.js"
check "zero-byte allowlist still reports offenders"     1 "$(run "$d" "$T/zero-byte-allow.txt")"
# the shipped allowlist must itself be well-formed
d="$(new_dist shipped)"
check "shipped allowlist parses"                        0 "$(run "$d" "$HERE/offline-allowlist.txt")"
exit "$FAILED"
