/**
 * From an image's alpha channel to clean outline polygons.
 *
 * 1. Threshold the alpha into a mask, then grow it by `margin` pixels so the outline stays
 *    outside every opaque pixel even after simplification.
 * 2. Remove "saddles" (two pixels touching only at a corner) by filling one of the two empty
 *    pixels. Then every corner point has at most one outline edge in and one out, so outlines
 *    never touch themselves or each other.
 * 3. Trace the outlines along pixel edges. Outer outlines have positive area and holes negative
 *    (in y-down coordinates).
 * 4. Simplify each outline (Douglas–Peucker), then split long edges so no edge exceeds the
 *    requested spacing. If simplification makes outlines cross, it is retried with a smaller
 *    tolerance; at zero tolerance the traced outlines are used as they are, and those never cross.
 */
import { segmentsCross } from './predicates.js';

export interface Mask {
  width: number;
  height: number;
  /** 1 = inside, 0 = outside; row-major. */
  data: Uint8Array;
}

/** A mask from RGBA pixels: alpha ≥ threshold (0–255) is inside. */
export function alphaMask(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 8,
): Mask {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) data[i] = rgba[4 * i + 3]! >= threshold ? 1 : 0;
  return { width, height, data };
}

/**
 * Grows a mask by r pixels (square neighborhood) and pads it by r + 1 on every side, so the
 * result has an empty border. Returns the padded mask and the padding.
 */
export function dilate(mask: Mask, r: number): { mask: Mask; pad: number } {
  const pad = r + 1;
  const w = mask.width + 2 * pad;
  const h = mask.height + 2 * pad;
  const src = new Uint8Array(w * h);
  for (let y = 0; y < mask.height; y++)
    src.set(mask.data.subarray(y * mask.width, (y + 1) * mask.width), (y + pad) * w + pad);
  if (r <= 0) return { mask: { width: w, height: h, data: src }, pad };
  // Separable max filter: rows, then columns, with running counts.
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = -r; x < w; x++) {
      const add = x + r;
      if (add < w) count += src[row + add]!;
      const sub = x - r - 1;
      if (sub >= 0) count -= src[row + sub]!;
      if (x >= 0) tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y < h; y++) {
      const add = y + r;
      if (add < h) count += tmp[add * w + x]!;
      const sub = y - r - 1;
      if (sub >= 0) count -= tmp[sub * w + x]!;
      if (y >= 0) out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return { mask: { width: w, height: h, data: out }, pad };
}

/** Fills one pixel of every diagonal-only pair until none remain (the mask only grows). */
export function removeSaddles(mask: Mask): void {
  const { width: w, height: h, data } = mask;
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y + 1 < h; y++)
      for (let x = 0; x + 1 < w; x++) {
        const a = data[y * w + x]!;
        const b = data[y * w + x + 1]!;
        const c = data[(y + 1) * w + x]!;
        const d = data[(y + 1) * w + x + 1]!;
        if (a === d && b === c && a !== b) {
          if (a === 1) data[y * w + x + 1] = 1;
          else data[y * w + x] = 1;
          changed = true;
        }
      }
  }
}

/**
 * Traces outlines along pixel edges, in pixel-corner coordinates. Each loop is a flat list
 * [x0, y0, x1, y1, ...] of its corners (collinear points removed). The mask must have no saddles
 * and an empty border.
 */
export function traceOutlines(mask: Mask): number[][] {
  const { width: w, height: h, data } = mask;
  const W = w + 1;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? data[y * w + x]! : 0);
  // next[corner] = the corner the outline edge starting there goes to (-1: none).
  const next = new Int32Array(W * (h + 1)).fill(-1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      if (!at(x, y - 1)) next[y * W + x] = y * W + x + 1;
      if (!at(x + 1, y)) next[y * W + x + 1] = (y + 1) * W + x + 1;
      if (!at(x, y + 1)) next[(y + 1) * W + x + 1] = (y + 1) * W + x;
      if (!at(x - 1, y)) next[(y + 1) * W + x] = y * W + x;
    }
  const loops: number[][] = [];
  for (let start = 0; start < next.length; start++) {
    if (next[start] === -1) continue;
    const corners: number[] = [];
    let c = start;
    while (next[c] !== -1) {
      corners.push(c);
      const n = next[c]!;
      next[c] = -1;
      c = n;
    }
    const pts: number[] = [];
    const k = corners.length;
    for (let i = 0; i < k; i++) {
      const prev = corners[(i + k - 1) % k]!;
      const cur = corners[i]!;
      const nxt = corners[(i + 1) % k]!;
      const dx1 = (cur % W) - (prev % W);
      const dy1 = Math.floor(cur / W) - Math.floor(prev / W);
      const dx2 = (nxt % W) - (cur % W);
      const dy2 = Math.floor(nxt / W) - Math.floor(cur / W);
      if (dx1 === dx2 && dy1 === dy2) continue; // collinear
      pts.push(cur % W, Math.floor(cur / W));
    }
    loops.push(pts);
  }
  return loops;
}

/** Twice the signed area of a flat loop [x0, y0, ...]. */
export function loopArea2(loop: readonly number[]): number {
  let s = 0;
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += loop[2 * i]! * loop[2 * j + 1]! - loop[2 * j]! * loop[2 * i + 1]!;
  }
  return s;
}

function perpDistance(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(x - ax, y - ay);
  return Math.abs(dx * (ay - y) - dy * (ax - x)) / len;
}

/** Douglas–Peucker simplification of a closed loop. */
export function simplifyLoop(loop: readonly number[], tolerance: number): number[] {
  const n = loop.length / 2;
  if (n <= 3 || tolerance <= 0) return [...loop];
  // Anchor at point 0 and the point farthest from it.
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(loop[2 * i]! - loop[0]!, loop[2 * i + 1]! - loop[1]!);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const ax = loop[2 * a]!;
    const ay = loop[2 * a + 1]!;
    const bx = loop[2 * (b % n)]!;
    const by = loop[2 * (b % n) + 1]!;
    let idx = -1;
    let dmax = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = perpDistance(loop[2 * i]!, loop[2 * i + 1]!, ax, ay, bx, by);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[2 * i]!, loop[2 * i + 1]!);
  return out;
}

/** Splits edges longer than maxEdge into equal pieces. */
export function resampleLoop(loop: readonly number[], maxEdge: number): number[] {
  const n = loop.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const ax = loop[2 * i]!;
    const ay = loop[2 * i + 1]!;
    const bx = loop[2 * ((i + 1) % n)]!;
    const by = loop[2 * ((i + 1) % n) + 1]!;
    const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / maxEdge));
    for (let k = 0; k < pieces; k++)
      out.push(ax + ((bx - ax) * k) / pieces, ay + ((by - ay) * k) / pieces);
  }
  return out;
}

/** True when any two edges of the loops cross or a loop has fewer than 3 distinct points. */
export function loopsIntersect(loops: readonly (readonly number[])[]): boolean {
  const pts: number[] = [];
  const edges: [number, number][] = [];
  for (const loop of loops) {
    const n = loop.length / 2;
    if (n < 3) return true;
    const base = pts.length / 2;
    pts.push(...loop);
    for (let i = 0; i < n; i++) edges.push([base + i, base + ((i + 1) % n)]);
  }
  // Grid buckets keep this near-linear for long outlines.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    minX = Math.min(minX, pts[i]!);
    maxX = Math.max(maxX, pts[i]!);
    minY = Math.min(minY, pts[i + 1]!);
    maxY = Math.max(maxY, pts[i + 1]!);
  }
  const cells = Math.max(1, Math.ceil(Math.sqrt(edges.length)));
  const cw = (maxX - minX) / cells || 1;
  const ch = (maxY - minY) / cells || 1;
  const buckets = new Map<number, number[]>();
  edges.forEach(([a, b], e) => {
    const x0 = Math.floor((Math.min(pts[2 * a]!, pts[2 * b]!) - minX) / cw);
    const x1 = Math.floor((Math.max(pts[2 * a]!, pts[2 * b]!) - minX) / cw);
    const y0 = Math.floor((Math.min(pts[2 * a + 1]!, pts[2 * b + 1]!) - minY) / ch);
    const y1 = Math.floor((Math.max(pts[2 * a + 1]!, pts[2 * b + 1]!) - minY) / ch);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const key = y * (cells + 2) + x;
        const list = buckets.get(key);
        if (list) list.push(e);
        else buckets.set(key, [e]);
      }
  });
  for (const list of buckets.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = edges[list[i]!]!;
        const [c, d] = edges[list[j]!]!;
        if (a === c || a === d || b === c || b === d) continue;
        if (segmentsCross(pts, a, b, c, d)) return true;
        // Touching (an endpoint on the other segment) also breaks triangulation.
        if (
          touches(pts, a, b, c) ||
          touches(pts, a, b, d) ||
          touches(pts, c, d, a) ||
          touches(pts, c, d, b)
        )
          return true;
      }
  return false;
}

function touches(p: number[], a: number, b: number, c: number): boolean {
  const ax = p[2 * a]!;
  const ay = p[2 * a + 1]!;
  const bx = p[2 * b]!;
  const by = p[2 * b + 1]!;
  const cx = p[2 * c]!;
  const cy = p[2 * c + 1]!;
  if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) !== 0) return false;
  return (
    cx >= Math.min(ax, bx) &&
    cx <= Math.max(ax, bx) &&
    cy >= Math.min(ay, by) &&
    cy <= Math.max(ay, by)
  );
}
