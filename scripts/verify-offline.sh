#!/usr/bin/env bash
# Scan a built local bundle for external http(s) URLs.
# Usage: scripts/verify-offline.sh [dist-dir]
# Prints a per-URL report (hits + sample file). Exits 0 always unless the dist
# dir is missing; the report is for review, see docs/local-bundle.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${1:-$ROOT/dist}"
[ -d "$DIST" ] || { echo "no such dir: $DIST" >&2; exit 1; }
cd "$DIST"

# Scope: URLs that a browser could actually request.
#  - *.html : only inside resource-loading tags (script/img/iframe/link/source/
#             video/audio/embed/object/form/use). Plain <a href>, JSON-LD and
#             meta tags are navigation/metadata, not fetches, so they are ignored.
#  - *.js/*.mjs/*.css/*.json/*.webmanifest/_headers/*.svg : every URL string.
# Bulk third-party engine dirs (pyodide, gs, tesseract core, libreoffice,
# vendored PDF.js viewers) are skipped; they are runtime code, not app config.
SKIP_RE='^\./(wasm/(pymupdf|gs|ocr/core)|libreoffice-wasm|pdfjs-viewer|pdfjs-annotation-viewer)/'
URL_RE='https?://[A-Za-z0-9._~:/?#@!$&*+,;=%-]+'

# Namespace / license / doc noise that is never fetched.
NOISE_RE='^https?://(www\.w3\.org|w3\.org|schema\.org|purl\.org|purl\.oclc\.org|www\.apache\.org|opensource\.org|creativecommons\.org|www\.gnu\.org|ns\.adobe\.com|schemas\.(openxmlformats|microsoft)\.org|sheetjs\.openxmlformats\.org|openoffice\.org|docs\.oasis-open\.org|www\.xfa\.org|localhost|127\.0\.0\.1|example\.(com|org)|your-cdn\.com)([/:#]|$)'

TMP="$(mktemp)"; trap 'rm -f "$TMP" "$TMP.raw" "$TMP.files"' EXIT
find . -type f \( -name '*.html' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' \
  -o -name '*.json' -o -name '*.webmanifest' -o -name '_headers' -o -name '*.svg' \) \
  | grep -Ev "$SKIP_RE" | sort > "$TMP.files"

{
  grep -E '\.html$' "$TMP.files" | xargs -d '\n' perl -0777 -ne '
    while (/<(?:script|img|iframe|link|source|video|audio|embed|object|form|use)\b[^>]*>/gis) {
      my $t = $&; next if $t =~ /\brel\s*=\s*["\x27]?(canonical|alternate)/i; while ($t =~ m{(https?://[A-Za-z0-9._~:/?#@!\$\&*+,;=%-]+)}g) { print "$ARGV\t$1\n" }
    }' 
  grep -Ev '\.html$' "$TMP.files" | xargs -d '\n' grep -aoH -E "$URL_RE" 2>/dev/null \
    | sed -E 's/^([^:]*):/\1\t/'
} | sed -E 's/[).,;:"'"'"'`\\]+$//' \
  | awk -F'\t' -v re="$NOISE_RE" '$2 !~ re' > "$TMP" || true

echo "Scanned $(wc -l < "$TMP.files") text files under $DIST"
echo "(skipped engine dirs: wasm/pymupdf, wasm/gs, wasm/ocr/core, libreoffice-wasm, pdfjs-*viewer)"
echo
echo "== External URLs by host (hits, distinct files) =="
awk -F'\t' '{h=$2; sub(/^https?:\/\//,"",h); sub(/[\/:?#].*$/,"",h); c[h]++; k=h SUBSEP $1; if(!(k in s)){s[k]=1;f[h]++}} END{for(h in c) printf "%6d %5d  %s\n", c[h], f[h], h}' "$TMP" | sort -rn
echo
CDN_RE='(cdn|unpkg|jsdelivr|githack|githubusercontent|googleapis|gstatic|cloudflare|workers\.dev|polar\.sh|esm\.sh|skypack)'
echo "== Likely-runtime URLs (CDN/API-like hosts; review each) =="
awk -F'\t' -v re="$CDN_RE" '$2 ~ re' "$TMP" | sort -t$'\t' -k2,2 -u | awk -F'\t' '{printf "%s\n    %s\n", $2, $1}'
echo
echo "== Other distinct URLs (mostly comments/docs links inside vendored libraries) =="
awk -F'\t' -v re="$CDN_RE" '$2 !~ re' "$TMP" | sort -t$'\t' -k2,2 -u | awk -F'\t' '{printf "%s\n    %s\n", $2, $1}' | head -${MAX_LIST:-60}
