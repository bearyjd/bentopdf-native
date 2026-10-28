# Local bundle (M1)

An offline build of upstream BentoPDF (pinned in `UPSTREAM_VERSION`) in Simple
Mode, with every WASM/OCR/font asset served same-origin from the app itself.
The *build* needs network (npm, jsDelivr for tessdata/fonts, GitHub); the
*output* does not.

```
scripts/fetch-upstream.sh     # clone tag into ./upstream, git apply --check + apply patches/*.patch
scripts/build-local.sh        # fetch + npm ci + vite build + assemble ./dist
scripts/verify-offline.sh     # list external http(s) URLs left in ./dist
```

`fetch-upstream.sh` is idempotent: if `./upstream` exists it is hard-reset to the
tag (build artifacts and previously applied patches are dropped, ignored
`node_modules/` is kept) and patches are re-applied. There are currently **zero
patches**: nothing in upstream v2.8.10 needed one (see "Hyper Compress / Kura").

## Build flags

All are environment variables of `scripts/build-local.sh`.

| Variable | Default | Effect |
|---|---|---|
| `SIMPLE_MODE` | `true` | Upstream Simple Mode: tools-only UI (`simple-index.html` becomes `index.html`). |
| `DISABLE_GITHUB_STARS` | `true` | Removes the GitHub stars fetch. |
| `VITE_BRAND_NAME` | empty | Brand name in UI. |
| `VITE_BRAND_LOGO` | empty | Logo path relative to dist root (upstream resolves it as `BASE_URL + value`). |
| `BRAND_LOGO_FILE` | empty | Local file copied to `dist/brand/` and used as `VITE_BRAND_LOGO`. |
| `VITE_FOOTER_TEXT` | empty | Footer text. |
| `VITE_DEFAULT_LANGUAGE` | empty | Default UI language (en, fr, de, ...). |
| `DISABLE_TOOLS` | empty | Comma list of tool ids to hide (upstream flag). |
| `BASE_URL` | `/` | Mount path of the app; must start with `/`. WASM URLs become `${BASE_URL}wasm/...`. |
| `OCR_LANGUAGES` | `eng` | Tesseract codes; downloads `<lang>.traineddata.gz` (`TESSDATA_VERSION`, default `4.0.0_best_int`), the matching OCR fonts, and sets `VITE_TESSERACT_AVAILABLE_LANGUAGES`. |
| `EMBEDPDF_FONT_PACKS` | `latin,arabic,hebrew` | `@embedpdf/fonts-*` packs for Edit PDF fallback fonts, hosted at `wasm/embedpdf-fonts` via `VITE_EMBEDPDF_FONTS_URL`. Add `jp,kr,sc,tc` for CJK (about +145 MB unpacked). |
| `SITE_URL` | `https://www.bentopdf.com` | Canonical/sitemap metadata only. Upstream's `seo-audit` fails the build if changed, so leave it. |
| `KEEP_BROTLI` | `false` | Upstream's vite config always writes `.br` sidecars; they are deleted unless `true`. |
| `NPM_CI_FLAGS` | `--allow-remote=root` | npm 12 refuses upstream's `xlsx` tarball URL (`cdn.sheetjs.com`) by default; this allows only root-declared URLs. npm 10/11 ignores it harmlessly. |
| `SKIP_FETCH` / `SKIP_INSTALL` | `false` | Reuse the existing `./upstream` / `node_modules`. |
| `UPSTREAM_DIR`, `OUT_DIR`, `CACHE_DIR` | `./upstream`, `./dist`, `./.cache/wasm` | Locations. Downloads are cached and reused. |

Fixed by the script (set as env for vite, all same-origin, root-relative):

```
VITE_WASM_PYMUPDF_URL=/wasm/pymupdf/      VITE_WASM_GS_URL=/wasm/gs/
VITE_WASM_CPDF_URL=/wasm/cpdf/            VITE_TESSERACT_WORKER_URL=/wasm/ocr/worker.min.js
VITE_TESSERACT_CORE_URL=/wasm/ocr/core    VITE_TESSERACT_LANG_URL=/wasm/ocr/lang-data
VITE_OCR_FONT_BASE_URL=/wasm/ocr/fonts    VITE_EMBEDPDF_FONTS_URL=/wasm/embedpdf-fonts
VITE_USE_CDN=false
```

Asset versions come from upstream at build time (same sources as
`scripts/prepare-airgap.sh`): PyMuPDF/Ghostscript from
`src/js/const/cdn-version.ts`, tesseract.js/-core from `package-lock.json`.
CoherentPDF is pinned to the version in upstream's CDN default
(`wasm-provider.ts`, 2.5.5); airgap script takes npm `latest` instead.
LibreOffice WASM is committed in upstream `public/libreoffice-wasm/` and loaded
from `BASE_URL`, so it is already same-origin.

Assets are copied into `dist/` after the vite build, not into `upstream/public`,
so the upstream checkout stays pristine for its own build/test.

## Hyper Compress / Kura

At v2.8.10 nothing imports `hyper-compress-wasm` (grep of `src/`,
`package.json`, `package-lock.json` is empty; `src/js/utils/compress.ts` has no
such import, contrary to the earlier roadmap note). Upstream only has the
`kura.html` and `hyper-compress.html` marketing pages (purchase links), plus
navbar links. The build removes all copies of those pages from `dist`
(including per-locale ones). The navbar entries stay and 404; harmless, and
removing them would need a patch. Re-check this on every `UPSTREAM_VERSION` bump.

## Verification of upstream defaults (patched checkout = unpatched, 0 patches)

Run in `./upstream` on Node v22.22.2 / npm 12.2.0, default flags, after
`npm ci --allow-remote=root`:

| Command | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npm run lint` | pass |
| `npm run test:run` | pass: 57 files, 990 tests |
| `npm run build` (incl. tsc, SEO audit) | pass, about 170 s ("3083 HTML files passed") |

Note: upstream's default build rewrites tracked files (`blog/*.html`,
`src/partials/tool-links-static.html`, `security-headers*.conf`, `public/_headers`).
`fetch-upstream.sh` resets them.

## Size report (default `OCR_LANGUAGES=eng`, default font packs)

`du -sh dist` = **368 MB**.

| Path | Size |
|---|---|
| `wasm/` | 132 MB |
| `libreoffice-wasm/` | 75 MB |
| `assets/` (app JS/CSS/wasm) | 36 MB |
| `pdfjs-annotation-viewer/` | 21 MB |
| `pdfjs-viewer/` | 14 MB |
| 3043 HTML pages (22 locales x ~138 pages) | 76 MB |

`wasm/` breakdown: pymupdf 54 MB (pyodide + wheels), ocr 47 MB (core 44 MB,
eng 2.9 MB, fonts 0.6 MB), gs 15 MB, embedpdf-fonts 12 MB, cpdf 5.3 MB.

Largest files: `libreoffice-wasm/soffice.wasm.gz` 46.5 MB, `soffice.data.gz`
27.3 MB, pymupdf wheel 16.4 MB, `gs.wasm` 14.8 MB, opencv wheel 11.2 MB, numpy
wheel 11.2 MB, `pyodide.asm.wasm` 8.2 MB, `assets/editcore-*.wasm` 7.0 MB,
`assets/vips-*.wasm` 5.6 MB, three tesseract-core `.wasm.js` 4.5 MB each.

Easy savings (not done): `ocr/core` ships 12 tesseract-core variants (all of
simd/relaxedsimd/lstm); localized HTML is 76 MB of the total.

## External URLs (`scripts/verify-offline.sh`)

HTML is scanned only inside resource-loading tags (not `<a href>`, canonical,
hreflang, JSON-LD); JS/CSS/JSON are scanned fully. Skipped as engine runtime:
`wasm/pymupdf`, `wasm/gs`, `wasm/ocr/core`, `libreoffice-wasm`, `pdfjs-*viewer`.
Remaining after noise filtering, classified (none patched):

| URL | Where | Verdict |
|---|---|---|
| `cdn.jsdelivr.net/npm/{@bentopdf/pymupdf-wasm,@bentopdf/gs-wasm,coherentpdf}...` | `wasm-provider` chunk | Dead default; overridden by `VITE_WASM_*_URL`. |
| `cdn.jsdelivr.net/npm/tesseract.js*`, `@tesseract.js-data` | `tesseract-runtime` chunk, `wasm/ocr/worker.min.js` | Dead defaults; overridden by `VITE_TESSERACT_*`. |
| `rawcdn.githack.com/.../Noto*.ttf` (33) | `font-loader` chunk | Dead defaults; overridden by `VITE_OCR_FONT_BASE_URL`. Only the selected languages' fonts are shipped. |
| `cdn.jsdelivr.net/npm/@embedpdf/fonts-*` | `worker-engine` chunk | Overridden by `VITE_EMBEDPDF_FONTS_URL` for shipped packs; CJK packs not shipped by default, so CJK fallback in Edit PDF fails offline. |
| `cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.9.1/dist/pdfium.wasm` | `embedpdf-*` chunk | Library default. Edit PDF passes its own vendored `editcore.wasm` (`edit-pdf-page.ts`), so expected unused. NOT verified in a browser. |
| `fonts.googleapis.com/css2?family=Open+Sans` | `@import` inside embedpdf CSS | Real request from the Edit PDF viewer UI; fails soft (cosmetic font). Non-essential, not patched. |
| `bentopdf-cors-proxy.bentopdf.workers.dev` | `digital-sign-pdf` chunk | Online-only (fetching remote certificates/timestamps); inactive until used. |
| `cdnjs.cloudflare.com/.../pdfobject` | jspdf-autotable chunk | Library comment/dead code. |
| `_headers` CSP entries (jsdelivr, googleapis, gstatic, githack) | generated headers | Allow-list text, not requests. |
| remaining: library comments (chevrotain, cpdf, xlsx namespaces, MDN, etc.) | vendored libs | Not requests. |

Localized/marketing pages contain `<a>` links to bentopdf.com, GitHub, etc.;
those are navigation, not fetches, and are not counted.

## Not verified

- No browser run: same-origin loading by workers is inferred from source and
  `curl` 200s against a static server, not executed. Root-relative URLs
  (`/wasm/...`) are assumed to resolve inside PyMuPDF/Ghostscript/Tesseract
  dynamic imports and workers; M2 (Electron, `crossOriginIsolated`) is where
  this gets proven. If a blob-URL worker fails to resolve them, the fix is a
  small patch resolving env URLs against `location.origin`.
- Upstream `pymupdf-wasm`'s RGB conversion path imports `<gs>/dist/index.js`,
  which does not exist in the GS layout (`gs.js` at root) used by both upstream's
  airgap script and this build. Pre-existing upstream behavior.
- Service worker behaviour offline (`sw.js` precache) was not exercised.
- License status of LibreOffice WASM and `bentopdf-pdfium`/`bentopdf-viewer`
  remains UNVERIFIED (see NOTICE).
