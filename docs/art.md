# Art import and mesh generation (M3)

This is what `@mochi-maker/art` and `@mochi-maker/geometry` do today, and how
to use them from the CLI and from code.

## Importing art

```sh
mochi-maker import Hana.mochi art/hana.psd --spacing 16 --preview import.png
mochi-maker import Hana.mochi art/layers/ --no-meshes
mochi-maker import Hana.mochi art/hana.ora --dry-run
```

`art.import` is an **operation**: it reads files and pixels, then changes the
document in one transaction made of ordinary commands. So the import is one
undo step, `--dry-run` shows the result without committing it, and the log
replays without the source file.

| Source | Read with | What is kept |
|---|---|---|
| PSD (`.psd`, `.psb`) | ag-psd | groups (nested), layer position, visibility (also hidden through a group), opacity, blend mode, clipping; 16-bit channels are reduced to 8 bits |
| OpenRaster (`.ora`) | fflate + Mochi Maker's XML reader | nested stacks with offsets, visibility, opacity, `composite-op` |
| A folder of PNGs | — | `layers.json` (name, position, group path, visibility, opacity, blend mode, clipping) or `order.txt` (one file per line, bottom first), else natural file-name order |
| One PNG | — | one layer |

What the import does:

1. Every layer is trimmed to its non-transparent pixels and stored once, by
   content hash, in the project's assets.
2. Every layer group becomes a part (nested as in the file). Art without any group, imported without
   `parent`, gets one part named after the file holding its layers.
3. Every layer becomes a **layer** object. It records the source layer's
   visibility, opacity, blend mode, clipping and import notes.
4. Unless `meshes` is false, every visible layer gets a **mesh**, generated
   from its alpha (below). `includeHidden` meshes hidden layers too. Meshes
   follow the layer order inside their group's part.
5. **PSD clipping** (a layer clipped to the one below) becomes a clipping
   mask: the clipped mesh is masked by its base layer's mesh.
6. If the project has no layers yet, the canvas is set to the art's size
   (`setCanvas`: `ifEmpty` by default, or `always` or `never`).

**Not applied, but noted:**

- blend modes other than normal;
- group opacity and group blend modes;
- layer masks and layer effects;
- adjustment layers (skipped).

The notes are in each layer's `notes` and in the import result.

**Export IDs** come from the names: `Part_Head`, `ArtMesh_Face`. A name
without ASCII letters or digits (for example `目`) gets a generated ID such as
`ArtMesh12`, and the name stays as the display name.

The result lists the new parts, layers and meshes, plus the notes, and comes
with a preview image of the visible layers composited with normal blending.
The preview applies neither clipping nor blend modes.

## Generating meshes

```jsonl
{"name":"mesh.generate","args":{"layer":"@layer~face","part":"@part:Part_Head","spacing":20}}
{"name":"mesh.regenerate","args":{"target":"@mesh:ArtMesh_Face","spacing":12}}
```

The algorithm is Mochi Maker's own (`packages/geometry`):

1. **Mask:** pixels with alpha at or above `alphaThreshold` (default 8 of
   255), grown by `margin` pixels (default 3), so the mesh covers the art with
   room for filtering.
2. **Saddles removed:** two pixels touching only at a corner get a third
   pixel, so outlines never touch.
3. **Outlines traced** along pixel edges. Outer outlines and holes are
   separated by orientation. Islands smaller than `minIslandArea` and holes
   smaller than `minHoleArea` (both 16 px²) are dropped.
4. **Simplified** with Douglas–Peucker (`tolerance`, default 1.5 px, kept
   below the margin), then long edges are split so none exceeds
   `boundarySpacing`. If simplified outlines would cross, the tolerance is
   halved until they don't. At zero tolerance the traced outlines never
   cross.
5. **Interior vertices** on a jittered grid (`spacing`, `seed`), kept at
   least 0.6 × spacing away from the outline.
6. **Constrained Delaunay triangulation:**
   - incremental insertion with Lawson flips;
   - constraint recovery by edge flips;
   - an even-odd fill, so holes stay open and islands inside holes are kept.

   Orientation tests are evaluated in a canonical vertex order, so they are
   consistent between neighboring triangles.

**Guarantees, tested on random shapes:**

- every opaque pixel lies inside the mesh;
- every triangle faces forward (positive orientation in stored y-down
  coordinates, the format's culling rule, §2e);
- each outline is a boundary of the mesh;
- the same image and options give the same mesh.

Without `spacing`, the density aims at about 120 interior vertices per
island. More than 65,535 vertices is an error, with a fix that suggests a
larger spacing.

| Layer | Vertices | Time (Node 22) |
|---|---|---|
| 512 × 512, default spacing | 179 | 57 ms |
| 2048 × 2048, default spacing | 247 | 160 ms |
| 2048 × 2048, spacing 20 | 4,129 | 179 ms |
| 4096 × 4096, default spacing | 318 | 576 ms |

`mesh.generate` creates the mesh at the layer's canvas position, without a
deformer, and returns a wireframe preview. `mesh.regenerate` rebuilds an
existing mesh from its layer through `mesh.setTopology`, so its keyforms carry
over.

## Re-importing changed art

When the artist changes the PSD (or ORA, PNG or PNG folder) after import, `art.reimport` brings
the changes in without undoing the rig (design 6, "Re-import"):

```sh
npx mochi-maker reimport demo.mochi character.psd --dry-run   # report only
npx mochi-maker reimport demo.mochi character.psd             # one undoable transaction
```

**Matching.** Each layer records where it came from (`source`: `file#group/…/name`). Layers in the
file are matched to the project's layers by that group path and name, or by the name alone when
it is unique (the layer moved to another group; the result says where it was). Candidates are the
layers imported from the same file; if there are none (the file moved or was renamed), every
imported layer is a candidate, and a note says so.

**What changes:**

- **A matched layer whose pixels or bounds changed** gets the new pixels through `layer.setImage`.
  Its meshes keep their positions in every keyform. Their texture coordinates move by the change
  of the layer's top-left corner, so every vertex keeps showing the same canvas pixel. A matched
  layer that did not change is left alone, except for its recorded properties (visibility,
  opacity, blend mode, clipping, source).
- **A layer that is new in the file** is created as a layer, with its source, but is not meshed
  (`mesh.generate` makes a mesh when the person wants one). `addNew: false` skips them.
- **A layer that is no longer in the file** is kept, with its meshes. Its notes get "missing from
  … at re-import"; the note goes away if a later re-import finds the layer again.

**The report** (`art.reimport`'s result, the CLI's output, the editor's Art palette):

| Field | Meaning |
|---|---|
| `changed` | Layers with new pixels. For each: `boundsChanged`, `shapeChange` (the share of canvas pixels whose opacity flipped), and `movedFrom` when matched by name. |
| `refit` | Meshes that may need re-fitting, with reasons and measurements. `art outside the mesh`: more than 0.2 % of the new opaque pixels are outside the mesh. `mesh over empty pixels`: the share of the mesh's area over transparent pixels grew by more than 10 points. `bounds changed`: the layer moved or resized and its shape changed by more than 1 %. |
| `added`, `removed` | As above. |
| `unchanged` | Matched layers with the same pixels and bounds. |

Re-importing the same file twice changes nothing the second time.

## Editing meshes

All of these are ordinary commands. They keep every keyform valid: a new
vertex is placed, in each keyform, by its barycentric weights in the old mesh,
so deformation carries over. Glue pairs follow their vertices, and pairs on
removed vertices are dropped (the result says how many).

| Command | Effect |
|---|---|
| `mesh.setTopology` | new uv and triangles. Vertices at the same uv as before keep their positions exactly; the rest are interpolated, or extrapolated outside the old mesh |
| `mesh.addVertices` | split the triangle (or edge) each point falls in; indices of existing vertices do not change |
| `mesh.deleteVertices` | remove vertices and their triangles, and refill the hole from the ring of neighbors (at the boundary, only if the outline stays simple); later vertices move down in index |
| `mesh.retriangulate` | constrained Delaunay over the current vertices and outline |
| `mesh.flipEdge` | flip the diagonal of a convex quad |
| `mesh.moveUv` | move texture coordinates only |
| `mesh.moveVertices` | move positions in one keyform cell, or all cells |

## From code

```ts
import { Session, MemoryAssetStore, runItems } from '@mochi-maker/core';
import { NodeFileSystem } from '@mochi-maker/core/node';
import { ART_OPERATIONS } from '@mochi-maker/art';

const session = Session.create();
const ctx = { session, assets: new MemoryAssetStore(), fs: new NodeFileSystem() };
const r = await runItems(ctx, 'Import', [{ name: 'art.import', args: { path: 'hana.psd' } }], {
  operations: ART_OPERATIONS,
});
r.itemResults[0]; // { parts, layers, meshes, notes }
r.previews[0];    // { mediaType: 'image/png', data, width, height, description }
```
