# Tabbed desktop shell (M3a, first slice)

Status: foundation only. Tested headless (`--ozone-platform=headless`) on the
dev host (Fedora/Bazzite, Electron 45.1.0). **No one has seen this window on a
screen** (see "Not verified"). Not an Acrobat Pro equivalent: see the gap table.

## What it is

One `BrowserWindow`. Its own WebContents is the **shell UI** (tab strip, tool
sidebar with search, recent files). Each **tab** is a `WebContentsView` placed
over the content area and showing an unmodified upstream page from
`bento://app/<tool>.html`. A new tab with no tool shows `index.html`
(upstream's landing page). There is no PDF viewer of our own yet.

```
BrowserWindow  (partition bento-shell, shell-preload.js, bento://shell/shell.html)
 ├─ WebContentsView tab 1  (partition bento-tab-1, preload.js, bento://app/merge-pdf.html)
 ├─ WebContentsView tab 2  (partition bento-tab-2, preload.js, bento://app/index.html)
 └─ ...                    (live-view budget of 6 slots; older background tabs discarded)
```

| File (`desktop/src/shell/`) | Role |
|---|---|
| `shell-app.js` | `startShell()`: wires everything; `main.js` uses it (scheme transport) |
| `sessions.js` | `prepareSession()`: the per-partition lockdown (below); the shell UI's CSP; `releaseSession()` |
| `bounded.js` | ring buffers / bounded sets / log rate limit / per-key serialisation |
| `tab-manager.js`, `tab-policy.js`, `live-budget.js` | tabs as frozen records; weighted live-view budget (pure, unit-tested; every number in `live-budget.js`) |
| `tab-views.js` | Electron adapter: one `WebContentsView` per live tab, layout |
| `document-store.js` | open documents (main process only); freed when their last tab closes |
| `recents.js` | recent files, JSON in `userData/recents.json` |
| `tool-registry.js` | tool list derived from `dist/` at startup |
| `handoff.js` | per-tool adapters and the handoff script |
| `shell-ipc.js`, `shell-channels.js`, `shell-preload.js` | the shell bridge (`window.bentoShell`) |
| `shell-menu.js` | application menu and shortcuts |
| `ui/` | the shell page (HTML/CSS/JS, no framework, DOM via `textContent` only) |

`BENTO_TRANSPORT=http` is a **TEST-ONLY harness**, not a way to use the app: it
starts the legacy single-window M2 app (no tabs, no shell UI) so the old
per-tool scenarios keep running; it is ignored when packaged, logs a warning
and is labelled as such in the tests (`single-window harness e2e`). The default
start path is the shell (`src/start-mode.js`, unit-tested). The shell is
scheme-only (the loopback transport's secret cookie is set on the default
session only). The window title is `brand.json`'s `productName`, set by the
main process (`shell.html`'s own `<title>` is ignored).

## Security model (what changed relative to M2)

Everything in [desktop.md](desktop.md) "Security model" still holds for each
tab. In addition:

- **Every partition gets the default session's treatment.** `prepareSession`
  registers `bento://` on that session's own `protocol` for exactly one host
  (COOP `same-origin`, COEP `require-corp`, CORP `same-origin`, the bundle's
  fail-closed CSP on every response), denies every permission and device
  request, and cancels every request outside its origin. It runs before a view
  of that partition is created; a `WeakSet` makes it idempotent.
- **Partitions** are in-memory (`bento-tab-<id>`, no `persist:`), one per tab,
  ids only grow, so a new tab never inherits a closed tab's storage. Closing a
  tab also empties its session (`releaseSession`: storage, HTTP cache, DNS
  cache, auth cache, open connections). **Electron cannot destroy a Session**:
  `session.fromPartition()` keeps the object, its protocol handler and its
  lockdown for the life of the process, so this is best effort and a closed
  tab's (empty) session object lives until quit. Consequence of the in-memory
  partitions: upstream settings kept in `localStorage` (language, WASM settings,
  ...) do **not** persist, neither across tabs nor across restarts (see TODO).
- **Two origins, two bridges.**
  - Tool pages: `bento://app`, `preload.js` (`window.bentoDesktop`), tool IPC
    accepts only the top frame at `bento://app` (unchanged M2 check).
  - Shell UI: `bento://shell` (served from `src/shell/ui/` in partition
    `bento-shell`), `shell-preload.js` (`window.bentoShell`). Shell IPC accepts
    only the **registered shell WebContents id**, top frame, at `bento://shell`.
    A second page at `bento://shell`, a tool page, or a tool page that somehow
    got the shell preload is refused (tested both ways with deliberately
    swapped preloads, see Tests).
  - Shell CSP: `default-src 'none'; script-src 'self'; style-src 'self';
    img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none';
    frame-ancestors 'none'` plus the isolation headers.
  - Navigation pinning is per WebContents: the shell is pinned to
    `bento://shell`, every other WebContents to `bento://app`.
- **The default session stays locked** (permissions denied, non-app requests
  cancelled), as in M2, although nothing of the shell loads there; tested by a
  view without a partition whose `data:` page is cancelled.
- **Shell IPC arguments** are validated against main-process state: tool ids
  must be in the registry (Map lookups, so `__proto__` etc. are just unknown),
  document and recent ids must be UUIDs the main process issued, tab ids must be
  safe integers of existing tabs. Paths never cross into any renderer.
- **Documents live in the main process.** `document-store.js` accepts a path
  only through `validateOpenPath` (`.pdf`, realpath, regular file, 512 MiB cap,
  `%PDF-` magic) and keeps path, `dev`, `ino`; renderers see `{id, name, size}`.
  A document is removed when the last tab showing it closes (or navigates to
  another document). The earlier hard limit of 32 documents per run (which made
  every open fail after the 32nd, because nothing ever removed a document) is
  **gone**: the store still holds at most 32 documents at once, evicts the least
  recently used one no tab shows when full, and fails with "close a tab first"
  only when 32 are all shown in tabs. In-memory documents (bytes) are supported
  by the store and the grant layer but nothing creates them yet.
- **No network paths.** A path starting with two slashes or backslashes (UNC,
  `\\?\UNC\`) is refused on every platform in `validateOpenPath`, the store,
  recents and the command-line filter (it can leak NTLM credentials or hang on
  a dead server).
- **Native dialogs belong to the active tab.** `openFile`/`saveFile` of the tool
  bridge are refused for any WebContents that is not the active tab's view, so a
  hidden background tab cannot open one.
- **Bounded main-process state.** The blocked-request list, permission
  decisions, handoff records and the allowed-URL set are capped at 200 entries
  (oldest dropped); blocked/permission log lines are rate-limited per
  partition (20 a minute, then one "suppressed" notice).
- **Handoff script** runs with `executeJavaScript(script, false)`: no user
  activation is granted to the page.
- **Recents**: at most 10, written atomically with mode 0600, parsed as hostile
  input (wrong types, relative paths, non-`.pdf`, NUL, >4096 chars, >64 KiB
  file are dropped, as are network paths). The renderer gets random
  per-run ids. Opening a recent re-runs the full `validateOpenPath`; only a
  **confirmed** failure (file gone: ENOENT/ENOTDIR/ELOOP, or not an acceptable
  PDF) removes the entry; a transient error (EACCES, EIO, EBUSY, ...) keeps it
  and reports "try again". Never auto-opened at startup.

Shell bridge (`window.bentoShell`): `listTools()`, `getState()` (tabs, open
documents, recent files), `openTool(toolId, docId?)`, `switchTab(id)`,
`closeTab(id)`, `openFileDialog()`, `openRecent(id)`, `onStateChanged(cb)`.
There is no separate "recents" call: recent files come with `getState()` and
every `stateChanged` push.

## Document handoff

`openTool(toolId, docId?)` loads the tool into the active tab (a new one if
there is none) and keeps the tab's document unless another is given. After the
page loads, the main process (in the **background**: `openTool`, `switchTab`
and friends return as soon as the page has loaded, they no longer wait up to
31.5 s for the handoff):

1. issues a grant for **that tab's WebContents only** (`grantPath`: same checks
   as an OS open, plus the file's `dev`/`ino` must still match what the store
   recorded, else "file changed since it was opened");
2. runs a script in the page that waits for the adapter's `<input type=file>`
   (30 s), pauses 1.5 s (upstream attaches its listeners late; same pause as the
   M2 scenario), then calls the existing `window.bentoDesktop.handoffToInput`,
   which reads the bytes back over the tool IPC with the token.

While it runs the tab has a status ("Loading x.pdf into Merge PDF...") and a
failure (e.g. "file changed since it was opened", no matching input within 30 s)
is shown on the shell's status line for the active tab. A handoff is dropped
silently (no injection, no success record, no status change) when it was
superseded by a newer one, its view was discarded or replaced, **or its tab
navigated**: every tab has a navigation epoch (bumped by `navigate()`,
`recordPage()` and every main-frame `did-start-navigation` / `did-navigate-in-page`
of its view) that the handoff compares with the value it started with, and
immediately before `executeJavaScript` it re-checks that the view's URL is still
`bento://app` + the intended tool's path. Page-originated error text is capped
at 300 characters and stripped of control and bidi characters before it reaches
the status line, state pushes or the (rate-limited) log. Concurrent opens of
the same path are serialised (one document, one tab).

Adapters (`handoff.js`): `merge-pdf` -> `#file-input`, multiple. Every other
tool uses `input[type="file"]`, single file: **only Merge PDF is tested.**
This is **PARTIAL**: a selector table feeding the M2 `handoffToInput`, Merge
PDF verified only, **no return path** (the roadmap's "documents by id in and
out" is not built: tool output still goes through the page's own download/save
path, not back into the store).

## Tabs and the live-view limit

Live views are limited by a **weighted slot budget** (`live-budget.js`, all
numbers in that one file): default 6 slots; an ordinary tool or the landing page
weighs 1, OCR 2, a LibreOffice conversion 4. Which tool is heavy is **read from
the bundle at startup**, not from a hand-kept list: a tool page whose HTML
preloads the LibreOffice loader / `soffice` weighs 4, one that preloads the
Tesseract runtime weighs 2 (14 LibreOffice pages in this bundle, including
`pdf-workflow`; the old hand list wrongly included `pdf-to-word`, which does not
load LibreOffice). A page that merely references an engine counts as heavy even
if it loads it only on demand (conservative), and a tool id the registry does
not know weighs the maximum (4). A unit test cross-checks the markers against
an independent walk of each page's static import graph in `dist`. The weights are an **estimate from the M2
findings** (one LibreOffice run ~1.7 GiB peak RSS, OCR ~0.9 GiB; one slot is
about 0.4 GiB), not a measurement of the running machine. Opening, activating
navigating a tab (or a page navigating itself to another tool) discards the least recently active background views until
the live weights fit (`webContents.close()`; the active tab is never discarded,
even if it alone exceeds the budget). So one LibreOffice tab plus two ordinary
ones fits; a second LibreOffice tab discards the first. A discarded tab keeps
its page, tool and document id; activating it creates a fresh view in the same
partition, reloads the page and hands the document over again. The lockdown is
asserted again on the reloaded view (e2e). In-page state (tool options, an
unfinished job) is lost on discard. Real memory under load: NOT VERIFIED.
In-page navigation to another tool is remembered for the reload.

## Tool registry

Built at startup from `dist/*.html` (excluding `404, about, contact, faq,
licensing, privacy, terms, index, tools` and anything matching
`kura|hyper-compress`). Names and categories come from the cards of
`dist/tools.html` (`<h2>` section, `<a href="/id"><h3>Name</h3>`). On the
current bundle: **129 pages, 118 categorised** (upstream's categories, not
Acrobat's; 7 upstream sections, one of them "Popular Tools", which is a section,
not a subject), 11 without (hub
pages `pdf-converter`, `pdf-editor`, `pdf-merge-split`, `pdf-security`, the six
`compress-pdf-to-*`/`for-email` SEO pages, `wasm-settings`): the sidebar shows
them under "Other". Limits: this parses upstream's rendered HTML, which is not
an API; if the markup changes, every tool falls back to its `<title>` and no
category (nothing breaks, the sidebar gets worse). The categories are
upstream's, not Acrobat's.

## Menus and shortcuts

File: Open... (Ctrl+O), Open Recent, Close Tab (Ctrl+W), Quit (Ctrl+Q). Edit:
roles. Tab: Next (Ctrl+Tab), Previous (Ctrl+Shift+Tab). View: Reload Tool
(Ctrl+R, re-runs the handoff), Actual Size / Zoom In / Zoom Out (Ctrl+0/=/-),
full screen. Help: About (AGPL notice and source offer, unchanged) and Source
code. Tab, reload and zoom act on the active tab explicitly, not on whatever
WebContents has focus. macOS gets the `appMenu` role; `CmdOrCtrl` maps to Cmd.

## Tests

- Unit (`npm test`, no Electron): `shell-registry`, `shell-store` (store and
  recents with hostile paths/JSON), `shell-tabs` (policy and manager with fake
  views), `shell-ipc` (sender gate and validators with hostile inputs),
  `shell-menu` (accelerators, handoff adapters and script escaping),
  `ipc` (`grantPath`/`grantBytes`).
- Headless e2e (`test/shell-e2e.test.js`, one Electron process per scenario,
  scheme only; `BENTO_E2E_SCENARIOS=shellTabs` to narrow):
  - `shellTabs`: two PDFs opened through the shell's real IPC -> two tabs; in
    each tab `crossOriginIsolated`, SharedArrayBuffer, COOP/COEP/CSP headers,
    the M2 bridge, no shell bridge, no Node globals, and a permission refusal
    recorded **for that partition**; `localStorage`/`sessionStorage` not shared
    tab-to-tab or tab-to-shell; switchTab; every request of every partition
    internal, nothing blocked.
  - `shellHandoff`: two documents open; Merge PDF opened for the one that is
    not active lists exactly that one (never the other), the store entry is
    touched, the unshown one is released.
  - `shellHandoffNavigated`: a handoff held after its grant (test seam
    `beforeInject`) while the tab navigates in-view to Split PDF injects
    nothing into the second page, records no success and leaves no status.
  - `shellHandoffError`: the file is replaced (new inode) after it was opened;
    the tool opens, the IPC returns, and the failure ("file changed since it
    was opened") appears in the tab status and on the shell's status line.
  - `shellMemcap`: budget 2, three documents -> the first view is destroyed, its
    document kept; activating it gives a fresh view, the same page and the
    document listed in Merge PDF again, with isolation headers, permission
    lock and request blocking still in force on that partition.
  - `shellLifecycle`: concurrent opens of one path give one document and one
    tab; 33 distinct PDFs opened and closed in one run; a closed tab's
    `localStorage` is gone; the window title is the brand name.
  - `shellTeardown`: closing the shell destroys every tab WebContents and has
    removed the resize listener before the window is destroyed.
  - `shellIpcReject`: shell IPC from the shell preload in a tool partition and
    from a second `bento://shell` page, and tool IPC from the tool preload at
    `bento://shell`, are all refused; positive control from the real shell;
    `openFile`/`saveFile` refused from a hidden background tab, allowed from the
    active one.
- Mutation checks (each must turn a test red): see the M3 section of
  [ROADMAP.md](ROADMAP.md).
- Known flake (not caused by the shell): the legacy single-window `mergeOffline`
  scenario on loopback http could fail on a Chromium `ERR_CACHE_MISS` font
  preload (2 of 6 runs on main); it now tolerates that for font files only.
- The legacy single-window scenarios `handoff`, `libreoffice`, `ocr`, `bigPdf`
  need `upstream/node_modules` (pdf-lib); a fresh worktree without it fails
  them with "pdf-lib not found" (run `scripts/build-local.sh` once).

## Not verified

- The packaged smoke test (`test/packaged-smoke.js`) runs only against a disposable extracted copy of
  an AppImage with the test-mode marker (docs/desktop-linux.md, "Packaged test mode"). Flatpak, deb
  and rpm are not smoke-tested. Follow-up: drive the packaged build over `--remote-debugging-pipe`.
- A visible window: the shell has only ever run headless. Layout, focus,
  keyboard shortcuts (accelerators are only unit-tested as data) and menus
  were never seen or pressed. **The window is still unseen.**
- Native open dialog (stubbed in tests), drag and drop (not implemented).
- Handoff to any tool other than Merge PDF.
- Memory under real multi-tab load: the slot weights are estimates from M2
  numbers, never measured on a running shell.
- Print, annotation, text editing, redaction, signing in the shell.
- macOS and Windows (including the UNC rules, which are unit-tested as strings
  on Linux only).
- Packaged builds other than the Linux AppImage (deb, rpm, Flatpak, macOS,
  Windows). For the AppImage built from this branch: `verify-artifact.sh` and
  `test/packaged-smoke.js` (16/16, with and without a PDF argument; the shell UI
  is served from `app.asar`) passed, headless.

## TODO (issue-ready)

**Persist upstream tool settings across tabs and restarts.** Tab partitions are
in-memory (`bento-tab-<id>`, no `persist:`), so anything upstream keeps in
`localStorage`/IndexedDB (language, WASM/LibreOffice settings, preferences)
is lost when a tab closes, per tab and on every restart. Needed: a decision
between (a) one persistent partition shared by all tabs (weakens the per-tab
storage isolation proven in `shellTabs`), (b) per-tool persistent partitions,
or (c) the main process storing a small allow-listed settings blob and
injecting it at load. Acceptance: settings survive a restart, tab-to-tab
storage isolation test still passes, nothing outside the allow-list persists.
