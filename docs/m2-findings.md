# M2 findings: Electron shell, transport experiment

Measured on one Linux machine (Fedora/Bazzite, Node 22, Electron 45.1.0 /
Chromium 156), against `./dist` built by M1 (BentoPDF v2.8.10, 0 patches).
Reproduce: `cd desktop && npm install && npm test` (33 tests: 13 unit,
10 Electron scenarios per transport; full run about 5 minutes).

Everything below was run with `--ozone-platform=headless`, not in a visible
window (see "Display caveat"). Anything not listed as passed is NOT VERIFIED.

## Decision

**Transport A, the privileged `bento://app` scheme, is the default.** Both
transports passed every scenario, so the choice rests on secondary evidence:

- A has no listening socket and no random port. B's origin changes every
  launch, which resets origin-scoped storage (IndexedDB, localStorage) each time
  (follows from how origins work; not separately tested).
- B showed `net::ERR_CACHE_MISS` on font files on the merge page (5 events in the final run,
  page still loaded); A showed none.
- A needs no Host/Origin filtering; B needs it (implemented).
- A's cost: service workers are unavailable (next section), which is fine
  offline: `sw.js` only precaches.

## Transport comparison

| Check | A: `bento://app` | B: `http://127.0.0.1:<random>` |
|---|---|---|
| `window.crossOriginIsolated === true` | pass | pass |
| `typeof SharedArrayBuffer === 'function'`, Atomics via a worker | pass | pass |
| COOP `same-origin`, COEP `require-corp` (bundle uses `credentialless`; not needed) | pass | pass |
| CSP from `dist/_headers` applied, `connect-src` blocks `data:` and external | pass | pass |
| blob Worker `importScripts(<absolute same-origin /wasm/...>)` | pass | pass |
| blob Worker `importScripts('/wasm/...')` (root-relative) | fails: "URL is invalid" | same |
| module Worker from `/assets/pdf.worker-*.js` | pass | pass |
| `.wasm` served as `application/wasm`; `Range` gives 206 with `Content-Range`; 416 when unsatisfiable | pass | pass |
| `soffice.wasm.gz` / `soffice.data.gz`: `application/gzip`, no `Content-Encoding` (the page inflates them itself with `DecompressionStream`) | pass | pass |
| 404 for unknown paths (serves `404.html`), 405 for POST | pass | pass |
| Traversal (`%2e%2e`, `..%2f`, `%5c`, NUL, bad escapes) all 404; symlink out of root 404 (unit test) | pass | pass |
| Page `sw.js` registration | not available (see below) | not attempted by the page (see below) |
| Merge PDF page, 4 s idle: external requests | 0 | 0 |
| Handoff of a real `File` into `<input type=file>` | pass | pass |
| Word to PDF via LibreOffice WASM | pass | pass |
| OCR | pass | pass |
| 112 MiB PDF | pass | pass |

Root-relative worker URLs are a property of blob workers, not of the
transports: a blob worker has no usable base for `/...`. The Tesseract worker
already receives absolute URLs and works, so no patch was needed for OCR.

### Service worker

- Scheme + `allowServiceWorkers: true`: registration succeeds, but then every
  `Cache.put()` in `sw.js` rejects (the Cache API refuses non-http(s) URLs),
  so every cacheable asset fetch (`.js`, `.wasm`, `/assets/`) fails with
  "Failed to fetch" once the worker controls the page. Observed: pdf.js worker
  load failed, "Merge PDF" file list never rendered. The privilege is
  therefore OFF (`registerScheme({ allowServiceWorkers: false })`); the page's
  own registration logs one `[SW] Service Worker registration failed` console
  error, harmless.
- Loopback HTTP: upstream's `sw-register.ts` treats hostname `127.0.0.1` or
  any non-empty port as development and skips registration, so the page never
  registers. Registering `/sw.js` manually works and the controlled page still
  loads assets (200). NOT VERIFIED: offline precache behaviour of `sw.js`.

## What passed (both transports unless noted)

- Isolation, workers, headers, traversal, 404/405, permission denial
  (`geolocation` denied), `window.open` denied, `location.href` to an external
  URL blocked, external `fetch` fails, `readFile` with an unissued token or a
  forged UUID rejected, no Node globals in the page.
- Merge PDF page: zero requests outside the app origin, no console errors,
  no app-origin 4xx/5xx.
- Handoff: the real path (native-dialog stub in main, token, `readFile` IPC,
  `File` + `DataTransfer` in the preload, `change` event) made Merge PDF list
  `two-page.pdf` with "Total: 2" pages.
- LibreOffice: generated `.docx` -> Word to PDF page -> download; output starts
  with `%PDF-`, 8,612 bytes. The text content of the PDF is NOT VERIFIED.
- OCR: PDF holding a rendered image of "BENTO OCR 2024" -> recovered text
  `BENTO OCR 2024`.
- 112 MiB, 300-page PDF through Page Dimensions: 300 pages reported, no crash.

## Memory (peak of the whole Electron process tree, 7 processes)

One Electron process runs all scenarios in sequence, so a later number can
include memory left by earlier scenarios. Treat them as upper bounds. Sampled
every 500 ms from `/proc` (RSS summed; PSS is the shared-page-aware figure).

| Scenario | A RSS / PSS (MiB) | B RSS / PSS (MiB) |
|---|---|---|
| LibreOffice docx -> PDF (first heavy scenario) | 1677 / 1261 | 1899 / 1475 |
| OCR, 1 page | 1434 / 1001 | 1562 / 1125 |
| 112 MiB PDF, page dimensions | 1446 / 1016 | 1505 / 1067 |

The earlier single-scenario runs gave LibreOffice 1828 MiB RSS and OCR 911 MiB
RSS (OCR alone), 100 MiB PDF alone 1270 MiB. Convert times are 1-4 s
once the page is loaded; they exclude the 46 MB `soffice.wasm.gz` first
fetch from disk. Multi-page OCR and bigger documents: NOT VERIFIED (M4).

## Display caveat (real windows)

In a real (non-headless) window on this machine `requestAnimationFrame` never
fires (0 frames; Wayland and XWayland both tried), which stalls pdf.js
rendering (OCR hung at "loading language traineddata" until this was
understood). Creating the window hidden and showing it on `ready-to-show`
helps navigation under headless, `hide()/show()` revived frames under XWayland,
but a plain Wayland window stayed at 0. Likely the compositor is not sending
frame callbacks (screen locked/idle?). NOT VERIFIED: that `npm start` shows a
working window. The user should run `cd desktop && npm start`, open Merge PDF
or OCR and confirm it renders. The automated suite therefore uses
`--ozone-platform=headless` (override with `BENTO_E2E_OZONE`).

## Upstream patches

None needed (patch budget stays at 0 of ~5). Possible later proposals, not
applied:

1. `sw-register.ts`: skip registration when `location.protocol` is not
   `http:`/`https:` (silences the one console error). Cosmetic.
2. Resolve `VITE_*` asset URLs against `location.origin` if any engine other than
   Tesseract turns out to use them inside a blob worker. PyMuPDF, Ghostscript,
   CPDF-in-worker and Edit PDF were not exercised: NOT VERIFIED.

## Not verified

- A visible window; macOS and Windows; packaging.
- Digital Sign (CORS proxy, timestamp servers) and Edit PDF (Google Fonts
  `@import`): the session hook cancels non-app requests and the CSP blocks
  them, but those pages were not driven.
- Tools other than Merge, Word to PDF, OCR, Page Dimensions.
- Native open/save dialogs (stubbed in tests); `saveFile` is untested.
- The 1 GiB IPC limit and large-file IPC memory behaviour.
