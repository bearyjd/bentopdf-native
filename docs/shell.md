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
 └─ ...                    (at most maxLive = 3 alive; older background tabs discarded)
```

| File (`desktop/src/shell/`) | Role |
|---|---|
| `shell-app.js` | `startShell()`: wires everything; `main.js` uses it (scheme transport) |
| `sessions.js` | `prepareSession()`: the per-partition lockdown (below); the shell UI's CSP |
| `tab-manager.js`, `tab-policy.js` | tabs as frozen records; live-view cap (pure, unit-tested) |
| `tab-views.js` | Electron adapter: one `WebContentsView` per live tab, layout |
| `document-store.js` | open documents (main process only) |
| `recents.js` | recent files, JSON in `userData/recents.json` |
| `tool-registry.js` | tool list derived from `dist/` at startup |
| `handoff.js` | per-tool adapters and the handoff script |
| `shell-ipc.js`, `shell-channels.js`, `shell-preload.js` | the shell bridge (`window.bentoShell`) |
| `shell-menu.js` | application menu and shortcuts |
| `ui/` | the shell page (HTML/CSS/JS, no framework, DOM via `textContent` only) |

`BENTO_TRANSPORT=http` (dev only) still starts the single-window M2 app: the shell
is scheme-only (the loopback transport's secret cookie is set on the default
session only).

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
  tab also calls `clearStorageData()`. Consequence: upstream settings kept in
  `localStorage` (e.g. language, WASM settings) are per tab and per run.
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
  Max 32 open documents. In-memory documents (bytes) are supported by the store
  and the grant layer but nothing creates them yet.
- **Recents**: at most 10, written atomically with mode 0600, parsed as hostile
  input (wrong types, relative paths, non-`.pdf`, NUL, >4096 chars, >64 KiB
  file are dropped). The renderer gets random per-run ids. Opening a recent
  re-runs the full `validateOpenPath`; a failure removes the entry. Never
  auto-opened at startup.

Shell bridge (`window.bentoShell`): `listTools()`, `getState()` (tabs, open
documents, recent files), `openTool(toolId, docId?)`, `switchTab(id)`,
`closeTab(id)`, `openFileDialog()`, `openRecent(id)`, `onStateChanged(cb)`.
There is no separate "recents" call: recent files come with `getState()` and
every `stateChanged` push.

## Document handoff

`openTool(toolId, docId?)` loads the tool into the active tab (a new one if
there is none) and keeps the tab's document unless another is given. After the
page loads, the main process:

1. issues a grant for **that tab's WebContents only** (`grantPath`: same checks
   as an OS open, plus the file's `dev`/`ino` must still match what the store
   recorded, else "file changed since it was opened");
2. runs a script in the page that waits for the adapter's `<input type=file>`
   (30 s), pauses 1.5 s (upstream attaches its listeners late; same pause as the
   M2 scenario), then calls the existing `window.bentoDesktop.handoffToInput`,
   which reads the bytes back over the tool IPC with the token.

Adapters (`handoff.js`): `merge-pdf` -> `#file-input`, multiple. Every other
tool uses `input[type="file"]`, single file: **only Merge PDF is tested.**
The M2 DOM-input handoff is therefore still the only handoff mechanism (the
roadmap's "documents by id, tool adapters that return results" is not built:
tool output still goes through the page's own download/save path, not back
into the store).

## Tabs and the memory cap

At most `maxLive` (default 3) tab views are alive. Opening or activating a tab
discards the least recently active background views beyond the cap
(`webContents.close()`; the active tab is never discarded). A discarded tab
keeps its page, tool and document id; activating it creates a fresh view in the
same partition, reloads the page and hands the document over again. In-page
state (tool options, an unfinished job) is lost on discard. The cap is a count,
not a memory measurement: three LibreOffice tabs could still need ~5 GiB
(docs/m2-findings.md: ~1.7 GiB each). In-page navigation to another tool is
remembered for the reload.

## Tool registry

Built at startup from `dist/*.html` (excluding `404, about, contact, faq,
licensing, privacy, terms, index, tools` and anything matching
`kura|hyper-compress`). Names and categories come from the cards of
`dist/tools.html` (`<h2>` section, `<a href="/id"><h3>Name</h3>`). On the
current bundle: 129 entries, 118 with a category (7 upstream sections, one of
them "Popular Tools", which is a section, not a subject), 11 without (hub
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
  - `shellHandoff`: Merge PDF opened for the active document lists it.
  - `shellMemcap`: cap 2, three documents -> the first view is destroyed, its
    document kept; activating it gives a fresh view, the same page and the
    document listed in Merge PDF again.
  - `shellIpcReject`: shell IPC from the shell preload in a tool partition and
    from a second `bento://shell` page, and tool IPC from the tool preload at
    `bento://shell`, are all refused; positive control from the real shell.
- Mutation checks (each must turn a test red): see the M3 section of
  [ROADMAP.md](ROADMAP.md).

## Not verified

- A visible window: the shell has only ever run headless. Layout, focus,
  keyboard shortcuts (accelerators are only unit-tested as data) and menus
  were never seen or pressed.
- Native open dialog (stubbed in tests), drag and drop (not implemented).
- Handoff to any tool other than Merge PDF.
- Memory under real multi-tab load (the cap is unit- and e2e-tested by count only).
- Print, annotation, text editing, redaction, signing in the shell.
- macOS and Windows; packaged builds were not rebuilt. `test/packaged-smoke.js`
  was adapted to the shell but not run. Serving from asar was only probed: the
  `ui/` folder packed with `@electron/asar` and served by `serveStatic` in a
  headless Electron (Electron 45.1.0, unpackaged, no fuses) gave 200 for
  `shell.html`/`shell.js` with the right lengths and 404 for a missing file.
  A real packaged build was not tried.
