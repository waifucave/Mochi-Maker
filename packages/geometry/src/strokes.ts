/**
 * Stroke-based meshing and subdivision, two of the mesh tools.
 *
 * - `strokeStrip`: a mesh along drawn strokes:
 *   each stroke is resampled every `spacing` pixels and widened to `width` on both sides of its
 *   path, as a strip of quads split into triangles. Several strokes give several strips.
 * - `subdivide`: every triangle split into four through its edges' midpoints, each midpoint shared
 *   by the triangles of its edge. The new vertices' derivations (the two ends, half each) carry any
 *   per-vertex values over exactly.
 */
import type { Derivation } from './topology.js';

export interface StripMesh {
  points: Float64Array;
  triangles: Uint32Array;
}

/** A polyline resampled at equal steps of about `spacing` along its length (ends kept). */
export function resample(stroke: readonly [number, number][], spacing: number): [number, number][] {
  const pts = stroke.filter(
    (p, i) => i === 0 || Math.hypot(p[0] - stroke[i - 1]![0], p[1] - stroke[i - 1]![1]) > 1e-9,
  );
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const total = cum.at(-1)!;
  const n = Math.max(1, Math.round(total / Math.max(spacing, 1e-6)));
  const out: [number, number][] = [];
  let seg = 0;
  for (let k = 0; k <= n; k++) {
    const s = (total * k) / n;
    while (seg < pts.length - 2 && cum[seg + 1]! < s) seg++;
    const t = (s - cum[seg]!) / (cum[seg + 1]! - cum[seg]! || 1);
    const [a, b] = [pts[seg]!, pts[seg + 1]!];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Strips of `width` along each stroke (see the module comment). Strokes shorter than 2 points are skipped. */
export function strokeStrip(
  strokes: readonly (readonly [number, number][])[],
  width: number,
  spacing = width,
): StripMesh {
  const pts: number[] = [];
  const tris: number[] = [];
  const half = width / 2;
  for (const stroke of strokes) {
    const c = resample(stroke, spacing);
    if (c.length < 2) continue;
    const base = pts.length / 2;
    c.forEach((p, i) => {
      const a = c[Math.max(0, i - 1)]!;
      const b = c[Math.min(c.length - 1, i + 1)]!;
      let [tx, ty] = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(tx, ty) || 1;
      [tx, ty] = [tx / len, ty / len];
      // Left then right of the path.
      pts.push(p[0] - ty * half, p[1] + tx * half, p[0] + ty * half, p[1] - tx * half);
    });
    for (let i = 0; i + 1 < c.length; i++) {
      const [l0, r0, l1, r1] = [base + 2 * i, base + 2 * i + 1, base + 2 * i + 2, base + 2 * i + 3];
      tris.push(l0, r0, l1, r0, r1, l1);
    }
  }
  return { points: Float64Array.from(pts), triangles: Uint32Array.from(tris) };
}

/** Every triangle split into four (see the module comment). */
export function subdivide(
  points: ArrayLike<number>,
  triangles: ArrayLike<number>,
): { points: Float64Array; triangles: Uint32Array; derivations: Derivation[] } {
  const n = points.length / 2;
  const out = Array.from(points);
  const derivations: Derivation[] = Array.from({ length: n }, (_, i) => ({
    from: [i],
    weights: [1],
  }));
  const mid = new Map<string, number>();
  const midpoint = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let m = mid.get(key);
    if (m === undefined) {
      m = out.length / 2;
      out.push(
        (points[2 * a]! + points[2 * b]!) / 2,
        (points[2 * a + 1]! + points[2 * b + 1]!) / 2,
      );
      derivations.push({ from: [a, b], weights: [0.5, 0.5] });
      mid.set(key, m);
    }
    return m;
  };
  const tris: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
    const [ab, bc, ca] = [midpoint(a, b), midpoint(b, c), midpoint(c, a)];
    tris.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { points: Float64Array.from(out), triangles: Uint32Array.from(tris), derivations };
}
