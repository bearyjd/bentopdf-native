# Licence evidence review

Not legal advice. This file records what primary evidence says about each third-party item in NOTICE.
It states facts found in package metadata, files shipped inside the artifacts, and the upstream projects'
own licence files. It does not interpret how any licence applies to a particular use.

Evidence rules: package.json `license` fields (cached tarballs / installed packages), LICENSE/COPYING files
shipped inside the artifacts or packages, Electron's LICENSES.chromium.html, and upstream licence files fetched
from the project's own repository or vendor site. Nothing else counts. Status: resolved / unresolved / needs-legal.

## Evidence table

| Item | Claim | Evidence source and quote | Status |
|---|---|---|---|
| @tesseract.js-data/eng 1.0.0 (4.0.0_best_int) | MIT wrapper; model data Apache-2.0 | https://raw.githubusercontent.com/naptha/tessdata/gh-pages/README.md lists "4.0.0_best_int" as "Integerized Version of "Tessdata Best""; https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/README.md: "All data in the repository are licensed under the Apache-2.0 License, see file LICENSE" (LICENSE = Apache License 2.0); https://raw.githubusercontent.com/naptha/tessdata/gh-pages/LICENSE = Apache License 2.0. Registry metadata of the npm wrapper: MIT. Only `eng` ships by default | resolved (other OCR languages not reviewed) |
| Noto Sans OCR font (dist wasm/ocr/fonts/NotoSans-Regular.ttf) | SIL OFL-1.1 | The shipped file's name table, nameID 13: "This Font Software is licensed under the SIL Open Font License, Version 1.1." and nameID 14 "http://scripts.sil.org/OFL"; sha256 b85c38ec...d232d5 equals scripts/checksums.sha256; source pinned to googlefonts/noto-fonts commit ffebf8c1ee449e544955a7e813c54f9b73848eac, whose LICENSE (https://raw.githubusercontent.com/googlefonts/noto-fonts/ffebf8c1ee449e544955a7e813c54f9b73848eac/LICENSE) reads "This Font Software is licensed under the SIL Open Font License, Version 1.1." | resolved |
| @embedpdf/fonts-{latin,arabic,hebrew} 1.0.0 | OFL-1.1 | package.json "license": "OFL-1.1" and package/LICENSE in each tarball ("licensed under the SIL Open Font License, Version 1.1") | resolved |
| LibreOffice wrapper @matbee/libreoffice-converter 2.6.0 | MPL-2.0 | package.json "license": "MPL-2.0"; README "MPL-2.0 (same as LibreOffice)" | resolved |
| LibreOffice engine (soffice.wasm/.data) | MPL-2.0 core; third-party components under other licences | https://www.libreoffice.org/about-us/licenses/: "made available subject to the terms of the Mozilla Public License v2.0", "based on code from Apache OpenOffice made available under the Apache License 2.0", and "also includes software which differs from version to version under a large variety of other Open Source licenses". Shipped soffice.data contains: "%PRODUCTNAME is made available subject to the terms of the Mozilla Public License, v. 2.0 ... Third Party Code Additional copyright notices and license terms applicable to portions of the Software are set forth in the LICENSE.html file". The converter package ships no licence file and its `files` list excludes any LICENSE.html; dist contains none | MPL-2.0 resolved; third-party component list UNRESOLVED (needs LICENSE.html of the exact engine build, which was not obtained from a primary source) |
| zypak v2025.09 | BSD-3-Clause | Pinned by https://github.com/flathub/org.electronjs.Electron2.BaseApp (org.electronjs.Electron2.BaseApp.yml: tag v2025.09, commit 693a71c5...). https://github.com/refi64/zypak LICENSE: "Copyright 2019 Endless Mobile, Inc. Portions copyright 2015 The Chromium Authors", three-clause BSD text; GitHub licence API spdx_id BSD-3-Clause | resolved (text now reproduced in NOTICE) |
| patch-electron-desktop-filename 1.3 | BSD-3-Clause | Base app manifest pins https://codeberg.org/JakobDev/patch-electron-desktop-filename/archive/1.3.tar.gz. https://codeberg.org/JakobDev/patch-electron-desktop-filename/raw/tag/1.3/LICENSE: "BSD 3-Clause License / Copyright (c) 2026, JakobDev". Its vendored Go modules (go.mod.yml) have their own licences, not reviewed | resolved for the tool itself; vendored Go modules unresolved |
| Flatpak runtime and base | Runtime not redistributed; BaseApp files are | Already in NOTICE, read from the built tree (/app/share/licenses/org.electronjs.Electron2.BaseApp/ and /app/manifest.json). Not re-verified here | resolved (prior evidence) |
| Electron 45.1.0 / Chromium / FFmpeg LGPL | MIT; Chromium mix; libffmpeg.so LGPL-2.1+ | Prior NOTICE evidence (LICENSE.electron.txt, LICENSES.chromium.html, `strings` on libffmpeg.so). Additionally https://raw.githubusercontent.com/electron/electron/v45.1.0/DEPS: 'chromium_version': '156.0.8078.49' (the Chromium the source statement points to). LGPL replaceability depends on the user being able to swap libffmpeg.so; verify per package format | resolved as a statement; needs-legal for compliance adequacy |
| NSIS / Windows installer | NSIS: zlib/libpng; bzip2 module: bzip2 licence; LZMA module: CPL-1.0 + linking exception | ~/.cache/electron-builder/nsis-3.0.4.1/*/COPYING: "All NSIS source code, plug-ins, documentation, examples, header files and graphics, with the exception of the compression modules and where otherwise noted, are licensed under the zlib/libpng license"; "The bzip2 compression module for NSIS is licensed under the bzip2 license"; "The LZMA compression module for NSIS is licensed under the Common Public License version 1.0" with a stated special exception for linking. nsis-resources-3.4.1 plug-in DLLs (nsis7z, UAC, StdUtils, nsisunz, INetC, EmbedHTML, ...) ship without licence files in the cache | NSIS core resolved; plug-in DLLs unresolved. No Windows installer is built locally, so NOTICE only records "not part of any artifact yet" |
| PyMuPDF / Ghostscript / CoherentPDF | AGPL as shipped; separate commercial licences exist | @bentopdf/pymupdf-wasm 0.11.16, @bentopdf/gs-wasm 0.1.1: package.json "AGPL-3.0-only" and package/LICENSE = GNU AGPL v3; coherentpdf 2.5.5: "AGPL-3.0-or-later", LICENSE.md = AGPL v3. PyMuPDF https://raw.githubusercontent.com/pymupdf/PyMuPDF/main/README.md: "Open source - GNU AGPL v3." / "Commercial - separate commercial licences available from Artifex for proprietary applications." Ghostscript https://ghostscript.com/licensing/index.html: "Licensing is handled exclusively by Artifex Software, Inc." Cpdf https://raw.githubusercontent.com/coherentgraphics/cpdf-binaries/master/README.md: "Cpdf is distributed under the AGPL - see LICENSE.md." and "If you are unable to abide by the terms of the AGPL, you will need a commercial license." The npm packages are described as modified versions ("This package is a modified version of PyMuPDF/Ghostscript") | AGPL confirmed (resolved); commercial interplay for downstream redistributors: needs-legal |
| hyper-compress-wasm / Kura | Excluded | scripts/build-local.sh deletes kura/hyper-compress pages and scripts/check-dist.sh fails if either name appears in dist; upstream src does not import hyper-compress-wasm. Links to those pages remain in navbar/legal pages | resolved (statement of build behaviour) |
| Application icon | Self-made, CC0-1.0, no upstream artwork | packaging/icons/icon.svg header: "Neutral, self-made application icon: a document glyph. No upstream or third-party artwork. CC0-1.0."; the SVG is six plain shapes (rounded square, page, fold, three bars) and the 512x512.png render was inspected: no BentoPDF mark or text. git history: one commit (64107e6, author bearyjd) introduced the files. Provenance rests on the author's declaration plus inspection; there is no independent proof of authorship | resolved |

## Production npm dependencies (upstream v2.8.10 package-lock.json)

Source: every entry of upstream package-lock.json that is not marked `dev` / `devOptional` (472 entries),
with the lockfile "license" field. This is a superset of what lands in dist: upstream lists build tools
(vite, tailwindcss, terser, lightningcss, rolldown) and optional platform binaries as production
dependencies; those are not shipped in the bundle. Entries marked "no field" were checked in installed node_modules.

Licence counts: 
MIT: 335, ISC: 51, Apache-2.0: 21, BSD-3-Clause: 16, MPL-2.0: 13, 0BSD: 7, OFL-1.1: 7, BSD-2-Clause: 4, BlueOak-1.0.0: 4, (none): 3, (MIT AND Zlib): 2, Unlicense: 2, Python-2.0: 1, AGPL-3.0: 1, (MPL-2.0 OR Apache-2.0): 1, (MIT OR GPL-3.0-or-later): 1, (BSD-3-Clause OR GPL-2.0): 1, MIT-0: 1, MIT OR SEE LICENSE IN FEEL-FREE.md: 1


### Red flags

| Package | Lockfile licence | Note |
|---|---|---|
| bentopdf-pdfium 0.0.0-051abe5b72a9 | AGPL-3.0 | Copyleft (network). Same family as BentoPDF itself; not "-only"/"-or-later" |
| (BentoPDF wasm packages) pymupdf-wasm, gs-wasm, coherentpdf | AGPL | Copyleft; see evidence table. Loaded as separate wasm assets |
| jszip 3.10.1 | (MIT OR GPL-3.0-or-later) | Choice offered; MIT is the permissive option |
| node-forge 1.4.0 | (BSD-3-Clause OR GPL-2.0) | Choice offered; BSD-3-Clause is the permissive option |
| dompurify 3.4.12 | (MPL-2.0 OR Apache-2.0) | Choice offered; Apache-2.0 is the permissive option |
| @matbee/libreoffice-converter 2.6.0 | MPL-2.0 | File-level copyleft; engine adds third-party components (unresolved above) |
| lightningcss 1.32.0 (+ platform binaries) | MPL-2.0 | Build tool, not in dist |
| blob 0.0.4 | no field | Own README in the installed package: "## Licence / MIT". The webmodules/blob repo package.json says "license": "MIT". Pulled in by blob-stream |
| khroma 2.1.0 | no field | installed package ships `license` file: "The MIT License (MIT) Copyright (c) 2019-present Fabio Spampinato, Andrew Maney" |
| png-js 1.0.0 | no field | installed package ships LICENSE: "MIT License Copyright (c) 2017 Devon Govett" |
| rgbcolor 1.0.1 | MIT OR SEE LICENSE IN FEEL-FREE.md | Optional (canvg). LICENSE.md is MIT ("Copyright (c) 2016 Stoyan Stefanov"); FEEL-FREE.md is an informal permission note. Not necessarily in dist |
| argparse 2.0.1 | Python-2.0 | Permissive PSF-style; build-time |
| @fontsource/* (7) | OFL-1.1 | Font licence: reserved font names and no sale of the font alone; fine to bundle |

No package in the set carries GPL/LGPL/AGPL (other than the AGPL ones above) without a permissive alternative,
and no package lacks any licence statement in its own files. Licence expressions such as "(MIT AND Zlib)" (pako) require both sets of notices.

### Full list by licence


**MIT** (335): @antfu/install-pkg@1.1.0, @babel/runtime@7.29.2, @braintree/sanitize-url@7.1.2, @emnapi/core@1.11.1, @emnapi/runtime@1.11.1, @emnapi/wasi-threads@1.2.2, @iconify/types@2.0.0, @iconify/utils@3.1.0, @jridgewell/gen-mapping@0.3.13, @jridgewell/remapping@2.3.5, @jridgewell/resolve-uri@3.1.2, @jridgewell/source-map@0.3.11, @jridgewell/sourcemap-codec@1.5.5, @jridgewell/trace-mapping@0.3.31, @mermaid-js/parser@1.2.0, @napi-rs/canvas@0.1.97, @napi-rs/canvas-android-arm64@0.1.97, @napi-rs/canvas-darwin-arm64@0.1.97, @napi-rs/canvas-darwin-x64@0.1.97, @napi-rs/canvas-linux-arm-gnueabihf@0.1.97, @napi-rs/canvas-linux-arm64-gnu@0.1.97, @napi-rs/canvas-linux-arm64-musl@0.1.97, @napi-rs/canvas-linux-riscv64-gnu@0.1.97, @napi-rs/canvas-linux-x64-gnu@0.1.97, @napi-rs/canvas-linux-x64-musl@0.1.97, @napi-rs/canvas-win32-arm64-msvc@0.1.97, @napi-rs/canvas-win32-x64-msvc@0.1.97, @napi-rs/wasm-runtime@1.1.6, @nodable/entities@2.1.0, @oxc-project/types@0.138.0, @pdf-lib/fontkit@1.1.1, @pdf-lib/standard-fonts@1.0.0, @pdf-lib/upng@1.0.1, @phosphor-icons/web@2.1.2, @pkgjs/parseargs@0.11.0, @retejs/lit-plugin@2.0.7, @rolldown/binding-android-arm64@1.1.4, @rolldown/binding-darwin-arm64@1.1.4, @rolldown/binding-darwin-x64@1.1.4, @rolldown/binding-freebsd-x64@1.1.4, @rolldown/binding-linux-arm-gnueabihf@1.1.4, @rolldown/binding-linux-arm64-gnu@1.1.4, @rolldown/binding-linux-arm64-musl@1.1.4, @rolldown/binding-linux-ppc64-gnu@1.1.4, @rolldown/binding-linux-s390x-gnu@1.1.4, @rolldown/binding-linux-x64-gnu@1.1.4, @rolldown/binding-linux-x64-musl@1.1.4, @rolldown/binding-openharmony-arm64@1.1.4, @rolldown/binding-wasm32-wasi@1.1.4, @rolldown/binding-win32-arm64-msvc@1.1.4, @rolldown/binding-win32-x64-msvc@1.1.4, @rolldown/pluginutils@1.0.1, @tailwindcss/node@4.2.2, @tailwindcss/oxide@4.2.2, @tailwindcss/oxide-android-arm64@4.2.2, @tailwindcss/oxide-darwin-arm64@4.2.2, @tailwindcss/oxide-darwin-x64@4.2.2, @tailwindcss/oxide-freebsd-x64@4.2.2, @tailwindcss/oxide-linux-arm-gnueabihf@4.2.2, @tailwindcss/oxide-linux-arm64-gnu@4.2.2, @tailwindcss/oxide-linux-arm64-musl@4.2.2, @tailwindcss/oxide-linux-x64-gnu@4.2.2, @tailwindcss/oxide-linux-x64-musl@4.2.2, @tailwindcss/oxide-wasm32-wasi@4.2.2, @tailwindcss/oxide-wasm32-wasi/@emnapi/core@1.8.1, @tailwindcss/oxide-wasm32-wasi/@emnapi/runtime@1.8.1, @tailwindcss/oxide-wasm32-wasi/@emnapi/wasi-threads@1.1.0, @tailwindcss/oxide-wasm32-wasi/@napi-rs/wasm-runtime@1.1.1, @tailwindcss/oxide-wasm32-wasi/@tybys/wasm-util@0.10.1, @tailwindcss/oxide-win32-arm64-msvc@4.2.2, @tailwindcss/oxide-win32-x64-msvc@4.2.2, @tailwindcss/vite@4.2.2, @tybys/wasm-util@0.10.3, @types/d3@7.4.3, @types/d3-array@3.2.2, @types/d3-axis@3.0.6, @types/d3-brush@3.0.6, @types/d3-chord@3.0.6, @types/d3-color@3.1.3, @types/d3-contour@3.0.6, @types/d3-delaunay@6.0.4, @types/d3-dispatch@3.0.7, @types/d3-drag@3.0.7, @types/d3-dsv@3.0.7, @types/d3-ease@3.0.2, @types/d3-fetch@3.0.7, @types/d3-force@3.0.10, @types/d3-format@3.0.4, @types/d3-geo@3.1.0, @types/d3-hierarchy@3.1.7, @types/d3-interpolate@3.0.4, @types/d3-path@3.1.1, @types/d3-polygon@3.0.2, @types/d3-quadtree@3.0.6, @types/d3-random@3.0.3, @types/d3-scale@4.0.9, @types/d3-scale-chromatic@3.1.0, @types/d3-selection@3.0.11, @types/d3-shape@3.1.8, @types/d3-time@3.0.4, @types/d3-time-format@4.0.3, @types/d3-timer@3.0.2, @types/d3-transition@3.0.9, @types/d3-zoom@3.0.8, @types/geojson@7946.0.16, @types/linkify-it@5.0.0, @types/markdown-it@14.1.2, @types/mdurl@2.0.0, @types/node@25.5.0, @types/node-forge@1.3.14, @types/pako@2.0.4, @types/papaparse@5.5.2, @types/raf@3.4.3, @types/trusted-types@2.0.7, @upsetjs/venn.js@2.0.0, abort-controller@3.0.0, acorn@8.16.0, ansi-regex@5.0.1, anymatch/picomatch@2.3.2, archiver@7.0.1, archiver-utils@5.0.2, async@3.2.6, base64-arraybuffer@1.0.2, base64-js@1.5.1, bentopdf-viewer@2.9.1, binary-extensions@2.3.0, blob-stream@0.1.3, bmp-js@0.1.0, braces@3.0.3, brotli@1.3.3, buffer@6.0.3, buffer-crc32@1.0.0, buffer-from@1.1.2, bwip-js@4.8.0, canvg@3.0.11, chokidar@3.6.0, clone@2.1.2, color-convert@2.0.1, color-name@1.1.4, compress-commons@6.0.2, confbox@0.1.8, core-js@3.49.0, core-util-is@1.0.3, cose-base@1.0.3, crc32-stream@6.0.0, cropperjs@1.6.2, cross-fetch@4.1.0, cross-spawn@7.0.6, crypto-js@4.2.0, css-line-break@2.1.0, cytoscape@3.34.0, cytoscape-cose-bilkent@4.1.0, cytoscape-fcose@2.2.0, cytoscape-fcose/cose-base@2.2.0, cytoscape-fcose/layout-base@2.0.1, d3-dsv/commander@7.2.0, dagre-d3-es@7.0.14, dayjs@1.11.20, dfa@1.2.0, eastasianwidth@0.2.0, emoji-regex@9.2.2, enhanced-resolve@5.20.1, es-toolkit@1.46.1, event-target-shim@5.0.1, events@3.3.0, fast-deep-equal@3.1.3, fast-fifo@1.3.2, fast-png@6.4.0, fast-xml-builder@1.2.0, fast-xml-parser@5.7.1, fdir@6.5.0, fflate@0.8.3, fill-range@7.1.1, follow-redirects@1.16.0, fontkit@2.0.4, fsevents@2.3.3, glob/balanced-match@1.0.2, glob/brace-expansion@2.1.4, hachure-fill@0.5.2, heic2any@0.0.4, html2canvas@1.4.1, i18next@25.10.2, i18next-browser-languagedetector@8.2.1, i18next-http-backend@3.0.6, iconv-lite@0.6.3, immediate@3.0.6, iobuffer@5.4.0, is-binary-path@2.1.0, is-extglob@2.1.1, is-glob@4.0.3, is-number@7.0.0, is-stream@2.0.1, is-url@1.2.4, jiti@2.6.1, jpeg-exif@1.1.4, jspdf@4.2.1, jspdf-autotable@5.0.7, jszip/isarray@1.0.0, jszip/readable-stream@2.3.8, jszip/safe-buffer@5.1.2, jszip/string_decoder@1.1.1, katex@0.16.47, katex/commander@8.3.0, layout-base@1.0.2, lazystream@1.0.1, lazystream/isarray@1.0.0, lazystream/readable-stream@2.3.8, lazystream/safe-buffer@5.1.2, lazystream/string_decoder@1.1.1, lie@3.3.0, linebreak@1.1.0, linebreak/base64-js@0.0.8, linkify-it@5.0.2, lodash@4.18.1, lodash-es@4.18.1, magic-string@0.30.21, markdown-it@14.2.0, markdown-it-abbr@2.0.0, markdown-it-deflist@3.0.0, markdown-it-emoji@3.0.0, markdown-it-footnote@4.0.0, markdown-it-ins@4.0.0, markdown-it-mark@4.0.0, markdown-it-sub@2.0.0, markdown-it-sup@2.0.0, markdown-it-toc-done-right@4.2.0, marked@16.4.2, mdurl@2.0.0, mermaid@11.16.1, microdiff@1.5.0, mlly@1.8.2, nanoid@3.3.18, node-fetch@2.7.0, node-fetch/tr46@0.0.3, node-fetch/whatwg-url@5.0.0, node-readable-to-web-readable-stream@0.4.2, normalize-path@3.0.0, opencollective-postinstall@2.0.3, p-map@7.0.4, package-manager-detector@1.6.0, papaparse@5.5.3, path-data-parser@0.1.0, path-expression-matcher@1.5.0, path-key@3.1.1, pathe@2.0.3, pdf-fontkit@1.8.9, pdf-lib@1.17.1, pdfkit@0.17.2, performance-now@2.1.0, picomatch@4.0.4, pkg-types@1.3.1, pngjs@7.0.0, points-on-curve@0.2.0, points-on-path@0.2.1, postcss@8.5.26, preact@10.29.0, process@0.11.10, process-nextick-args@2.0.1, punycode.js@2.3.1, raf@3.4.1, readable-stream@4.7.0, readdir-glob/balanced-match@1.0.2, readdir-glob/brace-expansion@2.1.4, readdirp@3.6.0, readdirp/picomatch@2.3.2, regenerator-runtime@0.13.11, restructure@3.0.2, rete@2.0.6, rete-area-plugin@2.1.5, rete-connection-plugin@2.0.5, rete-engine@2.1.1, rete-render-utils@2.0.3, rolldown@1.1.4, roughjs@4.6.6, safe-buffer@5.2.1, safer-buffer@2.1.2, setimmediate@1.0.5, shebang-command@2.0.0, shebang-regex@3.0.0, sortablejs@1.15.7, source-map-support@0.5.21, stackblur-canvas@2.7.0, streamx@2.25.0, string-width@5.1.2, string-width-cjs@4.2.3, string-width-cjs/emoji-regex@8.0.0, string-width-cjs/is-fullwidth-code-point@3.0.0, string-width-cjs/strip-ansi@6.0.1, string_decoder@1.3.0, strip-ansi@7.2.0, strip-ansi-cjs@6.0.1, strip-ansi/ansi-regex@6.2.2, strnum@2.2.3, stylis@4.3.6, svg-pathdata@6.0.3, tailwind-merge@3.5.0, tailwindcss@4.2.2, tapable@2.3.0, tar-stream@3.1.8, teex@1.0.1, terser/commander@2.20.3, text-segmentation@1.0.3, tiff@7.1.3, tiff/iobuffer@6.0.1, tiny-inflate@1.0.3, tinyexec@1.0.4, tinyglobby@0.2.17, to-regex-range@5.0.1, ts-dedent@2.2.0, uc.micro@2.1.0, ufo@1.6.3, undici-types@7.18.2, unicode-properties@1.4.1, unicode-trie@2.0.0, unicode-trie/pako@0.2.9, utif@3.1.0, util-deprecate@1.0.2, utrie@1.0.2, uuid@14.0.1, vite@8.1.2, vite-plugin-static-copy@3.3.0, wasm-vips@0.0.17, wrap-ansi@8.1.0, wrap-ansi-cjs@7.0.0, wrap-ansi-cjs/ansi-styles@4.3.0, wrap-ansi-cjs/emoji-regex@8.0.0, wrap-ansi-cjs/is-fullwidth-code-point@3.0.0, wrap-ansi-cjs/string-width@4.2.3, wrap-ansi-cjs/strip-ansi@6.0.1, wrap-ansi/ansi-styles@6.2.3, xml-naming@0.1.0, zgapdfsigner@2.7.5, zip-stream@6.0.1, zlibjs@0.3.1, zod@4.3.6


**ISC** (51): @isaacs/cliui@8.0.2, @neslinesli93/qpdf-wasm@0.3.0, anymatch@3.1.3, chokidar/glob-parent@5.1.2, d3@7.9.0, d3-array@3.2.4, d3-axis@3.0.0, d3-brush@3.0.0, d3-chord@3.0.1, d3-color@3.1.0, d3-contour@4.0.2, d3-delaunay@6.0.4, d3-dispatch@3.0.1, d3-drag@3.0.0, d3-dsv@3.0.1, d3-fetch@3.0.1, d3-force@3.0.0, d3-format@3.1.2, d3-geo@3.1.1, d3-hierarchy@3.1.2, d3-interpolate@3.0.1, d3-path@3.1.0, d3-polygon@3.0.1, d3-quadtree@3.0.1, d3-random@3.0.1, d3-sankey/internmap@1.0.1, d3-scale@4.0.2, d3-scale-chromatic@3.1.0, d3-selection@3.0.0, d3-shape@3.2.0, d3-time@3.1.0, d3-time-format@4.1.0, d3-timer@3.0.1, d3-transition@3.0.1, d3-zoom@3.0.0, delaunator@5.0.1, foreground-child@3.3.1, glob@10.5.0, glob/minimatch@9.0.9, graceful-fs@4.2.11, inherits@2.0.4, internmap@2.0.3, isexe@2.0.0, lucide@0.575.0, markdown-it-task-lists@2.1.1, path-scurry/lru-cache@10.4.3, picocolors@1.1.1, pixelmatch@7.1.0, readdir-glob/minimatch@5.1.9, signal-exit@4.1.0, which@2.0.2


**Apache-2.0** (21): @chevrotain/types@11.1.2, @kenjiuno/msgreader@1.28.0, @swc/helpers@0.5.19, b4a@1.8.0, bare-events@2.8.2, bare-fs@4.5.6, bare-os@3.8.0, bare-path@3.0.0, bare-stream@2.10.0, bare-url@2.4.0, crc-32@1.2.2, detect-libc@2.1.2, events-universal@1.0.1, idb-keyval@6.2.2, pdfjs-dist@5.5.207, readdir-glob@1.1.3, tesseract.js@7.0.0, tesseract.js-core@7.0.0, text-decoder@1.2.7, wasm-feature-detect@1.8.0, xlsx@0.20.3


**BSD-3-Clause** (16): @lit-labs/ssr-dom-shim@1.5.1, @lit/reactive-element@2.1.2, d3-ease@3.0.1, d3-sankey@0.12.3, d3-sankey/d3-array@2.12.1, d3-sankey/d3-path@1.0.9, d3-sankey/d3-shape@1.3.7, diff@8.0.3, highlight.js@11.11.1, ieee754@1.2.1, lit@3.3.2, lit-element@4.2.2, lit-html@3.3.2, rw@1.3.3, source-map@0.6.1, source-map-js@1.2.2


**MPL-2.0** (13): @matbee/libreoffice-converter@2.6.0, lightningcss@1.32.0, lightningcss-android-arm64@1.32.0, lightningcss-darwin-arm64@1.32.0, lightningcss-darwin-x64@1.32.0, lightningcss-freebsd-x64@1.32.0, lightningcss-linux-arm-gnueabihf@1.32.0, lightningcss-linux-arm64-gnu@1.32.0, lightningcss-linux-arm64-musl@1.32.0, lightningcss-linux-x64-gnu@1.32.0, lightningcss-linux-x64-musl@1.32.0, lightningcss-win32-arm64-msvc@1.32.0, lightningcss-win32-x64-msvc@1.32.0


**0BSD** (7): @emnapi/core/tslib@2.8.1, @emnapi/runtime/tslib@2.8.1, @emnapi/wasi-threads/tslib@2.8.1, @swc/helpers/tslib@2.8.1, @tailwindcss/oxide-wasm32-wasi/tslib@2.8.1, @tybys/wasm-util/tslib@2.8.1, tslib@1.14.1


**OFL-1.1** (7): @fontsource/cedarville-cursive@5.2.7, @fontsource/dancing-script@5.2.8, @fontsource/dm-sans@5.2.8, @fontsource/great-vibes@5.2.8, @fontsource/kalam@5.2.8, @fontsource/lato@5.2.7, @fontsource/merriweather@5.2.11


**BSD-2-Clause** (4): @kenjiuno/decompressrtf@0.1.4, entities@4.5.0, node-fetch/webidl-conversions@3.0.1, terser@5.46.1


**BlueOak-1.0.0** (4): jackspeak@3.4.3, minipass@7.1.3, package-json-from-dist@1.0.1, path-scurry@1.11.1


**(none)** (3): blob@0.0.4, khroma@2.1.0, png-js@1.0.0


**(MIT AND Zlib)** (2): fast-png/pako@2.1.0, pako@1.0.11


**Unlicense** (2): markdown-it-anchor@9.2.0, robust-predicates@3.0.2


**Python-2.0** (1): argparse@2.0.1


**AGPL-3.0** (1): bentopdf-pdfium@0.0.0-051abe5b72a9


**(MPL-2.0 OR Apache-2.0)** (1): dompurify@3.4.12


**(MIT OR GPL-3.0-or-later)** (1): jszip@3.10.1


**(BSD-3-Clause OR GPL-2.0)** (1): node-forge@1.4.0


**MIT-0** (1): postal-mime@2.7.4


**MIT OR SEE LICENSE IN FEEL-FREE.md** (1): rgbcolor@1.0.1
