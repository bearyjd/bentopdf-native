# bentopdf-native

Unofficial native packaging for [BentoPDF](https://github.com/alam00000/bentopdf):
an installable PWA, a desktop app (Electron: Linux, macOS, Windows) and an
Android app (Capacitor). Everything runs offline; no files leave your device.

> **Not affiliated with the BentoPDF project.** BentoPDF is by its authors and
> is AGPL-3.0. This repo only adds build tooling and wrappers around it.

## Status

Planning. Nothing is released yet. Roadmap:

1. Shared foundation: fully-offline "local bundle" build
2. PWA hardening (offline precache, COOP/COEP)
3. Desktop (Electron)
4. Android (Capacitor)

## How it works

Upstream is fetched at a pinned tag (`UPSTREAM_VERSION`), small patches in
`patches/` are applied, and the result is built and wrapped. No upstream code is
vendored here.

## License

AGPL-3.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). If you distribute a
build or run it as a network service, you must offer its corresponding source
under the same license.
