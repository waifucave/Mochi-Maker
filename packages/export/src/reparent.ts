/**
 * Deformer operations (design 3.5, 3.6): reparenting that keeps things in place, and editing in
 * canvas space. Both resolve canvas positions to local values through Mochi2D's forward mapping
 * (see mapping.ts) and then change the document through ordinary commands, so the log holds the
 * resolved local values and replays without Mochi2D.
 *
 * Reparenting converts every keyform through the old and new parents at their rest forms (all
 * parameters at their defaults), so the object stays exactly in place at the rest pose. At other
 * poses it moves with the new parent, which is the point of reparenting. Blend-shape deltas are
 * converted at the rest keyform.
 */
import { Type } from '@sinclair/typebox';
import {
  DocReader,
  MochiError,
  RefOf,
  defineOperation,
  rig,
  type ArtMesh,
  type Binding,
  type DocObject,
  type OperationDef,
  type Rotation,
  type Uid,
  type Warp,
} from '@mochi-maker/core';
import type { ModelInstance, ValuePatch } from 'mochi2d/headless';
import { DeformerMapper, type Pose } from './mapping.js';

/** Canvas pixels: a converted point farther than this from where it was is refused. */
export const PLACE_TOLERANCE = 0.01;

type Deformer = Warp | Rotation;
type Pair = [number, number];

/** A reader with some objects replaced (for evaluating a change before making it). */
class Overlay extends DocReader {
  constructor(
    private readonly base: DocReader,
    private readonly over: ReadonlyMap<Uid, DocObject>,
  ) {
    super();
  }
  get(uid: Uid): DocObject | undefined {
    return this.over.has(uid) ? this.over.get(uid) : this.base.get(uid);
  }
  *all(): Iterable<DocObject> {
    for (const o of this.base.all()) yield this.over.get(o.uid) ?? o;
  }
}

/** The document with a deformer moved under a new parent, deformer order kept valid. */
function withDeformer(doc: DocReader, d: Deformer): Overlay {
  const over = new Map<Uid, DocObject>([[d.uid, d]]);
  const view = new Overlay(doc, over);
  const out: Uid[] = [];
  const placed = new Set<Uid>();
  const place = (u: Uid) => {
    if (placed.has(u)) return;
    const p = (view.get(u) as Deformer).parent;
    if (p !== null) place(p);
    placed.add(u);
    out.push(u);
  };
  doc.project().deformerOrder.forEach(place);
  over.set('project', { ...doc.project(), deformerOrder: out });
  return view;
}

const pairs = (a: ArrayLike<number>): Pair[] => {
  const out: Pair[] = [];
  for (let i = 0; i < a.length; i += 2) out.push([a[i]!, a[i + 1]!]);
  return out;
};

/** The keyform shown at the rest pose (each binding's key nearest its parameter's default). */
function restKeyform(doc: DocReader, o: { rig: { bindings: Binding[] } }): number {
  const coords = o.rig.bindings.map((b) =>
    rig.nearestKeyIndex(b.keys, doc.getAs(b.parameter, 'parameter').default),
  );
  return rig.cellIndex(o.rig.bindings, coords);
}

/** The cell (parameter → key) of keyform `index`, or undefined when unbound. */
export function cellOf(
  o: { rig: { bindings: Binding[] } },
  index: number,
): Record<Uid, number> | undefined {
  if (o.rig.bindings.length === 0) return undefined;
  const coords = rig.cellCoords(o.rig.bindings, index);
  return Object.fromEntries(o.rig.bindings.map((b, j) => [b.parameter, b.keys[coords[j]!]!]));
}

/** Points through `from` to the canvas, then back into `to`, refusing points that do not land. */
function convertPoints(
  mapper: DeformerMapper,
  from: Uid | null,
  to: Uid | null,
  local: ArrayLike<number>,
  what: string,
): Float64Array {
  const canvas = mapper.toCanvas(from, local);
  const r = mapper.toLocal(to, canvas);
  if (!(r.maxError <= PLACE_TOLERANCE))
    throw new MochiError(
      'E_RANGE',
      `${what} cannot be placed in the new parent's space: a point stays ${r.maxError.toFixed(3)} px away (the parent folds or collapses there).`,
    );
  return r.points;
}

/** Converted deltas: the change of a point's new local value when its old one moves by the delta. */
function convertDeltas(
  mapper: DeformerMapper,
  from: Uid | null,
  to: Uid | null,
  base: ArrayLike<number>,
  delta: ArrayLike<number>,
  baseNew: Float64Array,
  what: string,
): Pair[] {
  const moved = Float64Array.from(base, (v, i) => v + delta[i]!);
  const m = convertPoints(mapper, from, to, moved, what);
  return pairs(m.map((v, i) => v - baseNew[i]!));
}

/**
 * The largest distance any mesh vertex moves at the rest pose between two evaluations, among the
 * meshes drawn in both (a mesh moved under a disabled deformer is hidden, not moved).
 */
function maxShift(a: DeformerMapper, b: DeformerMapper): number {
  const va = a.meshVertices();
  const vb = b.meshVertices();
  let max = 0;
  for (const [u, p] of va) {
    const q = vb.get(u);
    if (!q) continue;
    for (let i = 0; i < p.length; i += 2)
      max = Math.max(max, Math.hypot(p[i]! - q[i]!, p[i + 1]! - q[i + 1]!));
  }
  return max;
}

// ---------------------------------------------------------------- conversions

export interface Conversion {
  converted: {
    keyforms: Record<string, unknown>[];
    blendShapes?: Record<string, unknown>[][];
  };
  /** Largest on-screen movement of any mesh vertex at the rest pose, pixels. */
  maxShift: number;
}

/** Positions of a mesh in another deformer's space, so it stays in place at the rest pose. */
export function convertMesh(doc: DocReader, mesh: ArtMesh, to: Uid | null): Conversion {
  const mapper = new DeformerMapper(doc);
  const from = mesh.deformer;
  const what = doc.describe(mesh.uid);
  const news = mesh.rig.keyforms.map((k) => convertPoints(mapper, from, to, k.positions, what));
  const rest = restKeyform(doc, mesh);
  const blendShapes = mesh.blendShapes.map((s) =>
    s.deltas.map((d) => ({
      positions: convertDeltas(
        mapper,
        from,
        to,
        mesh.rig.keyforms[rest]!.positions,
        d.positions,
        news[rest]!,
        what,
      ),
    })),
  );
  const converted = {
    keyforms: news.map((p) => ({ positions: pairs(p) })),
    ...(blendShapes.length ? { blendShapes } : {}),
  };
  const after = new Overlay(
    doc,
    new Map([
      [
        mesh.uid,
        {
          ...mesh,
          deformer: to,
          rig: {
            bindings: mesh.rig.bindings,
            keyforms: mesh.rig.keyforms.map((k, i) => ({
              ...k,
              positions: Float32Array.from(news[i]!),
            })),
          },
        },
      ],
    ]),
  );
  return { converted, maxShift: maxShift(mapper, new DeformerMapper(after)) };
}

/** A rotation's world frame at the latest evaluation: origin, angle (degrees) and scale. */
function frame(inst: ModelInstance, di: number) {
  const p = inst.mapPoints(di, [0, 0], 'keyform');
  const j = inst.mapJacobians(di, [0, 0], 'keyform');
  return {
    x: p[0]!,
    y: p[1]!,
    angle: (Math.atan2(j[2]!, j[0]!) * 180) / Math.PI,
    scale: Math.sqrt(Math.abs(j[0]! * j[3]! - j[1]! * j[2]!)),
  };
}

/** Sets every keyform of a lowered rotation to one set of values, and evaluates. */
function setRotation(
  mapper: DeformerMapper,
  di: number,
  v: { angle: number; originX: number; originY: number; scale: number },
): void {
  const data = mapper.lowered.data;
  const ki = data.deformers.kindIndex[di]!;
  const start = data.rotationDeformers.firstKeyform[ki]!;
  const count = data.rotationDeformers.keyformCount[ki]!;
  const patches: ValuePatch[] = (['angle', 'originX', 'originY', 'scale'] as const).map((f) => ({
    group: 'rotationKeyforms',
    field: f,
    start,
    values: new Array<number>(count).fill(v[f]),
  }));
  mapper.instance.patch(patches);
  mapper.instance.evaluate();
}

const wrap = (deg: number) => deg - 360 * Math.round(deg / 360);

/** A deformer's keyforms in a new parent's space, so it (and its children) stay in place. */
export function convertDeformer(doc: DocReader, d: Deformer, to: Uid | null): Conversion {
  const mapper = new DeformerMapper(doc);
  const from = d.parent;
  const what = doc.describe(d.uid);
  const rest = restKeyform(doc, d);
  if (d.kind === 'warp') {
    const news = d.rig.keyforms.map((k) => convertPoints(mapper, from, to, k.grid, what));
    const blendShapes = d.blendShapes.map((s) =>
      s.deltas.map((dl) => ({
        grid: convertDeltas(
          mapper,
          from,
          to,
          d.rig.keyforms[rest]!.grid,
          dl.grid,
          news[rest]!,
          what,
        ),
      })),
    );
    const moved: Warp = {
      ...d,
      parent: to,
      rig: {
        bindings: d.rig.bindings,
        keyforms: d.rig.keyforms.map((k, i) => ({ ...k, grid: Float32Array.from(news[i]!) })),
      },
    };
    return {
      converted: {
        keyforms: news.map((g) => ({ grid: pairs(g) })),
        ...(blendShapes.length ? { blendShapes } : {}),
      },
      maxShift: maxShift(mapper, new DeformerMapper(withDeformer(doc, moved))),
    };
  }

  // A rotation: its origin is a point of the parent's space; its angle and scale are matched by
  // measuring its world frame before and after, through the evaluator itself.
  const c = doc.project().canvas;
  const lowerOrigin = (parent: Uid | null, x: number, y: number) =>
    parent === null
      ? [(x - c.originX) / c.pixelsPerUnit, (y - c.originY) / c.pixelsPerUnit]
      : [x, y];
  const factor = (view: DocReader, parent: Uid | null) => {
    for (let p = parent; p !== null; p = (view.get(p) as Deformer).parent)
      if (view.get(p)!.kind === 'rotation') return 1;
    return 1 / c.pixelsPerUnit;
  };
  const di = mapper.deformerIndex(d.uid);
  const origins = d.rig.keyforms.map((k) =>
    convertPoints(mapper, from, to, [k.originX, k.originY], what),
  );
  const before = d.rig.keyforms.map((k) => {
    const [ox, oy] = lowerOrigin(from, k.originX, k.originY);
    setRotation(mapper, di, {
      angle: k.angle,
      originX: ox!,
      originY: oy!,
      scale: k.scale * factor(doc, from),
    });
    return frame(mapper.instance, di);
  });
  const placed: Rotation = {
    ...d,
    parent: to,
    rig: {
      bindings: d.rig.bindings,
      keyforms: d.rig.keyforms.map((k, i) => ({
        ...k,
        originX: origins[i]![0]!,
        originY: origins[i]![1]!,
      })),
    },
  };
  const view = withDeformer(doc, placed);
  const after = new DeformerMapper(view);
  const fB = factor(view, to);
  const dB = after.deformerIndex(d.uid);
  const values = d.rig.keyforms.map((k, i) => {
    let angle = k.angle;
    let scale = k.scale;
    const [ox, oy] = lowerOrigin(to, origins[i]![0]!, origins[i]![1]!);
    for (let it = 0; it < 4; it++) {
      setRotation(after, dB, { angle, originX: ox!, originY: oy!, scale: scale * fB });
      const f = frame(after.instance, dB);
      const dAngle = wrap(before[i]!.angle - f.angle);
      const ratio = f.scale === 0 ? 1 : before[i]!.scale / f.scale;
      if (Math.abs(dAngle) < 1e-5 && Math.abs(ratio - 1) < 1e-7) break;
      angle += dAngle;
      scale *= ratio;
    }
    return { originX: origins[i]![0]!, originY: origins[i]![1]!, angle, scale };
  });
  const r = values[rest]!;
  const ratio = r.scale / (d.rig.keyforms[rest]!.scale || 1);
  const restOrigin = [d.rig.keyforms[rest]!.originX, d.rig.keyforms[rest]!.originY];
  const blendShapes = d.blendShapes.map((s) =>
    s.deltas.map((dl) => {
      const [dx, dy] = convertDeltas(
        mapper,
        from,
        to,
        restOrigin,
        [dl.originX, dl.originY],
        Float64Array.of(r.originX, r.originY),
        what,
      )[0]!;
      return { originX: dx, originY: dy, angle: dl.angle, scale: dl.scale * ratio };
    }),
  );
  const final: Rotation = {
    ...placed,
    rig: {
      bindings: d.rig.bindings,
      keyforms: placed.rig.keyforms.map((k, i) => ({
        ...k,
        angle: Math.fround(values[i]!.angle),
        scale: Math.fround(values[i]!.scale),
      })),
    },
  };
  return {
    converted: { keyforms: values, ...(blendShapes.length ? { blendShapes } : {}) },
    maxShift: maxShift(new DeformerMapper(doc), new DeformerMapper(withDeformer(doc, final))),
  };
}

// ---------------------------------------------------------------- operations

const Shift = Type.Number({
  description:
    'the largest distance any mesh vertex moved on the canvas at the rest pose, pixels, among the meshes drawn before and after (0 up to float32 rounding when everything stays in place)',
});

export const meshReparent = defineOperation({
  name: 'mesh.reparent',
  summary: 'Attach a mesh to a deformer (or none), converting its positions so it stays in place.',
  doc: `Converts every keyform's positions (and the position deltas of its blend shapes) from the
current deformer's space to the new one's, through both at their rest forms (every parameter at its
default), then records mesh.setDeformer with the converted values. The mesh stays in place at the
rest pose and moves with its new deformer at other poses. Fails with E_RANGE when a vertex has no
place in the new deformer's space (it folds or collapses there).`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    deformer: Type.Union([RefOf(['warp', 'rotation']), Type.Null()]),
  }),
  result: Type.Object({ keyforms: Type.Integer(), maxShift: Shift }),
  errors: ['E_RANGE'],
  examples: [
    {
      description: 'Put the mouth into the face warp, in place',
      args: { target: '@mesh:ArtMesh_Mouth', deformer: '@warp:Warp_Face' },
    },
  ],
  async run(_ctx, tx, a) {
    const d = tx.draft;
    const mesh = d.getAs(a.target, 'artMesh');
    const to = a.deformer === null ? null : d.getAs(a.deformer, ['warp', 'rotation']).uid;
    if (mesh.deformer === to) return { result: { keyforms: 0, maxShift: 0 } };
    const c = convertMesh(d, mesh, to);
    tx.run('mesh.setDeformer', { target: mesh.uid, deformer: to, converted: c.converted as never });
    return { result: { keyforms: mesh.rig.keyforms.length, maxShift: c.maxShift } };
  },
});

export const deformerReparent = defineOperation({
  name: 'deformer.reparent',
  summary:
    'Attach a deformer to another deformer (or none), converting its keyforms so it and its children stay in place.',
  doc: `Converts the deformer's keyforms from its current parent's space to the new parent's, through
both at their rest forms, then records deformer.setParent with the converted values:
- a warp's grid points are mapped point by point;
- a rotation's origin is mapped, and its angle and scale are set so its world frame (origin,
  direction and size) is unchanged, measured through the evaluator. Rotation scale stays unit-free
  in the document: the exporter applies the pixels-per-unit factor.

Children keep their stored values. Under a rotation they stay exactly in place; under a warp they
stay exactly in place at its grid points and to within \`maxShift\` between them, since a warp's
cells interpolate in the parent's space. Fails with E_CYCLE when the new parent is the deformer or
below it.`,
  args: Type.Object({
    target: RefOf(['warp', 'rotation']),
    parent: Type.Union([RefOf(['warp', 'rotation']), Type.Null()]),
  }),
  result: Type.Object({ keyforms: Type.Integer(), maxShift: Shift }),
  errors: ['E_RANGE', 'E_CYCLE'],
  examples: [
    {
      description: 'Put the face warp under the head rotation, in place',
      args: { target: '@warp:Warp_Face', parent: '@rot:Rotation_Head' },
    },
  ],
  async run(_ctx, tx, a) {
    const d = tx.draft;
    const o = d.getAs(a.target, ['warp', 'rotation']);
    const to = a.parent === null ? null : d.getAs(a.parent, ['warp', 'rotation']).uid;
    if (o.parent === to) return { result: { keyforms: 0, maxShift: 0 } };
    for (let p: Uid | null = to; p !== null; p = (d.get(p) as Deformer).parent)
      if (p === o.uid)
        throw new MochiError('E_CYCLE', `${d.describe(o.uid)} cannot be attached below itself.`, {
          path: 'args.parent',
        });
    const c = convertDeformer(d, o, to);
    tx.run('deformer.setParent', { target: o.uid, parent: to, converted: c.converted as never });
    return { result: { keyforms: o.rig.keyforms.length, maxShift: c.maxShift } };
  },
});

export const keyformMoveInCanvas = defineOperation({
  name: 'keyform.moveInCanvas',
  summary: 'Move mesh vertices, warp grid points or a rotation origin in canvas pixels.',
  doc: `Edits one keyform in canvas space: the points move on the canvas by \`offset\`, or to
\`positions\` (one [x, y] per listed point), as the deformers above the object have them at the
cell's pose (the cell's keys, every other parameter at its default). The new canvas positions are
mapped back through the deformer chain (a Newton inverse of Mochi2D's forward mapping), and
keyform.set records the resolved local values. \`points\` lists vertex or grid-point indices
(default: all); a rotation has one point, its origin. Fails with E_RANGE when a target has no
place in the parent's space.`,
  args: Type.Object({
    target: RefOf(['artMesh', 'warp', 'rotation']),
    cell: Type.Optional(Type.Record(Type.String(), Type.Number())),
    points: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
    offset: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
    positions: Type.Optional(Type.Array(Type.Tuple([Type.Number(), Type.Number()]))),
  }),
  result: Type.Object({
    moved: Type.Integer(),
    maxError: Type.Number({ description: 'largest canvas distance from a target, pixels' }),
  }),
  errors: ['E_RANGE', 'E_SHAPE', 'E_BAD_CELL'],
  examples: [
    {
      description: 'Raise two vertices of a mesh inside a warp by 6 px on screen',
      args: {
        target: '@mesh:ArtMesh_Mouth',
        cell: { '@param:ParamMouthOpenY': 1 },
        points: [3, 4],
        offset: [0, -6],
      },
    },
  ],
  async run(_ctx, tx, a) {
    const d = tx.draft;
    const o = d.getAs(a.target, ['artMesh', 'warp', 'rotation']);
    if ((a.offset === undefined) === (a.positions === undefined))
      throw new MochiError('E_SHAPE', 'Give either `offset` or `positions`.', { path: 'args' });
    // Find the keyform (keyform.set checks the cell again when it records).
    const cellArg = a.cell ?? {};
    const cell: Record<Uid, number> = {};
    for (const [k, v] of Object.entries(cellArg)) {
      const p = d.resolve(k, ['parameter'], `args.cell.${k}`);
      if (!o.rig.bindings.some((b) => b.parameter === p))
        throw new MochiError(
          'E_BAD_CELL',
          `${d.describe(o.uid)} is not bound to ${d.describe(p)}.`,
          {
            path: `args.cell.${k}`,
          },
        );
      cell[p] = v;
    }
    const coords = o.rig.bindings.map((b) => {
      const i = b.keys.indexOf(Math.fround(cell[b.parameter] ?? NaN));
      if (i < 0)
        throw new MochiError(
          'E_BAD_CELL',
          `The cell must give one of the keys of ${d.describe(b.parameter)} (${b.keys.join(', ')}).`,
          { path: `args.cell.${b.parameter}` },
        );
      return i;
    });
    const index = rig.cellIndex(o.rig.bindings, coords);
    const k = o.rig.keyforms[index]!;
    const parent = o.kind === 'artMesh' ? o.deformer : o.parent;
    const local =
      o.kind === 'artMesh'
        ? Float64Array.from((k as ArtMesh['rig']['keyforms'][number]).positions)
        : o.kind === 'warp'
          ? Float64Array.from((k as Warp['rig']['keyforms'][number]).grid)
          : Float64Array.of(
              (k as Rotation['rig']['keyforms'][number]).originX,
              (k as Rotation['rig']['keyforms'][number]).originY,
            );
    const n = local.length / 2;
    const list = a.points ?? [...Array(n).keys()];
    const bad = list.find((i) => i >= n);
    if (bad !== undefined)
      throw new MochiError('E_SHAPE', `${d.describe(o.uid)} has no point ${bad} (it has ${n}).`, {
        path: 'args.points',
      });
    if (a.positions && a.positions.length !== list.length)
      throw new MochiError(
        'E_SHAPE',
        `positions needs ${list.length} points, got ${a.positions.length}.`,
        { path: 'args.positions' },
      );
    const pose: Pose = Object.fromEntries(
      o.rig.bindings.map((b, j) => [b.parameter, b.keys[coords[j]!]!]),
    );
    const mapper = new DeformerMapper(d, pose);
    const sub = Float64Array.from(list.flatMap((i) => [local[2 * i]!, local[2 * i + 1]!]));
    const canvas = mapper.toCanvas(parent, sub);
    const target = a.positions
      ? Float64Array.from(a.positions.flat())
      : canvas.map((v, i) => v + a.offset![i % 2]!);
    const r = mapper.toLocal(parent, target, sub);
    if (!(r.maxError <= PLACE_TOLERANCE))
      throw new MochiError(
        'E_RANGE',
        `A point of ${d.describe(o.uid)} cannot reach its canvas position: it stays ${r.maxError.toFixed(3)} px away.`,
      );
    const next = Float64Array.from(local);
    list.forEach((p, j) => {
      next[2 * p] = r.points[2 * j]!;
      next[2 * p + 1] = r.points[2 * j + 1]!;
    });
    const values =
      o.kind === 'artMesh'
        ? { positions: pairs(next) }
        : o.kind === 'warp'
          ? { grid: pairs(next) }
          : { originX: next[0]!, originY: next[1]! };
    tx.run('keyform.set', {
      target: o.uid,
      ...(o.rig.bindings.length ? { cell: cellOf(o, index)! } : {}),
      values,
    });
    return { result: { moved: list.length, maxError: r.maxError } };
  },
});

export const deformerRemove = defineOperation({
  name: 'deformer.remove',
  summary:
    'Delete a deformer, moving its children to its parent in place (converted, as the reparent operations do).',
  doc: `Every mesh and deformer directly inside the deformer moves to the deformer's parent through
the same conversion as mesh.reparent and deformer.reparent, so it stays in place at the rest pose;
then the deformer is deleted with deformer.delete. Unlike deformer.delete with cascade, which keeps
the children's stored values (so they jump), this keeps them where they are. \`maxShift\` is the
largest of the conversions' shifts.`,
  args: Type.Object({ target: RefOf(['warp', 'rotation']) }),
  result: Type.Object({
    meshes: Type.Integer({ description: 'meshes moved to the parent' }),
    deformers: Type.Integer({ description: 'deformers moved to the parent' }),
    maxShift: Shift,
  }),
  errors: ['E_RANGE'],
  examples: [
    {
      description: 'Remove the face warp, keeping the face where it is',
      args: { target: '@warp:Warp_Face' },
    },
  ],
  async run(_ctx, tx, a) {
    const d = tx.draft;
    const o = d.getAs(a.target, ['warp', 'rotation']);
    const to = o.parent;
    let [meshes, deformers, shift] = [0, 0, 0];
    for (const m of d.ofKind('artMesh').filter((x) => x.deformer === o.uid)) {
      const c = convertMesh(d, d.getAs(m.uid, 'artMesh'), to);
      tx.run('mesh.setDeformer', { target: m.uid, deformer: to, converted: c.converted as never });
      shift = Math.max(shift, c.maxShift);
      meshes++;
    }
    for (const c0 of d.ofKind(['warp', 'rotation']).filter((x) => x.parent === o.uid)) {
      const child = d.getAs(c0.uid, ['warp', 'rotation']);
      const c = convertDeformer(d, child, to);
      tx.run('deformer.setParent', {
        target: child.uid,
        parent: to,
        converted: c.converted as never,
      });
      shift = Math.max(shift, c.maxShift);
      deformers++;
    }
    tx.run('deformer.delete', { target: o.uid });
    return { result: { meshes, deformers, maxShift: shift } };
  },
});

/** The operations that need Mochi2D's mapping (they live here, next to the lowering). */
export const DEFORMER_OPERATIONS: readonly OperationDef[] = [
  meshReparent,
  deformerReparent,
  keyformMoveInCanvas,
  deformerRemove,
];
