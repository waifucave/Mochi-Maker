# Changelog

Mochi Maker's releases. The version is the one in `package.json`; a release's tag is `v` plus it.

## 0.1.0

The first release: a pre-release of the desktop app, unsigned, for Windows (x64), macOS (Apple
silicon and Intel) and Linux (x64), with the command-line tool, the agent API and the MCP server
in the repository. Mochi Maker is a working editor, agent API and exporter, not yet at a 1.0
release. These work:

- the document model, commands, transactions, undo and redo, the replayable log and the project
  format; PSD, OpenRaster and PNG-folder import; automatic mesh generation, mesh editing, brushes
  and stroke meshing;
- deformers: nested warps and rotations, reparenting that keeps things in place, and canvas-space
  editing through Mochi2D's forward mapping;
- export of `.moc3` (versions 3–6, with `--moc-version auto`), textures and the runtime files
  through Mochi2D, with clipping masks, multiply and screen colors, hit areas, display info, user
  data, physics, expressions, pose, motions, sounds and motion sync;
- the agent API and the MCP server, with headless renders, sweeps and visual diffs;
- the editor: a web app over the same commands, with Mochi2D's view, a familiar layout (menu bar,
  toolbar, View area tabs and dockable palettes per workspace), rebindable shortcuts, a command
  bar, the timeline with the Dope Sheet and the Graph Editor, model templates, the usual parameter
  IDs, image and video export, and `window.mochi` for agents;
- the live bridge: agents work in the open editor through `mochi-maker bridge` (Mochi Studio's
  bridge protocol), with pairing, tokens with scopes, a control lease and `mochi-maker mcp
  --bridge`;
- the desktop app: the editor in Electron, with project folders saved straight to disk, auto-saved
  copies with recovery, the live link on a file watcher and the bridge built in; unsigned builds
  for Windows, macOS and Linux;
- the conformance pack (`conformance/`): every golden project exported at versions 3–6, with
  scenarios, results and reference renders, for checks by other implementations;
- version 6: offscreens and the version 6 blend modes, in the document, the editor's Inspector and
  view, the export and renders ([`docs/export.md`](docs/export.md#version-6)), tested on the
  project's own models;
- model import: a `.moc3` model folder (versions 3 to 6) opens as an editable project, from the
  File menu, the command line (`mochi-maker import-model`), the API and the MCP server; exported
  again without an edit, it evaluates as the file did in the cases the tests cover: the project's
  own exports, and synthetic models from other writers ([`docs/import.md`](docs/import.md));
- a command-line tool.

Glue and blend-shape authoring are not available in this build. Their code and tests are in the
repository behind the feature flags `glue` and `blendShapes`, which are off by default
([`docs/core.md`](docs/core.md#feature-flags)). Projects that hold glue or blend shapes still open,
but they do not export while the flags are off.
