/**
 * Motion-sync settings: add, update and remove. A setting names the mouth parameters it
 * drives (with their damper and smoothing), the audio elements Mochi2D's analysis weighs (Silence
 * and the vowels A, I, U, E, O by default), and each element's shape: a value per driven parameter.
 * Names are unique: motions and apps pick a setting by its name.
 */
import { Type } from '@sinclair/typebox';
import { Empty, Uid, defineCommand } from '../command.js';
import type { Draft } from '../document.js';
import { MochiError } from '../errors.js';
import type { MotionSyncSetting } from '../model.js';
import { RefOf } from '../schema.js';
import { deleteObject, insertAt } from './helpers.js';

/** The audio elements of a new setting, in their usual order. */
export const MOTION_SYNC_DEFAULT_ELEMENTS = ['Silence', 'A', 'I', 'U', 'E', 'O'] as const;

/**
 * Typical vowel shapes for the usual mouth parameters, by element ID: a starting point for a new
 * setting. Other parameters and elements start at 0.
 */
export const MOTION_SYNC_TYPICAL_SHAPES: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  ParamMouthOpenY: { Silence: 0, A: 1, I: 0.3, U: 0.4, E: 0.6, O: 0.8 },
  ParamMouthForm: { Silence: 0, A: 0, I: 1, U: -1, E: 0.5, O: -0.6 },
};

/** The typical value of element `id` for a parameter, within the parameter's range. */
function typical(d: Draft, parameter: string, id: string): number {
  const p = d.getAs(parameter, 'parameter');
  const v = MOTION_SYNC_TYPICAL_SHAPES[p.exportId]?.[id] ?? 0;
  return Math.min(p.max, Math.max(p.min, v));
}

const Driven = Type.Object({
  parameter: RefOf(['parameter']),
  damper: Type.Optional(Type.Number({ minimum: 0, description: 'dead band (default 0)' })),
  smooth: Type.Optional(
    Type.Number({ minimum: 0, maximum: 100, description: 'smoothing, percent (default 0)' }),
  ),
});
const Element = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 10 })),
});
const Fields = {
  useCase: Type.Optional(Type.String()),
  analysisType: Type.Optional(Type.String()),
  sampleRate: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
  smoothing: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  blendRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  parameters: Type.Optional(Type.Array(Driven)),
  elements: Type.Optional(Type.Array(Element, { minItems: 1 })),
  shapes: Type.Optional(
    Type.Array(Type.Array(Type.Number()), {
      description: "shapes[e][k]: element e's value for driven parameter k",
    }),
  ),
};

function uniqueName(d: Draft, name: string, except?: string): void {
  const other = d.ofKind('motionSyncSetting').find((s) => s.name === name && s.uid !== except);
  if (other)
    throw new MochiError('E_DUPLICATE_NAME', `A motion-sync setting is already named "${name}".`, {
      path: 'args.name',
    });
}

function checkIds<T>(list: readonly T[], key: (x: T) => string, what: string, path: string): void {
  const seen = new Set<string>();
  for (const x of list) {
    if (seen.has(key(x)))
      throw new MochiError('E_SHAPE', `${what} "${key(x)}" is named twice.`, { path });
    seen.add(key(x));
  }
}

function checkShapes(shapes: number[][], elements: number, parameters: number): void {
  if (shapes.length !== elements || shapes.some((r) => r.length !== parameters))
    throw new MochiError(
      'E_SHAPE',
      `The shapes need ${elements} row(s) (one per element) of ${parameters} value(s) (one per driven parameter).`,
      { path: 'args.shapes' },
    );
  if (shapes.some((r) => r.some((v) => !Number.isFinite(v))))
    throw new MochiError('E_SHAPE', 'Shape values must be finite numbers.', {
      path: 'args.shapes',
    });
}

export const motionSyncAdd = defineCommand({
  name: 'motionSync.addSetting',
  summary: 'Add a motion-sync setting: driven parameters, audio elements and their shapes.',
  doc: `Elements default to Silence, A, I, U, E and O (enabled, scale 1); useCase 'Mouth',
analysisType 'CRI', sampleRate 30, smoothing 10, blendRatio 0. Without \`shapes\`, ParamMouthOpenY
and ParamMouthForm start at typical vowel shapes (A open, I wide, U round and so on: a starting point
to adjust), and other parameters at 0. Exported as the model's .motionsync3.json. Names are unique.`,
  args: Type.Object({
    name: Type.String({ minLength: 1 }),
    ...Fields,
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  result: Uid,
  errors: ['E_DUPLICATE_NAME', 'E_SHAPE'],
  examples: [
    {
      description: 'Mouth open and form',
      args: {
        name: 'Mouth',
        parameters: [
          { parameter: '@param:ParamMouthOpenY' },
          { parameter: '@param:ParamMouthForm' },
        ],
        shapes: [
          [0, 0],
          [1, 0],
          [0.4, 1],
          [0.3, -1],
          [0.6, 0.5],
          [0.8, -0.5],
        ],
      },
    },
  ],
  apply(d, a) {
    uniqueName(d, a.name);
    const parameters = (a.parameters ?? []).map((p) => ({
      parameter: d.getAs(p.parameter, 'parameter').uid,
      damper: p.damper ?? 0,
      smooth: p.smooth ?? 0,
    }));
    const elements = (
      a.elements ??
      MOTION_SYNC_DEFAULT_ELEMENTS.map(
        (id): { id: string; name?: string; enabled?: boolean; scale?: number } => ({ id }),
      )
    ).map((e) => ({
      id: e.id,
      name: e.name ?? e.id,
      enabled: e.enabled ?? true,
      scale: e.scale ?? 1,
    }));
    checkIds(parameters, (p) => p.parameter, 'Parameter', 'args.parameters');
    checkIds(elements, (e) => e.id, 'Element', 'args.elements');
    const shapes =
      a.shapes ?? elements.map((e) => parameters.map((p) => typical(d, p.parameter, e.id)));
    checkShapes(shapes, elements.length, parameters.length);
    const uid = d.allocate('motionSyncSetting');
    const s: MotionSyncSetting = {
      kind: 'motionSyncSetting',
      uid,
      name: a.name,
      useCase: a.useCase ?? 'Mouth',
      analysisType: a.analysisType ?? 'CRI',
      sampleRate: a.sampleRate ?? 30,
      smoothing: a.smoothing ?? 10,
      blendRatio: a.blendRatio ?? 0,
      parameters,
      elements,
      shapes: shapes.map((r) => [...r]),
    };
    d.put(s);
    d.updateProject((p) => ({
      ...p,
      motionSyncOrder: insertAt(p.motionSyncOrder, uid, a.index),
    }));
    return { uid };
  },
});

export const motionSyncUpdate = defineCommand({
  name: 'motionSync.updateSetting',
  summary: 'Change a motion-sync setting; shapes follow its parameters and elements.',
  doc: `Only the given fields change. When the driven parameters or the elements change without
\`shapes\`, each shape value is kept by parameter and element, and new ones start as in
motionSync.addSetting: typical vowel shapes for ParamMouthOpenY and ParamMouthForm, 0 otherwise.`,
  args: Type.Object({
    target: RefOf(['motionSyncSetting']),
    name: Type.Optional(Type.String({ minLength: 1 })),
    ...Fields,
  }),
  result: Empty,
  errors: ['E_DUPLICATE_NAME', 'E_SHAPE'],
  examples: [
    {
      description: 'Blend the shapes by weight',
      args: { target: '@msync~Mouth', blendRatio: 1 },
    },
  ],
  apply(d, a) {
    const s = d.getAs(a.target, 'motionSyncSetting');
    if (a.name !== undefined) uniqueName(d, a.name, s.uid);
    const parameters = a.parameters
      ? a.parameters.map((p) => {
          const uid = d.getAs(p.parameter, 'parameter').uid;
          const was = s.parameters.find((x) => x.parameter === uid);
          return {
            parameter: uid,
            damper: p.damper ?? was?.damper ?? 0,
            smooth: p.smooth ?? was?.smooth ?? 0,
          };
        })
      : s.parameters;
    const elements = a.elements
      ? a.elements.map((e) => {
          const was = s.elements.find((x) => x.id === e.id);
          return {
            id: e.id,
            name: e.name ?? was?.name ?? e.id,
            enabled: e.enabled ?? was?.enabled ?? true,
            scale: e.scale ?? was?.scale ?? 1,
          };
        })
      : s.elements;
    checkIds(parameters, (p) => p.parameter, 'Parameter', 'args.parameters');
    checkIds(elements, (e) => e.id, 'Element', 'args.elements');
    const shapes =
      a.shapes ??
      elements.map((e) => {
        const row = s.elements.findIndex((x) => x.id === e.id);
        return parameters.map((p) => {
          const col = s.parameters.findIndex((x) => x.parameter === p.parameter);
          return row >= 0 && col >= 0 ? s.shapes[row]![col]! : typical(d, p.parameter, e.id);
        });
      });
    checkShapes(shapes, elements.length, parameters.length);
    d.put({
      ...s,
      name: a.name ?? s.name,
      useCase: a.useCase ?? s.useCase,
      analysisType: a.analysisType ?? s.analysisType,
      sampleRate: a.sampleRate ?? s.sampleRate,
      smoothing: a.smoothing ?? s.smoothing,
      blendRatio: a.blendRatio ?? s.blendRatio,
      parameters,
      elements,
      shapes: shapes.map((r) => [...r]),
    });
    return {};
  },
});

export const motionSyncRemove = defineCommand({
  name: 'motionSync.removeSetting',
  summary: 'Remove a motion-sync setting.',
  doc: 'The setting leaves the export; nothing else refers to it.',
  args: Type.Object({ target: RefOf(['motionSyncSetting']) }),
  result: Empty,
  errors: [],
  examples: [{ description: 'Remove', args: { target: '@msync~Mouth' } }],
  apply(d, a) {
    deleteObject(d, a.target, true, 'motionSync.removeSetting');
    return {};
  },
});
