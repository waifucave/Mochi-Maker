/** Commands for glue, expressions, motions and physics. */
import { Type, type Static } from '@sinclair/typebox';
import { Empty, Uid, defineCommand } from '../command.js';
import type { Draft } from '../document.js';
import { MochiError } from '../errors.js';
import { f32 } from '../f32.js';
import { segmentError } from '../invariants.js';
import { checkAuto } from '../keys.js';
import type { Glue, Motion, MotionCurve, PhysicsSetting } from '../model.js';
import { ASSET_HASH_PATTERN, RefOf } from '../schema.js';
import { deleteObject, insertAt, newExportId, without } from './helpers.js';

// ---------------------------------------------------------------- glue

const Pairs = () =>
  Type.Array(
    Type.Tuple([
      Type.Integer({ minimum: 0 }),
      Type.Number(),
      Type.Integer({ minimum: 0 }),
      Type.Number(),
    ]),
    {
      description: '[vertex of A, weight of A, vertex of B, weight of B]',
    },
  );

function checkPairs(
  d: Draft,
  meshA: string,
  meshB: string,
  pairs: [number, number, number, number][],
): [number, number, number, number][] {
  const a = d.getAs(meshA, 'artMesh');
  const b = d.getAs(meshB, 'artMesh');
  if (a.uid === b.uid)
    throw new MochiError('E_RANGE', 'A glue needs two different meshes.', { path: 'args.meshB' });
  return pairs.map(([va, wa, vb, wb], i) => {
    if (va >= a.uv.length / 2 || vb >= b.uv.length / 2)
      throw new MochiError('E_SHAPE', `Pair ${i} names a vertex outside its mesh.`, {
        path: `args.pairs[${i}]`,
      });
    return [va, f32(wa), vb, f32(wb)];
  });
}

export const glueCreate = defineCommand({
  name: 'glue.create',
  summary: 'Glue vertices of two meshes together.',
  doc: `Each pair pulls vertex a of mesh A and vertex b of mesh B toward each other after deformation,
by weight × intensity. Weights 0.5/0.5 at intensity 1 join them at the midpoint. Glues apply in
the project's glue order. Intensity is keyformable (default 1).`,
  args: Type.Object({
    exportId: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    meshA: RefOf(['artMesh']),
    meshB: RefOf(['artMesh']),
    pairs: Type.Optional(Pairs()),
    intensity: Type.Optional(Type.Number()),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  result: Uid,
  errors: ['E_RANGE', 'E_SHAPE'],
  examples: [
    {
      description: 'Join two edges',
      args: { meshA: '@mesh:ArtMesh_Neck', meshB: '@mesh:ArtMesh_Face', pairs: [[3, 0.5, 7, 0.5]] },
    },
  ],
  apply(d, a) {
    const pairs = checkPairs(d, a.meshA, a.meshB, a.pairs ?? []);
    const uid = d.allocate('glue');
    const exportId = newExportId(d, 'glue', uid, a.exportId);
    const g: Glue = {
      kind: 'glue',
      uid,
      exportId,
      name: a.name ?? exportId,
      meshA: a.meshA,
      meshB: a.meshB,
      pairs,
      rig: { bindings: [], keyforms: [{ authored: true, intensity: f32(a.intensity ?? 1) }] },
      blendShapes: [],
    };
    d.put(g);
    d.updateProject((p) => ({ ...p, glueOrder: insertAt(p.glueOrder, uid, a.index) }));
    return { uid };
  },
});

export const glueSetPairs = defineCommand({
  name: 'glue.setPairs',
  summary: 'Replace a glue’s vertex pairs.',
  doc: 'Pairs are [vertex of A, weight of A, vertex of B, weight of B].',
  args: Type.Object({ target: RefOf(['glue']), pairs: Pairs() }),
  result: Empty,
  errors: ['E_SHAPE'],
  examples: [
    {
      description: 'Two pairs',
      args: {
        target: '@glue:Glue1',
        pairs: [
          [0, 0.5, 4, 0.5],
          [1, 0.5, 5, 0.5],
        ],
      },
    },
  ],
  apply(d, a) {
    const g = d.getAs(a.target, 'glue');
    d.put({ ...g, pairs: checkPairs(d, g.meshA, g.meshB, a.pairs) });
    return {};
  },
});

export const glueReorder = defineCommand({
  name: 'glue.reorder',
  summary: 'Move a glue in the glue order.',
  doc: 'Later glues see the results of earlier ones, so order matters when glues share vertices.',
  args: Type.Object({ target: RefOf(['glue']), index: Type.Integer({ minimum: 0 }) }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Apply first', args: { target: '@glue:Glue1', index: 0 } }],
  apply(d, a) {
    d.updateProject((p) => ({
      ...p,
      glueOrder: insertAt(without(p.glueOrder, a.target), a.target, a.index),
    }));
    return {};
  },
});

export const glueDelete = defineCommand({
  name: 'glue.delete',
  summary: 'Delete a glue.',
  doc: 'Removes the glue and its keyforms.',
  args: Type.Object({ target: RefOf(['glue']) }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Delete a glue', args: { target: '@glue:Glue1' } }],
  apply(d, a) {
    deleteObject(d, a.target, true, 'glue.delete');
    return {};
  },
});

// ---------------------------------------------------------------- expressions

const Entries = () =>
  Type.Array(
    Type.Object({
      parameter: RefOf(['parameter']),
      value: Type.Number(),
      blend: Type.Optional(
        Type.Union([Type.Literal('Add'), Type.Literal('Multiply'), Type.Literal('Overwrite')]),
      ),
    }),
  );
const Fade = () =>
  Type.Optional(
    Type.Union([Type.Number(), Type.Null()], { description: 'seconds; null = the format default' }),
  );

function entries(list: Static<ReturnType<typeof Entries>>) {
  return list.map((e) => ({
    parameter: e.parameter,
    value: e.value,
    blend: e.blend ?? ('Add' as const),
  }));
}

export const expressionCreate = defineCommand({
  name: 'expression.create',
  summary: 'Create an expression: parameter offsets, factors or overrides with fades.',
  doc: `\`blend\` per entry: 'Add' (default) adds the value, 'Multiply' multiplies, 'Overwrite' replaces.
The name is used in the model settings and as the file stem.`,
  args: Type.Object({
    name: Type.String({ minLength: 1 }),
    fadeIn: Fade(),
    fadeOut: Fade(),
    entries: Type.Optional(Entries()),
  }),
  result: Uid,
  errors: [],
  examples: [
    {
      description: 'Smile',
      args: { name: 'smile', entries: [{ parameter: '@param:ParamMouthForm', value: 1 }] },
    },
  ],
  apply(d, a) {
    const uid = d.allocate('expression');
    d.put({
      kind: 'expression',
      uid,
      name: a.name,
      fadeIn: a.fadeIn ?? null,
      fadeOut: a.fadeOut ?? null,
      entries: entries(a.entries ?? []),
    });
    d.updateProject((p) => ({ ...p, expressionOrder: [...p.expressionOrder, uid] }));
    return { uid };
  },
});

export const expressionUpdate = defineCommand({
  name: 'expression.update',
  summary: 'Change an expression’s name, fades or entries.',
  doc: 'Entries, when given, replace the whole list.',
  args: Type.Object({
    target: RefOf(['expression']),
    name: Type.Optional(Type.String({ minLength: 1 })),
    fadeIn: Fade(),
    fadeOut: Fade(),
    entries: Type.Optional(Entries()),
  }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Slower fade', args: { target: 'expr_0010', fadeIn: 0.5 } }],
  apply(d, a) {
    const e = d.getAs(a.target, 'expression');
    d.put({
      ...e,
      name: a.name ?? e.name,
      fadeIn: a.fadeIn === undefined ? e.fadeIn : a.fadeIn,
      fadeOut: a.fadeOut === undefined ? e.fadeOut : a.fadeOut,
      entries: a.entries ? entries(a.entries) : e.entries,
    });
    return {};
  },
});

export const expressionDelete = defineCommand({
  name: 'expression.delete',
  summary: 'Delete an expression.',
  doc: 'Removes the expression.',
  args: Type.Object({ target: RefOf(['expression']) }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Delete', args: { target: 'expr_0010' } }],
  apply(d, a) {
    deleteObject(d, a.target, true, 'expression.delete');
    return {};
  },
});

// ---------------------------------------------------------------- motions

const MotionMeta = {
  group: Type.Optional(Type.String()),
  duration: Type.Optional(Type.Number({ minimum: 0 })),
  fps: Type.Optional(Type.Number({ minimum: 0 })),
  loop: Type.Optional(Type.Boolean()),
  restrictedBeziers: Type.Optional(Type.Boolean()),
  fadeIn: Fade(),
  fadeOut: Fade(),
};

export const motionCreate = defineCommand({
  name: 'motion.create',
  summary: 'Create an empty motion.',
  doc: '`group` is the motion group in the model settings (default "Idle"). Times are seconds.',
  args: Type.Object({ name: Type.String({ minLength: 1 }), ...MotionMeta }),
  result: Uid,
  errors: [],
  examples: [
    {
      description: 'A 3-second idle',
      args: { name: 'idle', group: 'Idle', duration: 3, fps: 30, loop: true },
    },
  ],
  apply(d, a) {
    const uid = d.allocate('motion');
    const m: Motion = {
      kind: 'motion',
      uid,
      name: a.name,
      group: a.group ?? 'Idle',
      duration: a.duration ?? 1,
      fps: a.fps ?? 30,
      loop: a.loop ?? false,
      restrictedBeziers: a.restrictedBeziers ?? false,
      fadeIn: a.fadeIn ?? null,
      fadeOut: a.fadeOut ?? null,
      curves: [],
      events: [],
      sound: null,
      motionSync: null,
      workArea: null,
      markers: [],
    };
    d.put(m);
    d.updateProject((p) => ({ ...p, motionOrder: [...p.motionOrder, uid] }));
    return { uid };
  },
});

export const motionUpdate = defineCommand({
  name: 'motion.update',
  summary:
    'Change a motion’s name, group, duration, fps, loop flag, Bézier mode, fades, sound or motion-sync setting.',
  doc: `Only the given fields change. With a sound and a motion-sync setting, apps move the mouth by
the setting's analysis of the sound while the motion plays (model settings \`MotionSync\`); without a
setting, the sound drives lip sync.`,
  args: Type.Object({
    target: RefOf(['motion']),
    name: Type.Optional(Type.String({ minLength: 1 })),
    ...MotionMeta,
    sound: Type.Optional(
      Type.Union([RefOf(['sound']), Type.Null()], {
        description: 'a sound to start with the motion, or null for none',
      }),
    ),
    motionSync: Type.Optional(
      Type.Union([RefOf(['motionSyncSetting']), Type.Null()], {
        description:
          'the motion-sync setting through which the sound moves the mouth, or null for lip sync',
      }),
    ),
    workArea: Type.Optional(
      Type.Union(
        [
          Type.Object({
            start: Type.Number({ minimum: 0 }),
            end: Type.Number({ minimum: 0 }),
          }),
          Type.Null(),
        ],
        {
          description:
            'the part that playback loops and exports render, in seconds (start < end), or null for the whole motion',
        },
      ),
    ),
  }),
  result: Empty,
  errors: ['E_RANGE'],
  examples: [
    { description: 'Make it loop', args: { target: 'motion_0020', loop: true } },
    {
      description: 'Set the work area',
      args: { target: 'motion_0020', workArea: { start: 0.5, end: 2 } },
    },
    {
      description: 'Move the mouth by motion sync',
      args: { target: 'motion_0020', motionSync: '@msync~Mouth' },
    },
  ],
  apply(d, a) {
    const m = d.getAs(a.target, 'motion');
    if (a.workArea && !(a.workArea.start < a.workArea.end))
      throw new MochiError('E_RANGE', 'The work area must start before it ends.');
    d.put({
      ...m,
      name: a.name ?? m.name,
      group: a.group ?? m.group,
      duration: a.duration ?? m.duration,
      fps: a.fps ?? m.fps,
      loop: a.loop ?? m.loop,
      restrictedBeziers: a.restrictedBeziers ?? m.restrictedBeziers,
      fadeIn: a.fadeIn === undefined ? m.fadeIn : a.fadeIn,
      fadeOut: a.fadeOut === undefined ? m.fadeOut : a.fadeOut,
      sound: a.sound === undefined ? m.sound : a.sound,
      motionSync: a.motionSync === undefined ? m.motionSync : a.motionSync,
      workArea: a.workArea === undefined ? m.workArea : a.workArea,
    });
    return {};
  },
});

export const motionSetMarkers = defineCommand({
  name: 'motion.setMarkers',
  summary: 'Replace a motion’s timeline markers (time and name).',
  doc: `Markers are the editor's: they label times in the timeline (Ctrl+J and Ctrl+K go to the
previous and next one) and are not exported. They are kept in time order.`,
  args: Type.Object({
    target: RefOf(['motion']),
    markers: Type.Array(Type.Object({ time: Type.Number({ minimum: 0 }), name: Type.String() })),
  }),
  result: Empty,
  errors: [],
  examples: [
    {
      description: 'Two markers',
      args: {
        target: 'motion_0020',
        markers: [
          { time: 0.5, name: 'blink' },
          { time: 2, name: 'turn' },
        ],
      },
    },
  ],
  apply(d, a) {
    const m = d.getAs(a.target, 'motion');
    const markers = a.markers
      .map((e, i) => ({ ...e, i }))
      .sort((x, y) => x.time - y.time || x.i - y.i)
      .map(({ time, name }) => ({ time, name }));
    d.put({ ...m, markers });
    return {};
  },
});

const sameCurve = (c: MotionCurve, target: string, model: string | null, object: string | null) =>
  c.target === target && c.model === model && c.object === object;

export const motionSetCurve = defineCommand({
  name: 'motion.setCurve',
  summary: 'Add or replace one curve of a motion.',
  doc: `A curve animates a parameter, a part's opacity, or a model value (EyeBlink, LipSync, Opacity).
\`segments\` uses the motion file encoding: the first point (time, value), then for each segment a
code and its points: 0 linear (t, v), 1 Bézier (t1, v1, t2, v2, t3, v3), 2 stepped (t, v),
3 inverse stepped (t, v). Times must not go backwards.`,
  args: Type.Object({
    target: RefOf(['motion']),
    curve: Type.Object({
      target: Type.Union([
        Type.Literal('model'),
        Type.Literal('parameter'),
        Type.Literal('partOpacity'),
      ]),
      model: Type.Optional(
        Type.Union([Type.Literal('EyeBlink'), Type.Literal('LipSync'), Type.Literal('Opacity')]),
      ),
      object: Type.Optional(RefOf(['parameter', 'part'])),
      fadeIn: Fade(),
      fadeOut: Fade(),
      segments: Type.Array(Type.Number(), { minItems: 2 }),
      auto: Type.Optional(
        Type.Array(Type.Integer({ minimum: 0 }), {
          description:
            'indices of Bézier segments that are Auto smooth (motion.setKeys computes them)',
        }),
      ),
    }),
  }),
  result: Empty,
  errors: ['E_SCHEMA', 'E_WRONG_KIND'],
  examples: [
    {
      description: 'Nod',
      args: {
        target: 'motion_0020',
        curve: {
          target: 'parameter',
          object: '@param:ParamAngleY',
          segments: [0, 0, 0, 1, 10, 0, 2, 0],
        },
      },
    },
  ],
  apply(d, a) {
    const m = d.getAs(a.target, 'motion');
    const c = a.curve;
    const model = c.target === 'model' ? (c.model ?? null) : null;
    const object = c.target === 'model' ? null : (c.object ?? null);
    if (c.target === 'model' ? model === null : object === null)
      throw new MochiError(
        'E_SCHEMA',
        c.target === 'model' ? 'A model curve needs `model`.' : 'This curve needs `object`.',
        { path: 'args.curve' },
      );
    if (object !== null)
      d.getAs(object, c.target === 'parameter' ? 'parameter' : 'part', 'args.curve.object');
    const err = segmentError(c.segments);
    if (err)
      throw new MochiError('E_SCHEMA', `Invalid segments: ${err}.`, {
        path: 'args.curve.segments',
      });
    const curve: MotionCurve = {
      target: c.target,
      model,
      object,
      fadeIn: c.fadeIn ?? null,
      fadeOut: c.fadeOut ?? null,
      segments: [...c.segments],
      auto: checkAuto(c.segments, c.auto ?? [], 'args.curve.auto'),
    };
    const i = m.curves.findIndex((x) => sameCurve(x, c.target, model, object));
    const curves = [...m.curves];
    if (i >= 0) curves[i] = curve;
    else curves.push(curve);
    d.put({ ...m, curves });
    return {};
  },
});

export const motionRemoveCurve = defineCommand({
  name: 'motion.removeCurve',
  summary: 'Remove one curve from a motion.',
  doc: 'Names the curve by its target and model value or object.',
  args: Type.Object({
    target: RefOf(['motion']),
    curveTarget: Type.Union([
      Type.Literal('model'),
      Type.Literal('parameter'),
      Type.Literal('partOpacity'),
    ]),
    model: Type.Optional(
      Type.Union([Type.Literal('EyeBlink'), Type.Literal('LipSync'), Type.Literal('Opacity')]),
    ),
    object: Type.Optional(RefOf(['parameter', 'part'])),
  }),
  result: Empty,
  errors: ['E_NOT_FOUND'],
  examples: [
    {
      description: 'Remove the nod',
      args: { target: 'motion_0020', curveTarget: 'parameter', object: '@param:ParamAngleY' },
    },
  ],
  apply(d, a) {
    const m = d.getAs(a.target, 'motion');
    const model = a.curveTarget === 'model' ? (a.model ?? null) : null;
    const object = a.curveTarget === 'model' ? null : (a.object ?? null);
    const curves = m.curves.filter((c) => !sameCurve(c, a.curveTarget, model, object));
    if (curves.length === m.curves.length)
      throw new MochiError('E_NOT_FOUND', 'The motion has no such curve.');
    d.put({ ...m, curves });
    return {};
  },
});

export const motionSetEvents = defineCommand({
  name: 'motion.setEvents',
  summary: 'Replace a motion’s events (time and string).',
  doc: 'Events fire when playback passes their time. They are written in time order.',
  args: Type.Object({
    target: RefOf(['motion']),
    events: Type.Array(Type.Object({ time: Type.Number({ minimum: 0 }), value: Type.String() })),
  }),
  result: Empty,
  errors: [],
  examples: [
    {
      description: 'One event',
      args: { target: 'motion_0020', events: [{ time: 1.5, value: 'blink' }] },
    },
  ],
  apply(d, a) {
    const m = d.getAs(a.target, 'motion');
    const events = a.events
      .map((e, i) => ({ ...e, i }))
      .sort((x, y) => x.time - y.time || x.i - y.i)
      .map(({ time, value }) => ({ time, value }));
    d.put({ ...m, events });
    return {};
  },
});

export const motionMarkersToEvents = defineCommand({
  name: 'motion.markersToEvents',
  summary: 'Write a motion’s markers as events (user data) at their times.',
  doc: `«Markers to Events»: each marker becomes an event with the marker's name as its value,
at the marker's time, added to the motion's events in time order. An event with the same time and
value is not added twice. The markers stay. The export never does this by itself.`,
  args: Type.Object({ target: RefOf(['motion']) }),
  result: Type.Object({ added: Type.Integer() }),
  errors: [],
  examples: [{ description: 'Markers to events', args: { target: 'motion_0020' } }],
  apply(d, a) {
    const m = d.getAs(a.target, 'motion');
    const have = new Set(m.events.map((e) => `${e.time}\u0000${e.value}`));
    const add = m.markers
      .map((k) => ({ time: k.time, value: k.name }))
      .filter((e) => !have.has(`${e.time}\u0000${e.value}`));
    if (add.length === 0) return { added: 0 };
    const events = [...m.events, ...add]
      .map((e, i) => ({ ...e, i }))
      .sort((x, y) => x.time - y.time || x.i - y.i)
      .map(({ time, value }) => ({ time, value }));
    d.put({ ...m, events });
    return { added: add.length };
  },
});

export const motionDelete = defineCommand({
  name: 'motion.delete',
  summary: 'Delete a motion.',
  doc: 'Removes the motion.',
  args: Type.Object({ target: RefOf(['motion']) }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Delete', args: { target: 'motion_0020' } }],
  apply(d, a) {
    deleteObject(d, a.target, true, 'motion.delete');
    return {};
  },
});

export const motionReorder = defineCommand({
  name: 'motion.reorder',
  summary: 'Move a motion to a position in the motion order.',
  doc: `The motion order is the order of each group's entries in the model settings, so it decides which
motion a group index names (an app's startMotion(group, index)) and which one idle playback picks
(§3l.7: entry ⌊r·n⌋ of the Idle group).`,
  args: Type.Object({ target: RefOf(['motion']), index: Type.Integer({ minimum: 0 }) }),
  result: Empty,
  errors: [],
  examples: [
    { description: 'Make it the first motion', args: { target: 'motion_0020', index: 0 } },
  ],
  apply(d, a) {
    d.updateProject((p) => ({
      ...p,
      motionOrder: insertAt(without(p.motionOrder, a.target), a.target, a.index),
    }));
    return {};
  },
});

// ---------------------------------------------------------------- sounds

export const soundCreate = defineCommand({
  name: 'sound.create',
  summary: 'Create a sound from a WAV asset already in the project’s asset store.',
  doc: `Usually run by the sound.import operation, which reads a WAV file, stores it and runs this. A
motion starts a sound with motion.update { sound }. Apps play it with the motion, and lip sync
follows its level (§3b.2, 3s).`,
  args: Type.Object({
    name: Type.String({ minLength: 1 }),
    asset: Type.String({ pattern: ASSET_HASH_PATTERN.source }),
    sampleRate: Type.Integer({ minimum: 1 }),
    channels: Type.Integer({ minimum: 1 }),
    frames: Type.Integer({ minimum: 0 }),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  result: Uid,
  errors: [],
  examples: [
    {
      description: 'A one-second mono sound',
      args: {
        name: 'hello',
        asset: '0'.repeat(64),
        sampleRate: 16000,
        channels: 1,
        frames: 16000,
      },
    },
  ],
  apply(d, a) {
    const uid = d.allocate('sound');
    const { index, ...fields } = a;
    d.put({ kind: 'sound', uid, ...fields });
    d.updateProject((p) => ({ ...p, soundOrder: insertAt(p.soundOrder, uid, index) }));
    return { uid };
  },
});

export const soundUpdate = defineCommand({
  name: 'sound.update',
  summary: 'Rename a sound.',
  doc: 'The name is also the exported file name (sounds/<name>.wav).',
  args: Type.Object({ target: RefOf(['sound']), name: Type.String({ minLength: 1 }) }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Rename', args: { target: 'sound_0030', name: 'greeting' } }],
  apply(d, a) {
    d.put({ ...d.getAs(a.target, 'sound'), name: a.name });
    return {};
  },
});

export const soundDelete = defineCommand({
  name: 'sound.delete',
  summary: 'Delete a sound.',
  doc: 'Without `cascade`, fails while a motion uses it; with `cascade`, those motions lose it.',
  args: Type.Object({ target: RefOf(['sound']), cascade: Type.Optional(Type.Boolean()) }),
  result: Empty,
  errors: ['E_IN_USE'],
  examples: [{ description: 'Delete', args: { target: 'sound_0030', cascade: true } }],
  apply(d, a) {
    deleteObject(d, a.target, a.cascade ?? false, 'sound.delete');
    return {};
  },
});

// ---------------------------------------------------------------- physics

const IO = {
  parameter: RefOf(['parameter']),
  weight: Type.Number(),
  type: Type.Union([Type.Literal('X'), Type.Literal('Y'), Type.Literal('Angle')]),
  reflect: Type.Optional(Type.Boolean()),
};
const Range3 = Type.Object({ min: Type.Number(), default: Type.Number(), max: Type.Number() });
const SettingFields = {
  name: Type.String(),
  inputs: Type.Array(Type.Object(IO)),
  outputs: Type.Array(
    Type.Object({ ...IO, particle: Type.Integer({ minimum: 0 }), scale: Type.Number() }),
  ),
  particles: Type.Array(
    Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      mobility: Type.Number(),
      delay: Type.Number(),
      acceleration: Type.Number(),
      radius: Type.Number(),
    }),
    { minItems: 1 },
  ),
  normalization: Type.Object({ position: Range3, angle: Range3 }),
};

function setting(
  uid: string,
  a: Static<ReturnType<typeof Type.Object<typeof SettingFields>>>,
): PhysicsSetting {
  a.outputs.forEach((o, i) => {
    if (o.particle >= a.particles.length)
      throw new MochiError(
        'E_RANGE',
        `Output ${i} uses particle ${o.particle}, but there are ${a.particles.length}.`,
        { path: `args.outputs[${i}].particle` },
      );
  });
  return {
    kind: 'physicsSetting',
    uid,
    name: a.name,
    inputs: a.inputs.map((i) => ({
      parameter: i.parameter,
      weight: i.weight,
      type: i.type,
      reflect: i.reflect ?? false,
    })),
    outputs: a.outputs.map((o) => ({
      parameter: o.parameter,
      weight: o.weight,
      type: o.type,
      reflect: o.reflect ?? false,
      particle: o.particle,
      scale: o.scale,
    })),
    particles: a.particles.map((p) => ({ ...p })),
    normalization: {
      position: { ...a.normalization.position },
      angle: { ...a.normalization.angle },
    },
  };
}

export const physicsAdd = defineCommand({
  name: 'physics.addSetting',
  summary: 'Add a pendulum physics setting.',
  doc: `Inputs read parameters (weight in percent, type X, Y or Angle); outputs write parameters from a
particle's motion; particles are the pendulum chain, root first. Settings run in order.`,
  args: Type.Object({ ...SettingFields, index: Type.Optional(Type.Integer({ minimum: 0 })) }),
  result: Uid,
  errors: ['E_RANGE'],
  examples: [
    {
      description: 'Hair sway',
      args: {
        name: 'Hair front',
        inputs: [{ parameter: '@param:ParamAngleX', weight: 60, type: 'X' }],
        outputs: [
          { parameter: '@param:ParamHairFront', weight: 100, type: 'Angle', particle: 1, scale: 1 },
        ],
        particles: [
          { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
          { x: 0, y: 10, mobility: 0.95, delay: 0.9, acceleration: 1.5, radius: 10 },
        ],
        normalization: {
          position: { min: -10, default: 0, max: 10 },
          angle: { min: -10, default: 0, max: 10 },
        },
      },
    },
  ],
  apply(d, a) {
    const uid = d.allocate('physicsSetting');
    const { index, ...fields } = a;
    d.put(setting(uid, fields));
    d.updateProject((p) => ({ ...p, physicsOrder: insertAt(p.physicsOrder, uid, index) }));
    return { uid };
  },
});

export const physicsUpdate = defineCommand({
  name: 'physics.updateSetting',
  summary: 'Replace a physics setting’s inputs, outputs, particles and normalization.',
  doc: 'All fields are replaced together.',
  args: Type.Object({ target: RefOf(['physicsSetting']), ...SettingFields }),
  result: Empty,
  errors: ['E_RANGE'],
  examples: [],
  apply(d, a) {
    d.getAs(a.target, 'physicsSetting');
    const { target, ...fields } = a;
    d.put(setting(target, fields));
    return {};
  },
});

export const physicsRemove = defineCommand({
  name: 'physics.removeSetting',
  summary: 'Remove a physics setting.',
  doc: 'Removes the setting.',
  args: Type.Object({ target: RefOf(['physicsSetting']) }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Remove', args: { target: 'phys_0030' } }],
  apply(d, a) {
    deleteObject(d, a.target, true, 'physics.removeSetting');
    return {};
  },
});

export const physicsSetFps = defineCommand({
  name: 'physics.setFps',
  summary: 'Set the physics simulation rate (0: one step per frame).',
  doc: 'Exported as the physics file’s Meta.Fps.',
  args: Type.Object({ fps: Type.Number({ minimum: 0 }) }),
  result: Empty,
  errors: [],
  examples: [{ description: '60 steps per second', args: { fps: 60 } }],
  apply(d, a) {
    d.updateProject((p) => ({ ...p, physicsFps: a.fps }));
    return {};
  },
});
