/**
 * Find and replace across export IDs and display names (Ctrl+F): parameters,
 * parts, deformers (warps and rotations) and art meshes. Plain text or a pattern (a JavaScript
 * regular expression, with `$1` and the like in the replacement).
 *
 * Every other object refers to these by UID, so bindings, masks, physics, the pose, expressions,
 * motion curves, hit areas and the standard groups keep pointing at the same objects; the exported
 * files (the `.moc3`, physics, pose, expressions, motions and display info) carry the new IDs and
 * names. `planReplace` is the preview: every change, and every problem the result would have (an
 * invalid or duplicate export ID, checked on the whole result, so that swapping two IDs works). The
 * command `objects.replaceText` applies a plan without problems in one step.
 */
import { Type, type Static } from '@sinclair/typebox';
import type { DocReader } from './document.js';
import { MochiError } from './errors.js';
import { exportNamespace, type DocObject } from './model.js';
import { EXPORT_ID_PATTERN, type Kind } from './schema.js';

export const REPLACE_KINDS = ['parameter', 'part', 'warp', 'rotation', 'artMesh'] as const;
export type ReplaceKind = (typeof REPLACE_KINDS)[number];

export const ReplaceArgs = Type.Object({
  find: Type.String({ minLength: 1, description: 'the text, or a pattern with `pattern: true`' }),
  replace: Type.String({ description: 'the replacement; with a pattern, $1… insert its groups' }),
  pattern: Type.Optional(
    Type.Boolean({ description: 'find is a JavaScript regular expression (default false)' }),
  ),
  ignoreCase: Type.Optional(Type.Boolean({ description: 'default false' })),
  fields: Type.Optional(
    Type.Array(Type.Union([Type.Literal('exportId'), Type.Literal('name')]), {
      minItems: 1,
      description: 'where to look (default both)',
    }),
  ),
  kinds: Type.Optional(
    Type.Array(Type.Union(REPLACE_KINDS.map((k) => Type.Literal(k))), {
      minItems: 1,
      description: 'which objects (default all four groups)',
    }),
  ),
});
export type ReplaceArgs = Static<typeof ReplaceArgs>;

export interface TextChange {
  uid: string;
  kind: ReplaceKind;
  field: 'exportId' | 'name';
  from: string;
  to: string;
}

export interface ReplaceProblem {
  uid: string;
  field: 'exportId';
  to: string;
  code: 'E_BAD_EXPORT_ID' | 'E_DUPLICATE_ID';
  message: string;
}

/** The changes a find and replace makes, and the problems its result would have. */
export function planReplace(
  doc: DocReader,
  a: ReplaceArgs,
): { changes: TextChange[]; problems: ReplaceProblem[] } {
  let re: RegExp;
  const flags = `g${a.ignoreCase ? 'i' : ''}`;
  try {
    re = a.pattern
      ? new RegExp(a.find, flags)
      : new RegExp(a.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch (e) {
    throw new MochiError('E_RANGE', `"${a.find}" is not a valid pattern: ${(e as Error).message}`, {
      path: 'args.find',
    });
  }
  const kinds = new Set<string>(a.kinds ?? REPLACE_KINDS);
  const fields = a.fields ?? ['exportId', 'name'];
  const changes: TextChange[] = [];
  for (const o of doc.ofKind([...REPLACE_KINDS])) {
    if (!kinds.has(o.kind)) continue;
    for (const field of fields) {
      const from = (o as unknown as Record<string, string>)[field];
      if (typeof from !== 'string') continue;
      re.lastIndex = 0;
      if (!re.test(from)) continue;
      re.lastIndex = 0;
      // Plain text is replaced literally ($ has no meaning); a pattern's replacement may use groups.
      const to = a.pattern ? from.replace(re, a.replace) : from.replace(re, () => a.replace);
      if (to !== from) changes.push({ uid: o.uid, kind: o.kind as ReplaceKind, field, from, to });
    }
  }
  // Check the export IDs of the result, per namespace.
  const problems: ReplaceProblem[] = [];
  const next = new Map(changes.filter((c) => c.field === 'exportId').map((c) => [c.uid, c.to]));
  const taken = new Map<string, string[]>();
  for (const o of doc.all()) {
    const ns = exportNamespace(o.kind as Kind);
    if (!ns || !('exportId' in o)) continue;
    const id = next.get(o.uid) ?? (o as DocObject & { exportId: string }).exportId;
    const key = `${ns}\u0000${id}`;
    taken.set(key, [...(taken.get(key) ?? []), o.uid]);
  }
  for (const c of changes) {
    if (c.field !== 'exportId') continue;
    if (!EXPORT_ID_PATTERN.test(c.to)) {
      problems.push({
        uid: c.uid,
        field: 'exportId',
        to: c.to,
        code: 'E_BAD_EXPORT_ID',
        message: `${doc.describe(c.uid)}: "${c.to}" is not a valid export ID (1–63 characters of A–Z, a–z, 0–9 and _).`,
      });
      continue;
    }
    const owners = taken.get(`${exportNamespace(c.kind)}\u0000${c.to}`) ?? [];
    const others = owners.filter((u) => u !== c.uid);
    if (others.length)
      problems.push({
        uid: c.uid,
        field: 'exportId',
        to: c.to,
        code: 'E_DUPLICATE_ID',
        message: `${doc.describe(c.uid)}: "${c.to}" would also be the export ID of ${others.map((u) => doc.describe(u)).join(', ')}.`,
      });
  }
  return { changes, problems };
}
