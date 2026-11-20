/**
 * Constrained Delaunay triangulation, written for Mochi Maker.
 *
 * 1. Incremental Delaunay triangulation inside a large enclosing triangle: each point is located
 *    by walking, the triangle (or edge) containing it is split, and edges are legalized by flips
 *    (Lawson).
 * 2. Every constraint edge is recovered by flipping the edges it crosses until it appears
 *    (Sloan's method). A constraint that passes exactly through another point is split there.
 * 3. A final Lawson pass restores the Delaunay property for edges that are not constraints.
 * 4. Triangles are kept by the even-odd rule: counting the constraint edges crossed on the way
 *    from the outside, a triangle is kept when the count is odd. So closed loops bound regions,
 *    holes are holes, and islands inside holes are kept.
 *
 * Output triangles are positively oriented (orient > 0), which faces forward (predicates.ts).
 */
import { incircle, orientIdx as orientRaw, type Coords } from './predicates.js';

/**
 * Orientation evaluated in a canonical vertex order, so it is exactly antisymmetric: every
 * triangle that shares an edge sees the same sign for a point. Plain floating-point evaluation
 * can disagree between orient(a, b, p) and orient(b, a, p), which breaks point location.
 */
function orientIdx(p: Coords, a: number, b: number, c: number): number {
  if (a < b) {
    if (b < c) return orientRaw(p, a, b, c);
    if (a < c) return -orientRaw(p, a, c, b);
    return orientRaw(p, c, a, b);
  }
  if (a < c) return -orientRaw(p, b, a, c);
  if (b < c) return orientRaw(p, b, c, a);
  return -orientRaw(p, c, b, a);
}

function segmentsCross(p: Coords, a: number, b: number, c: number, d: number): boolean {
  const o1 = orientIdx(p, a, b, c);
  const o2 = orientIdx(p, a, b, d);
  const o3 = orientIdx(p, c, d, a);
  const o4 = orientIdx(p, c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

export class TriangulationError extends Error {}

export interface TriangulateInput {
  /** Point coordinates [x0, y0, x1, y1, ...]. */
  points: Coords;
  /** Closed loops of point indices that bound the region (outer boundaries and holes). */
  loops?: readonly (readonly number[])[];
  /** Extra constraint edges that are kept but do not bound the region. */
  edges?: readonly (readonly [number, number])[];
  /**
   * 'loops' (default when loops are given): keep triangles inside the loops (even-odd).
   * 'hull': keep every triangle of the convex hull.
   */
  keep?: 'loops' | 'hull';
}

const EPS = 1e-12;

class Mesh {
  v: number[] = [];
  n: number[] = [];
  /** One triangle per vertex that contains it, kept current on every write. */
  vt: number[];
  constrained = new Set<number>();
  last = 0;

  constructor(
    readonly p: Float64Array,
    readonly count: number,
  ) {
    this.vt = new Array<number>(count).fill(-1);
  }

  key(a: number, b: number): number {
    return a < b ? a * this.count + b : b * this.count + a;
  }

  set(t: number, a: number, b: number, c: number, na: number, nb: number, nc: number): void {
    this.v[3 * t] = a;
    this.v[3 * t + 1] = b;
    this.v[3 * t + 2] = c;
    this.n[3 * t] = na;
    this.n[3 * t + 1] = nb;
    this.n[3 * t + 2] = nc;
    this.vt[a] = t;
    this.vt[b] = t;
    this.vt[c] = t;
  }

  add(): number {
    const t = this.v.length / 3;
    this.v.push(0, 0, 0);
    this.n.push(-1, -1, -1);
    return t;
  }

  /** In triangle u, replace the neighbor pointer `from` with `to`. */
  repoint(u: number, from: number, to: number): void {
    if (u < 0) return;
    for (let k = 0; k < 3; k++) if (this.n[3 * u + k] === from) this.n[3 * u + k] = to;
  }

  /** Local edge index in triangle t for the directed edge (a, b), or -1. */
  edgeIndex(t: number, a: number, b: number): number {
    for (let k = 0; k < 3; k++)
      if (this.v[3 * t + k] === a && this.v[3 * t + ((k + 1) % 3)] === b) return k;
    return -1;
  }

  /** Triangles around vertex a. At the outer hull, the ring is open: walk both ways. */
  around(a: number): number[] {
    const start = this.vt[a]!;
    const out: number[] = [];
    let t = start;
    for (let guard = 0; guard < 100000; guard++) {
      out.push(t);
      const k = this.localIndex(t, a);
      // Move across the edge (c, a), where c precedes a.
      const next = this.n[3 * t + ((k + 2) % 3)]!;
      if (next === start) return out;
      if (next < 0) break;
      t = next;
    }
    // Open ring: continue from the start in the other direction, across the edge (a, b).
    t = start;
    for (let guard = 0; guard < 100000; guard++) {
      const k = this.localIndex(t, a);
      const prev = this.n[3 * t + k]!;
      if (prev < 0 || prev === start) return out;
      out.push(prev);
      t = prev;
    }
    throw new TriangulationError('vertex ring did not close');
  }

  localIndex(t: number, a: number): number {
    if (this.v[3 * t] === a) return 0;
    if (this.v[3 * t + 1] === a) return 1;
    if (this.v[3 * t + 2] === a) return 2;
    throw new TriangulationError('vertex not in triangle');
  }

  /** The triangle and local edge index of the edge from a to b (in either direction), or null. */
  findEdge(a: number, b: number): [number, number] | null {
    for (const t of this.around(a)) {
      const k = this.localIndex(t, a);
      if (this.v[3 * t + ((k + 1) % 3)] === b) return [t, k];
      if (this.v[3 * t + ((k + 2) % 3)] === b) return [t, (k + 2) % 3];
    }
    return null;
  }

  /** Flips edge k of triangle t. Returns false when the quad is not strictly convex. */
  flip(t: number, k: number, requireConvex: boolean): boolean {
    const a = this.v[3 * t + k]!;
    const b = this.v[3 * t + ((k + 1) % 3)]!;
    const c = this.v[3 * t + ((k + 2) % 3)]!;
    const nbc = this.n[3 * t + ((k + 1) % 3)]!;
    const nca = this.n[3 * t + ((k + 2) % 3)]!;
    const u = this.n[3 * t + k]!;
    if (u < 0) return false;
    const j = this.edgeIndex(u, b, a);
    if (j < 0) throw new TriangulationError('broken adjacency');
    const d = this.v[3 * u + ((j + 2) % 3)]!;
    const nad = this.n[3 * u + ((j + 1) % 3)]!;
    const ndb = this.n[3 * u + ((j + 2) % 3)]!;
    if (requireConvex && !(orientIdx(this.p, c, a, d) > EPS && orientIdx(this.p, d, b, c) > EPS))
      return false;
    this.set(t, c, a, d, nca, nad, u);
    this.set(u, d, b, c, ndb, nbc, t);
    this.repoint(nad, u, t);
    this.repoint(nbc, t, u);
    return true;
  }

  legalize(stack: [number, number][]): void {
    let guard = 0;
    while (stack.length > 0) {
      if (++guard > 1e7) throw new TriangulationError('legalization did not converge');
      const [t, k] = stack.pop()!;
      const a = this.v[3 * t + k]!;
      const b = this.v[3 * t + ((k + 1) % 3)]!;
      if (this.constrained.has(this.key(a, b))) continue;
      const u = this.n[3 * t + k]!;
      if (u < 0) continue;
      const c = this.v[3 * t + ((k + 2) % 3)]!;
      const j = this.edgeIndex(u, b, a);
      const d = this.v[3 * u + ((j + 2) % 3)]!;
      if (incircle(this.p, a, b, c, d) > EPS * scaleOf(this.p, a, b, c) && this.flip(t, k, true)) {
        // t = (c, a, d), u = (d, b, c): recheck the outer edges.
        stack.push([t, 1], [u, 0]);
      }
    }
  }

  locate(x: number): [number, number] {
    // Returns [triangle, -1] when strictly inside, or [triangle, edge] when on that edge.
    const p = this.p;
    let t = this.last;
    const triCount = this.v.length / 3;
    for (let guard = 0; guard < triCount * 3 + 100; guard++) {
      let moved = false;
      let onEdge = -1;
      for (let k = 0; k < 3; k++) {
        const a = this.v[3 * t + k]!;
        const b = this.v[3 * t + ((k + 1) % 3)]!;
        const o = orientIdx(p, a, b, x);
        if (o < 0) {
          const nb = this.n[3 * t + k]!;
          if (nb >= 0) {
            t = nb;
            moved = true;
            break;
          }
        } else if (o === 0) onEdge = k;
      }
      if (!moved) return [t, onEdge];
    }
    // Walking can cycle in degenerate configurations; fall back to a scan.
    for (let s = 0; s < triCount; s++) {
      let ok = true;
      let onEdge = -1;
      for (let k = 0; k < 3 && ok; k++) {
        const o = orientIdx(p, this.v[3 * s + k]!, this.v[3 * s + ((k + 1) % 3)]!, x);
        if (o < 0) ok = false;
        else if (o === 0) onEdge = k;
      }
      if (ok) return [s, onEdge];
    }
    throw new TriangulationError('point location failed');
  }

  insert(x: number): void {
    const [t, e] = this.locate(x);
    this.last = t;
    if (e < 0) {
      const a = this.v[3 * t]!;
      const b = this.v[3 * t + 1]!;
      const c = this.v[3 * t + 2]!;
      const na = this.n[3 * t]!;
      const nb = this.n[3 * t + 1]!;
      const nc = this.n[3 * t + 2]!;
      const t1 = this.add();
      const t2 = this.add();
      this.set(t, a, b, x, na, t1, t2);
      this.set(t1, b, c, x, nb, t2, t);
      this.set(t2, c, a, x, nc, t, t1);
      this.repoint(nb, t, t1);
      this.repoint(nc, t, t2);
      this.legalize([
        [t, 0],
        [t1, 0],
        [t2, 0],
      ]);
      return;
    }
    // On edge e of t: split t and its neighbor into four.
    const a = this.v[3 * t + e]!;
    const b = this.v[3 * t + ((e + 1) % 3)]!;
    const c = this.v[3 * t + ((e + 2) % 3)]!;
    const nbc = this.n[3 * t + ((e + 1) % 3)]!;
    const nca = this.n[3 * t + ((e + 2) % 3)]!;
    const u = this.n[3 * t + e]!;
    const wasConstrained = this.constrained.delete(this.key(a, b));
    if (u < 0) throw new TriangulationError('point on the outer hull');
    const j = this.edgeIndex(u, b, a);
    const d = this.v[3 * u + ((j + 2) % 3)]!;
    const nad = this.n[3 * u + ((j + 1) % 3)]!;
    const ndb = this.n[3 * u + ((j + 2) % 3)]!;
    const t2 = this.add();
    const u2 = this.add();
    this.set(t, a, x, c, u2, t2, nca);
    this.set(t2, x, b, c, u, nbc, t);
    this.set(u, b, x, d, t2, u2, ndb);
    this.set(u2, x, a, d, t, nad, u);
    this.repoint(nbc, t, t2);
    this.repoint(nad, u, u2);
    if (wasConstrained) {
      this.constrained.add(this.key(a, x));
      this.constrained.add(this.key(x, b));
    }
    this.legalize([
      [t2, 1],
      [t, 2],
      [u2, 1],
      [u, 2],
    ]);
  }

  /** Makes (a, b) an edge of the triangulation, then marks it constrained. */
  enforce(a: number, b: number, depth = 0): void {
    if (a === b) return;
    if (depth > 64) throw new TriangulationError('constraint recovery recursed too deep');
    if (this.findEdge(a, b)) {
      this.constrained.add(this.key(a, b));
      return;
    }
    const p = this.p;
    // A point exactly on the segment splits the constraint there.
    const triCount = this.v.length / 3;
    for (let w = 0; w < this.count; w++) {
      if (w === a || w === b || this.vt[w] === -1) continue;
      if (orientIdx(p, a, b, w) === 0 && between(p, a, b, w)) {
        this.enforce(a, w, depth + 1);
        this.enforce(w, b, depth + 1);
        return;
      }
    }
    // Every edge the segment crosses. Scanning is O(triangles), and unlike walking it cannot
    // lose track in near-degenerate configurations.
    const crossed: [number, number][] = [];
    const seenEdge = new Set<number>();
    for (let t = 0; t < triCount; t++)
      for (let k = 0; k < 3; k++) {
        const x = this.v[3 * t + k]!;
        const y = this.v[3 * t + ((k + 1) % 3)]!;
        const key = this.key(x, y);
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        if (x !== a && x !== b && y !== a && y !== b && segmentsCross(p, a, b, x, y))
          crossed.push([x, y]);
      }
    if (crossed.length === 0) throw new TriangulationError(`cannot recover constraint ${a}-${b}`);
    // Flip the crossed edges away (Sloan).
    let guard = 0;
    const created: [number, number][] = [];
    while (crossed.length > 0) {
      if (++guard > 1e6) throw new TriangulationError('constraint recovery did not converge');
      const [e0, e1] = crossed.shift()!;
      if (this.constrained.has(this.key(e0, e1)))
        throw new TriangulationError(`constraint ${a}-${b} crosses constraint ${e0}-${e1}`);
      const found = this.findEdge(e0, e1);
      if (!found) continue;
      const [t, k] = found;
      if (!this.flip(t, k, true)) {
        crossed.push([e0, e1]);
        continue;
      }
      // The new diagonal is (c, d) = vertices 0 and 2 of t after the flip.
      const c = this.v[3 * t]!;
      const d = this.v[3 * t + 2]!;
      if (segmentsCross(p, a, b, c, d)) crossed.push([c, d]);
      else created.push([c, d]);
    }
    if (!this.findEdge(a, b)) {
      // The walk can miss crossings in near-degenerate configurations: walk again.
      this.enforce(a, b, depth + 1);
      return;
    }
    this.constrained.add(this.key(a, b));
    // Restore the Delaunay property around the new edges.
    const stack: [number, number][] = [];
    for (const [c, d] of created) {
      if (this.key(c, d) === this.key(a, b)) continue;
      const f = this.findEdge(c, d);
      if (f) stack.push(f);
    }
    this.legalize(stack);
  }
}

function scaleOf(p: Float64Array, a: number, b: number, c: number): number {
  const s = Math.max(
    Math.abs(p[2 * a]! - p[2 * b]!),
    Math.abs(p[2 * a + 1]! - p[2 * b + 1]!),
    Math.abs(p[2 * a]! - p[2 * c]!),
    Math.abs(p[2 * a + 1]! - p[2 * c + 1]!),
  );
  return s * s * s * s;
}

/** True when w lies strictly between a and b (assuming the three are collinear). */
function between(p: Coords, a: number, b: number, w: number): boolean {
  const dx = p[2 * b]! - p[2 * a]!;
  const dy = p[2 * b + 1]! - p[2 * a + 1]!;
  const t =
    ((p[2 * w]! - p[2 * a]!) * dx + (p[2 * w + 1]! - p[2 * a + 1]!) * dy) / (dx * dx + dy * dy);
  return t > 0 && t < 1;
}

/**
 * Triangulates points with constraint loops and edges. Returns triangles as point-index triples
 * (positively oriented). Duplicate points are merged into the first occurrence.
 */
export function triangulate(input: TriangulateInput): Uint32Array {
  const src = input.points;
  const n = src.length / 2;
  if (n < 3) return new Uint32Array(0);
  // Normalize coordinates into the unit box for numerical stability.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, src[2 * i]!);
    maxX = Math.max(maxX, src[2 * i]!);
    minY = Math.min(minY, src[2 * i + 1]!);
    maxY = Math.max(maxY, src[2 * i + 1]!);
  }
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  const p = new Float64Array(2 * (n + 3));
  for (let i = 0; i < n; i++) {
    p[2 * i] = (src[2 * i]! - minX) / size;
    p[2 * i + 1] = (src[2 * i + 1]! - minY) / size;
  }
  // The enclosing triangle (positively oriented).
  const s0 = n;
  const s1 = n + 1;
  const s2 = n + 2;
  p.set([-20, -20, 41, -20, -20, 41], 2 * n);
  // Merge duplicate points.
  const canon = new Int32Array(n);
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${p[2 * i]},${p[2 * i + 1]}`;
    const f = seen.get(k);
    canon[i] = f ?? i;
    if (f === undefined) seen.set(k, i);
  }
  const m = new Mesh(p, n + 3);
  const t0 = m.add();
  if (orientIdx(p, s0, s1, s2) > 0) m.set(t0, s0, s1, s2, -1, -1, -1);
  else m.set(t0, s0, s2, s1, -1, -1, -1);
  for (let i = 0; i < n; i++) if (canon[i] === i) m.insert(i);

  const loops = input.loops ?? [];
  for (const loop of loops)
    for (let i = 0; i < loop.length; i++)
      m.enforce(canon[loop[i]!]!, canon[loop[(i + 1) % loop.length]!]!);
  const boundary = new Set(m.constrained);
  for (const [a, b] of input.edges ?? []) m.enforce(canon[a]!, canon[b]!);

  // Final Lawson pass for non-constrained edges.
  const triCount = m.v.length / 3;
  const all: [number, number][] = [];
  for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) all.push([t, k]);
  m.legalize(all);

  const keepAll = input.keep === 'hull' || loops.length === 0;
  const keep = new Uint8Array(triCount);
  if (keepAll) {
    for (let t = 0; t < triCount; t++) keep[t] = 1;
  } else {
    // Even-odd depth by 0-1 BFS from the enclosing triangle's corners.
    const depth = new Int32Array(triCount).fill(-1);
    const deque: number[] = [];
    for (let t = 0; t < triCount; t++)
      for (let k = 0; k < 3; k++)
        if (m.v[3 * t + k]! >= n && depth[t] === -1) {
          depth[t] = 0;
          deque.push(t);
        }
    // Loop edges (including pieces of loop edges split at collinear points) count; extra
    // constraint edges do not.
    const boundaryKeys = boundary;
    while (deque.length > 0) {
      const t = deque.shift()!;
      for (let k = 0; k < 3; k++) {
        const u = m.n[3 * t + k]!;
        if (u < 0) continue;
        const a = m.v[3 * t + k]!;
        const b = m.v[3 * t + ((k + 1) % 3)]!;
        const w = boundaryKeys.has(m.key(a, b)) ? 1 : 0;
        const nd = depth[t]! + w;
        if (depth[u] === -1 || nd < depth[u]!) {
          depth[u] = nd;
          if (w === 0) deque.unshift(u);
          else deque.push(u);
        }
      }
    }
    for (let t = 0; t < triCount; t++) keep[t] = depth[t]! % 2 === 1 ? 1 : 0;
  }
  const out: number[] = [];
  for (let t = 0; t < triCount; t++) {
    if (!keep[t]) continue;
    const a = m.v[3 * t]!;
    const b = m.v[3 * t + 1]!;
    const c = m.v[3 * t + 2]!;
    if (a >= n || b >= n || c >= n) continue;
    if (!(orientIdx(p, a, b, c) > 0)) continue;
    out.push(a, b, c);
  }
  return Uint32Array.from(out);
}
