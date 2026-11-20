# Mochi Maker core — reference (M1, M3, M8, M9, M10)

This is what `@mochi-maker/core` and `mochi-maker` do today. The design behind
them is in [`design.md`](design.md) (sections 3 and 4) and
[`agent-api-design.md`](agent-api-design.md).

## Document

A `Document` is an immutable map from UID to object, plus `seq`, the UID counter.

| Kind | UID prefix | Notes |
|---|---|---|
| project | `project` | singleton: canvas, ordered lists, standard groups, hit areas, pose, user data, combined parameters, export settings |
| parameter | `param_` | min, max, default, repeat, decimals, type, key list |
| parameterGroup | `pgroup_` | display groups, nestable |
| part | `part_` | ordered children (parts and meshes), sorting scope, enabled, visible at start, rig (draw order), blend shapes |
| artMesh | `mesh_` | part, deformer, layer, UVs (layer pixels), triangles, clip, flags, rig (positions, opacity, draw order, colors), blend shapes |
| warp | `warp_` | rows, cols, cell mode, owning part, parent, rig (grid, opacity, colors), blend shapes |
| rotation | `rot_` | base angle, owning part, parent, rig (angle, origin, scale, mirror, opacity, colors), blend shapes |
| layer | `layer_` | an asset (SHA-256 of a PNG) placed on the canvas, with the source layer's visibility, opacity, blend mode, clipping and import notes |
| glue | `glue_` | two meshes, vertex pairs with weights, rig (intensity) |
| expression | `expr_` | entries (parameter, value, blend), fades |
| motion | `motion_` | meta, curves (model, parameter, part opacity) in the motion segment encoding, events |
| physicsSetting | `phys_` | inputs, outputs, particles, normalization |
| sound | `sound_` | a WAV asset (SHA-256), its name, sample rate, channels and length; a motion's `sound` starts it |

UIDs come from the counter, so the same commands always give the same UIDs, and
a UID is never reused, not even after undo. Export IDs are unique per namespace
(parameters, parameter groups, parts, meshes, deformers, glues) and match
`[A-Za-z0-9_]{1,63}`.

**Rigs.** Riggable objects (parts, meshes, warps, rotations, glues) have
`rig.bindings` (parameter and keys, a subset of the parameter's key list) and
`rig.keyforms`, the full grid with the first binding varying fastest. Each
keyform has `authored`: `false` marks cells filled automatically. Values are
stored as float32.

**Blend shapes.** Parts, meshes, warps, rotations and glues have
`blendShapes`, applied in list order. Each names a blend-shape parameter
(`type: 'blendShape'`, which cannot be bound normally), a subset of its keys,
a `base` key, one delta per key (the base key's all zero) and `constraints`:
weight curves `(value, weight)` over any parameter (even the blend shape's
own), combined as min(1, every curve). Weights above 1 are refused; negative
ones are allowed with a lint warning. Deltas hold offsets of the target's keyform fields: positions or grid
points in the target's own space, opacity, draw order, colors, and for
rotations angle, origin and scale, and for glues the intensity. Mirror flags
are never blended. Authored keyform opacities stay within 0…1, because the
runtime clamps a blend-shape target's opacity (and a glue's intensity). Commands:
`blendShape.add`, `set`, `setKeys`, `setConstraints`, `reorder`, `remove`.
- Mesh topology commands carry position deltas like keyform positions.
- `param.setKeys` refuses to remove a key a blend shape uses, with
  `blendShape.setKeys` fixes.
- Deleting a parameter with `cascade` removes its blend shapes, and
  constraints over it.
- Lint warns (`target-clamp-range`) when a blend-shape target's value, with
  its blend shapes at their extremes, can leave a range that version 5 clamps
  it to: opacity and colors 0…1, draw order 0…1000,
  rotation scale f32(10⁻⁴)…100, angle ±3600, glue intensity 0…1. A milder
  hint (`rotation-scale-unusual`) flags a scale above 10. Version 4 clamps
  nothing.

**Spaces.** Positions are stored in the parent deformer's space: canvas pixels
(y down) without a deformer; (u, v) in 0–1 inside a warp; pixels around the
origin inside a rotation. Deformers nest freely: a warp or rotation can sit in
either kind (`parent` on `deformer.createWarp`/`createRotation`).
`mesh.setDeformer` and `deformer.setParent` change a parent with the values as
given, or with `converted` values in the new space; the deformer operations of
`@mochi-maker/export` (`mesh.reparent`, `deformer.reparent`,
`keyform.moveInCanvas`, `deformer.remove`, see [`export.md`](export.md#deformers-mapping-and-reparenting))
compute those values through Mochi2D's forward mapping and record these
commands, so the log holds local values.

## Commands

`mochi-maker describe` lists them; `describe <name>` gives the JSON Schema,
errors and examples (`[op]` marks operations, below). Areas: `project`, `object`, `meta`, `pose`, `param`,
`paramGroup`, `part`, `tree`, `mesh`, `layer`, `deformer`, `rig`, `keyform`,
`glue`, `blendShape`, `expression`, `motion`, `physics`.

- **References** in arguments: a UID, `@kind:ExportId`, `@kind~"Display name"`,
  or in a batch `$n` / `$n.field` for an earlier command's result. Kinds in
  references: `param`, `pgroup`, `part`, `mesh`, `warp`, `rot`, `deformer`,
  `layer`, `glue`, `expr`, `motion`, `phys`. The log records resolved UIDs.
- **Deletes** fail with `E_IN_USE` while something refers to the object, and
  offer the `cascade: true` call as a fix. A cascade removes every reference:
  bindings (keeping the keyforms nearest the parameter's default), masks, hit
  areas, glues, pose entries, curves, physics inputs and outputs.
- **Scopes.** Every command and operation has Mochi Studio's bridge metadata:
  `scope` (`read`, `edit` or `export`; all document commands are `edit`),
  `undoable` and `readOnly`. `describe <name>` shows them.
- **Motion keys**. A curve is stored in the motion file's segment
  encoding plus `auto`, the indices of its Bézier segments that are Auto smooth
  (`packages/core/src/keys.ts`). The key commands work on keys, each carrying
  the interpolation of the segment after it (`linear`, `auto`, `step`,
  `inverseStep`, `bezier`): `motion.setKeys` (a whole curve from keys, with
  optional fades), `motion.insertKey` (on an existing segment it keeps the
  curve's shape; a new key at the end makes the segment before it Auto smooth;
  a new curve when there is none), `motion.deleteKeys` (`E_RANGE` for a time
  without a key; the last key removes the curve), `motion.moveKeys` (by time and
  value; Bézier handles move with their keys) and `motion.setInterpolation`
  (turned Bézier, a segment keeps the shape it had). Times match within 1e-6.
  Auto smooth segments are recomputed whenever keys change. `motion.setCurve`
  takes `auto` too, checked to name Bézier segments only.
- **Animation templates** are kept in `project.animationTemplates`
  (names unique): `template.create` (a motion's parameter keys from `from` to
  `to`, optionally of given parameters, stored from 0 by parameter export ID;
  `E_RANGE` without keys), `template.add` (a template as it is, from a file;
  `replace` overwrites one of the same name, else `E_DUPLICATE_NAME`),
  `template.rename`, `template.delete`, and `template.apply` (at a time in a
  motion: each curve goes to the parameter with its export ID, the keys inside
  the template's span give way; the result lists `parameters` and `unmatched`;
  `E_NOT_FOUND` when nothing matches). `templateMatch(template, exportIds)`
  tells the matched and unmatched IDs beforehand.
- **Guide images**: `part.create`/`part.update` take `guide`; such a part is a visual
  reference, left out of the export with everything in it unless
  `project.setExportSettings { includeGuideImages: true }`.
- **Copy and paste**: `copyFragment(view, uids)` makes a fragment (plain JSON) of art
  meshes and deformers with everything below them, their layers, and what they refer to outside
  (parameters by export ID, parts, deformers, masks). `objects.paste { fragment, part? }` puts it
  in: new UIDs, new export IDs where taken, parameters bound by export ID (an unbound binding is
  removed keeping the forms at the parameter's default; blend shapes on it are removed), masks to
  the copies or to meshes here, layers reused when the same layer is here; the rest is listed in
  `unbound`. The operations `clipboard.copy` and `clipboard.paste` (export.md) add images and
  in-place reparenting.
- **Work area and markers** (format 10): a motion keeps `workArea` (`{ start, end }` in
  seconds, or null; `motion.update { workArea }`, `E_RANGE` unless start < end) and `markers`
  (`{ time, name }` in time order; `motion.setMarkers`). Both are the editor's: playback loops the
  work area, exports render it, and neither is exported. `clipMotion(motion, start, end)` is the
  part between two times as a motion of its own, sampled at every frame.
- **Brushes and mesh tools**: `brushWeight(dx, dy, brush)` is the brush's falloff
  (radius, hardness, angle, roundness). `mesh.brushDeform { target, cell?, center, radius,
  hardness?, roundness?, angle?, offset }` moves a keyform's vertices under a brush by their weight,
  in the keyform's own space. `mesh.subdivide` splits every triangle into four (midpoints derived
  from their edges, so every keyform and blend shape looks the same). `mesh.fromStrokes { target,
  strokes, width, spacing? }` replaces the mesh by strips along strokes (texture space), through
  mesh.setTopology. `motion.markersToEvents` adds the markers to the events, without doubles.
  (`strokeStrip`, `resample` and `subdivide` are in `@mochi-maker/geometry`.)
- **Motion sync** (format 11): `motionSyncSetting` objects in `project.motionSyncOrder`
  (`motionsync.json`): a dictionary name (unique), use case, analysis type, sample rate, smoothing,
  blend ratio, driven parameters (damper, smooth), elements (id, name, enabled, scale) and
  `shapes[e][k]`. `motionSync.addSetting` (elements default to Silence, A, I, U, E, O; without
  `shapes`, ParamMouthOpenY and ParamMouthForm start at typical vowel shapes, within their ranges,
  and other parameters at 0: `MOTION_SYNC_TYPICAL_SHAPES`), `motionSync.updateSetting`
  (shapes follow the parameters and elements by ID when only they change; new cells start as in
  addSetting), `motionSync.removeSetting`. Deleting a driven parameter (cascade) drops its column.
- **A motion's motion sync** (format 12): a motion's `motionSync` names the setting
  through which its sound moves the mouth (`motion.update { motionSync }`; null: lip sync).
  Removing the setting clears it. Lint `motion-sync-without-sound` warns when a motion names a
  setting but starts no sound (the export leaves the setting out), with the fix to clear it.
- **Standard IDs** (`standard.ts`): `STANDARD_PARAMETERS` (40, with min, default, max,
  section, optional, meaning, and `group` for the Eye blink and Lip sync members),
  `STANDARD_PARAMETER_GROUPS` (20), `standardParameter(id)` and `caseOnlyStandard(id)` (the standard
  ID an ID matches only up to letter case). Also exported by `@mochi-maker/api`.
- **Find and replace**: `objects.replaceText { find, replace, pattern?, ignoreCase?,
  fields?, kinds? }` over the export IDs and names of parameters, parts, warps, rotations and art
  meshes, as plain text or a regular expression. `planReplace(view, args)` is the preview: every
  change, and the problems of the result (`E_BAD_EXPORT_ID`, `E_DUPLICATE_ID`, checked on the
  whole result, so IDs can swap). The command refuses a result with problems and changes nothing.
  References are UIDs, so everything stays attached.
- **Deform paths** are kept in `project.deformPaths`: editor-side helpers, never
  exported. `deformPath.create` (targets, level 2 or 3, points in canvas pixels, reach; returns
  its id), `deformPath.update` (points, reach) and `deformPath.delete`. They never block a
  delete: a path drops a deleted target and goes with its last one.
- **Four-corner forms**: `keyform.fillCorners {targets, parameters?}`. For objects bound
  to two parameters, each cell away from both defaults becomes K(x, rest) + K(rest, y) −
  K(rest, rest), field by field (opacity clamped to 0…1; flags from whichever edge set them),
  authored. With more bindings it runs for every key of the others; without `parameters`, objects
  need exactly two bindings, and others are skipped and listed. A default that is not a key is
  `E_RANGE`.
- **Recording helpers**: `fieldAt(rig, field, values)` blends a
  rotation's keyform field at parameter values as evaluation does
  (multilinear, held beyond the end keys), and `solveField` finds the value
  of one bound parameter that gives a wanted field value (exact; the
  smallest change in the parameter's range wins).
- **Motion lint**: `motion-missing-target` (error) for a curve whose
  parameter or part is gone, `motion-keys-out-of-order` (error) for segment
  times that go back, and `motion-fade-too-long` (warning) for a motion's or a
  curve's fade longer than the motion.
- **Errors** are `MochiError`s with `code`, `message`, `path`, `command`, `at`
  (index in the transaction), `details` and `fixes`. A fix is either a command
  to run or a replacement value for the failing argument.

## Operations

Some actions need more than the document: `art.import` reads files, and
`mesh.generate` and `mesh.regenerate` decode layer images. These are
**operations** (`defineOperation`). An operation:

- has the same self-description as a command;
- runs asynchronously inside a transaction (`Session.transactAsync`; other
  changes meanwhile fail with `E_BUSY`);
- changes the document only by running ordinary commands, so the log records
  plain commands and replays without the operation's inputs;
- may return preview images (PNG).

`runItems(ctx, label, items, { operations, dryRun })` runs a list that mixes
commands and operations as one transaction, with `$n` referring to item n's
result. Details are in [`art.md`](art.md). The deformer operations live in
`@mochi-maker/export`, next to the lowering they evaluate; its `OPERATIONS`
list holds every operation, and the API, CLI, MCP server and editor use it.

## Sessions and transactions

```ts
const s = Session.create(canvas);         // or Session.open(doc)
s.transact(label, (tx) => { tx.run(name, args); ... }, { dryRun, expectRevision, author });
s.runBatch(label, [{ name, args }, ...], options);
s.run(name, args, options);               // one command, one transaction
s.undo(); s.redo();
s.query({ kind, where, fields, offset, limit });
s.get(ref); s.validate();
s.log;                                    // the replayable log
replay(log, base?);                       // rebuilds a session; checks every result
```

- A transaction is atomic and is one undo step. After it, the invariants are
  checked on the whole document, and a violation rolls it back
  (`E_INVARIANT`).
- `dryRun` applies, reports changes and lint results, and discards.
- `expectRevision` fails with `E_REVISION_MISMATCH` (and lists what changed
  since) if the session moved on.
- The log starts with `init` (a new project) or `base` (the hash of a loaded
  document), followed by `tx`, `undo` and `redo` entries.

**Validation.** `checkInvariants` (must always hold: references, tree
structure, order lists, grids, export IDs, ranges) and `lint` (worth knowing:
filled keyforms, unused parameters, meshes without triangles or layers, empty
parts, and the physics rules: incomplete settings and bad normalization are errors, overlapping or
unbound outputs warnings; expressions naming a missing parameter and parts in two pose groups are
errors, a parameter named twice in an expression and pose groups of fewer than two parts warnings).

## Feature flags

Glue and blend-shape authoring are behind two feature flags, `glue` and `blendShapes`, both off by
default: they are not available in this build. Their commands, preview and export code and their
tests stay in the repository.

They are off by default because of the patent notice in the README. Turn them on only if you are satisfied that you may use them where you are.

- **Where they are set.** In the editor, Settings → Features. Headless (CLI, MCP server, scripts),
  the `MOCHI_MAKER_FEATURES` environment variable: a comma-separated list (`glue,blendShapes`) or
  `all`. From TypeScript, the `features` option of `Session.create`, `Session.open`, the API's
  `Project` and `exportModel` (`{ glue: true, blendShapes: false }`); without it, the environment
  variable decides.
- **When a flag is off**, a command that adds or changes glue, a blend-shape parameter or a blend
  shape's targets and constraints refuses with `E_FEATURE_OFF` ("Glue is not available in this
  build." or "Blend shapes are not available in this build."). Removing them (`glue.delete`,
  `blendShape.remove`) still works. `describe` lists those commands as not available, the editor
  hides their controls, and `exportModel` refuses a project that holds glue or blend shapes.
- **Projects that hold them still open**, and can be inspected and edited otherwise.
- **Tests** run with both flags on (`vitest.config.ts` sets the environment variable, and the
  editor's test harness turns them on in its settings). One test per flag checks the off behavior
  (`packages/core/test/features.test.ts`, `packages/export/test/features.test.ts`,
  `packages/editor/test/features.test.ts`). The conformance pack is built with them on.

## Project folder

```
Name.mochi/
  mochi-project.json           format "mochi-maker-project", version 10, writer, seq, project object
  parameters.json              parameters and parameter groups
  parts.json  layers.json  glues.json  physics.json
  meshes/<uid>.json  deformers/<uid>.json  expressions/<uid>.json  motions/<uid>.json
  assets/sha256-<hex>.png
  .mochi-cache/history.jsonl   the CLI's command history (not part of the project)
```

- Deterministic text: fixed key order; point and triangle lists one per line;
  float32 values as the shortest text that reads back exactly. Saving an
  unchanged document writes nothing, and save → load → save is byte-identical.
- Unknown keys are kept and written back.
- Readers migrate older versions step by step (`MIGRATIONS`) and refuse newer
  ones with `E_PROJECT_TOO_NEW`. Version 2 added the layer fields
  `opacity`, `blendMode`, `clipped` and `notes`. Version-1 projects get the
  defaults (1, normal, false, none). Version 3 (M8) added
  `blendShapes` to parts, meshes, warps and rotations, and version 4
  to glues; older projects get empty lists. Version 5 added sounds
  (`sounds.json`, the project's `soundOrder`, and WAV assets stored as
  `assets/sha256-<hex>.wav`) and the motions' `sound` field. Version 6
  added the curves' `auto` lists; older curves get `[]`. Version 7
  added `project.animationTemplates`; older projects get `[]`. Version 8
  added `project.deformPaths`; older projects get `[]`. Version 9 added the parts'
  `guide` flag and `exportSettings.includeGuideImages` (both false for older projects). Version 10
  added the motions' work area and markers; version 11 motion-sync settings
  (`project.motionSyncOrder`, `motionsync.json`); version 12 the motions' `motionSync`
  (null for older motions).
- Unreferenced assets are kept on save, because undo can bring their layers
  back. A clean-up command will come later.

## CLI

```
mochi-maker new <dir> [--canvas WxH] [--ppu N] [--origin X,Y]
mochi-maker run <project> <commands.jsonl|commands.json|script.mjs> [--dry-run] [--label L] [--author A] [--preview dir]
mochi-maker import <project> <file.psd|file.ora|file.png|folder> [--no-meshes] [--include-hidden] [--parent ref]
                   [--spacing N] [--margin N] [--tolerance N] [--preview out.png] [--dry-run]
mochi-maker query <project> [kind] [--where field=value] [--fields a,b] [--limit N] [--offset N]
mochi-maker get <project> <ref>
mochi-maker validate <project> [--export] [--target-version auto|3|4|5]
mochi-maker export <project> --out <dir|file.zip> [--moc-version auto|3|4|5] [--atlas N] [--stem S] [--force]
mochi-maker history <project>
mochi-maker import-physics <project> <file.physics3.json> [--dry-run]
mochi-maker export-template <project> --out <file.mochitemplate> [--name N] [--description D] [--author A] [--no-physics] [--thumbnail file.png]
mochi-maker apply-template <project> <file.mochitemplate> [--targets ref,…] [--draw-order template|keep] [--redivide] [--no-masks] [--parameters merge|add] [--physics merge|add|none] [--dry-run]
mochi-maker conformance-pack <project…> --out <dir> [--versions 3,4,5] [--seed N] [--random N] [--no-renders] [--force]
mochi-maker replay <history.jsonl> --out <dir> [--base <project>] [--assets <project>]
mochi-maker describe [command] [--search words]
```

- `validate --export` also runs the export in memory and lists its problems.
  `export` writes a model folder, or a deterministic zip, plus
  `mochi-export.json`. It refuses a non-empty folder that is not a previous
  export unless `--force` is given. See [`export.md`](export.md).
- `--json` everywhere. Exit codes: 0 success, 1 command or validation errors,
  2 usage errors, 3 internal errors.
- Command files may contain operations as well as commands. `--preview`
  writes the operations' preview images (one `.png` path, or a directory).
- A script (`.mjs`) default-exports
  `(session, { core, assets, fs, operations, author }) => …`.
- `run` appends a segment to `.mochi-cache/history.jsonl`: a `base` entry with
  the hash of the project as loaded, then the transactions. `replay` chains
  the segments and fails with `E_REPLAY_DIVERGED` if the project was edited
  outside the history in between.
