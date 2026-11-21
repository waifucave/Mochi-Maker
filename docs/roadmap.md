# Mochi Maker — Roadmap

The milestones, and where each stands. Items M1–M16 of Mochi2D in the «Depends on» column are the
capabilities that design section 5 asks of Mochi2D.

| # | Milestone | Delivers | Depends on | Status |
|---|---|---|---|---|
| **M0** | Design | `docs/design.md`, `docs/agent-api-design.md`, this roadmap | — | done |
| **M1** | Core | Monorepo setup (npm workspaces, strict TS, Vitest, CI); the document model; the command registry with schemas; transactions, undo/redo, log and replay; the project format with read, write and migrations; queries; invariants; the three command laws plus property tests. A headless CLI (`new`, `run`, `query`, `history`, `replay`). | — | done |
| **M2** | First export | Lowering for parts, art meshes, parameters, bindings and keyforms, draw order and sorting scopes; atlas packing; `model3.json`; `.moc3` v5 through Mochi2D; load check; export report; golden projects; round trip export → load → evaluate. `mochi-maker export`, `validate`. | Mochi2D M1, M3, M4, M13, M14 | done |
| **M3** | Art and meshes | PSD, ORA and PNG-folder import; mesh generation; mesh editing commands with keyform-safe topology changes. | M1 | done |
| **M4** | Deformers | Warp and rotation deformers, nesting, reparenting with keyform conversion, rotation scale normalization, editing in canvas space (inverse mapping). Golden projects for nested deformers. | M2; Mochi2D M7, M8 | done |
| **M5** | Agent API v1 | The typed API (`@mochi-maker/api`), generated method layer, `describe`; the MCP server; headless renders, sweeps and visual diffs; error fixes; documentation resources and prompts. | M2, M4; Mochi2D M7, M10 | done |
| **M6** | Editor v1 | Web app: viewport with Mochi2D rendering and overlays, the palettes (Parts, Deformer, Parameter, Inspector and the rest), command bar, history and validation; a familiar layout (menu bar, toolbar, View area tabs, dockable palettes, workspaces, rebindable keys); find and replace; brushes, stroke meshing and the mesh tools; model templates; the standard parameter IDs. | M4; Mochi2D M5, M6, M9, M12 | done |
| **M7** | Rig completeness | Clipping masks (normal and inverted), multiply and screen colors, glue, hit areas, display info (`.cdi3.json`), user data, standard groups. Golden projects for each. Glue authoring is not available in this build (feature flag `glue`). | M2 | done |
| **M8** | Blend shapes | Blend-shape parameters, targets on meshes, warps, rotations and parts, constraints; v4 restrictions in validation. Not available in this build (feature flag `blendShapes`). | M7 | done |
| **M9** | Physics, expressions, pose | Authoring and live preview; exports and their re-parse checks; the physics dialog with a live test; the Expression palette and pose groups with previews; motion sync. | M6 | done |
| **M10** | Motions | Timeline: curves with every segment type, events, fades, model curves; the Dope Sheet and the Graph Editor; recording from the viewport and animation templates; scrubbing with physics snapshots; the work area and markers; image, video and PSD export. | M9 | done |
| **M11** | Live bridge | The bridge endpoint and client, pairing, permissions, control lease, indicator, presence and focus; MCP `--bridge` mode. | M5, M6 | done |
| **M12** | Conformance pack | `mochi-maker conformance-pack`; golden coverage of every writer path; the pack of every golden at versions 3–5 in `conformance/`, with reference renders. | M8, M10 | done |
| **M13** | Compatibility targets | v4 and v3 export with downgrade diagnostics; `--moc-version auto`. | M8 | done |
| **M14** | Desktop build | Electron app (unsigned), native file dialogs, the bridge endpoint in the main process, auto-saved copies; Windows, macOS and Linux builds in CI. | M11 | done |
| **M15** | v6: offscreens and blend modes | Part offscreens and blend modes in the document, the editor's Inspector and view, the export and the import; renders in the agent API and the MCP server; a version 6 golden and every golden at version 6 in the conformance pack, with reference renders ([`export.md`](export.md#version-6)). Tested on the project's own models: no version 6 file from other software is at hand. | Mochi2D 0.22.0 | done |
| **M16** | moc3 import | A `.moc3` model folder (versions 3–6) opens as an editable project, from the editor's File menu, the CLI, the API and the MCP server ([`import.md`](import.md)); the round trip of every golden at versions 3–5 is bit-identical in evaluation and byte-identical in its files; files from other writers keep their orders, stacking, ranges and values, tested on synthetic models and one value at a time. | Mochi2D M2 | done |

**Order.** M1 → M2 was the critical path, because it proves the whole chain to a file that loads in
Mochi2D. M5 came before most of the editor work, M6, on purpose: the agent API exercises every
command headlessly first, and the editor is built on top of the same commands.
