/**
 * Structural diff between two documents (agent API design 2.5): objects added, removed and
 * changed, with the changed fields, and for meshes and warps the largest and RMS displacement of
 * their keyform points, in their own space.
 */
import { encode, OBJECT_SCHEMAS, type DocObject, type Document } from '@mochi-maker/core';

export interface ObjectChange {
  uid: string;
  kind: string;
  /** Top-level fields whose value differs. */
  fields: string[];
  /** Meshes and warps whose point counts match: keyform point displacement. */
  displacement?: { max: number; rms: number };
}

export interface DocumentDiff {
  added: { uid: string; kind: string }[];
  removed: { uid: string; kind: string }[];
  changed: ObjectChange[];
}

const enc = (o: DocObject) => encode(OBJECT_SCHEMAS[o.kind], o) as Record<string, unknown>;

function displacement(a: DocObject, b: DocObject): { max: number; rms: number } | undefined {
  const field = a.kind === 'artMesh' ? 'positions' : a.kind === 'warp' ? 'grid' : undefined;
  if (!field || a.kind !== b.kind) return undefined;
  const ka = (a as unknown as { rig: { keyforms: Record<string, Float32Array>[] } }).rig.keyforms;
  const kb = (b as unknown as { rig: { keyforms: Record<string, Float32Array>[] } }).rig.keyforms;
  if (ka.length !== kb.length) return undefined;
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < ka.length; k++) {
    const pa = ka[k]![field]!;
    const pb = kb[k]![field]!;
    if (pa.length !== pb.length) return undefined;
    for (let i = 0; i < pa.length; i += 2) {
      const d = Math.hypot(pb[i]! - pa[i]!, pb[i + 1]! - pa[i + 1]!);
      max = Math.max(max, d);
      sum += d * d;
      n++;
    }
  }
  return { max, rms: n ? Math.sqrt(sum / n) : 0 };
}

export function diffDocuments(from: Document, to: Document): DocumentDiff {
  const out: DocumentDiff = { added: [], removed: [], changed: [] };
  const uids = [...new Set([...Object.keys(from.objects), ...Object.keys(to.objects)])].sort();
  for (const uid of uids) {
    const a = from.objects[uid];
    const b = to.objects[uid];
    if (!a) out.added.push({ uid, kind: b!.kind });
    else if (!b) out.removed.push({ uid, kind: a.kind });
    else if (a !== b) {
      const ea = enc(a);
      const eb = enc(b);
      const fields = [...new Set([...Object.keys(ea), ...Object.keys(eb)])].filter(
        (f) => JSON.stringify(ea[f]) !== JSON.stringify(eb[f]),
      );
      if (fields.length === 0) continue;
      const change: ObjectChange = { uid, kind: a.kind, fields };
      const d = fields.includes('rig') ? displacement(a, b) : undefined;
      if (d && d.max > 0) change.displacement = d;
      out.changed.push(change);
    }
  }
  return out;
}
