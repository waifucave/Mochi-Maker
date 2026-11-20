import { Type } from '@sinclair/typebox';
import { Empty, Uid, defineCommand } from '../command.js';
import { MochiError } from '../errors.js';
import { f32 } from '../f32.js';
import type { Parameter } from '../model.js';
import { RefOf } from '../schema.js';
import { deleteObject, insertAt, isAncestor, newExportId, without } from './helpers.js';

function sortedKeys(keys: readonly number[], path: string): number[] {
  const out = [...new Set(keys.map(f32))].sort((a, b) => a - b);
  if (out.length !== keys.length)
    throw new MochiError('E_RANGE', 'Keys must be distinct (after rounding to float32).', { path });
  return out;
}

function checkRange(p: Pick<Parameter, 'min' | 'max' | 'default' | 'keys'>): void {
  if (!(p.min <= p.max))
    throw new MochiError('E_RANGE', `min (${p.min}) must not exceed max (${p.max}).`, {
      path: 'args.min',
    });
  if (p.default < p.min || p.default > p.max)
    throw new MochiError('E_RANGE', `The default ${p.default} lies outside [${p.min}, ${p.max}].`, {
      path: 'args.default',
      fixes: [
        {
          description: 'Use the nearest bound',
          replace: { path: 'args.default', value: Math.min(Math.max(p.default, p.min), p.max) },
        },
      ],
    });
  const outside = p.keys.find((k) => k < p.min || k > p.max);
  if (outside !== undefined)
    throw new MochiError('E_RANGE', `Key ${outside} lies outside [${p.min}, ${p.max}].`, {
      path: 'args.keys',
    });
}

/** Keys used by bindings of any object, for a parameter. */
function keysInUse(d: import('../document.js').Draft, uid: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const o of d.ofKind(['part', 'artMesh', 'warp', 'rotation', 'glue'])) {
    for (const b of o.rig.bindings) {
      if (b.parameter !== uid) continue;
      for (const k of b.keys) out.set(k, [...(out.get(k) ?? []), o.uid]);
    }
    for (const b of 'blendShapes' in o ? o.blendShapes : []) {
      if (b.parameter !== uid) continue;
      for (const k of b.keys) out.set(k, [...(out.get(k) ?? []), o.uid]);
    }
  }
  return out;
}

/** A blend shape's keys without `k`. */
function shapeKeys(d: import('../document.js').Draft, o: string, p: string, k: number): number[] {
  const t = d.get(o);
  const b = t && 'blendShapes' in t ? t.blendShapes.find((x) => x.parameter === p) : undefined;
  return (b?.keys ?? []).filter((x) => x !== k);
}

export const paramCreate = defineCommand({
  name: 'param.create',
  summary: 'Create a parameter with a range, a default and a key list.',
  doc: `Creates a parameter. \`keys\` are the values where keyforms may exist; when omitted they are
the distinct values of min, default and max. Values are rounded to float32. \`type\` 'blendShape'
creates a blend-shape parameter: it drives blend shapes (blendShape.add), not bindings.`,
  args: Type.Object({
    exportId: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    min: Type.Number(),
    max: Type.Number(),
    default: Type.Optional(Type.Number()),
    keys: Type.Optional(Type.Array(Type.Number())),
    repeat: Type.Optional(Type.Boolean()),
    decimals: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
    group: Type.Optional(Type.Union([RefOf(['parameterGroup']), Type.Null()])),
    type: Type.Optional(Type.Union([Type.Literal('normal'), Type.Literal('blendShape')])),
    index: Type.Optional(
      Type.Integer({ minimum: 0, description: 'position in the parameter order' }),
    ),
  }),
  result: Uid,
  errors: ['E_RANGE', 'E_DUPLICATE_ID', 'E_BAD_EXPORT_ID'],
  examples: [
    {
      description: 'Head angle X',
      args: {
        exportId: 'ParamAngleX',
        name: 'Angle X',
        min: -30,
        max: 30,
        default: 0,
        keys: [-30, 0, 30],
      },
    },
  ],
  apply(d, a) {
    const uid = d.allocate('parameter');
    const min = f32(a.min);
    const max = f32(a.max);
    const def = f32(a.default ?? Math.min(Math.max(0, a.min), a.max));
    const keys = sortedKeys(
      a.keys ?? [min, def, max].filter((v, i, l) => l.indexOf(v) === i),
      'args.keys',
    );
    const exportId = newExportId(d, 'parameter', uid, a.exportId);
    const p: Parameter = {
      kind: 'parameter',
      uid,
      exportId,
      name: a.name ?? exportId,
      group: a.group ?? null,
      min,
      max,
      default: def,
      repeat: a.repeat ?? false,
      decimals: a.decimals ?? 3,
      type: a.type ?? 'normal',
      keys,
    };
    checkRange(p);
    d.put(p);
    d.updateProject((pr) => ({ ...pr, parameterOrder: insertAt(pr.parameterOrder, uid, a.index) }));
    return { uid };
  },
});

export const paramUpdate = defineCommand({
  name: 'param.update',
  summary: 'Change a parameter’s range, default, repeat flag, decimals or group.',
  doc: 'The new range must still contain the default and every key. Use param.setKeys for keys.',
  args: Type.Object({
    target: RefOf(['parameter']),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    default: Type.Optional(Type.Number()),
    repeat: Type.Optional(Type.Boolean()),
    decimals: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
    group: Type.Optional(Type.Union([RefOf(['parameterGroup']), Type.Null()])),
  }),
  result: Empty,
  errors: ['E_RANGE'],
  examples: [
    { description: 'Widen the range', args: { target: '@param:ParamAngleX', min: -45, max: 45 } },
  ],
  apply(d, a) {
    const p = d.getAs(a.target, 'parameter');
    const r: Parameter = {
      ...p,
      min: a.min === undefined ? p.min : f32(a.min),
      max: a.max === undefined ? p.max : f32(a.max),
      default: a.default === undefined ? p.default : f32(a.default),
      repeat: a.repeat ?? p.repeat,
      decimals: a.decimals ?? p.decimals,
      group: a.group === undefined ? p.group : a.group,
    };
    checkRange(r);
    d.put(r);
    return {};
  },
});

export const paramSetKeys = defineCommand({
  name: 'param.setKeys',
  summary: 'Replace a parameter’s key list.',
  doc: `Keys must lie within [min, max]. A key that a binding uses cannot be removed; the error lists the
objects and offers rig.removeKey fixes.`,
  args: Type.Object({ target: RefOf(['parameter']), keys: Type.Array(Type.Number()) }),
  result: Empty,
  errors: ['E_RANGE', 'E_KEY_IN_USE'],
  examples: [
    {
      description: 'Add a key at 15',
      args: { target: '@param:ParamAngleX', keys: [-30, 0, 15, 30] },
    },
  ],
  apply(d, a) {
    const p = d.getAs(a.target, 'parameter');
    const keys = sortedKeys(a.keys, 'args.keys');
    const used = keysInUse(d, p.uid);
    for (const [k, objects] of used) {
      if (!keys.includes(k))
        throw new MochiError(
          'E_KEY_IN_USE',
          `Key ${k} of ${p.exportId} is used by ${objects.length} object(s), for example ${d.describe(objects[0]!)}.`,
          {
            path: 'args.keys',
            details: { key: k, objects },
            fixes: objects.slice(0, 20).map((o) =>
              p.type === 'blendShape'
                ? {
                    description: `Remove key ${k} from ${d.describe(o)}'s blend shape`,
                    command: 'blendShape.setKeys',
                    args: { target: o, parameter: p.uid, keys: shapeKeys(d, o, p.uid, k) },
                  }
                : {
                    description: `Remove key ${k} from ${d.describe(o)}`,
                    command: 'rig.removeKey',
                    args: { target: o, parameter: p.uid, key: k },
                  },
            ),
          },
        );
    }
    const r = { ...p, keys };
    checkRange(r);
    d.put(r);
    return {};
  },
});

export const paramReorder = defineCommand({
  name: 'param.reorder',
  summary: 'Move a parameter to a position in the parameter order.',
  doc: 'The parameter order is the export order and the order apps list parameters in.',
  args: Type.Object({ target: RefOf(['parameter']), index: Type.Integer({ minimum: 0 }) }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Move to the top', args: { target: '@param:ParamAngleX', index: 0 } }],
  apply(d, a) {
    d.updateProject((p) => ({
      ...p,
      parameterOrder: insertAt(without(p.parameterOrder, a.target), a.target, a.index),
    }));
    return {};
  },
});

export const paramDelete = defineCommand({
  name: 'param.delete',
  summary: 'Delete a parameter.',
  doc: `Without \`cascade\`, fails when anything uses the parameter. With \`cascade\`, bindings are removed
(each object keeps the keyforms nearest to the parameter's default) and the parameter is removed
from expressions, motions, physics, groups and the display lists.`,
  args: Type.Object({ target: RefOf(['parameter']), cascade: Type.Optional(Type.Boolean()) }),
  result: Empty,
  errors: ['E_IN_USE'],
  examples: [
    { description: 'Delete and unbind', args: { target: '@param:Param12', cascade: true } },
  ],
  apply(d, a) {
    deleteObject(d, a.target, a.cascade ?? false, 'param.delete');
    return {};
  },
});

export const groupCreate = defineCommand({
  name: 'paramGroup.create',
  summary: 'Create a parameter group for display.',
  doc: 'Groups are exported to the display-info file. Groups can nest through `parent`.',
  args: Type.Object({
    exportId: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    parent: Type.Optional(Type.Union([RefOf(['parameterGroup']), Type.Null()])),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  result: Uid,
  errors: ['E_DUPLICATE_ID'],
  examples: [{ description: 'A face group', args: { exportId: 'ParamGroupFace', name: 'Face' } }],
  apply(d, a) {
    const uid = d.allocate('parameterGroup');
    const exportId = newExportId(d, 'parameterGroup', uid, a.exportId);
    d.put({
      kind: 'parameterGroup',
      uid,
      exportId,
      name: a.name ?? exportId,
      parent: a.parent ?? null,
    });
    d.updateProject((p) => ({
      ...p,
      parameterGroupOrder: insertAt(p.parameterGroupOrder, uid, a.index),
    }));
    return { uid };
  },
});

export const groupUpdate = defineCommand({
  name: 'paramGroup.update',
  summary: 'Change a parameter group’s parent.',
  doc: 'A group cannot become its own ancestor.',
  args: Type.Object({
    target: RefOf(['parameterGroup']),
    parent: Type.Union([RefOf(['parameterGroup']), Type.Null()]),
  }),
  result: Empty,
  errors: ['E_CYCLE'],
  examples: [
    { description: 'Nest a group', args: { target: 'pgroup_0002', parent: 'pgroup_0001' } },
  ],
  apply(d, a) {
    const g = d.getAs(a.target, 'parameterGroup');
    if (isAncestor(d, g.uid, a.parent, (o) => (o.kind === 'parameterGroup' ? o.parent : null)))
      throw new MochiError('E_CYCLE', `${d.describe(g.uid)} cannot be nested inside itself.`, {
        path: 'args.parent',
      });
    d.put({ ...g, parent: a.parent });
    return {};
  },
});

export const groupDelete = defineCommand({
  name: 'paramGroup.delete',
  summary: 'Delete a parameter group. Its parameters and subgroups move to its parent.',
  doc: 'Parameters in the group become ungrouped; subgroups move up one level.',
  args: Type.Object({ target: RefOf(['parameterGroup']) }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Delete a group', args: { target: 'pgroup_0002' } }],
  apply(d, a) {
    deleteObject(d, a.target, true, 'paramGroup.delete');
    return {};
  },
});
