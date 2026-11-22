# Model import

Mochi Maker can open a `.moc3` model folder as an editable project (roadmap M16): a model you
made earlier, or one whose author allows you to edit it, comes back into the editor. Exported
again without an edit, it evaluates as the file did in the cases the tests cover
([below](#the-round-trip)). Open only models that you made or that their author allows you to
edit; a model's terms of use still apply after import ([`TERMS.md`](../TERMS.md)).

To try it, import [`samples/mochi/`](../samples/mochi/), the getting-started guide's model.

## Where

| Where | How |
|---|---|
| Editor (browser) | File › Import Model…, then choose the model's folder. |
| Editor (desktop) | File › Import Model…, then choose the folder in the system's dialog. |
| Command line | `mochi-maker import-model <model folder or file.model3.json> <new project dir>` |
| API | `Project.importModel(model, dir, options?)` returns `{ project, report, notices }`, saved in `dir` |
| MCP | `mochi_project` with `{ "action": "importModel", "model": "…", "path": "…" }`; the result has `report` and `notices` |

The project opens unsaved in the editor (Save asks for a folder); the command line, the API and
the MCP server save it in the new folder, which must not hold a project yet.

## What it reads

One model folder: its `.model3.json` and what it refers to: the `.moc3`, the texture pages, and
the physics, pose, expression, motion, display-info, user-data, sound and motion-sync files.
Point at the folder or at its `.model3.json`. Nothing else is read: no archives, no downloads, no
other folders. A folder with several `.model3.json` files at its top is refused; name the one to
import.

The folder is read within the caps Mochi2D suggests for models from strangers: 64 MiB a file,
256 MiB in all, 2,000 files, each checked by its size before anything is read. Textures are
checked against the image caps before they are decoded. A folder past a cap is refused as too
large ([`limits.md`](limits.md)).

- `.moc3` versions 3 to 6 are imported; versions 1 and 2 are refused. The version 6 import is
  tested only on the project's own files (every golden exported at version 6, the version 6 golden
  among them: exported, imported and exported again byte for byte), not on a model from other
  software, as no version 6 file from other software is at hand.
- Every file is read with Mochi2D's parsers, which check it; a runtime file that does not read is
  left out and listed in the report. The `.moc3`, the settings and the textures must read, and the
  `.moc3` must pass Mochi2D's `strict` check (the loader's): `readMoc` alone reads some files that
  do not load.
- `importModel(files, settings, assets, { mocData })` takes model data instead of the `.moc3`
  file's contents, as `readMoc` gives it: for data read or made elsewhere.
- Motions are read as Mochi2D reads them (`parseMotion`, with the file's `Meta` and curve fades as
  written). Curves at the end of a motion that come after a curve of a later kind (model, then
  parameter, then part opacity) take no effect; they are left out, and the report says so.

## What the project holds

The inverse of the export: Mochi2D's `readMoc` gives the model data, and each part of it becomes the
document's objects.

- **Parameters** with their IDs, ranges, defaults, repeat flag, type (normal or blend shape) and
  key lists (from version 4; for version 3, the keys their bindings use).
- **Parts** with their tree, keyforms, initial visibility and sorting scopes (a nested draw-order
  group becomes a part with its own scope). Each part's children follow the file's draw-order
  entries, so that the tree shows the stacking where it can.
- **Warp and rotation deformers** with their nesting, owning parts, cells and keyforms.
- **Art meshes** with their UVs, triangles, keyforms (positions, opacity, draw order, multiply and
  screen colors), blending, double-sided flag and clipping masks (normal and inverted).
- **Glue** (vertex pairs, weights and keyformed intensity) and **blend shapes** on every kind of
  target, with their keys, base key, deltas and constraints.
- **Version 6:** offscreens (a part drawn offscreen, with its blend mode, masks, and its keyforms'
  opacity and colors, read as Mochi2D's loader reads them) and their blend shapes, which join the
  part's blend shape on the same parameter; and the art meshes' blend modes.
- **The runtime files:** hit areas, the EyeBlink and LipSync groups, the display info's names,
  parameter groups and combined parameters, user data, physics (with its rate), expressions,
  motions (curves, fades, events, loop, the sound and motion-sync setting they start), sounds,
  motion sync and pose.
- **Export settings:** the file stem, the `.moc3` version (so the export writes the same version)
  and the atlas page size of the texture folder.

**Spaces.** The file stores top-level objects in model units and the document stores them in
canvas pixels. Each value becomes the float32 pixel value that the export turns into exactly the
stored one again (and the same for rotation scales, blend-shape offsets and UVs). For a model
exported by Mochi Maker such a value always exists. For a file written by other software it may
not; then the document holds the nearest one, the project keeps the file's value beside it, and
the report counts these values ([what is kept](#what-is-kept-from-the-file)).

**Textures.** Each texture page becomes one layer the size of the page, marked as a texture page
(`texturePage`). The export writes such a layer back as its own page, unpacked, with its PNG bytes
unchanged, and its meshes keep their UVs, which are the page's pixels. New art added to an imported
model is packed onto pages after the kept ones, as usual. The art palette and the canvas show the
pages as layers; their meshes can be edited, re-meshed and rigged like any other.

**Names.** A `.moc3` holds IDs, not editor names. Parameters, parameter groups and parts get the
names of the display-info file where it has them; everything else is named by its ID.

**Version 4 files.** Version 4 ignores blend-shape values other than positions and grid points.
The project keeps those values at zero, so it still exports at version 4; the report says when
the file had others.

## What is kept from the file

Some of what a file holds the document would otherwise derive, in its own way, when it exports.
The import keeps the file's in `project.importedFrom.keep`, and an unedited export writes it again:

- **Index orders.** The file's order of parts, art meshes and deformers. The export writes those
  objects in that order; new objects follow.
- **Draw-order groups.** The order of the groups and, for each, its entries in the file's order:
  the stacking order among equal draw orders (below).
- **Values with no exact inverse** (see Spaces): the file's value, written while the document
  still holds the value it was given. Once that value is edited, the export writes the edited
  one, converted as usual.
- **Group ranges** (each group's lowest and highest draw order). Evaluation uses them. A file may
  store wider ones than its members can reach; they are written while the members' reachable
  range is the one the file's data gave.
- **Flags the document has no place for:** a parameter's decimal places other than 3, art meshes
  and deformers whose file flag says hidden, art-mesh flag bits other than blending and
  double-sided, the canvas flags, and mirror flags on rotation blend-shape deltas.
- **Version 6:** a mesh's blending every version has comes from its blend code, not from flag bits
  0–1, which version 6 does not read (the file's bits are kept while the blending is unedited); the
  order of the offscreens, offscreen flag bits other than the inverted mask and bit 2, and blend
  codes the document gives otherwise (a code it has no name for, a compatible code with an
  alpha mode, a code that differs from the mesh's legacy flags), written while the document gives
  the code the import gave it.

**Stacking.** Among equal draw orders, a group draws its members (meshes, and parts with their
own scope) in a fixed order. A project normally takes it from the tree. A file can interleave the
members of different parts, which a tree cannot show. Then the project keeps the group's order
explicitly (`project.stacks`), and the export writes that order:

- members not in the list, such as a new mesh, stand right after the member before them in the
  tree;
- moving an object in the tree (`tree.move`, drag and drop) places its members in the explicit
  order before the next listed member that follows it in the tree, or else after the one before it;
- reordering a part among its siblings is such a move, and its members move with it;
- an object that changes groups (a part switched to or from its own scope, a deleted object)
  leaves the lists; one that joins a group is placed as a new member.

A group whose file order the tree already shows keeps no list, and edits work as in any project.

## What it cannot hold

An imported project is a reconstruction. A model folder does not hold:

- the source artwork and its layers: the texture pages are the art;
- names of art meshes, deformers and glues, and names the display info does not give;
- editor data: guides, deform paths, the timeline's work areas and markers, Auto smooth handles
  (they are ordinary Bézier handles in the file), animation templates.

Keep the original files. The report lists what was left out and why, for example a file the
settings do not refer to, an entry that names an ID the model does not have, fade times set
in the settings' motion entries (the document keeps a motion's fades in its own file), or a mesh
or part that the file lists in another draw-order group than its part's (the project stacks it
with its part, so the order it is drawn in can differ).

Some files are refused, with a message that names the object: data that Mochi2D reads but the
document's own rules do not allow. Examples are an opacity above 1, a parameter default or key
outside the parameter's range, keys that are not strictly ascending, a blend-shape parameter used
as a normal binding, a blend shape whose base key has a non-zero delta, two blend shapes on one
parameter for one object, a mask that is the mesh itself or listed twice, a glue between a mesh
and itself, a keyform count that does not match its bindings, and a texture the settings do not
list.

## The origin

The project records that it was imported: the date, the `.moc3` version and the files read
(`project.importedFrom`). It is saved with the project and shown in the Project palette.

## Glue and blend shapes

A model that uses glue or blend shapes imports with them, whatever the feature flags
([`core.md`](core.md#feature-flags)). The import does not change a flag. The report says which of the
two the model uses, and that the project does not export while the flag it needs is off. With the
flags off, the project opens, previews as it exports, and everything else in it can be edited; a
glue's Inspector fields are read-only with a notice, and commands that create or change glue or
blend shapes are refused.

## The round trip

`.moc3` → project → `.moc3`, without an edit, evaluates bit for bit as the file did. That is
tested for:

- the project's own exports: every golden project at versions 3, 4 and 5;
- the synthetic models in the repository, written with Mochi2D's writer the way other software
  might write them;
- a real model checked locally by the project (not in the repository).

It is not promised for every file from other software. What is tested:

**Mochi Maker's own exports** (`packages/export/test/modelimport.test.ts`): every golden project
exported at versions 3, 4 and 5 is imported, exported again and checked:

- Mochi2D's evaluation of the original and the re-export is bit-identical over 300 seeded random
  poses (every drawable's vertices, opacity, draw and render order, colors and visibility);
- the re-exported `.moc3` is byte-identical, and the texture pages too, so renders are identical;
- the runtime files carry the same content;
- after one edit (moving a mesh's vertex in every keyform and widening a parameter's range), the
  re-export changes only those values;
- the project saves and reopens with its origin and texture pages, and exports the same bytes.

**Files not written by Mochi Maker** (`packages/export/test/modelorder.test.ts`,
`packages/api/test/importrender.test.ts`): synthetic models in which every mesh has the same
draw order and overlaps the others, so that the stacking alone decides what is on top. They have:

- shuffled part, mesh and deformer index orders, children before their parents included;
- group entries that interleave parts, and renumbered nested groups;
- group ranges wider than reachable;
- values no pixel value exports to exactly;
- other decimal places, a hidden mesh, canvas flags and extra mesh flags.

For each, at versions 3, 4 and 5, the export gives the same ID orders, the same groups with the
same entries in the same order and the same ranges, and the same values for each object. The
evaluation is bit-identical over 200 seeded poses (render order included), and so are the
reference renderer's images. Only the layout in the file's shared pools may differ (where each
object's keyforms, positions and colors sit), so the bytes may differ while the evaluation does
not. After a move in the tree and a new mesh, the stacking follows as described above.

**One value at a time** (`packages/export/test/modelsweep.test.ts`): in each golden export at
versions 3, 4 and 5, the first and the last value of every field of the model data are changed,
one at a time. Each change that Mochi2D's writer and its strict check accept must come back from
an unedited import and export with a bit-identical evaluation, be named in the report, or be
refused with a message.

## The notice

The first time someone imports a model in the editor, a dialog shows this once, with «Got it»:

> You are opening a finished model for editing. Do this only with models you made or have
> permission to edit. The model's terms of use still apply.

The command line prints the same text as one line on standard error on each import; the API and
MCP results carry it in `notices`. Nothing asks for a confirmation or for proof of anything.
