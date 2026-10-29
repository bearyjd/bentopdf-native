# BentoPDF Native on Windows (M5 packaging)

Unofficial packaging of BentoPDF as a locked-down Electron app, Windows x64 only.
Same app, same security model as Linux ([desktop.md](desktop.md), [desktop-linux.md](desktop-linux.md)).
**Honesty rule for this page:** this project is developed on Linux with no Windows machine and no
Wine. Only the things marked "proven by a Windows CI run" below ran on Windows, and only if the
run named in the status section succeeded. Everything else says NOT VERIFIED.

## Status of evidence

See "What was and was not verified" at the end. In short: the Windows build configuration was
exercised on Linux up to the unpacked app (a real `win-unpacked` tree with fuses flipped; the NSIS
step needs Wine and cannot run here); the installer, uninstaller, registry, shortcuts, marker-gated test mode
and sandbox were exercised by `desktop-windows.yml` on `windows-latest`. **The last run (40853355808, on head 9d6b8e8, after the review fixes) is green; the earlier replay run was 40845803115**;
the portable exe's second-instance forwarding (issue #11) runs as its own step whose exit code 3 (only the known
signature) is listed as `KNOWN FAILURE #11` in the job summary and is NOT VERIFIED (the portable cannot enter test
mode); any other portable failure turns the job red.

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
node test/packaged-smoke-win.js "<COPY of win-unpacked>/BentoPDF Native.exe"  # headless smoke; writes and removes the test-mode marker in that tree, so never point it at release output
```

Outputs: `bentopdf-native-<version>-setup-x64.exe` (NSIS) and `bentopdf-native-<version>-portable-x64.exe`.
Configuration: `desktop/electron-builder.win.config.js` (derived from the Linux config; names, app id and icon
come from `desktop/brand.json`, including the new `iconIco`). `packaging/icons/render-ico.sh` rebuilds
`packaging/icons/icon.ico` from `icon.svg` with the repo-local `make-ico.js`; the `.ico` is committed.

## Install, portable, uninstall

| Format | How | Notes |
|---|---|---|
| Installer | run `...-setup-x64.exe` | per-user by default (no administrator rights, installs under `%LOCALAPPDATA%\Programs`), not one-click: the wizard lets you change the folder and offers all-users; desktop and Start-menu shortcuts |
| Portable (EXPERIMENTAL) | run `...-portable-x64.exe` | **the installer is the only supported Windows target.** The portable exe fails if a second PDF is opened while it runs (issue #11). Nothing is installed or registered; the exe unpacks to a temp folder on each start, so startup is slower than the installed app |
| Silent (CI) | `setup.exe /S /D=C:\path` | `/D=` must be last and unquoted |

**All-users installs and the install folder.** An all-users (per-machine) install registers the app in HKLM, where an
administrator later launches it from the ProgID. If the folder were user-writable, a standard user could replace
the exe the administrator runs. The default per-machine location (Program Files) is writable only by
administrators, but the wizard lets you pick any folder. `installer.nsh` therefore **refuses a per-machine install
whose folder is not under `%ProgramFiles%` (or contains `..`)** (checked in `customInit`, so also for silent
`/D=` installs, and again after the directory page). Per-user installs are unaffected: the folder is the user's own,
and the user can replace the app there anyway. **NOT VERIFIED:** the per-machine path never ran (the lifecycle smoke
installs per-user; the NSIS code is only compiled by CI), and the ACL of a custom per-user folder is the user's
choice (a folder shared with other users is the user's responsibility).

Uninstall via Settings > Apps or `Uninstall BentoPDF Native.exe`. It removes the files the installer put in the install
folder (app subfolders and the Electron file set; NOT `RMDir /r` of the folder: a foreign file in a user-chosen folder
survives, proven by the canary check of the lifecycle smoke when it ran on windows-latest), the
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

**What an unsigned installer means in practice.** SmartScreen warns again for every new version (reputation is per
file hash, and builds are not reproducible bit for bit), so each release asks users to click through. Check the
SHA256 of every download against the published `SHA256SUMS` (that proves the file is the one CI built, not who built
it). This is **unofficial packaging** of the upstream BentoPDF web app, not a release of the upstream project.
Unsigned, freshly packaged Electron executables are also a common antivirus false-positive pattern: expect some
scanners to flag them (NOT measured here).

Optional signing in CI (`desktop-windows.yml`): the secrets `WIN_CSC_LINK` (+ `WIN_CSC_KEY_PASSWORD`) become
`CSC_LINK`/`CSC_KEY_PASSWORD` for electron-builder, or the Azure Trusted Signing set `AZURE_SIGN_ENDPOINT`,
`AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`. They are handed **only** as `env:` of the one build step "signed when secrets exist" (never via
`$GITHUB_ENV`, so no later step inherits them and a newline in a value cannot inject variables), and that step runs only
for pushes to `main` and `v*` tags: pull requests, `workflow_dispatch` from other branches and the temporary branch
trigger use the unsigned step, whose environment holds no secret. With no secrets the signing step is inert (empty
values are unset). **Before any secret is added the repository owner must create a GitHub Environment (for example
`windows-signing`) restricted to `main` and `v*` tags and move the secrets there; the workflow deliberately names no
environment, so nothing is created or protected until then.** No secrets were created by this work. electron-builder
runs our `afterPack` fuse hook first and signs afterwards, so the signature covers the fused binary. **Signing was never
exercised (no secrets exist): NOT VERIFIED.** Issue #13 is addressed (this branch, see "Build flavours"): the release
installer and portable carry no test mode, and only they are built in the signing step; the smoke flavour is built in
its own step with no secret in its environment and refuses to build if any signing variable is set.

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
the app in **test mode**: the window is created hidden and never shown, nothing appears on screen, and the app
writes `app.getAppMetrics()` (`sandboxed`, `integrityLevel` per process) to the profile directory. The smoke asserts
every renderer (`Tab`) is `sandboxed: true` at `untrusted` or `low` integrity. This is Electron's own report of the
OS-level sandbox, **only proven if the Windows run succeeded**.

### Build flavours (issue #13)

As on Linux (`docs/desktop-linux.md`, "Build flavours"), `BENTO_FLAVOUR=release` (default) packs the stub
`desktop/flavours/release/test-mode.js` and `build-flavour.js = 'release'`: a RELEASE installer/portable has no
marker logic, no test-only switch and no honoured test variable, and `testModeOn` refuses test mode in the release
flavour even when `app.isPackaged` is false. That Electron derives it from the executable name, so that a signed
`BentoPDF Native.exe` copied as `electron.exe` would count as unpackaged (where the environment alone used to enable
test mode), is inferred from Electron's source and measured on Linux only; it was NOT measured on Windows, and
`--mode release-refusal` passes whether or not the flag flipped there. The test-mode module is removed from a release
build; the test-only branches of `main.js` still ship but are dead code (see the Linux document). This closes the scenario of the PR #12 security review: malware that writes the marker
and sets the variable next to a validly signed release executable gets no test mode, no hidden window and no
accepted debug-port switch. `BENTO_FLAVOUR=smoke npm run dist:win` builds the SMOKE installer/portable into
`desktop/release-smoke/` (names carry `SMOKE-ONLY-NOT-FOR-DISTRIBUTION`); CI builds it in the same job, gates it with
`verify-artifact-win.sh --flavour smoke` (never `--release`) and never uploads it. Only `desktop/release/*.exe` are
uploaded as candidates.

What CI runs on Windows (`packaging/windows/smoke-installer.sh <setup> <portable> <smoke-setup>`):

- RELEASE installer: the full install/registry/shortcut/uninstall lifecycle, the release gate on the installed tree,
  and `packaged-smoke-win.js --mode release-refusal`: the marker written and `BENTO_TEST_HEADLESS=1` set, the app
  started as itself and as a hard link named `electron.exe` must exit 2 without a `DevToolsActivePort` file; marker
  and link are removed again (checked).
- SMOKE installer (other directory, after the release uninstall): gate `--flavour smoke`, the full test-mode smoke
  below, uninstall.
- RELEASE portable: the checks that need no test mode.

The Windows gate mutation test (`test-verify-artifact-win.sh --seed <release win-unpacked> --smoke-seed <smoke
win-unpacked>`) runs the release-flavour mutations on the release tree and the marker-logic mutations on a copy
carrying the smoke `app.asar`.

### Test mode on Windows (smoke flavour only: marker file)

As on Linux, a packaged SMOKE build enters test mode only with `BENTO_TEST_HEADLESS=1` in the environment **and** the
marker file `resources\.bento-test-mode` (`src/test-mode.js`); every test-only behaviour in `main.js` (hidden window,
debugging switches, event log, trace, sandbox report) keys off that combined result. No artifact may contain the
marker (`verify-artifact-win.sh` fails if one is found, any case), and release artifacts do not contain this code. Windows has no uid or mode bits, so the win32
branch checks what it can:

- `process.resourcesPath` is its own native real path (`realpathSync.native`, compared case-insensitively as NTFS
  does): a junction, symlink or 8.3 short name in the path fails closed;
- the marker is found with `lstat` directly inside that directory, is a regular file and not a symlink/junction;
- its own native real path is exactly `<resources>\.bento-test-mode` (no other reparse point redirects it);
- the handle that is read is the file that was `lstat`ed (same `dev`/`ino`), has one hard link, exactly the token's
  size and exactly the token.

**Ownership and write permission are not checked; they are left to the install directory's ACLs.** A per-machine
install under `Program Files` is writable only by administrators. A per-user install under `%LOCALAPPDATA%` is
writable by that user, who can equally replace the executable itself, so the marker grants nothing extra there.
It exists only in the never-distributed smoke flavour. Chromium parses the debugging switch before any JavaScript
runs, so even a release build started with it may hold the port until it exits 2; whether a listener appears in that
window was NOT measured on Windows (the release-refusal check only proves exit 2 and no `DevToolsActivePort` file).
The checks run as unit tests on every platform against a fake fs (each single check removed turns a test red), on
real NTFS files on `windows-latest` (`test-mode.test.js`, and `tools/check-asar-policy.js` inside the Windows gate),
and the gate also requires each control's text in the packaged `test-mode.js`.

For the SMOKE installer the CI smoke runs the gate on the installed tree first, then
`desktop/test/packaged-smoke-win.js`, which proves the installed copy refuses the test switches WITHOUT the marker
(exit 2, no debug port), writes the marker into that disposable installed copy, runs the checks and removes it
again; the lifecycle script asserts it is gone before the uninstall assertions ("no files left").

**The portable exe cannot enter test mode.** Its stub extracts the app to `%TEMP%\<dir>` at every launch and runs
`RMDir /r` on that directory first (`app-builder-lib/templates/nsis/portable.nsi`, also when `portable.unpackDirName`
fixes the name), so a pre-placed marker is always deleted. The portable smoke therefore runs only what needs no test
mode (refusal of the test switches without the marker, `/no-sandbox` refused with exit 2, no registry/shortcut traces;
the payload itself is gated by 7-Zip extraction) and prints the rest as NOT VERIFIED.

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
- Network shares (UNC) are refused for open-with. A mapped drive cannot be told from a local one lexically, but the resolved (native real) path is checked again, so a mapped drive that resolves to a UNC path is refused (fake-fs unit test; real mapped drives NOT VERIFIED).
- On win32 `fs.constants.O_NOFOLLOW` does not exist: the open-with "no symlink" open cannot rely on it. It is compensated by `lstat` (not a link), the native real path equal before and after the open, and the opened handle having the lstat'ed file's 64-bit id (bigint `dev`/`ino`). Unit tests use a fake fs; real NTFS links NOT VERIFIED beyond the pre-existing dev/ino swap test.
- The portable exe leaves its unpacked copy in `%TEMP%` while running, and wipes that directory (`RMDir /r`) at every
  launch, including a second launch while the first is still running from it (a plausible cause of issue #11, NOT verified).
- The portable exe cannot be smoke-tested in test mode (see "Test mode on Windows"). It is EXPERIMENTAL: the installer is the only supported Windows target, and the portable exe fails if a second PDF is opened while it runs (issue #11).
- `static-files.js` refuses Windows-unsafe segment names (`~digit`, colon, trailing dot, device names) on every platform on purpose; `scripts/check-dist.sh` (`desktop/tools/check-dist-names.js`) and `test/dist-names.test.js` fail if a bundle asset would trip them.
- The `.ico` is rendered from the same neutral glyph as the PNG; the product-name trademark question is unchanged.
- The bundled upstream pages do not consume open-with events yet (M3 viewer).

## What was and was not verified

Evidence = GitHub Actions runs of `desktop-windows.yml` on `windows-latest` (a standard runner, headless, Windows
Server image), from the branch `feat/m5-windows-on-main` (this work replayed onto main's marker-gated test mode),
2026-10-29: 40840134744 (cancelled before it started, superseded), 40840883624 (red: three of main's unit tests assumed
POSIX: a FIFO, a `/ok/c.pdf` argv without an explicit platform, `0600` mode bits), **40845803115 (green, replay before the review fixes)** and **40853355808 (green, on head 9d6b8e8, after the review fixes)**.
The temporary `push:` trigger used for these runs was removed again; the workflow runs on `workflow_dispatch`, `main`
and tags. Earlier evidence from the pre-main branch (runs 40805536068 ... 40813630518) is superseded.

**Proven by runs 40845803115 and 40853355808 on a real Windows runner** (figures below are from the later run, 40853355808, unless stated)
- Build of the NSIS installer and portable exe; the Windows gate passes on both (7-Zip extraction) and on
  `win-unpacked`; inside every gate run `tools/check-asar-policy.js` ran the packaged win32 marker branch against real
  NTFS files (valid accepted; extra bytes, other token, hard link, file symlink, directory, junctioned resources refused)
  and against a fake fs, and the argv policy. Gate mutation test: 60 caught, 0 missed, 1 skipped; asar-policy mutation test: 10 caught, 0 missed (Git Bash cannot make symlinks).
- Silent per-user install and uninstall: files, HKCU uninstall entry, shortcuts (no sandbox/devtools arguments), ProgID,
  `OpenWithProgids`, `.pdf` default untouched; uninstall leaves no files, keys or shortcuts.
- **Marker-gated test mode on the installed copy:** without the marker the test switches are refused (exit 2, no debug
  port); with the marker written into the disposable installed copy the app enters test mode (hidden window); the marker
  is removed again and asserted absent before the uninstall assertions.
- Installed app in test mode (24/24 checks): `bento://app` loads, `crossOriginIsolated`, no external requests, no Node
  globals, tool page has no shell bridge, `BENTO_*` ignored, renderer `sandboxed: true` at `untrusted` integrity, the
  launch-argument PDF opens as a document tab of the shell, the shell UI is served from the asar (129 tools); second
  instance (single-argument launches, as the registered `"%1"` produces), each with positive evidence in the event log:
  a backslash path with a space and non-ASCII and a `file:///C:/...` URL become document tabs, a UNC path
  `\\127.0.0.1\c$\...` is delivered and refused, Windows' injected argv passes the switch policy; `/no-sandbox` exits 2.
- Portable exe without test mode: test switches refused (exit 2), `/no-sandbox` refused (exit 2), no registry/shortcut traces.
- Unit tests on Windows: 231 tests, 212 pass, 0 fail, 19 skipped with stated reasons (POSIX-only FIFOs, mode bits and the POSIX
  marker branch); the real-file win32 marker test ran and passed. `windows`, `brand`, `headers`: 69 pass. Lint passes.

**Failing / not proven**
- **Portable exe, second instance (issue #11): NOT VERIFIED, KNOWN FAILURE.** The pre-main branch measured that a second
  `portable.exe` launch hangs before starting an app. The portable stub runs `RMDir /r` on its extraction directory at
  every launch (portable.nsi), which plausibly explains it (NOT verified) and also means no test-mode marker can be
  placed, so it cannot be exercised now. `packaged-smoke-win.js --portable --mode second-instance-only` exits 3 ONLY for
  that signature (first instance healthy; second launch hung or its forwarding unobservable) and 1 for anything else;
  `portable-second-step.sh` makes 3 a green step with a `KNOWN FAILURE #11` summary line and every other code red
  (exit-code policy unit-tested on Linux with fakes; the first real run of the new step is listed below).
- **Portable exe in test mode: NOT VERIFIED** (page isolation, sandbox level, open-with): proven on the installed app
  only, which ships the same payload (both pass the gate by extraction).
- **Multi-argument launches can crash the installed app before JavaScript runs** (tracking issue #14): `[file URL, UNC path]`
  and `[path with space, file URL, UNC path]` exit with code 4294967295, no trace file and no Chromium log (measured,
  reproducible in this run and the previous ones); `[space, URL]` and `[space, UNC]` are fine, and every single argument is
  fine. Cause NOT determined (happens before `main.js`; not our argument policy). Not produced by Explorer's open command
  (one `"%1"`), reported by the smoke as `INFO multi-argument` lines, not as checks.
- Argument policy: **measured** on Windows: `/no-sandbox` as the first instance's argument is refused with exit 2 by our
  code. **Read from Chromium source, NOT measured**: that Chromium itself would honour `/switch` and lowercases names. A
  POSIX-looking `/d/a.pdf` is therefore dropped (whole launch ignored in a second instance) on win32; real Windows file
  arguments (`C:\x.pdf`, `\\server\share\x.pdf`, `file:///C:/x.pdf`) never start with a slash. This is why the unit test
  that failed on Windows was wrong, not the policy: it now passes the platform explicitly (`linux` or `win32`).
- Code signing, SmartScreen behaviour, an all-users (per-machine) install, upgrade-over-existing install, a visible
  window, real Explorer double-click / "Open with" / default-app selection, Windows Firewall behaviour, Windows ARM
  and older Windows versions: NOT VERIFIED (never run).
- NTFS specifics (8.3 names, streams, mapped drives) are covered by lexical unit tests and fake-fs tests only; 64-bit file ids
  are compared as bigint (fake-fs tests with ids that differ only beyond 2^53). On Windows a symlink swapped in after a grant is refused by the dev/ino identity check, not by `ELOOP`.
- Licences of what the Windows packages add (NSIS, its plugins, Microsoft DLLs inside Electron) were not reviewed; see NOTICE.
- Multi-argument second-instance launches were not re-measured beyond the INFO lines in the smoke log (issue #14).
- The win32 marker check's reliance on install-directory ACLs (no owner/mode check) is a design statement, not tested;
  since issue #13 it matters only for the never-distributed smoke flavour.
- Linux side (dev host): `packaging/test-verify-artifact.sh --appimage-only` aborts silently when `desktop/release/` is
  absent (`newest()` under `set -euo pipefail`; a bug on main, not fixed here); with explicit
  `--deb /dev/null --rpm /dev/null --appimage <rebuilt AppImage>` it passes 78/0, and the Linux packaged smoke passes 18/18.

**Earlier false root-cause hypotheses (ruled out by evidence):** wrong `--user-data-dir` (same dir was used and worked),
handler registered late (single-argument launches arrive), early abort in our policy (traces show it passes). The first
failing runs launched a three-argument command that crashes in the multi-argument case above, so "nothing delivered" had been
misread as a lock problem; two smoke checks that reported ok were vacuous and now require positive evidence.
