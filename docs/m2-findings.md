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
denied). The `denied` scenario asserts the page-visible answers
(`permissions.query` and `Notification.requestPermission()` say `denied`),
records every request/check the main-process handlers see, requires that
`Notification.requestPermission()` reached the request handler, and requires
that every observed decision was `false`. `clipboard-read` is recorded but NOT
required to reach the handler: `navigator.clipboard.readText()` only asks the
main process when the document is focused, and an independent verifier's
headless run never got there (the original assertion failed on an unmutated
baseline; it passed 5/5 on each transport here, so the focus dependence is the
likely, not proven, cause). Proof the scenario can fail: with `decidePermission`
mutated to `() => true` (on a copy under `$TMPDIR`) it fails on both transports.
`security.test.js` stays the unit-level guard for the decision function.

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
  files; 404/405; permission denial (notifications reach the handler; all decisions false); `window.open`
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
| remove `blob:` from `script-src` (keep `unsafe-eval`; `worker-src` keeps `blob:`) | the tools above pass, **but this was wrong as a general claim**: `ghostscript-loader` does `import(URL.createObjectURL(new Blob([gs.js])))`, a blob: module script, which the CSP then blocks (`Loading the script 'blob:...' violates ... script-src`, import fails). Compress PDF went through `ghostscript-dynamic-loader`, which does not use a blob, so the first experiment missed it. Found by the `ghostscript` probe of `npm run test:csp-smoke`. |

Result: the shell serves the bundle's own `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:`.
- `'unsafe-eval'`: kept, solely for LibreOffice WASM (evidence above). It is
  allowlisted with that reason in `desktop/src/headers.js`; any other
  `unsafe-eval`/`unsafe-inline` in `script-src` makes the shell refuse to serve.
  Follow-up: a per-page CSP would confine it to the Office-conversion pages.
- `'wasm-unsafe-eval'`: redundant while `'unsafe-eval'` is present (which also
  allows WebAssembly compilation); kept so dropping `unsafe-eval` later is a
  one-line change. Its removal was not tested alone.
- `blob:` in `script-src`: kept, allowlisted with a reason in `headers.js`.
  Needed by Ghostscript tools that use `ghostscript-loader` (PDF/A, Font to
  Outline, workflow). CSP cannot scope it to one tool, so every page can run
  blob: scripts; a per-page CSP (or an upstream change to load gs.js by URL)
  would confine it. `script-src-elem`/`-attr` and `worker-src` allow no more
  than `'self'`, `'wasm-unsafe-eval'` (and `blob:` for workers, which tools
  spawn from blob URLs).
- Fail-closed validation is a token allowlist (`script-src`, `script-src-elem`,
  `script-src-attr`, `worker-src`, `default-src` when `script-src` is absent):
  `'self'`, `'wasm-unsafe-eval'`, `'none'` plus the reasoned exceptions. Hashes,
  nonces, `unsafe-inline`, `unsafe-hashes`, `strict-dynamic`, `*`, `data:`,
  `filesystem:` and any scheme/host source are refused (one unit test each).
- `style-src 'unsafe-inline'`: left as shipped by the bundle; removal NOT tested.
- `/docs` has its own CSP in `_headers`; the shell applies only the `/*` block and
  refuses to start if `dist/docs` exists (it does not in this bundle).

## Static trace of script URLs built from blob: URLs

Greps over `dist` for `importScripts`, `new Worker`, `createElement('script')`,
`import(`+`createObjectURL`:

- **Needs blob: in script-src**: `ghostscript-loader` (`import(blobUrl)`); proven
  by the smoke probe. Not needing it: `ghostscript-dynamic-loader` (script tag
  with a path), `cpdf` workers (`importScripts(getUrl('cpdf') + ...)`, a path),
  `libreoffice-wasm/browser.worker.global.js` (`importScripts(sofficeJs)`, a
  path; its `<script>` fallback also a path), `soffice.js`/`soffice.worker.js`
  (`importScripts(Blob URL)` only when `mainScriptUrlOrBlob` is a Blob, which
  the loader never sets), `pyodide.asm.js`/`pyodide.js` (`importScripts(url)`
  with the indexURL path), pdf.js workers (module URL), tesseract
  (`new Worker(blob)` whose body `importScripts`'s an absolute http path; worker-src).
- Blob workers (heic2any, embedpdf, tesseract) are governed by `worker-src`.
- The static trace cannot prove paths computed at runtime (wasm-settings
  custom base URLs); by default they are same-origin paths.

## Test-backed vs only manually observed

Test-backed (`npm test`): the 137 top-level pages of the bundle each load on the
scheme transport with zero CSP violations (`test/csp-smoke`, allowlist file
`test/csp-smoke/allowlist.json` is empty); Ghostscript's blob import works; the
header allowlist (unit tests, mutation-sensitive); e2e scenarios listed under
"What passed".
Only manually observed: the CSP-experiment rows for PyMuPDF, Linearize and the
other tools (no committed test); pages' behaviour AFTER user action. The smoke
test only loads pages; worker/script paths reached by uploading files (vips,
heic2any, embedpdf, pyodide, cpdf workers) are covered by the static trace and,
for cpdf/pyodide/vips, not at all dynamically.

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
