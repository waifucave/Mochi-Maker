/**
 * Copy and paste of objects. A fragment is what a copy holds: art meshes and deformers
 * with everything below them (a deformer's child deformers and the meshes in them), their layers,
 * and what they refer to outside it (parameters by export ID, parts, deformers and masks), so a
 * paste into this project or another one can rebind them. Objects are encoded as the project
 * files store them (`encode`), so a fragment is plain JSON and travels through the clipboard.
 */
import { F32Num, encode, visitRefs, type JsonTree } from './codec.js';
import type { DocReader } from './document.js';
import { OBJECT_SCHEMAS, type Uid } from './model.js';

export const FRAGMENT_FORMAT = 'mochi-maker-fragment';

export interface FragmentRef {
  kind: string;
  exportId?: string;
  /** A parameter's default, to keep the right keyforms when it cannot be bound. */
  default?: number;
}

export interface Fragment {
  format: typeof FRAGMENT_FORMAT;
  version: 1;
  /** The copied objects at the top (meshes and deformers), in order. */
  roots: Uid[];
  /** Every object in the fragment, encoded: deformers parents first, then meshes, then layers. */
  objects: JsonTree[];
  /** What the objects refer to outside the fragment. */
  refs: Record<Uid, FragmentRef>;
  /** Layer images by asset hash, base64 (added by the clipboard.copy operation). */
  assets?: Record<string, string>;
}

/** Plain JSON: float32 values (wrapped for the project writer) as their numbers. */
function plain(t: JsonTree): JsonTree {
  if (t instanceof F32Num) return t.value;
  if (Array.isArray(t)) return t.map(plain);
  if (t && typeof t === 'object') {
    const out: { [key: string]: JsonTree } = {};
    for (const [k, v] of Object.entries(t)) out[k] = plain(v);
    return out;
  }
  return t;
}

/** A fragment of art meshes and deformers, with what lies below them. */
export function copyFragment(v: DocReader, uids: readonly Uid[]): Fragment {
  const wanted = uids.filter((u) => {
    const k = v.get(u)?.kind;
    return k === 'artMesh' || k === 'warp' || k === 'rotation';
  });
  const inSet = new Set<Uid>();
  // Deformers below a copied deformer, then meshes in any copied deformer.
  const deformers = v.project().deformerOrder;
  for (const u of wanted) inSet.add(u);
  for (const u of deformers) {
    const d = v.get(u) as { parent: Uid | null };
    if (d.parent && inSet.has(d.parent)) inSet.add(u);
  }
  for (const m of v.ofKind('artMesh')) if (m.deformer && inSet.has(m.deformer)) inSet.add(m.uid);
  // Roots: copied objects whose parent is not copied.
  const parentOf = (u: Uid): Uid | null => {
    const o = v.get(u)!;
    return o.kind === 'artMesh' ? o.deformer : (o as { parent: Uid | null }).parent;
  };
  const roots = wanted.filter((u) => {
    const p = parentOf(u);
    return !p || !inSet.has(p);
  });
  const ordered = [
    ...deformers.filter((u) => inSet.has(u)),
    ...v
      .ofKind('artMesh')
      .map((m) => m.uid)
      .filter((u) => inSet.has(u)),
  ];
  const layers = new Set<Uid>();
  for (const u of ordered) {
    const o = v.get(u)!;
    if (o.kind === 'artMesh' && o.layer) layers.add(o.layer);
  }
  const all = [...ordered, ...layers];
  const inFragment = new Set(all);
  const refs: Record<Uid, FragmentRef> = {};
  const objects: JsonTree[] = [];
  for (const u of all) {
    const o = v.get(u)!;
    const schema = OBJECT_SCHEMAS[o.kind as keyof typeof OBJECT_SCHEMAS];
    visitRefs(schema, o, (ref, _kinds, path) => {
      if (path === 'uid' || inFragment.has(ref) || refs[ref]) return;
      const t = v.get(ref);
      if (!t) return;
      const r: FragmentRef = { kind: t.kind };
      if ('exportId' in t) r.exportId = (t as { exportId: string }).exportId;
      if (t.kind === 'parameter') r.default = t.default;
      refs[ref] = r;
    });
    objects.push(plain(encode(schema, o)));
  }
  return { format: FRAGMENT_FORMAT, version: 1, roots, objects, refs };
}
