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
  while any NOTICE line is UNVERIFIED.
- `hyper-compress-wasm` is imported by default (`src/js/utils/compress.ts`) and
  is separately licensed: exclude via patch/`DISABLE_TOOLS`. Same for Kura.
- Upstream CLA means nothing here can be merged upstream without the owner
  signing the ICLA; this repo stays AGPL-only.
- Overlap: upstream issue #219 reply says a reader-style UX "will be a part of
  BentoPDF Desktop" (maintainer's own product). Keep this repo clearly
  unofficial; revisit if upstream ships a desktop app.
- Not in BentoPDF, therefore out of scope until proven otherwise: true text
  re-flow editing parity with Acrobat, Acrobat-grade OCR editing, cloud
  features. Gap analysis lands in M3.

## Milestones

| M | Deliverable | Verified how |
|---|---|---|
| M1 | Local-bundle build: pinned upstream + patches, all WASM/Tesseract/fonts same-origin, Simple Mode, no non-essential network, Hyper Compress/Kura excluded. Default upstream build and tests still pass. Size report. | local build + test run + grep for external URLs |
| M2 | Thin Electron shell: transport chosen by experiment (privileged scheme vs loopback), COOP/COEP, `crossOriginIsolated`, workers, LibreOffice WASM, `sw.js`; document handoff proven. | local (needs display; xvfb absent: use headless Electron flags) |
| M3 | Acrobat shell: tabs, viewer, sidebar mapped to tool categories, recents, native menus/shortcuts/print/dialogs, file association, gap analysis vs Acrobat Pro. | local |
| M4 | Packaging: AppImage/.deb/Flatpak (local), DMG universal + NSIS/portable (CI only), optional notarization env vars. 100+ MB PDF and multi-page OCR memory report. | Linux local; macOS/Windows CI-built, NOT verified locally |
| M5 | PWA hardening: icons, precache, header configs, SW COOP/COEP fallback. Small; desktop is primary. | local |
| M6 | Android (Capacitor): COOP/COEP via shouldInterceptRequest, save/share, minimal permissions, F-Droid metadata. Needs Android SDK (ANDROID_HOME unset here). | build local if SDK installable; device tests may be unverifiable |
| Docs/CI | docs per target, GitHub Actions on tag/dispatch only. | workflow lint |

Each milestone ends with a diff summary and a commit on `main` of this repo.
Signing keys/certs are never committed; env vars or CI secrets only.
