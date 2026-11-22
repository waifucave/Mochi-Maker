# Third-party notices

Mochi Maker uses the following open-source packages at run time. Each is used
as published on npm, unmodified. Their full license texts are in their packages
(`node_modules/<name>/LICENSE`), and every desktop package carries them in its `licenses/` folder.

| Package | Version | License | Copyright | Used by | Purpose |
|---|---|---|---|---|---|
| [@sinclair/typebox](https://github.com/sinclairzx81/typebox) | 0.34.52 | MIT | Copyright (c) 2017-2026 Haydn Paterson | core, art | JSON Schema and static types for commands and the document |
| [ag-psd](https://github.com/Agamnentzar/ag-psd) | 31.0.3 | MIT | Copyright (c) 2016 Agamnentzar | art, editor | reading PSD files; writing the PSD of the pose |
| [pako](https://github.com/nodeca/pako) | 2.1.0 | MIT AND Zlib | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn | art (through ag-psd) | zlib decompression |
| [base64-js](https://github.com/beatgammit/base64-js) | 1.5.1 | MIT | Copyright (c) 2014 Jameson Little | art (through ag-psd) | base64 |
| [fast-png](https://github.com/image-js/fast-png) | 8.0.0 | MIT | Copyright (c) 2015 Michaël Zasso | art | PNG decoding and encoding |
| [iobuffer](https://github.com/image-js/iobuffer) | 6.0.1 | MIT | Copyright (c) 2015 Michaël Zasso | art (through fast-png) | binary buffers |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett | art, export, cli, editor | unzipping OpenRaster files; deflate for PNG; zipped exports; opening and saving zipped projects in the editor |
| [ws](https://github.com/websockets/ws) | 8.22.0 | MIT | Copyright (c) 2011 Einar Otto Stangvik, (c) 2013 Arnout Kazemier and contributors, (c) 2016 Luigi Pinca and contributors | bridge, mcp, cli | the live bridge's WebSocket server and Node client |
| Mochi2D | 0.24.0 | MIT | Copyright (c) 2026 Mochi2D contributors | art, export, api, cli, editor | model data, writer, validator, loading and evaluation; zip reading; the editor’s view (its browser bundle) |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | 5.2.2 | MIT | Copyright (c) 2023 Vanilagy | editor | MP4 files for the video export |
| [Electron](https://github.com/electron/electron) | 44.9.2 | MIT | Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc. | desktop | the desktop app's shell |

**Mochi2D's own notices.** Mochi2D's builds include code from other projects, listed in Mochi2D's
own `THIRD_PARTY_NOTICES.md` (in its package, `node_modules/mochi2d/THIRD_PARTY_NOTICES.md`, with
the license texts). The parts that reach Mochi Maker's builds through Mochi2D's library and browser
bundles are:

- [fflate](https://github.com/101arrowz/fflate) (MIT), for reading zip archives and compressing
  screenshots;
- TypeScript ports of musl's float32 `atan2f`, `atanf`, `sinf` and `cosf` (from FreeBSD's msun),
  under musl's MIT license with the Sun Microsystems notice of its math code, which the evaluator
  uses for rotations.

Every desktop package carries Mochi2D's notices as `licenses/mochi2d.THIRD_PARTY_NOTICES.md`.

None of these packages is related to Live2D. Mochi Maker's own algorithms
(outline tracing, simplification, constrained Delaunay triangulation, mesh
editing) are in `packages/geometry` and use no third-party code.

The editor's build (`packages/editor/dist`) bundles the packages above that
it uses. Development-only tools (TypeScript, Vitest, fast-check, Prettier,
@types/node, @types/ws, Vite, playwright-core, @electron/packager) are not distributed with Mochi Maker;
Vite's build adds no runtime code of its own beyond its module-preload helper
(MIT, Copyright (c) 2019-present VoidZero Inc. and Vite contributors).

The desktop build (`packages/desktop`) is Electron with the editor's build and the
bundled main process inside. A packaged app carries Electron's own `LICENSE` and
`LICENSES.chromium.html` (the licenses of Chromium and the components Electron ships) next to its
executable, as @electron/packager puts them there; they are distributed unchanged.
Next to them, and inside the app, the `licenses/` folder holds Mochi Maker's `LICENSE`, this file, `TERMS.md`,
`ASSETS.md`, the license text of every package in the table above
(`<package>.LICENSE.txt`) and Mochi2D's notices. `packages/desktop/build.mjs` puts them there, and
the desktop tests and the packaged app's smoke test check them.
