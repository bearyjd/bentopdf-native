# BentoPDF Desktop (Electron shell) - skeleton

Status: M2 prototype plus M4 Linux packaging
([desktop-linux.md](desktop-linux.md)). A thin, locked-down Electron window that
serves the offline bundle in `./dist`. Since M3a, `npm start` opens the tabbed
shell (tabs, tool sidebar, recents, menus; see [shell.md](shell.md)); everything
below still describes each tool tab. There is no auto-update.
Measured results and open problems: [m2-findings.md](m2-findings.md).

## Prerequisites

- Node.js 22, npm.
- A built offline bundle in `./dist` (`scripts/build-local.sh`, see
  [local-bundle.md](local-bundle.md)). Override with `BENTO_DIST=/path/to/dist`.
- Linux: a graphical session to run the window. Electron 45.1.0 is installed
  into `desktop/node_modules` by `npm install` (its postinstall downloads the
  binary from GitHub releases, checksum-verified by `@electron/get`).
- NOT VERIFIED: macOS and Windows (no local machine; M4 builds them in CI).

## Run

```sh
cd desktop
npm install
npm start                          # transport: bento:// scheme (default)
BENTO_TRANSPORT=http npm start     # loopback HTTP alternative
npm test                           # unit tests + real-Electron e2e, one process per scenario (needs ../dist)
```

`npm test` runs the e2e suite with `--ozone-platform=headless` (see findings:
on the dev machine a real Wayland window received no animation frames).
Narrow it with `BENTO_E2E_TRANSPORTS=scheme` and `BENTO_E2E_SCENARIOS=isolation,handoff`.

## Layout

| File | Role |
|---|---|
| `src/main.js` | entry; picks transport and starts the app |
| `src/app.js` | wires transport, session lockdown, IPC, window |
| `src/transport-scheme.js` / `transport-http.js` | the two transports |
| `src/static-files.js` | path resolution (no dotfiles/`_headers`), MIME, Range (RFC 9110), 404 (transport-neutral) |
| `src/headers.js` | CSP from `dist/_headers` (fail-closed script-src, `blob:` dropped) plus forced COOP/COEP/CORP |
| `src/security.js` | window prefs, permission denial, request/navigation locks |
| `src/failure.js` | error page on renderer crash / failed load (never a blank window) |
| `src/ipc.js`, `channels.js`, `preload.js` | the file bridge (`window.bentoDesktop`) |
| `src/open-file.js`, `src/menu.js` | OS "open with" paths (argv, second instance) validated and turned into grants; minimal Help/About menu |
| `tools/`, `electron-builder.yml` | packaging: fuse hook and checker, Linux targets (see desktop-linux.md) |
| `src/shell/` | the tabbed shell (M3a): window, tabs/partitions, document store, recents, registry, menus; see [shell.md](shell.md) |
| `test/` | unit tests and the Electron scenario runners (`runner/main.js` M2 window, `runner/shell-main.js` shell) |

## Security model

- Renderer: `contextIsolation`, `sandbox`, `webSecurity` on; no Node
  integration (main, workers, subframes); no `<webview>`; no `remote`.
- Origin: only the app origin (`bento://app` or `http://127.0.0.1:<port>`).
  Every request outside it, `blob:<origin>` and inline `data:` image/font URLs
  is cancelled by a session `onBeforeRequest` hook (`devtools:` only when not
  packaged), on top of the CSP from `dist/_headers`.
- Headers: COOP `same-origin`, COEP `require-corp`, CORP `same-origin` are
  forced by the shell and always override the bundle (which asks for
  `credentialless`/`cross-origin`). `require-corp` is chosen because every
  subresource is same-origin, so the stricter value costs nothing. The CSP is
  refused unless `script-src` is free of `'unsafe-eval'`/`'unsafe-inline'`,
  except `'unsafe-eval'` which is allowlisted in `src/headers.js` with its
  reason (LibreOffice WASM, see findings "CSP experiment"). `blob:` is removed
  from `script-src`. `_headers` rules for `/docs` are not applied; a bundle that
  contains `docs/` is refused. `style-src 'unsafe-inline'` is kept as shipped by
  the bundle and was not tested for removal.
- Navigation: `will-navigate`, `will-frame-navigate`, `will-redirect` are
  pinned to the app origin (default deny, also on errors); `window.open` is
  denied and logged (the https allowlist for `shell.openExternal` is empty).
- Permissions: all permission, device and display-capture requests are denied;
  each decision is logged and recorded for the tests.
- Files: the renderer never supplies a path. `openFile()` shows a native
  dialog in the main process and returns opaque tokens (10 minute TTL, at most
  64 per window, revoked when the window is destroyed). `readFile(token)` opens
  the file once, `fstat`s the handle, rejects anything that is not a regular
  file (FIFO, device) and reads at most 512 MiB. `saveFile()` accepts only an
  allowlisted extension (documents, images, archives, text formats; see
  `SAVE_EXTENSIONS` in `src/ipc.js`), checks it again on the path chosen in
  the native dialog, and writes only there. IPC handlers reject senders that
  are not the top-level frame of the app origin.
- Static files: dotfiles, `_headers` and `_redirects` are never served;
  symlinks leaving the root are 404.
- Loopback transport only: requests must carry the exact loopback `Host`
  (anti DNS-rebinding), no foreign `Origin`, and a per-run secret cookie
  (set into the window's session by the main process; HttpOnly, SameSite=Strict).
  Other local processes that reach the port without the token get 403.
  Not an issue for the scheme transport.
- Robustness: renderer crash or failed main-frame load shows a static error
  page; `uncaughtException`/`unhandledRejection` are logged and exit non-zero;
  a second instance on the same profile quits (single-instance lock).
  `BENTO_DIST`/`BENTO_TRANSPORT` are ignored when `app.isPackaged`
  (packaged, the bundle is read from `process.resourcesPath/dist`).

## Bridge API (`window.bentoDesktop`)

```ts
openFile(options?: { multiple?: boolean; extensions?: string[] }): Promise<{ token: string; name: string; size: number }[]>
readFile(token: string): Promise<Uint8Array>
saveFile(suggestedName: string, bytes: Uint8Array): Promise<{ saved: boolean; name?: string }>
handoffToInput(files: PickedFile[], selector?: string): Promise<number>  // sets <input type=file> + fires 'change'
takeOpenedFiles(): Promise<PickedFile[]>   // PDFs the OS asked us to open (argv / open-with); drains the queue and starts push delivery
onFileOpened(callback: (file: PickedFile) => void): () => void   // later opens (second instance); returns an unsubscribe function
```
