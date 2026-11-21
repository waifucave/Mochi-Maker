/**
 * Blend-shape commands (design 3.7; §1c.4): difference-based interpolation is
 * not available in this build unless the `blendShapes` feature is on.
 *
 * A blend shape on a target (art mesh, warp, rotation or part) has a blend-shape parameter, a
 * subset of its keys, a base key and one delta per key; the base key's delta is always zero. At
 * evaluation the target gets w·s added to its normal result: s interpolates the deltas at the
 * parameter's value, and w is the minimum of the constraint curves (1 without constraints).
 */
import { Type } from '@sinclair/typebox';
import { Empty, defineCommand } from '../command.js';
import type { Draft } from '../document.js';
import { MochiError } from '../errors.js';
import { f32 } from '../f32.js';
import type { AnyDelta, BlendShape, BlendShapeConstraint, ShapeTarget, Uid } from '../model.js';
import { nearestKeyIndex } from '../rig.js';
import { RefOf } from '../schema.js';
import { checkKeysOnParameter, f32Array } from './helpers.js';

const TARGETS = ['artMesh', 'warp', 'rotation', 'part', 'glue'] as const;

const FIELDS: Record<ShapeTarget['kind'], string[]> = {
  artMesh: ['positions', 'opacity', 'drawOrder', 'multiply', 'screen'],
  warp: ['grid', 'opacity', 'multiply', 'screen'],
  rotation: ['angle', 'originX', 'originY', 'scale', 'opacity', 'multiply', 'screen'],
  part: ['drawOrder', 'opacity', 'multiply', 'screen'],
  glue: ['intensity'],
};

/** An all-zero delta for a target. */
export function zeroDelta(o: ShapeTarget): AnyDelta {
  const zero3 = (): [number, number, number] => [0, 0, 0];
  switch (o.kind) {
    case 'artMesh':
      return {
        positions: new Float32Array(o.uv.length),
        opacity: 0,
        drawOrder: 0,
        multiply: zero3(),
        screen: zero3(),
      };
    case 'warp':
      return {
        grid: new Float32Array(2 * (o.rows + 1) * (o.cols + 1)),
        opacity: 0,
        multiply: zero3(),
        screen: zero3(),
      };
    case 'rotation':
      return {
        angle: 0,
        originX: 0,
        originY: 0,
        scale: 0,
        opacity: 0,
        multiply: zero3(),
        screen: zero3(),
      };
    case 'part':
      return { drawOrder: 0, opacity: 0, multiply: zero3(), screen: zero3() };
    case 'glue':
      return { intensity: 0 };
  }
}

function getTarget(d: Draft, uid: Uid): ShapeTarget {
  const o = d.get(uid);
  if (!o || !(TARGETS as readonly string[]).includes(o.kind))
    throw new MochiError(
      'E_WRONG_KIND',
      `${d.describe(uid)} cannot carry blend shapes (art meshes, warps, rotations, parts and glues can).`,
      { path: 'args.target' },
    );
  return o as ShapeTarget;
}

function blendShapeParameter(d: Draft, uid: Uid, path: string) {
  const p = d.getAs(uid, 'parameter');
  if (p.type !== 'blendShape')
    throw new MochiError(
      'E_RANGE',
      `${p.exportId} is a normal parameter; blend shapes need a blend-shape parameter.`,
      {
        path,
        fixes: [
          {
            description: 'Create a blend-shape parameter',
            command: 'param.create',
            args: { min: p.min, max: p.max, default: p.default, keys: p.keys, type: 'blendShape' },
          },
        ],
      },
    );
  return p;
}

function findShape(d: Draft, o: ShapeTarget, parameter: Uid): number {
  const i = o.blendShapes.findIndex((b) => b.parameter === parameter);
  if (i < 0)
    throw new MochiError(
      'E_NOT_BOUND',
      `${d.describe(o.uid)} has no blend shape on ${d.describe(parameter)}.`,
      {
        path: 'args.parameter',
        fixes: [
          {
            description: 'Add the blend shape first',
            command: 'blendShape.add',
            args: { target: o.uid, parameter },
          },
        ],
      },
    );
  return i;
}

function withShapes(o: ShapeTarget, blendShapes: BlendShape[]): ShapeTarget {
  return { ...o, blendShapes } as ShapeTarget;
}

function chooseBase(keys: number[], base: number | undefined, fallback: number, path: string) {
  if (base === undefined) return keys[nearestKeyIndex(keys, fallback)]!;
  const b = f32(base);
  if (!keys.includes(b))
    throw new MochiError('E_RANGE', `The base ${b} must be one of the keys (${keys.join(', ')}).`, {
      path,
    });
  return b;
}

export const blendShapeAdd = defineCommand({
  name: 'blendShape.add',
  summary: 'Add a blend shape to a mesh, warp, rotation, part or glue.',
  doc: `Adds a blend shape over a blend-shape parameter, with an all-zero delta at every key, so nothing
changes until a key is edited (blendShape.set). \`keys\` default to all of the parameter's keys;
\`base\` (the key with no effect) defaults to the key nearest the parameter's default. Blend shapes
apply in list order; \`index\` places this one (default: last). Version 4 files carry only position
and grid deltas on meshes and warps; anything else needs version 5.`,
  args: Type.Object({
    target: RefOf([...TARGETS]),
    parameter: RefOf(['parameter']),
    keys: Type.Optional(Type.Array(Type.Number(), { minItems: 1 })),
    base: Type.Optional(Type.Number()),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  result: Type.Object({ keyCount: Type.Integer() }),
  errors: ['E_WRONG_KIND', 'E_RANGE', 'E_ALREADY_BOUND', 'E_KEY_NOT_ON_PARAMETER'],
  examples: [
    {
      description: 'A smile shape on the mouth',
      args: { target: '@mesh:ArtMesh_Mouth', parameter: '@param:ParamSmile', keys: [0, 1] },
    },
  ],
  apply(d, a) {
    const o = getTarget(d, a.target);
    const p = blendShapeParameter(d, a.parameter, 'args.parameter');
    if (o.blendShapes.some((b) => b.parameter === p.uid))
      throw new MochiError(
        'E_ALREADY_BOUND',
        `${d.describe(o.uid)} already has a blend shape on ${p.exportId}.`,
        { path: 'args.parameter' },
      );
    const keys = checkKeysOnParameter(d, p.uid, a.keys ?? p.keys, 'args.keys');
    const base = chooseBase(keys, a.base, p.default, 'args.base');
    const shape: BlendShape = {
      parameter: p.uid,
      keys,
      base,
      deltas: keys.map(() => zeroDelta(o)),
      constraints: [],
    };
    const list: BlendShape[] = [...o.blendShapes];
    list.splice(Math.min(a.index ?? list.length, list.length), 0, shape);
    d.put(withShapes(o, list));
    return { keyCount: keys.length };
  },
});

const Points = () => Type.Array(Type.Tuple([Type.Number(), Type.Number()]));
const Rgb = () => Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);

export const blendShapeSet = defineCommand({
  name: 'blendShape.set',
  summary: 'Set the delta of a blend shape at one key.',
  doc: `Sets fields of the delta at \`key\`: what the blend shape adds when its parameter is at that key
(with weight 1). The base key's delta is always zero and cannot be set.

Fields by kind (all are offsets):
- artMesh: positions (one offset per vertex, in the mesh's own space), opacity, drawOrder, multiply,
  screen
- warp: grid (one offset per grid point, row-major), opacity, multiply, screen
- rotation: angle (degrees), originX, originY, scale, opacity, multiply, screen
- part: drawOrder
- glue: intensity (a glue that is a blend-shape target has its intensity clamped to 0…1)

Values are rounded to float32.`,
  args: Type.Object({
    target: RefOf([...TARGETS]),
    parameter: RefOf(['parameter']),
    key: Type.Number(),
    values: Type.Object({
      positions: Type.Optional(Points()),
      grid: Type.Optional(Points()),
      opacity: Type.Optional(Type.Number()),
      drawOrder: Type.Optional(Type.Number()),
      multiply: Type.Optional(Rgb()),
      screen: Type.Optional(Rgb()),
      angle: Type.Optional(Type.Number()),
      originX: Type.Optional(Type.Number()),
      originY: Type.Optional(Type.Number()),
      scale: Type.Optional(Type.Number()),
      intensity: Type.Optional(Type.Number()),
    }),
  }),
  result: Empty,
  errors: ['E_NOT_BOUND', 'E_BAD_CELL', 'E_RANGE', 'E_FIELD_NOT_APPLICABLE', 'E_SHAPE'],
  examples: [
    {
      description: 'Raise the mouth corners at key 1',
      args: {
        target: '@mesh:ArtMesh_Mouth',
        parameter: '@param:ParamSmile',
        key: 1,
        values: {
          positions: [
            [0, -3],
            [0, 0],
            [0, -3],
          ],
        },
      },
    },
  ],
  apply(d, a) {
    const o = getTarget(d, a.target);
    const i = findShape(d, o, a.parameter);
    const shape: BlendShape = o.blendShapes[i]!;
    const key = f32(a.key);
    const k = shape.keys.indexOf(key);
    if (k < 0)
      throw new MochiError(
        'E_BAD_CELL',
        `${key} is not a key of this blend shape (keys: ${shape.keys.join(', ')}).`,
        { path: 'args.key' },
      );
    if (key === shape.base)
      throw new MochiError(
        'E_RANGE',
        `${key} is the base key; its delta is always zero. Set another key, or move the base with blendShape.setKeys.`,
        { path: 'args.key' },
      );
    const allowed = FIELDS[o.kind];
    for (const f of Object.keys(a.values))
      if (!allowed.includes(f))
        throw new MochiError(
          'E_FIELD_NOT_APPLICABLE',
          `A ${o.kind} blend shape has no field "${f}" (fields: ${allowed.join(', ')}).`,
          { path: `args.values.${f}` },
        );
    const v = a.values;
    const patch: Record<string, unknown> = {};
    const pointCount =
      o.kind === 'artMesh' ? o.uv.length / 2 : o.kind === 'warp' ? (o.rows + 1) * (o.cols + 1) : 0;
    for (const f of ['positions', 'grid'] as const) {
      const pts = v[f];
      if (!pts) continue;
      if (pts.length !== pointCount)
        throw new MochiError('E_SHAPE', `${f} needs ${pointCount} offsets, got ${pts.length}.`, {
          path: `args.values.${f}`,
        });
      patch[f] = f32Array(pts.flat());
    }
    for (const f of [
      'opacity',
      'drawOrder',
      'angle',
      'originX',
      'originY',
      'scale',
      'intensity',
    ] as const)
      if (v[f] !== undefined) patch[f] = f32(v[f]);
    for (const f of ['multiply', 'screen'] as const)
      if (v[f]) patch[f] = v[f].map((x) => f32(x)) as [number, number, number];
    const deltas = [...shape.deltas];
    deltas[k] = { ...deltas[k], ...patch } as AnyDelta;
    const list: BlendShape[] = [...o.blendShapes];
    list[i] = { ...shape, deltas };
    d.put(withShapes(o, list));
    return {};
  },
});

export const blendShapeSetKeys = defineCommand({
  name: 'blendShape.setKeys',
  summary: 'Change a blend shape’s keys or its base key.',
  doc: `Keeps the deltas at keys that stay, gives new keys an all-zero delta and drops removed keys.
\`base\` defaults to the current base when it stays, else the key nearest the parameter's default.
Changing the base key does not change the other deltas, which stay offsets from the normal result.`,
  args: Type.Object({
    target: RefOf([...TARGETS]),
    parameter: RefOf(['parameter']),
    keys: Type.Array(Type.Number(), { minItems: 1 }),
    base: Type.Optional(Type.Number()),
  }),
  result: Empty,
  errors: ['E_NOT_BOUND', 'E_KEY_NOT_ON_PARAMETER', 'E_RANGE'],
  examples: [
    {
      description: 'Add a negative key',
      args: { target: '@mesh:ArtMesh_Mouth', parameter: '@param:ParamSmile', keys: [-1, 0, 1] },
    },
  ],
  apply(d, a) {
    const o = getTarget(d, a.target);
    const i = findShape(d, o, a.parameter);
    const shape: BlendShape = o.blendShapes[i]!;
    const p = d.getAs(shape.parameter, 'parameter');
    const keys = checkKeysOnParameter(d, p.uid, a.keys, 'args.keys');
    const base = chooseBase(
      keys,
      a.base ?? (keys.includes(shape.base) ? shape.base : undefined),
      p.default,
      'args.base',
    );
    const deltas = keys.map((k) => {
      const old = shape.keys.indexOf(k);
      return k === base || old < 0 ? zeroDelta(o) : shape.deltas[old]!;
    });
    const list: BlendShape[] = [...o.blendShapes];
    list[i] = { ...shape, keys, base, deltas };
    d.put(withShapes(o, list));
    return {};
  },
});

export const blendShapeSetConstraints = defineCommand({
  name: 'blendShape.setConstraints',
  summary: 'Set the weight curves that limit a blend shape.',
  doc: `Each constraint is a piecewise-linear weight curve over another parameter: points
(parameter value, weight), values ascending, constant beyond the first and last point. The blend
shape's weight is min(1, every constraint) (§1c.4), or 1 without any: weights above
1 are refused, and negative weights (allowed, with a lint warning) reverse the blend shape. A
constraint may use any parameter, even the blend shape's own. An empty list removes every
constraint.`,
  args: Type.Object({
    target: RefOf([...TARGETS]),
    parameter: RefOf(['parameter']),
    constraints: Type.Array(
      Type.Object({
        parameter: RefOf(['parameter']),
        points: Type.Array(Type.Tuple([Type.Number(), Type.Number()]), { minItems: 1 }),
      }),
    ),
  }),
  result: Empty,
  errors: ['E_NOT_BOUND', 'E_RANGE'],
  examples: [
    {
      description: 'Fade the smile out as the mouth opens',
      args: {
        target: '@mesh:ArtMesh_Mouth',
        parameter: '@param:ParamSmile',
        constraints: [
          {
            parameter: '@param:ParamMouthOpenY',
            points: [
              [0, 1],
              [1, 0],
            ],
          },
        ],
      },
    },
  ],
  apply(d, a) {
    const o = getTarget(d, a.target);
    const i = findShape(d, o, a.parameter);
    const shape: BlendShape = o.blendShapes[i]!;
    const seen = new Set<Uid>();
    const constraints: BlendShapeConstraint[] = a.constraints.map((c, j) => {
      const path = `args.constraints[${j}]`;
      if (seen.has(c.parameter))
        throw new MochiError('E_RANGE', `${d.describe(c.parameter)} is constrained twice.`, {
          path,
        });
      seen.add(c.parameter);
      const points = c.points.map(([x, w]) => [f32(x), f32(w)] as [number, number]);
      points.forEach(([, w], k) => {
        // w = min(1, c₁, …): a weight above 1 acts as 1.
        if (w > 1)
          throw new MochiError(
            'E_RANGE',
            `Weight ${w} is above 1; weights combine as min(1, weights) (§1c.4), so it would act as 1.`,
            {
              path: `${path}.points[${k}][1]`,
              fixes: [
                { description: 'Use 1', replace: { path: `${path}.points[${k}][1]`, value: 1 } },
              ],
            },
          );
      });
      for (let k = 1; k < points.length; k++)
        if (!(points[k]![0] > points[k - 1]![0]))
          throw new MochiError(
            'E_RANGE',
            'Constraint values must be strictly ascending (also after rounding to float32).',
            { path: `${path}.points[${k}]` },
          );
      return { parameter: c.parameter, points };
    });
    const list: BlendShape[] = [...o.blendShapes];
    list[i] = { ...shape, constraints };
    d.put(withShapes(o, list));
    return {};
  },
});

export const blendShapeReorder = defineCommand({
  name: 'blendShape.reorder',
  summary: 'Move a blend shape within its target’s list.',
  doc: 'Blend shapes add their contributions in list order (float32 sums, §1c.4).',
  args: Type.Object({
    target: RefOf([...TARGETS]),
    parameter: RefOf(['parameter']),
    index: Type.Integer({ minimum: 0 }),
  }),
  result: Empty,
  errors: ['E_NOT_BOUND'],
  examples: [
    {
      description: 'Apply the smile first',
      args: { target: '@mesh:ArtMesh_Mouth', parameter: '@param:ParamSmile', index: 0 },
    },
  ],
  apply(d, a) {
    const o = getTarget(d, a.target);
    const i = findShape(d, o, a.parameter);
    const list: BlendShape[] = [...o.blendShapes];
    const [shape] = list.splice(i, 1);
    list.splice(Math.min(a.index, list.length), 0, shape!);
    d.put(withShapes(o, list));
    return {};
  },
});

export const blendShapeRemove = defineCommand({
  name: 'blendShape.remove',
  summary: 'Remove a blend shape from its target.',
  doc: 'The target keeps its normal keyforms.',
  args: Type.Object({ target: RefOf([...TARGETS]), parameter: RefOf(['parameter']) }),
  result: Empty,
  errors: ['E_NOT_BOUND'],
  examples: [
    {
      description: 'Remove the smile',
      args: { target: '@mesh:ArtMesh_Mouth', parameter: '@param:ParamSmile' },
    },
  ],
  apply(d, a) {
    const o = getTarget(d, a.target);
    const i = findShape(d, o, a.parameter);
    d.put(
      withShapes(
        o,
        o.blendShapes.filter((_, j) => j !== i),
      ),
    );
    return {};
  },
});
