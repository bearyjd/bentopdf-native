# M2 findings: Electron shell, transport experiment

All numbers and results below come from ONE Linux machine (Fedora/Bazzite,
Node 22, Electron 45.1.0 / Chromium 156), against `./dist` built by M1
(BentoPDF v2.8.10, 0 patches). Reproduce: `cd desktop && npm install && npm test`
(59 tests: 35 unit, 2 entry-point, 22 Electron scenarios = 11 per transport,
each in its own fresh Electron process; about 12 minutes).

Everything was run with `--ozone-platform=headless`, never in a visible
window (see "Display caveat"). Anything not listed as passed is NOT VERIFIED.
M2 is not closed until a human confirms a visible window (ROADMAP, Open gates).

## Decision

**Transport A, the privileged `bento://app` scheme, is the default.** Both
transports passed every scenario, so the choice rests on secondary evidence:

- A has no listening socket and no random port. B's origin changes every
  launch, which resets origin-scoped storage (IndexedDB, localStorage) each time
  (follows from how origins work; not separately tested). B also needs a
  per-run cookie token and Host/Origin filtering (implemented); A needs neither.
- B showed `net::ERR_CACHE_MISS` on font files on the merge page; A showed
  none. The test tolerates exactly that on B, with the reason recorded.
- **`sw.js` is unproven on BOTH transports.** On A it cannot run at all (no
  service-worker privilege, by design). On B it registers, activates, controls
  the page after reload and assets still return 200 (asserted), but its
  caching and offline behaviour were never tested. This is not a problem for
  the desktop app: offline operation comes from the files on disk, not from
  `sw.js`. Whether `sw.js` matters for the PWA is M5.

## Transport comparison

| Check | A: `bento://app` | B: `http://127.0.0.1:<random>` |
|---|---|---|
| `window.crossOriginIsolated === true`, `SharedArrayBuffer`, Atomics via a worker | pass | pass |
| Response headers exactly COOP `same-origin`, COEP `require-corp`, CORP `same-origin` (asserted on the document and on `session.fetch`) | pass | pass |
| CSP from `dist/_headers` applied (shell-tightened, see CSP experiment) | pass | pass |
| blob Worker `importScripts(<absolute same-origin /wasm/...>)` | pass | pass |
| blob Worker `importScripts('/wasm/...')` (root-relative) | fails with "URL ... is invalid" (asserted) | same |
| module Worker straight from `/assets/pdf.worker-*.js` (success = the worker's own `ready` message) | pass | pass |
| `.wasm` as `application/wasm`; Range gives 206 + `Content-Range`; unsatisfiable gives 416; invalid Range ignored (200) | pass | pass |
| `soffice.wasm.gz`: `application/gzip`, no `Content-Encoding` | pass | pass |
| 404 for unknown paths, 405 for POST, traversal/NUL/backslash 404, `_headers`/dotfiles 404 | pass | pass |
| Merge PDF page, 4 s idle: external requests, console errors, HTTP/net errors (allowlist with reasons) | 0 | 0 plus tolerated font `ERR_CACHE_MISS` |
| Permission handlers (see below) | pass | pass |
| `sw.js` | cannot register (asserted: error "URL protocol ... not supported", not controlled) | register + activated + controls page after reload + assets 200 (asserted) |
| Handoff of a real `File` into `<input type=file>` (Merge PDF lists `two-page.pdf`, Total: 2) | pass | pass |
| Renderer killed: static error page shown, file bridge unusable from it | pass | pass |

Root-relative worker URLs are a property of blob workers, not of the
transports. The Tesseract worker already receives absolute URLs.

### Permissions

The bundle's `Permissions-Policy` already blocks geolocation/camera/mic before
the main process is asked, so geolocation proves nothing about the shell's
handler (an earlier version of this test accepted "position unavailable" as
denied). The test now probes `notifications` and `clipboard-read`, asserts the
page-visible answers, and asserts the main-process handler was invoked for both
and returned false every time.

### Service worker on the scheme

With `allowServiceWorkers: true`, registration succeeds but every `Cache.put()`
in `sw.js` rejects (the Cache API refuses non-http(s) URLs), so cacheable
asset fetches fail once the worker controls the page (observed earlier: pdf.js
worker load failed, Merge PDF list never rendered). The privilege is OFF and
pinned by a unit test. The page's own registration logs one
`[SW] Service Worker registration failed` console error, tolerated by name.
On B, upstream's `sw-register.ts` skips registration on `127.0.0.1`/ports; the
test registers `/sw.js` manually.

## What passed (both transports unless noted)

- Isolation with the shell's exact header values; workers; traversal; hidden
  files; 404/405; permission denial with the handler asserted; `window.open`
  denied; navigation to an external URL blocked; external `fetch` fails;
  `readFile` with an unissued token or forged UUID rejected; no Node globals.
- Merge PDF: zero requests outside the app origin, no unexpected console,
  HTTP or net errors.
- Word to PDF via LibreOffice WASM: download state `completed`, output starts
  with `%PDF-`, and the text extracted from the PDF with pdf.js contains the
  fixture sentence "BentoPDF desktop LibreOffice fixture". This proves one
  one-line paragraph converts; layout, fonts, tables and images are NOT VERIFIED.
- OCR: PDF holding a rendered image of "BENTO OCR 2024" -> recovered text.
- A 105 MiB payload, 300-page PDF (file size asserted within 1 MiB of target)
  through Page Dimensions: 300 pages reported.
- Also exercised during the CSP experiment (download completed): Compress PDF
  (Ghostscript), PDF to Markdown (PyMuPDF), Linearize PDF.

## CSP experiment

The bundle's CSP is `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:`.
Run with the shell stripping each source in turn (scheme transport):

| Change | Result |
|---|---|
| remove `'unsafe-eval'` (keep `'wasm-unsafe-eval'`) | Merge handoff (pdf.js), OCR, Ghostscript, PyMuPDF (PDF to Markdown), Linearize, workers, Page Dimensions on 105 MiB: all pass. **Word to PDF (LibreOffice) fails**: console `EvalError: Evaluating a string as JavaScript violates ... 'unsafe-eval' is not an allowed source`, then `ConversionError: WASM initialization timeout` after 300 s. |
| remove `blob:` from `script-src` (keep `unsafe-eval`; `worker-src` keeps `blob:`) | everything above passes, including LibreOffice. |

Result: the shell now serves `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`.
- `'unsafe-eval'`: kept, solely for LibreOffice WASM (evidence above). It is
  allowlisted with that reason in `desktop/src/headers.js`; any other
  `unsafe-eval`/`unsafe-inline` in `script-src` makes the shell refuse to serve.
  Follow-up: a per-page CSP would confine it to the Office-conversion pages.
- `'wasm-unsafe-eval'`: redundant while `'unsafe-eval'` is present (which also
  allows WebAssembly compilation); kept so dropping `unsafe-eval` later is a
  one-line change. Its removal was not tested alone.
- `blob:` in `script-src`: removed by the shell. Only the tools listed above
  were exercised; untested tools (about 120 pages) might need it back, and the
  fix is to re-add it with a failing test as evidence.
- `style-src 'unsafe-inline'`: left as shipped by the bundle; removal NOT tested.
- `/docs` has its own CSP in `_headers`; the shell applies only the `/*` block and
  refuses to start if `dist/docs` exists (it does not in this bundle).

## Memory (peak RSS / PSS of the Electron process tree, MiB)

Reported, not benchmarked: one run each on one machine, sampled every 500 ms
from `/proc`. Each scenario ran in a fresh Electron process, so these are
per-scenario (the earlier shared-process numbers were inflated by earlier
scenarios). The tests only assert a generous 4096 MiB RSS ceiling.

| Scenario | A RSS / PSS | B RSS / PSS |
|---|---|---|
| LibreOffice docx -> PDF (convert 2 s once loaded) | 1786 / 1401 | 1632 / 1228 |
| OCR, 1 page | 884 / 474 | 895 / 472 |
| 105 MiB, 300-page PDF, page dimensions | 1221 / 824 | 1221 / 820 |

Convert times exclude the 46 MB `soffice.wasm.gz` read from disk. Multi-page
OCR and bigger documents: NOT VERIFIED (M4).

## Display caveat (real windows)

In a real (non-headless) window on this machine `requestAnimationFrame` never
fires (0 frames; Wayland and XWayland both tried), which stalls pdf.js
rendering. Likely the compositor is not sending frame callbacks. NOT VERIFIED:
that `npm start` shows a working window. The user must run `cd desktop && npm
start`, open Merge PDF or OCR and confirm it renders. The suite uses
`--ozone-platform=headless` (override with `BENTO_E2E_OZONE`).

## Upstream patches

None applied (budget 0 of ~5). Possible later proposals:

1. Resolve `VITE_*` asset URLs against `location.origin` if any engine other
   than Tesseract uses them inside a blob worker. Not currently needed by any
   exercised tool.

## Not verified

- A visible window; macOS and Windows; packaging.
- Edit PDF (Google Fonts `@import`) and Digital Sign (CORS proxy, timestamp
  servers) were NOT driven at all; the session hook and CSP are expected to
  block their external calls but this is untested.
- Tools other than Merge, Word to PDF, OCR, Page Dimensions, Compress,
  PDF to Markdown, Linearize.
- Native open/save dialogs (stubbed in tests); `saveFile` is covered only by
  unit tests with a fake dialog.
- The 512 MiB IPC cap and large-file IPC memory behaviour end to end.
- Fidelity of the Word to PDF output beyond the one fixture sentence.
