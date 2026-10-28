#!/usr/bin/env bash
# Build the offline "local bundle" from ./upstream (see docs/local-bundle.md).
# All WASM / OCR / font assets are placed under <dist>/wasm and addressed by
# same-origin, root-relative URLs, so nothing is fetched from a CDN at runtime.
# Asset download/versions logic mirrors upstream scripts/prepare-airgap.sh.
#
# Usage: scripts/build-local.sh [--update-checksums]
#   --update-checksums  re-download every artifact (network), rewrite
#                       scripts/checksums.sha256, print the diff, and stop.
#                       Review the diff before committing: it is trust-on-first-use.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

info() { echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

UPDATE_CHECKSUMS=false
for a in "$@"; do
  case "$a" in
    --update-checksums) UPDATE_CHECKSUMS=true ;;
    *) die "unknown argument: $a (supported: --update-checksums)" ;;
  esac
done

# --- configuration (all overridable via environment) -------------------------
# Paths use "-" (unset only) so an explicitly empty value is refused, not defaulted.
UP="${UPSTREAM_DIR-$ROOT/upstream}"
OUT_DIR="${OUT_DIR-$ROOT/dist}"
CACHE_DIR="${CACHE_DIR-$ROOT/.cache/wasm}"
BASE_URL="${BASE_URL:-/}"                     # app mount path, must start with /
SIMPLE_MODE="${SIMPLE_MODE:-true}"
DISABLE_GITHUB_STARS="${DISABLE_GITHUB_STARS:-true}"
VITE_BRAND_NAME="${VITE_BRAND_NAME:-}"
VITE_BRAND_LOGO="${VITE_BRAND_LOGO:-}"        # path relative to dist root
BRAND_LOGO_FILE="${BRAND_LOGO_FILE:-}"        # local file; copied to dist/brand/
VITE_FOOTER_TEXT="${VITE_FOOTER_TEXT:-}"
VITE_DEFAULT_LANGUAGE="${VITE_DEFAULT_LANGUAGE:-}"
DISABLE_TOOLS="${DISABLE_TOOLS:-}"
KEEP_BROTLI="${KEEP_BROTLI:-false}"           # upstream always emits .br sidecars; useless for a local server
EMBEDPDF_FONT_PACKS="${EMBEDPDF_FONT_PACKS:-latin,arabic,hebrew}"  # Edit PDF fallback fonts; add jp,kr,sc,tc (+~145 MB) for CJK
OCR_LANGUAGES="${OCR_LANGUAGES:-eng}"         # comma list of tesseract codes
TESSDATA_VERSION="${TESSDATA_VERSION:-4.0.0_best_int}"   # directory inside the @tesseract.js-data/<lang> package
TESSDATA_PKG_VERSION="${TESSDATA_PKG_VERSION:-1.0.0}"    # exact npm version of every @tesseract.js-data/<lang> package
SITE_URL="${SITE_URL:-https://www.bentopdf.com}"   # canonical/sitemap metadata only; upstream seo-audit fails if changed
NPM_CI_FLAGS="${NPM_CI_FLAGS:---allow-remote=root}"  # upstream needs xlsx from cdn.sheetjs.com (lockfile-pinned integrity)
SKIP_FETCH="${SKIP_FETCH:-false}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"
CHECKSUMS="$ROOT/scripts/checksums.sha256"
CURL_OPTS=(-fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2)

for c in node npm curl tar git gzip sha256sum perl realpath; do command -v "$c" >/dev/null || die "missing: $c"; done

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# --- input validation / path canonicalisation (before any cd or rm) ----------
is_within() { case "$1/" in "$2"/*) return 0 ;; esac; return 1; }  # $1 inside or equal to $2

[ -n "$UP" ] || die "UPSTREAM_DIR is empty"
[ -n "$OUT_DIR" ] || die "OUT_DIR is empty"
[ -n "$CACHE_DIR" ] || die "CACHE_DIR is empty"
UP="$(realpath -m -- "$UP")"
OUT_DIR="$(realpath -m -- "$OUT_DIR")"
CACHE_DIR="$(realpath -m -- "$CACHE_DIR")"

[ "$OUT_DIR" != / ] || die "refusing OUT_DIR=/"
[ "$OUT_DIR" != "$(realpath -m -- "${HOME:-/nonexistent}")" ] || die "refusing OUT_DIR=\$HOME"
for p in "$ROOT" "$UP" "$CACHE_DIR"; do
  ! is_within "$p" "$OUT_DIR" || die "refusing OUT_DIR=$OUT_DIR: it contains $p"
done
! is_within "$OUT_DIR" "$UP" || die "refusing OUT_DIR=$OUT_DIR: it is inside the upstream checkout"
! is_within "$OUT_DIR" "$CACHE_DIR" || die "refusing OUT_DIR=$OUT_DIR: it is inside the cache"
if [ -e "$OUT_DIR" ] && [ -n "$(find "$OUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ] && [ ! -f "$OUT_DIR/index.html" ]; then
  die "refusing to wipe $OUT_DIR: not empty and does not look like a previous bundle (no index.html)"
fi

[[ "$BASE_URL" =~ ^/[A-Za-z0-9/_.-]*$ ]] && [[ "$BASE_URL" != *..* ]] || die "BASE_URL must start with / and use only [A-Za-z0-9/_.-] (no ..)"
BASE_URL="${BASE_URL%/}/"
WASM_BASE="${BASE_URL}wasm"

[[ "$TESSDATA_VERSION" =~ ^[A-Za-z0-9._]+$ ]] || die "invalid TESSDATA_VERSION"
[[ "$TESSDATA_PKG_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "TESSDATA_PKG_VERSION must be an exact x.y.z version"
[[ "$DISABLE_TOOLS" =~ ^[A-Za-z0-9,_-]*$ ]] || die "invalid DISABLE_TOOLS"
[[ "$VITE_DEFAULT_LANGUAGE" =~ ^([a-z]{2,3}(-[A-Za-z]{2,4})?)?$ ]] || die "invalid VITE_DEFAULT_LANGUAGE"
# Brand text is not shell-escaped here: upstream renders it via handlebars {{ }}
# (HTML-escaped), JSON.stringify (vite define) and textContent. Only reject control chars / huge values.
for v in VITE_BRAND_NAME VITE_FOOTER_TEXT; do
  val="${!v}"
  [ "${#val}" -le 200 ] || die "$v is longer than 200 characters"
  [[ "$val" != *[[:cntrl:]]* ]] || die "$v contains control characters"
done
[[ "$VITE_BRAND_LOGO" =~ ^[A-Za-z0-9/_.-]*$ ]] || die "invalid VITE_BRAND_LOGO"

LOGO_COPY=""
if [ -n "$BRAND_LOGO_FILE" ]; then
  BRAND_LOGO_FILE="$(realpath -e -- "$BRAND_LOGO_FILE")" || die "BRAND_LOGO_FILE does not exist"
  [ -f "$BRAND_LOGO_FILE" ] || die "BRAND_LOGO_FILE is not a regular file"
  ! is_within "$BRAND_LOGO_FILE" "$OUT_DIR" || die "BRAND_LOGO_FILE must not be inside OUT_DIR (it is wiped at build time)"
  logo_name="$(basename "$BRAND_LOGO_FILE")"
  [[ "$logo_name" =~ ^[A-Za-z0-9._-]+$ ]] || die "BRAND_LOGO_FILE name must match [A-Za-z0-9._-]+"
  mkdir "$T/logo"; cp -- "$BRAND_LOGO_FILE" "$T/logo/$logo_name"; LOGO_COPY="$T/logo/$logo_name"
  VITE_BRAND_LOGO="brand/$logo_name"
fi

# --- checksummed downloads ---------------------------------------------------
sum_of()  { sha256sum "$1" | awk '{print $1}'; }
want_of() { awk -v k="$1" '$2==k{print $1; exit}' "$CHECKSUMS"; }

verify_or_die() { # key file : compare against scripts/checksums.sha256, delete file on failure
  local key=$1 file=$2 want got
  want="$(want_of "$key")"
  [ -n "$want" ] || { rm -f "$file"; die "no pinned checksum for $key; review the source, then run scripts/build-local.sh --update-checksums"; }
  got="$(sum_of "$file")"
  [ "$got" = "$want" ] || { rm -f "$file"; die "checksum mismatch for $key (pinned $want, got $got); cache entry deleted"; }
}

check_members() { # tgz : reject absolute paths, .. components and any link member
  local names links
  tar tzf "$1" >/dev/null 2>&1 || die "$1 is not a readable tar.gz"
  names="$(tar tzf "$1" | awk '/^\// || /(^|\/)\.\.(\/|$)/')"
  [ -z "$names" ] || die "$1 contains unsafe member paths: $(echo "$names" | awk 'NR==1')"
  links="$(tar tvzf "$1" | awk '$1 ~ /^[lh]/')"
  [ -z "$links" ] || die "$1 contains link members; refusing"
}

validate_file() { # key file : structural check of a downloaded file
  case "$1" in
    *.tgz) check_members "$2" ;;
    *.gz)  gzip -t "$2" 2>/dev/null || die "$1 is not valid gzip" ;;
    *)     [ -s "$2" ] || die "$1 is empty" ;;
  esac
}

NEWSUMS="$T/newsums"; : > "$NEWSUMS"
ACQUIRED=""
acquire() { # key kind(npm|url) arg : verified file lands at $CACHE_DIR/<key>, path in $ACQUIRED
  local key=$1 kind=$2 arg=$3 f="$CACHE_DIR/$1" part tmp
  ACQUIRED="$f"
  mkdir -p "$(dirname "$f")"
  if [ "$UPDATE_CHECKSUMS" != true ] && [ -f "$f" ]; then
    verify_or_die "$key" "$f"        # every cache hit is re-verified
    return 0
  fi
  part="$f.part"; rm -f "$part"
  info "downloading $key"
  if [ "$kind" = npm ]; then
    tmp="$(mktemp -d)"
    (cd "$tmp" && npm pack "$arg" --ignore-scripts --quiet >/dev/null) || die "npm pack $arg failed"
    mv -- "$tmp"/*.tgz "$part"; rmdir "$tmp"
  else
    curl "${CURL_OPTS[@]}" "$arg" -o "$part" || { rm -f "$part"; die "download failed: $arg"; }
  fi
  validate_file "$key" "$part"
  if [ "$UPDATE_CHECKSUMS" = true ]; then
    printf '%s  %s\n' "$(sum_of "$part")" "$key" >> "$NEWSUMS"
  else
    verify_or_die "$key" "$part"      # verified BEFORE it enters the cache
  fi
  mv -- "$part" "$f"
}

npm_artifact() { # spec -> cached tgz (npm pack output is the registry tarball)
  acquire "npm/$(echo "$1" | sed 's#^@##; s#/#-#; s#@#-#').tgz" npm "$1"
}

safe_untar() { # tgz dest [strip-components]
  check_members "$1"
  mkdir -p "$2"
  tar xzf "$1" --no-same-owner -C "$2" --strip-components="${3:-0}"
}

# --- 1. upstream checkout ----------------------------------------------------
if [ "$SKIP_FETCH" != true ]; then UPSTREAM_DIR="$UP" "$ROOT/scripts/fetch-upstream.sh"; fi
[ -f "$UP/package.json" ] || die "$UP not found; run scripts/fetch-upstream.sh"
cd "$UP"

# --- 2. versions (read from upstream, as prepare-airgap.sh does) -------------
# sed with {p;q} always exits 0, so a miss yields an empty value and the friendly die below.
up_quoted() { sed -n "/$1:/{s/^[^']*'\([^']*\)'.*\$/\1/p;q}" src/js/const/cdn-version.ts; }
PYMUPDF_VERSION="$(up_quoted pymupdf)"
GS_VERSION="$(up_quoted ghostscript)"
TESSERACT_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/tesseract.js'].version")"
TESSERACT_CORE_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/tesseract.js-core'].version")"
# coherentpdf is not in the lockfile; pin the version upstream's CDN default uses
CPDF_VERSION="$(sed -n '/coherentpdf@[0-9]/{s/^.*coherentpdf@\([0-9][0-9.]*\).*$/\1/p;q}' src/js/utils/wasm-provider.ts)"
for v in PYMUPDF_VERSION GS_VERSION TESSERACT_VERSION TESSERACT_CORE_VERSION CPDF_VERSION; do
  [ -n "${!v}" ] || die "could not determine $v from upstream"
  [[ "${!v}" =~ ^[0-9][0-9A-Za-z.+-]*$ ]] || die "unexpected $v: ${!v}"
done
info "pymupdf $PYMUPDF_VERSION | gs $GS_VERSION | cpdf $CPDF_VERSION | tesseract.js $TESSERACT_VERSION (core $TESSERACT_CORE_VERSION)"

# --- 3. normalise + validate OCR languages -----------------------------------
OCR_LANGUAGES="${OCR_LANGUAGES// /}"
LANG_LIST="$(sed -n "s/^  \([a-z0-9_]*\): '.*\$/\1/p" src/js/config/tesseract-languages.ts)"
[ -n "$LANG_LIST" ] || die "could not read the language list from upstream"
IFS=',' read -r -a LANGS <<< "$OCR_LANGUAGES"
[ "${#LANGS[@]}" -gt 0 ] || die "OCR_LANGUAGES is empty"
for l in "${LANGS[@]}"; do
  [[ "$l" =~ ^[a-z0-9_]+$ ]] || die "invalid OCR language code: '$l'"
  grep -Fxq -- "$l" <<< "$LANG_LIST" || die "unsupported OCR language: $l"
done

EMBEDPDF_FONT_PACKS="${EMBEDPDF_FONT_PACKS// /}"
IFS=',' read -r -a FONT_PACKS <<< "$EMBEDPDF_FONT_PACKS"
for p in "${FONT_PACKS[@]}"; do
  [[ "$p" =~ ^[a-z]+$ ]] || die "invalid EMBEDPDF font pack: '$p'"
done

# --- 4. install deps (lifecycle scripts disabled: upstream code is untrusted) --
if [ "$SKIP_INSTALL" != true ] && [ "$UPDATE_CHECKSUMS" != true ]; then
  info "npm ci --ignore-scripts $NPM_CI_FLAGS"
  # shellcheck disable=SC2086
  HUSKY=0 npm ci --ignore-scripts $NPM_CI_FLAGS
fi

# --- 5. download WASM packages into the cache (checksum-verified) ------------
npm_artifact "@bentopdf/pymupdf-wasm@$PYMUPDF_VERSION"; PYMUPDF_TGZ="$ACQUIRED"
npm_artifact "@bentopdf/gs-wasm@$GS_VERSION";           GS_TGZ="$ACQUIRED"
npm_artifact "coherentpdf@$CPDF_VERSION";               CPDF_TGZ="$ACQUIRED"
npm_artifact "tesseract.js@$TESSERACT_VERSION";         TESS_TGZ="$ACQUIRED"
npm_artifact "tesseract.js-core@$TESSERACT_CORE_VERSION"; CORE_TGZ="$ACQUIRED"

declare -A LANG_FILE
for l in "${LANGS[@]}"; do
  acquire "ocr-langdata/$l-$TESSDATA_PKG_VERSION-$TESSDATA_VERSION.traineddata.gz" url \
    "https://cdn.jsdelivr.net/npm/@tesseract.js-data/$l@$TESSDATA_PKG_VERSION/$TESSDATA_VERSION/$l.traineddata.gz"
  LANG_FILE[$l]="$ACQUIRED"
done

# OCR fonts: same resolution as prepare-airgap.sh (Noto Sans + per-language family)
FONT_MANIFEST=$(node -e "const fs=require('fs');const src=fs.readFileSync(process.argv[1],'utf8');const sel=(process.argv[2]||'').split(',').filter(Boolean);const s=src.split('export const fontFamilyToUrl');const l2f={},f2u={};let m;const lp=/^\s*([a-z_]+):\s*'([^']+)',/gm;while((m=lp.exec(s[0]))!==null)l2f[m[1]]=m[2];const fp=/^\s*'([^']+)':\s*'([^']+)',/gm;while((m=fp.exec(s[1]||''))!==null)f2u[m[1]]=m[2];const fam=new Set(['Noto Sans']);for(const x of sel)fam.add(l2f[x]||'Noto Sans');process.stdout.write(Array.from(fam).sort().map(f=>{const u=f2u[f]||f2u['Noto Sans'];return f+'\t'+u+'\t'+u.split('/').pop()}).join('\n'))" src/js/config/font-mappings.ts "$OCR_LANGUAGES")
[ -n "$FONT_MANIFEST" ] || die "could not resolve OCR fonts"
FONT_FILES=()
while IFS=$'\t' read -r fam url file; do
  [ -z "$file" ] && continue
  [[ "$url" =~ ^https:// ]] || die "OCR font URL for '$fam' is not https: $url"
  [[ "$file" =~ ^[A-Za-z0-9._-]+$ ]] || die "unsafe OCR font file name: $file"
  acquire "ocr-fonts/$file" url "$url"
  FONT_FILES+=("$file")
done <<< "$FONT_MANIFEST"

# Edit PDF fallback fonts (upstream: src/js/config/editor-fonts.ts, VITE_EMBEDPDF_FONTS_URL)
declare -A PACK_VER PACK_TGZ
for p in "${FONT_PACKS[@]}"; do
  [ -z "$p" ] && continue
  ver="$(sed -n "/fonts-$p@[0-9]/{s/^.*fonts-$p@\([0-9][0-9.]*\).*\$/\1/p;q}" src/js/config/editor-fonts.ts)"
  [ -n "$ver" ] || die "unknown EMBEDPDF font pack: $p"
  npm_artifact "@embedpdf/fonts-$p@$ver"
  PACK_VER[$p]="$ver"; PACK_TGZ[$p]="$ACQUIRED"
done

if [ "$UPDATE_CHECKSUMS" = true ]; then
  touch "$CHECKSUMS"
  MERGED="$T/merged"
  { cat "$NEWSUMS"; awk 'NR==FNR{n[$2]=1; next} !($2 in n)' "$NEWSUMS" "$CHECKSUMS"; } | sort -k2,2 > "$MERGED"
  rc=0; diff -u "$CHECKSUMS" "$MERGED" || rc=$?
  [ "$rc" -le 1 ] || die "diff failed"
  cp -- "$MERGED" "$CHECKSUMS"
  info "wrote $CHECKSUMS; review the diff above before committing"
  exit 0
fi

# --- 6. vite build with same-origin asset URLs -------------------------------
export BASE_URL SIMPLE_MODE DISABLE_GITHUB_STARS SITE_URL DISABLE_TOOLS
export VITE_BRAND_NAME VITE_BRAND_LOGO VITE_FOOTER_TEXT VITE_DEFAULT_LANGUAGE
export VITE_WASM_PYMUPDF_URL="$WASM_BASE/pymupdf/"
export VITE_WASM_GS_URL="$WASM_BASE/gs/"
export VITE_WASM_CPDF_URL="$WASM_BASE/cpdf/"
export VITE_TESSERACT_WORKER_URL="$WASM_BASE/ocr/worker.min.js"
export VITE_TESSERACT_CORE_URL="$WASM_BASE/ocr/core"
export VITE_TESSERACT_LANG_URL="$WASM_BASE/ocr/lang-data"
export VITE_TESSERACT_AVAILABLE_LANGUAGES="$OCR_LANGUAGES"
export VITE_OCR_FONT_BASE_URL="$WASM_BASE/ocr/fonts"
export VITE_EMBEDPDF_FONTS_URL="$WASM_BASE/embedpdf-fonts"
export VITE_USE_CDN=false
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}"

info "npm run build (SIMPLE_MODE=$SIMPLE_MODE, BASE_URL=$BASE_URL)"
rm -rf "$UP/dist"
npm run build

# --- 7. assemble ./dist ------------------------------------------------------
info "assembling $OUT_DIR"
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"
cp -a "$UP/dist/." "$OUT_DIR/"
W="$OUT_DIR/wasm"
mkdir -p "$W/pymupdf" "$W/gs" "$W/cpdf" "$W/ocr/core" "$W/ocr/lang-data" "$W/ocr/fonts"

safe_untar "$PYMUPDF_TGZ" "$W/pymupdf" 1
safe_untar "$GS_TGZ" "$T/gs"
if [ -d "$T/gs/package/assets" ]; then cp -a "$T/gs/package/assets/." "$W/gs/"; else cp -a "$T/gs/package/." "$W/gs/"; fi
safe_untar "$CPDF_TGZ" "$T/cpdf"
if [ -d "$T/cpdf/package/dist" ]; then cp -a "$T/cpdf/package/dist/." "$W/cpdf/"; else cp -a "$T/cpdf/package/." "$W/cpdf/"; fi
safe_untar "$TESS_TGZ" "$T/tess"
cp "$T/tess/package/dist/worker.min.js" "$W/ocr/worker.min.js"
safe_untar "$CORE_TGZ" "$W/ocr/core" 1
for l in "${LANGS[@]}"; do cp "${LANG_FILE[$l]}" "$W/ocr/lang-data/$l.traineddata.gz"; done
for file in "${FONT_FILES[@]}"; do cp "$CACHE_DIR/ocr-fonts/$file" "$W/ocr/fonts/"; done
for p in "${FONT_PACKS[@]}"; do
  safe_untar "${PACK_TGZ[$p]}" "$W/embedpdf-fonts/fonts-$p@${PACK_VER[$p]}" 1
done

# Trim package payload that is not needed at runtime (sources, build scripts, tests)
rm -rf "$W/pymupdf/build_scripts" "$W/ocr/core/package.json"

if [ -n "$LOGO_COPY" ]; then mkdir -p "$OUT_DIR/brand"; cp "$LOGO_COPY" "$OUT_DIR/brand/"; fi

# Separately licensed products (see NOTICE): not shipped. Upstream v2.8.10 only
# has marketing pages for them (no code/WASM); remove them from the bundle.
# Links to them in navbar/legal pages are NOT removed (would need an upstream patch).
find "$OUT_DIR" \( -name 'kura.html*' -o -name 'hyper-compress.html*' \) -type f -delete
rm -rf "$OUT_DIR/kura" "$OUT_DIR/hyper-compress"
if [ -f "$OUT_DIR/sitemap.xml" ]; then
  perl -0777 -i -pe 's{\s*<url>(?:(?!</url>).)*?<loc>[^<]*/(?:kura|hyper-compress)(?:\.html)?</loc>.*?</url>}{}gs' "$OUT_DIR/sitemap.xml"
fi
if [ "$KEEP_BROTLI" != true ]; then find "$OUT_DIR" -name '*.br' -type f -delete; fi

# Runtime-network policy: drop every external origin from the generated CSP.
# connect-src keeps blob: (in-browser fetch of object URLs); style-src keeps
# 'unsafe-inline' (inline style attributes); img-src loses the bare https: scheme.
if [ -f "$OUT_DIR/_headers" ]; then
  perl -i -pe 'if (/^\s*Content-Security-Policy:/) {
      s{\s+https://[^\s;]+}{}g;
      s{(img-src[^;]*?)\s+https:(?=[\s;]|$)}{$1}g;
      s{connect-src[^;]*}{connect-src \x27self\x27 blob:}g;
    }' "$OUT_DIR/_headers"
fi

# LibreOffice WASM ships inside upstream public/ and is already in dist.
[ -f "$OUT_DIR/libreoffice-wasm/soffice.wasm.gz" ] || die "libreoffice-wasm missing from dist"

# --- 8. AGPL source offer: licence texts + SOURCE.txt ------------------------
cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$OUT_DIR/"
OUR_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then DIRTY=yes; else DIRTY=no; fi
UP_COMMIT="$(git -C "$UP" rev-parse 'HEAD^{commit}')"
UP_TAG="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_VERSION")"
BUILD_DATE="$(date -u -d "@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y-%m-%dT%H:%M:%SZ)"
LO_VERSION="$(node -p "require('./node_modules/@matbee/libreoffice-converter/package.json').version" 2>/dev/null || echo unknown)"
{
  echo "Corresponding source / AGPL-3.0 notice"
  echo "======================================"
  echo "This bundle is licensed under the GNU Affero General Public License v3.0 (LICENSE)."
  echo "Third-party components and their licences: NOTICE (shipped next to this file)."
  echo
  echo "Build recipe (this project):  https://github.com/bearyjd/bentopdf-native"
  echo "  commit:        $OUR_COMMIT"
  echo "  working tree:  dirty=$DIRTY"
  if [ "$DIRTY" = yes ]; then
    echo "  WARNING: built from uncommitted changes; the commit above does not reproduce this bundle."
  fi
  echo "Upstream BentoPDF source:     https://github.com/alam00000/bentopdf"
  echo "  tag:           $UP_TAG"
  echo "  commit:        $UP_COMMIT"
  echo "  patches:       $(find "$ROOT/patches" -maxdepth 1 -name '*.patch' | awk 'END{print NR}') (patches/*.patch in the recipe repository)"
  echo "Build date (UTC): $BUILD_DATE"
  echo
  echo "Bundled runtime components (npm packages, source on npmjs.com / their repositories):"
  echo "  @bentopdf/pymupdf-wasm $PYMUPDF_VERSION, @bentopdf/gs-wasm $GS_VERSION, coherentpdf $CPDF_VERSION,"
  echo "  tesseract.js $TESSERACT_VERSION, tesseract.js-core $TESSERACT_CORE_VERSION,"
  echo "  @tesseract.js-data/{$OCR_LANGUAGES} $TESSDATA_PKG_VERSION ($TESSDATA_VERSION),"
  echo "  @matbee/libreoffice-converter $LO_VERSION (LibreOffice WASM, committed in upstream public/libreoffice-wasm)."
  echo "Rebuild: scripts/build-local.sh in the recipe repository at the commit above."
} > "$OUT_DIR/SOURCE.txt"

# --- 9. gates ----------------------------------------------------------------
"$ROOT/scripts/check-dist.sh" "$OUT_DIR"
STRICT=1 "$ROOT/scripts/verify-offline.sh" "$OUT_DIR"

info "done: $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1))"
