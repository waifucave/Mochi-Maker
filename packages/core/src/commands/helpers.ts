/** Shared building blocks for commands. */
import { Type, type Static } from '@sinclair/typebox';
import type { Draft } from '../document.js';
import { uidNumber } from '../document.js';
import { MochiError } from '../errors.js';
import { f32 } from '../f32.js';
import {
  exportNamespace,
  type AnyKeyform,
  type ArtMesh,
  type Rotation,
  type Warp,
  type DocObject,
  type ObjectByKind,
  type Parameter,
  type Riggable,
  type Rig,
  type ShapeTarget,
  type Uid,
} from '../model.js';
import { bindingIndex, nearestKeyIndex, removeBinding } from '../rig.js';
import { EXPORT_ID_PATTERN, type Kind } from '../schema.js';

const EXPORT_PREFIX: Partial<Record<Kind, string>> = {
  parameter: 'Param',
  parameterGroup: 'ParamGroup',
  part: 'Part',
  artMesh: 'ArtMesh',
  warp: 'Warp',
  rotation: 'Rotation',
  glue: 'Glue',
};

function exportIdTaken(d: Draft, kind: Kind, exportId: string, except?: Uid): Uid | undefined {
  const ns = exportNamespace(kind);
  for (const o of d.all())
    if (
      'exportId' in o &&
      o.uid !== except &&
      exportNamespace(o.kind) === ns &&
      o.exportId === exportId
    )
      return o.uid;
  return undefined;
}

/** Checks an export ID for format and uniqueness, with fixes that suggest a free one. */
export function checkExportId(
  d: Draft,
  kind: Kind,
  exportId: string,
  except?: Uid,
  path = 'args.exportId',
): void {
  if (!EXPORT_ID_PATTERN.test(exportId))
    throw new MochiError(
      'E_BAD_EXPORT_ID',
      `"${exportId}" is not a valid export ID: use 1–63 characters of A–Z, a–z, 0–9 and _.`,
      { path },
    );
  const other = exportIdTaken(d, kind, exportId, except);
  if (other) {
    const free = freeExportId(d, kind, exportId);
    throw new MochiError(
      'E_DUPLICATE_ID',
      `${d.describe(other)} already uses the export ID "${exportId}".`,
      {
        path,
        fixes: [{ description: `Use "${free}"`, replace: { path, value: free } }],
      },
    );
  }
}

/** A free export ID derived from `base`: base, base_2, base_3, ... */
export function freeExportId(d: Draft, kind: Kind, base: string): string {
  const clean = base.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 56) || (EXPORT_PREFIX[kind] ?? 'Id');
  if (!exportIdTaken(d, kind, clean)) return clean;
  for (let i = 2; ; i++) {
    const candidate = `${clean}_${i}`;
    if (!exportIdTaken(d, kind, candidate)) return candidate;
  }
}

/** The export ID for a new object: the given one (checked), or a generated `Prefix<number>`. */
export function newExportId(d: Draft, kind: Kind, uid: Uid, given: string | undefined): string {
  if (given !== undefined) {
    checkExportId(d, kind, given);
    return given;
  }
  return freeExportId(d, kind, `${EXPORT_PREFIX[kind] ?? 'Id'}${uidNumber(uid)}`);
}

export const WHITE: [number, number, number] = [1, 1, 1];
export const BLACK: [number, number, number] = [0, 0, 0];

export function rgb(
  v: number[] | undefined,
  fallback: [number, number, number],
): [number, number, number] {
  if (v === undefined) return [...fallback];
  return [f32(v[0] as number), f32(v[1] as number), f32(v[2] as number)];
}

export function f32Array(values: readonly number[]): Float32Array {
  const a = Float32Array.from(values);
  for (let i = 0; i < a.length; i++) if (a[i] === 0) a[i] = 0;
  return a;
}

/** Inserts into a list at `index` (clamped; default: the end). */
export function insertAt<T>(list: readonly T[], item: T, index?: number): T[] {
  const out = [...list];
  const i = index === undefined ? out.length : Math.max(0, Math.min(index, out.length));
  out.splice(i, 0, item);
  return out;
}

export function without<T>(list: readonly T[], item: T): T[] {
  return list.filter((x) => x !== item);
}

/** The parameter a riggable object's binding refers to, with a helpful error when it is not bound. */
export function requireBinding(d: Draft, o: Riggable, parameter: Uid): number {
  const b = bindingIndex(o.rig, parameter);
  if (b < 0)
    throw new MochiError(
      'E_NOT_BOUND',
      `${d.describe(o.uid)} is not bound to ${d.describe(parameter)}.`,
      {
        path: 'args.parameter',
        fixes: [
          {
            description: 'Bind it first',
            command: 'rig.addBinding',
            args: { target: o.uid, parameter },
          },
        ],
      },
    );
  return b;
}

export function withRig<T extends Riggable>(o: T, rig: Rig): T {
  return { ...o, rig } as T;
}

/** Removes a parameter's binding from an object, keeping the slice nearest the parameter default. */
export function unbind(o: Riggable, p: Parameter): Riggable {
  const b = bindingIndex(o.rig, p.uid);
  if (b < 0) return o;
  const keys = (o.rig.bindings[b] as { keys: number[] }).keys;
  return withRig(o, removeBinding(o.rig as Rig<AnyKeyform>, b, nearestKeyIndex(keys, p.default)));
}

/**
 * Removes a parameter from an object's blend shapes: its own blend shape goes, and
 * constraints over it are dropped from the others.
 */
export function unshape<T extends DocObject>(o: T, p: Uid): T {
  if (!('blendShapes' in o)) return o;
  const t = o as unknown as ShapeTarget;
  const uses = t.blendShapes.some(
    (b) => b.parameter === p || b.constraints.some((c) => c.parameter === p),
  );
  if (!uses) return o;
  return {
    ...o,
    blendShapes: t.blendShapes
      .filter((b) => b.parameter !== p)
      .map((b) => ({ ...b, constraints: b.constraints.filter((c) => c.parameter !== p) })),
  };
}

/**
 * Removes every reference to `uid` from the object `o` (for cascading deletes). Returns the new
 * object, or null when `o` itself must be deleted (a glue that loses a mesh).
 */
export function detach(d: Draft, o: DocObject, uid: Uid): DocObject | null {
  const gone = d.get(uid);
  switch (o.kind) {
    case 'project':
      return {
        ...o,
        parameterOrder: without(o.parameterOrder, uid),
        parameterGroupOrder: without(o.parameterGroupOrder, uid),
        root: without(o.root, uid),
        deformerOrder: without(o.deformerOrder, uid),
        layerOrder: without(o.layerOrder, uid),
        glueOrder: without(o.glueOrder, uid),
        expressionOrder: without(o.expressionOrder, uid),
        motionOrder: without(o.motionOrder, uid),
        physicsOrder: without(o.physicsOrder, uid),
        motionSyncOrder: without(o.motionSyncOrder, uid),
        soundOrder: without(o.soundOrder, uid),
        hitAreas: o.hitAreas.filter((h) => h.mesh !== uid),
        standardGroups: {
          eyeBlink: without(o.standardGroups.eyeBlink, uid),
          lipSync: without(o.standardGroups.lipSync, uid),
        },
        combinedParameters: o.combinedParameters.filter(([a, b]) => a !== uid && b !== uid),
        userData: o.userData.filter((u) => u.target !== uid),
        pose: {
          ...o.pose,
          groups: o.pose.groups
            .map((g) =>
              g.filter((e) => e.part !== uid).map((e) => ({ ...e, links: without(e.links, uid) })),
            )
            .filter((g) => g.length > 0),
        },
        // Deform paths are helpers: they drop a deleted target, and go when none is left.
        deformPaths: o.deformPaths
          .map((p) => ({ ...p, targets: without(p.targets, uid) }))
          .filter((p) => p.targets.length > 0),
      };
    case 'parameter':
      return o.group === uid
        ? { ...o, group: gone?.kind === 'parameterGroup' ? gone.parent : null }
        : o;
    case 'parameterGroup':
      return o.parent === uid
        ? { ...o, parent: gone?.kind === 'parameterGroup' ? gone.parent : null }
        : o;
    case 'part': {
      let r: DocObject = o.children.includes(uid)
        ? { ...o, children: without(o.children, uid) }
        : o;
      if (gone?.kind === 'parameter') r = unshape(unbind(r as Riggable, gone), uid);
      return r;
    }
    case 'artMesh': {
      let r = o;
      if (r.layer === uid) r = { ...r, layer: null };
      if (r.clip && r.clip.masks.includes(uid)) {
        const masks = without(r.clip.masks, uid);
        r = { ...r, clip: masks.length > 0 ? { ...r.clip, masks } : null };
      }
      if (gone?.kind === 'parameter') r = unshape(unbind(r, gone) as typeof r, uid);
      return r;
    }
    case 'warp':
    case 'rotation': {
      let r: DocObject = o;
      if (o.part === uid) r = { ...o, part: null };
      if (gone?.kind === 'parameter') r = unshape(unbind(r as Riggable, gone), uid);
      return r;
    }
    case 'glue':
      if (o.meshA === uid || o.meshB === uid) return null;
      return gone?.kind === 'parameter' ? unshape(unbind(o, gone), uid) : o;
    case 'expression':
      return { ...o, entries: o.entries.filter((e) => e.parameter !== uid) };
    case 'motion':
      return {
        ...o,
        curves: o.curves.filter((c) => c.object !== uid),
        sound: o.sound === uid ? null : o.sound,
        motionSync: o.motionSync === uid ? null : o.motionSync,
      };
    case 'physicsSetting':
      return {
        ...o,
        inputs: o.inputs.filter((i) => i.parameter !== uid),
        outputs: o.outputs.filter((i) => i.parameter !== uid),
      };
    case 'motionSyncSetting': {
      // A driven parameter goes with its column of every shape.
      const k = o.parameters.findIndex((p) => p.parameter === uid);
      if (k < 0) return o;
      return {
        ...o,
        parameters: o.parameters.filter((_, j) => j !== k),
        shapes: o.shapes.map((row) => row.filter((_, j) => j !== k)),
      };
    }
    default:
      return o;
  }
}

/**
 * Deletes an object. Without `cascade`, any reference to it is an E_IN_USE error that lists the
 * references and offers the cascading call as a fix. With `cascade`, references are removed.
 */
export function deleteObject(
  d: Draft,
  uid: Uid,
  cascade: boolean,
  command: string,
  ignore: (from: Uid) => boolean = () => false,
): void {
  const refs = d.referencesTo(uid).filter((r) => !ignore(r.from));
  const blocking = refs.filter((r) => !isOrderListRef(r.from, r.path));
  if (blocking.length > 0 && !cascade)
    throw new MochiError(
      'E_IN_USE',
      `${d.describe(uid)} is used by ${blocking.length} reference(s), for example ${d.describe(blocking[0]!.from)} (${blocking[0]!.path}).`,
      {
        details: { references: blocking.slice(0, 50) },
        fixes: [
          {
            description: 'Delete it and remove every reference',
            command,
            args: { target: uid, cascade: true },
          },
        ],
      },
    );
  const fromUids = [...new Set(refs.map((r) => r.from))];
  for (const from of fromUids) {
    const o = d.get(from);
    if (!o) continue;
    const r = detach(d, o, uid);
    if (r === null) deleteObject(d, from, true, command);
    else if (r !== o) d.put(r);
  }
  d.remove(uid);
}

/** References from the project's ordered lists only record existence, so they never block. */
function isOrderListRef(from: Uid, path: string): boolean {
  return (
    from === 'project' &&
    /^(parameterOrder|parameterGroupOrder|root|deformerOrder|layerOrder|glueOrder|expressionOrder|motionOrder|physicsOrder|motionSyncOrder|deformPaths)\[/.test(
      path,
    )
  );
}

/** True when `ancestor` is `uid` or one of its ancestors through `parentOf`. */
export function isAncestor(
  d: Draft,
  ancestor: Uid,
  uid: Uid | null,
  parentOf: (o: DocObject) => Uid | null,
): boolean {
  let cur = uid;
  const seen = new Set<Uid>();
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    const o = d.get(cur);
    cur = o ? parentOf(o) : null;
  }
  return false;
}

export function getRiggable(d: Draft, uid: Uid): Riggable {
  return d.getAs(uid, ['part', 'artMesh', 'warp', 'rotation', 'glue'], 'args.target');
}

export type { ObjectByKind };

/** Checks that keys are on the parameter's key list; returns them rounded, sorted and distinct. */
export function checkKeysOnParameter(
  d: Draft,
  parameter: string,
  keys: number[],
  path: string,
): number[] {
  const p = d.getAs(parameter, 'parameter');
  const out = [...new Set(keys.map(f32))].sort((a, b) => a - b);
  for (const k of out)
    if (!p.keys.includes(k))
      throw new MochiError(
        'E_KEY_NOT_ON_PARAMETER',
        `Key ${k} is not in the key list of ${p.exportId} (${p.keys.join(', ')}).`,
        {
          path,
          fixes: [
            {
              description: `Add ${k} to ${p.exportId}'s key list first`,
              command: 'param.setKeys',
              args: { target: p.uid, keys: [...p.keys, k].sort((a, b) => a - b) },
            },
            {
              description: 'Use the nearest existing key',
              replace: { path, value: p.keys[nearestKeyIndex(p.keys, k)] },
            },
          ],
        },
      );
  return out;
}

// ---------------------------------------------------------------- converted values (design 3.5)

const PointList = () => Type.Array(Type.Tuple([Type.Number(), Type.Number()]));
const ConvertedValues = Type.Object({
  positions: Type.Optional(PointList()),
  grid: Type.Optional(PointList()),
  originX: Type.Optional(Type.Number()),
  originY: Type.Optional(Type.Number()),
  angle: Type.Optional(Type.Number()),
  scale: Type.Optional(Type.Number()),
});

/** Values in a new parent's space, for commands that change a parent and keep things in place. */
export const Converted = Type.Object(
  {
    keyforms: Type.Array(ConvertedValues, { description: 'one per keyform, in keyform order' }),
    blendShapes: Type.Optional(
      Type.Array(Type.Array(ConvertedValues), {
        description: 'per blend shape, one delta per key (the base key’s stays zero)',
      }),
    ),
  },
  {
    description:
      'keyform values (and blend-shape deltas) in the new parent’s space; the reparent operations compute them',
  },
);
export type Converted = Static<typeof Converted>;

type ConvertedFields = Static<typeof ConvertedValues>;

/**
 * Writes converted values into an object's keyforms and blend-shape deltas, keeping their other
 * fields (and authored flags). Meshes take `positions`, warps `grid`, rotations the origin, angle
 * and scale.
 */
export function withConverted<T extends ArtMesh | Warp | Rotation>(o: T, c: Converted): T {
  const pointCount =
    o.kind === 'artMesh' ? o.uv.length / 2 : o.kind === 'warp' ? (o.rows + 1) * (o.cols + 1) : 0;
  const allowed =
    o.kind === 'artMesh'
      ? ['positions']
      : o.kind === 'warp'
        ? ['grid']
        : ['originX', 'originY', 'angle', 'scale'];
  const fields = (v: ConvertedFields, path: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [f, x] of Object.entries(v)) {
      if (!allowed.includes(f))
        throw new MochiError(
          'E_FIELD_NOT_APPLICABLE',
          `Converted values of a ${o.kind} have no field "${f}" (fields: ${allowed.join(', ')}).`,
          { path: `${path}.${f}` },
        );
      if (Array.isArray(x)) {
        if (x.length !== pointCount)
          throw new MochiError('E_SHAPE', `${f} needs ${pointCount} points, got ${x.length}.`, {
            path: `${path}.${f}`,
          });
        out[f] = f32Array((x as [number, number][]).flat());
      } else out[f] = f32(x as number);
    }
    return out;
  };
  if (c.keyforms.length !== o.rig.keyforms.length)
    throw new MochiError(
      'E_SHAPE',
      `Converted values need ${o.rig.keyforms.length} keyform(s), got ${c.keyforms.length}.`,
      { path: 'args.converted.keyforms' },
    );
  const keyforms = o.rig.keyforms.map((k, i) => ({
    ...k,
    ...fields(c.keyforms[i]!, `args.converted.keyforms.${i}`),
  }));
  let blendShapes = o.blendShapes;
  if (c.blendShapes) {
    if (c.blendShapes.length !== o.blendShapes.length)
      throw new MochiError(
        'E_SHAPE',
        `Converted values need ${o.blendShapes.length} blend shape(s), got ${c.blendShapes.length}.`,
        { path: 'args.converted.blendShapes' },
      );
    blendShapes = o.blendShapes.map((s, i) => {
      const list = c.blendShapes![i]!;
      if (list.length !== s.deltas.length)
        throw new MochiError(
          'E_SHAPE',
          `Blend shape ${i} needs ${s.deltas.length} delta(s), got ${list.length}.`,
          { path: `args.converted.blendShapes.${i}` },
        );
      return {
        ...s,
        deltas: s.deltas.map((dl, j) =>
          s.keys[j] === s.base
            ? dl
            : { ...dl, ...fields(list[j]!, `args.converted.blendShapes.${i}.${j}`) },
        ),
      };
    }) as typeof o.blendShapes;
  }
  return { ...o, rig: { bindings: o.rig.bindings, keyforms }, blendShapes } as T;
}
