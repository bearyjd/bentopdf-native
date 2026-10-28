#!/usr/bin/env bash
# Gate: scan a built local bundle for external http(s) hosts.
# Usage: [STRICT=0|1] [MAX_LIST=n] scripts/verify-offline.sh [dist-dir]
#
# STRICT=1 (default): exit 1 if any (host, file) hit is not covered by
# scripts/offline-allowlist.txt (tab-separated: host, file regex, reason).
# STRICT=0: report only.
#
# Scope: URLs that a browser could request.
#  - *.html : only inside resource-loading tags (script/img/iframe/link/source/
#             video/audio/embed/object/form/use). Plain <a href>, JSON-LD and
#             meta tags are navigation/metadata, not fetches, so they are ignored.
#  - text files (js/mjs/css/json/webmanifest/svg/_headers): every URL string.
#  - Bulk third-party engine dirs (pyodide, gs, tesseract core, libreoffice,
#    vendored PDF.js viewers) are scanned too, but only hosts matching CDN_RE
#    are reported there (their code is full of documentation links).
# Static scanning cannot prove a browser makes no request; see docs/local-bundle.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${1:-$ROOT/dist}"
ALLOWLIST="${ALLOWLIST:-$ROOT/scripts/offline-allowlist.txt}"
STRICT="${STRICT:-1}"
[ -d "$DIST" ] || { echo "no such dir: $DIST" >&2; exit 1; }
[ -f "$ALLOWLIST" ] || { echo "no allowlist: $ALLOWLIST" >&2; exit 1; }
DIST="$(cd "$DIST" && pwd)"
cd "$DIST"

SKIP_RE='^wasm/(pymupdf|gs|ocr/core)/|^libreoffice-wasm/|^pdfjs-viewer/|^pdfjs-annotation-viewer/'
CDN_RE='(cdn|unpkg|jsdelivr|githack|githubusercontent|googleapis|gstatic|cloudflare|workers\.dev|polar\.sh|esm\.sh|skypack)'
# Namespace / license / doc noise that is never fetched.
NOISE_RE='^(www\.w3\.org|w3\.org|schema\.org|purl\.org|purl\.oclc\.org|www\.apache\.org|opensource\.org|creativecommons\.org|www\.gnu\.org|ns\.adobe\.com|schemas\.(openxmlformats|microsoft)\.org|sheetjs\.openxmlformats\.org|openoffice\.org|docs\.oasis-open\.org|www\.xfa\.org|localhost|127\.0\.0\.1|example\.(com|org)|your-cdn\.com)$'

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# One perl process does the scanning, so no grep/xargs exit-status or SIGPIPE traps.
# Output: file<TAB>host<TAB>url
find . -type f \( -name '*.html' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' \
  -o -name '*.json' -o -name '*.webmanifest' -o -name '_headers' -o -name '*.svg' \) -print0 \
  | SKIP_RE="$SKIP_RE" CDN_RE="$CDN_RE" perl -0 -ne '
      BEGIN { $/ = "\0"; $skip = qr/$ENV{SKIP_RE}/; $cdn = qr/$ENV{CDN_RE}/i; $nfiles = 0 }
      chomp; my $f = $_; $f =~ s{^\./}{};
      my $in_engine = ($f =~ $skip);
      open(my $fh, "<:raw", $_) or next; local $/ = undef; my $s = <$fh>; close $fh;
      $nfiles++;
      my @urls;
      if ($f =~ /\.html$/) {
        while ($s =~ /<(?:script|img|iframe|link|source|video|audio|embed|object|form|use)\b[^>]*>/gis) {
          my $t = $&; next if $t =~ /\brel\s*=\s*["\x27]?(canonical|alternate)/i;
          push @urls, $1 while $t =~ m{(https?://[A-Za-z0-9._~:/?#@!\$&*+,;=%-]+)}g;
        }
      } else {
        push @urls, $1 while $s =~ m{(https?://[A-Za-z0-9._~:/?#@!\$&*+,;=%-]+)}g;
      }
      for my $u (@urls) {
        $u =~ s{[).,;:"\x27`\\]+$}{};
        my ($h) = $u =~ m{^https?://([^/:?#]+)}; next unless defined $h;
        next if $in_engine && $h !~ $cdn;
        print "$f\t$h\t$u\n";
      }
      END { print STDERR "scanned $nfiles text files\n" }
    ' 2> "$T/scan.err" > "$T/raw.tsv"
NOISE_RE="$NOISE_RE" awk -F'\t' '$2 !~ ENVIRON["NOISE_RE"]' "$T/raw.tsv" > "$T/hits.tsv"

echo "Scanned $(awk '{print $2}' "$T/scan.err") text files under $DIST"
echo "(engine dirs scanned for CDN-like hosts only: wasm/pymupdf, wasm/gs, wasm/ocr/core, libreoffice-wasm, pdfjs-*viewer)"
echo
echo "== External hosts (hits, distinct files) =="
awk -F'\t' '{c[$2]++; k=$2 SUBSEP $1; if(!(k in s)){s[k]=1;f[$2]++}} END{for(h in c) printf "%6d %5d  %s\n", c[h], f[h], h}' "$T/hits.tsv" | sort -rn
echo

# Allowlist: host<TAB>file-regex<TAB>reason ; a hit is allowed if host equals and the file matches.
awk -F'\t' '
  NR==FNR { if ($0 ~ /^[[:space:]]*(#|$)/) next; if (NF < 3 || $3 == "") { bad = bad "allowlist line " FNR " needs host, file-regex and reason\n"; next }
            n++; ah[n]=$1; af[n]=$2; next }
  { ok = 0; for (i = 1; i <= n; i++) if ($2 == ah[i] && $1 ~ af[i]) { ok = 1; break }
    if (!ok) print $1 "\t" $3 }
  END { if (bad != "") { printf "%s", bad > "/dev/stderr"; exit 3 } }
' "$ALLOWLIST" "$T/hits.tsv" | sort -u > "$T/offenders.tsv" || { echo "malformed allowlist: $ALLOWLIST" >&2; exit 2; }

echo "== Hits not covered by $(basename "$ALLOWLIST") =="
awk -F'\t' -v max="${MAX_LIST:-60}" 'NR<=max {printf "%s\n    %s\n", $2, $1} END{if (NR>max) printf "... %d more (raise MAX_LIST)\n", NR-max}' "$T/offenders.tsv"
count="$(awk 'END{print NR}' "$T/offenders.tsv")"
echo
if [ "$count" -eq 0 ]; then echo "verify-offline: OK (all external hosts allowlisted)"; exit 0; fi
echo "verify-offline: $count non-allowlisted (file, url) hit(s)"
if [ "$STRICT" = 1 ]; then echo "STRICT=1: failing" >&2; exit 1; fi
echo "STRICT=0: report only"
