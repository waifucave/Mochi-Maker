/**
 * Schema helpers.
 *
 * Document objects and command arguments are described with TypeBox, so each schema gives both
 * a static TypeScript type and a JSON Schema for introspection. A few custom annotations drive
 * the project codec (codec.ts) and reference handling:
 *
 * - `f32: true` on a number: the value is a float32 (rounded on read, written as float32 text).
 * - `typed: 'f32' | 'u16'` with `stride`: in memory a typed array; in JSON an array of tuples.
 * - `uidOf: Kind[]` on a string: a reference to another document object.
 * - `refOf: Kind[]` on a command argument: a reference in any accepted form (UID, `@kind:ExportId`,
 *   `@kind~"Display name"`), resolved to a UID before the command runs.
 */
import { Type, type TSchema, type TString, type TNumber, type TUnsafe } from '@sinclair/typebox';

export type Kind =
  | 'project'
  | 'parameter'
  | 'parameterGroup'
  | 'part'
  | 'artMesh'
  | 'warp'
  | 'rotation'
  | 'layer'
  | 'glue'
  | 'expression'
  | 'motion'
  | 'physicsSetting'
  | 'motionSyncSetting'
  | 'sound';

/** UID prefix per kind. A UID is `<prefix>_<number>`, except the singleton `project`. */
export const UID_PREFIX: Record<Exclude<Kind, 'project'>, string> = {
  parameter: 'param',
  parameterGroup: 'pgroup',
  part: 'part',
  artMesh: 'mesh',
  warp: 'warp',
  rotation: 'rot',
  layer: 'layer',
  glue: 'glue',
  expression: 'expr',
  motion: 'motion',
  physicsSetting: 'phys',
  motionSyncSetting: 'msync',
  sound: 'sound',
};

/** Kind names accepted in `@kind:` references. `deformer` means warp or rotation. */
export const REF_KIND_NAMES: Record<string, Kind[]> = {
  param: ['parameter'],
  pgroup: ['parameterGroup'],
  part: ['part'],
  mesh: ['artMesh'],
  warp: ['warp'],
  rot: ['rotation'],
  rotation: ['rotation'],
  deformer: ['warp', 'rotation'],
  layer: ['layer'],
  glue: ['glue'],
  expr: ['expression'],
  motion: ['motion'],
  phys: ['physicsSetting'],
  msync: ['motionSyncSetting'],
  sound: ['sound'],
};

export const UID_PATTERN = /^(project|[a-z]+_[0-9]+)$/;
export const EXPORT_ID_PATTERN = /^[A-Za-z0-9_]{1,63}$/;
export const ASSET_HASH_PATTERN = /^[0-9a-f]{64}$/;

export const DEFORMER_KINDS: Kind[] = ['warp', 'rotation'];
export const RIGGABLE_KINDS: Kind[] = ['part', 'artMesh', 'warp', 'rotation', 'glue'];

/** A float32 number. */
export const F32 = (options: Record<string, unknown> = {}): TNumber =>
  Type.Number({ ...options, f32: true });

/** A stored reference to another object (always a UID). */
export const UidOf = (kinds: Kind[], options: Record<string, unknown> = {}): TString =>
  Type.String({ ...options, uidOf: kinds });

/** A command argument that names an object; any reference form is accepted. */
export const RefOf = (kinds: Kind[], options: Record<string, unknown> = {}): TString =>
  Type.String({
    description: `Reference to a ${kinds.join(' or ')}: a UID, @kind:ExportId or @kind~"Display name"`,
    ...options,
    refOf: kinds,
  });

export const ExportId = (options: Record<string, unknown> = {}): TString =>
  Type.String({ pattern: EXPORT_ID_PATTERN.source, maxLength: 63, ...options });

/** Points stored as a Float32Array [x0, y0, x1, y1, ...]; JSON form [[x0, y0], [x1, y1], ...]. */
export const F32Points = (description = 'points'): TUnsafe<Float32Array> =>
  Type.Unsafe<Float32Array>(
    Type.Array(Type.Tuple([Type.Number(), Type.Number()]), {
      typed: 'f32',
      stride: 2,
      description,
    }),
  );

/** Triangles stored as a Uint16Array; JSON form [[a, b, c], ...]. */
export const U16Triangles = (): TUnsafe<Uint16Array> =>
  Type.Unsafe<Uint16Array>(
    Type.Array(Type.Tuple([Type.Integer(), Type.Integer(), Type.Integer()]), {
      typed: 'u16',
      stride: 3,
      description: 'triangles as vertex-index triples',
    }),
  );

export const Rgb = () =>
  Type.Tuple([F32(), F32(), F32()], { description: 'RGB, 0–1 (not clamped)' });

export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Reads a custom annotation from a schema. */
export function annotation<T>(schema: TSchema, key: string): T | undefined {
  return (schema as Record<string, unknown>)[key] as T | undefined;
}

/** A plain JSON copy of a schema, without TypeBox's symbol keys, for introspection output. */
export function toJsonSchema(schema: TSchema): unknown {
  return JSON.parse(JSON.stringify(schema));
}
