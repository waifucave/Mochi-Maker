import { Type } from '@sinclair/typebox';
import { Empty, Uid, defineCommand } from '../command.js';
import type { Draft } from '../document.js';
import { MochiError } from '../errors.js';
import { f32 } from '../f32.js';
import type { Deformer, Rotation, Uid as UidT, Warp } from '../model.js';
import { RefOf } from '../schema.js';
import {
  BLACK,
  Converted,
  WHITE,
  deleteObject,
  f32Array,
  isAncestor,
  newExportId,
  withConverted,
} from './helpers.js';

const parentOf = (o: { kind: string; parent?: unknown }) =>
  o.kind === 'warp' || o.kind === 'rotation' ? ((o as Deformer).parent ?? null) : null;

/** Re-sorts deformerOrder so parents come before children, keeping the existing order otherwise. */
function sortDeformers(d: Draft): void {
  const order = d.project().deformerOrder;
  const out: UidT[] = [];
  const placed = new Set<UidT>();
  const place = (u: UidT) => {
    if (placed.has(u)) return;
    const p = (d.get(u) as Deformer).parent;
    if (p !== null) place(p);
    placed.add(u);
    out.push(u);
  };
  order.forEach(place);
  d.updateProject((p) => ({ ...p, deformerOrder: out }));
}

function regularGrid(
  rows: number,
  cols: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Float32Array {
  const pts: number[] = [];
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++) pts.push(x + (w * c) / cols, y + (h * r) / rows);
  return f32Array(pts);
}

const Common = {
  exportId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  part: Type.Optional(Type.Union([RefOf(['part']), Type.Null()], { description: 'owning part' })),
  parent: Type.Optional(Type.Union([RefOf(['warp', 'rotation']), Type.Null()])),
};

export const warpCreate = defineCommand({
  name: 'deformer.createWarp',
  summary: 'Create a warp deformer with a regular grid over a rectangle.',
  doc: `Creates a warp with \`rows\` × \`cols\` cells. Its rest grid spans \`rect\`, given in the parent's
space: canvas pixels at the top level, (u, v) inside a warp (default: the whole 0–1 square), or
pixels around the origin inside a rotation (rect required). Children of a warp use normalized
(u, v) coordinates. \`cellMode\` 'bilinear' or 'triangles' (default 'bilinear').`,
  args: Type.Object({
    ...Common,
    rows: Type.Integer({ minimum: 1, maximum: 256 }),
    cols: Type.Integer({ minimum: 1, maximum: 256 }),
    cellMode: Type.Optional(Type.Union([Type.Literal('triangles'), Type.Literal('bilinear')])),
    rect: Type.Optional(
      Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number(),
        height: Type.Number(),
      }),
    ),
  }),
  result: Uid,
  errors: ['E_RANGE', 'E_DUPLICATE_ID'],
  examples: [
    {
      description: 'A 5×5 face warp',
      args: {
        exportId: 'Warp_Face',
        rows: 5,
        cols: 5,
        rect: { x: 700, y: 300, width: 600, height: 700 },
      },
    },
  ],
  apply(d, a) {
    const parent = a.parent ? d.getAs(a.parent, ['warp', 'rotation']) : null;
    let rect = a.rect;
    if (!rect) {
      if (parent?.kind === 'rotation')
        throw new MochiError(
          'E_RANGE',
          'A warp inside a rotation needs a rect (pixels around the rotation origin).',
          { path: 'args.rect' },
        );
      const c = d.project().canvas;
      rect = parent
        ? { x: 0, y: 0, width: 1, height: 1 }
        : { x: 0, y: 0, width: c.width, height: c.height };
    }
    const uid = d.allocate('warp');
    const exportId = newExportId(d, 'warp', uid, a.exportId);
    const w: Warp = {
      kind: 'warp',
      uid,
      exportId,
      name: a.name ?? exportId,
      part: a.part ?? null,
      parent: parent?.uid ?? null,
      enabled: true,
      rows: a.rows,
      cols: a.cols,
      cellMode: a.cellMode ?? 'bilinear',
      blendShapes: [],
      rig: {
        bindings: [],
        keyforms: [
          {
            authored: true,
            grid: regularGrid(a.rows, a.cols, rect.x, rect.y, rect.width, rect.height),
            opacity: 1,
            multiply: [...WHITE],
            screen: [...BLACK],
          },
        ],
      },
    };
    d.put(w);
    d.updateProject((p) => ({ ...p, deformerOrder: [...p.deformerOrder, uid] }));
    return { uid };
  },
});

export const rotationCreate = defineCommand({
  name: 'deformer.createRotation',
  summary: 'Create a rotation deformer at an origin.',
  doc: `\`origin\` is in the parent's space (canvas pixels at the top level). Children of a rotation are
stored in canvas pixels relative to the origin, and its scale 1 means natural size.`,
  args: Type.Object({
    ...Common,
    origin: Type.Object({ x: Type.Number(), y: Type.Number() }),
    baseAngle: Type.Optional(Type.Number({ description: 'degrees' })),
  }),
  result: Uid,
  errors: ['E_DUPLICATE_ID'],
  examples: [
    {
      description: 'A neck pivot',
      args: { exportId: 'Rotation_Neck', origin: { x: 1024, y: 1200 } },
    },
  ],
  apply(d, a) {
    const parent = a.parent ? d.getAs(a.parent, ['warp', 'rotation']) : null;
    const uid = d.allocate('rotation');
    const exportId = newExportId(d, 'rotation', uid, a.exportId);
    const r: Rotation = {
      kind: 'rotation',
      uid,
      exportId,
      name: a.name ?? exportId,
      part: a.part ?? null,
      parent: parent?.uid ?? null,
      enabled: true,
      baseAngle: f32(a.baseAngle ?? 0),
      blendShapes: [],
      rig: {
        bindings: [],
        keyforms: [
          {
            authored: true,
            angle: 0,
            originX: f32(a.origin.x),
            originY: f32(a.origin.y),
            scale: 1,
            mirrorX: false,
            mirrorY: false,
            opacity: 1,
            multiply: [...WHITE],
            screen: [...BLACK],
          },
        ],
      },
    };
    d.put(r);
    d.updateProject((p) => ({ ...p, deformerOrder: [...p.deformerOrder, uid] }));
    return { uid };
  },
});

export const deformerUpdate = defineCommand({
  name: 'deformer.update',
  summary:
    'Change a deformer’s enabled flag, owning part, cell mode (warp) or base angle (rotation).',
  doc: 'A disabled deformer hides everything it moves. A deformer is also inactive when its owning part is.',
  args: Type.Object({
    target: RefOf(['warp', 'rotation']),
    enabled: Type.Optional(Type.Boolean()),
    part: Type.Optional(Type.Union([RefOf(['part']), Type.Null()])),
    cellMode: Type.Optional(Type.Union([Type.Literal('triangles'), Type.Literal('bilinear')])),
    baseAngle: Type.Optional(Type.Number()),
  }),
  result: Empty,
  errors: ['E_FIELD_NOT_APPLICABLE'],
  examples: [
    { description: 'Triangle cells', args: { target: '@warp:Warp_Face', cellMode: 'triangles' } },
  ],
  apply(d, a) {
    const o = d.getAs(a.target, ['warp', 'rotation']);
    if (o.kind === 'rotation' && a.cellMode !== undefined)
      throw new MochiError('E_FIELD_NOT_APPLICABLE', 'Rotation deformers have no cell mode.', {
        path: 'args.cellMode',
      });
    if (o.kind === 'warp' && a.baseAngle !== undefined)
      throw new MochiError('E_FIELD_NOT_APPLICABLE', 'Warp deformers have no base angle.', {
        path: 'args.baseAngle',
      });
    const common = {
      enabled: a.enabled ?? o.enabled,
      part: a.part === undefined ? o.part : a.part,
    };
    if (o.kind === 'warp') d.put({ ...o, ...common, cellMode: a.cellMode ?? o.cellMode });
    else
      d.put({
        ...o,
        ...common,
        baseAngle: a.baseAngle === undefined ? o.baseAngle : f32(a.baseAngle),
      });
    return {};
  },
});

export const deformerSetParent = defineCommand({
  name: 'deformer.setParent',
  summary: 'Attach a deformer to another deformer (or none), with its values as given.',
  doc: `Changes the parent deformer. Without \`converted\`, stored values are kept, so the deformer and its
children move on screen. \`converted\` gives the keyform values (and blend-shape deltas) in the new
parent's space: a warp's \`grid\`, a rotation's \`originX\`, \`originY\`, \`angle\` and \`scale\`. The
deformer.reparent operation computes them so the deformer stays in place, and records this command.`,
  args: Type.Object({
    target: RefOf(['warp', 'rotation']),
    parent: Type.Union([RefOf(['warp', 'rotation']), Type.Null()]),
    converted: Type.Optional(Converted),
  }),
  result: Empty,
  errors: ['E_CYCLE', 'E_SHAPE', 'E_FIELD_NOT_APPLICABLE'],
  examples: [
    {
      description: 'Put the face warp under the head rotation',
      args: { target: '@warp:Warp_Face', parent: '@rot:Rotation_Head' },
    },
  ],
  apply(d, a) {
    const o = d.getAs(a.target, ['warp', 'rotation']);
    if (isAncestor(d, o.uid, a.parent, parentOf))
      throw new MochiError('E_CYCLE', `${d.describe(o.uid)} cannot be attached below itself.`, {
        path: 'args.parent',
      });
    const moved = { ...o, parent: a.parent };
    d.put(a.converted ? withConverted(moved, a.converted) : moved);
    sortDeformers(d);
    return {};
  },
});

export const deformerDelete = defineCommand({
  name: 'deformer.delete',
  summary: 'Delete a deformer. With cascade, its children move to its parent.',
  doc: `Without \`cascade\`, the deformer must have no child deformers or meshes. With \`cascade\`, children
are attached to the deleted deformer's parent, keeping their stored values (so they move on screen).`,
  args: Type.Object({
    target: RefOf(['warp', 'rotation']),
    cascade: Type.Optional(Type.Boolean()),
  }),
  result: Empty,
  errors: ['E_IN_USE'],
  examples: [{ description: 'Delete a warp', args: { target: '@warp:Warp_Old', cascade: true } }],
  apply(d, a) {
    const o = d.getAs(a.target, ['warp', 'rotation']);
    const deformerChildren = d.ofKind(['warp', 'rotation']).filter((c) => c.parent === o.uid);
    const meshChildren = d.ofKind('artMesh').filter((m) => m.deformer === o.uid);
    if (!a.cascade && deformerChildren.length + meshChildren.length > 0)
      throw new MochiError(
        'E_IN_USE',
        `${d.describe(o.uid)} has ${deformerChildren.length} child deformer(s) and ${meshChildren.length} mesh(es).`,
        {
          fixes: [
            {
              description: 'Delete it and attach its children to its parent',
              command: 'deformer.delete',
              args: { target: o.uid, cascade: true },
            },
          ],
        },
      );
    for (const c of deformerChildren) d.put({ ...c, parent: o.parent });
    for (const m of meshChildren) d.put({ ...m, deformer: o.parent });
    deleteObject(d, o.uid, a.cascade ?? false, 'deformer.delete');
    return {};
  },
});
