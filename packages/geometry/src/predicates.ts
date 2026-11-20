/** Basic geometric predicates and helpers, on flat coordinate arrays [x0, y0, x1, y1, ...]. */

export type Coords = ArrayLike<number>;

/**
 * Twice the signed area of (a, b, c). Positive means the triangle faces forward in Mochi Maker's
 * stored coordinates (y downward), which is clockwise on screen. This matches the format's
 * culling rule for single-sided meshes (§2e).
 */
export function orient(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

export function orientIdx(p: Coords, a: number, b: number, c: number): number {
  return orient(p[2 * a]!, p[2 * a + 1]!, p[2 * b]!, p[2 * b + 1]!, p[2 * c]!, p[2 * c + 1]!);
}

/** Positive when d lies inside the circumcircle of the positively oriented triangle (a, b, c). */
export function incircle(p: Coords, a: number, b: number, c: number, d: number): number {
  const dx = p[2 * d]!;
  const dy = p[2 * d + 1]!;
  const adx = p[2 * a]! - dx;
  const ady = p[2 * a + 1]! - dy;
  const bdx = p[2 * b]! - dx;
  const bdy = p[2 * b + 1]! - dy;
  const cdx = p[2 * c]! - dx;
  const cdy = p[2 * c + 1]! - dy;
  const ad = adx * adx + ady * ady;
  const bd = bdx * bdx + bdy * bdy;
  const cd = cdx * cdx + cdy * cdy;
  return adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx);
}

/** True when segments (a, b) and (c, d) cross at a single interior point of both. */
export function segmentsCross(p: Coords, a: number, b: number, c: number, d: number): boolean {
  const o1 = orientIdx(p, a, b, c);
  const o2 = orientIdx(p, a, b, d);
  const o3 = orientIdx(p, c, d, a);
  const o4 = orientIdx(p, c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

/** Twice the signed area of a closed polygon given as point indices. */
export function polygonArea2(p: Coords, loop: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    s += p[2 * a]! * p[2 * b + 1]! - p[2 * b]! * p[2 * a + 1]!;
  }
  return s;
}

/** Even-odd point-in-polygons test over closed loops of [x, y] points. */
export function insideEvenOdd(
  x: number,
  y: number,
  loops: readonly (readonly number[])[],
): boolean {
  let inside = false;
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = loop[2 * i]!;
      const yi = loop[2 * i + 1]!;
      const xj = loop[2 * j]!;
      const yj = loop[2 * j + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Squared distance from (x, y) to the segment (ax, ay)–(bx, by). */
export function segmentDistance2(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - x;
  const ey = ay + t * dy - y;
  return ex * ex + ey * ey;
}

/** A small, fast, seeded pseudo-random generator (mulberry32). Returns values in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
