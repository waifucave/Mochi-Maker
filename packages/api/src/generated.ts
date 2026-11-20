// Generated from the command registry by packages/api/src/codegen.ts. Do not edit:
// run `UPDATE_GENERATED=1 npx vitest run packages/api/test/generated.test.ts` instead.
import type { ArgsOf, ResultOf } from '@mochi-maker/core';

/** One typed method per command, grouped by area. */
export interface CommandMethods {
  blendShape: {
    /**
     * Add a blend shape to a mesh, warp, rotation, part or glue.
     *
     * Adds a blend shape over a blend-shape parameter, with an all-zero delta at every key, so nothing
     * changes until a key is edited (blendShape.set). `keys` default to all of the parameter's keys;
     * `base` (the key with no effect) defaults to the key nearest the parameter's default. Blend shapes
     * apply in list order; `index` places this one (default: last). Version 4 files carry only position
     * and grid deltas on meshes and warps; anything else needs version 5.
     *
     * Command `blendShape.add`.
     * Errors: E_WRONG_KIND, E_RANGE, E_ALREADY_BOUND, E_KEY_NOT_ON_PARAMETER.
     */
    add(args: ArgsOf<'blendShape.add'>): ResultOf<'blendShape.add'>;
    /**
     * Remove a blend shape from its target.
     *
     * The target keeps its normal keyforms.
     *
     * Command `blendShape.remove`.
     * Errors: E_NOT_BOUND.
     */
    remove(args: ArgsOf<'blendShape.remove'>): ResultOf<'blendShape.remove'>;
    /**
     * Move a blend shape within its target’s list.
     *
     * Blend shapes add their contributions in list order (float32 sums, §1c.4).
     *
     * Command `blendShape.reorder`.
     * Errors: E_NOT_BOUND.
     */
    reorder(args: ArgsOf<'blendShape.reorder'>): ResultOf<'blendShape.reorder'>;
    /**
     * Set the delta of a blend shape at one key.
     *
     * Sets fields of the delta at `key`: what the blend shape adds when its parameter is at that key
     * (with weight 1). The base key's delta is always zero and cannot be set.
     *
     * Fields by kind (all are offsets):
     * - artMesh: positions (one offset per vertex, in the mesh's own space), opacity, drawOrder, multiply,
     *   screen
     * - warp: grid (one offset per grid point, row-major), opacity, multiply, screen
     * - rotation: angle (degrees), originX, originY, scale, opacity, multiply, screen
     * - part: drawOrder
     * - glue: intensity (a glue that is a blend-shape target has its intensity clamped to 0…1)
     *
     * Values are rounded to float32.
     *
     * Command `blendShape.set`.
     * Errors: E_NOT_BOUND, E_BAD_CELL, E_RANGE, E_FIELD_NOT_APPLICABLE, E_SHAPE.
     */
    set(args: ArgsOf<'blendShape.set'>): ResultOf<'blendShape.set'>;
    /**
     * Set the weight curves that limit a blend shape.
     *
     * Each constraint is a piecewise-linear weight curve over another parameter: points
     * (parameter value, weight), values ascending, constant beyond the first and last point. The blend
     * shape's weight is min(1, every constraint) (§1c.4), or 1 without any: weights above
     * 1 are refused, and negative weights (allowed, with a lint warning) reverse the blend shape. A
     * constraint may use any parameter, even the blend shape's own. An empty list removes every
     * constraint.
     *
     * Command `blendShape.setConstraints`.
     * Errors: E_NOT_BOUND, E_RANGE.
     */
    setConstraints(args: ArgsOf<'blendShape.setConstraints'>): ResultOf<'blendShape.setConstraints'>;
    /**
     * Change a blend shape’s keys or its base key.
     *
     * Keeps the deltas at keys that stay, gives new keys an all-zero delta and drops removed keys.
     * `base` defaults to the current base when it stays, else the key nearest the parameter's default.
     * Changing the base key does not change the other deltas, which stay offsets from the normal result.
     *
     * Command `blendShape.setKeys`.
     * Errors: E_NOT_BOUND, E_KEY_NOT_ON_PARAMETER, E_RANGE.
     */
    setKeys(args: ArgsOf<'blendShape.setKeys'>): ResultOf<'blendShape.setKeys'>;
  };
  deformPath: {
    /**
     * Save a deform path: an editor-side helper over art meshes and warps (never exported).
     *
     * Paths belong to edit level 2 or 3. Dragging a path's points in the editor drags the points
     * of its targets within `reach` (canvas pixels) along; only the resulting keyform values are
     * exported. Returns the path's id.
     *
     * Command `deformPath.create`.
     * Errors: E_NOT_FOUND, E_WRONG_KIND.
     */
    create(args: ArgsOf<'deformPath.create'>): ResultOf<'deformPath.create'>;
    /**
     * Delete a deform path (the keyforms it shaped stay).
     *
     * Only the helper goes.
     *
     * Command `deformPath.delete`.
     * Errors: E_NOT_FOUND.
     */
    delete(args: ArgsOf<'deformPath.delete'>): ResultOf<'deformPath.delete'>;
    /**
     * Move a deform path’s points, or change its reach.
     *
     * The points replace the old ones (the same number or not).
     *
     * Command `deformPath.update`.
     * Errors: E_NOT_FOUND.
     */
    update(args: ArgsOf<'deformPath.update'>): ResultOf<'deformPath.update'>;
  };
  deformer: {
    /**
     * Create a rotation deformer at an origin.
     *
     * `origin` is in the parent's space (canvas pixels at the top level). Children of a rotation are
     * stored in canvas pixels relative to the origin, and its scale 1 means natural size.
     *
     * Command `deformer.createRotation`.
     * Errors: E_DUPLICATE_ID.
     */
    createRotation(args: ArgsOf<'deformer.createRotation'>): ResultOf<'deformer.createRotation'>;
    /**
     * Create a warp deformer with a regular grid over a rectangle.
     *
     * Creates a warp with `rows` × `cols` cells. Its rest grid spans `rect`, given in the parent's
     * space: canvas pixels at the top level, (u, v) inside a warp (default: the whole 0–1 square), or
     * pixels around the origin inside a rotation (rect required). Children of a warp use normalized
     * (u, v) coordinates. `cellMode` 'bilinear' or 'triangles' (default 'bilinear').
     *
     * Command `deformer.createWarp`.
     * Errors: E_RANGE, E_DUPLICATE_ID.
     */
    createWarp(args: ArgsOf<'deformer.createWarp'>): ResultOf<'deformer.createWarp'>;
    /**
     * Delete a deformer. With cascade, its children move to its parent.
     *
     * Without `cascade`, the deformer must have no child deformers or meshes. With `cascade`, children
     * are attached to the deleted deformer's parent, keeping their stored values (so they move on screen).
     *
     * Command `deformer.delete`.
     * Errors: E_IN_USE.
     */
    delete(args: ArgsOf<'deformer.delete'>): ResultOf<'deformer.delete'>;
    /**
     * Attach a deformer to another deformer (or none), with its values as given.
     *
     * Changes the parent deformer. Without `converted`, stored values are kept, so the deformer and its
     * children move on screen. `converted` gives the keyform values (and blend-shape deltas) in the new
     * parent's space: a warp's `grid`, a rotation's `originX`, `originY`, `angle` and `scale`. The
     * deformer.reparent operation computes them so the deformer stays in place, and records this command.
     *
     * Command `deformer.setParent`.
     * Errors: E_CYCLE, E_SHAPE, E_FIELD_NOT_APPLICABLE.
     */
    setParent(args: ArgsOf<'deformer.setParent'>): ResultOf<'deformer.setParent'>;
    /**
     * Change a deformer’s enabled flag, owning part, cell mode (warp) or base angle (rotation).
     *
     * A disabled deformer hides everything it moves. A deformer is also inactive when its owning part is.
     *
     * Command `deformer.update`.
     * Errors: E_FIELD_NOT_APPLICABLE.
     */
    update(args: ArgsOf<'deformer.update'>): ResultOf<'deformer.update'>;
  };
  expression: {
    /**
     * Create an expression: parameter offsets, factors or overrides with fades.
     *
     * `blend` per entry: 'Add' (default) adds the value, 'Multiply' multiplies, 'Overwrite' replaces.
     * The name is used in the model settings and as the file stem.
     *
     * Command `expression.create`.
     * Errors: none.
     */
    create(args: ArgsOf<'expression.create'>): ResultOf<'expression.create'>;
    /**
     * Delete an expression.
     *
     * Removes the expression.
     *
     * Command `expression.delete`.
     * Errors: none.
     */
    delete(args: ArgsOf<'expression.delete'>): ResultOf<'expression.delete'>;
    /**
     * Change an expression’s name, fades or entries.
     *
     * Entries, when given, replace the whole list.
     *
     * Command `expression.update`.
     * Errors: none.
     */
    update(args: ArgsOf<'expression.update'>): ResultOf<'expression.update'>;
  };
  glue: {
    /**
     * Glue vertices of two meshes together.
     *
     * Each pair pulls vertex a of mesh A and vertex b of mesh B toward each other after deformation,
     * by weight × intensity. Weights 0.5/0.5 at intensity 1 join them at the midpoint. Glues apply in
     * the project's glue order. Intensity is keyformable (default 1).
     *
     * Command `glue.create`.
     * Errors: E_RANGE, E_SHAPE.
     */
    create(args: ArgsOf<'glue.create'>): ResultOf<'glue.create'>;
    /**
     * Delete a glue.
     *
     * Removes the glue and its keyforms.
     *
     * Command `glue.delete`.
     * Errors: none.
     */
    delete(args: ArgsOf<'glue.delete'>): ResultOf<'glue.delete'>;
    /**
     * Move a glue in the glue order.
     *
     * Later glues see the results of earlier ones, so order matters when glues share vertices.
     *
     * Command `glue.reorder`.
     * Errors: none.
     */
    reorder(args: ArgsOf<'glue.reorder'>): ResultOf<'glue.reorder'>;
    /**
     * Replace a glue’s vertex pairs.
     *
     * Pairs are [vertex of A, weight of A, vertex of B, weight of B].
     *
     * Command `glue.setPairs`.
     * Errors: E_SHAPE.
     */
    setPairs(args: ArgsOf<'glue.setPairs'>): ResultOf<'glue.setPairs'>;
  };
  keyform: {
    /**
     * Copy one keyform cell’s values to another cell of the same object.
     *
     * The destination becomes authored. Both cells are given as {parameter: key}.
     *
     * Command `keyform.copy`.
     * Errors: E_BAD_CELL.
     */
    copy(args: ArgsOf<'keyform.copy'>): ResultOf<'keyform.copy'>;
    /**
     * Generate the four-corner forms: the diagonal cells of two parameters from their edges.
     *
     * For objects bound to two parameters (say Angle X and Angle Y), each cell away from both
     * parameters' defaults gets the rest form plus what each edge adds: K(x, y) = K(x, rest) + K(rest, y)
     * − K(rest, rest), field by field (positions, grid points, angle, origin, scale, opacity clamped to
     * 0…1, colors, draw order). The edges are the cells where one of the two is at its default, which
     * must be one of its keys. With more bindings, it runs for every key of the others. `parameters`
     * names the two; without it, each object must have exactly two bindings. Objects without both
     * are skipped and counted.
     *
     * Command `keyform.fillCorners`.
     * Errors: E_NOT_BOUND, E_RANGE.
     */
    fillCorners(args: ArgsOf<'keyform.fillCorners'>): ResultOf<'keyform.fillCorners'>;
    /**
     * Set values of one keyform cell (or of every cell).
     *
     * Sets fields of the keyform at `cell` ({parameter: key} for every bound parameter; omit when the
     * object has no bindings), or of every keyform with `all: true`. The cell becomes authored.
     *
     * Fields by kind:
     * - mesh: positions ([x, y] per vertex, in the parent deformer space), opacity, drawOrder, multiply, screen
     * - warp: grid ([x, y] per grid point, row-major), opacity, multiply, screen
     * - rotation: angle (degrees), originX, originY, scale, mirrorX, mirrorY, opacity, multiply, screen
     * - part: drawOrder
     * - glue: intensity
     *
     * Values are rounded to float32. Editing in canvas space comes with the deformer milestone.
     *
     * Command `keyform.set`.
     * Errors: E_BAD_CELL, E_FIELD_NOT_APPLICABLE, E_SHAPE.
     */
    set(args: ArgsOf<'keyform.set'>): ResultOf<'keyform.set'>;
  };
  layer: {
    /**
     * Register an image layer (an asset placed on the canvas).
     *
     * `asset` is the SHA-256 (hex) of a PNG already stored in the session's asset store. `x`, `y`
     * place the image's top-left pixel on the canvas. Import commands create layers for you.
     *
     * Command `layer.create`.
     * Errors: none.
     */
    create(args: ArgsOf<'layer.create'>): ResultOf<'layer.create'>;
    /**
     * Delete a layer. With cascade, meshes that use it keep their geometry but lose the layer.
     *
     * The asset itself stays in the store until the project is saved without references to it.
     *
     * Command `layer.delete`.
     * Errors: E_IN_USE.
     */
    delete(args: ArgsOf<'layer.delete'>): ResultOf<'layer.delete'>;
    /**
     * Replace a layer’s pixels (a new asset and bounds), keeping its meshes in place.
     *
     * Points the layer at another asset with its canvas position and size, as a re-import does
     * (art.reimport). Meshes that use the layer keep their positions; unless `remapUvs` is false, their
     * texture coordinates move by the change of the layer's top-left corner, so each vertex keeps showing
     * the same canvas pixel. The other fields update the layer's recorded source properties.
     *
     * Command `layer.setImage`.
     * Errors: none.
     */
    setImage(args: ArgsOf<'layer.setImage'>): ResultOf<'layer.setImage'>;
    /**
     * Change a layer’s name, position or visibility.
     *
     * Moving a layer does not move meshes that use it.
     *
     * Command `layer.update`.
     * Errors: none.
     */
    update(args: ArgsOf<'layer.update'>): ResultOf<'layer.update'>;
  };
  mesh: {
    /**
     * Add vertices inside a mesh, splitting the triangles they fall in.
     *
     * Each point (layer pixels, texture space) must lie inside the mesh. A point inside a triangle splits
     * it into three; a point on an edge splits the triangles of that edge. In every keyform the new
     * vertex is placed by its barycentric weights, so the mesh looks the same. Existing vertex indices do
     * not change; the new vertices are appended.
     *
     * Command `mesh.addVertices`.
     * Errors: E_TOPOLOGY, E_SHAPE.
     */
    addVertices(args: ArgsOf<'mesh.addVertices'>): ResultOf<'mesh.addVertices'>;
    /**
     * Move the vertices under a brush in one keyform, weighted by its falloff.
     *
     * The deform brush for agents. Every vertex of the keyform at `cell` (omit it when the
     * mesh has no bindings) within the brush moves by `offset` times its brush weight: 1 inside
     * `hardness` of the radius, falling smoothly to 0 at the edge. `center`, `radius` and `offset`
     * are in the keyform's own space, the space of its positions (the parent deformer's; canvas pixels
     * without one). `roundness` (short / long axis, default 1) and `angle` (degrees) shape the brush.
     * Returns how many vertices moved.
     *
     * Command `mesh.brushDeform`.
     * Errors: E_BAD_CELL.
     */
    brushDeform(args: ArgsOf<'mesh.brushDeform'>): ResultOf<'mesh.brushDeform'>;
    /**
     * Create an art mesh from explicit vertices and triangles.
     *
     * `uv` are texture coordinates in the layer's pixel space (one [x, y] per vertex).
     * `positions` are the rest positions in the parent deformer's space; without a deformer that is
     * canvas pixels, and the default is the layer position plus uv. `triangles` are vertex-index
     * triples. The mesh starts with one keyform (no bindings).
     *
     * Command `mesh.create`.
     * Errors: E_SHAPE, E_DUPLICATE_ID.
     */
    create(args: ArgsOf<'mesh.create'>): ResultOf<'mesh.create'>;
    /**
     * Delete an art mesh.
     *
     * Without `cascade`, fails when masks, glues, hit areas or user data refer to the mesh.
     *
     * Command `mesh.delete`.
     * Errors: E_IN_USE.
     */
    delete(args: ArgsOf<'mesh.delete'>): ResultOf<'mesh.delete'>;
    /**
     * Delete vertices and their triangles, refilling the holes.
     *
     * Removes the vertices and every triangle that uses them. The hole around an interior vertex is
     * refilled from its neighbors; at the boundary the hole is refilled only when that keeps the outline
     * simple. Later vertices move down in index; glue pairs follow, and pairs on deleted vertices are
     * dropped. The mesh must keep at least three vertices.
     *
     * Command `mesh.deleteVertices`.
     * Errors: E_SHAPE, E_TOPOLOGY.
     */
    deleteVertices(args: ArgsOf<'mesh.deleteVertices'>): ResultOf<'mesh.deleteVertices'>;
    /**
     * Flip the edge between two vertices to the other diagonal of its quad.
     *
     * The edge must be shared by two triangles that form a convex quad (in texture space).
     *
     * Command `mesh.flipEdge`.
     * Errors: E_TOPOLOGY.
     */
    flipEdge(args: ArgsOf<'mesh.flipEdge'>): ResultOf<'mesh.flipEdge'>;
    /**
     * Replace a mesh by strips along drawn strokes, keeping its keyforms.
     *
     * Stroke-based meshing (confirmed with Shift+E in the editor). Each stroke is a
     * polyline in the mesh's texture space (layer pixels), resampled every `spacing` pixels (default
     * `width`) and widened to `width` across its path; the strips become the mesh's vertices and
     * triangles through mesh.setTopology, so every keyform carries over. For thin lines such as hair
     * strands and eyelashes.
     *
     * Command `mesh.fromStrokes`.
     * Errors: E_SHAPE, E_TOPOLOGY.
     */
    fromStrokes(args: ArgsOf<'mesh.fromStrokes'>): ResultOf<'mesh.fromStrokes'>;
    /**
     * Move texture coordinates of vertices (what part of the image they show).
     *
     * Moves uv only; positions in keyforms do not change. Omit `vertices` to move all of them.
     *
     * Command `mesh.moveUv`.
     * Errors: E_SHAPE.
     */
    moveUv(args: ArgsOf<'mesh.moveUv'>): ResultOf<'mesh.moveUv'>;
    /**
     * Move vertices in one keyform (or every keyform) by an offset, in the mesh’s own space.
     *
     * Offsets keyform positions of the listed vertices (all when omitted), in the parent deformer's
     * space. Name the keyform with `cell` ({parameter: key} for each binding), or use `all: true`. The
     * edited keyforms become authored.
     *
     * Command `mesh.moveVertices`.
     * Errors: E_SHAPE, E_BAD_CELL.
     */
    moveVertices(args: ArgsOf<'mesh.moveVertices'>): ResultOf<'mesh.moveVertices'>;
    /**
     * Recompute a mesh’s triangles over its current vertices, keeping its outline.
     *
     * A constrained Delaunay triangulation of the current vertices inside the current boundary. Vertices and keyforms are unchanged.
     *
     * Command `mesh.retriangulate`.
     * Errors: E_TOPOLOGY.
     */
    retriangulate(args: ArgsOf<'mesh.retriangulate'>): ResultOf<'mesh.retriangulate'>;
    /**
     * Set the meshes that clip a mesh, and whether the clip is inverted.
     *
     * The mesh is drawn only where its masks cover (or, inverted, only where they do not). Mask meshes
     * count whenever they are active, even at opacity 0. An empty list removes clipping.
     *
     * Command `mesh.setClip`.
     * Errors: E_RANGE.
     */
    setClip(args: ArgsOf<'mesh.setClip'>): ResultOf<'mesh.setClip'>;
    /**
     * Attach a mesh to a deformer (or none), with its positions as given.
     *
     * Changes the deformer whose space the mesh's stored positions are in. Without `converted`, the
     * stored values are kept, so the mesh moves on screen. `converted` gives the positions of every
     * keyform (and the position deltas of its blend shapes) in the new deformer's space. The
     * mesh.reparent operation computes them through Mochi2D's deformer mapping so the mesh stays in
     * place, and records this command.
     *
     * Command `mesh.setDeformer`.
     * Errors: E_SHAPE, E_FIELD_NOT_APPLICABLE.
     */
    setDeformer(args: ArgsOf<'mesh.setDeformer'>): ResultOf<'mesh.setDeformer'>;
    /**
     * Replace a mesh’s vertices (texture coordinates) and triangles, carrying keyforms over.
     *
     * Sets new `uv` (layer pixels, one [x, y] per vertex) and `triangles`. In every keyform, a new
     * vertex at the same uv as an old one keeps that vertex's position exactly; any other new vertex gets
     * the position given by its barycentric coordinates in the old mesh (extrapolated from the nearest
     * triangle when outside it). Glue pairs follow vertices that keep their uv; other pairs are dropped.
     * Use mesh.regenerate to rebuild from the layer image.
     *
     * Command `mesh.setTopology`.
     * Errors: E_SHAPE, E_TOPOLOGY.
     */
    setTopology(args: ArgsOf<'mesh.setTopology'>): ResultOf<'mesh.setTopology'>;
    /**
     * Split every triangle of a mesh into four.
     *
     * Adds a vertex at the middle of every edge (shared by the edge's triangles) and splits each triangle
     * into four. In every keyform and blend shape, a new vertex sits
     * halfway between its edge's ends, so the mesh looks the same. Existing vertex indices do not change;
     * glue pairs stay.
     *
     * Command `mesh.subdivide`.
     * Errors: E_SHAPE.
     */
    subdivide(args: ArgsOf<'mesh.subdivide'>): ResultOf<'mesh.subdivide'>;
    /**
     * Change a mesh’s layer, sidedness, enabled flag or legacy blending.
     *
     * A disabled mesh is always hidden. Single-sided meshes are culled when they face away.
     *
     * Command `mesh.update`.
     * Errors: none.
     */
    update(args: ArgsOf<'mesh.update'>): ResultOf<'mesh.update'>;
  };
  meta: {
    /**
     * Replace the pairs of parameters shown as one 2D control.
     *
     * Exported to the display-info file. Each pair names two different parameters.
     *
     * Command `meta.setCombinedParameters`.
     * Errors: E_RANGE.
     */
    setCombinedParameters(args: ArgsOf<'meta.setCombinedParameters'>): ResultOf<'meta.setCombinedParameters'>;
    /**
     * Replace the list of hit areas (mesh and name).
     *
     * Hit areas are exported to the model settings file with the mesh’s export ID.
     *
     * Command `meta.setHitAreas`.
     * Errors: E_NOT_FOUND.
     */
    setHitAreas(args: ArgsOf<'meta.setHitAreas'>): ResultOf<'meta.setHitAreas'>;
    /**
     * Set the EyeBlink and LipSync parameter groups.
     *
     * Apps drive the EyeBlink parameters for automatic blinking and the LipSync parameters for lip sync.
     *
     * Command `meta.setStandardGroups`.
     * Errors: E_NOT_FOUND.
     */
    setStandardGroups(args: ArgsOf<'meta.setStandardGroups'>): ResultOf<'meta.setStandardGroups'>;
    /**
     * Replace the user-data strings attached to meshes, parts or parameters.
     *
     * Exported to the user-data file. Playback ignores user data; apps may read it.
     *
     * Command `meta.setUserData`.
     * Errors: E_NOT_FOUND.
     */
    setUserData(args: ArgsOf<'meta.setUserData'>): ResultOf<'meta.setUserData'>;
  };
  motion: {
    /**
     * Create an empty motion.
     *
     * `group` is the motion group in the model settings (default "Idle"). Times are seconds.
     *
     * Command `motion.create`.
     * Errors: none.
     */
    create(args: ArgsOf<'motion.create'>): ResultOf<'motion.create'>;
    /**
     * Delete a motion.
     *
     * Removes the motion.
     *
     * Command `motion.delete`.
     * Errors: none.
     */
    delete(args: ArgsOf<'motion.delete'>): ResultOf<'motion.delete'>;
    /**
     * Delete keys of a motion curve by their times (the last one removes the curve).
     *
     * Fails with E_RANGE when a time has no key.
     *
     * Command `motion.deleteKeys`.
     * Errors: E_RANGE, E_SCHEMA.
     */
    deleteKeys(args: ArgsOf<'motion.deleteKeys'>): ResultOf<'motion.deleteKeys'>;
    /**
     * Insert a key into a motion curve, or replace the key at that time.
     *
     * Creates the curve when it has none. Without `interp`, a new key takes the interpolation of
     * the key before it (auto when it is the first), and a replaced key keeps its own.
     *
     * Command `motion.insertKey`.
     * Errors: E_SCHEMA, E_WRONG_KIND.
     */
    insertKey(args: ArgsOf<'motion.insertKey'>): ResultOf<'motion.insertKey'>;
    /**
     * Write a motion’s markers as events (user data) at their times.
     *
     * «Markers to Events»: each marker becomes an event with the marker's name as its value,
     * at the marker's time, added to the motion's events in time order. An event with the same time and
     * value is not added twice. The markers stay. The export never does this by itself.
     *
     * Command `motion.markersToEvents`.
     * Errors: none.
     */
    markersToEvents(args: ArgsOf<'motion.markersToEvents'>): ResultOf<'motion.markersToEvents'>;
    /**
     * Move keys of a motion curve in time and value.
     *
     * Adds `dt` seconds and `dv` to the keys at `times`, and moves their Bézier handles along. A
     * moved key that lands on another key replaces it. Times stay at 0 or later.
     *
     * Command `motion.moveKeys`.
     * Errors: E_RANGE, E_SCHEMA.
     */
    moveKeys(args: ArgsOf<'motion.moveKeys'>): ResultOf<'motion.moveKeys'>;
    /**
     * Remove one curve from a motion.
     *
     * Names the curve by its target and model value or object.
     *
     * Command `motion.removeCurve`.
     * Errors: E_NOT_FOUND.
     */
    removeCurve(args: ArgsOf<'motion.removeCurve'>): ResultOf<'motion.removeCurve'>;
    /**
     * Move a motion to a position in the motion order.
     *
     * The motion order is the order of each group's entries in the model settings, so it decides which
     * motion a group index names (an app's startMotion(group, index)) and which one idle playback picks
     * (§3l.7: entry ⌊r·n⌋ of the Idle group).
     *
     * Command `motion.reorder`.
     * Errors: none.
     */
    reorder(args: ArgsOf<'motion.reorder'>): ResultOf<'motion.reorder'>;
    /**
     * Add or replace one curve of a motion.
     *
     * A curve animates a parameter, a part's opacity, or a model value (EyeBlink, LipSync, Opacity).
     * `segments` uses the motion file encoding: the first point (time, value), then for each segment a
     * code and its points: 0 linear (t, v), 1 Bézier (t1, v1, t2, v2, t3, v3), 2 stepped (t, v),
     * 3 inverse stepped (t, v). Times must not go backwards.
     *
     * Command `motion.setCurve`.
     * Errors: E_SCHEMA, E_WRONG_KIND.
     */
    setCurve(args: ArgsOf<'motion.setCurve'>): ResultOf<'motion.setCurve'>;
    /**
     * Replace a motion’s events (time and string).
     *
     * Events fire when playback passes their time. They are written in time order.
     *
     * Command `motion.setEvents`.
     * Errors: none.
     */
    setEvents(args: ArgsOf<'motion.setEvents'>): ResultOf<'motion.setEvents'>;
    /**
     * Set the interpolation of the segments after keys of a motion curve.
     *
     * For each key at `times`, the segment after it becomes linear, auto (Auto smooth), step,
     * inverseStep or bezier. A new Bézier segment starts from the curve as it was where it can (the Auto
     * smooth or default handles), or from `handles` when given.
     *
     * Command `motion.setInterpolation`.
     * Errors: E_RANGE, E_SCHEMA.
     */
    setInterpolation(args: ArgsOf<'motion.setInterpolation'>): ResultOf<'motion.setInterpolation'>;
    /**
     * Replace a motion curve’s keys (creating the curve; no keys removes it).
     *
     * Keys are (time, value) with the interpolation of the segment after each one: linear, auto (Auto
     * smooth: Bézier handles computed from the keys, so it eases out and in and never overshoots), step,
     * inverseStep, or bezier with `handles` [t1, v1, t2, v2]. Keys at the same time: the later one wins.
     * Fades, when given, set the curve's fade-in and fade-out (null: the motion's).
     *
     * Command `motion.setKeys`.
     * Errors: E_SCHEMA, E_WRONG_KIND.
     */
    setKeys(args: ArgsOf<'motion.setKeys'>): ResultOf<'motion.setKeys'>;
    /**
     * Replace a motion’s timeline markers (time and name).
     *
     * Markers are the editor's: they label times in the timeline (Ctrl+J and Ctrl+K go to the
     * previous and next one) and are not exported. They are kept in time order.
     *
     * Command `motion.setMarkers`.
     * Errors: none.
     */
    setMarkers(args: ArgsOf<'motion.setMarkers'>): ResultOf<'motion.setMarkers'>;
    /**
     * Change a motion’s name, group, duration, fps, loop flag, Bézier mode, fades, sound or motion-sync setting.
     *
     * Only the given fields change. With a sound and a motion-sync setting, apps move the mouth by
     * the setting's analysis of the sound while the motion plays (model settings `MotionSync`); without a
     * setting, the sound drives lip sync.
     *
     * Command `motion.update`.
     * Errors: E_RANGE.
     */
    update(args: ArgsOf<'motion.update'>): ResultOf<'motion.update'>;
  };
  motionSync: {
    /**
     * Add a motion-sync setting: driven parameters, audio elements and their shapes.
     *
     * Elements default to Silence, A, I, U, E and O (enabled, scale 1); useCase 'Mouth',
     * analysisType 'CRI', sampleRate 30, smoothing 10, blendRatio 0. Without `shapes`, ParamMouthOpenY
     * and ParamMouthForm start at typical vowel shapes (A open, I wide, U round and so on: a starting point
     * to adjust), and other parameters at 0. Exported as the model's .motionsync3.json. Names are unique.
     *
     * Command `motionSync.addSetting`.
     * Errors: E_DUPLICATE_NAME, E_SHAPE.
     */
    addSetting(args: ArgsOf<'motionSync.addSetting'>): ResultOf<'motionSync.addSetting'>;
    /**
     * Remove a motion-sync setting.
     *
     * The setting leaves the export; nothing else refers to it.
     *
     * Command `motionSync.removeSetting`.
     * Errors: none.
     */
    removeSetting(args: ArgsOf<'motionSync.removeSetting'>): ResultOf<'motionSync.removeSetting'>;
    /**
     * Change a motion-sync setting; shapes follow its parameters and elements.
     *
     * Only the given fields change. When the driven parameters or the elements change without
     * `shapes`, each shape value is kept by parameter and element, and new ones start as in
     * motionSync.addSetting: typical vowel shapes for ParamMouthOpenY and ParamMouthForm, 0 otherwise.
     *
     * Command `motionSync.updateSetting`.
     * Errors: E_DUPLICATE_NAME, E_SHAPE.
     */
    updateSetting(args: ArgsOf<'motionSync.updateSetting'>): ResultOf<'motionSync.updateSetting'>;
  };
  object: {
    /**
     * Change an object’s export ID and/or display name.
     *
     * Works for every kind with names. Other objects refer to it by UID, so nothing else changes.
     * Export IDs must be unique within their namespace (parameters, parameter groups, parts, meshes,
     * deformers, glues).
     *
     * Command `object.rename`.
     * Errors: E_DUPLICATE_ID, E_BAD_EXPORT_ID, E_NOT_FOUND.
     */
    rename(args: ArgsOf<'object.rename'>): ResultOf<'object.rename'>;
  };
  objects: {
    /**
     * Paste copied art meshes and deformers (a fragment from copyFragment or clipboard.copy).
     *
     * Every object gets a new UID, and a new export ID where its own is taken. References are rebound:
     * - parameters by export ID; a binding whose parameter is not here is removed, keeping the forms at
     *   the parameter's default, and blend shapes on it are removed;
     * - masks to copied meshes follow the copies; masks to meshes not copied stay when the mesh is here,
     *   else are removed;
     * - the copies at the top go into `part` (when given) or their own part when it is here; a copied
     *   mesh or deformer keeps its deformer when that is here, else goes onto the canvas with its stored
     *   values;
     * - layers are reused when the same layer (with the same image) is here, else added; their images
     *   must be in the project's assets (clipboard.paste adds them).
     * Everything that could not be bound is listed in `unbound`.
     *
     * Command `objects.paste`.
     * Errors: E_SCHEMA.
     */
    paste(args: ArgsOf<'objects.paste'>): ResultOf<'objects.paste'>;
    /**
     * Find and replace in the export IDs and names of parameters, parts, deformers and meshes.
     *
     * Plain text, or a JavaScript regular expression with `pattern: true` (`$1` in the replacement
     * inserts a group). `fields` limits it to export IDs or names, `kinds` to some of parameter, part,
     * warp, rotation and artMesh. Other objects refer to these by UID, so bindings, masks, physics, the
     * pose, expressions and motion curves stay attached, and the exported files carry the new IDs and
     * names. The whole result is checked first: an invalid or duplicate export ID refuses the command and
     * changes nothing (a dry run lists the changes). Returns every change.
     *
     * Command `objects.replaceText`.
     * Errors: E_RANGE, E_BAD_EXPORT_ID, E_DUPLICATE_ID.
     */
    replaceText(args: ArgsOf<'objects.replaceText'>): ResultOf<'objects.replaceText'>;
  };
  param: {
    /**
     * Create a parameter with a range, a default and a key list.
     *
     * Creates a parameter. `keys` are the values where keyforms may exist; when omitted they are
     * the distinct values of min, default and max. Values are rounded to float32. `type` 'blendShape'
     * creates a blend-shape parameter: it drives blend shapes (blendShape.add), not bindings.
     *
     * Command `param.create`.
     * Errors: E_RANGE, E_DUPLICATE_ID, E_BAD_EXPORT_ID.
     */
    create(args: ArgsOf<'param.create'>): ResultOf<'param.create'>;
    /**
     * Delete a parameter.
     *
     * Without `cascade`, fails when anything uses the parameter. With `cascade`, bindings are removed
     * (each object keeps the keyforms nearest to the parameter's default) and the parameter is removed
     * from expressions, motions, physics, groups and the display lists.
     *
     * Command `param.delete`.
     * Errors: E_IN_USE.
     */
    delete(args: ArgsOf<'param.delete'>): ResultOf<'param.delete'>;
    /**
     * Move a parameter to a position in the parameter order.
     *
     * The parameter order is the export order and the order apps list parameters in.
     *
     * Command `param.reorder`.
     * Errors: none.
     */
    reorder(args: ArgsOf<'param.reorder'>): ResultOf<'param.reorder'>;
    /**
     * Replace a parameter’s key list.
     *
     * Keys must lie within [min, max]. A key that a binding uses cannot be removed; the error lists the
     * objects and offers rig.removeKey fixes.
     *
     * Command `param.setKeys`.
     * Errors: E_RANGE, E_KEY_IN_USE.
     */
    setKeys(args: ArgsOf<'param.setKeys'>): ResultOf<'param.setKeys'>;
    /**
     * Change a parameter’s range, default, repeat flag, decimals or group.
     *
     * The new range must still contain the default and every key. Use param.setKeys for keys.
     *
     * Command `param.update`.
     * Errors: E_RANGE.
     */
    update(args: ArgsOf<'param.update'>): ResultOf<'param.update'>;
  };
  paramGroup: {
    /**
     * Create a parameter group for display.
     *
     * Groups are exported to the display-info file. Groups can nest through `parent`.
     *
     * Command `paramGroup.create`.
     * Errors: E_DUPLICATE_ID.
     */
    create(args: ArgsOf<'paramGroup.create'>): ResultOf<'paramGroup.create'>;
    /**
     * Delete a parameter group. Its parameters and subgroups move to its parent.
     *
     * Parameters in the group become ungrouped; subgroups move up one level.
     *
     * Command `paramGroup.delete`.
     * Errors: none.
     */
    delete(args: ArgsOf<'paramGroup.delete'>): ResultOf<'paramGroup.delete'>;
    /**
     * Change a parameter group’s parent.
     *
     * A group cannot become its own ancestor.
     *
     * Command `paramGroup.update`.
     * Errors: E_CYCLE.
     */
    update(args: ArgsOf<'paramGroup.update'>): ResultOf<'paramGroup.update'>;
  };
  part: {
    /**
     * Create a part under a parent part, or at the top of the tree.
     *
     * Parts group meshes and other parts, carry an opacity that apps set, and can own a sorting scope.
     * Its draw order (default 500) sorts the part among its siblings when its parent scope sorts parts.
     * `index` is the position among the parent's children (default: last, which is front-most among ties).
     *
     * Command `part.create`.
     * Errors: E_DUPLICATE_ID, E_NOT_FOUND.
     */
    create(args: ArgsOf<'part.create'>): ResultOf<'part.create'>;
    /**
     * Delete a part. With cascade, also everything inside it.
     *
     * Without `cascade` the part must be empty and unreferenced. With `cascade`, its children are
     * deleted too, and references to all deleted objects are removed (masks, hit areas, glues, poses...).
     * Deformers owned by the part lose their owning part.
     *
     * Command `part.delete`.
     * Errors: E_IN_USE.
     */
    delete(args: ArgsOf<'part.delete'>): ResultOf<'part.delete'>;
    /**
     * Change a part’s enabled flag, initial visibility, sorting scope or guide-image flag.
     *
     * A disabled part hides everything below it, including meshes moved by deformers it owns.
     * `sortingScope` 'own' makes the part's children sort among themselves while the part sorts as one item.
     * `guide` makes it a guide image: a visual reference that the export leaves out, with everything in
     * it, unless the export settings' `includeGuideImages` is on.
     *
     * Command `part.update`.
     * Errors: none.
     */
    update(args: ArgsOf<'part.update'>): ResultOf<'part.update'>;
  };
  physics: {
    /**
     * Add a pendulum physics setting.
     *
     * Inputs read parameters (weight in percent, type X, Y or Angle); outputs write parameters from a
     * particle's motion; particles are the pendulum chain, root first. Settings run in order.
     *
     * Command `physics.addSetting`.
     * Errors: E_RANGE.
     */
    addSetting(args: ArgsOf<'physics.addSetting'>): ResultOf<'physics.addSetting'>;
    /**
     * Remove a physics setting.
     *
     * Removes the setting.
     *
     * Command `physics.removeSetting`.
     * Errors: none.
     */
    removeSetting(args: ArgsOf<'physics.removeSetting'>): ResultOf<'physics.removeSetting'>;
    /**
     * Set the physics simulation rate (0: one step per frame).
     *
     * Exported as the physics file’s Meta.Fps.
     *
     * Command `physics.setFps`.
     * Errors: none.
     */
    setFps(args: ArgsOf<'physics.setFps'>): ResultOf<'physics.setFps'>;
    /**
     * Replace a physics setting’s inputs, outputs, particles and normalization.
     *
     * All fields are replaced together.
     *
     * Command `physics.updateSetting`.
     * Errors: E_RANGE.
     */
    updateSetting(args: ArgsOf<'physics.updateSetting'>): ResultOf<'physics.updateSetting'>;
  };
  pose: {
    /**
     * Replace the pose groups (mutually exclusive parts) and the pose fade time.
     *
     * Each group lists parts of which only one is shown at a time; `links` are parts that copy an
     * entry's opacity. A part may appear in at most one group.
     *
     * Command `pose.setGroups`.
     * Errors: E_RANGE.
     */
    setGroups(args: ArgsOf<'pose.setGroups'>): ResultOf<'pose.setGroups'>;
  };
  project: {
    /**
     * Set the canvas size, pixels per unit and origin.
     *
     * Sets the canvas in pixels. `pixelsPerUnit` is how many canvas pixels make one model unit in the
     * exported file, and the origin is the model-space origin, in pixels from the canvas's top-left corner.
     * Stored positions are not moved.
     *
     * Command `project.setCanvas`.
     * Errors: E_SCHEMA.
     */
    setCanvas(args: ArgsOf<'project.setCanvas'>): ResultOf<'project.setCanvas'>;
    /**
     * Set the export target version, minimum version, atlas size and file stem.
     *
     * `mocVersion` is 'auto' or 3, 4 or 5. 'auto' picks the lowest version that carries every feature
     * the document uses, but never below `minimumVersion` (design 2.2).
     *
     * Command `project.setExportSettings`.
     * Errors: E_SCHEMA.
     */
    setExportSettings(args: ArgsOf<'project.setExportSettings'>): ResultOf<'project.setExportSettings'>;
  };
  rig: {
    /**
     * Bind an object to a parameter, at some or all of the parameter’s keys.
     *
     * Adds an interpolation axis. Every existing keyform is copied to each new key, so the object looks
     * the same until a cell is edited. Copies at the key nearest the parameter's default keep their
     * "authored" mark; the others are marked as filled. `keys` default to all of the parameter's keys.
     * `index` places the binding in the axis order (default: last).
     *
     * Command `rig.addBinding`.
     * Errors: E_ALREADY_BOUND, E_KEY_NOT_ON_PARAMETER, E_RANGE.
     */
    addBinding(args: ArgsOf<'rig.addBinding'>): ResultOf<'rig.addBinding'>;
    /**
     * Add a key to one of an object’s bindings.
     *
     * The key must be in the parameter's key list. New cells between two keys are interpolated (so the
     * object looks the same as before); new cells beyond the ends copy the nearest cell. They are marked
     * as filled until edited.
     *
     * Command `rig.addKey`.
     * Errors: E_NOT_BOUND, E_KEY_NOT_ON_PARAMETER, E_RANGE.
     */
    addKey(args: ArgsOf<'rig.addKey'>): ResultOf<'rig.addKey'>;
    /**
     * Recompute every filled (unauthored) keyform from the authored ones.
     *
     * Along each axis, filled cells are interpolated between the nearest authored cells, or copied from the only one.
     *
     * Command `rig.fillMissing`.
     * Errors: none.
     */
    fillMissing(args: ArgsOf<'rig.fillMissing'>): ResultOf<'rig.fillMissing'>;
    /**
     * Unbind an object from a parameter, keeping the keyforms at one key.
     *
     * `keep` is the key whose keyforms remain (default: the key nearest the parameter default).
     *
     * Command `rig.removeBinding`.
     * Errors: E_NOT_BOUND, E_BAD_CELL.
     */
    removeBinding(args: ArgsOf<'rig.removeBinding'>): ResultOf<'rig.removeBinding'>;
    /**
     * Remove a key (and its keyforms) from one of an object’s bindings.
     *
     * A binding keeps at least one key; to remove the last one, remove the binding.
     *
     * Command `rig.removeKey`.
     * Errors: E_NOT_BOUND, E_LAST_KEY, E_BAD_CELL.
     */
    removeKey(args: ArgsOf<'rig.removeKey'>): ResultOf<'rig.removeKey'>;
  };
  sound: {
    /**
     * Create a sound from a WAV asset already in the project’s asset store.
     *
     * Usually run by the sound.import operation, which reads a WAV file, stores it and runs this. A
     * motion starts a sound with motion.update { sound }. Apps play it with the motion, and lip sync
     * follows its level (§3b.2, 3s).
     *
     * Command `sound.create`.
     * Errors: none.
     */
    create(args: ArgsOf<'sound.create'>): ResultOf<'sound.create'>;
    /**
     * Delete a sound.
     *
     * Without `cascade`, fails while a motion uses it; with `cascade`, those motions lose it.
     *
     * Command `sound.delete`.
     * Errors: E_IN_USE.
     */
    delete(args: ArgsOf<'sound.delete'>): ResultOf<'sound.delete'>;
    /**
     * Rename a sound.
     *
     * The name is also the exported file name (sounds/<name>.wav).
     *
     * Command `sound.update`.
     * Errors: none.
     */
    update(args: ArgsOf<'sound.update'>): ResultOf<'sound.update'>;
  };
  template: {
    /**
     * Add an animation template as it is (an imported template file).
     *
     * With `replace`, a template of the same name is replaced; otherwise the name must be new.
     *
     * Command `template.add`.
     * Errors: E_DUPLICATE_NAME.
     */
    add(args: ArgsOf<'template.add'>): ResultOf<'template.add'>;
    /**
     * Insert an animation template’s keys into a motion at a time.
     *
     * Each of the template's curves goes to the parameter with the same export ID; the others are
     * reported in `unmatched` and left out. On a matched parameter's curve, the keys inside the
     * template's span (after `time`, before `time` + its duration) give way to the template's, and keys
     * at the same time are replaced. Fails with E_NOT_FOUND when no parameter matches.
     *
     * Command `template.apply`.
     * Errors: E_NOT_FOUND.
     */
    apply(args: ArgsOf<'template.apply'>): ResultOf<'template.apply'>;
    /**
     * Make an animation template from a motion’s parameter keys in a range of time.
     *
     * Takes the keys of the motion's parameter curves from `from` to `to` (seconds, both
     * included), or of the given parameters only, with their interpolations. Times are stored from 0, and
     * the template is named by parameter export ID, so it applies to any model with the same IDs.
     *
     * Command `template.create`.
     * Errors: E_DUPLICATE_NAME, E_RANGE.
     */
    create(args: ArgsOf<'template.create'>): ResultOf<'template.create'>;
    /**
     * Delete an animation template.
     *
     * Motions keep the keys it inserted.
     *
     * Command `template.delete`.
     * Errors: E_NOT_FOUND.
     */
    delete(args: ArgsOf<'template.delete'>): ResultOf<'template.delete'>;
    /**
     * Rename an animation template.
     *
     * The new name must not be taken.
     *
     * Command `template.rename`.
     * Errors: E_NOT_FOUND, E_DUPLICATE_NAME.
     */
    rename(args: ArgsOf<'template.rename'>): ResultOf<'template.rename'>;
  };
  tree: {
    /**
     * Move a part or mesh to another parent part and/or position.
     *
     * Moves within the part tree (grouping and order). It does not change geometry or the deformer
     * a mesh uses. `parent` null means the top level. A part cannot move inside itself.
     *
     * Command `tree.move`.
     * Errors: E_CYCLE.
     */
    move(args: ArgsOf<'tree.move'>): ResultOf<'tree.move'>;
  };
}

/** The areas and their verbs, for building the methods at run time. */
export const COMMAND_AREAS = {
  blendShape: ['add', 'remove', 'reorder', 'set', 'setConstraints', 'setKeys'],
  deformPath: ['create', 'delete', 'update'],
  deformer: ['createRotation', 'createWarp', 'delete', 'setParent', 'update'],
  expression: ['create', 'delete', 'update'],
  glue: ['create', 'delete', 'reorder', 'setPairs'],
  keyform: ['copy', 'fillCorners', 'set'],
  layer: ['create', 'delete', 'setImage', 'update'],
  mesh: ['addVertices', 'brushDeform', 'create', 'delete', 'deleteVertices', 'flipEdge', 'fromStrokes', 'moveUv', 'moveVertices', 'retriangulate', 'setClip', 'setDeformer', 'setTopology', 'subdivide', 'update'],
  meta: ['setCombinedParameters', 'setHitAreas', 'setStandardGroups', 'setUserData'],
  motion: ['create', 'delete', 'deleteKeys', 'insertKey', 'markersToEvents', 'moveKeys', 'removeCurve', 'reorder', 'setCurve', 'setEvents', 'setInterpolation', 'setKeys', 'setMarkers', 'update'],
  motionSync: ['addSetting', 'removeSetting', 'updateSetting'],
  object: ['rename'],
  objects: ['paste', 'replaceText'],
  param: ['create', 'delete', 'reorder', 'setKeys', 'update'],
  paramGroup: ['create', 'delete', 'update'],
  part: ['create', 'delete', 'update'],
  physics: ['addSetting', 'removeSetting', 'setFps', 'updateSetting'],
  pose: ['setGroups'],
  project: ['setCanvas', 'setExportSettings'],
  rig: ['addBinding', 'addKey', 'fillMissing', 'removeBinding', 'removeKey'],
  sound: ['create', 'delete', 'update'],
  template: ['add', 'apply', 'create', 'delete', 'rename'],
  tree: ['move'],
} as const;
