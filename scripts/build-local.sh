#!/usr/bin/env bash
# Build the offline "local bundle" from ./upstream (see docs/local-bundle.md).
# All WASM / OCR / font assets are placed under <dist>/wasm and addressed by
# same-origin, root-relative URLs, so nothing is fetched from a CDN at runtime.
# Asset download/versions logic mirrors upstream scripts/prepare-airgap.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UP="${UPSTREAM_DIR:-$ROOT/upstream}"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
CACHE_DIR="${CACHE_DIR:-$ROOT/.cache/wasm}"

# --- configuration (all overridable via environment) -------------------------
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
TESSDATA_VERSION="${TESSDATA_VERSION:-4.0.0_best_int}"
SITE_URL="${SITE_URL:-https://www.bentopdf.com}"   # canonical/sitemap metadata only; upstream seo-audit fails if changed
NPM_CI_FLAGS="${NPM_CI_FLAGS:---allow-remote=root}"  # upstream needs xlsx from cdn.sheetjs.com
SKIP_FETCH="${SKIP_FETCH:-false}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"

case "$BASE_URL" in /*) ;; *) echo "BASE_URL must start with /" >&2; exit 1;; esac
BASE_URL="${BASE_URL%/}/"
WASM_BASE="${BASE_URL}wasm"

info() { echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
for c in node npm curl tar git; do command -v "$c" >/dev/null || die "missing: $c"; done

# --- 1. upstream checkout ----------------------------------------------------
if [ "$SKIP_FETCH" != true ]; then "$ROOT/scripts/fetch-upstream.sh"; fi
[ -f "$UP/package.json" ] || die "$UP not found; run scripts/fetch-upstream.sh"
cd "$UP"

# --- 2. versions (read from upstream, as prepare-airgap.sh does) -------------
PYMUPDF_VERSION=$(grep "pymupdf:" src/js/const/cdn-version.ts | grep -o "'[^']*'" | tr -d "'")
GS_VERSION=$(grep "ghostscript:" src/js/const/cdn-version.ts | grep -o "'[^']*'" | tr -d "'")
TESSERACT_VERSION=$(node -p "require('./package-lock.json').packages['node_modules/tesseract.js'].version")
TESSERACT_CORE_VERSION=$(node -p "require('./package-lock.json').packages['node_modules/tesseract.js-core'].version")
# coherentpdf is not in the lockfile; pin the version upstream's CDN default uses
CPDF_VERSION=$(grep -o "coherentpdf@[0-9][0-9.]*" src/js/utils/wasm-provider.ts | head -1 | cut -d@ -f2)
for v in PYMUPDF_VERSION GS_VERSION TESSERACT_VERSION TESSERACT_CORE_VERSION CPDF_VERSION; do
  [ -n "${!v}" ] || die "could not determine $v from upstream"
done
info "pymupdf $PYMUPDF_VERSION | gs $GS_VERSION | cpdf $CPDF_VERSION | tesseract.js $TESSERACT_VERSION (core $TESSERACT_CORE_VERSION)"

# --- 3. normalise OCR languages (validate against upstream's list) -----------
OCR_LANGUAGES="${OCR_LANGUAGES// /}"
IFS=',' read -r -a LANGS <<< "$OCR_LANGUAGES"
for l in "${LANGS[@]}"; do
  grep -q "'$l'\|\b$l:" src/js/config/tesseract-languages.ts || die "unsupported OCR language: $l"
done

# --- 4. install deps ---------------------------------------------------------
if [ "$SKIP_INSTALL" != true ]; then
  info "npm ci $NPM_CI_FLAGS"
  # shellcheck disable=SC2086
  HUSKY=0 npm ci $NPM_CI_FLAGS
fi

# --- 5. download WASM packages into the cache (skipped when cached) ----------
mkdir -p "$CACHE_DIR/ocr-langdata" "$CACHE_DIR/ocr-fonts"
pack() { # name@version -> tgz in cache
  local spec="$1" name f
  name=$(echo "$1" | sed 's#^@##; s#/#-#; s#@#-#')
  f="$CACHE_DIR/$name.tgz"
  if [ ! -f "$f" ]; then
    info "downloading $spec"
    local t; t=$(mktemp -d)
    (cd "$t" && npm pack "$spec" --quiet >/dev/null) || die "npm pack $spec failed"
    mv "$t"/*.tgz "$f"; rm -rf "$t"
  fi
  echo "$f"
}
PYMUPDF_TGZ=$(pack "@bentopdf/pymupdf-wasm@$PYMUPDF_VERSION")
GS_TGZ=$(pack "@bentopdf/gs-wasm@$GS_VERSION")
CPDF_TGZ=$(pack "coherentpdf@$CPDF_VERSION")
TESS_TGZ=$(pack "tesseract.js@$TESSERACT_VERSION")
CORE_TGZ=$(pack "tesseract.js-core@$TESSERACT_CORE_VERSION")

for l in "${LANGS[@]}"; do
  f="$CACHE_DIR/ocr-langdata/$l.traineddata.gz"
  [ -f "$f" ] || { info "downloading OCR language data: $l"
    curl -fsSL "https://cdn.jsdelivr.net/npm/@tesseract.js-data/$l/$TESSDATA_VERSION/$l.traineddata.gz" -o "$f.part" \
      && mv "$f.part" "$f" || die "failed to download $l"; }
done

# OCR fonts: same resolution as prepare-airgap.sh (Noto Sans + per-language family)
FONT_MANIFEST=$(node -e "const fs=require('fs');const src=fs.readFileSync(process.argv[1],'utf8');const sel=(process.argv[2]||'').split(',').filter(Boolean);const s=src.split('export const fontFamilyToUrl');const l2f={},f2u={};let m;const lp=/^\s*([a-z_]+):\s*'([^']+)',/gm;while((m=lp.exec(s[0]))!==null)l2f[m[1]]=m[2];const fp=/^\s*'([^']+)':\s*'([^']+)',/gm;while((m=fp.exec(s[1]||''))!==null)f2u[m[1]]=m[2];const fam=new Set(['Noto Sans']);for(const x of sel)fam.add(l2f[x]||'Noto Sans');process.stdout.write(Array.from(fam).sort().map(f=>{const u=f2u[f]||f2u['Noto Sans'];return f+'\t'+u+'\t'+u.split('/').pop()}).join('\n'))" src/js/config/font-mappings.ts "$OCR_LANGUAGES")
[ -n "$FONT_MANIFEST" ] || die "could not resolve OCR fonts"
while IFS=$'\t' read -r fam url file; do
  [ -z "$file" ] && continue
  f="$CACHE_DIR/ocr-fonts/$file"
  [ -f "$f" ] || { info "downloading OCR font: $fam"
    curl -fsSL "$url" -o "$f.part" && mv "$f.part" "$f" || die "failed to download font $fam"; }
done <<< "$FONT_MANIFEST"

# Edit PDF fallback fonts (upstream: src/js/config/editor-fonts.ts, VITE_EMBEDPDF_FONTS_URL)
IFS=',' read -r -a FONT_PACKS <<< "${EMBEDPDF_FONT_PACKS// /}"
for p in "${FONT_PACKS[@]}"; do
  [ -z "$p" ] && continue
  ver=$(grep -o "fonts-$p@[0-9][0-9.]*" src/js/config/editor-fonts.ts | head -1 | cut -d@ -f2)
  [ -n "$ver" ] || die "unknown EMBEDPDF font pack: $p"
  pack "@embedpdf/fonts-$p@$ver" >/dev/null
done

# --- 6. vite build with same-origin asset URLs -------------------------------
export BASE_URL SIMPLE_MODE DISABLE_GITHUB_STARS SITE_URL DISABLE_TOOLS
export VITE_BRAND_NAME VITE_FOOTER_TEXT VITE_DEFAULT_LANGUAGE
if [ -n "$BRAND_LOGO_FILE" ]; then VITE_BRAND_LOGO="brand/$(basename "$BRAND_LOGO_FILE")"; fi
export VITE_BRAND_LOGO
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

tar xzf "$PYMUPDF_TGZ" -C "$W/pymupdf" --strip-components=1
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir "$T/gs" "$T/cpdf" "$T/tess"
tar xzf "$GS_TGZ" -C "$T/gs"
if [ -d "$T/gs/package/assets" ]; then cp -a "$T/gs/package/assets/." "$W/gs/"; else cp -a "$T/gs/package/." "$W/gs/"; fi
tar xzf "$CPDF_TGZ" -C "$T/cpdf"
if [ -d "$T/cpdf/package/dist" ]; then cp -a "$T/cpdf/package/dist/." "$W/cpdf/"; else cp -a "$T/cpdf/package/." "$W/cpdf/"; fi
tar xzf "$TESS_TGZ" -C "$T/tess"
cp "$T/tess/package/dist/worker.min.js" "$W/ocr/worker.min.js"
tar xzf "$CORE_TGZ" -C "$W/ocr/core" --strip-components=1
for l in "${LANGS[@]}"; do cp "$CACHE_DIR/ocr-langdata/$l.traineddata.gz" "$W/ocr/lang-data/"; done
while IFS=$'\t' read -r _ _ file; do [ -n "$file" ] && cp "$CACHE_DIR/ocr-fonts/$file" "$W/ocr/fonts/"; done <<< "$FONT_MANIFEST"

for p in "${FONT_PACKS[@]}"; do
  [ -z "$p" ] && continue
  ver=$(grep -o "fonts-$p@[0-9][0-9.]*" src/js/config/editor-fonts.ts | head -1 | cut -d@ -f2)
  mkdir -p "$W/embedpdf-fonts/fonts-$p@$ver"
  tar xzf "$(pack "@embedpdf/fonts-$p@$ver")" -C "$W/embedpdf-fonts/fonts-$p@$ver" --strip-components=1
done

# Trim package payload that is not needed at runtime (sources, build scripts, tests)
rm -rf "$W/pymupdf/build_scripts" "$W/ocr/core/package.json" 2>/dev/null || true

if [ -n "$BRAND_LOGO_FILE" ]; then
  mkdir -p "$OUT_DIR/brand"; cp "$BRAND_LOGO_FILE" "$OUT_DIR/brand/"
fi

# Separately licensed products (see NOTICE): not shipped. Upstream v2.8.10 only
# has marketing pages for them (no code/WASM); remove them from the bundle.
find "$OUT_DIR" \( -name 'kura.html*' -o -name 'hyper-compress.html*' \) -type f -delete
rm -rf "$OUT_DIR/kura" "$OUT_DIR/hyper-compress"
if [ "$KEEP_BROTLI" != true ]; then find "$OUT_DIR" -name '*.br' -type f -delete; fi

# LibreOffice WASM ships inside upstream public/ and is already in dist.
[ -f "$OUT_DIR/libreoffice-wasm/soffice.wasm.gz" ] || die "libreoffice-wasm missing from dist"

info "done: $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1))"
