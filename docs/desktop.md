# BentoPDF Desktop (Electron shell) - skeleton

Status: M2 prototype. A thin, locked-down Electron window that serves the
offline bundle in `./dist`. The Acrobat-style UI is M3; packaging is M4.
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
npm test                           # unit tests + real-Electron e2e (needs ../dist)
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
| `src/static-files.js` | path resolution, MIME, Range, 404 (transport-neutral) |
| `src/headers.js` | CSP from `dist/_headers` plus forced COOP/COEP/CORP |
| `src/security.js` | window prefs, permission denial, request/navigation locks |
| `src/ipc.js`, `channels.js`, `preload.js` | the file bridge (`window.bentoDesktop`) |
| `test/` | unit tests and the Electron scenario runner |

## Security model

- Renderer: `contextIsolation`, `sandbox`, `webSecurity` on; no Node
  integration (main, workers, subframes); no `<webview>`; no `remote`.
- Origin: only the app origin (`bento://app` or `http://127.0.0.1:<port>`).
  Every request outside it, `blob:<origin>` and `data:` is cancelled by a
  session `onBeforeRequest` hook, on top of the CSP taken verbatim from
  `dist/_headers` (no external origin allowed).
- Navigation: `will-navigate`, `will-frame-navigate`, `will-redirect` are
  pinned to the app origin; `window.open` is denied and logged (the https
  allowlist for `shell.openExternal` is empty).
- Permissions: all permission, device and display-capture requests are denied.
- Files: the renderer never supplies a path. `openFile()` shows a native
  dialog in the main process and returns opaque tokens; `readFile(token)`
  only serves tokens issued to that WebContents. `saveFile()` writes only to a
  path chosen in a native save dialog. IPC handlers reject senders that are
  not the top-level frame of the app origin. Limit: 1 GiB per read/write.
- Loopback transport only: requests must carry the exact loopback `Host`
  (anti DNS-rebinding) and no foreign `Origin`; any local process can still
  connect to the port. Not an issue for the scheme transport.

## Bridge API (`window.bentoDesktop`)

```ts
openFile(options?: { multiple?: boolean; extensions?: string[] }): Promise<{ token: string; name: string; size: number }[]>
readFile(token: string): Promise<Uint8Array>
saveFile(suggestedName: string, bytes: Uint8Array): Promise<{ saved: boolean; name?: string }>
handoffToInput(files: PickedFile[], selector?: string): Promise<number>  // sets <input type=file> + fires 'change'
```
