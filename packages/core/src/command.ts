/**
 * Command definitions (design 4.2).
 *
 * A command is a named, schema-checked, pure operation on a Draft. Arguments are checked against
 * the command's JSON Schema, then every reference argument (annotated `refOf`) is resolved to a
 * UID. The resolved arguments are what the log records, so a replay never depends on names.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Draft } from './document.js';
import { MochiError, type ErrorCode } from './errors.js';
import { annotation, type Kind } from './schema.js';

export interface CommandExample {
  description: string;
  args: Record<string, unknown>;
}

/**
 * Who may run a command (Mochi Studio's bridge protocol, `CommandInfo.scope`):
 * `read` looks only, `edit` changes the document, `export` also writes files outside the project.
 */
export type CommandScope = 'read' | 'edit' | 'export';

export interface CommandDef<
  N extends string = string,
  A extends TSchema = TSchema,
  R extends TSchema = TSchema,
> {
  name: N;
  summary: string;
  /** Markdown: semantics, units and spaces, related commands. */
  doc: string;
  args: A;
  result: R;
  errors: ErrorCode[];
  examples: CommandExample[];
  /** Default 'edit': every document command changes the document. */
  scope?: CommandScope;
  /** Default true: commands run in transactions, which undo reverts. */
  undoable?: boolean;
  apply(d: Draft, args: Static<A>): Static<R>;
}

export function defineCommand<const N extends string, A extends TSchema, R extends TSchema>(
  def: CommandDef<N, A, R>,
): CommandDef<N, A, R> {
  return def;
}

export const Uid = Type.Object({ uid: Type.String() });
export const Empty = Type.Object({});

/** Checks arguments against the schema; the first problem becomes an E_SCHEMA error. */
export function checkArgs(schema: TSchema, args: unknown): void {
  if (Value.Check(schema, args)) return;
  const first = Value.Errors(schema, args).First();
  const path = first ? 'args' + first.path.replace(/\//g, '.') : 'args';
  throw new MochiError('E_SCHEMA', `${path}: ${first?.message ?? 'invalid arguments'}`, { path });
}

const RESULT_REF = /^\$(\d+)(?:\.([A-Za-z]+))?$/;

/**
 * Returns a copy of `args` with every reference resolved to a UID. In a batch, a reference written
 * as `$n` or `$n.field` names the result of command n (its `uid`, or the given field).
 */
export function resolveArgs(
  schema: TSchema,
  args: unknown,
  d: Draft,
  results: readonly unknown[] = [],
): unknown {
  return walk(schema as TSchema & Record<string, unknown>, args, 'args');

  function walk(s: TSchema & Record<string, unknown>, v: unknown, path: string): unknown {
    if (v === undefined || v === null) return v;
    const refOf = annotation<Kind[]>(s, 'refOf');
    if (refOf && typeof v === 'string') {
      let ref = v;
      const m = RESULT_REF.exec(v);
      if (m) {
        const r = results[Number(m[1])] as Record<string, unknown> | string | undefined;
        const value = typeof r === 'string' ? r : r?.[m[2] ?? 'uid'];
        if (typeof value !== 'string')
          throw new MochiError(
            'E_BAD_REF',
            `${v} does not name an earlier result with a ${m[2] ?? 'uid'}`,
            { path },
          );
        ref = value;
      }
      return d.resolve(ref, refOf, path);
    }
    if (Array.isArray(s.anyOf)) {
      for (const variant of s.anyOf as (TSchema & Record<string, unknown>)[]) {
        if (Value.Check(variant, v)) return walk(variant, v, path);
      }
      return v;
    }
    if (s.type === 'array' && Array.isArray(v)) {
      if (Array.isArray(s.items))
        return v.map((x, i) =>
          walk((s.items as (TSchema & Record<string, unknown>)[])[i] as never, x, `${path}[${i}]`),
        );
      return v.map((x, i) =>
        walk(s.items as TSchema & Record<string, unknown>, x, `${path}[${i}]`),
      );
    }
    if (s.type === 'object' && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      const props = s.properties as Record<string, TSchema & Record<string, unknown>> | undefined;
      const pattern = s.patternProperties as
        Record<string, TSchema & Record<string, unknown>> | undefined;
      const patternSchema = pattern ? Object.values(pattern)[0] : undefined;
      const keyRefOf = annotation<Kind[]>(s, 'keyRefOf');
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const ps = props?.[k] ?? patternSchema;
        const key = keyRefOf ? d.resolve(k, keyRefOf, `${path}.${k}`) : k;
        out[key] = ps ? walk(ps, x, `${path}.${k}`) : x;
      }
      return out;
    }
    return v;
  }
}
