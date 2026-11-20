/**
 * Schema-driven conversion between in-memory objects and their JSON form.
 *
 * - decode: checks a JSON value against a schema, rounds float32 fields, builds typed arrays, and
 *   keeps unknown object keys (under the EXTRA symbol) so they are written back unchanged.
 * - encode: the reverse. Float32 numbers are wrapped in F32Num so the JSON writer prints the
 *   shortest text that reads back as the same float32.
 */
import type { TSchema } from '@sinclair/typebox';
import { MochiError } from './errors.js';
import { f32 } from './f32.js';

/** Unknown keys of a decoded object, kept for writing back. */
export const EXTRA: unique symbol = Symbol('mochi.extra');

/** A float32 number in an encoded JSON tree. */
export class F32Num {
  constructor(readonly value: number) {}
}

export type JsonTree =
  null | boolean | number | string | F32Num | JsonTree[] | { [key: string]: JsonTree };

type Schema = TSchema & Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new MochiError('E_SCHEMA', `${path || '(root)'}: ${message}`, { path });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(schema: Schema): string | undefined {
  return schema.type as string | undefined;
}

/** Picks the union member for a value. Objects are matched by their `kind` literal first. */
function pickVariant(variants: Schema[], value: unknown): Schema[] {
  if (value === null) return variants.filter((v) => typeOf(v) === 'null');
  if (isPlainObject(value)) {
    const objects = variants.filter((v) => typeOf(v) === 'object');
    if (objects.length > 1 && typeof value.kind === 'string') {
      const byKind = objects.filter((v) => {
        const k = (v.properties as Record<string, Schema> | undefined)?.kind;
        return k !== undefined && k.const === value.kind;
      });
      if (byKind.length > 0) return byKind;
    }
    return objects;
  }
  return variants.filter((v) => typeOf(v) !== 'null' && typeOf(v) !== 'object');
}

export function decode<T>(schema: TSchema, value: unknown, path = ''): T {
  return decodeAny(schema as Schema, value, path) as T;
}

function decodeAny(schema: Schema, value: unknown, path: string): unknown {
  if (schema.typed !== undefined) return decodeTyped(schema, value, path);

  if (Array.isArray(schema.anyOf)) {
    const candidates = pickVariant(schema.anyOf as Schema[], value);
    let lastError: unknown = null;
    for (const c of candidates) {
      try {
        return decodeAny(c, value, path);
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
    fail(path, `no variant matches ${JSON.stringify(value)}`);
  }

  if ('const' in schema) {
    if (value !== schema.const) fail(path, `expected ${JSON.stringify(schema.const)}`);
    return value;
  }

  switch (typeOf(schema)) {
    case 'null':
      if (value !== null) fail(path, 'expected null');
      return null;
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, 'expected a boolean');
      return value;
    case 'string':
      if (typeof value !== 'string') fail(path, 'expected a string');
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))
        fail(path, `"${value}" does not match ${schema.pattern}`);
      if (typeof schema.minLength === 'number' && value.length < schema.minLength)
        fail(path, 'string too short');
      return value;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        fail(path, 'expected a finite number');
      if (typeOf(schema) === 'integer' && !Number.isInteger(value))
        fail(path, 'expected an integer');
      if (typeof schema.minimum === 'number' && value < schema.minimum)
        fail(path, `below the minimum ${schema.minimum}`);
      if (typeof schema.maximum === 'number' && value > schema.maximum)
        fail(path, `above the maximum ${schema.maximum}`);
      return schema.f32 === true ? f32(value) : value;
    }
    case 'array': {
      if (!Array.isArray(value)) fail(path, 'expected an array');
      if (Array.isArray(schema.items)) {
        const items = schema.items as Schema[];
        if (value.length !== items.length) fail(path, `expected ${items.length} items`);
        return items.map((s, i) => decodeAny(s, value[i], `${path}[${i}]`));
      }
      const item = schema.items as Schema;
      return value.map((v, i) => decodeAny(item, v, `${path}[${i}]`));
    }
    case 'object': {
      if (!isPlainObject(value)) fail(path, 'expected an object');
      const props = schema.properties as Record<string, Schema> | undefined;
      const out: Record<string | symbol, unknown> = {};
      if (props === undefined) {
        const pattern = schema.patternProperties as Record<string, Schema> | undefined;
        const valueSchema = pattern ? Object.values(pattern)[0] : undefined;
        for (const [k, v] of Object.entries(value))
          out[k] = valueSchema ? decodeAny(valueSchema, v, `${path}.${k}`) : v;
        return out;
      }
      const required = new Set((schema.required as string[] | undefined) ?? []);
      for (const [k, s] of Object.entries(props)) {
        if (!(k in value)) {
          if (required.has(k)) fail(`${path}.${k}`, 'missing');
          continue;
        }
        out[k] = decodeAny(s, value[k], path ? `${path}.${k}` : k);
      }
      const extra: Record<string, unknown> = {};
      let hasExtra = false;
      for (const [k, v] of Object.entries(value)) {
        if (!(k in props)) {
          extra[k] = v;
          hasExtra = true;
        }
      }
      if (hasExtra) out[EXTRA] = extra;
      return out;
    }
    default:
      return value;
  }
}

function decodeTyped(schema: Schema, value: unknown, path: string): Float32Array | Uint16Array {
  const stride = schema.stride as number;
  if (!Array.isArray(value)) fail(path, 'expected an array of tuples');
  const flat: number[] = [];
  value.forEach((t, i) => {
    if (!Array.isArray(t) || t.length !== stride)
      fail(`${path}[${i}]`, `expected ${stride} numbers`);
    for (const x of t) {
      if (typeof x !== 'number' || !Number.isFinite(x)) fail(`${path}[${i}]`, 'expected numbers');
      if (schema.typed === 'u16' && (!Number.isInteger(x) || x < 0 || x > 65535))
        fail(`${path}[${i}]`, 'expected integers 0–65535');
      flat.push(x);
    }
  });
  if (schema.typed === 'u16') return Uint16Array.from(flat);
  const arr = Float32Array.from(flat);
  for (let i = 0; i < arr.length; i++) if (arr[i] === 0) arr[i] = 0; // no negative zero
  return arr;
}

export function encode(schema: TSchema, value: unknown): JsonTree {
  return encodeAny(schema as Schema, value);
}

function encodeAny(schema: Schema, value: unknown): JsonTree {
  if (schema.typed !== undefined) {
    const arr = value as Float32Array | Uint16Array;
    const stride = schema.stride as number;
    const out: JsonTree[] = [];
    for (let i = 0; i < arr.length; i += stride) {
      const tuple: JsonTree[] = [];
      for (let j = 0; j < stride; j++) {
        const x = arr[i + j] as number;
        tuple.push(schema.typed === 'f32' ? new F32Num(x) : x);
      }
      out.push(tuple);
    }
    return out;
  }
  if (Array.isArray(schema.anyOf)) {
    const [variant] = pickVariant(schema.anyOf as Schema[], value);
    if (variant === undefined) throw new MochiError('E_INTERNAL', `cannot encode ${String(value)}`);
    return encodeAny(variant, value);
  }
  if ('const' in schema) return value as JsonTree;
  switch (typeOf(schema)) {
    case 'number':
    case 'integer':
      return schema.f32 === true ? new F32Num(value as number) : (value as number);
    case 'array': {
      const arr = value as unknown[];
      if (Array.isArray(schema.items)) {
        const items = schema.items as Schema[];
        return arr.map((v, i) => encodeAny(items[i] as Schema, v));
      }
      return arr.map((v) => encodeAny(schema.items as Schema, v));
    }
    case 'object': {
      const obj = value as Record<string | symbol, unknown>;
      const props = schema.properties as Record<string, Schema> | undefined;
      const out: { [key: string]: JsonTree } = {};
      if (props === undefined) {
        const pattern = schema.patternProperties as Record<string, Schema> | undefined;
        const valueSchema = pattern ? Object.values(pattern)[0] : undefined;
        for (const k of Object.keys(obj))
          out[k] = valueSchema ? encodeAny(valueSchema, obj[k]) : (obj[k] as JsonTree);
        return out;
      }
      for (const [k, s] of Object.entries(props)) {
        if (obj[k] === undefined) continue;
        out[k] = encodeAny(s, obj[k]);
      }
      const extra = obj[EXTRA] as Record<string, JsonTree> | undefined;
      if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v;
      return out;
    }
    default:
      return value as JsonTree;
  }
}

/** Visits every UID reference stored in a value, with its path and allowed kinds. */
export function visitRefs(
  schema: TSchema,
  value: unknown,
  visit: (uid: string, kinds: string[], path: string) => void,
  path = '',
): void {
  const s = schema as Schema;
  if (s.typed !== undefined || value === null || value === undefined) return;
  if (!holdsRefs(s)) return;
  if (Array.isArray(s.anyOf)) {
    const [variant] = pickVariant(s.anyOf as Schema[], value);
    if (variant) visitRefs(variant, value, visit, path);
    return;
  }
  if (Array.isArray(s.uidOf) && typeof value === 'string') {
    visit(value, s.uidOf as string[], path);
    return;
  }
  if (typeOf(s) === 'array' && Array.isArray(value)) {
    if (Array.isArray(s.items)) {
      (s.items as Schema[]).forEach((item, i) => visitRefs(item, value[i], visit, `${path}[${i}]`));
    } else {
      value.forEach((v, i) => visitRefs(s.items as Schema, v, visit, `${path}[${i}]`));
    }
    return;
  }
  if (typeOf(s) === 'object' && isPlainObject(value) && s.properties) {
    for (const [k, ps] of Object.entries(s.properties as Record<string, Schema>))
      visitRefs(ps, value[k], visit, path ? `${path}.${k}` : k);
  }
}

const refCache = new WeakMap<object, boolean>();

/** Whether a schema can contain a UID reference anywhere below it (cached). */
function holdsRefs(s: Schema): boolean {
  const cached = refCache.get(s);
  if (cached !== undefined) return cached;
  refCache.set(s, false); // guards against recursive schemas
  let r = Array.isArray(s.uidOf);
  if (!r && Array.isArray(s.anyOf)) r = (s.anyOf as Schema[]).some(holdsRefs);
  if (!r && Array.isArray(s.items)) r = (s.items as Schema[]).some(holdsRefs);
  else if (!r && s.items && typeof s.items === 'object') r = holdsRefs(s.items as Schema);
  if (!r && s.properties) r = Object.values(s.properties as Record<string, Schema>).some(holdsRefs);
  if (!r && s.patternProperties)
    r = Object.values(s.patternProperties as Record<string, Schema>).some(holdsRefs);
  refCache.set(s, r);
  return r;
}
