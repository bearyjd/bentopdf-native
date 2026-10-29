# Roadmap: BentoPDF as an Acrobat-style desktop app

End state: one desktop window (Linux/macOS/Windows) that opens to a PDF viewer
with tabs, a tool sidebar, recent files, native menus, shortcuts, print, and
"open with" for .pdf. Every BentoPDF tool is reachable from the sidebar and
operates on the document in the active tab. Fully offline.

## Architecture (decided)

- **Upstream is not forked or vendored.** `UPSTREAM_VERSION` pins a tag
  (v2.8.10). A build script clones that tag, applies `patches/*.patch`, builds.
- **The Acrobat-style shell is new code in `desktop/`** (Electron main +
  preload + shell UI). It loads upstream's ~125 tool pages unmodified into a
  content pane and hands them the active document.
- **Document handoff.** Upstream tools take files only through
  `<input type=file>`/drop (Sign PDF also accepts a blob URL). The shell injects
  a `File` into the page's input from the preload bridge. ASSUMPTION: proven
  in M2; if it fails the fallback is a minimal upstreamable patch.
- **Patch budget:** at most ~5 small patches, limited to build config, headers,
  asset URLs and excluding Hyper Compress. If the Acrobat UX needs more, this
  project has become a fork and the architecture must be revisited with the
  owner of this repo, not silently.

## Constraints and risks

- AGPL-3.0 throughout; NOTICE credits upstream and libraries. No release ships
  while any NOTICE line is marked NEEDS REVIEW. Every bundle carries
  SOURCE.txt, LICENSE and NOTICE.
- Supply chain: upstream pinned by tag and commit (`UPSTREAM_COMMIT`), npm
  install scripts disabled, all downloads checksum-pinned
  (`scripts/checksums.sha256`). The build executes upstream code, so it is not
  run in PR CI.
- Runtime network: the generated CSP has no external origin; two upstream
  third-party calls (digital-sign cors proxy/timestamp servers, Google Fonts
  `@import`) remain in the code and are only CSP-blocked, not browser-verified.
  M2 must enforce an equivalent policy in Electron and run a network-blocked
  headless check (deferred from M1), plus COOP/COEP and custom-scheme `BASE_URL`.
- `hyper-compress-wasm` and Kura are separately licensed and must not ship.
  Checked at v2.8.10: nothing imports them (no patch needed); only their
  marketing pages exist, which the local-bundle build removes (and
  `scripts/check-dist.sh` fails the build if they reappear). Navbar/legal-page
  links to them remain as dead links. Re-check on every `UPSTREAM_VERSION` bump.
- Upstream CLA means nothing here can be merged upstream without the owner
  signing the ICLA; this repo stays AGPL-only.
- Overlap: upstream issue #219 reply says a reader-style UX "will be a part of
  BentoPDF Desktop" (maintainer's own product). Keep this repo clearly
  unofficial; revisit if upstream ships a desktop app.
- Not in BentoPDF, therefore out of scope until proven otherwise: true text
  re-flow editing parity with Acrobat, Acrobat-grade OCR editing, cloud
  features. Gap analysis lands in M3.

## Open gates

- [ ] **BLOCKING: M2 is not closed until a human confirms a VISIBLE window
  renders** (`cd desktop && npm start`, open Merge PDF and OCR). Everything so
  far ran headless only (`--ozone-platform=headless`); on the dev machine a real
  Wayland window got 0 `requestAnimationFrame` frames.

## Milestones

| M | Deliverable | Verified how |
|---|---|---|
| M1 | Local-bundle build: pinned upstream + patches, all WASM/Tesseract/fonts same-origin, Simple Mode, no non-essential network, Hyper Compress/Kura excluded. Default upstream build and tests still pass. Size report. | local build + test run + grep for external URLs |
| M2 | Thin Electron shell: transport chosen by experiment (privileged scheme vs loopback), COOP/COEP, `crossOriginIsolated`, workers, LibreOffice WASM, `sw.js`; document handoff proven. | local (needs display; xvfb absent: use headless Electron flags) |
| M3 | Acrobat shell: tabs, viewer, sidebar mapped to tool categories, recents, native menus/shortcuts/print/dialogs, file association, gap analysis vs Acrobat Pro. First slice M3a done (see "M3 status"); viewer, print, adapters beyond Merge PDF open. | local, headless only so far |
| M4 | Packaging: AppImage/.deb/Flatpak (local), DMG universal + NSIS/portable (CI only), optional notarization env vars. 100+ MB PDF and multi-page OCR memory report. | Linux local; macOS/Windows CI-built, NOT verified locally |
| M5 | PWA hardening: icons, precache, header configs, SW COOP/COEP fallback. Small; desktop is primary. | local |
| M6 | Android (Capacitor): COOP/COEP via shouldInterceptRequest, save/share, minimal permissions, F-Droid metadata. Needs Android SDK (ANDROID_HOME unset here). | build local if SDK installable; device tests may be unverifiable |
| Docs/CI | docs per target, GitHub Actions on tag/dispatch only. | workflow lint |

Each milestone ends with a diff summary and a commit on `main` of this repo.
Signing keys/certs are never committed; env vars or CI secrets only.

## M3 design notes

- **Documents live in the main process.** A main-process document store plus a
  per-tool adapter replaces the per-page hidden-input DOM hack
  (`handoffToInput`) used in M2. Each tool gets a small adapter that takes
  and returns documents by id, not a `File` pushed into whatever `<input>` the
  page has. M2's handoff stays only as the fallback adapter.
- **One `WebContentsView` per tab**, with separate partitions (or a deliberate,
  documented decision to share one). Every view must re-prove, in a test:
  `crossOriginIsolated`, the preload bridge, and the IPC sender checks (today
  they are proven for a single window only).
- **Cap live views and memory.** One LibreOffice run is about 1.7 GiB RSS
  (docs/m2-findings.md); N tabs cannot each keep a live engine. Define a limit
  and an eviction policy.

## M3 status (first slice "M3a", details in [shell.md](shell.md))

`[x]` = implemented and covered by a passing test on the dev host (headless,
Electron 45.1.0); `[~]` = PARTIAL; `[ ]` = not done. Nothing here was seen in a visible window.

- [x] Tabs: one `WebContentsView` per tab in one window, each in its own
  in-memory partition (`bento-tab-<id>`) with the full default-session
  treatment (scheme handler + COOP/COEP/CORP + CSP, permission lock, non-app
  requests cancelled). Per tab: `crossOriginIsolated`, the M2 bridge, the
  permission lock and storage isolation (tab/tab and tab/shell) are e2e-tested.
- [x] Live-view limit: a weighted slot budget (default 6; ordinary tool 1, OCR 2,
  LibreOffice conversion 4, from the M2 RSS numbers, constants in
  `live-budget.js`) with discard and reload-on-activation that re-hands the
  document (policy unit-tested; discard/reload and the lockdown after reload
  e2e-tested). The weights are estimates, not a measurement of a running shell.
- [x] Main-process document store (validated paths only, ids to renderers;
  released when the last tab closes, LRU eviction of unshown documents; the old
  hard 32-documents-per-run limit is gone) and shell IPC gated to the
  registered shell WebContents, with hostile-input tests. Network (UNC) paths
  refused; native dialogs only for the active tab; main-process accumulators
  bounded.
- [x] Tool sidebar derived from `dist` (129 pages, 118 categorised: upstream's
  categories, not Acrobat's), search, recent files (10, re-validated on open;
  only a confirmed missing/invalid file is dropped).
- [~] PARTIAL: handoff adapter = a selector table feeding the M2
  `handoffToInput`, Merge PDF verified only, no return path. Runs in the
  background with a visible status and surfaced errors.
- [x] Menus: File (Open, Open Recent, Close Tab, Quit), Tab (Next/Previous,
  Ctrl+Tab), View (Reload Tool, zoom), Help (About + AGPL source offer).
  Template unit-tested; never clicked.
- [ ] A PDF viewer of our own (a document tab shows upstream's landing page).
- [ ] Tool results back into the store (output still leaves via the page's own
  download; "documents by id in and out" from the design notes is not built).
- [ ] Adapters verified for tools other than Merge PDF.
- [ ] Print, drag and drop onto the window, native save-as from the shell.
- [ ] Categories mapped to Acrobat-style task groups (upstream's sections used).
- [ ] Persisted per-tab settings (partitions are in-memory: upstream settings in
  `localStorage` do not survive a tab or a restart; issue-ready note in
  [shell.md](shell.md) TODO).

Mutation checks (each mutation applied alone, then reverted; it must make a
test fail):

| Mutation | Result |
|---|---|
| Shell IPC sender: drop the WebContents id check | RED: shell-ipc unit + e2e shellIpcReject |
| Shell IPC sender: drop the origin check | RED: shell-ipc unit |
| Tab partition: skip `lockSession` | RED: e2e shellTabs |
| Tab partition: skip the whole setup before the view is created | RED: e2e shellTabs |
| All tabs share one partition | RED: e2e shellTabs |
| `openTool`: document id not checked against the store | RED: shell-ipc unit |
| Recents: hostile entries kept | RED: shell-store unit |
| Handoff grant: file identity (`dev`/`ino`) not compared | RED: ipc unit |
| Live-view limit ignored | RED: shell-tabs unit + e2e shellMemcap |
| Registry: excluded pages listed | RED: shell-registry unit |
| Store: path not validated | RED: shell-store unit |
| Default session left unlocked in shell mode | RED: e2e shellIpcReject |

Review round (applied on a copy of the worktree under a mktemp dir, one at a
time, each reverted; "RED" = the named test failed, baseline green):

| Mutation | Result |
|---|---|
| tab-manager `close()` does not discard the view | RED: shell-tabs unit |
| Handoff uses the wrong document id (first in the store) | RED: e2e shellHandoff (two documents open) |
| Stale-view guard in `loadInto` removed | RED: shell-tabs unit |
| Previous view not hidden on activate | RED: shell-tabs unit |
| `navigate` drops the document id | RED: shell-tabs unit |
| Store dedupes by path only (no dev/ino) | RED: shell-store unit |
| `store.touch` removed from the handoff | RED: e2e shellHandoff |
| Handoff awaited by activate/open (blocks) | RED: shell-tabs unit |
| Weights ignored by the live-view policy | RED: shell-tabs unit |
| Document not released when its tab closes | RED: e2e shellLifecycle |
| Window teardown skips `closeAll` / skips `views.dispose` | RED: e2e shellTeardown (both) |
| Native-dialog active-tab gate removed | RED: shell-hardening unit + e2e shellIpcReject |
| Closed tab's session not emptied | RED: e2e shellLifecycle |
| Handoff error not surfaced to the status | RED: e2e shellHandoffError |
| Window title taken from the page | RED: e2e shellLifecycle |
| Per-path serialisation of concurrent opens removed | **GREEN (survived)**: the store and tab lookup run synchronously after the await, so duplicates cannot occur even without it; the helper is unit-tested (`serialByKey`) but its wiring is defence in depth with no test that can fail |

**Packaged (Linux AppImage only, this branch's HEAD, built with
`electron-builder --linux AppImage`, hardened, headless):** `verify-artifact.sh
--allow-dirty` VERIFIED (13 checks; the NOTICE-marker line is the usual "not for
release" note); `test/packaged-smoke.js` 16/16 with a PDF argument and 16/16
without: shell UI served from `app.asar` (`bento://shell`, 129 tools
rendered), tool tab isolated, renderers sandboxed, hostile `BENTO_*` env ignored,
second instance forwards its PDF. deb, rpm, Flatpak, macOS, Windows: not built.

**NOT VERIFIED (M3a):**

- A visible window was never seen (headless only, the M2 display gate above
  still applies); layout, focus, shortcuts and menus were never exercised by a
  person or a real input event.
- Print; annotate/edit in a viewer; redaction; signing flows; any tool other
  than Merge PDF receiving the document.
- macOS and Windows (menus use `CmdOrCtrl`, `appMenu` on macOS; UNC rules only
  tested as strings on Linux).
- Memory under real tab load: the live-view weights are estimates from M2 RSS
  numbers, never measured on a running shell.
- The `BENTO_TRANSPORT=http` path is a test-only harness and is not a supported
  way to run the app.

### Gap analysis vs Acrobat Pro (honest, by feature)

"Upstream tool" = a BentoPDF page reachable from the sidebar. None of these
has been checked for Acrobat-level fidelity; only Merge PDF receives the open
document automatically today.

| Acrobat Pro feature | BentoPDF (v2.8.10) | Notes |
|---|---|---|
| View (continuous viewer, thumbnails, search) | partial: `edit-pdf` (PDF Editor, EmbedPDF) views and searches; no standalone viewer page | no shell viewer yet |
| Annotate / comment | `edit-pdf`, `add-stamps`, `remove-annotations` | not driven in any test |
| Edit text | `edit-pdf-text` ("live reflow" per upstream) | Acrobat-grade reflow editing: not claimed |
| Organize pages | `organize-pdf`, `pdf-multi-tool`, `rotate-pdf`, `delete-pages`, `extract-pages`, `add-blank-page`, `reverse-pages` | |
| Combine / split | `merge-pdf` (handoff tested), `alternate-merge`, `split-pdf` | |
| OCR | `ocr-pdf` (Tesseract) | 1-page OCR measured in M2 only |
| Forms | `form-filler`, `form-creator` | |
| Sign | `sign-pdf` (visual signature), `digital-sign-pdf`, `validate-signature-pdf` | digital sign has external timestamp/CORS calls that are only CSP-blocked (M2 findings) |
| Redact | upstream says `edit-pdf` can redact; no dedicated page | NOT VERIFIED that content is removed, not covered |
| Compare | `compare-pdfs` | |
| Export (Word, Excel, images, text) | `pdf-to-word`, `pdf-to-excel`, `pdf-to-jpg`/`png`/`tiff`/`webp`/`svg`, `pdf-to-text`, `pdf-to-markdown`, ... | |
| Protect | `protect-pdf`, `change-permissions`, `unlock-pdf`, `remove-restrictions`, `sanitize-pdf`, `remove-metadata` | |
| Print | not in BentoPDF | needs shell work (M3b) |
| Cloud, sharing, review workflows, accessibility checker, preflight | not in BentoPDF | out of scope |

## M4 entry criteria (do not start packaging before these have an answer)

Status after the Linux packaging pass and its review fixes (details and commands:
[desktop-linux.md](desktop-linux.md)). `[x]` means demonstrated on the dev
host (Fedora/Bazzite, Electron 45.1.0, headless) with the evidence named;
`[~]` means decided or partly shown; anything not proven says NOT VERIFIED.

- [~] Chromium sandbox strategy for AppImage and Flatpak. **No `--no-sandbox`.**
  Shown: AppImage (user-namespace sandbox) and the installed Flatpak (zypak): the headless
  smoke test reads `/proc/<renderer>/status`: `Seccomp: 2`, `NoNewPrivs: 1`, `CapEff: 0`.
  Negative control: `--no-sandbox` makes the test fail. Hosts without user namespaces: the
  hardened AppRun refuses to start (simulated with a failing `unshare`; NOT VERIFIED on a real
  AppArmor-restricted Ubuntu). deb/rpm: payload ships `chrome-sandbox` 0755; the post-install
  script (non-root userns probe, AppArmor-aware, setuid only as fallback) is read and gated, but
  installing it is NOT VERIFIED (needs root/layering).
- [x] Electron fuses: RunAsNode off, NODE_OPTIONS off, inspect arguments off,
  OnlyLoadAppFromAsar on, cookie encryption on, file-protocol privileges off, read from the built
  binary (`desktop/tools/check-fuses.js`; unpacked, AppImage, deb, rpm). The asar-integrity fuse
  is on but NOT relied upon: probably a no-op on Linux.
- [x] asar vs unpacked decision for the WASM payloads (Range reads, size):
  app code in `app.asar` (~50 KB), 368 MB / 4,394-file payload as an
  extraResource outside it; file list identical to `dist/`.
- [x] `BENTO_DIST` / `BENTO_TRANSPORT` and other environment overrides disabled in release:
  static check of the extracted `main.js` in every artifact plus AppImage and Flatpak smoke runs
  with hostile values. Every launch switch not on an allowlist is
  refused, single-dash spellings included (Chromium honours `-remote-debugging-port=0` on Linux:
  measured on Electron 45.1.0), and `main.js` exits 2 if `ELECTRON_DISABLE_SANDBOX` or
  `CHROME_DEVEL_SANDBOX` is set (`src/argv-policy.js`, `src/main.js`, unit-tested). Not mitigated for
  deb/rpm: `ELECTRON_EXTRA_LAUNCH_ARGS` / `ELECTRON_ENABLE_LOGGING` in the user's own environment.
- [~] Desktop entry, MIME type and file association for `.pdf`: present and gated in all four
  formats (`verify-artifact.sh`; Flatpak files also by `desktop-file-validate`/`appstreamcli`). Open-with
  is proven at argv/second-instance level only (smoke test); a real file-manager launch is NOT VERIFIED.
- [~] Wayland: **decided** (`--ozone-platform-hint=auto` in entries and the Flatpak wrapper).
  A visible window under Wayland or X11 was NOT VERIFIED (only headless was run).
- [x] Deliberately no auto-update; stated in desktop-linux.md and in the About dialog.
- [x] Ship Electron's `LICENSE` and `LICENSES.chromium.html`, gated in the AppImage, deb, rpm and
  the Flatpak build tree (`verify-artifact.sh`). The CI workflow gates AppImage/deb/rpm only; the
  Flatpak is built and gated locally, **not in CI**.
- [~] `SOURCE.txt` provenance: repo commit, upstream tag/commit, Electron version and checksum, build
  date, release-tag line and PR/branch. The gate fails on a commit that is not the checkout's HEAD or on
  a dirty tree; artifacts were rebuilt from the final commit. A release must come from a tagged
  commit on main (workflow check, NOT VERIFIED on GitHub: the workflow never ran).
- [~] Licence check: `NOTICE` still has unresolved lines (`packaging/check-notice.sh` prints the
  count); tag builds fail while any remain, other builds are named NOT FOR RELEASE. So no release can
  be cut yet. The icon is self-made; the product name's trademark status is NOT VERIFIED (rename
  recommended; one-file change, see desktop-linux.md "Renaming").
- [x] AGPL corresponding-source offer reachable from Help/About (unit-tested text and menu wiring,
  and gated in the artifact; the dialog itself was never opened: NOT VERIFIED visually).
- [x] Release gate mutation-tested: `packaging/test-verify-artifact.sh` (every mutation must fail the gate).

Still open for M4: macOS/Windows packaging (CI only, not built), signing and
notarization hooks, the 100+ MB PDF and multi-page OCR memory report, and a
real run of `.github/workflows/desktop-linux.yml` on GitHub (NOT VERIFIED).
