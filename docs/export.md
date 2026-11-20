# Export (M2, M7, M8, M9, M10, M13)

```sh
mochi-maker validate Hana.mochi --export          # would it export? (no files written)
mochi-maker export Hana.mochi --out out/hana      # a model folder
mochi-maker export Hana.mochi --out hana.zip      # the same, zipped (deterministic)
mochi-maker export Hana.mochi --out out/hana --moc-version 4 --atlas 2048 --stem hana
```

```ts
import { exportModel } from '@mochi-maker/export';
const { files, report } = await exportModel(session.doc, assets, { mocVersion: 'auto' });
```

## What gets written

| File | Content |
|---|---|
| `<stem>.moc3` | the model, written by Mochi2D's `writeMoc` |
| `<stem>.<atlasSize>/texture_NN.png` | texture atlas pages |
| `<stem>.model3.json` | settings: file references, the `EyeBlink` and `LipSync` groups, hit areas |
| `<stem>.cdi3.json` | display names, parameter groups, combined parameters |
| `<stem>.physics3.json`, `<stem>.pose3.json`, `<stem>.userdata3.json` | when the document has physics, pose groups or user data |
| `expressions/<name>.exp3.json`, `motions/<name>.motion3.json` | one per expression and motion (names made file-safe, collisions numbered) |
| `mochi-export.json` | the export report (not read by apps) |

The same document, assets and options always give byte-identical files.
Golden tests pin the hashes.

## The steps

1. **Lint.** Lint errors stop the export. Examples: a mesh without triangles
   or an image layer, or a model without meshes.
2. **Version.** `auto` picks the lowest version that carries what the
   document uses, but never below the project's minimum (default 5).
   - Colors need version 4.
   - Blend shapes on meshes and warps that move only
     positions or grid points need version 4.
   - Blend shapes on rotations, parts or glues, or that change opacity, draw
     order or colors, need version 5. Version 4 ignores those values (§1c.4).
   - An explicit version that cannot carry the model is refused, with every
     object that needs more (M13). Each problem names the feature (for blend
     shapes, the parameter and the values) and carries a `fix`: export at a
     higher version, or the command that removes what needs it.
3. **Atlas.**
   - Each layer used by a mesh contributes one region: the union of its
     meshes' UV bounds plus 4 pixels of padding.
   - Regions are packed (skyline, tallest first) into pages of the atlas
     size. Each page is then trimmed to the smallest power of two that holds
     it.
   - Edge colors are bled into transparent pixels.
   - A region larger than a page is refused, with a fix that suggests a
     larger atlas size.
4. **Lowering** to Mochi2D's `MocData`:
   - **Object order:** parts and meshes depth-first through the part tree, in
     children order (so draw-order ties keep the document's back-to-front
     order); deformers in the project's deformer order; parameters and glues
     in project order.
   - **Spaces:** top-level positions, warp grids and rotation origins go from
     canvas pixels to model units, `(p − origin)/ppu`. Anything inside a
     deformer is stored in that deformer's space unchanged. A rotation with no
     rotation above it gets its scale multiplied by 1/ppu, because its
     children are stored in pixels (design 3.5).
   - **Bindings:** one parameter binding per distinct (parameter, keys) pair,
     owned contiguously, parameter by parameter. One band per distinct list of
     bindings; band 0 is the empty band.
   - **Draw-order groups** come from sorting scopes. A part with its own scope
     is an object in its parent's group, with a nested group. A part that
     inherits contributes its children directly. Group minimum and maximum are
     exactly the range of keys the members can reach. A member's key is
     n = trunc(f32(D + 0.001)), and for a blend-shape
     target max(0, trunc(f32(f32(n + B) + 0.001))). The lowest key takes the
     lowest normal draw order with every blend shape at its most negative
     contribution; the highest takes the opposite. A
     group without members gets the pair genuine files use: minimum
     2147483647, maximum −2147483647. Totals count
     drawables, recursively.
   - **Keyform order:** each object's keyforms are contiguous, in object
     order, so the position-run test of `validateMoc`'s `official` level passes. Blend-shape keyforms come after all normal keyforms of their
     kind, and their positions after all normal positions.
   - **Blend shapes:**
     - one blend-shape parameter binding per distinct (parameter, keys,
       base), owned by the parameter;
     - one keyform binding per blend shape, with its constraints;
     - one target record per object that has blend shapes.

     Keyforms hold the deltas, with the base keyform all zero. Top-level position, grid and origin offsets are divided by ppu, and
     rotation scale offsets get the same 1/ppu factor as the scale. From
     version 5 each blend-shape keyform has its own color entries, holding
     color deltas.
   - **Display fields:** deformer and art-mesh display flags 1; decimal
     places always 3. Decimal places set the key-snapping and range tolerance
     10^−d, so the document's `decimals` stays the editor's display precision
     and is not written.
   - **Colors (version 4 and later):** one color entry per keyform. From
     version 5, each keyform's multiply and screen indices equal
     `firstColor + position`, as genuine files store them (C5).
   - **Glue:** each pair is stored as (vertex of A, weight of A), then
     (vertex of B, weight of B).
5. **Writer rules** (`packages/export/src/rules.ts`), checked on the lowered data. Each
   violation stops the export, names the document object and says what to
   change (`fix`):

   | Code | Rule |
   |---|---|
   | `id-length`, `id-utf8`, `id-empty` | export IDs are valid UTF-8 (no lone surrogates, no NUL) of 1–63 bytes; the fix suggests a shortened ID |
   | `flag-value`, `display-flag` | every flag field is 0 or 1; display flags are 1 |
   | `decimals` | decimal places are 3 |
   | `triangle-index`, `triangle-count` | indices below the vertex count; index count a multiple of 3 |
   | `keys-order` | every key list strictly increasing in float32 |
   | `parameter-range` | min ≤ max |
   | `group-range` | the exact reachable range, or the empty-group pair |
   | `color-index` | version 5: keyform color indices `firstColor + k` |
   | `position-run` | for object index i, start(keyform i) + length(object i) inside the position array (the form the `official` level tests); `padPositionRuns` appends zero floats when needed, which this layout never needs |

   The `official` level does not test most of these, so the writer must. The
   document's own rules already keep most of them; the check also covers
   hand-edited project files.
6. **Validation:** `validateMoc` at the `official` level, then `strict`. Any
   error stops the export and is reported against the document object it is
   about.
7. **Writing:** `writeMoc`, then the JSON files.
8. **Load check:**
   - `validateMoc` on the written bytes;
   - `loadMoc`;
   - Mochi2D's parser for every JSON file;
   - an evaluation of the default pose (`scenarioResult`), which must have no
     error and only finite vertices.

   Runtime warnings go into the report.
9. **Report:**
   - the version and why it was chosen;
   - every file with its size and SHA-256;
   - the map from document UIDs to export IDs;
   - counts;
   - the atlas layout;
   - the load-check summary;
   - all problems (lint warnings, validator warnings, runtime warnings).

## Preview builds

`PreviewBuilder` (`src/preview.ts`) is the editor's live preview (design 4.4). It produces the
same runtime files as the export through the same lowering, writer and file plan
(`addRuntimeFiles`), so the preview shows what the export will produce. It skips the export's
lint, validation and load check, and it keeps two caches:

- decoded layer images, by asset hash;
- the atlas and its PNG pages, by the layout's inputs: layers, UV bounds and page size;
- the previous lowering (`LoweringCache`, `src/lowercache.ts`).

**The lowering cache.** Documents are immutable and share their unchanged objects, so the objects
changed since the last lowering are those whose identity differs. When each of them is a part,
ArtMesh, deformer or glue with the same structure (parents, bindings, keyform counts, topology, IDs,
and no blend shapes), the cache copies the previous model data and rewrites only their keyform
values (positions, opacities, draw orders, colors, angles, origins, scales, intensities, glue
weights), their texture coordinates and the draw-order group ranges. Objects that never reach the
model data (layers, motions, expressions, physics, sounds, parameter groups) are ignored. Anything
else (the project, parameters, a new atlas, another version, a removed object) lowers in full. The
cache keeps its own copy of the data, so callers may patch what they get. `PreviewBuild.lowering`
says which path ran. On the synthetic project a value edit lowers in 4–12 ms instead of 80–250 ms.
`test/lowercache.test.ts` makes a value edit of every kind to every object of every golden, at
versions 5, 4 and 3, and checks the result against `lowerDocument` byte for byte.

An edit that moves vertices or changes keyforms therefore reuses the atlas. Its file version is the
export's choice, raised to what the document needs (`previewVersion`).

**Value patches** (`src/patches.ts`, Mochi2D 0.6.0). `dataPatches(shown, next)` compares the model
data of two lowerings. When everything outside Mochi2D's patchable arrays (`PATCHABLE_FIELDS`:
keyform positions, opacities, draw orders, colors, rotation values, glue intensities and weights)
is equal, it returns the patches that turn one into the other, with nearby changed elements merged
into one patch; otherwise null, and the editor replaces the model data instead.
`applyDataPatches` keeps a copy of the data in step. `test/patches.test.ts` checks that value
edits patch to exactly what a rebuild evaluates, and that structural edits (and draw orders that
move a group's range) return null.

`test/preview.test.ts` checks that every golden's preview `.moc3`, settings and textures equal the
export's bytes, and that the atlas is reused or rebuilt as it should be. With
`MOCHI_MAKER_BENCH=1`, it times the builds on the goldens and on the synthetic project at the
design target's size (`test/synthetic.ts`).

## Deformers: mapping and reparenting

`src/mapping.ts` and `src/reparent.ts` (M4; design 3.5 and 3.6).

**The mapping.** `DeformerMapper(doc, pose?)` lowers the document (no textures needed), builds a
Mochi2D `ModelInstance` from the data and evaluates it at the pose (every parameter not named at
its default). `toCanvas(deformer, local)` maps local points (a warp's (u, v), a rotation's pixels)
to canvas pixels through the deformer's world form, with Mochi2D's `mapPoints`, exactly as the
evaluator maps child vertices. `jacobians` gives ∂canvas/∂local from `mapJacobians`.
`toLocal(deformer, canvas, guess?)` is the inverse: `invertMap`, a damped Newton iteration on the
forward map from an affine guess, which shortens a step that does not bring a point closer and
falls back to a gradient step where the Jacobian is singular. It stops at 10⁻⁴ px.

**The operations** (in `DEFORMER_OPERATIONS`, and in `OPERATIONS` with the art operations) record
ordinary commands with local values, so the log replays without Mochi2D:

| Operation | Records | What it does |
|---|---|---|
| `mesh.reparent` | `mesh.setDeformer` with `converted` | every keyform's positions through the old deformer at rest to the canvas, then into the new one by the inverse; blend-shape deltas converted at the rest keyform. The mesh stays in place at the rest pose. |
| `deformer.reparent` | `deformer.setParent` with `converted` | a warp's grid points as above. A rotation's origin as a point; its angle and scale so that its world frame (origin, direction, size) is unchanged, measured through the evaluator: every keyform's values are patched into the model before and after, the frames compared, and the angle and scale corrected until they match. Refuses cycles. |
| `keyform.moveInCanvas` | `keyform.set` | moves mesh vertices, warp grid points or a rotation's origin by a canvas offset or to canvas positions, at the cell's pose |
| `deformer.remove` | `mesh.setDeformer` and `deformer.setParent` with `converted` for each direct child, then `deformer.delete` | deletes a deformer and moves its children to its parent in place, converted as above; `deformer.delete { cascade }` keeps their stored values instead, so they jump |

Each conversion reports `maxShift`: the largest distance any mesh vertex moved at the rest pose,
measured by evaluating the document before and after, among the meshes drawn in both (a mesh moved
under a disabled deformer is hidden, not moved, and converts as usual). It is float32 round-off (about 10⁻⁵ px) when
everything stays in place. A warp moved into a parent that bends (another warp) stays exactly in
place at its grid points; its cells interpolate in the new parent's space, so points between them
can move a little, and `maxShift` says how much. A point that has no place in the new parent's
space (it folds or collapses there) fails with `E_RANGE`.

**Rotation scale** stays unit-free in the document: 1 is natural size wherever the rotation sits.
The lowering multiplies it by 1/ppu for a rotation with no rotation above it, because its children
are stored in pixels and its parent's space is not. `deformer.reparent` measures world frames
through the lowering, so moving a rotation into or out of a rotation chain keeps its size: a
rotation at scale 2 at the root, moved into a rotation at 0.8 inside a warp, gets 2 / (0.8 × the
warp's size there).

`test/reparent.test.ts` covers the inverse, meshes through every kind of parent and back (in place
at rest, at another keyform and with a blend shape on), rotations into a bent warp and through a
rotation, warps into a rotation and into a bent warp, cycles, and canvas edits deep in the chain.

**What Mochi2D's introspection (M7, 0.7.0) would add.** Reparenting and canvas editing need none of it: the mapping
covers conversion and editing. With it, the editor could show each deformer's evaluated world form
(grid, origin, angle) at the pose directly instead of mapping lattice points, explain why a point
lands where it does (which keyforms and blend shapes contributed), and `maxShift` could name the
vertices that moved and by which deformer.

## Golden projects

`packages/export/test/golden/` holds fifteen committed projects, built from
commands and procedurally drawn art, with the expected hashes of their exports:

| Project | What it tests |
|---|---|
| `golden-1-keyforms` | one mesh, one parameter with two keys: positions and opacity interpolate |
| `golden-2-deformers` | a rotation inside a warp, a mesh inside the rotation: space conversion, the 1/ppu scale, warp keyforms |
| `golden-3-drawing` | sorting scopes and keyformed part draw order, normal and inverted masks, colors through a warp, glue, a binding whose range ends early (the mesh hides) |
| `golden-4-masks-colors` | two masks on one mesh, normal and inverted; a mask inside a moving warp; colors down warp → rotation → mesh (§1 example d, with an unclamped 1.5); keyformed colors |
| `golden-5-glue` | weights 0.25/0.75 with keyformed intensity; a vertex in two glues, applied in order; a glue with two pairs |
| `golden-6-metadata` | parameter groups and display names, combined parameters, hit areas, user data on a mesh, a part and a parameter, the EyeBlink and LipSync groups |
| `golden-7-blend-positions` | blend shapes on mesh positions (negative and positive keys, a constraint) and warp grids, two on one mesh; exported and evaluated at versions 4 and 5 |
| `golden-9-draw-order-edges` | draw orders within 0.001 below an integer, with and without blend shapes, negative ones, and a part |
| `golden-10-glue-blend-shapes` | blend shapes on glue intensity, up, down and past 1, where a target glue is clamped |
| `golden-11-animation` | expressions (Add, Multiply, Overwrite, fades), a pose group with a link, and a physics setting (M9) |
| `golden-12-motions` | motions: linear, stepped, inverse-stepped and Bézier curves (solved and restricted), a per-curve fade, the model opacity, events, a looping Idle motion, and part-opacity curves that switch a pose (M10) |
| `golden-8-blend-values` | blend shapes on opacity, colors and draw order with two constraints (minimum), a rotation (angle, origin, scale), a part's draw order and a warp's opacity and color; the root group reaches 480…520; version 4 refuses it, naming each object |
| `golden-13-sound` | a motion with a sound: a one-second square wave that drives lip sync (the LipSync group) while the motion plays |
| `golden-14-reimport` | a PSD imported, edited and re-imported (`art.reimport`): recolored, moved, grown, removed and added layers |
| `golden-15-nested-deformers` | a warp in a rotation in a warp, a rotation in that (four levels); `mesh.reparent` of a bound mesh into the inner warp, `deformer.reparent` of a scaled root rotation under the head rotation (angle −10°, scale 1.25 in its new frame), and a `keyform.moveInCanvas` edit; checked by hand at rest and with the head turned |
| `golden-16-writer-edges` | the writer paths no other golden exports at version 3 (for the conformance pack): a nested part with its own sorting scope, a mesh bound to two parameters (six cells), a repeating parameter, a rotation bound to two parameters with mirror flags, a normal and an inverted mask, additive and multiplicative blending, and a single-sided mesh; set to version 3 |

The round-trip tests export each project, evaluate it in Mochi2D at several
poses, and compare vertices, opacity, render order, visibility and colors with
values computed by hand from the format's meaning. Every golden export also
keeps every writer rule and passes `validateMoc` at the `official` level.

Golden 6 is loaded the way an app loads it, with Mochi2D's `ModelRuntime`: the
display names and groups, the parts, hit testing (`hitAreasAt`), automatic eye
blinking (the EyeBlink parameters close the eye) and lip sync from a WAV (the
mouth opens by the sound's level).

Golden 4 is also rendered with `mochi2d render` and sampled at 12 pixels,
compared with the fragment formula of §2c. That test needs headless
Chromium through Playwright. It is skipped where Chromium is missing, except in
CI's `render` job, which installs Playwright's Chromium and requires the test.

Run with `UPDATE_GOLDEN=1` to rewrite the committed projects and hashes after a
deliberate change.

## Animation files (M9)

Expressions (`expressions/*.exp3.json`), the pose (`<stem>.pose3.json`) and physics
(`<stem>.physics3.json`) are written from the document and referenced from the model settings.
`animation.test.ts` runs golden 11 through Mochi2D's animation scenarios
(`runAnimationScenarioReport`) and compares the results with values computed from the rules of §3:

- expressions follow 3m: S = E(t / fade-in), the value (O + A)·M written with weight S, a newer
  instant expression replacing the older at once, and no cross-fade for Overwrite;
- the pose follows 3o: the visible entry fades in by Δ/F per frame, the others are capped by the
  0.15 rule, and links copy their entry;
- physics is checked by behavior: the output swings away from rest and settles, runs are
  deterministic, the input is never written, and the output is reported as physics-driven.

Physics settings that cannot work block the export through lint errors:
`physics-incomplete` (no inputs, no outputs, or fewer than two particles) and
`physics-normalization` (minimum not below maximum, or the default outside them). Two warnings
catch common pitfalls: `physics-output-overlap` (settings that write one parameter with
weights adding up to more than 100 %) and `physics-output-unbound` (an output that moves nothing
yet). The exported physics file is parsed back with Mochi2D's `parsePhysics` as before.

## Motions (M10)

Each motion is written to `motions/<name>.motion3.json`, with its curves in the order playback
requires (Model, then Parameter, then PartOpacity, §3c.2) and `Meta` counts computed from the
segments. The model settings list them under `Motions`, by group, in the project's motion order
(`motion.reorder`), which decides group indexes and idle picks.

`motion.test.ts` runs golden 12 in Mochi2D's animation scenarios and compares every frame with
values computed from the rules of §3:

- curves (3k): linear, stepped, inverse stepped, and Bézier in solved mode (root of the time
  polynomial) and restricted mode (s = τ/(t₃ − t₀));
- playback (3l.3): the local clock starting at the first processing, a per-curve fade-in closing
  E(t) of the remaining distance each frame, events between the previous and current local time,
  values persisting after the end;
- the model opacity (3u), looping with the end interval and the strict wrap test (3l.5), idle
  playback (3l.7);
- a pose switched by part-opacity curves (3l.3 step g and 3o), as genuine models do.

### Auto smooth

The motion file has no Auto smooth segment, so an Auto smooth segment is stored, and exported, as
the Bézier segment (code 1) it is, with handles Mochi Maker chooses:

1. Each key gets a slope. An end key, and a key that is a peak or a valley (its value not strictly
   between its neighbours' values), gets 0: the curve eases out of and into it. Any other key gets
   the slope from its previous to its next key, (v₊ − v₋)/(t₊ − t₋).
2. Each segment limits its two slopes as monotone cubic interpolation does (Fritsch–Carlson): a
   slope against the segment's direction becomes 0, and when the two slopes, as multiples of the
   segment's own slope, lie outside the circle of radius 3, both are scaled back onto it. The curve
   therefore never overshoots its keys.
3. The handles sit a third of the way along the segment in time, on those slopes:
   (t₀ + h/3, v₀ + m₀h/3) and (t₁ − h/3, v₁ − m₁h/3).

The counts follow: an Auto smooth segment counts as one segment and three points, like any Bézier.
`motion.test.ts` exports a curve with two Auto smooth segments, checks the segments and the
`Meta` counts, parses the file with `parseMotion`, and plays it in Mochi2D's animation scenario,
frame by frame against `sampleSegments`. Handles of hand-made Bézier segments are kept inside their
segment in time, so a curve never goes back.

## Image sequences and videos

The editor exports a motion as PNG frames, WebM or MP4 ([`editor.md`](editor.md), "Exporting
images and video"). MP4 export uses the person's browser or system encoder (H.264 through WebCodecs), and
Mochi Maker ships none; the MP4 container is written with mp4-muxer (MIT). WebM uses the same
encoders for VP9 or VP8, with Mochi Maker's own WebM writer. Where no encoder is available, the
format is refused with a message and PNG frames still work.

## Guide images

Parts marked as guide images (`guide`) are visual references: `exportModel` leaves them
out, with everything in them (`withoutGuideImages`: each top guide part deleted with `part.delete`
and cascade on a draft, so masks, glues and other references to their meshes go too), unless
`exportSettings.includeGuideImages` is on. The editor's preview always shows them.

## Motion sync

With motion-sync settings, the export writes `<stem>.motionsync3.json` with Mochi2D's
`writeMotionSync` and names it in the model settings (`FileReferences.MotionSync`): each setting
with a positional ID (`MotionSync1`, …) and its dictionary name, its driven parameters by export
ID (with their name and range, damper and smoothing), its elements (range 0–1, scale, enabled),
their shapes, blend ratio, smoothing and sample rate. The load check reads it back with
`parseMotionSync` (lint on): no warning, the same settings in the same order, every one usable.
Golden 17 has two settings and is in the conformance pack (coverage «file: motion sync»);
`motionsync.test.ts` reads it back and has Mochi2D's analysis of a synthesized «a» open the mouth. Each
parameter's smoothing is written as the file's `Smooth`; Mochi2D applies it only with its
`fileSmoothing` option (off by default since 0.20.0), and the test checks both: a `Smooth` of 100
holds the mouth shut with the option and not without it.

**A motion's setting**: a motion with a sound and a motion-sync setting gets
`"MotionSync": "<setting name>"` beside `"Sound"` in its model-settings entry, and Mochi2D then
moves the mouth by that setting's analysis of the sound while the motion plays. Without a sound,
the setting is left out (lint `motion-sync-without-sound`). The load check re-reads the model
settings and the motion-sync file with Mochi2D and checks that each motion's `MotionSync` names a
setting of the file and comes with a sound. `motionsync.test.ts` plays such a motion with
`startMotion` and checks that the sound opens the mouth through the named setting; that is Mochi
Maker's own test, not a pack scenario, since Mochi2D's analysis is its own.

In templates (`modelTemplate.apply`, option `motionSync`): settings whose driven parameters came
along are merged by name (default: one of the same name is replaced), added («Mouth 2»), or left
out (`'none'`); `exportTemplate` leaves them out with `motionSync: false`.

## Physics files in

`physics.import { path | text }` (`src/physics-import.ts`) reads a `.physics3.json` with
Mochi2D's `parsePhysics` and records ordinary commands: `physics.addSetting` for new settings,
`physics.updateSetting` for one whose name the document has (settings are known by their
`PhysicsDictionary` name, since a file's setting IDs are only positions), and `physics.setFps`.
Inputs and outputs are matched to parameters by export ID; the unmatched ones are left out and
reported. It is one transaction, and a dry run only reports. It is in the CLI
(`mochi-maker import-physics`), the API (`Project.importPhysics`), the MCP server (`mochi_run`; the
path is checked against the allowed folders), the bridge (with `text`: the editor cannot reach
paths) and the physics dialog. Exports keep our own writer (`physicsFile`).
`physicsimport.test.ts` checks the round trip for every golden with physics: export, import the
file into a copy without physics, export again; the file comes back byte for byte.

## Copy and paste

`clipboard.copy { targets }` (read scope) returns a fragment (`copyFragment`) with the layers'
images as base64; `clipboard.paste { fragment, part?, deformer? }` adds the images to the assets
(checking their hashes), runs `objects.paste`, and with `deformer` reparents the pasted top objects
into it with `mesh.reparent` and `deformer.reparent`, in place. `clipboard.test.ts` carries a warp
from golden 15 into golden 1 through JSON and exports the result.

## Model templates

A template is a finished project's rig, to put on new art, in a familiar workflow. The
file is Mochi Maker's own: a zip, `.mochitemplate`, with `template.json` (format
`mochi-maker-template`, version 1, name, description, author, date, whether physics is included,
counts), `thumbnail.png`, and the project's files under `project/`. `exportTemplate(doc, assets,
{ name, description, author, thumbnail, physics })` writes the files, `templateZip` the zip, and
`readTemplate(files | zip)` reads either.

`modelTemplate.apply { path | files, targets?, layout?, pairs?, options? }` (`applyTemplate`), one
transaction:

- **Layout:** template canvas pixels × `scale` + (`x`, `y`). The default (`defaultLayout`) fits the
  template's art onto the targets' art (the smaller size ratio) and centers it.
- **Matching** (`matchTemplate`): equal names first (export ID or display name, ignoring case, an
  `ArtMesh` prefix and punctuation); then, for the rest, the cheapest pairs by `shapeCost` of the
  laid-out art rectangles (center distance over the diagonal, plus half the log size ratios, plus
  one minus the overlap), up to `MATCH_LIMIT` 1.5. `pairs` fixes pairs by hand (a template mesh's
  export ID, or null to leave a target out).
- **Parameters** that the matched meshes, their deformer chains and the physics use: with
  `parameters: 'merge'` (default) a target parameter with the same export ID is used (its range
  widened and keys added only as the template's bindings need); with `'add'`, or when there is
  none, a new one (`ParamX_2` when the ID is taken).
- **Deformers:** the matched meshes' deformer chains, parents first, with every keyform. Top-level
  points (warp grids, rotation origins) are laid out like the art; points inside a rotation are
  scaled; points inside a warp are relative to it and stay.
- **Meshes:** each target moves into its template mesh's deformer, staying in place
  (`mesh.reparent`), and takes its bindings. Each keyform is the target's rest shape plus the
  template mesh's change from its rest form (the cell at the parameters' defaults), carried by the
  barycentric weights of each target vertex in the template mesh (outside it: the nearest triangle,
  clamped), scaled like the layout outside warps. With `redivide`, the target first takes the
  template mesh's topology (`mesh.setTopology`, its texture placed by the layout), and the shapes
  carry vertex by vertex. Opacity and colors come along; draw order with `drawOrder: 'template'`
  (default; `'keep'` keeps the art's); masks (to the matched targets), culling and legacy blending
  with `masksCullingBlend` (default true). Targets that already have bindings are left alone, with
  a note.
- **Parts** (`parts`, default true): the template's part structure for the matched
  meshes and deformers, top-down in its tree order, with visibility, sorting scope and draw-order
  keyforms (a part whose export ID the target has is reused); the targets move into their template
  meshes' parts, in the template's order, and the new deformers belong to the template's parts.
  With `parts: false` the target keeps its own tree.
- **Physics** settings whose parameters all came along: `'merge'` (default) replaces a setting of
  the same name, `'add'` adds another («Swing 2»), `'none'` brings none.
- Not carried: blend shapes and glue (not available in this build), and motions (the preview
  plays them, below). Motion-sync settings come along by the `motionSync` option (below, «Motion
  sync»). Mochi Maker has no label colors.

The result also maps each parameter that came along from its template export ID to the target's
(`parameterIds`). `retargetMotion(motion3, parameterIds)` rewrites a template motion's parameter
curves for the target and leaves out (and lists) curves of parameters that did not come along; the
editor's preview plays the template's motions that way.

The result lists the layout, every pair (and how it was made), the unmatched targets, the
parameters merged and added, the new deformers, the physics replaced and added, and notes. In the
CLI: `mochi-maker export-template` and `mochi-maker apply-template`. Agents run `modelTemplate.apply` with
`mochi_run` (a `path` inside the allowed folders) or through the bridge (`files`, base64).
`template.test.ts` applies a template of golden 15 to golden 15's art without any rig and compares
Mochi2D's evaluation at four poses (within 2·10⁻⁴), matches by shape when the names differ, takes
corrections, and checks merge and add with golden 11's physics.

## The conformance pack (M12)

```
mochi-maker conformance-pack <project…> --out <dir> [--versions 3,4,5] [--seed N] [--random N] [--render-poses N] [--no-renders] [--force]
```

For comparing Mochi Maker's exports with reference results in the same formats (design 7.5). For each project and each version 3, 4 and
5 that can carry it, the pack holds the exported model folder, scenario files in Mochi2D's
catalog formats, Mochi2D's results for them (`scenarioResult`, printed with `formatResultJson`
as Mochi2D's own conformance runner prints them), a `manifest.json` with every file's SHA-256 and
the coverage of the writer's paths, and a `README.md` saying how to compare
(`conformancePack` and `packReadme` in `src/conformance.ts`).

- **Static scenarios** (`mochi2d-scenario/0`): the default pose; each key of each parameter;
  the midpoints between neighbouring keys; values half a range below and above; every cell of
  an object bound to two or more parameters, and each cell's centre; part opacities at one half;
  random poses from a fixed seed (mulberry32), a quarter range beyond each end.
- **Animation scenarios** (`mochi2d-anim-scenario/0`, 30 frames a second, no random numbers;
  physics and pose on where the model has them): each motion, each expression, physics under wind
  and tilted gravity, and switching the first pose group.
- **Versions a project cannot carry** are listed with the first feature that needs a newer one.
- **Coverage.** Each export is read back with Mochi2D's `readMoc`. Its sections and files say
  which writer paths it exercises (`COVERAGE`): parts, nested parts, meshes, masks and inverted
  masks, blending, single-sided meshes, warps, rotations, nesting, mirror flags, glues, bindings,
  two-parameter bindings, repeating parameters, nested draw-order groups; at version 4 colors,
  parameter key lists, blend-shape parameters, mesh and warp blend shapes, constraints; at version
  5 keyform colors and part, rotation and glue blend shapes; and the settings, display info,
  textures, user data, physics, pose, expressions, motions and sounds. `conformance.test.ts`
  checks that every path is covered, and every version-3 path at version 3.

The pack of all goldens is committed in `conformance/` for the hand-over, and the test checks that
it is up to date; `UPDATE_PACK=1 npx vitest run packages/export/test/conformance.test.ts` rewrites
it, renders included (that needs headless Chromium; the plain test compares everything else).

**Renders**. Each export also has `render.default`, the default pose with a `render`
block of 512 × 512 (the canvas fitted in). `renderPack` renders it with Mochi2D's `NodeRenderer`
(`openPackRenderer` in `@mochi-maker/api`; the reference render: headless Chromium with
SwiftShader) and writes `renders/<id>.png`, premultiplied, and `renders/<id>.render.json` in the
shape of Mochi2D's render tool: `format` `mochi2d-render/0`, `scenario`, `producer`,
`error`, `png`, `alpha`, `width`, `height`, `renderer`, `pixelsPerUnit`, `center`, `masks` (the
reference configuration: per-drawable masks of 4096, offscreen masks of 256, every mask mesh) and
`notes`. It leaves out `stats` (informational, not reported by `NodeRenderer`) and
`milliseconds` (which would change the pack on every run). The CLI renders unless `--no-renders`
is given, and without Chromium it writes the pack without renders and says so. Renders are
byte-identical from run to run.

**Renders at random poses**. Each export also has `render.random.<seed>.<i>` for the
first three random poses (`renderPoses`, `--render-poses N`): the same parameter values and part
opacities as the static `random.<seed>.<i>`, with the same `render` block. The manifest lists them
in each entry's `renders`, beside `render` for the default pose, and `renderPack` renders each at
its scenario's pose (`PackRenderer.render` takes the pose). The committed pack has 39 × 4 = 156
renders.

## Sounds

A motion's sound is exported as `sounds/<name>.wav` (the asset's bytes, unchanged), and the motion's
entry in the model settings gets `"Sound"`. Only sounds that some motion starts are exported. The
load check decodes each with Mochi2D's WAV reader. Golden 13 checks, in a Mochi2D scenario, that
starting the motion plays the sound and that lip sync follows its level (§3b.2, 3s).

Sounds come in through the `sound.import` operation, which reads the WAV header with Mochi Maker's
own reader (PCM 8, 16, 24 or 32 bits, or 32-bit float) and stores the file as an asset.

## Compatibility targets (M13)

`compat.test.ts` exports every golden project at versions 3, 4 and 5.

- A lower version that carries the project must evaluate exactly like version
  5, value for value, at the default pose, at each parameter's ends, and with
  every parameter at 30 % of its range.
- A lower version that cannot carry it must be refused, naming exactly the
  objects `requiredVersion` lists above that version, each with a fix.

`mochi-maker export --moc-version 3|4|5|auto` and `validate --target-version`
use the same rules.

## Fuzzing

Random documents with parts, sorting scopes, nested warps and rotations,
meshes, bindings, colors, masks, glue and blend shapes (with constraints) are
exported at versions 3, 4 and 5. Each version below the one the document needs
must be refused. Each export must:

- keep every writer rule;
- pass `validateMoc` at both levels;
- export to the same bytes twice;
- evaluate random poses in Mochi2D without errors or non-finite values.
