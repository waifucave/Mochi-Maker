# Mochi Maker — Design

Status: the design as built. [`roadmap.md`](roadmap.md) says where each milestone stands.

Mochi Maker is an open-source, agent-first editor for creating and rigging
models for Live2D Cubism-compatible apps. Its output is a model folder:
`.moc3`, `.model3.json`, textures, physics, expressions, motions, pose,
display info and user data. The folder loads in Mochi2D, in Mochi Studio and in
other apps that read these formats.

This document covers scope, architecture, how Mochi Maker uses Mochi2D, and
testing. The agent interface is in [`agent-api-design.md`](agent-api-design.md)
and the milestones are in [`roadmap.md`](roadmap.md).

**Format rules.** Labels such as §1b.7 (validation), §1c.4 (blend shapes) and C26 (section
order) name groups of Mochi2D's format rules, as in Mochi2D's own docs and code comments. Section 5
states what Mochi Maker needs from Mochi2D as capabilities.

---

## 1. Principles

1. **Everything is a command.** The editor UI, the TypeScript API, the MCP
   server, the CLI and the live bridge all change the document only through
   the same typed commands. An agent can do everything a person can.
2. **The document is the source of truth, and the export is a build product.**
   The document holds the author's intent: layers, meshes, rigs, keyforms and
   animations. Exporting compiles it to runtime files, and the same document
   always gives byte-identical output.
3. **One format implementation.** The `.moc3` binary format is read, validated
   and written by Mochi2D. Mochi Maker lowers its document to Mochi2D's public
   model data and calls Mochi2D's writer. It does not write its own `.moc3`
   writer, and it does not copy or fork Mochi2D.
4. **Headless first.** The document core, the commands, import, export and
   validation run in Node without a DOM. The editor is one client of that core.
5. **Deterministic.** There is no wall-clock time, no unseeded randomness and
   no locale or platform dependence in anything that changes the document or
   the export. Replaying a command log gives the same document, byte for byte.
6. **A familiar interface, our own look.** The editor's layout, workflow, terms and
   shortcuts follow familiar conventions of model editors, so that
   users of other editors feel at home. The visual design (icons, colors,
   styling) is Mochi Maker's own (section 3.10).
7. **No machine learning without approval.** Nothing in this design uses
   machine learning. Rigging is done by people and by agents using the tools
   (section 8).

---

## 2. Scope

### 2.1 Feature list

| Area | First release | Later |
|---|---|---|
| Art import | PSD (8-bit RGB, layer groups, opacity, visibility, normal blending), OpenRaster (`.ora`), a folder of PNGs with a small manifest, single PNGs | PSD 16-bit, layer masks, clipping layers flattened on import, re-import with change mapping |
| Parts and draw order | part tree, per-mesh keyformed draw order, part sorting scopes (nested draw-order groups) | |
| Art meshes | automatic generation from alpha, manual editing, keyform-safe topology edits | mesh templates (eye, mouth), symmetric editing |
| Deformers | warp (triangle and bilinear cells) and rotation deformers, any nesting | deformer presets |
| Parameters and keyforms | parameters with key lists, objects bound to 1–4 parameters (more allowed), full keyform grids, auto-fill of missing cells | combined (2D) parameter controls |
| Blend shapes | blend-shape parameters, targets on meshes, warps, rotations, parts and glues, constraints | |
| Glue | vertex pairs with weights, keyformed intensity | |
| Clipping masks | normal and inverted | mask previews per drawable |
| Colors | per-keyform multiply and screen colors on meshes and deformers | |
| Offscreens and blend modes (`.moc3` v6) | part offscreens, the 18 color and 5 alpha blend codes (M15) | |
| Physics | pendulum settings: inputs, outputs, particles, normalization; live simulation in the preview | rig templates (hair, accessories) |
| Expressions | `Add`, `Multiply`, `Overwrite` entries, fades | |
| Motions | a timeline with linear, Bézier, stepped and inverse-stepped segments, events, fades, model curves (eye blink, lip sync, opacity) | audio track for reference, recording from live input |
| Pose | mutually exclusive part groups with links | |
| Hit areas and display names | `HitAreas` in the settings file; display names, parameter groups and combined parameters (`.cdi3.json`); user data (`.userdata3.json`) | |
| Export | model folder or zip; `.moc3` v5 (default), v4 and v3 as compatibility targets; v6 for offscreens and blend modes (M15) | |

Machine-learning features are out of scope (section 8).

### 2.2 Which `.moc3` versions to export, and why

The file format has six versions (§1b.1). What matters for Mochi Maker's exporter is
which features each version can carry.

| Version | Carries | Missing |
|---|---|---|
| 3 | parts, deformers, meshes, keyforms, glue, masks, warp cell mode (from v2) | colors, blend shapes |
| 4 | + multiply and screen colors (one color entry per keyform, indexed by position), blend shapes on mesh and warp **positions only** (§1c.4) | blend shapes on opacity, colors, draw order, rotations and parts |
| 5 | + per-keyform color indices, blend shapes on every property, part, rotation and glue blend-shape targets | offscreens, blend modes |
| 6 | + part offscreens and the full blend-mode set | |

**Decision:**

1. **Version 5 is the default and the first export target.**
   - It carries every feature in the first-release scope.
   - It is the version of every committed test model so far (DeepSeek-chan
     and 8 of the 10 locally tested models). Mochi2D's
     reader is checked bit-exact on it.
   - Version 6 is the newest version (§1b.1). Mochi Maker writes version 5 by
     default so that its models also suit apps that do not read version 6 yet.
2. **Versions 4 and 3 are compatibility targets** for older runtimes. They
   come from the same lowering. The exporter refuses, with a diagnostic that
   names each offending object, a document that uses a feature the target
   cannot carry. It never drops a feature silently. Examples: a color on a
   version-3 export, or a blend shape on opacity for version 4. Each
   diagnostic names the object, the values (and for blend shapes the
   parameter), and a fix. Version 4 is a regular target (M13).
3. **Version 6 is written for what needs it** (M15): only offscreens and
   blend modes do, and `auto` chooses it for them. Mochi2D 0.22.0 writes it,
   and its documented table of blend codes and offscreen flags is the
   authority. No native version 6 test model is at hand, so it is tested on
   the project's own models.
4. **Versions 1 and 2 are not targets.** Version 3 is a strict superset for
   exporting, and no app is known to need the older ones.
5. **Automatic choice.** `export --moc-version auto` picks the lowest version
   that carries every feature the document uses, but never lower than the
   project's minimum setting (default 5). The chosen version and the reason
   are in the export report.

Rules the writer must keep for every version (from §1b.7, C5, C6, C26).
Mochi2D's writer enforces them (section 5), and Mochi Maker's lowering avoids
producing anything that breaks them:

- sections in slot order, 64-byte aligned, file length a multiple of 64,
  little-endian, placeholders zeroed;
- band 0 empty; every keyform count equal to the product of its key counts;
  keys strictly ascending; no binding with zero keys;
- parents before children, for parts and deformers;
- every art mesh in exactly one draw-order group, and correct group totals
  (slot 83, C6) and group min/max (slots 84/85);
- multiply and screen color indices equal and consecutive within each object
  (C5), so every reading of the color slots gives the same result;
- IDs of at most 63 bytes. Mochi Maker restricts exported IDs to ASCII
  `[A-Za-z0-9_]`, because every test model uses ASCII and Mochi Maker has no
  tests of non-ASCII IDs.
- no glue blend-shape targets (count 34 is unconfirmed, §1b.3).

---

## 3. Document model

### 3.1 Identity: stable IDs and semantic names

Every object has three identities:

| Identity | Example | Rules |
|---|---|---|
| **UID** | `mesh_0042` | Assigned by the document. It never changes and is never reused. It is generated from a per-document counter, not from randomness or time, so a replayed log gives the same UIDs. The prefix gives the kind. |
| **Export ID** | `ArtMesh_EyeL_Lid`, `ParamAngleX` | The ID written into the runtime files. It is unique per kind and has at most 63 ASCII characters `[A-Za-z0-9_]`. It is editable, and renaming it is a command. Motions, expressions, physics and hit areas refer to objects by UID inside the document, and the exporter writes the export IDs, so a rename can never break a reference. |
| **Display name** | `Left eyelid` | Free Unicode text. It is exported to `.cdi3.json` for parameters and parts. |

Commands, the API and the bridge accept any of these **references**: a UID, or
a typed name reference such as `@mesh:ArtMesh_EyeL_Lid` (export ID) or
`@mesh~"Left eyelid"` (display name, an error if it is ambiguous). Results
always return UIDs.

### 3.2 Object kinds

```
Project
├─ Canvas            width, height, pixelsPerUnit, origin (pixels)
├─ Assets            source images, content-addressed (3.8)
├─ Layers            imported art: asset, crop, position, source path
├─ Parameters[]      ordered; this order is the export order
├─ ParameterGroups[] display groups (.cdi3)
├─ Parts (tree)
│   └─ children: Parts, ArtMeshes   (the visual hierarchy)
├─ Deformers (tree)  Warp | Rotation  (the geometric hierarchy)
├─ Glues[]
├─ (blend shapes)    on their targets: parameter, keys, base, deltas, constraints
├─ Physics           settings[]
├─ Expressions[]
├─ Motions[]
├─ Pose              groups[]
├─ HitAreas[]
├─ UserData[]
└─ ExportSettings    targets, texture sizes, file names
```

Parts and deformers are **two separate trees**, as in the runtime format (§1a): a mesh has a parent part (grouping, opacity, draw-order scope) and,
optionally, a parent deformer (geometry). A deformer has an owning part,
because §1c.5 makes a deformer inactive when its owning part is inactive.

### 3.3 Parameters, bindings and keyforms

**Parameter:** `uid`, export ID, display name, group, `min`, `max`,
`default`, `repeat`, `decimals` (the editor's display precision; the file always gets 3, which sets the evaluation tolerance), kind (`normal` or
`blendShape`), and a **key list**: the values where keyforms may exist, for
example −30, 0, 30. The key list is exported as the parameter's own list in
version 4 and later (§1b.6 item 6).

**Rig of an object.** Any keyformable object (part, warp, rotation, art mesh,
glue) has a *rig*: an ordered list of 0 or more **bindings**. Each binding
names a parameter and a subset of its keys (at least one). The keyforms form
the full grid over those keys, in the order of §1b.6: the first binding
varies fastest.

```ts
interface Rig {
  bindings: { parameter: Uid; keys: number[] }[];   // keys ⊆ parameter key list
  keyforms: Keyform[];                               // length = Π keys.length
}
interface KeyformMeta { authored: boolean }          // false = filled automatically
```

- **Complete grids only.** The format needs every cell (§1b.6 item 3). When
  a person adds a binding or a key, the new cells are **filled automatically**
  from neighboring authored cells by multilinear interpolation, or by copying
  where only one neighbor exists, and marked `authored: false`. They are
  highlighted in the editor until someone edits them. Validation can warn
  about unauthored cells in finished rigs.
- **Values are float32.** Every stored keyform value is rounded to float32 when
  a command writes it, because evaluation is in float32 (§1a,
  numeric model). Then what the document stores is exactly what gets exported.
- **Draw order** is a keyformed float on art meshes and parts. Evaluation
  truncates it (§1c.6, C30). The editor shows integers and stores whole
  numbers unless an agent or script sets fractions on purpose.

**Lowering.** The exporter turns bindings into the format's shared structures:
one *parameter binding* per distinct (parameter, key set) pair, and one *band*
per distinct ordered list of parameter bindings, with duplicates merged. Band 0
is always the empty band (§1b.6 item 2).

**Activity.** A binding is out of range when the parameter value lies outside
its keys by more than 0.001 (§1c.2), and that hides the object and its
dependants (§1c.5). This is a real authoring feature: binding a mesh to
`MouthOpen` with keys 0…0.3 hides it above 0.301. The editor shows it
explicitly. The rig view marks the active key range, and `explain` (agent API)
reports "inactive because binding MouthOpen ∈ [0, 0.3] is out of range".

### 3.4 Art meshes

```ts
interface ArtMesh {
  uid; exportId; displayName;
  part: Uid; deformer: Uid | null;
  source: { layer: Uid };             // the image the mesh samples
  uv: Float32Array;                   // per vertex, in the layer's pixel space
  triangles: Uint16Array;             // ≤ 65535 vertices (u16 indices, §1b.5)
  rig: Rig<{ positions: Float32Array; opacity: number; drawOrder: number;
             multiply: RGB; screen: RGB }>;
  doubleSided: boolean;
  clip: { masks: Uid[]; invert: boolean } | null;
  enabled: boolean;
  legacyBlend: 'normal' | 'additive' | 'multiplicative';   // flag bits 0/1
}
```

- **Positions** of every keyform are stored in the parent deformer's input
  space (section 3.5). The editor converts to and from canvas space through
  the deformer chain for display and dragging (section 3.6).
- **UVs** are stored in the source layer's pixel space. The exporter places the
  layer's pixels in a texture atlas and converts them to normalized UVs
  (section 4.3).
- **Mesh generation** from a layer: threshold the alpha → trace contours
  (marching squares) → expand by a margin so the edge pixels are covered →
  simplify (Douglas–Peucker, then a maximum edge length) → interior points on
  a jittered grid with a fixed seed → constrained Delaunay triangulation. These
  are generic computational-geometry algorithms, and parameters such as
  density and margin are command arguments.
- **Topology edits keep keyforms valid.** A command that adds vertices
  computes each new vertex in every keyform from its barycentric position in
  the rest mesh, so existing deformation carries over. Deleting a vertex
  removes it everywhere and remaps glue pairs. A topology edit is one command,
  so it is undone as one step.

### 3.5 Deformers and their spaces

| Kind | Rest data | Keyformed | Child space |
|---|---|---|---|
| **Warp** | rows R, columns C, cell mode (`triangles` or `bilinear`, §1b.5) | grid points ((R+1)(C+1) per keyform), opacity, multiply, screen | normalized (u, v) ∈ [0,1]², v downward (§1a) |
| **Rotation** | base angle | angle, origin, scale, mirror x/y, opacity, multiply, screen | Cartesian, in canvas pixels around the origin |

- **Warp grids** are stored in the parent's space, row-major (§1b.6 item 5).
- **Rotation scale is stored unit-free in the document.** In the format, a
  rotation whose chain has no rotation ancestor needs a scale of about 1/ppu,
  because its children are in pixel-like units (§1a, local spaces;
  1c.7). The document stores `scale = 1` for "natural size", and the exporter
  multiplies by 1/ppu exactly for rotations with no rotation ancestor. A
  rotation under another rotation inherits the factor through s_w = s·s_P.
  One rule handles both direct and warp-mediated chains, and the editor never
  shows numbers like 0.000267.
- **Mirror flags** are keyformed per cell. Mochi Maker evaluates them at the
  lower corner of the active cell (§1c.7). The rig view shows them as
  step values, not interpolated ones.
- **Reparenting and inserting deformers** convert every keyform of the moved
  children into the new parent's space. The conversion is exact at the new
  parent's rest form. At other poses the children follow the new parent, which
  is what reparenting means. Example: "wrap selection in a warp" creates a
  rectangular warp around the selection's bounds at rest. Its rest mapping is
  affine inside the grid, so the children's positions convert exactly.
- **Evaluation order.** Parents come before children. The document keeps both
  trees in an order where this holds, and export writes deformers in that
  order (§1b.7: parent index lower than own index).

### 3.6 Editing in deformed space

People and agents usually want to say "move this vertex to here on the
canvas" at the current pose. Commands therefore accept positions in one of
three spaces:

- `local`: the object's stored space;
- `canvas`: canvas pixels, y downward;
- `model`: model units.

For `canvas` and `model` input, the command maps the point back through the
deformer chain at the given pose, using the forward mapping that Mochi2D
provides (section 5, M7/M8). The inverse is a damped Newton iteration on the
forward map, starting from the point's current local position. It is generic
numerics, and the result is exact to float32. Outside a warp's grid the
mapping is affine-extended (§1c.8), so the inverse is well defined
everywhere.

The command records the **resolved local values** in the log, not the canvas
input. A replay therefore does not depend on solver details.

### 3.7 The other object kinds

- **Parts:** parent part, children, keyformed draw order, initial opacity
  (§1b.5 slot 7), enabled flag, and `sortingScope`. When a part has its
  own scope, its children sort among themselves and the part sorts as one item
  in its parent's scope (draw-order groups, §1c.13). Otherwise its
  children join the parent's scope directly. Lowering builds the draw-order
  groups, their objects in document order (ties keep file order, §1c.13),
  their min and max, and their totals.
- **Clipping masks:** a mesh lists the meshes that clip it, plus an invert
  flag. Rule §2g.1 says mask meshes count whenever they are *active*, even at
  opacity 0, so a hidden "mask-only" mesh is a normal pattern. The editor
  shows mask-only meshes with a distinct style.
- **Multiply and screen colors** are keyformed RGB values on meshes, warps and
  rotations. Combination down the chain follows §1c.7 and 1c.9 and needs
  no authoring rules beyond "values in [0, 1]". Values above 1 are allowed,
  because evaluation clamps only at the end.
- **Glue:** two meshes A and B, a list of pairs (vertex of A,
  weight of A, vertex of B, weight of B), and a keyformed intensity. "Glue
  coincident edges" pairs boundary vertices of A and B that lie within a
  tolerance at rest, with weights 0.5/0.5. Glues apply in document order, and
  order matters (§1c.10), so the order is visible and editable.
- **Blend shapes:** a blend-shape parameter (kind `blendShape`)
  drives blend shapes, never normal bindings. Each target (mesh, warp,
  rotation, part, glue) holds a list of blend shapes. A blend shape has:
  - the parameter, a subset of its keys, and a **base key**;
  - one **delta** per key: what it adds at that key, with the base key's
    delta all zero;
  - **constraints**: piecewise-linear weight curves over any parameter, even
    the blend shape's own. The weight is min(1, every constraint), or 1
    without any (§1c.4). Weights above 1 are refused,
    negative ones get a lint warning.

  The target gets w·s added to its normal result, where s interpolates the
  deltas at the parameter's value (§1c.4). The document stores deltas, as
  genuine files do. Absolute shapes are not stored.

  Version 4 carries only position and grid deltas on meshes and warps.
  Anything else needs version 5, and the export names what forces it (2.2).
  Blend shapes apply in list order, because their contributions are summed
  in float32. Mesh topology edits carry position deltas the same way they
  carry keyform positions.
- **Physics:** settings with inputs (parameter, weight %, X/Y/Angle,
  reflect), outputs (parameter, particle index, scale, weight, type,
  reflect), particles (position, mobility, delay, acceleration, radius),
  normalization ranges, and a simulation rate (§3e). The preview runs
  Mochi2D's simulation. The exporter fills `Meta` counts from the content
  (§3e.1).
- **Expressions:** entries (parameter, value, blend) and fades (§3d).
- **Motions:** duration, fps, loop flag (stored; playback decides, §3c.1),
  fades, curves per target (model, parameter, part opacity) with segments, and
  events. Curves are stored per target kind and exported in the required run
  order (model, then parameter, then part opacity), because later curves
  would otherwise be ignored (§3c.2). Counts are computed (§3c.4).
- **Pose:** groups of part entries with links (§3f).
- **Hit areas:** (mesh UID, name). The exporter writes the mesh's export ID.
- **Display info:** parameter and part display names, parameter groups
  (nested), combined parameter pairs (§3i).
- **Standard groups:** the `EyeBlink` and `LipSync` parameter groups (§3b.3) are explicit project settings.

### 3.8 The project file format

A project is a **folder** `Name.mochi/`. A single-file form,
`Name.mochi.zip`, is the same folder zipped, for sharing.

```
Name.mochi/
├─ mochi-project.json        manifest: format "mochi-maker-project", version 1,
│                            the app version that wrote it, canvas, settings,
│                            and the object index (UID → file)
├─ parameters.json           ordered parameters, groups, key lists
├─ parts.json                the part tree (structure, draw orders, flags)
├─ deformers/<uid>.json      one file per deformer, with its rig
├─ meshes/<uid>.json         one file per art mesh: topology, UVs, rig
├─ glues.json, blend-shapes.json, physics.json, pose.json,
│  hit-areas.json, user-data.json, display.json, export.json
├─ expressions/<uid>.json
├─ motions/<uid>.json
├─ layers.json               imported layers: asset, crop, position, origin path
└─ assets/
   └─ sha256-<hex>.png       source images, content-addressed and deduplicated
```

**Why this layout:**

- **Text and diffable.** Each heavy object has its own file, so changing one
  mesh changes one file. Objects are written in a fixed key order. Numeric
  arrays put one vertex (`[x, y]`) or one grid row per line, so a moved
  vertex is a one-line diff. Numbers are written as the shortest decimal that
  reads back as the same float32, so the text is stable and exact.
- **Merge-friendly.** UIDs are stable, and collections are keyed by UID.
  Ordered collections (parameters, glue order, draw-order ties) store
  explicit order lists, so a three-way merge of two people's edits usually
  succeeds. `mochi-maker validate` catches the rest.
- **Assets** are stored once, by content hash, as PNG (straight alpha,
  8-bit). PSDs are not kept. Import extracts the layers, and the origin path is
  recorded for re-import. Generated atlases are build products. They go into
  `.mochi-cache/` (gitignored), never into the project.
- **Versioned.** The manifest has a format version. Readers migrate old
  versions step by step (`1 → 2 → …`) with pure functions, each tested with
  fixture projects. A newer format than the reader knows is refused with a
  clear message. Unknown keys are kept and written back unchanged, so older
  apps don't destroy newer data within a version.
- **The history is not part of the project.** The command log (section 4.1) is
  written to `.mochi-cache/history.jsonl` for crash recovery and can be
  exported on request. A project does not need its history to open.

### 3.9 In-memory representation

- The document is a **normalized store**: maps from UID to object, plus order
  lists.
- Objects are immutable. A command produces new versions of the objects it
  touches and shares the rest (structural sharing).
- Large numeric data (positions, UVs, triangles, grids) lives in typed arrays,
  replaced whole by the commands that change them, never mutated in place.
  Undo therefore only needs references to the old arrays.
- A **revision number** increases with every committed transaction. Derived
  data is cached per revision and per object: lowered model data, atlas
  layout, bounding boxes.

### 3.10 The editor interface (summary)

The frame follows familiar conventions of model editors;
the look is our own. [`editor.md`](editor.md) describes it in full.

- **Frame:** a menu bar; a toolbar with the workspace switcher at its left
  end; the View area in the middle, with a tab per view and the draw-order
  strip along its left edge; dockable palettes around it.
- **Palettes** with familiar names and roles: Parts, Deformer, Parameter,
  Inspector, Tool Details, Project, Log, Timeline and Scene; and Mochi
  Maker's own History, Validation, Agents, Art, Preview and Draw Order.
- **Workspaces** (Modeling, Animation, and custom ones) each keep a layout,
  with a reset; selecting a view tab switches to its workspace.
- **Keys and mouse** with familiar defaults, every command rebindable, with
  import and export.
- **Still ours:** the command bar (every command by name, with typed
  arguments, the same names as the API), agent access and the agents' band,
  and the activity palettes. The rig grid stays a later idea.

---

## 4. Architecture

### 4.1 Packages

An npm-workspaces monorepo, TypeScript in strict mode, Node ≥ 20, ES modules,
Vite for the web app, Vitest for tests.

| Package | Contents | Runs in |
|---|---|---|
| `@mochi-maker/core` | document model, commands, transactions, undo/redo, log, queries, validation, project read/write (through an injected file-system interface) | Node, browser, worker |
| `@mochi-maker/geometry` | triangulation, contours, simplification, inverse mapping, atlas packing | anywhere |
| `@mochi-maker/import` | PSD, OpenRaster, PNG folder readers | anywhere |
| `@mochi-maker/export` | lowering to Mochi2D model data, the JSON writers, atlas building, packaging, export report | anywhere |
| `@mochi-maker/preview` | the bridge between a document and a Mochi2D model instance: incremental updates, posing, rendering, picking | browser; Node via headless Chromium |
| `@mochi-maker/api` | the typed agent API (agent API, section 2) | anywhere |
| `@mochi-maker/mcp` | the MCP server | Node |
| `@mochi-maker/cli` | the `mochi-maker` command | Node |
| `@mochi-maker/bridge` | the live-bridge protocol, client and endpoint | Node, browser |
| `@mochi-maker/editor` | the web app | browser; later Electron |

The dependency direction is strict: `core` depends on nothing in the
project, and only `preview`, `export` and the apps depend on Mochi2D.

### 4.2 Commands and transactions

```ts
interface CommandDef<A, R> {
  name: string;                 // 'mesh.generate', 'rig.addBinding', ...
  summary: string;              // one line, for discovery
  doc: string;                  // markdown: semantics, examples, errors
  args: TSchema;                // JSON Schema (TypeBox), so A is inferred
  result: TSchema;
  errors: ErrorCode[];          // which structured errors it can raise
  apply(doc: Draft, args: A, ctx: CommandContext): R;   // pure
}
```

- **Pure and deterministic.** `apply` reads the document and its arguments
  only. `ctx` gives UID allocation and a seeded random stream when a command
  needs randomness, such as jittered interior points, with the seed in the
  arguments.
- **Patches.** Applying a command against a draft records forward and inverse
  patches at object granularity: "object X: old version → new version". Undo
  applies the inverse patches. Patches never contain derived data.
- **Transactions.** A transaction is a labeled list of commands applied
  atomically. If any command throws, the whole transaction rolls back and the
  error names the failing command (agent API, section 2.4). A transaction is
  one undo step, so a drag gesture is one transaction that is updated while
  the pointer moves and committed on release.
- **Dry runs.** A transaction can be applied, inspected (diff, validation,
  preview) and discarded. It is the same code path as a real commit, minus the
  commit.
- **Validation tiers:**
  1. Argument schemas, checked before `apply`.
  2. Invariants that must hold after every command, for example "every
     keyform grid is complete" and "references resolve". A violation rolls the
     transaction back.
  3. Lint rules checked on request or before export, for example
     "unauthored keyforms", "mesh outside its warp", "parameter without
     bindings".
- **Log.** Each committed transaction is appended to the history as
  `{ revision, author, label, commands: [{ name, args, result }] }`, with
  arguments after resolution: references are UIDs, canvas positions have
  become local values (3.6), and the seed is filled in. Replaying the log from
  an empty project, or from a snapshot, gives an identical document. Tests
  check this (section 7).
- **Authors.** Each transaction records `person`, `agent:<name>` or
  `script:<path>`, for the history panel and the agent indicator.

### 4.3 Export pipeline

```
Document ──lint──► Lowering ──► model data (Mochi2D type) ──► Mochi2D validate (strict)
                     │                                          │
                     ├─► atlas pages (PNG) ◄── layers           ▼
                     ├─► JSON files ◄────────── Mochi2D writeMoc (version) ──► .moc3
                     └─► export report  ──► folder or zip ──► Mochi2D load check
```

1. **Lint.** Refuse on errors, report warnings. Examples: "a feature not
   allowed by the target version", "duplicate export IDs", "a mask list that
   names a mesh which is not exported".
2. **Lowering.** Pure and deterministic.
   - Parts and deformers are ordered with parents first.
   - Parameter bindings and bands are deduplicated. Keyforms are laid out per
     band order (§1b.6).
   - Blend-shape keyforms go after the normal keyforms of each kind, and
     their positions after every normal position. From
     version 5 each gets its own color entries, holding color deltas.
   - Draw-order group ranges cover every key their members can reach, by
     evaluating every blend shape at its extremes.
   - Draw-order groups come from sorting scopes.
   - Color entries are allocated equal and consecutive (C5).
   - Rotation scales are normalized (3.5). Positions are converted from canvas
     pixels to model units for root-level objects: x = (px − originX)/ppu,
     with y downward (§1a).
3. **Atlas.** Each exported mesh needs the pixels its UVs cover. Each
   layer's used region, cropped to the bounds of its meshes plus a padding of
   at least 4 px, is packed into pages of the configured size (default 4096,
   up to 8192; non-square allowed) with a deterministic MaxRects packer.
   Edges are bled outward so filtering and mipmaps don't pull in transparent
   black. UVs are normalized with v top-down (§1b.5). Pages are written as
   straight-alpha PNGs, premultiplied when drawn (§2b.1).
4. **The JSON files.** `model3.json` (file references, `Groups` with
   `EyeBlink` and `LipSync`, `HitAreas`, optional `Layout`), `physics3.json`,
   `exp3.json`, `motion3.json`, `pose3.json`, `userdata3.json` and
   `cdi3.json`. All are UTF-8 without a BOM (§4b), with keys in a fixed
   order, and every count field computed. Mochi2D's parsers then re-read each
   file as a check (section 5, M11).
5. **The `.moc3` file** comes from Mochi2D's writer, followed by a load check:
   Mochi2D loads the written bytes and evaluates the default pose without
   warnings.
6. **Export report** (`mochi-export.json`, next to the export or in the
   cache): the version chosen and why, the map from UIDs to export IDs, the
   feature use, warnings, texture sizes and memory, and the hashes of the
   output files.

The same document and settings always give byte-identical output. Tests check
this on golden projects (section 7).

**moc3 import** (roadmap M16). A `.moc3` model folder opens as a project
through Mochi2D's reader (M2) and an inverse of the lowering; the texture pages
are kept as they are. [`import.md`](import.md) describes it.

### 4.4 Live preview through Mochi2D

The preview always shows what the export will produce, because it is the
export. The document is lowered to Mochi2D model data, and Mochi2D evaluates
and renders it. No second evaluator exists in Mochi Maker.

- **Full rebuild.** Lower the document, create a Mochi2D model instance from
  the model data directly, without writing bytes (M5), and upload the
  textures. Rebuilds run in a worker when the change is structural: new
  object, new binding, topology change.
- **Fast path.** Most interactive edits change values, not structure: moving
  vertices, editing a keyform's opacity, angle or color, moving warp points.
  The preview maps the edited keyform to its position in the lowered arrays
  (the lowering keeps an index from (object, cell) to array ranges) and patches
  the model instance in place (M6). Textures and buffers are reused.
- **Pose state.** Parameter values, part opacities and animation time belong to
  the view, not the document. Several views can show different poses. The
  "edit pose" is the keyform cell being edited, and editing a non-key pose
  is refused with a hint: "move to a key, or add a key here".
- **Animation preview.** Motions, expressions, physics, pose, eye blink and
  breath come from Mochi2D's animation layer, driven by the timeline clock.
  Scrubbing evaluates the motion at time t directly. Physics while scrubbing
  restores the nearest cached state snapshot and steps forward from it (M11).
- **Overlays** (wireframes, warp grids, rotation handles, mask outlines,
  selection) are drawn by Mochi Maker on top of Mochi2D's render, using the
  evaluated deformer forms and drawable vertices that Mochi2D reports (M7).
  **Picking** uses Mochi2D's hit test at a point, topmost drawable first (M9),
  with a mesh-level refinement in Mochi Maker for vertices and edges.
- **Headless previews** for agents and the CLI render through Mochi2D's
  reference renderer in the pre-installed headless Chromium, through
  Playwright, with one browser kept alive per process (M10). The overlays are
  then drawn into the same page.

### 4.5 Performance

**Design target:** a model of DeepSeek-chan's size (§1b.8, 0002): about
720 drawables, 509 parameters, 147 parts, about 8,900 warp keyforms, warps up
to 61×61 points, glue with about 2,500 pairs, and textures up to 8192 px.

| Operation | Target |
|---|---|
| Pose change (slider) | 60 fps; evaluation is Mochi2D's (it reports ≤ 4 ms, §0006) |
| Vertex or grid drag (fast path) | ≤ 16 ms from pointer event to frame |
| Structural edit → preview updated | ≤ 250 ms (lowering plus model creation, in a worker) |
| Undo/redo of a typical command | ≤ 16 ms, plus a rebuild if structural |
| Open a project | ≤ 2 s plus texture decode |
| Export (moc3 plus atlas) | ≤ 10 s, dominated by PNG encoding; atlas pages encode in parallel workers |
| Project size | about 2–3× the `.moc3` size in text, plus assets |

**How:**

- Typed arrays everywhere for geometry, and structural sharing for undo.
- Lowering is cached per object and per revision, and only changed objects are
  re-lowered. The shared pools (positions, keys) are rebuilt by concatenation.
- Expensive derived data (atlas, triangulations) is cached by input hash.
- Texture decoding happens off the main thread. Previews downscale large
  textures with a visible notice, as Mochi2D's viewer does (§0002). The
  export always uses full resolution.
- A benchmark project, synthetic and generated by a script at
  DeepSeek-chan's size, is committed as a generator, not as data. CI tracks
  the operations in the table above.

---

## 5. What Mochi Maker needs from Mochi2D

Mochi2D already reads, validates and writes `.moc3` in its own code and
tests. These are the capabilities Mochi Maker needs as **public, documented,
semver-stable API**. Names are illustrative. Mochi2D's team chooses the real
ones. Priority: **P1** blocks the first export milestone (roadmap M2), **P2**
blocks the editor preview, **P3** is wanted later.

| # | Capability | Pri. | Why |
|---|---|---|---|
| **M1** | **A public model-data type** (`MocData`): a plain, index-based TypeScript representation of everything in a `.moc3` file across versions 1–6. It covers canvas info, parts, deformers, warps, rotations, art meshes, parameters (including key lists and types), all keyform arrays, the position, key, UV, index and mask pools, bindings and bands, draw-order groups and objects, glues, colors, blend-shape bindings, targets and constraints, and offscreens. Field docs name the format rules (§ labels). Offsets and slot numbers are internal; the type uses element indices and counts. | P1 | It is the contract between the exporter and the writer. |
| **M2** | **`readMoc(bytes)`** → `{ data: MocData, version, diagnostics }`, without building an evaluator. | P1 | Round-trip tests; moc3 import if approved. |
| **M3** | **`writeMoc(data, { version })`** → `Uint8Array`. Sections in slot order (C26), 64-byte aligned, length a multiple of 64, little-endian, zeroed placeholders, offset and count tables sized per version, the version-4 color indexing and the version-5+ per-keyform indices (equal and consecutive, C5). Refuses data the version cannot carry, with diagnostics, never silently. Byte-identical output for equal input. | P1 | The single writer implementation. |
| **M4** | **`validateMoc(data or bytes, { level })`** → structured diagnostics `{ code, severity, kind, index, field, message }`. Levels: `official` (Mochi2D's base rejections, §1b.7 and C26) and `strict` (Mochi2D's extra rejections, plus group totals C6, plus warnings such as out-of-range draw orders). | P1 | Export refuses invalid output, and errors point at objects. |
| **M5** | **Create a model instance from `MocData`** without serializing, guaranteed equivalent to loading `writeMoc(data)`. | P2 | Fast preview rebuilds. |
| **M6** | **In-place value patches** on a model instance when the structure is unchanged: replace ranges of keyform positions, opacities, draw orders, colors, rotation values, glue intensities and weights, and blend-shape keyforms. The next evaluation sees the new values, and change tracking marks them as changed. | P2 | 60 fps vertex dragging without rebuilds. |
| **M7** | **Evaluation introspection** after `evaluate()`: per deformer, its world form (warp: mapped grid points and σ; rotation: origin, angle, scale, mirror flags), accumulated opacity and colors, and activity with a reason (disabled, binding *k* out of range, inactive ancestor); per object, the located (i, t) of each binding; part draw orders; per drawable, its opacity factors. | P2 | Overlays, `explain`, and the inverse mapping. |
| **M8** | **Forward point mapping:** map points from a deformer's input space to model space at the current evaluation (the 1c.7/1c.8 mapping, outside regions included), optionally with the 2×2 Jacobian. | P2 | Editing in canvas space (3.6). |
| **M9** | **Rendering hooks:** render into a caller-provided WebGL2 context and canvas with a view transform (pan, zoom), leaving GL state documented or restored so the editor can draw overlays after it; a per-drawable highlight tint; a hit test at a point that returns drawables topmost first. | P2 | Editor viewport. |
| **M10** | **Headless rendering from Node:** render a model instance or model folder at a pose to PNG bytes with the reference renderer (headless Chromium, as `npm run render` does), as a library call that keeps the browser alive between calls. Also a faster non-reference mode with downscaled textures. | P2 | Previews for agents and the CLI. |
| **M11** | **Animation formats and players:** parsers that return structured diagnostics for `model3`, `motion3`, `exp3`, `physics3`, `pose3`, `userdata3` and `cdi3`; evaluating a motion's curves at a given time without the playback queue; physics with explicit stepping, plus snapshot and restore of its state, plus the settle procedure (§3n.8). | P2 | Timeline scrubbing, physics preview, export checks. |
| **M12** | **Loading a model package from an in-memory file map** (path → bytes), including non-ASCII paths. | P2 | Previewing an export without touching disk. |
| **M13** | **Result generation as a library call:** produce the `mochi2d-result/0` structure (§1d, result contract) for a model and a static or animation scenario. | P1 | Round-trip tests and the conformance pack (7.4). |
| **M14** | **Packaging:** an ES module build with type declarations, the core importable in Node without DOM or WebGL, and semver with a changelog. Mochi Maker pins an exact version in `package.json`. | P1 | |
| **M15** | **Writer test vectors.** Mochi2D's own tests pin `writeMoc` output for small synthetic models (hashes), so a Mochi2D release that changes bytes is visible. | P3 | Stable goldens across Mochi2D upgrades. |
| **M16** | **Version 6 writing** (offscreens, blend modes, the count-37 group written empty) once what writing needs is confirmed. | P3 | Roadmap M15. |

Mochi Maker does **not** ask Mochi2D to write the JSON formats. They are
simple, and Mochi Maker writes them itself and checks them with Mochi2D's
parsers (M11). If Mochi2D's team prefers to own those writers too, Mochi Maker
will use them.

---

## 6. Import

- **PSD.** Through a generic MIT-licensed PSD reader (for example `ag-psd`),
  or our own reader if that proves too limited. Layer pixels are composited
  only within a layer: no cross-layer blending is baked in. Layer groups
  become parts, layers become layers, and hidden layers are imported but
  marked hidden. Blend modes other than normal produce a warning, and the
  layer is imported as normal.
- **OpenRaster** (`.ora`): a zip with `stack.xml` and PNG layers. An open
  format that works well in place of PSD.
- **PNG folder:** PNGs plus an optional `layers.json` (name, position, order,
  group). Without it, files are ordered by name and placed at (0, 0).
- **Re-import:** match layers by path and name, and replace pixels. If a
  layer's bounds change, existing meshes keep their positions, UVs are
  remapped, and the import reports which meshes may need re-fitting.

---

## 7. Testing

### 7.1 Core

- **Unit tests per command:** the result, the error cases, and three laws
  checked automatically for every command in the registry:
  - apply then undo gives a document equal to the original;
  - undo then redo gives the post-command document;
  - replaying the log from the start gives an identical document.
- **Property-based tests** (fast-check): random command sequences from a
  generator that knows every command's schema. After each step the invariants
  hold, and the three laws hold for the whole sequence.
- **Project format:** write → read → write is byte-identical. Every migration
  has fixture projects.

### 7.2 Golden projects

Small synthetic projects are committed under `test/golden/`. Their art is
generated by scripts: flat shapes, gradients and text. No model data is
committed. Each golden project tests one feature: one mesh with two keys; a
warp in a rotation in a warp; blend shapes with constraints; glue; masks,
normal and inverted; sorting scopes; colors; physics; motions with every
segment type. Each has:

- **Expected export hashes** for every output file, per target version.
  Mochi2D upgrades that change bytes are reviewed explicitly (M15).
- **Expected evaluation vectors:** poses with values computed independently
  by hand or from the format's formulas. Example: a mesh keyed at 0 and 1,
  evaluated at 0.25, gives the vertex lerp. These are compared with Mochi2D's
  evaluation of the export, within the tolerances of §4l.
- **Expected renders:** PNGs from Mochi2D's reference renderer, compared with
  the image metrics of §4h. These are our own synthetic images, so
  committing them is allowed.

### 7.3 Round trips

1. **Export → load → evaluate.** For every golden project and for generated
   random documents: export, load with Mochi2D, evaluate N seeded random poses,
   and compare with the lowering's expectations: active flags, draw orders and
   render orders exactly; vertices within tolerance.
2. **Export → load → render → compare** with the golden PNGs.
3. **moc3 → document → moc3** ([`import.md`](import.md)). Every golden
   project exported at versions 3–5 is imported and exported again, and
   Mochi2D's evaluation of both files is **bit-identical** over a few hundred
   seeded random poses; the re-exported files are byte-identical, so the
   renders are too. Where an announced test model is available locally, the
   same check runs on it, and nothing derived from it is committed.

### 7.4 Fuzzing the export

- **Valid-document fuzzing.** Random documents from the command generator,
  exported for every target version. Requirements: Mochi2D's `strict`
  validation passes; the file loads; evaluation of random poses gives no NaN
  and no exception; the export is deterministic, so exporting twice gives the
  same bytes.
- **Invalid-document fuzzing.** Mutate lowered model data (bad indices,
  unsorted keys, wrong counts) and require the writer or validator to refuse
  it with a diagnostic. This tests M3/M4 from our side.
- **Edge sizes:** zero meshes, one vertex, 65,535 vertices, 63-byte IDs, warps
  of 1×1 and 64×64 cells, bindings with 1 key and with 32 keys, deep nesting.

### 7.5 The conformance pack

The conformance pack holds Mochi Maker's exports with scenarios and Mochi2D's
results and renders for them, so that results from any implementation in the
same formats can be compared with them:

- `mochi-maker conformance-pack <project…> --out <dir>` writes, per project
  and target version:
  - the exported model folder;
  - scenario files in Mochi2D's existing formats (`mochi2d-scenario/0`
    static and render scenarios, and `mochi2d-anim-scenario/0` for motions
    and physics), with poses that exercise every binding and key: each key
    exactly, midpoints, out-of-range values, and random poses with a fixed
    seed;
  - Mochi2D's result files and renders for those scenarios (M13, M10);
  - a manifest listing each file and its hash.
- Reference results in the same formats are compared with the pack's by
  Mochi2D's judge, with the tolerances of §4l. Mochi Maker itself runs and
  contacts no other software.
- Golden projects are designed to cover every writer path: every version,
  every object kind, empty and maximal sections. So a pass on the pack covers
  the writer, not just a sample.

---

## 8. Constraints: machine learning

This design uses no machine learning. Rigging is manual or done by agents through the commands;
that is the intended approach, and the agent API is built for it. No feature learns from existing
models.

---

## 9. Open points

- version 6: tested on the project's own models only; a version 6 file from other software would
  be the next test (roadmap M15);
- glue and blend-shape authoring, built and tested but not available in this build (feature
  flags `glue` and `blendShapes`).
