/**
 * Checks for common rigging pitfalls that look at the document.
 */
import type { ArtMesh, DocReader, Parameter, Rotation, Uid, Warp } from '@mochi-maker/core';

export interface Outside {
  child: Uid;
  childId: string;
  parent: Uid;
  parentId: string;
  /** Points outside the parent warp, over every keyform. */
  points: number;
}

/**
 * Children that stick out of their parent warp: mesh vertices, grid points or rotation origins
 * whose (u, v) leaves 0…1 in some keyform. A warp only bends what lies inside it, so the parent
 * must not be smaller than its child.
 */
export function outsideParents(v: DocReader, only?: ReadonlySet<Uid>): Outside[] {
  const out: Outside[] = [];
  const warps = new Map(v.ofKind('warp').map((w) => [w.uid, w]));
  const check = (
    child: ArtMesh | Warp | Rotation,
    parent: Uid | null,
    values: () => ArrayLike<number>[],
  ) => {
    const w = parent ? warps.get(parent) : undefined;
    if (!w) return;
    if (only && !only.has(child.uid) && !only.has(w.uid)) return;
    let n = 0;
    for (const pts of values())
      for (let i = 0; i < pts.length; i++) if (pts[i]! < -1e-3 || pts[i]! > 1 + 1e-3) n++;
    if (n)
      out.push({
        child: child.uid,
        childId: child.exportId,
        parent: w.uid,
        parentId: w.exportId,
        points: n,
      });
  };
  for (const m of v.ofKind('artMesh'))
    check(m, m.deformer, () => m.rig.keyforms.map((k) => k.positions));
  for (const d of v.ofKind('warp')) check(d, d.parent, () => d.rig.keyforms.map((k) => k.grid));
  for (const d of v.ofKind('rotation'))
    check(d, d.parent, () => d.rig.keyforms.map((k) => [k.originX, k.originY]));
  return out;
}

/** Whether a key value looks untidy: not a multiple of a hundredth of the range. */
export function untidyKey(p: Parameter, key: number): boolean {
  const unit = (p.max - p.min) / 100 || 1;
  const steps = key / unit;
  return (
    Math.abs(steps - Math.round(steps)) > 1e-6 && Math.abs(key * 100 - Math.round(key * 100)) > 1e-6
  );
}
