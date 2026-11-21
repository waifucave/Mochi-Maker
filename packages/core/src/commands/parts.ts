import { Type } from '@sinclair/typebox';
import { Empty, Uid, defineCommand } from '../command.js';
import type { Draft } from '../document.js';
import { MochiError } from '../errors.js';
import { f32 } from '../f32.js';
import { decode } from '../codec.js';
import { FRAGMENT_FORMAT, type Fragment } from '../fragment.js';
import {
  BlendMode,
  OBJECT_SCHEMAS,
  isCompatibleBlend,
  type AnyKeyform,
  type ArtMesh,
  type DocObject,
  type Layer,
  type MeshKeyform,
  type Part,
  type Rig,
  type Rotation,
  type Uid as UidT,
  type Warp,
} from '../model.js';
import * as grid from '../rig.js';
import { RefOf, type Kind } from '../schema.js';
import { restack } from '../stacking.js';
import {
  BLACK,
  WHITE,
  deleteObject,
  f32Array,
  insertAt,
  isAncestor,
  freeExportId,
  newExportId,
  withConverted,
  without,
  Converted,
} from './helpers.js';

const Points = (description: string) =>
  Type.Array(Type.Tuple([Type.Number(), Type.Number()]), { description });

/** Places a part or mesh under a parent part (or at the root) at an index. */
function placeInTree(d: Draft, uid: string, parent: string | null, index?: number): void {
  if (parent === null) d.updateProject((p) => ({ ...p, root: insertAt(p.root, uid, index) }));
  else {
    const pp = d.getAs(parent, 'part');
    d.put({ ...pp, children: insertAt(pp.children, uid, index) });
  }
}

function removeFromTree(d: Draft, uid: string, parent: string | null): void {
  if (parent === null) d.updateProject((p) => ({ ...p, root: without(p.root, uid) }));
  else {
    const pp = d.getAs(parent, 'part');
    d.put({ ...pp, children: without(pp.children, uid) });
  }
}

export const partCreate = defineCommand({
  name: 'part.create',
  summary: 'Create a part under a parent part, or at the top of the tree.',
  doc: `Parts group meshes and other parts, carry an opacity that apps set, and can own a sorting scope.
Its draw order (default 500) sorts the part among its siblings when its parent scope sorts parts.
\`index\` is the position among the parent's children (default: last, which is front-most among ties).`,
  args: Type.Object({
    exportId: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    parent: Type.Optional(Type.Union([RefOf(['part']), Type.Null()])),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
    sortingScope: Type.Optional(Type.Union([Type.Literal('inherit'), Type.Literal('own')])),
    visibleAtStart: Type.Optional(Type.Boolean()),
    drawOrder: Type.Optional(Type.Number()),
    guide: Type.Optional(Type.Boolean({ description: 'a guide image (see part.update)' })),
  }),
  result: Uid,
  errors: ['E_DUPLICATE_ID', 'E_NOT_FOUND'],
  examples: [{ description: 'A head part', args: { exportId: 'PartHead', name: 'Head' } }],
  apply(d, a) {
    const uid = d.allocate('part');
    const exportId = newExportId(d, 'part', uid, a.exportId);
    const part: Part = {
      kind: 'part',
      uid,
      exportId,
      name: a.name ?? exportId,
      parent: a.parent ?? null,
      children: [],
      visibleAtStart: a.visibleAtStart ?? true,
      enabled: true,
      sortingScope: a.sortingScope ?? 'inherit',
      guide: a.guide ?? false,
      offscreen: null,
      rig: {
        bindings: [],
        keyforms: [
          {
            authored: true,
            drawOrder: f32(a.drawOrder ?? 500),
            opacity: 1,
            multiply: [...WHITE],
            screen: [...BLACK],
          },
        ],
      },
      blendShapes: [],
    };
    d.put(part);
    placeInTree(d, uid, part.parent, a.index);
    return { uid };
  },
});

export const partUpdate = defineCommand({
  name: 'part.update',
  summary: 'Change a part’s enabled flag, initial visibility, sorting scope or guide-image flag.',
  doc: `A disabled part hides everything below it, including meshes moved by deformers it owns.
\`sortingScope\` 'own' makes the part's children sort among themselves while the part sorts as one item.
\`guide\` makes it a guide image: a visual reference that the export leaves out, with everything in
it, unless the export settings' \`includeGuideImages\` is on.`,
  args: Type.Object({
    target: RefOf(['part']),
    enabled: Type.Optional(Type.Boolean()),
    visibleAtStart: Type.Optional(Type.Boolean()),
    sortingScope: Type.Optional(Type.Union([Type.Literal('inherit'), Type.Literal('own')])),
    guide: Type.Optional(Type.Boolean()),
  }),
  result: Empty,
  errors: [],
  examples: [
    { description: 'Own sorting scope', args: { target: '@part:PartHead', sortingScope: 'own' } },
  ],
  apply(d, a) {
    const p = d.getAs(a.target, 'part');
    if (a.sortingScope === 'inherit' && p.offscreen)
      throw new MochiError(
        'E_RANGE',
        `${d.describe(p.uid)} draws offscreen, which needs its own sorting scope.`,
        {
          path: 'args.sortingScope',
          fixes: [
            {
              description: 'Stop drawing it offscreen first',
              command: 'part.setOffscreen',
              args: { target: p.uid, offscreen: false },
            },
          ],
        },
      );
    d.put({
      ...p,
      enabled: a.enabled ?? p.enabled,
      visibleAtStart: a.visibleAtStart ?? p.visibleAtStart,
      sortingScope: a.sortingScope ?? p.sortingScope,
      guide: a.guide ?? p.guide,
    });
    return {};
  },
});

export const partSetOffscreen = defineCommand({
  name: 'part.setOffscreen',
  summary: 'Draw a part offscreen (version 6), with a blend mode and masks, or stop.',
  doc: `With \`offscreen\` true, the part's contents are drawn into an image of their own, which is then
composited into what is below with the part's opacity and tints (the part keyforms' \`opacity\`,
\`multiply\` and \`screen\`, set with keyform.set), its blend mode, and its masks. The part gets its
own sorting scope. Needs version 6, which the export chooses for it. Arguments left out keep their
values; a new offscreen is normal over, without masks. \`offscreen\` false stops drawing it offscreen.`,
  args: Type.Object({
    target: RefOf(['part']),
    offscreen: Type.Boolean(),
    blend: Type.Optional(BlendMode),
    masks: Type.Optional(Type.Array(RefOf(['artMesh']))),
    invert: Type.Optional(Type.Boolean()),
  }),
  result: Empty,
  errors: ['E_RANGE'],
  examples: [
    {
      description: 'Draw the hair offscreen and multiply it over the head',
      args: {
        target: '@part:PartHair',
        offscreen: true,
        blend: { color: 'multiply', alpha: 'over' },
      },
    },
  ],
  apply(d, a) {
    const p = d.getAs(a.target, 'part');
    if (!a.offscreen) {
      d.put({ ...p, offscreen: null });
      return {};
    }
    const old = p.offscreen;
    const masks = a.masks ? [...new Set(a.masks)] : (old?.clip?.masks ?? []);
    const invert = a.invert ?? old?.clip?.invert ?? false;
    d.put({
      ...p,
      sortingScope: 'own',
      offscreen: {
        blend: a.blend ?? old?.blend ?? { color: 'normal', alpha: 'over' },
        clip: masks.length === 0 ? null : { masks, invert },
      },
    });
    return {};
  },
});

export const treeMove = defineCommand({
  name: 'tree.move',
  summary: 'Move a part or mesh to another parent part and/or position.',
  doc: `Moves within the part tree (grouping and order). It does not change geometry or the deformer
a mesh uses. Where the group has an explicit stacking order (\`project.stacks\`, an imported model's),
the moved object takes the same place there. \`parent\` null means the top level. A part cannot move inside itself.`,
  args: Type.Object({
    target: RefOf(['part', 'artMesh']),
    parent: Type.Union([RefOf(['part']), Type.Null()]),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  result: Empty,
  errors: ['E_CYCLE'],
  examples: [
    {
      description: 'Move a mesh into the head',
      args: { target: '@mesh:ArtMesh_EyeL', parent: '@part:PartHead' },
    },
  ],
  apply(d, a) {
    const o = d.getAs(a.target, ['part', 'artMesh']);
    if (
      o.kind === 'part' &&
      isAncestor(d, o.uid, a.parent, (x) => (x.kind === 'part' ? x.parent : null))
    )
      throw new MochiError('E_CYCLE', `${d.describe(o.uid)} cannot move inside itself.`, {
        path: 'args.parent',
      });
    const oldParent = o.kind === 'part' ? o.parent : o.part;
    removeFromTree(d, o.uid, oldParent);
    const moved = d.get(o.uid) as Part | ArtMesh;
    d.put(moved.kind === 'part' ? { ...moved, parent: a.parent } : { ...moved, part: a.parent });
    placeInTree(d, o.uid, a.parent, a.index);
    // A group with an explicit stacking order (an imported model's) follows the move.
    restack(d, o.uid);
    return {};
  },
});

/** Deletes a part and its whole subtree. */
function deleteSubtree(d: Draft, uid: string): void {
  const o = d.get(uid);
  if (!o) return;
  if (o.kind === 'part') for (const c of [...o.children]) deleteSubtree(d, c);
  const cur = d.get(uid) as Part | ArtMesh;
  removeFromTree(d, uid, cur.kind === 'part' ? cur.parent : cur.part);
  deleteObject(
    d,
    uid,
    true,
    cur.kind === 'part' ? 'part.delete' : 'mesh.delete',
    (from) => from === (cur.kind === 'part' ? cur.parent : cur.part),
  );
}

export const partDelete = defineCommand({
  name: 'part.delete',
  summary: 'Delete a part. With cascade, also everything inside it.',
  doc: `Without \`cascade\` the part must be empty and unreferenced. With \`cascade\`, its children are
deleted too, and references to all deleted objects are removed (masks, hit areas, glues, poses...).
Deformers owned by the part lose their owning part.`,
  args: Type.Object({ target: RefOf(['part']), cascade: Type.Optional(Type.Boolean()) }),
  result: Empty,
  errors: ['E_IN_USE'],
  examples: [
    {
      description: 'Delete a part and its contents',
      args: { target: '@part:PartHat', cascade: true },
    },
  ],
  apply(d, a) {
    const p = d.getAs(a.target, 'part');
    if (!a.cascade) {
      if (p.children.length > 0)
        throw new MochiError(
          'E_IN_USE',
          `${d.describe(p.uid)} has ${p.children.length} child(ren).`,
          {
            fixes: [
              {
                description: 'Delete it with its contents',
                command: 'part.delete',
                args: { target: p.uid, cascade: true },
              },
            ],
          },
        );
      removeFromTree(d, p.uid, p.parent);
      deleteObject(d, p.uid, false, 'part.delete');
      return {};
    }
    deleteSubtree(d, p.uid);
    return {};
  },
});

export const meshCreate = defineCommand({
  name: 'mesh.create',
  summary: 'Create an art mesh from explicit vertices and triangles.',
  doc: `\`uv\` are texture coordinates in the layer's pixel space (one [x, y] per vertex).
\`positions\` are the rest positions in the parent deformer's space; without a deformer that is
canvas pixels, and the default is the layer position plus uv. \`triangles\` are vertex-index
triples. The mesh starts with one keyform (no bindings).`,
  args: Type.Object({
    exportId: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    part: Type.Optional(Type.Union([RefOf(['part']), Type.Null()])),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
    deformer: Type.Optional(Type.Union([RefOf(['warp', 'rotation']), Type.Null()])),
    layer: Type.Optional(Type.Union([RefOf(['layer']), Type.Null()])),
    uv: Points('texture coordinates, layer pixels'),
    positions: Type.Optional(Points('rest positions in the parent space')),
    triangles: Type.Array(
      Type.Tuple([
        Type.Integer({ minimum: 0 }),
        Type.Integer({ minimum: 0 }),
        Type.Integer({ minimum: 0 }),
      ]),
    ),
    doubleSided: Type.Optional(Type.Boolean()),
    opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    drawOrder: Type.Optional(Type.Number()),
  }),
  result: Uid,
  errors: ['E_SHAPE', 'E_DUPLICATE_ID'],
  examples: [
    {
      description: 'A quad',
      args: {
        exportId: 'ArtMesh_Quad',
        uv: [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
        ],
        triangles: [
          [0, 1, 2],
          [0, 2, 3],
        ],
      },
    },
  ],
  apply(d, a) {
    const v = a.uv.length;
    if (v > 65535)
      throw new MochiError('E_SHAPE', 'A mesh can have at most 65535 vertices.', {
        path: 'args.uv',
      });
    if (a.positions && a.positions.length !== v)
      throw new MochiError('E_SHAPE', `positions has ${a.positions.length} points, uv has ${v}.`, {
        path: 'args.positions',
      });
    a.triangles.forEach((t, i) => {
      if (t.some((x) => x >= v))
        throw new MochiError('E_SHAPE', `Triangle ${i} uses a vertex index ≥ ${v}.`, {
          path: `args.triangles[${i}]`,
        });
    });
    const layer = a.layer ? (d.getAs(a.layer, 'layer') as Layer) : null;
    const offset = layer && !a.deformer ? [layer.x, layer.y] : [0, 0];
    const uid = d.allocate('artMesh');
    const exportId = newExportId(d, 'artMesh', uid, a.exportId);
    const keyform: MeshKeyform = {
      authored: true,
      positions: f32Array(
        (a.positions ?? a.uv.map(([x, y]) => [x + offset[0]!, y + offset[1]!])).flat(),
      ),
      opacity: f32(a.opacity ?? 1),
      drawOrder: f32(a.drawOrder ?? 500),
      multiply: [...WHITE],
      screen: [...BLACK],
    };
    const mesh: ArtMesh = {
      kind: 'artMesh',
      uid,
      exportId,
      name: a.name ?? exportId,
      part: a.part ?? null,
      deformer: a.deformer ?? null,
      layer: layer?.uid ?? null,
      uv: f32Array(a.uv.flat()),
      triangles: Uint16Array.from(a.triangles.flat()),
      doubleSided: a.doubleSided ?? true,
      enabled: true,
      legacyBlend: 'normal',
      blend: null,
      clip: null,
      rig: { bindings: [], keyforms: [keyform] },
      blendShapes: [],
    };
    d.put(mesh);
    placeInTree(d, uid, mesh.part, a.index);
    return { uid };
  },
});

export const meshUpdate = defineCommand({
  name: 'mesh.update',
  summary: 'Change a mesh’s layer, sidedness, enabled flag or blending.',
  doc: `A disabled mesh is always hidden. Single-sided meshes are culled when they face away.
\`legacyBlend\` is the blending every version has. \`blend\` sets a version 6 blend mode (a color
function and an alpha mode); one that every version can draw (normal over, additive,
multiplicative) is stored as \`legacyBlend\` instead. \`blend\` null goes back to \`legacyBlend\`.`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    layer: Type.Optional(Type.Union([RefOf(['layer']), Type.Null()])),
    doubleSided: Type.Optional(Type.Boolean()),
    enabled: Type.Optional(Type.Boolean()),
    legacyBlend: Type.Optional(
      Type.Union([
        Type.Literal('normal'),
        Type.Literal('additive'),
        Type.Literal('multiplicative'),
      ]),
    ),
    blend: Type.Optional(Type.Union([BlendMode, Type.Null()])),
  }),
  result: Empty,
  errors: [],
  examples: [
    {
      description: 'Additive glow',
      args: { target: '@mesh:ArtMesh_Glow', legacyBlend: 'additive' },
    },
    {
      description: 'Overlay shading (version 6)',
      args: { target: '@mesh:ArtMesh_Shade', blend: { color: 'overlay', alpha: 'atop' } },
    },
  ],
  apply(d, a) {
    const m = d.getAs(a.target, 'artMesh');
    let legacyBlend = a.legacyBlend ?? m.legacyBlend;
    let blend = a.blend === undefined ? m.blend : a.blend;
    if (a.legacyBlend !== undefined && a.blend === undefined) blend = null;
    if (blend && isCompatibleBlend(blend)) {
      legacyBlend = blend.color as 'normal' | 'additive' | 'multiplicative';
      blend = null;
    }
    d.put({
      ...m,
      layer: a.layer === undefined ? m.layer : a.layer,
      doubleSided: a.doubleSided ?? m.doubleSided,
      enabled: a.enabled ?? m.enabled,
      legacyBlend,
      blend,
    });
    return {};
  },
});

export const meshSetClip = defineCommand({
  name: 'mesh.setClip',
  summary: 'Set the meshes that clip a mesh, and whether the clip is inverted.',
  doc: `The mesh is drawn only where its masks cover (or, inverted, only where they do not). Mask meshes
count whenever they are active, even at opacity 0. An empty list removes clipping.`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    masks: Type.Array(RefOf(['artMesh'])),
    invert: Type.Optional(Type.Boolean()),
  }),
  result: Empty,
  errors: ['E_RANGE'],
  examples: [
    {
      description: 'Clip the iris by the eye white',
      args: { target: '@mesh:ArtMesh_Iris', masks: ['@mesh:ArtMesh_EyeWhite'] },
    },
  ],
  apply(d, a) {
    const m = d.getAs(a.target, 'artMesh');
    if (a.masks.includes(m.uid))
      throw new MochiError('E_RANGE', 'A mesh cannot clip itself.', { path: 'args.masks' });
    const masks = [...new Set(a.masks)];
    d.put({
      ...m,
      clip: masks.length === 0 ? null : { masks, invert: a.invert ?? m.clip?.invert ?? false },
    });
    return {};
  },
});

export const meshSetDeformer = defineCommand({
  name: 'mesh.setDeformer',
  summary: 'Attach a mesh to a deformer (or none), with its positions as given.',
  doc: `Changes the deformer whose space the mesh's stored positions are in. Without \`converted\`, the
stored values are kept, so the mesh moves on screen. \`converted\` gives the positions of every
keyform (and the position deltas of its blend shapes) in the new deformer's space. The
mesh.reparent operation computes them through Mochi2D's deformer mapping so the mesh stays in
place, and records this command.`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    deformer: Type.Union([RefOf(['warp', 'rotation']), Type.Null()]),
    converted: Type.Optional(Converted),
  }),
  result: Empty,
  errors: ['E_SHAPE', 'E_FIELD_NOT_APPLICABLE'],
  examples: [
    {
      description: 'Attach to a warp',
      args: { target: '@mesh:ArtMesh_Face', deformer: '@warp:Warp_Face' },
    },
  ],
  apply(d, a) {
    const m = d.getAs(a.target, 'artMesh');
    const moved = { ...m, deformer: a.deformer };
    d.put(a.converted ? withConverted(moved, a.converted) : moved);
    return {};
  },
});

export const meshDelete = defineCommand({
  name: 'mesh.delete',
  summary: 'Delete an art mesh.',
  doc: 'Without `cascade`, fails when masks, glues, hit areas or user data refer to the mesh.',
  args: Type.Object({ target: RefOf(['artMesh']), cascade: Type.Optional(Type.Boolean()) }),
  result: Empty,
  errors: ['E_IN_USE'],
  examples: [
    { description: 'Delete a mesh', args: { target: '@mesh:ArtMesh_Old', cascade: true } },
  ],
  apply(d, a) {
    const m = d.getAs(a.target, 'artMesh');
    deleteObject(d, m.uid, a.cascade ?? false, 'mesh.delete', (from) => from === m.part);
    removeFromTree(d, m.uid, m.part);
    return {};
  },
});

export const layerCreate = defineCommand({
  name: 'layer.create',
  summary: 'Register an image layer (an asset placed on the canvas).',
  doc: `\`asset\` is the SHA-256 (hex) of a PNG already stored in the session's asset store. \`x\`, \`y\`
place the image's top-left pixel on the canvas. Import commands create layers for you.`,
  args: Type.Object({
    name: Type.String(),
    asset: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    x: Type.Integer(),
    y: Type.Integer(),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    visible: Type.Optional(Type.Boolean()),
    opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    blendMode: Type.Optional(Type.String()),
    clipped: Type.Optional(Type.Boolean()),
    notes: Type.Optional(Type.Array(Type.String())),
    source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    texturePage: Type.Optional(
      Type.Boolean({ description: 'a whole texture page, exported as it is (default false)' }),
    ),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  result: Uid,
  errors: [],
  examples: [
    {
      description: 'A layer',
      args: { name: 'face', asset: '0'.repeat(64), x: 100, y: 200, width: 512, height: 512 },
    },
  ],
  apply(d, a) {
    const uid = d.allocate('layer');
    d.put({
      kind: 'layer',
      uid,
      name: a.name,
      asset: a.asset,
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
      visible: a.visible ?? true,
      opacity: f32(a.opacity ?? 1),
      blendMode: a.blendMode ?? 'normal',
      clipped: a.clipped ?? false,
      notes: a.notes ?? [],
      source: a.source ?? null,
      texturePage: a.texturePage ?? false,
    });
    d.updateProject((p) => ({ ...p, layerOrder: insertAt(p.layerOrder, uid, a.index) }));
    return { uid };
  },
});

export const layerUpdate = defineCommand({
  name: 'layer.update',
  summary: 'Change a layer’s name, position or visibility.',
  doc: 'Moving a layer does not move meshes that use it.',
  args: Type.Object({
    target: RefOf(['layer']),
    name: Type.Optional(Type.String()),
    x: Type.Optional(Type.Integer()),
    y: Type.Optional(Type.Integer()),
    visible: Type.Optional(Type.Boolean()),
    notes: Type.Optional(Type.Array(Type.String(), { description: 'replaces the notes' })),
    source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Hide a layer', args: { target: 'layer_0003', visible: false } }],
  apply(d, a) {
    const l = d.getAs(a.target, 'layer');
    d.put({
      ...l,
      name: a.name ?? l.name,
      x: a.x ?? l.x,
      y: a.y ?? l.y,
      visible: a.visible ?? l.visible,
      notes: a.notes ?? l.notes,
      source: a.source === undefined ? l.source : a.source,
    });
    return {};
  },
});

export const layerSetImage = defineCommand({
  name: 'layer.setImage',
  summary: 'Replace a layer’s pixels (a new asset and bounds), keeping its meshes in place.',
  doc: `Points the layer at another asset with its canvas position and size, as a re-import does
(art.reimport). Meshes that use the layer keep their positions; unless \`remapUvs\` is false, their
texture coordinates move by the change of the layer's top-left corner, so each vertex keeps showing
the same canvas pixel. The other fields update the layer's recorded source properties.`,
  args: Type.Object({
    target: RefOf(['layer']),
    asset: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    x: Type.Integer(),
    y: Type.Integer(),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    remapUvs: Type.Optional(Type.Boolean()),
    visible: Type.Optional(Type.Boolean()),
    opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    blendMode: Type.Optional(Type.String()),
    clipped: Type.Optional(Type.Boolean()),
    notes: Type.Optional(Type.Array(Type.String())),
    source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }),
  result: Type.Object({ remapped: Type.Array(Type.String()) }),
  errors: [],
  examples: [
    {
      description: 'The layer grew 4 px to the left',
      args: { target: 'layer_0003', asset: '0'.repeat(64), x: 96, y: 200, width: 516, height: 512 },
    },
  ],
  apply(d, a) {
    const l = d.getAs(a.target, 'layer');
    d.put({
      ...l,
      asset: a.asset,
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
      visible: a.visible ?? l.visible,
      opacity: a.opacity === undefined ? l.opacity : f32(a.opacity),
      blendMode: a.blendMode ?? l.blendMode,
      clipped: a.clipped ?? l.clipped,
      notes: a.notes ?? l.notes,
      source: a.source === undefined ? l.source : a.source,
    });
    const remapped: string[] = [];
    const dx = l.x - a.x;
    const dy = l.y - a.y;
    if ((a.remapUvs ?? true) && (dx !== 0 || dy !== 0))
      for (const m of d.ofKind('artMesh')) {
        if (m.layer !== l.uid) continue;
        const uv = Array.from(m.uv, (v, i) => v + (i % 2 === 0 ? dx : dy));
        d.put({ ...m, uv: f32Array(uv) });
        remapped.push(m.uid);
      }
    return { remapped };
  },
});

export const layerDelete = defineCommand({
  name: 'layer.delete',
  summary:
    'Delete a layer. With cascade, meshes that use it keep their geometry but lose the layer.',
  doc: 'The asset itself stays in the store until the project is saved without references to it.',
  args: Type.Object({ target: RefOf(['layer']), cascade: Type.Optional(Type.Boolean()) }),
  result: Empty,
  errors: ['E_IN_USE'],
  examples: [{ description: 'Delete a layer', args: { target: 'layer_0003', cascade: true } }],
  apply(d, a) {
    deleteObject(d, a.target, a.cascade ?? false, 'layer.delete');
    return {};
  },
});

// ---------------------------------------------------------------- paste

/**
 * Puts a fragment (`copyFragment`) into the document: every object a new UID, new export IDs
 * where the old ones are taken, references rebound (see the doc).
 */
export const objectsPaste = defineCommand({
  name: 'objects.paste',
  summary:
    'Paste copied art meshes and deformers (a fragment from copyFragment or clipboard.copy).',
  doc: `Every object gets a new UID, and a new export ID where its own is taken. References are rebound:
- parameters by export ID; a binding whose parameter is not here is removed, keeping the forms at
  the parameter's default, and blend shapes on it are removed;
- masks to copied meshes follow the copies; masks to meshes not copied stay when the mesh is here,
  else are removed;
- the copies at the top go into \`part\` (when given) or their own part when it is here; a copied
  mesh or deformer keeps its deformer when that is here, else goes onto the canvas with its stored
  values;
- layers are reused when the same layer (with the same image) is here, else added; their images
  must be in the project's assets (clipboard.paste adds them).
Everything that could not be bound is listed in \`unbound\`.`,
  args: Type.Object({
    fragment: Type.Object(
      {
        format: Type.Literal(FRAGMENT_FORMAT),
        version: Type.Literal(1),
        roots: Type.Array(Type.String()),
        objects: Type.Array(Type.Unknown()),
        refs: Type.Record(Type.String(), Type.Unknown()),
        assets: Type.Optional(Type.Record(Type.String(), Type.String())),
      },
      { description: 'what copyFragment (or the clipboard.copy operation) gives' },
    ),
    part: Type.Optional(Type.Union([RefOf(['part']), Type.Null()])),
  }),
  result: Type.Object({
    roots: Type.Array(Type.String({ description: 'the new UIDs of the copies at the top' })),
    created: Type.Integer(),
    unbound: Type.Array(
      Type.Object({ object: Type.String(), what: Type.String(), ref: Type.String() }),
    ),
  }),
  errors: ['E_SCHEMA'],
  examples: [],
  apply(d, a) {
    const f = a.fragment as unknown as Fragment;
    if (f?.format !== FRAGMENT_FORMAT || f.version !== 1 || !Array.isArray(f.objects))
      throw new MochiError('E_SCHEMA', 'This is not a Mochi Maker fragment (version 1).', {
        path: 'args.fragment',
      });
    const intoPart = a.part ? d.getAs(a.part, 'part').uid : a.part === null ? null : undefined;
    const objs = f.objects.map((j, i) => {
      const kind = (j as { kind?: string }).kind as Kind;
      if (!['artMesh', 'warp', 'rotation', 'layer'].includes(kind))
        throw new MochiError('E_SCHEMA', `A fragment holds no ${String(kind)}.`, {
          path: `args.fragment.objects[${i}]`,
        });
      return decode<DocObject>(
        OBJECT_SCHEMAS[kind as keyof typeof OBJECT_SCHEMAS],
        j,
        `args.fragment.objects[${i}]`,
      );
    });
    const unbound: { object: string; what: string; ref: string }[] = [];
    // New UIDs; layers already here (same UID, same image) are reused.
    const map = new Map<UidT, UidT>();
    const reused = new Set<UidT>();
    for (const o of objs) {
      const here = d.get(o.uid);
      if (o.kind === 'layer' && here?.kind === 'layer' && here.asset === (o as Layer).asset) {
        map.set(o.uid, o.uid);
        reused.add(o.uid);
      } else map.set(o.uid, d.allocate(o.kind as 'artMesh' | 'warp' | 'rotation' | 'layer'));
    }
    // References outside the fragment.
    const outside = (ref: UidT): UidT | null => {
      const r = f.refs?.[ref];
      if (r?.kind === 'parameter') {
        const same = d.get(ref);
        if (same?.kind === 'parameter' && same.exportId === r.exportId) return ref;
        return d.ofKind('parameter').find((p) => p.exportId === r.exportId)?.uid ?? null;
      }
      const here = d.get(ref);
      return here && here.kind === (r?.kind ?? here.kind) ? ref : null;
    };
    const to = (ref: UidT | null): UidT | null =>
      ref === null ? null : (map.get(ref) ?? outside(ref));
    const name = (o: DocObject) => ('exportId' in o ? (o as { exportId: string }).exportId : o.uid);
    const fixRig = <
      T extends {
        rig: Rig<AnyKeyform>;
        blendShapes?: { parameter: UidT; constraints: { parameter: UidT }[] }[];
      },
    >(
      o: T,
    ): T => {
      let rig = o.rig;
      for (let b = rig.bindings.length - 1; b >= 0; b--) {
        const bind = rig.bindings[b]!;
        const p = to(bind.parameter);
        if (p) {
          rig = {
            ...rig,
            bindings: rig.bindings.map((x, j) => (j === b ? { ...x, parameter: p } : x)),
          };
          continue;
        }
        const r = f.refs?.[bind.parameter];
        unbound.push({
          object: name(o as unknown as DocObject),
          what: 'parameter',
          ref: r?.exportId ?? bind.parameter,
        });
        rig = grid.removeBinding(
          rig,
          b,
          grid.nearestKeyIndex(bind.keys, r?.default ?? bind.keys[0]!),
        );
      }
      const blendShapes = (o.blendShapes ?? [])
        .filter((s) => {
          if (to(s.parameter)) return true;
          unbound.push({
            object: name(o as unknown as DocObject),
            what: 'blend shape',
            ref: f.refs?.[s.parameter]?.exportId ?? s.parameter,
          });
          return false;
        })
        .map((s) => ({
          ...s,
          parameter: to(s.parameter)!,
          constraints: s.constraints
            .filter((c) => to(c.parameter))
            .map((c) => ({ ...c, parameter: to(c.parameter)! })),
        }));
      return { ...o, rig, ...(o.blendShapes ? { blendShapes } : {}) };
    };
    const roots = new Set(f.roots);
    let created = 0;
    for (const o of objs) {
      const uid = map.get(o.uid)!;
      if (o.kind === 'layer') {
        if (reused.has(o.uid)) continue;
        d.put({ ...(o as Layer), uid });
        d.updateProject((p) => ({ ...p, layerOrder: [...p.layerOrder, uid] }));
        created++;
        continue;
      }
      const kind = o.kind as 'artMesh' | 'warp' | 'rotation';
      const exportId = freeExportId(d, kind, (o as { exportId: string }).exportId);
      if (kind === 'artMesh') {
        const m = o as ArtMesh;
        const part = roots.has(m.uid) && intoPart !== undefined ? intoPart : to(m.part);
        if (m.part && !part && !(roots.has(m.uid) && intoPart !== undefined))
          unbound.push({
            object: m.exportId,
            what: 'part',
            ref: f.refs?.[m.part]?.exportId ?? m.part,
          });
        const deformer = to(m.deformer);
        if (m.deformer && !deformer)
          unbound.push({
            object: m.exportId,
            what: 'deformer',
            ref: f.refs?.[m.deformer]?.exportId ?? m.deformer,
          });
        const masks = (m.clip?.masks ?? []).filter((u) => {
          if (to(u)) return true;
          unbound.push({ object: m.exportId, what: 'mask', ref: f.refs?.[u]?.exportId ?? u });
          return false;
        });
        const next = fixRig({
          ...m,
          uid,
          exportId,
          part,
          deformer,
          layer: to(m.layer),
          clip: m.clip && masks.length ? { ...m.clip, masks: masks.map((u) => to(u)!) } : null,
        } as ArtMesh);
        d.put(next);
        placeInTree(d, uid, part);
      } else {
        const o2 = o as Warp | Rotation;
        const part = roots.has(o2.uid) && intoPart !== undefined ? intoPart : to(o2.part);
        const parent = to(o2.parent);
        if (o2.parent && !parent)
          unbound.push({
            object: o2.exportId,
            what: 'deformer',
            ref: f.refs?.[o2.parent]?.exportId ?? o2.parent,
          });
        d.put(fixRig({ ...o2, uid, exportId, part, parent } as Warp | Rotation) as DocObject);
        d.updateProject((p) => ({ ...p, deformerOrder: [...p.deformerOrder, uid] }));
      }
      created++;
    }
    return { roots: f.roots.map((u) => map.get(u)!), created, unbound };
  },
});
