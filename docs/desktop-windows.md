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
(40805536068) is red**: everything below passed except the second-instance forwarding check.

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
Server image), from the branch `feat/m5-windows-packaging`, 2026-10-29. Four runs were used: 40799612108 (a unit-test
fixture used the wrong realpath; build skipped), 40801299255 (build ok; gate and smoke scripts had path bugs, e.g.
`sha256sum` printing a `\` before the digest for Windows paths), 40802920084 (app smoke ran), 40805536068 (final).

**Proven by run 40805536068 on a real Windows runner**
- The NSIS installer and the portable exe build with electron-builder 26.18.0 and Electron 45.1.0 (unsigned).
- `verify-artifact-win.sh` passes on both real artifacts (opened with 7-Zip, two levels) and on `win-unpacked`:
  licences, SOURCE.txt (Windows variant, commit, upstream, Electron hashes), fuses on the real exe, asar/bundle layout,
  forbidden flags, no signing material.
- `test-verify-artifact-win.sh`: positive control passes on the real installer and portable exe, every mutation is
  caught (the symlink mutation is skipped where the shell cannot create symlinks).
- Silent per-user install to a temp dir: executable, uninstaller, HKCU uninstall entry, desktop and Start-menu
  shortcuts (targets are the installed exe, arguments contain no sandbox/devtools switch, read with `WScript.Shell`);
  `OpenWithProgids` value and ProgID `shell\open\command` registered; the `.pdf` default value was not set.
- Silent uninstall removes the executable, install directory contents, uninstall entry, both shortcuts, the ProgID
  key and the `OpenWithProgids` value.
- Headless packaged smoke (installed app and portable exe): window loads `bento://app`, `crossOriginIsolated` true,
  no external resource requests, no Node globals in the page, `BENTO_DIST`/`BENTO_TRANSPORT` ignored, the launch
  argument PDF arrives through the grant bridge and is readable via its token, the renderer (`Tab`) process reported
  by `app.getAppMetrics()` as `sandboxed: true` at `untrusted` integrity (GPU `low`; the browser and a utility process are
  `sandboxed: false`, `high`, as expected), a launch with `/no-sandbox` exits 2.
- The Windows-relevant unit tests (`windows.test.js`, `brand.test.js`, `headers.test.js`) and lint pass on Windows;
  the POSIX-oriented tests were run informationally and passed too.

**Failing / not proven**
- **Second-instance forwarding on Windows is NOT working in the smoke test.** A second launch with the same
  `--user-data-dir` and a backslash path, a `file:///C:/...` URL and a UNC path exits with code 4294967295 (installed app)
  and never reaches the first instance: the first instance's test event log shows no `second-instance` event, and the
  second process wrote no `lock denied` event, so it seems to terminate before `main.js` reaches the single-instance
  lock. The cause is unknown (not investigated further: the four allowed CI iterations were used). Linux forwards
  correctly. Until fixed, "Open with" on a running window is NOT VERIFIED on Windows; opening a PDF by launching the app with it
  is proven. The UNC refusal is only proven at the unit level (the UNC case "passing" in the smoke is vacuous while
  forwarding is broken).
- `/switch` handling is from the Chromium source plus unit tests and the `/no-sandbox` exit-2 probe: whether Chromium itself
  honours `/remote-debugging-port=...` was not measured.
- Code signing, SmartScreen behaviour, an all-users (per-machine) install, upgrade-over-existing install, a visible
  window, real Explorer double-click / "Open with" / default-app selection, Windows Firewall behaviour, Windows ARM
  and older Windows versions: NOT VERIFIED (never run).
- NTFS specifics (8.3 names, streams, mapped drives, 64-bit file index precision in `dev`/`ino`) are covered by lexical unit
  tests only.
- Licences of what the Windows packages add (NSIS, its plugins, Microsoft DLLs inside Electron) were not reviewed; see NOTICE.
- The existing Linux `packaging/test-verify-artifact.sh` fails its positive control on this dev host ("missing or empty:
  resources/LICENSE" on the AppImage tree) both with and without these changes; not investigated.
