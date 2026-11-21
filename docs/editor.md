# The editor

`@mochi-maker/editor` is a web app over the same command layer as the agent API. Everything a
person does in it is a command, so it lands in the same history as an agent's commands, and an
agent could do the same thing.

Its layout, workflow, terms and shortcuts follow familiar conventions of model editors, so that
people who know other model editors feel at home. The visual design (icons, colors, styling) is
Mochi Maker's own.

```sh
npm run editor         # Vite dev server
npm run build:editor   # static build in packages/editor/dist
```

## The window

| Area | What it holds |
|---|---|
| **Menu bar** | «File», «Edit», «Show» (or «Display», a setting), «Modeling», «Animation», «Window», «Help». While mesh editing is on, a «Mesh Edit mode» menu appears. Each item shows its current key. |
| **Toolbar** | At the left end the **workspace switcher**; then the target version (`.moc3` v5, v4, v3 or auto), the three **edit levels**, the workspace's tools, and Undo and Redo. Modeling: Texture Atlas, Edit Mesh, Automatic Mesh, Create Warp Deformer, Create Rotation Deformer, the drag-to-create rotation tool, the Arrow and the Lasso. Animation: Play and the Arrow. On the right: the command bar, **Agent access** ([`bridge.md`](bridge.md)) and **Home**. |
| **View area** | A tab per view (a Modeling View or an Animation View), the **draw-order strip** along the left edge, Mochi2D's view with Mochi Maker's overlays, the status line (lower left) and the view controls (lower right: magnification, full scale, fit, flip). |
| **Palettes** | Docked left, right and below the View area, or floating (next section). |
| **Home** | At startup: a new model with a canvas size, a new model from art (pick or drop a PSD, OpenRaster or PNG), opening a project folder or a `.mochi.zip`, and the recent names. It closes when a file opens (both are settings). |

Open a project by dropping a project folder or a zip onto the window; the folder that holds
`mochi-project.json` is the project. A dropped art file goes into an empty model; when a model is
open, a dialog asks whether to add new ArtMeshes, replace the art that is loaded (re-import), or
start a new model.

### Palettes

| Palette | What it is for |
|---|---|
| **Parts** | The objects grouped by part, in layer order, with each one's draw order at the pose. Show/hide and lock toggles on every row; filters by type and by name or ID; drag an ArtMesh or part onto a part to move it there. |
| **Deformer** | The same objects by parent-child hierarchy. Drag an object onto a deformer to reparent it in place (`mesh.reparent`, `deformer.reparent`). |
| **Parameter** | A slider per parameter, in groups. «+2 keys» and «+3 keys» add keys at the ends (and the middle) of the range to the selected objects for the parameter picked by clicking its name; «New…» creates a parameter; the palette menu has Reset Parameters and «Lock Default Forms». A filter shows only the parameters keyed on the selection. Double-click a name to type exact keys; right-click near a key to snap to it. |
| **Inspector** | The selection's properties: name, ID, part, parent, mask and its inversion, culling, «Standard Angle» of rotation deformers, a parameter's standard groups (Eye blink, Lip sync), and the keyform at the pose (opacity, draw order with ±10 and ±100 steps and drag-to-change, angle, origin in canvas pixels, scale, multiply and screen colors). A locked object's fields are locked too (a setting). |
| **Tool Details** | The active tool and edit level; in mesh editing, its sub-tools (select and move, add vertices, lasso), Delete, Flip Edge, Connect Vertices, Automatic Mesh, Confirm and Cancel. |
| **Project** | The model's files and its layers. |
| **Log** | Every message and change, with info, warning and error levels; logging on or off, Copy, Clear; double-click to enlarge. |
| **Scene** | The project's motions: pick, create, delete. |
| **Template** | Animation templates: New from the selected keys' range, a button per template that inserts it at the playhead, rename, delete, import and export. See [Motions](#motions-m10). |
| **Timeline** | The picked motion's keys, in the Dope Sheet or the Graph Editor (C); playback through Mochi2D. See [Motions](#motions-m10). |
| History, Validation, Agents, Art, Preview, Draw Order | Mochi Maker's own: the history with authors, invariants and lint with the export check, agents' calls, the last re-import's report, preview build timings, and Mochi2D's evaluated draw order. |

### Docking and workspaces

- **Moving a palette:** drag its tab. Dropped near the top or bottom edge of a group (left or
  right edge in the bottom region) it becomes a new group there, and a marker shows the place;
  dropped onto a group it joins it as a tab; dropped over the View area or outside the regions it
  floats. Dragging the empty strip next to a group's tabs moves the whole group. While dragging,
  empty regions show as drop zones.
- **Floating windows** can be moved by their empty strip, resized by their corner, closed, and can
  take further palettes as tabs.
- **Showing and hiding:** the Window menu toggles each palette; a tab's right-click menu closes or
  floats it; «Hide All Palettes» and its counterpart enlarge the canvas and bring them back.
- **Splitters** between the regions and the View area, and between groups, resize them.
- **Workspaces:** Modeling and Animation, plus custom ones (Window › Workspace › Workspace
  Settings: add from the current layout, rename, reorder, delete, and choose which kind of view
  switches to each). Each workspace keeps its own layout as it changes, in the browser's storage;
  «Reset Current Layout» restores its initial layout; a custom workspace can make the current
  arrangement its new initial layout. The presets' initial layouts can only be restored.
- **View tabs:** each keeps its own parameter values, display position and flip. Selecting a tab
  switches to the workspace that suits it (a setting turns this off). Tabs can be duplicated,
  closed (Ctrl+W; the last one stays), reordered by dragging, stepped through (Ctrl+PageUp,
  Ctrl+PageDown) and put at the same display position. File › New Animation View (Ctrl+Shift+N)
  adds an Animation View.

## The viewport

**What it shows.** The preview is the export. After every change, `PreviewBuilder`
(`@mochi-maker/export`) lowers the document and writes the `.moc3` with the exporter's own code.
The view then loads that from memory (`view.load({ files })`).

- **Skipped for speed:** the export's lint, validation and load check.
- **Cached:** decoded layer images (by asset hash) and the atlas with its PNG files. The atlas key
  is its inputs: layers, UV bounds and page size. Moving vertices or editing keyforms reuses the
  atlas.
- **Versions:** the preview uses the export's file version, raised to what the document needs.

**Requests.** Builds are latest-wins. A build in progress finishes, and the newest request runs
next. Loading keeps the person's zoom and pan; only a newly opened project is fitted.

**Effects.** Physics, blink, breath, look, idle motions, lip sync, pose groups and expressions are
off while editing. The view shows the parameters as posed and the parts' own opacities.

**Overlays.**

- Each mesh's evaluated vertices are mapped from model units to the screen through the view's
  documented transform: `viewTransform`, with zoom, x, y, rotation and `pixelsPerUnit`, and
  `model.canvas`.
- A test checks that this mapping agrees with Mochi2D's `toModel` within 0.1 px, before and after
  zooming and panning.
- Picking uses Mochi2D's `hitTest` for meshes, and the overlay's own geometry for vertices.

**Navigation** (rebindable, see below):

| Input | Effect |
|---|---|
| Mouse wheel | Zoom about the pointer |
| Space + drag, middle-button drag | Pan (`panBy`) |
| Space + Shift + drag | Pan along the first direction only |
| Ctrl + Space + drag | Zoom in steps of 1 % |
| R | Flip the canvas left to right (a view setting: the model is not changed) |
| R + drag, R + Shift + drag | Rotate the canvas, freely or in 15° steps |
| R + double-click | Reset the rotation |
| Ctrl + 0 | Fit the whole canvas; clears zoom and rotation |
| F | Center on the selection |
| T | The texture atlas instead of the model |

The flipped view is drawn mirrored; pointer positions are mirrored back before they reach Mochi2D
or the overlays (`Viewport.unflip`). The tilted 3D view (E + drag) and the spread draw order
(W + drag) are not built.

## Editing

Every edit is one transaction:

| Action | Command |
|---|---|
| Click an ArtMesh; Shift+click adds or removes; a drag on empty canvas or the Lasso (L) selects what it covers | selection (not a command). Locked and hidden objects are left out; Shift+A and Shift+D lock drawables or deformers on the canvas. |
| Click or Shift+click a vertex of the selected ArtMesh, drag a box or lasso over them | vertex selection |
| Drag selected vertices (levels 1 and 2); arrow keys (Shift: 10 px); Shift keeps a single point on one axis | `mesh.moveVertices` with the cell at the pose (meshes on the canvas); `keyform.set` with the resolved local positions (meshes in deformers) |
| The transform box (level 2: around two or more selected points; level 3: the whole ArtMesh or warp): drag inside to move, a corner to scale (Shift: proportions, Alt: about the center), just outside a corner to rotate (Shift: 15° steps) | `keyform.set` with every point resolved through the parent |
| Select a warp or rotation, drag a grid point or the origin (levels 1 and 2) | `keyform.set` of the grid or origin, resolved through the parent |
| Level 2 on a selected warp: drag a Bézier control point (pink dots at the patch corners take their handles along; rings are handles); Shift keeps one axis. Tool Details sets the Bézier divisions (2 × 2 by default) | `keyform.set` of the whole grid: each grid point moves by the control net's surface of the move, so the grid's own detail stays |
| A rotation deformer's handle (the dot at the end of its axis): turn it (Shift: steps, 45° by default); the square beyond it: scale; Alt+drag on the handle lengthens only its display | `keyform.set` of `angle` or `scale` |
| **Ctrl** with any deformer drag | the same, plus `keyform.set` of each direct child's keyform at its cell of the pose, converted so the contents stay in place on the canvas |
| Inspector "Parent deformer" (ArtMesh) and "Parent" (deformer); drop onto a deformer in the Deformer palette | `mesh.reparent`, `deformer.reparent`: attach in place |
| Modeling › Create Warp Deformer… / Create Rotation Deformer… | a dialog: ID, name, part, where it goes (the parent of the selection, a child of the selected deformer, or under a named deformer), a warp's grid (5 × 5 by default) and how it is sized (around every keyform of the contents, or around them at this pose, plus a margin), and a sequential mode that keeps it open. `deformer.createWarp` or `createRotation`, then the reparent operations, as one transaction; the new deformer is selected. |
| The drag-to-create rotation tool | `deformer.createRotation` at the press, with the drag's direction as its «Standard Angle» (`baseAngle`, up = 0°), and the selection moved into it |
| Edit Mesh (Ctrl+E, the toolbar, or a double-click on an ArtMesh) | enters mesh editing for up to two selected ArtMeshes; Ctrl+E or the canvas's Confirm leaves it; Esc or × cancels, undoing the person's changes made in it |
| In mesh editing: drag vertices | `mesh.moveVertices { all: true }` per vertex (every keyform moves by the same offset in the mesh's space) and `mesh.moveUv` (its texture coordinates follow, so the image stays put) |
| In mesh editing: the add tool, a click inside; Alt+click deletes | `mesh.addVertices` at the clicked point's texture coordinates; `mesh.deleteVertices` |
| In mesh editing: Delete, Flip Edge, Connect Vertices (Ctrl+R) | `mesh.deleteVertices`, `mesh.flipEdge`, `mesh.retriangulate` |
| Automatic Mesh (Ctrl+Shift+A) | a dialog that leaves the canvas usable: spacing, margin, outline tolerance and transparency threshold, three presets and saved ones; Enter in a field meshes the selected ArtMeshes with `mesh.regenerate` (keyforms carry over) |
| Delete / Backspace (canvas or a palette) | `mesh.delete`, `part.delete`, `param.delete`; `deformer.remove` for a deformer (its children move to its parent in place). The palette's Delete button asks first. |
| Modeling › Physics… | the physics dialog (below): `physics.addSetting`, `physics.updateSetting`, `physics.removeSetting`, `physics.setFps` |
| Ctrl+Delete | a deformer with everything inside it |
| The draw-order strip: drag a marker | `keyform.set` of `drawOrder` at the cell of the pose |
| Copy and paste a shape (Ctrl+Shift+C, Ctrl+Shift+V) | `keyform.copy` (the same object) or `keyform.set` (another object of the same kind and size) |
| Inspector keyform fields | `keyform.set` at the cell of the pose |
| Inspector «Origin X/Y (canvas)» of a rotation deformer: canvas pixels at the keyform's pose, whatever the parent | `keyform.moveInCanvas`: converted into the parent's space |
| Inspector object fields | `object.rename`, `mesh.update`, `mesh.setClip`, `part.update`, `deformer.update`, `param.update`, `param.setKeys` |
| Inspector «Groups» of a parameter: Eye blink, Lip sync | `meta.setStandardGroups` |
| "Add a key here", «+2 keys», «+3 keys», the key dialog | `param.setKeys` (when needed), `rig.addKey` or `rig.addBinding`, as one transaction |
| Undo, Redo | the session's undo and redo |

**The Parts and Deformer lists** keep a row's element while what it shows is unchanged, so a
commit rebuilds only the rows that changed.

**Hiding and locking** (the Ctrl+2 and Ctrl+3 families, the palettes' toggles and S for solo) are
the person's view, not the document: a hidden ArtMesh is disabled in the preview only, and nothing
lands in the history. A part's or deformer's state covers what is inside it. Dragging across the
toggles of several rows sets them all; Ctrl+click on a toggle sets every row at that level.

**Lock Default Forms** (Ctrl+Shift+1) refuses a person's edits to the default form of a keyed
object (its keyform where every bound parameter is at its default), with `E_DEFAULT_LOCKED`.
Objects with no bindings are not affected.

**Keyforms at the pose.** An edit goes to the keyform cell given by the current pose. When a bound
parameter sits between its keys, the edit is refused with the hint "Move it to a key, or add a key
here". The inspector then offers "Go to key" and "Add a key here" (design 4.4).

**Drags.** While dragging, the editor applies the same `mesh.moveVertices` to a draft of the
document and previews that draft without committing it. Releasing commits one transaction. The
dragged vertices are drawn under the pointer at once, ahead of the preview.

**Canvas-space editing through deformers (M4).** Vertices of a mesh inside deformers, a warp's grid
points and a rotation's origin are dragged on the canvas like vertices of a mesh on the canvas.
The points are stored in their parent's space, so each drag frame maps the pointer's canvas target
back through the parent chain: a damped Newton inverse (`invertMap` from `@mochi-maker/export`)
of the shown model's forward map at the current pose (Mochi2D's `mapPoints` and `mapJacobians`),
started from the previous frame's values. Mesh drags patch the shown model in place, as on the
canvas; handle drags preview a draft. Releasing commits `keyform.set` with the resolved local
values, so the log never holds canvas positions. A target the parent cannot reach (where it folds)
keeps the last good position. The selected warp is drawn as its lattice, curved as its parents
bend it, and a rotation as its origin and axis. Adding, deleting and flipping vertices work in
texture space, for every mesh.

**The deform path** (P, the toolbar's 〰 Path). With ArtMeshes or warps selected, clicks
on the canvas draw a path over them; Enter, a double-click or a click on its last point finishes
it, Esc cancels. Dragging a point of a path then drags the points near the path along, in the
keyform at the pose: every vertex or grid point within the path's reach (60 canvas pixels by
default, set in Tool Details) is tied to the path segments near it and keeps its place along and
beside them, so points turn with a turning segment; the move fades out with the distance,
(1 − (d / reach)²)² (`src/deformpath.ts`). One drag is one `keyform.set` per object, in one
transaction («Deform path»), resolved through the parents like any point drag. Paths belong to
an edit level: drawn at level 3 they show at level 3, otherwise at level 2 (level 1 shows level
2's), so a mesh can have fine paths and a broad one. They are saved with the
project (`deformPath.create`, `update`, `delete`; the drag moves the path in the same step as the
keyforms, so undo takes both back); they are never exported. A path drops a deleted target and
goes with its last one. Tool Details shows the state,
the reach, Finish and Delete path.

**Recording with the deform path.** In the Animation workspace with a motion picked and Record
drags on, at levels 2 and 3, dragging a path point does not change keyforms: the parameters bound
to the path's objects and to their deformers take the values that bring the objects' points
nearest to where the path puts them (least squares, each parameter in turn, sampled over its
range and refined, twice over, on Mochi2D's evaluation), and on release they are keyed at the
playhead in one transaction («Key from drag»).

**The four-corner forms** (Ctrl+4, Modeling › Generate Four-Corner Forms). For the
selected objects bound to exactly two parameters, `keyform.fillCorners` fills every cell away
from both defaults from the two edges: the rest form plus what each edge adds (core.md). The
usual flow: key Angle X and Angle Y separately, then select the objects and press
Ctrl+4 for the diagonals.

**The Bézier control layer of warps**. At edit level 1 a
warp's grid points move one by one; at level 2 a control net shows over the grid as well, and at
level 3 the transform box moves the whole grid. The net divides the warp into Bézier divisions
(2 × 2 by default, at most the grid's cells; set in Tool Details, kept for the session). Its
control points are an anchor at each division corner and two handles on each edge between
anchors; each division is a Coons patch bounded by the cubic Bézier curves of its edges
(`src/bezier.ts`). The net is fitted to the grid each time it is shown, with every control point
on the grid, so nothing about it is saved: the document keeps the grid, and the export is
unchanged. Dragging a control point moves every grid point by the surface of that move, which
bends the grid smoothly and keeps detail made at level 1.

## Brushes and the mesh tools

**The brush.** Brush selection, the deform brush, the add-points brush and stroke meshing share one
brush: a size (radius in screen pixels), an angle, a hardness (the weight is 1 inside that share of
the radius and falls smoothly to 0 at the edge) and a roundness (1 is a circle; the angle turns a
flatter one). **B + drag** sets the size, **C + drag** the angle and **V + drag** the hardness,
while a brush tool is active; Tool Details shows the four values. The cursor shows the brush, with
the hardness as a dashed inner ring. The roundness is Mochi Maker's own: it gives the angle something to turn.

- **Brush selection (B):** painting selects the vertices of the selected mesh under the brush
  (weight at least one half), in mesh editing or wherever its points show; without a selected mesh
  it selects the meshes it touches. A stroke without Shift starts a new selection; Shift adds; Alt
  removes.
- **The deform brush** (toolbar «Deform»; unbound by default): a stroke over the selected mesh, or
  the mesh under the pointer, moves the vertices under the brush with the pointer, each by its
  weight. In Modeling it changes the keyform at the pose (between keys it says so, as dragging
  does); in mesh editing it moves the vertices themselves, in every keyform, with the texture
  following. One undoable step per stroke («Deform brush»). While it is active, a double-click does
  not enter mesh editing.
- **Stroke meshing (beta)** (toolbar «Strokes»): draw strokes over the selected mesh's layer; they
  stay until **Shift+E** (Modeling › Mesh from Strokes, or «Make mesh» in Tool Details) turns them
  into the mesh: strips the brush's width wide along each stroke, through `mesh.fromStrokes`, so
  every keyform carries over. For thin lines such as strands and lashes.

**The mesh tools.** Besides lasso (L)
and rectangle selection (the arrow tool's drag), adding vertices by clicking, deleting, connecting
(Ctrl+R), flipping an edge, and automatic meshing, there are:

- **the add-points brush** (mesh editing): painting inside the mesh adds vertices a brush radius
  apart from each other and from the existing ones, in one step; Ctrl+R connects them;
- **Split Every Triangle into Four** (`mesh.subdivide`): a vertex in the middle of every edge, the
  mesh looking the same in every keyform;
- **mirrored editing** (Mesh Edit › Mirrored Editing, or the check in Tool Details): about a
  vertical axis at a canvas x (default: the canvas origin, the model's center line), shown as a
  dashed line. Moving vertices moves their mirror partners (a vertex at the mirrored place) the
  other way across; adding a vertex adds its mirror too;
- **Reset to the Imported Mesh**: regenerates the mesh from its layer with the defaults the import
  uses (`mesh.regenerate` without options), keeping the keyforms.

Binding glue between two meshes (Ctrl+G) is not available in this build.

**Markers to Events** (the Timeline's menu, or the action of that name): the motion's markers are
added to its events (user data) at their times, named as the markers, in one undoable step
(`motion.markersToEvents`). The export never does this by itself.

**For agents:** `mesh.brushDeform` (the deform brush in a keyform's own space), `mesh.subdivide`,
`mesh.fromStrokes` (strokes in texture space), `mesh.addVertices`, `mesh.regenerate`,
`motion.markersToEvents`, and selection with `window.mochi.select(ref, vertices)`.

## Model templates

Modeling › Model Template:

- **Export Template…** saves the project as a `.mochitemplate` (name, description, author,
  whether physics comes along; the view becomes the thumbnail). It downloads, or on the desktop goes
  into a chosen folder.
- **Apply Template…** puts one on the selected art meshes, or on all of them:
  - **choosing:** load template files or a folder of them; they show as thumbnails with name and
    author, searchable by name, description and author, and stay loaded for the session;
  - **layout:** the template's art (its layer images) is drawn over the target's. Drag on the
    canvas to move it; right-drag to scale it about where the drag began; **T** cycles how
    see-through it is; «Fit» goes back to the template fitted onto the targets;
  - **matching:** every target with its template mesh, found by name, then by position and shape,
    redone as the layout moves; a list per target picks another by hand, or none;
  - **options:** the draw order (the template's or the art's), re-dividing the meshes like the
    template's, masks, culling and blending; **advanced:** merge or add for parameter IDs and
    physics settings that already exist (or no physics), and the template's parts (on by default:
    the targets move into the template's part structure; off keeps the art's tree);
  - **preview:** the template (left) and the result (right) side
    by side, in two Mochi2D views. The result is the apply run on a copy of the document, so the
    project does not change until Apply. «Play on both» plays a template motion on both, retargeted
    by parameter ID (`retargetMotion`); physics and the pose run, the other effects are off;
  - **Apply:** one undoable step («Apply template …»), `modelTemplate.apply` (export.md).

Not built: the layout's bounding-box handles (right-drag scales instead).
Mochi Maker has no label colors.

## The snapshot and guide images

**The snapshot** is a translucent copy of the pose, kept for comparison (one at a time, view
state). Ctrl+5 takes it (View › Take Snapshot): Mochi2D's `screenshot()` of the view, pinned to the
model points under three corners of the canvas, so it follows pan, zoom and rotation and stays put
while parameters move. 5 shows or hides it. It is drawn at 40 % opacity under the overlay.

**Guide images.** Ctrl+Shift+5 saves the snapshot as a guide image: its picture (at most 2048
pixels a side) becomes a layer, and a quad mesh over the place it covers on the canvas shows it,
in a new part marked as a guide image (Inspector › Guide image; the Parts palette says "guide").
Ctrl+Alt+Shift+3 shows or hides the guide parts (view state). The export leaves guide parts out,
with everything in them, unless File › Export › Include Guide Images is on
(`exportSettings.includeGuideImages`, off by default); the editor's own view always shows them.
Agents: `part.update { guide }` and that setting, and through the bridge `snapshot` (take, show,
hide, clear, status, with the PNG on request; read scope) and `snapshot_guide` (edit scope).

## Copy and paste of objects

Ctrl+C copies the selected ArtMeshes and deformers with everything below them (a deformer's
child deformers and the meshes in them), their keyforms, bindings, blend shapes, masks and layers'
images, as a fragment (`clipboard.copy`). It goes to the system clipboard as JSON, so another
project in another tab can paste it, and stays in the tab for when the browser does not let the
page read the clipboard. Ctrl+V pastes it (`clipboard.paste`): into the selected part; into the
selected deformer, in place (the copies at the top are reparented with conversion, so they stay
where they were on the canvas); next to a selected mesh. Copies get new export IDs where theirs
are taken, parameters bind by ID, and whatever could not be bound (a parameter, a deformer, a
mask or a part not in this project) is reported in the status line; an unbound binding is removed,
keeping the forms at the parameter's default. The copies are selected; one paste is one undoable
step. Ctrl+X copies, then deletes the copied objects. In the Timeline with keys selected, the same
keys copy and paste keys.

## Preview modes

Each preview build ends in one of three ways (the Preview palette and
`window.mochi.stats().builds` give the mode, with its timings):

- **patch**: the structure is unchanged (only values changed), so the differences between the shown
  model data and the new lowering (`dataPatches`) go to Mochi2D 0.6.0's `model.patch`, which
  evaluates exactly as a rebuild would. Drags take a shorter path: each frame patches the dragged
  keyform's positions straight into the shown model, without lowering.
- **replace**: the structure changed but the textures and settings files did not, so the new model
  data replaces the old with `model.replace`, keeping the textures and the view.
- **load**: anything else (new textures, other files): the files are loaded again, keeping the
  view.

## Re-import and the live link

**Re-import** picks the changed art file and runs `art.reimport` on it (one undoable transaction,
[`art.md`](art.md#re-importing-changed-art)). The Art palette shows the report.

**Link art** (Chromium, through the File System Access API) keeps a handle on the art file. When
the project already holds layers from the file, linking re-imports it, so the project matches the
file; otherwise it imports it. Then the editor checks the file every half second, and when its
modification time or size changes, it re-imports it:

- the re-import lands in the history as "Re-import <file> (live link)", by the person, and undoes in
  one step;
- the viewport shows the new pixels in under a second (769 ms from save to shown, in the test on
  headless Chromium);
- a check that finds nothing to change leaves the history alone;
- a re-import waits while the person is dragging in the viewport.

Other browsers have no file handles; there the person uses Re-import. In the desktop build (M14,
`docs/desktop.md`) the main process watches the file on disk and tells the page when it
changes, so the check runs only then, with no polling. The art is stored in the project's files as
`import/<name>`, the same path an import from the editor uses, so re-imports match.

## Importing a model (M16)

File › Import Model… opens a `.moc3` model folder as a new project, not yet saved
([`import.md`](import.md)). The first time, a dialog shows the notice with «Got it»; then the folder
dialog opens (in a browser, a folder picker; on the desktop, the system's dialog). After the import,
the Import Report lists what was reconstructed, what the folder did not hold, anything left out,
and whether the model uses glue or blend shapes; Esc closes it, and the next import's report
replaces it if it is still open. The Project palette shows where the project came from: the `.moc3`
version, the date and the files. The texture pages appear as layers.

## Version 6: offscreens and blend modes

The Inspector of an ArtMesh has **Color blend** and **Alpha blend**: Normal, Additive and
Multiplicative work in every version; the other blend modes need version 6, and a note says so. The
Inspector of a part has **Draw offscreen**. When it is on, the part has its own draw order group,
its own blend mode, an **Offscreen mask** with **Invert offscreen mask**, and, among the keyform
values, the offscreen's **Opacity** and **Multiply** and **Screen** colors.

The view shows a version 6 model as version 6 draws it: offscreens composited with their opacity,
tints, blend mode and masks, and meshes with their blend modes. The toolbar's target version has
«moc3 v6», which `auto` chooses for such a model; an earlier version is refused, naming each object
that needs version 6 ([`export.md`](export.md#version-6)).

## The desktop build (M14)

The same editor runs in Mochi Maker's Electron window (`docs/desktop.md`). There, the File menu
works on the disk: native dialogs open and save project folders in place, import art and physics
files, and export into a folder; File › Recent lists the last ten projects. Unsaved work is copied
every minute, and offered for recovery after a crash. Closing with unsaved work asks Save, Don't
Save or Cancel. The bridge runs inside the app, and the window connects to it as the host by
itself. `src/desktop.ts` (`DesktopFiles`) holds this side; the browser build never uses it.
`window.mochiEditor.desktop` is it, or null in a browser.

## `window.mochi`: agents in the editor

`window.mochi` is the agent API's surface (agent API design 2.1), bound to the session the editor
shows. Calls default to the author `agent:window.mochi`; pass `{ author }` to name another.

| Member | What it does |
|---|---|
| `transact(label, (tx) => …, options)` | one transaction with the typed method layer: `tx.<area>.<verb>(args)` and `tx.run(name, args)`. Returns the result and `value`. |
| `run(label, items, options)` | commands and operations, such as `art.import` and `mesh.generate`, given as data |
| `undo(n)`, `redo(n)`, `history()` | history |
| `describe(…)`, `schema(kind)`, `errorCodes()` | self-description |
| `query(q)`, `get(ref)`, `validate()` | reading |
| `diff(from, to?)` | structural diff between revisions this editor session has shown |
| `export()` | the full export with its report (nothing is written) |
| `exportMovie({ motion, … })` | a motion as PNG frames or a WebM or MP4 video (nothing is written) |
| `pose()`, `setPose({ ParamX: v })`, `select(ref, vertices)`, `selection()` | the editor's pose and selection |
| `evaluate()` | Mochi2D's evaluation of the model in the view, in canvas pixels |
| `settled()` | resolves when the preview shows the current revision |
| `screenshot()` | the viewport as a PNG data URL |
| `stats()` | preview build and drag timings |
| `errorJson(e)` | an error in the agent API's shape (`category`, `code`, `message`, `fixes`, …) |

**What the person sees.** An agent's commands land like the person's own. The preview rebuilds, the
history lists them with the agent as author, the Agents palette logs each call, and the indicator in
the toolbar lights while an agent works. The person can undo an agent's transaction like any other.

Outside agents reach the same session through the live bridge ([`bridge.md`](bridge.md)). While
they are connected, a band over the viewport shows who they are and what they run, and lets the
person pause or disconnect them.

## Motion sync

Modeling › **Motion Sync…** edits the project's motion-sync settings: how a sound moves the mouth.
Mochi2D analyses the sound into the weights of audio elements (Silence and the vowels A, I, U, E,
O); each element has a shape, a value for each driven parameter, and the parameters take the shapes
blended by the weights. The dialog (Mochi Maker's own design):

- **settings:** add (it drives the parameters with "mouth" in their ID), remove, rename; the sample
  rate (analysis ticks a second), smoothing (1 intense to 100 smooth), blend ratio (0: the likeliest
  element's shape; 1: the shapes blended by weight) and use case;
- **driven parameters**, with their dead band (damper) and smoothing; «Drive another parameter…»
  adds one, × removes it with its column;
- **elements and their shapes:** a grid of elements × driven parameters, with each element's
  enabled check and scale. A new setting starts ParamMouthOpenY and ParamMouthForm at typical vowel
  shapes, which the dialog calls a starting point. «From pose» fills a row from the
  editor's pose (set the mouth with the sliders, then take it); «Pose» shows a row on the model;
- **preview:** «Play a WAV file…» plays it through Mochi2D's own analysis (`startMotionSync`) on the
  shown model, with a meter of the elements' weights and the level; «Stop» ends it. The preview
  applies each driven parameter's smoothing («smooth %», the file's `Smooth`), so it shows what
  the values in the dialog do, and the dialog says so. Mochi2D leaves that smoothing off by default
  (since 0.20.0; its `fileSmoothing` option turns it on), so an app built on Mochi2D shows only the
  setting's own smoothing and the dampers unless it turns it on. The editor's views all run with it
  on (`EDITOR_RUNTIME` in `noview.ts`): the viewport, the preview and the movie export agree.

Every change is one undoable command (`motionSync.addSetting`, `updateSetting`, `removeSetting`).
The settings are exported as the model's `.motionsync3.json` (export.md) and travel in model
templates (merge or add by name).

**A motion's sound and setting**: the timeline's motion bar has «Sound»: no sound, one
of the project's sounds, or «Import WAV…» (it imports the file and gives it to the motion in one
step); and beside it, how the sound moves the mouth: «Lip sync» or «Motion sync: <setting>». The
second waits until the motion has a sound.

## Physics (M9)

Modeling › Physics… opens the physics dialog, which leaves the canvas usable. Every change is a command; testing is a view setting.

- **Import .physics3.json…** reads a physics file made elsewhere through
  `physics.import` (export.md): groups are added, or replaced when the name is the same; inputs
  and outputs find their parameters by ID, and the dialog lists the ones that found none. One
  undoable step.

- **Groups:** the model's physics settings, in order. «Add group» takes a name, an input preset
  (none, head, body, head and body: standard parameter IDs, used when the model has them) and a
  pendulum preset (one, two or three stages); «Remove» deletes one. A checkbox per group leaves it
  out of the test without changing the document.
- **Inputs:** parameter, how it counts (sideways X, up and down Y, or angle), its share in percent
  and inversion; the position and angle ranges they are normalized to.
- **Pendulum:** the root and its stages: position, length, swing (how readily it swings), reaction
  and settling; stages can be added, removed or replaced by a preset.
- **Outputs:** parameter, the stage that drives it, how it counts, scale, share and inversion, and
  the **observed peak** above and below the default, as a percentage of the range on that side.
  «100 % ↑» and «100 % ↓» rescale the output so its observed peak reaches 100 %.
- **Frame rate** of the simulation (0: one step per frame), exported as the file's `Fps`.
- **Test:** runs Mochi2D's physics in the View area (the physics effect of the shown model, the only
  effect that runs while editing). The pad drives the group's inputs (X and angle inputs
  horizontally, Y inputs vertically) and lets go to their defaults on release, so the pendulum
  settles; moving the input parameters or playing a motion drives it too. Closing the dialog stops
  the test.
- **Warnings:** the dialog lists the group's lint problems: incomplete settings and bad ranges (which
  block the export), outputs that move nothing yet ("key the sway parameters first"), outputs shared
  past 100 %, and outputs that peak past 100 % (marked). Opening it reminds once that physics is
  saved with the model.

## Expressions and pose (M9)

**The Expression palette** (next to Parameter) lists the model's expressions. Every change is an
`expression.*` command, and each expression is exported as an `.exp3.json` file listed in the model
settings and parsed back by the export check.

- **New from pose** records the parameters that are away from their defaults; **Record** replaces
  the selected expression's values the same way. The blend chosen beside them decides the value:
  - **Set** (the file's `Overwrite`) stores the pose value;
  - **Add** stores the difference from the default;
  - **Multiply** stores the factor from the default. Parameters whose default is 0 have no factor,
    so they are left out, with a message.
- **The table** edits each value's parameter, value and blend, and adds or removes values; the
  name and the fade times are fields.
- **Preview** applies the selected expression to the shown model with Mochi2D (`setExpression`),
  fades included, on top of the pose. It stays on while the person edits.

**Pose groups** are a section at the foot of the Parts palette. Parts in a group show one at a
time; rows of grouped parts say "pose N".
- **New group from selection** takes the selected parts; a part already in a group moves to the
  new one.
- **«+ selection»** adds to a group; **×** removes a part or a group.
- **Linked parts** (a multiple choice per part) show and hide with it.
- **Fade** sets the group fade-in time.
- **Preview** turns on Mochi2D's pose. The radio buttons pick the part each group shows, written
  every frame as a motion's part-opacity curves would be; Mochi2D does the fades and the links.

Every change is one `pose.setGroups` command, exported as `<stem>.pose3.json` and parsed back.
Lint warns about a group with fewer than two parts. A part in two groups is an error; the command
refuses it, and lint catches it in files edited by hand. An expression naming a missing parameter
is an error, and a parameter named twice is a warning.

## Motions (M10)

The **Scene** palette picks the motion; the **Timeline** palette edits its keys. Every edit is a
key command (`motion.insertKey`, `motion.moveKeys`, `motion.deleteKeys`, `motion.setKeys`,
`motion.setInterpolation`; see core.md), so it undoes in one step and agents can do the same.

The header has Play, frame steps, the time readout, the mode button (**Dope Sheet** or **Graph
Editor**, the name of the view shown; C switches, Animation › Switch Edit Mode), **◆ Key** (keys
the selected rows, or all, at the playhead), **+ Track…** (a parameter, a part's opacity, or a
model curve: EyeBlink, LipSync, Opacity) and the ⋯ menu. Below it: the motion's length, fps, loop
and fade in/out, and **Key sliders**.

**The Dope Sheet** (the default) shows a row per curve, the keys as marks (diamonds; round for Auto
smooth, square for the steps), the events lane and the playhead.
- Ctrl+click on a row inserts a key there, on the curve; Ctrl+click on a key deletes it. A click
  moves the playhead.
- Click, Shift+click select keys; dragging moves them by whole frames (with Snap keys to frames).
- **Key sliders**: moving a parameter's slider in the Animation workspace keys it at the playhead
  (a quarter second after the slider stops).
- Delete; Ctrl+C, Ctrl+X, Ctrl+V (pasted at the playhead, onto the copied curves); the up and down
  arrows change the selected keys' values by a hundredth of each range.
- **Paste Keyframes to Selected Rows…** (⋯ menu) puts the first copied curve's keys on the
  selected rows (click the row names, Ctrl or Shift to add). The dialog asks what to do when the
  ranges differ: scale by the ranges' ratio, clamp to the target's range, or copy as they are (not
  advised).
- **Adjust Spacing…** stretches or squeezes the selected keys' spacing by a percentage, from the
  earliest one; **Reverse Keyframes** mirrors their values around each parameter's default (0.5
  for part opacities and model curves). The marks stay where they were; the Graph Editor shows it.
- Events: Ctrl+click on the events lane adds one at that time (asking its value); drag to move,
  Delete to remove.
- A selected row shows its own fade in and out (empty: the motion's) and **Remove track**.

**The Graph Editor** draws the selected rows' curves (or all), each row's range scaled to the
height, on a grid of tenths of the length and of the range.
- The buttons set the interpolation of the segment after each selected key: **Linear**, **Auto
  smooth**, **Step**, **Inverse step**, **Bézier**. Turned Bézier, a segment keeps its shape, and
  its handles appear.
- Drag a key (Shift: along one axis); drag in empty space for box selection; the box gets handles
  that scale the selected keys in time (from the box's start) and in value (from its bottom; Alt: from
  its middle). Left and right
  arrows move the selected keys a frame.
- Handles: drag to shape a Bézier segment; with **edit handles as continuous** (⋯ menu, on by
  default) the handle on the key's other side stays in line; Ctrl inverts that for a drag.
- Ctrl+click on empty space inserts a key on the first drawn curve (Alt: at the pointer's value).
- Snapping (⋯ menu): keys to frames, values to the grid, and values to the neighbouring keys'.

**Recording from the viewport**. In the Animation workspace, with a motion picked and
**Record drags** on (the Timeline header), turning a rotation deformer by its handle at edit levels
2 and 3 changes the parameters that turn it, not its forms. The deformer follows the pointer:
Mochi Maker finds the value of one bound parameter that gives the dragged angle (`solveField` in
core: exact, since along one parameter the angle is piecewise linear between its keys; among
several bound parameters, the one that needs the least change in its own range). On release, that
parameter is keyed at the playhead: one key per drag, as for the sliders. Shift snaps the angle to
the rotation step. At edit level 1, or with Record drags off, the drag is the modeling turn as
before. A rotation bound to no parameter records nothing and says so. Mochi Maker has no deform
paths, so there is no second recording handle.

**The Template palette** (Window › Template, docked under the Inspector in the Animation
workspace) holds animation templates, kept in the project (`project.animationTemplates`):
- **New…** takes the parameter keys in a range of time, with their interpolations, under a name.
  The range starts as the span of the keys selected in the Timeline (or the whole motion), and can
  be typed. With rows selected, it can take only those rows.
- **A button per template** inserts it at the playhead. Parameters match by export ID. A template
  that names parameters this model lacks is marked ("1 unmatched"), and clicking it first lists
  them; **Insert the rest** goes on without them. On each matched curve, the keys inside the
  template's span give way to the template's.
- **⋯** per template: Rename, Export (a `.template.json` file), Delete. **Import…** reads one or
  more template files, replacing templates of the same name; **Export all** writes one file. Files
  stand in for a template folder, which a browser cannot offer.

The file is JSON: `{ "format": "mochi-maker-animation-template", "version": 1, "templates": [...] }`,
each template being `{ name, duration, curves: [{ id, keys: [{ time, value, interp, handles? }] }] }`.

**Scrubbing with physics** (Mochi2D 0.10.0's `savePhysicsState` and
`restorePhysicsState`). With the Timeline stopped and its **Physics** switch on (the default), in
the Animation workspace, and a model with physics, moving the playhead shows the pose with physics
as it would be at that time (`src/scrub.ts`):
- a headless copy of the shown export (a `ModelRuntime`, nothing but physics running) bakes the
  motion forward from a fresh physics state at the motion's frame rate, lazily, as far as the
  playhead has gone, and keeps a snapshot every 10 frames;
- for frame F, the shown model restores the nearest snapshot at or before F and steps the frames
  after it (at most 9), with the curves' parameter values and the other parameters' pose values,
  then the view's clock pauses so the pose stays;
- a restored run repeats the original bit for bit, so the result is that of running the motion
  from its start (a test compares the two exactly);
- a document change or a slider move forgets the bake. Playing hands over to Mochi2D's own
  playback; stopping goes back to scrubbing. Leaving the Animation workspace or switching Physics
  off stops it.

On the synthetic project at the design target's size (720 meshes, 300 warps, 509 parameters) with
24 three-particle pendulums and 50 keyed parameters, in Node: baking costs 0.7 ms a frame, and a
scrub to any of 300 frames takes 2.8 ms (median) and 11.5 ms at most (`scrub.test.ts` with
`MOCHI_MAKER_BENCH=1`).

**Playback.** Stopped, the playhead poses the model from the curves: parameter curves set the view's
pose, part-opacity curves are written every frame as part opacities. Play exports the motion
(`planFiles` names its file) and starts it in Mochi2D (`startMotionFile`), with the effects that
are on, so fades, events, model curves and pose groups behave as they will in an app. Meanwhile the
Parameter palette shows each parameter's base value from Mochi2D (`getParameterBase`), before
physics and the other effects. With a work area, Play loops the work area (below).

### The work area and markers

- **The work area** is the part of the motion that playback loops and exports render. Shift+Home
  sets its start at the playhead, Shift+End its end (each keeps the other end, or the motion's
  start or end). The Timeline's menu also clears it. It shows as a band on the Dope Sheet's top
  «Markers» lane and in the Graph Editor.
- **Shift+F** fits the work area across the Dope Sheet and the Graph Editor; again, or without a
  work area, the whole motion.
- **Markers** label times: Ctrl+click on the «Markers» lane adds one (it asks for a name), a drag
  moves it, a double-click renames it, a right-click deletes it; «Add marker at the playhead…» is in
  the menu. **Ctrl+J** and **Ctrl+K** go to the previous and next marker (in the Timeline; Ctrl+K
  is the command bar elsewhere).
- Both are saved with the motion (`workArea`, `markers`; project format 10) and are not exported.
  Agents set them with `motion.update { workArea }` and `motion.setMarkers`.
- **Playing a work area.** Mochi2D cannot start a motion partway, so Play hands it a copy of the
  motion clipped to the work area (`clipMotion`: each curve sampled at every frame and joined with
  linear segments, so it shows the same values frame by frame) and loops it. The playhead runs from
  the work area's start; physics starts fresh at each start of the loop.

## Exporting images and video

File › Export › **Image Sequence…** (Ctrl+I) and **Video…** (Ctrl+Shift+M) render a motion:

- **Settings:** the motion, the size (default: the canvas, at most 1280 pixels on its longer
  side), the frame rate (default: the motion's), the background (transparent, or a color), and the
  range (the whole scene or the work area). A progress bar shows each frame; Cancel stops.
- **Physics as in playback, from the scene's start:** an off-screen view starts the motion at
  frame 0 with physics and the pose on (the other effects off) and steps one frame at a time, so
  the frames of a work area are the same as in an export of the whole scene (a test compares them
  byte for byte). Frame f is at f / fps seconds; a looping motion leaves out its last instant,
  which is its first again.
- **Image sequence:** PNG frames with transparency, named `<motion>_<frame>.png`. In a browser
  they download as a zip; on the desktop they go into a folder chosen in a dialog.
- **WebM:** VP9 (VP8 if not), through the platform's WebCodecs encoder. With a transparent
  background the video keeps alpha: the encoders available here cannot, so Mochi Maker encodes the
  alpha as a second, grey VP9 stream and writes it into each block's BlockAdditions with `AlphaMode`
  on the track, as WebM defines it (`webm.ts`, our own writer). Chromium plays it back with
  transparency (tested).
- **MP4:** H.264 where the platform has an encoder (Chromium here does), muxed with mp4-muxer
  (MIT). The encoder is the person's browser or system encoder: Mochi Maker ships none. MP4 has no
  alpha, so it needs a background.
- Video sizes are rounded up to even numbers.
- **Agents:** `window.mochi.exportMovie({ motion, format, width, height, fps, background, range })`,
  the bridge tool `export_movie` (export scope, files as base64), and MCP's `mochi_export_movie`
  (bridge mode; it writes the files into an allowed folder).

## Find and Replace

Edit › **Find and Replace…** (Ctrl+F) searches the export IDs and names of parameters, parts,
deformers and art meshes:

- plain text, or a pattern (a JavaScript regular expression; `$1` in the replacement inserts a
  group), with Ignore case;
- IDs, names or both, and any of the four groups;
- the preview lists every change as you type; a row selects its object. Problems in the result (an
  invalid export ID, or one that another object would also have) are marked, and Replace All waits
  until there are none. The whole result is checked, so two IDs can swap;
- Replace All is one undoable step, `objects.replaceText`, which agents run too.

Every reference follows, because other objects refer to these by UID: bindings, masks, physics,
the pose, expressions, motion curves, hit areas and the standard groups keep pointing at the same
objects, and the exported `.moc3`, physics, pose, expression, motion and display-info files carry
the new IDs and names (`export/test/replace.test.ts`). The Parts palette's filter moved to Edit ›
Filter the Parts Palette.

## The PSD of the pose (beta)

File › Export › **PSD of the Pose** (Ctrl+P) writes the model at the pose the editor shows as a
Photoshop file the size of the canvas:

- one layer per art mesh as drawn (its deformation, opacity, colors and clipping), back to front in
  draw order, named by the mesh's name and cropped to its pixels; a mesh not drawn at the pose is
  an empty layer;
- the whole image as the composite.

Each layer is rendered off-screen with the other meshes tinted to opacity 0; they still mask, so
clipping is kept. Stacking the layers in order gives the composite again (`psd.test.ts`, on golden 4
with an inverted mask). Written with ag-psd. In a browser it downloads; on the desktop it goes into
a chosen folder.

## Keyboard shortcuts

Every editor action has an ID, a category (Menus, Tools, View area, Palettes) and default keys, and
every one can be rebound in File › Keyboard Shortcuts (Ctrl+Alt+Shift+K):

- search by command name or by key, several words narrowing the search;
- several keys per command; a key used twice in the same context is marked (a key may serve
  mesh editing or the Timeline and something else elsewhere, such as Esc);
- export and import as a JSON file (`mochi-maker-shortcuts`, the same on every platform);
  «Restore» goes back to the state when the dialog opened, «Reset to defaults» to the defaults.

Only the person's changes are stored (browser storage), so new default keys of a later version
take effect without a reset. Keys are physical: letters are their key positions, the digits above
the letters are `1`…`9`, and keypad keys are `Numpad1`…, a different key. On macOS, Ctrl in a
shortcut means ⌘ Command, and the dialog says so; a setting makes it Control instead.

| Keys | Action |
|---|---|
| Ctrl+N; Ctrl+Shift+N | New model (Home); a new Animation View |
| Ctrl+O; Ctrl+Shift+O | Open a `.mochi.zip`; Home with the recent names |
| Ctrl+S; Ctrl+Shift+S | Save (a `.mochi.zip` download); Save As |
| Ctrl+W; Ctrl+PageUp / Ctrl+PageDown | Close the view tab; previous / next tab |
| Ctrl+Z; Ctrl+Y or Ctrl+Shift+Z | Undo; redo |
| Delete or Backspace; Ctrl+Delete | Delete the selection (or the selected vertices in mesh editing); a deformer with its contents |
| Ctrl+A; Esc | Select all (vertices in mesh editing; locked and hidden objects left out); close the open dialog, else deselect, or cancel mesh editing |
| Ctrl+F | Find and Replace |
| Ctrl+I; Ctrl+Shift+M; Ctrl+P | Export an image sequence; a video; the PSD of the pose (beta) |
| Ctrl+K | The command bar (Mochi Maker's own) |
| 1, 2, 3 | Edit level 1, 2, 3 |
| A, L, B | Arrow, lasso, brush selection |
| B / C / V + drag | The brush's size / angle / hardness (brush tools) |
| Shift+E | Mesh from the strokes drawn (stroke meshing, beta) |
| S; T; F | Show the selection solo; source image or atlas; center on the selection |
| R; Space; Ctrl+Space | Flip (tap) or rotate (hold and drag); pan; zoom (hold and drag) |
| Ctrl+0 | Fit the whole canvas |
| Ctrl+E; Ctrl+R | Enter or leave mesh editing; connect vertices (mesh editing) |
| Ctrl+Shift+A | Automatic mesh |
| Ctrl+T | Texture atlas |
| Ctrl+1; Ctrl+Shift+1 | Reset parameters; Lock Default Forms |
| Ctrl+2; Ctrl+Shift+2; Ctrl+Alt+2 | Lock or unlock the selection; lock everything else; unlock everything |
| Ctrl+3; Ctrl+Shift+3; Ctrl+Alt+3 | Show or hide the selection; hide everything else; show everything |
| Ctrl+D; Ctrl+Alt+D; Ctrl+Shift+D | Select the parent deformer; select the children; highlight the children |
| Ctrl+Shift+C; Ctrl+Shift+V | Copy; paste a shape |
| Shift+A; Shift+D | Lock drawable objects; lock deformers on the canvas |
| Ctrl+Alt+S; Ctrl+Alt+Shift+S | Export the `.moc3` set; export the motion files (as zips) |
| Ctrl+Alt+Shift+K | Keyboard Shortcuts |
| Enter; Page Up / Page Down; Home / End; J / K | Timeline: play or stop; previous / next frame; start / end; previous / next keyframe |
| Shift+Home / Shift+End; Shift+F; Ctrl+J / Ctrl+K | Timeline: work area start / end at the playhead; fit the work area; previous / next marker |
| C | Animation › Switch Edit Mode: Dope Sheet ↔ Graph Editor |
| P; Enter / Esc while drawing | The deform path; finish or cancel the path being drawn |
| Ctrl+4 | Generate the four-corner forms |
| Ctrl+X, Ctrl+C, Ctrl+V | Cut, copy, paste objects (in the Timeline with keys selected: keys) |
| Ctrl+5 / 5 / Ctrl+Shift+5 | Take the snapshot / show or hide it / save it as a guide image |
| Ctrl+Alt+Shift+3 | Show or hide the guide-image parts |
| Delete; Ctrl+C / Ctrl+X / Ctrl+V; ↑ / ↓; ← / → | Timeline keys: delete; copy / cut / paste; value up / down; a frame earlier / later (Graph Editor) |
| Arrow keys (Shift: 10 px) | Nudge the selected vertices |

Unbound by default: Open Project Folder, Import Art, Re-import, Link Art, Environment Settings,
Create Warp and Rotation Deformer, the drag-to-create rotation tool, the add-vertices tool, Flip
Edge, the palettes, the workspace commands, Check Children Outside Parent Warps, Import Physics,
Filter the Parts Palette, Clear Work Area, Add Marker at the Playhead, the Deform Brush, the
Add-Points Brush, Stroke Meshing, Split Every Triangle into Four, Mirrored Editing, Reset to the
Imported Mesh, and Markers to Events.

**Not built yet** (no command to bind): glue (Ctrl+G) and blending shapes (Ctrl+Shift+B), not
available in this build, and the 3D views (E, W), left for now.

## Warnings at the point of action

Gentle tips (once per session; Environment Settings can turn them off) and warnings about the data
(every time). Warnings show in the status line, over the canvas; tips show at the top of Tool
Details until closed with ×, so that they never cover the canvas. Both go to the Log
palette:

| Where | What it says |
|---|---|
| A deformer dragged without Ctrl, with contents | Its contents moved along; Ctrl moves only the deformer (tip) |
| An edit at the default form of a keyed object | It changed the rest pose; Lock Default Forms protects it (tip). With the lock on, the edit is refused. |
| A binding with one key (Inspector) | The same shape at every value: add a key at the other end |
| "Add a key here" at an untidy value | Double-click the parameter's name to type exact keys |
| A box rotation of more than 30° | In-between shapes are straight-line blends and shrink midway: a rotation deformer turns without shrinking |
| A child outside its parent warp, after the person's change (and Modeling › Check Children Outside Parent Warps, which also highlights them) | A warp bends only what lies inside it: a parent must not be smaller than its child |
| The transform box over a warp's center | Tool Details and Show › Hide the Transform Box |
| Automatic mesh on ArtMeshes with keyforms | Shapes may change between the old vertices (in the dialog, before applying) |
| Stray faint pixels | The dialog's transparency threshold explains when to raise it |
| Rows hidden by the Parts or Deformer palette's filters | "N rows hidden by the filters" |
| Moving rows to another part | The row order does not decide what is in front; the draw order does (tip) |
| Delete in a palette or on the canvas | It did not ask; Ctrl+Z brings it back (tip). The palette's Delete button asks first. |
| Stray drags in the Parts and Deformer palettes | «Lock list» stops rows from being dragged |
| "@" in a parameter ID (the New Parameter dialog, renaming) | It can block motion export in other tools |
| Leaving the page with unsaved changes | The browser asks first (on the desktop: Save, Don't Save or Cancel) |
| Atlas pages | Always square (Texture Atlas dialog) |
| Shortcuts after an update | New defaults appear by themselves; the dialog says the keypad digits are separate keys |
| Learning | Edit level 2 is the place to start (tip on the first switch to 1 or 3) |

## Choices where conventions differ

Each is a setting (File › Environment Settings) or a layout the person can change.

| Item | Our choice |
|---|---|
| 1. Default palette positions | Modeling: Parts and Deformer at the upper left, Parameter below them; Inspector and Tool Details on the right; Log, History, Validation, Agents, Art, Preview, Draw Order and Project below the View area. Animation: Scene and Parts, then Parameter on the left; Inspector on the right; Timeline, and Log, History and Agents below. Any layout can be changed, kept, reset. |
| 2. Palettes per workspace | As above: Modeling shows no Timeline or Scene; Animation shows no Deformer, Tool Details or Validation (Window menu brings them). |
| 3. View controls | Status line at the lower left; magnification, full scale, fit and flip at the lower right; the lock and display toggles in the «Show» menu. |
| 4. Template palette; animation edit modes (C) | The Dope Sheet and Graph Editor, the Template palette. |
| 5. Ctrl means Command on macOS | For every shortcut (setting: Command or Control). |
| 6. Scale or rotate at the box's corners | Within 8 px of a corner scales; up to 2.5 times that outside the box rotates (setting: the reach). |
| 7. The Ctrl+right-click list | The ArtMeshes under the pointer, topmost first (setting: under the pointer, or all). |
| 8. «Show» or «Display»; «Export For Runtime» or «Export Embedded File» | «Show» and «Export For Runtime» (settings for both). |
| 9. Pitfalls beyond the usual ones | None added. |

Other settings: Home at startup and closing it when a file opens, switching workspace with the
view tab, double-click to enter mesh editing, the parent deformers in right-click menus, locking
the Inspector with an object, the Shift rotation step (45°), and the tips.

## Tests

`packages/editor/test/` builds the editor with Vite and drives it in headless Chromium through
Playwright. `editor.test.ts` checks:

- every golden project opens, and the view's evaluation matches the agent API's evaluation of the
  export in Node: visibility, opacity and every vertex;
- the overlay transform before and after zooming and panning, and that an edit keeps the view;
- clicking selects a mesh; dragging a vertex moves that keyform's positions by the dragged canvas
  offset, the preview shows the vertex under the pointer, and undo and redo work from the keyboard;
- keyform edits are refused between keys, the inspector edits the keyform at a key, and "Add a key
  here" works;
- adding a vertex at the clicked point in mesh editing, deleting it, connecting, and confirming;
- canvas-space drags through four levels of deformers, and Create Warp Deformer keeping the mesh
  in place;
- the command bar, with results and with errors in the agent API's shape;
- an agent's transaction through `window.mochi`: the person sees its history entry, its parameter
  and the indicator; the agent poses the editor and reads the evaluation; the person undoes it;
- validation, the export check, and File › Save: the saved zip opens again to the same document.

`layout.test.ts` checks the frame and Home; docking as a tab, between groups, floating,
moving a whole group, closing and showing palettes, hiding all, persistence over a reload and the
reset; workspaces with the view tabs, per-tab poses, and custom workspaces; Timeline playback;
rebinding, duplicates, export and import, the keypad, and Command on macOS; flip, rotate,
axis-locked panning, fit, full scale and the magnification field; selection with Shift, Ctrl+A,
locks and hiding; the transform box at levels 2 and 3 and the rotation handle; Ctrl-drags that leave
the contents in place; the warnings (default forms, one key, "@", children outside a warp); mesh
editing with Esc; the draw-order strip and the drag-to-create rotation deformer.
`timeline.test.ts` checks the Dope Sheet (Ctrl+click insert, Delete, dragging by frames,
copy, cut, paste, undo, the arrow keys), keys from a slider and the Key sliders switch, Paste
Keyframes to Selected Rows, Adjust Spacing, Reverse Keyframes, part-opacity and model tracks, events
and fades, C and the header button, the interpolation buttons, and playback with the base values.
`snapshot.test.ts` and `clipboard.test.ts` check the snapshot (pinned while parameters
move, following zoom, 5), saving it as a guide part, Ctrl+Alt+Shift+3, the export with and without
guide images, and copy, paste into a rotation in place, cut, undo, and a paste into another
project through the system clipboard.
`scrub.test.ts` (Node) and `scrubview.test.ts` check scrubbing: any frame, reached in
any order, equals a straight run bit for bit, with fewer than 10 steps; in the editor the pendulum
of golden 11 shows the same value whichever way the playhead got there, and the Physics switch and
leaving the workspace turn it off. `warps.test.ts` also checks Ctrl+4 on golden 16.
`paths.test.ts` and `deformpath.test.ts` check the deform path: binding and skinning
(nothing moves while the path stays, or beyond reach; points on the path go with it; a turned
segment turns the points beside it), drawing with P and Enter, a drag that moves one corner and
leaves the far ones, undo, levels, Esc, and recording a parameter key from a path drag.
`warps.test.ts` and `bezier.test.ts` check the Bézier layer: the fitted net reproduces
a grid, drag weights (the corner fully, its edges by half, the centre by a quarter), the level 2
drag in the viewport, single points at level 1, and undo. `templates.test.ts` checks recording (a turn of a rotation deformer keys its parameter
at the playhead, one key per drag, its forms untouched; with Record drags off it is the modeling
turn), and the Template palette (New from selected keys, a taken name refused, insertion at the
playhead, the unmatched list, rename, delete, export, import, and a wrong file refused). `bridge.test.ts`
and `reimport.test.ts` cover the live bridge and re-import in the new layout.

`MOCHI_MAKER_BENCH=1` adds a benchmark of rebuilds and drags. It runs on golden 1 and on the
synthetic project in `packages/export/test/synthetic.ts`, which is at the design target's size and
is generated, never committed. The tests are skipped where Chromium is missing, except in CI's render
job.

## Without WebGL2

Mochi2D's view needs WebGL2. Where the browser or machine has none (a GPU-less virtual machine, a
locked-down browser), the editor starts with a stand-in view that draws nothing (`noview.ts`), and
the View area says why. Everything that needs no pixels works: opening, editing, the palettes,
saving and exporting (the export's load check runs Mochi2D without WebGL). Screenshots, image and
video export, and previews fail with that reason. `noview.test.ts` runs the editor in Chromium with
WebGL turned off.

## Standard parameters

**New Parameter** (the Parameter palette's New…) has a **Standard** list: the 40 standard
parameter IDs of models made with Live2D Cubism, in their usual groups (Head, Eyes, Eyeballs,
Brows, Mouth and cheeks, Body, Arms and hands, Hair), the optional ones marked, and those the model
already has disabled («in use»).

- **Picking one** fills in its ID, name, minimum, default and maximum, and shows its meaning.
- **The note:** Mochi Maker offers the usual IDs and ranges so that a model works with apps'
  automatic setup, such as VTube Studio's Auto-Setup. The usual variant ranges stay quiet: ±45 for
  `ParamAngleX`; ±10, ±50 or ±100 for the arms; eye and mouth openness extended past 0 to 1 in
  steps of 0.1 (a maximum up to 2, a minimum down to −1); the eyeball size's half ranges. The note
  turns into a warning for any other range, or when the ID of a picked standard parameter is
  changed. `standardRange(id, min, default, max)` in `@mochi-maker/core` gives the verdict
  (standard, variant or other), and each parameter's `variants` describes them for agents.
- **Groups:** for `ParamEyeLOpen` and `ParamEyeROpen` the dialog offers «Add to the Eye blink
  group», and for `ParamMouthOpenY` «Add to the Lip sync group», checked. Creating adds the
  parameter to the group in the same undoable step.
- **Custom IDs** stay possible. An ID that differs from a standard one only by letter case
  (`ParamAnglex`) is warned about, in the dialog and in the status line on Create.

**New Parameter Group…** (the Parameter palette's ⋯ menu) offers the 20 standard group IDs
(`ParamGroupFace`, …, `ParamGroupOverall`), or a custom one.

The list is `STANDARD_PARAMETERS` and `STANDARD_PARAMETER_GROUPS` in `@mochi-maker/core`
(`standard.ts`); agents read it from the API or the MCP resources (agent-api.md).

