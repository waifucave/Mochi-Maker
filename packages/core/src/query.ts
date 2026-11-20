/**
 * Read-only queries over a document (agent API design 2.5). Results are plain JSON.
 *
 * Without `fields`, each item is a compact summary: scalar fields, plus counts for geometry and a
 * short description of the rig. With `fields`, the named fields are returned in full, in their
 * project-file JSON form (points as [x, y] pairs).
 */
import { encode, F32Num, type JsonTree } from './codec.js';
import type { DocReader } from './document.js';
import { MochiError } from './errors.js';
import { OBJECT_SCHEMAS, type DocObject } from './model.js';
import type { Kind } from './schema.js';

export interface QueryOptions {
  kind?: Kind | Kind[];
  where?: Record<string, unknown>;
  fields?: string[];
  offset?: number;
  limit?: number;
}

export interface QueryResult {
  total: number;
  items: Record<string, unknown>[];
}

/** Converts an encoded tree to plain JSON (float32 wrappers become numbers). */
export function plain(tree: JsonTree): unknown {
  if (tree instanceof F32Num) return tree.value;
  if (Array.isArray(tree)) return tree.map(plain);
  if (tree !== null && typeof tree === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tree)) out[k] = plain(v);
    return out;
  }
  return tree;
}

/** The full JSON form of an object. */
export function toJson(o: DocObject): Record<string, unknown> {
  return plain(encode(OBJECT_SCHEMAS[o.kind], o)) as Record<string, unknown>;
}

/** A compact summary of an object. */
export function summarize(o: DocObject): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  if (o.kind === 'artMesh') {
    out.vertexCount = o.uv.length / 2;
    out.triangleCount = o.triangles.length / 3;
    out.clip = o.clip;
  }
  if (o.kind === 'part') out.children = o.children;
  if (o.kind === 'parameter') out.keys = o.keys;
  if ('rig' in o) {
    out.bindings = o.rig.bindings.map((b) => ({ parameter: b.parameter, keys: b.keys }));
    out.keyformCount = o.rig.keyforms.length;
    out.filledKeyforms = o.rig.keyforms.filter((k) => !k.authored).length;
  }
  if (o.kind === 'motion') out.curveCount = o.curves.length;
  if (o.kind === 'expression') out.entryCount = o.entries.length;
  return out;
}

export function query(doc: DocReader, q: QueryOptions = {}): QueryResult {
  const kinds = q.kind === undefined ? undefined : Array.isArray(q.kind) ? q.kind : [q.kind];
  let items = [...(kinds ? doc.ofKind(kinds) : doc.ofKind(Object.keys(OBJECT_SCHEMAS) as Kind[]))];
  if (q.where) {
    const where = q.where;
    items = items.filter((o) =>
      Object.entries(where).every(([k, v]) => (o as unknown as Record<string, unknown>)[k] === v),
    );
  }
  const total = items.length;
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 200;
  const page = items.slice(offset, offset + limit);
  const out = page.map((o) => {
    if (!q.fields) return summarize(o);
    const full = toJson(o);
    const r: Record<string, unknown> = { uid: o.uid, kind: o.kind };
    for (const f of q.fields) {
      if (!(f in full))
        throw new MochiError('E_SCHEMA', `A ${o.kind} has no field "${f}".`, { path: 'fields' });
      r[f] = full[f];
    }
    return r;
  });
  return { total, items: out };
}
