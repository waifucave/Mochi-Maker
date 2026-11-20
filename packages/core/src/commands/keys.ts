/**
 * Key commands for motion curves (M10): what the Timeline palette does, for agents too.
 * Each one reads the curve's keys (`curveKeys`), changes them, and writes the segments and the
 * Auto smooth list back (`keysToCurve`), so Auto smooth handles always follow the keys.
 *
 * Animation templates (the Template palette) live in the project: `template.create` cuts
 * one from a motion's parameter keys in a range of time, `template.apply` inserts one at a time,
 * matching parameters by export ID.
 */
import { Type } from '@sinclair/typebox';
import { Empty, defineCommand } from '../command.js';
import type { Draft } from '../document.js';
import { MochiError } from '../errors.js';
import {
  INTERPOLATIONS,
  curveKeys,
  keysToCurve,
  sampleSegments,
  type Interpolation,
  type MotionKey,
} from '../keys.js';
import { AnimationTemplate, type Motion, type MotionCurve } from '../model.js';
import { RefOf } from '../schema.js';

const CurveRef = () =>
  Type.Object(
    {
      target: Type.Union([
        Type.Literal('model'),
        Type.Literal('parameter'),
        Type.Literal('partOpacity'),
      ]),
      model: Type.Optional(
        Type.Union([Type.Literal('EyeBlink'), Type.Literal('LipSync'), Type.Literal('Opacity')]),
      ),
      object: Type.Optional(RefOf(['parameter', 'part'])),
    },
    { description: 'which curve: its target, and its model value or object' },
  );
const Interp = () =>
  Type.Union(
    INTERPOLATIONS.map((i) => Type.Literal(i)),
    {
      description:
        'the segment after the key: linear, auto (Auto smooth, exported as Bézier), step, inverseStep or bezier',
    },
  );
const Key = () =>
  Type.Object({
    time: Type.Number({ minimum: 0, description: 'seconds' }),
    value: Type.Number(),
    interp: Type.Optional(Interp()),
    handles: Type.Optional(
      Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()], {
        description: 'Bézier handles of the segment after the key: [t1, v1, t2, v2]',
      }),
    ),
  });

type Ref = { target: MotionCurve['target']; model?: MotionCurve['model']; object?: string };
const EPS = 1e-6;

/** The motion, the curve's identity, and its index (−1 when it has no curve yet). */
function find(d: Draft, motion: string, ref: Ref, path = 'args.curve') {
  const m = d.getAs(motion, 'motion');
  const model = ref.target === 'model' ? (ref.model ?? null) : null;
  const object =
    ref.target === 'model'
      ? null
      : ref.object
        ? d.getAs(ref.object, ref.target === 'parameter' ? 'parameter' : 'part', `${path}.object`)
            .uid
        : null;
  if (ref.target === 'model' ? model === null : object === null)
    throw new MochiError(
      'E_SCHEMA',
      ref.target === 'model' ? 'A model curve needs `model`.' : 'This curve needs `object`.',
      { path },
    );
  const index = m.curves.findIndex(
    (c) => c.target === ref.target && c.model === model && c.object === object,
  );
  return { m, model, object, index };
}

/** Writes a curve's keys (removing the curve when none are left). */
function write(
  d: Draft,
  m: Motion,
  where: { model: MotionCurve['model']; object: string | null; index: number },
  target: MotionCurve['target'],
  keys: MotionKey[],
  fades?: { fadeIn?: number | null; fadeOut?: number | null },
): void {
  const curves = [...m.curves];
  if (keys.length === 0) {
    if (where.index >= 0) curves.splice(where.index, 1);
  } else {
    const { segments, auto } = keysToCurve(keys);
    const old = where.index >= 0 ? curves[where.index] : undefined;
    const curve: MotionCurve = {
      target,
      model: where.model,
      object: where.object,
      fadeIn: fades?.fadeIn !== undefined ? fades.fadeIn : (old?.fadeIn ?? null),
      fadeOut: fades?.fadeOut !== undefined ? fades.fadeOut : (old?.fadeOut ?? null),
      segments,
      auto,
    };
    if (where.index >= 0) curves[where.index] = curve;
    else curves.push(curve);
  }
  d.put({ ...m, curves });
}

const keysOf = (m: Motion, index: number): MotionKey[] =>
  index >= 0 ? curveKeys(m.curves[index]!.segments, m.curves[index]!.auto) : [];

/** Keys at given times; refuses times with no key. */
function at(keys: MotionKey[], times: number[], path: string): Set<MotionKey> {
  const out = new Set<MotionKey>();
  times.forEach((t, i) => {
    const k = keys.find((x) => Math.abs(x.time - t) < EPS);
    if (!k)
      throw new MochiError('E_RANGE', `There is no key at ${t} s.`, { path: `${path}[${i}]` });
    out.add(k);
  });
  return out;
}

/** Keys made unique by time: a later one at the same time replaces an earlier one. */
function unique(keys: MotionKey[]): MotionKey[] {
  const out: MotionKey[] = [];
  for (const k of keys) {
    const i = out.findIndex((x) => Math.abs(x.time - k.time) < EPS);
    if (i >= 0) out[i] = k;
    else out.push(k);
  }
  return out.sort((a, b) => a.time - b.time);
}

export const motionSetKeys = defineCommand({
  name: 'motion.setKeys',
  summary: 'Replace a motion curve’s keys (creating the curve; no keys removes it).',
  doc: `Keys are (time, value) with the interpolation of the segment after each one: linear, auto (Auto
smooth: Bézier handles computed from the keys, so it eases out and in and never overshoots), step,
inverseStep, or bezier with \`handles\` [t1, v1, t2, v2]. Keys at the same time: the later one wins.
Fades, when given, set the curve's fade-in and fade-out (null: the motion's).`,
  args: Type.Object({
    target: RefOf(['motion']),
    curve: CurveRef(),
    keys: Type.Array(Key()),
    fadeIn: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    fadeOut: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  }),
  result: Type.Object({ keys: Type.Integer() }),
  errors: ['E_SCHEMA', 'E_WRONG_KIND'],
  examples: [
    {
      description: 'A nod that eases in and out',
      args: {
        target: 'motion_0020',
        curve: { target: 'parameter', object: '@param:ParamAngleY' },
        keys: [
          { time: 0, value: 0, interp: 'auto' },
          { time: 0.5, value: 10, interp: 'auto' },
          { time: 1, value: 0 },
        ],
      },
    },
  ],
  apply(d, a) {
    const w = find(d, a.target, a.curve);
    const keys = unique(a.keys.map((k) => ({ interp: 'linear' as Interpolation, ...k })));
    write(d, w.m, w, a.curve.target, keys, { fadeIn: a.fadeIn, fadeOut: a.fadeOut });
    return { keys: keys.length };
  },
});

export const motionInsertKey = defineCommand({
  name: 'motion.insertKey',
  summary: 'Insert a key into a motion curve, or replace the key at that time.',
  doc: `Creates the curve when it has none. Without \`interp\`, a new key takes the interpolation of
the key before it (auto when it is the first), and a replaced key keeps its own.`,
  args: Type.Object({
    target: RefOf(['motion']),
    curve: CurveRef(),
    time: Type.Number({ minimum: 0 }),
    value: Type.Number(),
    interp: Type.Optional(Interp()),
  }),
  result: Type.Object({ keys: Type.Integer() }),
  errors: ['E_SCHEMA', 'E_WRONG_KIND'],
  examples: [
    {
      description: 'Key the head turn at 0.5 s',
      args: {
        target: 'motion_0020',
        curve: { target: 'parameter', object: '@param:ParamAngleX' },
        time: 0.5,
        value: 20,
      },
    },
  ],
  apply(d, a) {
    const w = find(d, a.target, a.curve);
    const keys = keysOf(w.m, w.index);
    const same = keys.find((k) => Math.abs(k.time - a.time) < EPS);
    if (same) {
      same.value = a.value;
      if (a.interp) same.interp = a.interp;
    } else {
      // A key inside a segment splits it (both halves keep its interpolation); a key past the last
      // one makes a new segment, Auto smooth unless `interp` says otherwise.
      const before = [...keys].reverse().find((k) => k.time < a.time);
      const wasLast = before !== undefined && before === keys[keys.length - 1];
      if (wasLast) before.interp = a.interp ?? 'auto';
      keys.push({
        time: a.time,
        value: a.value,
        interp: a.interp ?? (before && !wasLast ? before.interp : 'auto'),
      });
    }
    write(d, w.m, w, a.curve.target, unique(keys));
    return { keys: keys.length };
  },
});

export const motionDeleteKeys = defineCommand({
  name: 'motion.deleteKeys',
  summary: 'Delete keys of a motion curve by their times (the last one removes the curve).',
  doc: 'Fails with E_RANGE when a time has no key.',
  args: Type.Object({
    target: RefOf(['motion']),
    curve: CurveRef(),
    times: Type.Array(Type.Number(), { minItems: 1 }),
  }),
  result: Type.Object({ keys: Type.Integer() }),
  errors: ['E_RANGE', 'E_SCHEMA'],
  examples: [],
  apply(d, a) {
    const w = find(d, a.target, a.curve);
    const keys = keysOf(w.m, w.index);
    const gone = at(keys, a.times, 'args.times');
    const left = keys.filter((k) => !gone.has(k));
    write(d, w.m, w, a.curve.target, left);
    return { keys: left.length };
  },
});

export const motionMoveKeys = defineCommand({
  name: 'motion.moveKeys',
  summary: 'Move keys of a motion curve in time and value.',
  doc: `Adds \`dt\` seconds and \`dv\` to the keys at \`times\`, and moves their Bézier handles along. A
moved key that lands on another key replaces it. Times stay at 0 or later.`,
  args: Type.Object({
    target: RefOf(['motion']),
    curve: CurveRef(),
    times: Type.Array(Type.Number(), { minItems: 1 }),
    dt: Type.Optional(Type.Number()),
    dv: Type.Optional(Type.Number()),
  }),
  result: Type.Object({ keys: Type.Integer() }),
  errors: ['E_RANGE', 'E_SCHEMA'],
  examples: [],
  apply(d, a) {
    const w = find(d, a.target, a.curve);
    const keys = keysOf(w.m, w.index);
    const moving = at(keys, a.times, 'args.times');
    const [dt, dv] = [a.dt ?? 0, a.dv ?? 0];
    const minTime = Math.min(...[...moving].map((k) => k.time));
    const shift = Math.max(dt, -minTime);
    // A key's handle out of it moves with it, and so does the handle into it (on the key before).
    keys.forEach((k, i) => {
      if (!moving.has(k)) return;
      k.time += shift;
      k.value += dv;
      if (k.handles)
        k.handles = [k.handles[0] + shift, k.handles[1] + dv, k.handles[2], k.handles[3]];
      const prev = keys[i - 1];
      if (prev?.handles)
        prev.handles = [
          prev.handles[0],
          prev.handles[1],
          prev.handles[2] + shift,
          prev.handles[3] + dv,
        ];
    });
    // Moved keys win over unmoved ones at the same time.
    const ordered = [...keys.filter((k) => !moving.has(k)), ...keys.filter((k) => moving.has(k))];
    const out = unique(ordered);
    write(d, w.m, w, a.curve.target, out);
    return { keys: out.length };
  },
});

export const motionSetInterpolation = defineCommand({
  name: 'motion.setInterpolation',
  summary: 'Set the interpolation of the segments after keys of a motion curve.',
  doc: `For each key at \`times\`, the segment after it becomes linear, auto (Auto smooth), step,
inverseStep or bezier. A new Bézier segment starts from the curve as it was where it can (the Auto
smooth or default handles), or from \`handles\` when given.`,
  args: Type.Object({
    target: RefOf(['motion']),
    curve: CurveRef(),
    times: Type.Array(Type.Number(), { minItems: 1 }),
    interp: Interp(),
    handles: Type.Optional(
      Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]),
    ),
  }),
  result: Empty,
  errors: ['E_RANGE', 'E_SCHEMA'],
  examples: [],
  apply(d, a) {
    const w = find(d, a.target, a.curve);
    const c = w.index >= 0 ? w.m.curves[w.index]! : undefined;
    const keys = keysOf(w.m, w.index);
    const chosen = at(keys, a.times, 'args.times');
    keys.forEach((k, i) => {
      if (!chosen.has(k)) return;
      const next = keys[i + 1];
      if (a.interp === 'bezier' && next) {
        if (a.handles) k.handles = a.handles;
        else if (!k.handles) {
          // Keep the shape a Bézier segment had (Auto smooth's handles), else thirds on the line.
          const third = (next.time - k.time) / 3;
          const s = c?.segments ?? [];
          k.handles = [
            k.time + third,
            sampleSegments(s, k.time + third),
            next.time - third,
            sampleSegments(s, next.time - third),
          ];
          if (k.interp === 'auto') {
            const { segments } = keysToCurve(keys);
            const after = curveKeys(segments);
            k.handles = after[i]?.handles ?? k.handles;
          }
        }
      }
      k.interp = a.interp;
    });
    write(d, w.m, w, a.curve.target, keys);
    return {};
  },
});

// ---------------------------------------------------------------- animation templates

const templateIndex = (d: Draft, name: string, path = 'args.name'): number => {
  const i = d.project().animationTemplates.findIndex((t) => t.name === name);
  if (i < 0)
    throw new MochiError('E_NOT_FOUND', `There is no animation template named “${name}”.`, {
      path,
    });
  return i;
};
const nameFree = (d: Draft, name: string, path = 'args.name'): void => {
  if (d.project().animationTemplates.some((t) => t.name === name))
    throw new MochiError(
      'E_DUPLICATE_NAME',
      `An animation template named “${name}” exists already.`,
      { path },
    );
};
const shiftKey = (k: MotionKey, dt: number): MotionKey =>
  ({
    ...k,
    time: k.time + dt,
    ...(k.handles
      ? { handles: [k.handles[0] + dt, k.handles[1], k.handles[2] + dt, k.handles[3]] as const }
      : {}),
  }) as MotionKey;

export const templateCreate = defineCommand({
  name: 'template.create',
  summary: 'Make an animation template from a motion’s parameter keys in a range of time.',
  doc: `Takes the keys of the motion's parameter curves from \`from\` to \`to\` (seconds, both
included), or of the given parameters only, with their interpolations. Times are stored from 0, and
the template is named by parameter export ID, so it applies to any model with the same IDs.`,
  args: Type.Object({
    name: Type.String({ minLength: 1 }),
    motion: RefOf(['motion']),
    from: Type.Number({ minimum: 0 }),
    to: Type.Number({ minimum: 0 }),
    parameters: Type.Optional(Type.Array(RefOf(['parameter']))),
  }),
  result: Type.Object({ parameters: Type.Array(Type.String()), keys: Type.Integer() }),
  errors: ['E_DUPLICATE_NAME', 'E_RANGE'],
  examples: [
    {
      description: 'An eye blink from the first half second',
      args: { name: 'Blink', motion: 'motion_0020', from: 0, to: 0.5 },
    },
  ],
  apply(d, a) {
    nameFree(d, a.name);
    if (a.to < a.from)
      throw new MochiError('E_RANGE', 'The range ends before it starts.', { path: 'args.to' });
    const m = d.getAs(a.motion, 'motion', 'args.motion');
    const only = a.parameters?.map((r, i) => d.getAs(r, 'parameter', `args.parameters[${i}]`).uid);
    const curves: AnimationTemplate['curves'] = [];
    m.curves.forEach((c, i) => {
      if (c.target !== 'parameter' || !c.object) return;
      if (only && !only.includes(c.object)) return;
      const p = d.get(c.object);
      if (p?.kind !== 'parameter') return;
      const keys = keysOf(m, i)
        .filter((k) => k.time >= a.from - EPS && k.time <= a.to + EPS)
        .map((k) => shiftKey(k, -a.from));
      if (keys.length) curves.push({ id: p.exportId, keys });
    });
    const n = curves.reduce((s, c) => s + c.keys.length, 0);
    if (n === 0)
      throw new MochiError('E_RANGE', 'There are no parameter keys in this range.', {
        path: 'args.from',
      });
    d.updateProject((p) => ({
      ...p,
      animationTemplates: [
        ...p.animationTemplates,
        { name: a.name, duration: a.to - a.from, curves },
      ],
    }));
    return { parameters: curves.map((c) => c.id), keys: n };
  },
});

export const templateAdd = defineCommand({
  name: 'template.add',
  summary: 'Add an animation template as it is (an imported template file).',
  doc: `With \`replace\`, a template of the same name is replaced; otherwise the name must be new.`,
  args: Type.Object({ template: AnimationTemplate, replace: Type.Optional(Type.Boolean()) }),
  result: Empty,
  errors: ['E_DUPLICATE_NAME'],
  examples: [
    {
      description: 'A blink on the standard eye parameters',
      args: {
        template: {
          name: 'Blink',
          duration: 0.3,
          curves: [
            {
              id: 'ParamEyeLOpen',
              keys: [
                { time: 0, value: 1, interp: 'linear' },
                { time: 0.1, value: 0, interp: 'linear' },
                { time: 0.3, value: 1, interp: 'linear' },
              ],
            },
          ],
        },
      },
    },
  ],
  apply(d, a) {
    const list = [...d.project().animationTemplates];
    const i = list.findIndex((t) => t.name === a.template.name);
    if (i >= 0 && !a.replace) nameFree(d, a.template.name, 'args.template.name');
    const t = {
      ...a.template,
      curves: a.template.curves.map((c) => ({
        ...c,
        keys: [...c.keys].sort((x, y) => x.time - y.time),
      })),
    };
    if (i >= 0) list[i] = t;
    else list.push(t);
    d.updateProject((p) => ({ ...p, animationTemplates: list }));
    return {};
  },
});

export const templateRename = defineCommand({
  name: 'template.rename',
  summary: 'Rename an animation template.',
  doc: 'The new name must not be taken.',
  args: Type.Object({ name: Type.String(), newName: Type.String({ minLength: 1 }) }),
  result: Empty,
  errors: ['E_NOT_FOUND', 'E_DUPLICATE_NAME'],
  examples: [],
  apply(d, a) {
    const i = templateIndex(d, a.name);
    if (a.newName !== a.name) nameFree(d, a.newName, 'args.newName');
    d.updateProject((p) => ({
      ...p,
      animationTemplates: p.animationTemplates.map((t, j) =>
        j === i ? { ...t, name: a.newName } : t,
      ),
    }));
    return {};
  },
});

export const templateDelete = defineCommand({
  name: 'template.delete',
  summary: 'Delete an animation template.',
  doc: 'Motions keep the keys it inserted.',
  args: Type.Object({ name: Type.String() }),
  result: Empty,
  errors: ['E_NOT_FOUND'],
  examples: [],
  apply(d, a) {
    const i = templateIndex(d, a.name);
    d.updateProject((p) => ({
      ...p,
      animationTemplates: p.animationTemplates.filter((_, j) => j !== i),
    }));
    return {};
  },
});

export const templateApply = defineCommand({
  name: 'template.apply',
  summary: 'Insert an animation template’s keys into a motion at a time.',
  doc: `Each of the template's curves goes to the parameter with the same export ID; the others are
reported in \`unmatched\` and left out. On a matched parameter's curve, the keys inside the
template's span (after \`time\`, before \`time\` + its duration) give way to the template's, and keys
at the same time are replaced. Fails with E_NOT_FOUND when no parameter matches.`,
  args: Type.Object({
    name: Type.String(),
    target: RefOf(['motion']),
    time: Type.Number({ minimum: 0 }),
  }),
  result: Type.Object({
    parameters: Type.Array(Type.String(), { description: 'matched export IDs' }),
    unmatched: Type.Array(Type.String(), { description: 'export IDs with no parameter' }),
  }),
  errors: ['E_NOT_FOUND'],
  examples: [
    {
      description: 'Blink at 1.5 s',
      args: { name: 'Blink', target: 'motion_0020', time: 1.5 },
    },
  ],
  apply(d, a) {
    const t = d.project().animationTemplates[templateIndex(d, a.name)]!;
    const ids = new Map(d.ofKind('parameter').map((p) => [p.exportId, p.uid] as const));
    const parameters: string[] = [];
    const unmatched: string[] = [];
    for (const c of t.curves) {
      const uid = ids.get(c.id);
      if (!uid) {
        unmatched.push(c.id);
        continue;
      }
      parameters.push(c.id);
      const ref: Ref = { target: 'parameter', object: uid };
      const w = find(d, a.target, ref);
      const end = a.time + t.duration;
      const kept = keysOf(w.m, w.index).filter(
        (k) => k.time <= a.time + EPS || k.time >= end - EPS,
      );
      const incoming = c.keys.map((k) => shiftKey(k as MotionKey, a.time));
      write(d, w.m, w, 'parameter', unique([...kept, ...incoming]));
    }
    if (parameters.length === 0)
      throw new MochiError(
        'E_NOT_FOUND',
        `None of the template's parameters (${unmatched.join(', ')}) is in this model.`,
        { path: 'args.name' },
      );
    return { parameters, unmatched };
  },
});
