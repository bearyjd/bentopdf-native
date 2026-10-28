# Local bundle (M1)

An offline build of upstream BentoPDF (pinned in `UPSTREAM_VERSION`) in Simple
Mode, with every WASM/OCR/font asset served same-origin from the app itself.
The *build* needs network (npm, jsDelivr for tessdata/fonts, GitHub); the
*output* does not.

```
scripts/fetch-upstream.sh     # clone tag into ./upstream, verify commit, apply patches/*.patch
scripts/build-local.sh        # fetch + npm ci --ignore-scripts + vite build + assemble ./dist + gates
scripts/build-local.sh --update-checksums   # re-download artifacts, rewrite scripts/checksums.sha256, print diff, stop
scripts/check-dist.sh         # hard assertions on ./dist (excluded products, source offer, CSP)
scripts/verify-offline.sh     # gate: external hosts in ./dist must be in scripts/offline-allowlist.txt
```

`fetch-upstream.sh` is idempotent: if `./upstream` exists it is re-fetched
(tag forced, never trusted from the local clone), hard-reset and cleaned
(build artifacts and previously applied patches are dropped, ignored
`node_modules/` is kept) and patches are re-applied. There are currently **zero
patches**: nothing in upstream v2.8.10 needed one (see "Hyper Compress / Kura").

## Supply chain and integrity

- **Upstream pin.** `UPSTREAM_VERSION` is the tag; `UPSTREAM_COMMIT` is the
  commit it must peel to (`git ls-remote ... refs/tags/v2.8.10^{}`). After
  checkout the script requires `git rev-parse HEAD^{commit}` to equal it and
  aborts otherwise, so a moved or re-pointed tag cannot change the build input.
- **Destructive git guard.** `reset --hard` / `clean -fd` run only if the
  checkout's `origin` equals `UPSTREAM_REPO` and `./upstream/.git/upstream-managed`
  exists (written when the script clones). A directory without it is refused.
  A checkout that predates this marker needs `touch upstream/.git/upstream-managed` once.
- **npm lifecycle scripts are disabled**: `npm ci --ignore-scripts` (upstream
  code and every dependency is untrusted at build time). The lockfile lists
  install scripts only for `core-js` (donation banner), `rete`, `tesseract.js`
  (funding banner), two nested `esbuild` copies (binary self-check/optimisation)
  and `fsevents` (macOS); none is needed, the full build passes without them
  (see Verification). Husky's `prepare` is also skipped.
- **`--allow-remote=root` is still required**: npm 12 refuses upstream's
  `xlsx` dependency, a tarball URL (`https://cdn.sheetjs.com/xlsx-0.20.3/...`),
  unless the root package declares it. The flag only admits URLs declared in
  upstream's own `package.json`; the lockfile `integrity` (sha512) still
  applies. npm 10/11 do not know this option and may print a warning.
- **Downloads are checksummed.** `scripts/checksums.sha256` pins SHA-256 for
  every downloaded artifact: the npm-packed tarballs (pymupdf, gs, cpdf,
  tesseract.js/-core, embedpdf font packs), `@tesseract.js-data/<lang>@1.0.0`
  traineddata and the OCR font. A file is verified before it enters the cache
  and again on every cache hit; mismatch deletes the cache entry and aborts.
  A download without a pinned entry also aborts. Files are additionally
  checked with `gzip -t` / `tar tzf`; tarballs with absolute or `..` members
  or any link member are rejected, and extraction uses `--no-same-owner`.
  curl uses `--proto '=https' --proto-redir '=https' --tlsv1.2`.
  The committed checksums cover the default selection only
  (`OCR_LANGUAGES=eng`, default font packs, `latin,arabic,hebrew`). For other
  languages/packs run `scripts/build-local.sh --update-checksums`, review the
  printed diff, and commit it: that step is trust-on-first-use (the first
  checksums were cross-checked against files cached by an earlier build).
- `@tesseract.js-data/<lang>` is pinned to an exact version
  (`TESSDATA_PKG_VERSION`, default `1.0.0`), no floating `latest`.

## Build flags

All are environment variables of `scripts/build-local.sh`.

| Variable | Default | Effect |
|---|---|---|
| `SIMPLE_MODE` | `true` | Upstream Simple Mode: tools-only UI (`simple-index.html` becomes `index.html`). |
| `DISABLE_GITHUB_STARS` | `true` | Removes the GitHub stars fetch. |
| `VITE_BRAND_NAME` | empty | Brand name in UI (max 200 chars, no control characters). Upstream escapes it (handlebars `{{ }}`, `JSON.stringify`, `textContent`), so the script does not re-escape it. |
| `VITE_BRAND_LOGO` | empty | Logo path relative to dist root (upstream resolves it as `BASE_URL + value`). |
| `BRAND_LOGO_FILE` | empty | Local file (must exist, name `[A-Za-z0-9._-]+`, not inside `OUT_DIR`); copied to a temp dir first, then to `dist/brand/`, and used as `VITE_BRAND_LOGO`. |
| `VITE_FOOTER_TEXT` | empty | Footer text. |
| `VITE_DEFAULT_LANGUAGE` | empty | Default UI language (en, fr, de, ...). |
| `DISABLE_TOOLS` | empty | Comma list of tool ids to hide (upstream flag). |
| `BASE_URL` | `/` | Mount path of the app; must match `^/[A-Za-z0-9/_.-]*$` (no `..`). WASM URLs become `${BASE_URL}wasm/...`. |
| `OCR_LANGUAGES` | `eng` | Tesseract codes (`^[a-z0-9_]+$`, exact match against upstream's language list); downloads `<lang>.traineddata.gz` (`TESSDATA_VERSION`, default `4.0.0_best_int`, from `@tesseract.js-data/<lang>@TESSDATA_PKG_VERSION`), the matching OCR fonts, and sets `VITE_TESSERACT_AVAILABLE_LANGUAGES`. |
| `EMBEDPDF_FONT_PACKS` | `latin,arabic,hebrew` | `@embedpdf/fonts-*` packs for Edit PDF fallback fonts, hosted at `wasm/embedpdf-fonts` via `VITE_EMBEDPDF_FONTS_URL`. Add `jp,kr,sc,tc` for CJK (about +145 MB unpacked). |
| `SITE_URL` | `https://www.bentopdf.com` | Canonical/sitemap metadata only. Upstream's `seo-audit` fails the build if changed, so leave it. |
| `KEEP_BROTLI` | `false` | Upstream's vite config always writes `.br` sidecars; they are deleted unless `true`. |
| `NPM_CI_FLAGS` | `--allow-remote=root` | Extra flags for `npm ci --ignore-scripts`; see "Supply chain and integrity". |
| `SKIP_FETCH` / `SKIP_INSTALL` | `false` | Reuse the existing `./upstream` / `node_modules`. |
| `UPSTREAM_DIR`, `OUT_DIR`, `CACHE_DIR` | `./upstream`, `./dist`, `./.cache/wasm` | Locations, canonicalised with `realpath` before anything is deleted. `OUT_DIR` is refused if empty, `/`, `$HOME`, the repo root, an ancestor of the repo/upstream/cache, or inside upstream/cache; an existing non-empty `OUT_DIR` must contain `index.html`. |

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
(including per-locale ones) and their `<url>` entries from `dist/sitemap.xml`.

**Known remaining defect:** the navbar and some legal pages still contain links
to `/kura` and `/hyper-compress`; in the bundle they are dead links (404).
Removing them would need a patch of upstream templates; the patch budget (<=5
project-wide, currently 0 used) is kept for things that cannot be done in the
build script, so this is left as is.

`scripts/check-dist.sh` runs at the end of every build and fails it if
`grep -ril hyper-compress-wasm dist` is non-empty, if any file name contains
`kura` or `hyper-compress`, or if the sitemap still lists those pages. It can
be run on its own against any directory. Re-check this on every
`UPSTREAM_VERSION` bump.

## Licence compliance output (AGPL)

Every build writes `dist/SOURCE.txt` (this repository URL and commit with a
dirty-tree flag, upstream repo/tag/commit, patch count, build date, licence,
bundled component versions) and copies `LICENSE` and `NOTICE` into `dist/`.
`check-dist.sh` fails the build if any of the three is missing. If the tree was
dirty, `SOURCE.txt` says the commit does not reproduce the bundle: do not
distribute such a build. `NOTICE` licence lines come from package metadata;
lines that cannot be resolved that way are marked NEEDS REVIEW.

## Runtime network policy (generated `_headers`)

The build rewrites every `Content-Security-Policy:` line in `dist/_headers`:
all `https://...` origins are removed, `connect-src` becomes
`'self' blob:`, `font-src` `'self' data:`, `style-src` `'self' 'unsafe-inline'`,
and the bare `https:` scheme is dropped from `img-src`. Kept deliberately:
`blob:` in `connect-src` (the app fetches object URLs of user files),
`'unsafe-inline'` in `style-src` (inline style attributes), `'wasm-unsafe-eval'`
and `'unsafe-eval'` in `script-src` (inherited from upstream; WASM engines).
`check-dist.sh` fails if any CSP line still contains `http:`/`https:`.

Two third-party calls exist in upstream code and are **not patched**:

- Digital Sign: `bentopdf-cors-proxy.bentopdf.workers.dev` (plus user-selectable
  RFC 3161 timestamp servers such as freetsa.org, digicert, sectigo) for fetching
  remote certificates/OCSP/timestamps. This leaks certificate and request
  metadata to those hosts when the user uses such features.
- Edit PDF: a CSS `@import` of `fonts.googleapis.com` (Open Sans), which leaks
  the client IP to Google.

Both are blocked by the CSP above **in hosts that honour `_headers`**
(Cloudflare Pages/Netlify style). They are **not verified in a browser**, and a
plain static server or the future Electron shell ignores `_headers`: M2 must
apply an equivalent CSP itself (e.g. session `webRequest`/response headers).
Features that need those hosts (remote signing certificates, trusted
timestamps, the Google font) will fail under this policy.

## Verification of upstream defaults (patched checkout = unpatched, 0 patches)

Run in `./upstream` on Node v22.22.2 / npm 12.2.0, default flags, after
`npm ci --allow-remote=root` (the build script itself now adds `--ignore-scripts`; the table below was measured before that change):

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

This is a gate, not a report. `STRICT=1` (default, and what `build-local.sh`
runs) exits non-zero for any external host that `scripts/offline-allowlist.txt`
does not cover; `STRICT=0` only reports. The allowlist is committed, one entry
per line: `host<TAB>file regex<TAB>reason`; a hit passes only if host and file
both match. A new host, or a known host in a new file, fails the build until it
is reviewed and added with a reason.

Scope: HTML is scanned only inside resource-loading tags (not `<a href>`,
canonical, hreflang, JSON-LD); JS/CSS/JSON/SVG/`_headers` are scanned fully.
The vendored engine directories (`wasm/pymupdf`, `wasm/gs`, `wasm/ocr/core`,
`libreoffice-wasm`, `pdfjs-*viewer`) are now scanned too, but only hosts that
look like CDN/API hosts (`cdn`, `jsdelivr`, `githack`, `googleapis`, `gstatic`,
`cloudflare`, `workers.dev`, ...) are reported there, because the engines are
full of documentation links. Non-CDN hosts inside the engines are therefore NOT
checked, and binary/compressed files (`.wasm`, `.gz`, `.data`) are not scanned
at all. This is a static string scan; it cannot prove the absence of requests
built at runtime.

Entries that can become real requests (all unpatched; CSP-blocked only in hosts
that honour `_headers`, not verified in a browser):

| URL | Where | Verdict |
|---|---|---|
| `cdn.jsdelivr.net/npm/{@bentopdf/pymupdf-wasm,@bentopdf/gs-wasm,coherentpdf}...` | `wasm-provider` chunk | Dead default; overridden by `VITE_WASM_*_URL`. |
| `cdn.jsdelivr.net/npm/tesseract.js*`, `@tesseract.js-data` | `tesseract-runtime` chunk, `wasm/ocr/worker.min.js` | Dead defaults; overridden by `VITE_TESSERACT_*`. |
| `rawcdn.githack.com/.../Noto*.ttf` (33) | `font-loader` chunk | Dead defaults; overridden by `VITE_OCR_FONT_BASE_URL`. Only the selected languages' fonts are shipped. |
| `cdn.jsdelivr.net/npm/@embedpdf/fonts-*` | `worker-engine` chunk | Overridden by `VITE_EMBEDPDF_FONTS_URL` for shipped packs; CJK packs not shipped by default, so CJK fallback in Edit PDF fails offline. |
| `cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.9.1/dist/pdfium.wasm` | `embedpdf-*` chunk | Library default. Edit PDF passes its own vendored `editcore.wasm` (`edit-pdf-page.ts`), so expected unused. NOT verified in a browser. |
| `cdn.jsdelivr.net/pyodide/...` | `wasm/pymupdf/assets/pyodide.js` | Pyodide package CDN fallback; PyMuPDF ships its packages locally. NOT verified. |
| `cdn.jsdelivr.net` | `sw.js` `trustedCdnOrigins` | Service worker caching policy for that origin, not a request by itself. |
| `fonts.googleapis.com/css2?family=Open+Sans` | `@import` in embedpdf bundle | REAL request from the Edit PDF viewer (leaks IP). Cosmetic font; blocked by the CSP above. |
| `bentopdf-cors-proxy.bentopdf.workers.dev`, timestamp servers (freetsa.org, digicert, sectigo, apple, entrust, mesign, ssl.com) | `digital-sign-pdf` chunk | REAL requests when signing with remote certs/timestamps (leak metadata); inactive until used. |

Everything else in the allowlist is a documentation link, XML namespace or
package-metadata string inside vendored code (chevrotain, SheetJS, coherentpdf
comments, i18next messages, ...), each with its file pattern in
`scripts/offline-allowlist.txt`. The generated `_headers` CSP no longer
contains any external origin, so it needs no allowlist entries.

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
- Licences: `NOTICE` now uses package metadata where it exists. Still NEEDS
  REVIEW: the LibreOffice engine and its bundled components, the Noto Sans OCR
  font, tessdata models, upstream's other npm dependencies.
- The CSP rewrite and the "blocked by CSP" statements are not tested in a
  browser; `'unsafe-eval'`/`'unsafe-inline'` remain in the policy.
- The committed checksums are trust-on-first-use; `--update-checksums` needs
  review of its diff.

## Deferred to M2

- A headless-browser run with the network blocked (proving no request leaves
  the bundle and that engines resolve root-relative URLs).
- Serving with COOP/COEP (`crossOriginIsolated`) and the CSP outside `_headers` hosts.
- `BASE_URL` for a custom scheme (Electron privileged scheme); the current
  validation only accepts a path.
- Removing the dead `/kura` and `/hyper-compress` links (needs a patch).
