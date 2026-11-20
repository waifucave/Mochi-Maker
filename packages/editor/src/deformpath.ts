/**
 * The deform path (key P): a path drawn over art
 * meshes and warps. Dragging its points drags the vertices or grid points near it along. An
 * editor-side helper like the Bézier layer: the document keeps only the keyform values that result,
 * so the export is unchanged. Paths belong to an edit level (2 or 3), so the same mesh can have
 * fine paths at level 2 and a broad one at level 3.
 *
 * Binding (when a drag starts): each point within `reach` of the path is tied to every path
 * segment within reach, by where it projects onto the segment (t along it, `extra` beyond an end)
 * and its signed distance from it (n). Moving the path then puts each tie at the same place on the
 * moved segment: along it in proportion, and the same distance off it, so points turn with the
 * segment. A point's ties blend by inverse square distance, and the whole move fades out with
 * the distance to the path: (1 − (d / reach)²)². Points beyond reach do not move; an unmoved path
 * moves nothing.
 *
 * Everything here works in canvas pixels.
 */

export type Pt = [number, number];

export interface DeformPath {
  id: number;
  /** The art meshes and warps it deforms. */
  targets: string[];
  /** The edit level it belongs to. */
  level: 2 | 3;
  /** Its points, in canvas pixels. */
  points: Pt[];
  /** How far from the path points follow it, in canvas pixels. */
  reach: number;
}

interface Tie {
  /** Segment index, or −1 for a path of one point. */
  j: number;
  t: number;
  extra: number;
  n: number;
  u: number;
}
export interface Binding {
  ties: Tie[];
  /** The fall-off with the distance to the path (0: the point does not move). */
  w: number;
}

const frame = (a: Pt, b: Pt) => {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dir: Pt = L > 1e-9 ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [1, 0];
  return { L, dir, normal: [-dir[1], dir[0]] as Pt };
};

/** Ties every point (x, y pairs) to the path within reach. */
export function bindPoints(path: readonly Pt[], pts: ArrayLike<number>, reach: number): Binding[] {
  const out: Binding[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const p: Pt = [pts[i]!, pts[i + 1]!];
    const ties: (Tie & { d: number })[] = [];
    if (path.length === 1) {
      const d = Math.hypot(p[0] - path[0]![0], p[1] - path[0]![1]);
      if (d < reach) ties.push({ j: -1, t: 0, extra: 0, n: 0, u: 1, d });
    }
    for (let j = 0; j + 1 < path.length; j++) {
      const a = path[j]!;
      const { L, dir, normal } = frame(a, path[j + 1]!);
      const rel: Pt = [p[0] - a[0], p[1] - a[1]];
      const s = rel[0] * dir[0] + rel[1] * dir[1];
      const t = L > 1e-9 ? Math.min(1, Math.max(0, s / L)) : 0;
      const extra = s - t * L;
      const n = rel[0] * normal[0] + rel[1] * normal[1];
      const d = Math.hypot(extra, n);
      if (d < reach) ties.push({ j, t, extra, n, u: 0, d });
    }
    if (ties.length === 0) {
      out.push({ ties: [], w: 0 });
      continue;
    }
    const dmin = Math.min(...ties.map((x) => x.d));
    const raw = ties.map((x) => 1 / (x.d + 1) ** 2);
    const sum = raw.reduce((s, x) => s + x, 0);
    ties.forEach((x, k) => (x.u = raw[k]! / sum));
    const r = dmin / reach;
    out.push({ ties: ties.map(({ d: _d, ...x }) => x), w: (1 - r * r) ** 2 });
  }
  return out;
}

/** Where the points go when the path moves from `before` to `after` (same number of points). */
export function skin(
  before: readonly Pt[],
  after: readonly Pt[],
  pts: ArrayLike<number>,
  binds: readonly Binding[],
): Float64Array {
  const out = Float64Array.from(pts);
  binds.forEach((b, k) => {
    if (b.w === 0) return;
    const p: Pt = [pts[2 * k]!, pts[2 * k + 1]!];
    let qx = 0;
    let qy = 0;
    for (const tie of b.ties) {
      let q: Pt;
      if (tie.j < 0) q = [p[0] + after[0]![0] - before[0]![0], p[1] + after[0]![1] - before[0]![1]];
      else {
        const a = after[tie.j]!;
        const f0 = frame(before[tie.j]!, before[tie.j + 1]!);
        const f1 = frame(a, after[tie.j + 1]!);
        // Along the segment in proportion to its new length; the same distance off it.
        const along = tie.t * f1.L + tie.extra * (f0.L > 1e-9 ? f1.L / f0.L : 1);
        q = [
          a[0] + f1.dir[0] * along + f1.normal[0] * tie.n,
          a[1] + f1.dir[1] * along + f1.normal[1] * tie.n,
        ];
      }
      qx += tie.u * q[0];
      qy += tie.u * q[1];
    }
    out[2 * k] = p[0] + b.w * (qx - p[0]);
    out[2 * k + 1] = p[1] + b.w * (qy - p[1]);
  });
  return out;
}

/** The index of the path point within `reach` screen pixels of a point, or −1. */
export function nearestPathPoint(screen: readonly Pt[], x: number, y: number, reach = 8): number {
  let best = -1;
  let bd = reach;
  screen.forEach(([px, py], i) => {
    const d = Math.hypot(px - x, py - y);
    if (d <= bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}
