# BentoPDF Native on Windows (M5 packaging)

Unofficial packaging of BentoPDF as a locked-down Electron app, Windows x64 only.
Same app, same security model as Linux ([desktop.md](desktop.md), [desktop-linux.md](desktop-linux.md)).
**Honesty rule for this page:** this project is developed on Linux with no Windows machine and no
Wine. Only the things marked "proven by a Windows CI run" below ran on Windows, and only if the
run named in the status section succeeded. Everything else says NOT VERIFIED.

## Status of evidence

See "What was and was not verified" at the end. In short: the Windows build configuration was
exercised on Linux up to the unpacked app (a real `win-unpacked` tree with fuses flipped; the NSIS
step needs Wine and cannot run here); the installer, uninstaller, registry, shortcuts and sandbox
were exercised by the GitHub Actions workflow `desktop-windows.yml` on `windows-latest`. **The last run
(40813630518) is red** only because the PORTABLE exe's second-instance forwarding does not work (installed app: 21/21
smoke checks passed). See "What was and was not verified".

## Prerequisites (build)

- Windows with Git Bash (CI: `windows-latest`), Node.js 22, git. 7-Zip is used by the gate to open the installers.
- `desktop/` dependencies installed **on Windows**: `cd desktop && npm ci` (Electron 45.1.0 win32-x64).
- The offline bundle `dist/` (about 370 MB). It is platform-independent and built by
  `scripts/build-local.sh` on Linux; CI builds it in an `ubuntu-latest` job and passes it to the Windows
  job as an artifact. `scripts/package-windows.sh` does not build it and fails with a message when it is missing.
- Network for npm and electron-builder tools. No signing material is needed.

## Build

```sh
cd desktop && npm ci
bash ../scripts/package-windows.sh          # NSIS installer + portable exe into desktop/release/
bash ../packaging/verify-artifact-win.sh release/bentopdf-native-*-setup-x64.exe
bash ../packaging/verify-artifact-win.sh release/bentopdf-native-*-portable-x64.exe
bash ../packaging/test-verify-artifact-win.sh --seed release/win-unpacked   # mutation test of the gate
node test/packaged-smoke-win.js "release/win-unpacked/BentoPDF Native.exe"  # headless smoke, no visible window
```

Outputs: `bentopdf-native-<version>-setup-x64.exe` (NSIS) and `bentopdf-native-<version>-portable-x64.exe`.
Configuration: `desktop/electron-builder.win.config.js` (derived from the Linux config; names, app id and icon
come from `desktop/brand.json`, including the new `iconIco`). `packaging/icons/render-ico.sh` rebuilds
`packaging/icons/icon.ico` from `icon.svg` with the repo-local `make-ico.js`; the `.ico` is committed.

## Install, portable, uninstall

| Format | How | Notes |
|---|---|---|
| Installer | run `...-setup-x64.exe` | per-user by default (no administrator rights, installs under `%LOCALAPPDATA%\Programs`), not one-click: the wizard lets you change the folder and offers all-users; desktop and Start-menu shortcuts |
| Portable | run `...-portable-x64.exe` | nothing is installed or registered; the exe unpacks to a temp folder on each start, so startup is slower than the installed app |
| Silent (CI) | `setup.exe /S /D=C:\path` | `/D=` must be last and unquoted |

Uninstall via Settings > Apps or `Uninstall BentoPDF Native.exe`. It removes the install folder, the
shortcuts, the uninstall entry and the `.pdf` registry keys listed below. It does **not** delete your
settings/profile in `%APPDATA%\BentoPDF Native` (not installed files; `deleteAppDataOnUninstall` is off;
pass `--delete-app-data` to the uninstaller to remove it). There is no auto-update, deliberately: the app makes
no network requests. Install a newer version yourself.

## SmartScreen, signing and checksums

The artifacts are **unsigned unless the repository owner configures signing secrets**. No key or certificate is
in this repository. On an unsigned download Windows SmartScreen shows "Windows protected your PC / unrecognised
app" (More info, then Run anyway). That is expected, not a malware verdict, and a signature would not make it
disappear instantly either (reputation builds over time; OV certificates still warn at first; NOT VERIFIED
which certificate type the owner will use). Verify a download against the published `SHA256SUMS`:

```powershell
Get-FileHash .\bentopdf-native-0.1.0-setup-x64.exe -Algorithm SHA256   # compare with SHA256SUMS
```

Optional signing in CI (`desktop-windows.yml`, step "Optional code signing"): secrets `WIN_CSC_LINK` (+
`WIN_CSC_KEY_PASSWORD`) become `CSC_LINK`/`CSC_KEY_PASSWORD` for electron-builder, or the Azure Trusted Signing
set `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER`, `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. Variables that are empty are never exported. electron-builder runs our
`afterPack` fuse hook first and signs afterwards, so the signature covers the fused binary. **Signing was never
exercised (no secrets exist): NOT VERIFIED.**

## File association ("Open with")

`packaging/windows/installer.nsh` registers the app as one of the programs that can open `.pdf`; it does **not**
make it the default. (electron-builder's own `fileAssociations` was rejected: its macro overwrites the default
value of `HKCU\Software\Classes\.pdf` and the uninstaller never restores it.) Keys written, all removed on
uninstall (HKCU for the per-user install, HKLM for all-users):

- `Software\Classes\.pdf\OpenWithProgids` value `<appId>.pdf`
- `Software\Classes\<appId>.pdf` (description, icon, `shell\open\command` = `"<exe>" "%1"`)

Choose the default yourself in Settings > Apps > Default apps (Windows 10/11 protect that choice from programs).
Launch arguments and second-instance arguments flow through the same filter and grant bridge as on Linux
(`src/open-file.js`): the renderer never supplies a path. Windows-specific rules (`windowsPathProblem`, unit-tested
on every OS with a `platform` parameter):

- accepted: `C:\dir\x.pdf`, `C:/dir/x.pdf`, relative paths (resolved against the second instance's cwd),
  `file:///C:/dir/x.pdf` (percent-decoded), the extended-length local form `\\?\C:\...` (prefix stripped), long paths
- **refused (UNC / remote files are not opened by default):** `\\server\share\...`, `//server/...`, `\\?\UNC\...`,
  `\\.\...`, `file://server/share/...`; also drive-relative `C:x.pdf`, any `:` after the drive letter (alternate
  data streams `x.pdf::$DATA`), `* ? " < > |`, control characters, names ending in a dot or space, and device
  names `CON PRN AUX NUL COM1-9 LPT1-9 CONIN$ CONOUT$` with or without an extension
- a mapped network drive (`Z:\`) **cannot be told from a local disk** lexically and is not detected
- after the lexical checks the file must still be a regular file, at most 512 MiB, starting with `%PDF-`
  (checked on an open handle). `dev`/`ino` are compared between grant and read; on NTFS the 64-bit file index can
  exceed 2^53 and lose precision in a JS number: NOT VERIFIED on Windows

## Argument policy on Windows

Chromium on Windows accepts a leading `/` as a switch prefix as well as `--` and `-` (`kSwitchPrefixes` in
`base/command_line.cc`, `{"--", "-", "/"}` under `IS_WIN`; switch names are lowercased there). That is from reading
the Chromium source, **NOT measured on a Windows runner**. The allowlist therefore treats any argument starting
with `/` as a switch **on win32 only** (so a file argument must be a drive path, a backslash path or a `file:` URL,
never `/x.pdf`); on POSIX `/home/u/x.pdf` stays a file. `--` ends options as before. The unit tests
(`test/windows.test.js`) cover `/no-sandbox`, `/NO-SANDBOX`, `/remote-debugging-port=...` and the allowed forms.
As on Linux, the first instance's own switches have already been parsed by Chromium before JavaScript runs: this
is a fail-closed tripwire (exit code 2), and the CI smoke checks that `/no-sandbox` is refused that way.

## Static file serving (bundle)

The scheme handler refuses, before any file system call and on every platform: backslashes, `..`, `:` (drive
letters, alternate data streams), `* ? " < > |`, control characters, trailing dot or space (Windows strips them,
so `_headers.` would otherwise open `_headers`), 8.3 short-name look-alikes (`NAME~1`), and device names with
any extension. Hidden-file names are compared case-insensitively. After that, symlink/realpath containment
applies as before; the root is canonicalised with `fs.realpathSync.native` (the JS version keeps 8.3 names such
as `RUNNER~1`, which would never match the native paths of files inside). The bundle was checked to contain
none of the refused names. All of this is unit-tested lexically; actual NTFS behaviour (short names, streams) is
NOT VERIFIED beyond the CI smoke loading the app.

## Hardening shared with Linux

- Fuses flipped in `afterPack` on `BentoPDF Native.exe` (`tools/after-pack.js`, same list as Linux, asserted by
  `tools/check-fuses.js` inside the gate). Unlike Linux, `EnableEmbeddedAsarIntegrityValidation` is meaningful on
  Windows: electron-builder embeds the asar hash in the exe; the install smoke proves the app still starts.
- App code in `app.asar` (about 55 KB), the 370 MB bundle in `resources\dist` outside it (extraResources).
- `BENTO_DIST`/`BENTO_TRANSPORT` are ignored when packaged (gate: static check; smoke: hostile values).
- No `--no-sandbox` anywhere: the gate scans the asar, shortcut/script/config files and the electron-builder
  config; the lifecycle smoke reads the real `.lnk` targets and arguments with `WScript.Shell`.
- The executable is `BentoPDF Native.exe` (electron-builder names Windows executables after `productName`;
  `executableName` is Linux-only).

## Sandbox

`sandbox: true` and context isolation are set for every window (`src/security.js`). The packaged smoke runs
the app in **test mode** (`BENTO_TEST_HEADLESS=1`): the window is created hidden and never shown, nothing
appears on screen, and the app writes `app.getAppMetrics()` (`sandboxed`, `integrityLevel` per process) to the
profile directory. The smoke asserts every renderer (`Tab`) is `sandboxed: true` at `untrusted` or `low`
integrity. This is Electron's own report of the OS-level sandbox, **only proven if the Windows run succeeded**.
Test mode also admits the debugging switches the smoke needs; as on Linux, anyone who can set environment
variables for the process can enable it, which is outside this threat model (they can already run the exe).

## Offline behaviour

Unchanged: a session hook cancels every non-app request. The smoke asserts no external resource entries and no
"blocked request" log line. Windows Firewall prompts are not expected because the app opens no listening socket
in normal use (scheme transport); the smoke's debugging port exists only in test mode.

## Release hygiene (AGPL obligations)

Every Windows artifact carries `LICENSE.electron.txt` and `LICENSES.chromium.html` (next to the exe), our
`LICENSE`, `NOTICE` and `SOURCE.txt` (`resources\`), generated by the same `gen-source-txt.sh` (it detects
`electron.exe`, hashes it and the `electron-v<ver>-win32-x64.zip` found in the Electron cache). The gate opens
the installer and the portable exe with 7-Zip (two levels: `app-64.7z` inside the NSIS payload) and the installed
tree directly, and fails on missing/empty files, a wrong commit or dirty tree in SOURCE.txt, flipped fuses, honoured
`BENTO_*` overrides, sandbox-off flags, `.pdb`/`.pfx`/`.pem`/`.key`/secret files and symlinks in the payload.
`packaging/test-verify-artifact-win.sh` mutates a tree 39 ways (plus a symlink case) (missing licences, flipped fuse, `--no-sandbox` in a
UTF-16 `.lnk`/`.bat`/`.ps1`/config, honoured overrides, wrong commit, emptied NOTICE, forbidden files, empty tree...)
and requires every one to fail the gate.

Releases are tag builds only: the workflow checks that `HEAD` is the tag's commit and that the tag is reachable
from `main`, then runs `check-notice.sh --release` and the gate with `--release`. `NOTICE` still has unresolved
lines (including new Windows ones: NSIS and its plugins, the Microsoft DLLs in Electron), so **no release can be
cut yet**; non-tag builds are uploaded as `...-NOT-FOR-RELEASE-<n>-unresolved-notice-lines`. Source offer: the About
dialog and `SOURCE.txt`, as on Linux.

## Known limits

- x64 only (no arm64, no 32-bit). No Microsoft Store/MSIX, no winget manifest, no auto-update.
- Network shares (UNC) are refused for open-with; mapped drives are not distinguished.
- The portable exe leaves its unpacked copy in `%TEMP%` while running.
- The `.ico` is rendered from the same neutral glyph as the PNG; the product-name trademark question is unchanged.
- The bundled upstream pages do not consume open-with events yet (M3 viewer).

## What was and was not verified

Evidence = GitHub Actions runs of `desktop-windows.yml` on `windows-latest` (a standard runner, headless, Windows
Server image), from the branch `feat/m5-windows-packaging`, 2026-10-29. Runs: 40805536068 (second-instance checks failed,
vacuous refusal checks), 40808241772 (test-mode tracing added, unit tests made blocking and exposed Windows-incorrect test
fixtures), 40811392955 (probes: single-argument launches work on the installed app), **40813630518 (final)**. The
temporary `push:` trigger used for these runs was removed again; the workflow runs on `workflow_dispatch`, `main` and tags.

**Proven by run 40813630518 on a real Windows runner**
- Everything listed for 40805536068 still passes: installer/portable build, 7-Zip extraction gate, gate mutation test,
  silent install and uninstall (files, HKCU uninstall entry, shortcuts, ProgID, `OpenWithProgids`, `.pdf` default untouched),
  window loads `bento://app`, `crossOriginIsolated`, no external requests, no Node globals, `BENTO_*` ignored, the
  launch-argument PDF arrives through the grant bridge, renderer sandboxed at `untrusted` integrity, `/no-sandbox` exits 2.
- **Installed app, second instance (single-argument launches, which is what the registered `"%1"` command produces):**
  each launch exits 0 after `lock denied`, and each one provably reached the first instance (a `second-instance` event is
  in the event log, required by the harness as positive evidence): a backslash path with a space and a non-ASCII letter is
  granted, a `file:///C:/...` URL is granted, a UNC path `\\127.0.0.1\c$\...` is delivered and NOT granted (refused), and
  the argv Windows delivers (it contains `--allow-file-access-from-files` injected by Electron, nothing else) is not
  rejected by the switch policy. 21/21 checks of the installed smoke passed.
- Unit tests that run on Windows (`open-file`, `argv-policy`, `ipc`, `security`, `static-files`, `transport-http`,
  `normalise-modes` plus `windows`, `brand`, `headers`) pass: 50 pass, 0 fail, 3 skipped (stated POSIX-only reasons: named
  pipes/`/dev/zero`, a FIFO in `validateOpenPath`, unix permission bits in `normaliseModes`). The step is blocking.

**Failing / not proven**
- **Portable exe: second-instance forwarding does NOT work (FAIL in the smoke).** A second `portable.exe` launch never exits
  within 30 s and never reaches `main.js`. Process listing while stuck: the first stub has the running app as a child from
  its extraction directory under `%TEMP%`; the second stub is running and has no child. So the second stub itself hangs
  before starting an app, probably while extracting into/over the locked directory or waiting on something (cause NOT
  determined; hidden modal dialog not verified). Opening a PDF by launching the portable exe once is proven. A user
  double-clicking a PDF with the portable build while it is running would not be forwarded. Possible next probes: the
  electron-builder `portable` `unpackDirName` / `requestExecutionLevel` options and the stub's behaviour.
- **Multi-argument launches can crash the installed app before JavaScript runs:** `[file URL, UNC path]` and
  `[path with space, file URL, UNC path]` exit with code 4294967295, no trace file and no Chromium log (measured, reproducible
  in this run and the previous ones); `[space, URL]` and `[space, UNC]` are fine, and every single argument is fine. Cause
  NOT determined (happens before `main.js`; not our argument policy). Not produced by Explorer's open command (one `"%1"`),
  reported by the smoke as `INFO multi-argument` lines, not as checks.
- Argument policy: **measured** on Windows: `/no-sandbox` as the first instance's argument is refused with exit 2 by our
  code. **Read from Chromium source, NOT measured**: that Chromium itself would honour `/switch` and lowercases names. A
  POSIX-looking `/d/a.pdf` is therefore dropped (whole launch ignored in a second instance) on win32; real Windows file
  arguments (`C:\x.pdf`, `\\server\share\x.pdf`, `file:///C:/x.pdf`) never start with a slash. This is why the unit test
  that failed on Windows was wrong, not the policy: it now passes the platform explicitly (`linux` or `win32`).
- Code signing, SmartScreen behaviour, an all-users (per-machine) install, upgrade-over-existing install, a visible
  window, real Explorer double-click / "Open with" / default-app selection, Windows Firewall behaviour, Windows ARM
  and older Windows versions: NOT VERIFIED (never run).
- NTFS specifics (8.3 names, streams, mapped drives, 64-bit file index precision in `dev`/`ino`) are covered by lexical unit
  tests only. On Windows a symlink swapped in after a grant is refused by the dev/ino identity check, not by `ELOOP`.
- Licences of what the Windows packages add (NSIS, its plugins, Microsoft DLLs inside Electron) were not reviewed; see NOTICE.
- The existing Linux `packaging/test-verify-artifact.sh` fails its positive control on this dev host ("missing or empty:
  resources/LICENSE" on the AppImage tree) both with and without these changes; not investigated.

**Earlier false root-cause hypotheses (ruled out by evidence):** wrong `--user-data-dir` (same dir was used and worked),
handler registered late (single-argument launches arrive), early abort in our policy (traces show it passes). The first
failing runs launched a three-argument command that crashes in the multi-argument case above, so "nothing delivered" had been
misread as a lock problem; two smoke checks that reported ok were vacuous and now require positive evidence.
