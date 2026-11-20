import { Type } from '@sinclair/typebox';
import { Empty, defineCommand } from '../command.js';
import type { Draft } from '../document.js';
import { MochiError } from '../errors.js';
import { f32 } from '../f32.js';
import type { AnyKeyform, Riggable, Rig } from '../model.js';
import * as grid from '../rig.js';
import { brushWeight } from '../brush.js';
import { RefOf } from '../schema.js';
import {
  checkKeysOnParameter,
  f32Array,
  getRiggable,
  requireBinding,
  rgb,
  withRig,
} from './helpers.js';

const RIGGABLE = ['part', 'artMesh', 'warp', 'rotation', 'glue'] as const;

const Cell = () =>
  Type.Record(Type.String(), Type.Number(), {
    keyRefOf: ['parameter'],
    description: 'one key value per bound parameter, e.g. {"@param:ParamAngleX": 30}',
  });

/** Finds a keyform cell from {parameter: key value}. Every bound parameter must be named, with a key. */
function locateCell(
  d: Draft,
  o: Riggable,
  cell: Record<string, number> | undefined,
  path: string,
): number {
  const c = cell ?? {};
  const coords: number[] = [];
  for (const b of o.rig.bindings) {
    if (!(b.parameter in c))
      throw new MochiError(
        'E_BAD_CELL',
        `The cell must give a key for ${d.describe(b.parameter)}.`,
        {
          path,
          details: {
            bindings: o.rig.bindings.map((x) => ({ parameter: x.parameter, keys: x.keys })),
          },
        },
      );
    const v = f32(c[b.parameter] as number);
    const i = b.keys.indexOf(v);
    if (i < 0) {
      const near = b.keys[grid.nearestKeyIndex(b.keys, v)];
      throw new MochiError(
        'E_BAD_CELL',
        `${v} is not a key of ${d.describe(o.uid)}'s binding to ${d.describe(b.parameter)} (keys: ${b.keys.join(', ')}).`,
        {
          path: `${path}.${b.parameter}`,
          fixes: [
            {
              description: `Use the nearest key ${near}`,
              replace: { path: `${path}.${b.parameter}`, value: near },
            },
            {
              description: `Add a key at ${v}`,
              command: 'rig.addKey',
              args: { target: o.uid, parameter: b.parameter, key: v },
            },
          ],
        },
      );
    }
    coords.push(i);
  }
  const extra = Object.keys(c).find((p) => !o.rig.bindings.some((b) => b.parameter === p));
  if (extra !== undefined)
    throw new MochiError(
      'E_BAD_CELL',
      `${d.describe(o.uid)} is not bound to ${d.describe(extra)}.`,
      { path: `${path}.${extra}` },
    );
  return grid.cellIndex(o.rig.bindings, coords);
}

export const rigAddBinding = defineCommand({
  name: 'rig.addBinding',
  summary: 'Bind an object to a parameter, at some or all of the parameter’s keys.',
  doc: `Adds an interpolation axis. Every existing keyform is copied to each new key, so the object looks
the same until a cell is edited. Copies at the key nearest the parameter's default keep their
"authored" mark; the others are marked as filled. \`keys\` default to all of the parameter's keys.
\`index\` places the binding in the axis order (default: last).`,
  args: Type.Object({
    target: RefOf([...RIGGABLE]),
    parameter: RefOf(['parameter']),
    keys: Type.Optional(Type.Array(Type.Number(), { minItems: 1 })),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  result: Type.Object({ keyformCount: Type.Integer() }),
  errors: ['E_ALREADY_BOUND', 'E_KEY_NOT_ON_PARAMETER', 'E_RANGE'],
  examples: [
    {
      description: 'Bind a mesh to the eye parameter',
      args: { target: '@mesh:ArtMesh_EyeL', parameter: '@param:ParamEyeLOpen', keys: [0, 1] },
    },
  ],
  apply(d, a) {
    const o = getRiggable(d, a.target);
    const p = d.getAs(a.parameter, 'parameter');
    if (p.type !== 'normal')
      throw new MochiError(
        'E_RANGE',
        `${p.exportId} is a blend-shape parameter; only normal parameters can be bound.`,
        { path: 'args.parameter' },
      );
    if (grid.bindingIndex(o.rig, p.uid) >= 0)
      throw new MochiError(
        'E_ALREADY_BOUND',
        `${d.describe(o.uid)} is already bound to ${p.exportId}.`,
        {
          path: 'args.parameter',
          fixes: [
            {
              description: 'Add keys to the existing binding instead',
              command: 'rig.addKey',
              args: { target: o.uid, parameter: p.uid, key: 0 },
            },
          ],
        },
      );
    if (p.keys.length === 0)
      throw new MochiError('E_KEY_NOT_ON_PARAMETER', `${p.exportId} has no keys.`, {
        fixes: [
          {
            description: 'Give the parameter keys',
            command: 'param.setKeys',
            args: { target: p.uid, keys: [p.min, p.max] },
          },
        ],
      });
    const keys = checkKeysOnParameter(d, p.uid, a.keys ?? p.keys, 'args.keys');
    const rig = grid.addBinding(
      o.rig as Rig<AnyKeyform>,
      { parameter: p.uid, keys },
      grid.nearestKeyIndex(keys, p.default),
      a.index,
    );
    d.put(withRig(o, rig));
    return { keyformCount: rig.keyforms.length };
  },
});

export const rigRemoveBinding = defineCommand({
  name: 'rig.removeBinding',
  summary: 'Unbind an object from a parameter, keeping the keyforms at one key.',
  doc: '`keep` is the key whose keyforms remain (default: the key nearest the parameter default).',
  args: Type.Object({
    target: RefOf([...RIGGABLE]),
    parameter: RefOf(['parameter']),
    keep: Type.Optional(Type.Number()),
  }),
  result: Type.Object({ keyformCount: Type.Integer() }),
  errors: ['E_NOT_BOUND', 'E_BAD_CELL'],
  examples: [
    {
      description: 'Unbind, keeping key 0',
      args: { target: '@mesh:ArtMesh_EyeL', parameter: '@param:ParamEyeLOpen', keep: 1 },
    },
  ],
  apply(d, a) {
    const o = getRiggable(d, a.target);
    const p = d.getAs(a.parameter, 'parameter');
    const b = requireBinding(d, o, p.uid);
    const keys = o.rig.bindings[b]!.keys;
    let keep = grid.nearestKeyIndex(keys, p.default);
    if (a.keep !== undefined) {
      keep = keys.indexOf(f32(a.keep));
      if (keep < 0)
        throw new MochiError(
          'E_BAD_CELL',
          `${a.keep} is not a key of this binding (${keys.join(', ')}).`,
          { path: 'args.keep' },
        );
    }
    const rig = grid.removeBinding(o.rig as Rig<AnyKeyform>, b, keep);
    d.put(withRig(o, rig));
    return { keyformCount: rig.keyforms.length };
  },
});

export const rigAddKey = defineCommand({
  name: 'rig.addKey',
  summary: 'Add a key to one of an object’s bindings.',
  doc: `The key must be in the parameter's key list. New cells between two keys are interpolated (so the
object looks the same as before); new cells beyond the ends copy the nearest cell. They are marked
as filled until edited.`,
  args: Type.Object({
    target: RefOf([...RIGGABLE]),
    parameter: RefOf(['parameter']),
    key: Type.Number(),
  }),
  result: Type.Object({ keyformCount: Type.Integer() }),
  errors: ['E_NOT_BOUND', 'E_KEY_NOT_ON_PARAMETER', 'E_RANGE'],
  examples: [
    {
      description: 'Add a half-open key',
      args: { target: '@mesh:ArtMesh_EyeL', parameter: '@param:ParamEyeLOpen', key: 0.5 },
    },
  ],
  apply(d, a) {
    const o = getRiggable(d, a.target);
    const b = requireBinding(d, o, a.parameter);
    const [key] = checkKeysOnParameter(d, a.parameter, [a.key], 'args.key') as [number];
    if (o.rig.bindings[b]!.keys.includes(key))
      throw new MochiError('E_RANGE', `The binding already has the key ${key}.`, {
        path: 'args.key',
      });
    const rig = grid.addKey(o.rig as Rig<AnyKeyform>, b, key);
    d.put(withRig(o, rig));
    return { keyformCount: rig.keyforms.length };
  },
});

export const rigRemoveKey = defineCommand({
  name: 'rig.removeKey',
  summary: 'Remove a key (and its keyforms) from one of an object’s bindings.',
  doc: 'A binding keeps at least one key; to remove the last one, remove the binding.',
  args: Type.Object({
    target: RefOf([...RIGGABLE]),
    parameter: RefOf(['parameter']),
    key: Type.Number(),
  }),
  result: Type.Object({ keyformCount: Type.Integer() }),
  errors: ['E_NOT_BOUND', 'E_LAST_KEY', 'E_BAD_CELL'],
  examples: [
    {
      description: 'Remove key 0.5',
      args: { target: '@mesh:ArtMesh_EyeL', parameter: '@param:ParamEyeLOpen', key: 0.5 },
    },
  ],
  apply(d, a) {
    const o = getRiggable(d, a.target);
    const b = requireBinding(d, o, a.parameter);
    const keys = o.rig.bindings[b]!.keys;
    const i = keys.indexOf(f32(a.key));
    if (i < 0)
      throw new MochiError(
        'E_BAD_CELL',
        `${a.key} is not a key of this binding (${keys.join(', ')}).`,
        { path: 'args.key' },
      );
    if (keys.length === 1)
      throw new MochiError('E_LAST_KEY', 'This is the binding’s last key.', {
        fixes: [
          {
            description: 'Remove the binding',
            command: 'rig.removeBinding',
            args: { target: o.uid, parameter: a.parameter },
          },
        ],
      });
    const rig = grid.removeKey(o.rig as Rig<AnyKeyform>, b, i);
    d.put(withRig(o, rig));
    return { keyformCount: rig.keyforms.length };
  },
});

export const rigFillMissing = defineCommand({
  name: 'rig.fillMissing',
  summary: 'Recompute every filled (unauthored) keyform from the authored ones.',
  doc: 'Along each axis, filled cells are interpolated between the nearest authored cells, or copied from the only one.',
  args: Type.Object({ target: RefOf([...RIGGABLE]) }),
  result: Type.Object({ filled: Type.Integer() }),
  errors: [],
  examples: [{ description: 'Refill a mesh', args: { target: '@mesh:ArtMesh_EyeL' } }],
  apply(d, a) {
    const o = getRiggable(d, a.target);
    const rig = grid.fillMissing(o.rig as Rig<AnyKeyform>);
    if (rig !== o.rig) d.put(withRig(o, rig));
    return { filled: rig.keyforms.filter((k) => !k.authored).length };
  },
});

const FIELDS: Record<Riggable['kind'], string[]> = {
  artMesh: ['positions', 'opacity', 'drawOrder', 'multiply', 'screen'],
  warp: ['grid', 'opacity', 'multiply', 'screen'],
  rotation: [
    'angle',
    'originX',
    'originY',
    'scale',
    'mirrorX',
    'mirrorY',
    'opacity',
    'multiply',
    'screen',
  ],
  part: ['drawOrder'],
  glue: ['intensity'],
};

const Points = () => Type.Array(Type.Tuple([Type.Number(), Type.Number()]));
const Rgb = () => Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);

export const keyformSet = defineCommand({
  name: 'keyform.set',
  summary: 'Set values of one keyform cell (or of every cell).',
  doc: `Sets fields of the keyform at \`cell\` ({parameter: key} for every bound parameter; omit when the
object has no bindings), or of every keyform with \`all: true\`. The cell becomes authored.

Fields by kind:
- mesh: positions ([x, y] per vertex, in the parent deformer space), opacity, drawOrder, multiply, screen
- warp: grid ([x, y] per grid point, row-major), opacity, multiply, screen
- rotation: angle (degrees), originX, originY, scale, mirrorX, mirrorY, opacity, multiply, screen
- part: drawOrder
- glue: intensity

Values are rounded to float32. Editing in canvas space comes with the deformer milestone.`,
  args: Type.Object({
    target: RefOf([...RIGGABLE]),
    cell: Type.Optional(Cell()),
    all: Type.Optional(Type.Boolean()),
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
      mirrorX: Type.Optional(Type.Boolean()),
      mirrorY: Type.Optional(Type.Boolean()),
      intensity: Type.Optional(Type.Number()),
    }),
  }),
  result: Type.Object({ cells: Type.Integer() }),
  errors: ['E_BAD_CELL', 'E_FIELD_NOT_APPLICABLE', 'E_SHAPE'],
  examples: [
    {
      description: 'Close the eye at key 0',
      args: {
        target: '@mesh:ArtMesh_EyeL',
        cell: { '@param:ParamEyeLOpen': 0 },
        values: { opacity: 0 },
      },
    },
  ],
  apply(d, a) {
    const o = getRiggable(d, a.target);
    const allowed = FIELDS[o.kind];
    for (const f of Object.keys(a.values))
      if (!allowed.includes(f))
        throw new MochiError(
          'E_FIELD_NOT_APPLICABLE',
          `A ${o.kind} keyform has no field "${f}" (fields: ${allowed.join(', ')}).`,
          { path: `args.values.${f}` },
        );
    const v = a.values;
    const patch: Record<string, unknown> = { authored: true };
    const pointCount =
      o.kind === 'artMesh' ? o.uv.length / 2 : o.kind === 'warp' ? (o.rows + 1) * (o.cols + 1) : 0;
    for (const f of ['positions', 'grid'] as const) {
      const pts = v[f];
      if (!pts) continue;
      if (pts.length !== pointCount)
        throw new MochiError('E_SHAPE', `${f} needs ${pointCount} points, got ${pts.length}.`, {
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
    for (const f of ['mirrorX', 'mirrorY'] as const) if (v[f] !== undefined) patch[f] = v[f];
    if (v.opacity !== undefined && !(v.opacity >= 0 && v.opacity <= 1))
      throw new MochiError('E_RANGE', `Opacity ${v.opacity} is outside 0…1.`, {
        path: 'args.values.opacity',
        fixes: [
          {
            description: 'Use the nearest value in range',
            replace: { path: 'args.values.opacity', value: Math.min(1, Math.max(0, v.opacity)) },
          },
        ],
      });
    if (v.multiply) patch.multiply = rgb(v.multiply, [1, 1, 1]);
    if (v.screen) patch.screen = rgb(v.screen, [0, 0, 0]);
    let cells: number[];
    if (a.all) {
      if (a.cell)
        throw new MochiError('E_BAD_CELL', 'Give either `cell` or `all`, not both.', {
          path: 'args.all',
        });
      cells = o.rig.keyforms.map((_, i) => i);
    } else cells = [locateCell(d, o, a.cell, 'args.cell')];
    const keyforms = [...o.rig.keyforms];
    for (const i of cells) keyforms[i] = { ...keyforms[i], ...patch } as AnyKeyform;
    d.put(withRig(o, { bindings: o.rig.bindings, keyforms }));
    return { cells: cells.length };
  },
});

export const meshBrushDeform = defineCommand({
  name: 'mesh.brushDeform',
  summary: 'Move the vertices under a brush in one keyform, weighted by its falloff.',
  doc: `The deform brush for agents. Every vertex of the keyform at \`cell\` (omit it when the
mesh has no bindings) within the brush moves by \`offset\` times its brush weight: 1 inside
\`hardness\` of the radius, falling smoothly to 0 at the edge. \`center\`, \`radius\` and \`offset\`
are in the keyform's own space, the space of its positions (the parent deformer's; canvas pixels
without one). \`roundness\` (short / long axis, default 1) and \`angle\` (degrees) shape the brush.
Returns how many vertices moved.`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    cell: Type.Optional(Cell()),
    center: Type.Tuple([Type.Number(), Type.Number()]),
    radius: Type.Number({ exclusiveMinimum: 0 }),
    hardness: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: 'default 0.5' })),
    roundness: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
    angle: Type.Optional(Type.Number()),
    offset: Type.Tuple([Type.Number(), Type.Number()]),
  }),
  result: Type.Object({ moved: Type.Integer() }),
  errors: ['E_BAD_CELL'],
  examples: [
    {
      description: 'Push the cheek out at the smile key',
      args: {
        target: '@mesh:ArtMesh_Face',
        cell: { '@param:ParamMouthForm': 1 },
        center: [420, 610],
        radius: 40,
        offset: [6, -2],
      },
    },
  ],
  apply(d, a) {
    const o = d.getAs(a.target, 'artMesh');
    const index = locateCell(d, o, a.cell, 'args.cell');
    const src = o.rig.keyforms[index]!.positions;
    const brush = {
      radius: a.radius,
      hardness: a.hardness ?? 0.5,
      roundness: a.roundness,
      angle: a.angle,
    };
    const positions: [number, number][] = [];
    let moved = 0;
    for (let k = 0; k < src.length; k += 2) {
      const [x, y] = [src[k]!, src[k + 1]!];
      const w = brushWeight(x - a.center[0], y - a.center[1], brush);
      if (w > 0) moved++;
      positions.push([x + a.offset[0] * w, y + a.offset[1] * w]);
    }
    if (moved)
      keyformSet.apply(d, {
        target: o.uid,
        ...(o.rig.bindings.length ? { cell: a.cell } : {}),
        values: { positions },
      });
    return { moved };
  },
});

export const keyformCopy = defineCommand({
  name: 'keyform.copy',
  summary: 'Copy one keyform cell’s values to another cell of the same object.',
  doc: 'The destination becomes authored. Both cells are given as {parameter: key}.',
  args: Type.Object({ target: RefOf([...RIGGABLE]), from: Cell(), to: Cell() }),
  result: Empty,
  errors: ['E_BAD_CELL'],
  examples: [
    {
      description: 'Copy the open eye to key 0.5',
      args: {
        target: '@mesh:ArtMesh_EyeL',
        from: { '@param:ParamEyeLOpen': 1 },
        to: { '@param:ParamEyeLOpen': 0.5 },
      },
    },
  ],
  apply(d, a) {
    const o = getRiggable(d, a.target);
    const from = locateCell(d, o, a.from, 'args.from');
    const to = locateCell(d, o, a.to, 'args.to');
    const keyforms = [...o.rig.keyforms];
    keyforms[to] = grid.withAuthored(keyforms[from] as AnyKeyform, true);
    d.put(withRig(o, { bindings: o.rig.bindings, keyforms }));
    return {};
  },
});

/** a + b − base, field by field (numbers and arrays in float32); a flag from whichever edge set it. */
function addForms<K extends AnyKeyform>(a: K, b: K, base: K): K {
  const out: Record<string, unknown> = {};
  for (const [key, vbase] of Object.entries(base)) {
    const va = (a as Record<string, unknown>)[key];
    const vb = (b as Record<string, unknown>)[key];
    if (key === 'authored') out[key] = true;
    else if (typeof vbase === 'number') {
      const v = f32((va as number) + (vb as number) - vbase);
      out[key] = key === 'opacity' ? Math.min(1, Math.max(0, v)) : v;
    } else if (vbase instanceof Float32Array) {
      const [fa, fb] = [va as Float32Array, vb as Float32Array];
      const r = new Float32Array(vbase.length);
      for (let i = 0; i < r.length; i++) r[i] = fa[i]! + fb[i]! - vbase[i]!;
      out[key] = r;
    } else if (Array.isArray(vbase))
      out[key] = vbase.map((x: number, i) => f32((va as number[])[i]! + (vb as number[])[i]! - x));
    else out[key] = va !== vbase ? va : vb;
  }
  return out as K;
}

export const keyformFillCorners = defineCommand({
  name: 'keyform.fillCorners',
  summary: 'Generate the four-corner forms: the diagonal cells of two parameters from their edges.',
  doc: `For objects bound to two parameters (say Angle X and Angle Y), each cell away from both
parameters' defaults gets the rest form plus what each edge adds: K(x, y) = K(x, rest) + K(rest, y)
− K(rest, rest), field by field (positions, grid points, angle, origin, scale, opacity clamped to
0…1, colors, draw order). The edges are the cells where one of the two is at its default, which
must be one of its keys. With more bindings, it runs for every key of the others. \`parameters\`
names the two; without it, each object must have exactly two bindings. Objects without both
are skipped and counted.`,
  args: Type.Object({
    targets: Type.Array(RefOf([...RIGGABLE]), { minItems: 1 }),
    parameters: Type.Optional(Type.Tuple([RefOf(['parameter']), RefOf(['parameter'])])),
  }),
  result: Type.Object({
    objects: Type.Integer(),
    cells: Type.Integer(),
    skipped: Type.Array(Type.String()),
  }),
  errors: ['E_NOT_BOUND', 'E_RANGE'],
  examples: [
    {
      description: 'The face turned diagonally from its X and Y forms',
      args: {
        targets: ['@warp:Warp_Face'],
        parameters: ['@param:ParamAngleX', '@param:ParamAngleY'],
      },
    },
  ],
  apply(d, a) {
    const pair = a.parameters?.map((r, i) => d.getAs(r, 'parameter', `args.parameters[${i}]`).uid);
    let objects = 0;
    let cells = 0;
    const skipped: string[] = [];
    a.targets.forEach((ref, ti) => {
      const o = getRiggable(d, ref);
      const bs = o.rig.bindings;
      const axes = pair
        ? pair.map((p) => bs.findIndex((b) => b.parameter === p))
        : bs.length === 2
          ? [0, 1]
          : [-1, -1];
      if (axes.some((x) => x < 0)) {
        skipped.push(o.uid);
        return;
      }
      const [ax, ay] = axes as [number, number];
      const rest = [ax, ay].map((j) => {
        const b = bs[j]!;
        const p = d.getAs(b.parameter, 'parameter');
        const k = b.keys.findIndex((x) => Math.abs(x - p.default) < 1e-6);
        if (k < 0)
          throw new MochiError(
            'E_RANGE',
            `${d.describe(o.uid)}: ${p.exportId}'s default (${p.default}) is not one of its keys here, so there is no rest edge to start from.`,
            { path: `args.targets[${ti}]` },
          );
        return k;
      }) as [number, number];
      const rig = o.rig as Rig<AnyKeyform>;
      const keyforms = [...rig.keyforms];
      const at = (c: number[]) => keyforms[grid.cellIndex(bs, c)]!;
      for (let i = 0; i < keyforms.length; i++) {
        const c = grid.cellCoords(bs, i);
        if (c[ax] === rest[0] || c[ay] === rest[1]) continue;
        const withX = [...c];
        withX[ay] = rest[1];
        const withY = [...c];
        withY[ax] = rest[0];
        const base = [...c];
        base[ax] = rest[0];
        base[ay] = rest[1];
        keyforms[i] = addForms(at(withX), at(withY), at(base));
        cells++;
      }
      d.put(withRig(o, { ...rig, keyforms }));
      objects++;
    });
    return { objects, cells, skipped };
  },
});
