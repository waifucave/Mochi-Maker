/**
 * Mesh topology operations used by the mesh editing commands.
 *
 * Every operation that adds vertices also says how each new vertex is made from old ones
 * (vertex indices and barycentric weights), so the caller can compute the new vertex in every
 * keyform the same way. Deformation therefore carries over to new vertices.
 */
import { triangulate } from './cdt.js';
import { orient, type Coords } from './predicates.js';

export class TopologyError extends Error {}

/** How a vertex is made from existing vertices: Σ wᵢ·vertex[iᵢ]. */
export interface Derivation {
  from: number[];
  weights: number[];
}

export interface TopoResult {
  points: Float32Array;
  triangles: Uint32Array;
}

function pt(p: Coords, i: number): [number, number] {
  return [p[2 * i]!, p[2 * i + 1]!];
}

/** Barycentric coordinates of (x, y) in triangle (a, b, c); may be negative outside it. */
export function barycentric(
  p: Coords,
  a: number,
  b: number,
  c: number,
  x: number,
  y: number,
): [number, number, number] {
  const [ax, ay] = pt(p, a);
  const [bx, by] = pt(p, b);
  const [cx, cy] = pt(p, c);
  const d = orient(ax, ay, bx, by, cx, cy);
  if (d === 0) return [1, 0, 0];
  const wa = orient(x, y, bx, by, cx, cy) / d;
  const wb = orient(ax, ay, x, y, cx, cy) / d;
  return [wa, wb, 1 - wa - wb];
}

/** The triangle containing (x, y) (within a small tolerance) and the barycentric weights. */
export function locate(
  p: Coords,
  tris: ArrayLike<number>,
  x: number,
  y: number,
  tol = 1e-7,
): { t: number; w: [number, number, number] } | null {
  for (let t = 0; t < tris.length / 3; t++) {
    const w = barycentric(p, tris[3 * t]!, tris[3 * t + 1]!, tris[3 * t + 2]!, x, y);
    if (w[0] >= -tol && w[1] >= -tol && w[2] >= -tol) return { t, w };
  }
  return null;
}

/** The triangle nearest to (x, y), with (possibly negative) barycentric weights for extrapolation. */
export function nearestTriangle(
  p: Coords,
  tris: ArrayLike<number>,
  x: number,
  y: number,
): { t: number; w: [number, number, number] } | null {
  let best: { t: number; w: [number, number, number] } | null = null;
  let bestD = Infinity;
  for (let t = 0; t < tris.length / 3; t++) {
    const w = barycentric(p, tris[3 * t]!, tris[3 * t + 1]!, tris[3 * t + 2]!, x, y);
    const d = Math.max(0, -w[0]) + Math.max(0, -w[1]) + Math.max(0, -w[2]);
    if (d < bestD) {
      bestD = d;
      best = { t, w };
    }
  }
  return best;
}

/**
 * Describes each new point in terms of an old mesh: an exact copy where coordinates match, else
 * the barycentric weights of the containing (or nearest) old triangle.
 */
export function derivePoints(
  oldPoints: Coords,
  oldTris: ArrayLike<number>,
  newPoints: Coords,
): Derivation[] {
  const exact = new Map<string, number>();
  for (let i = 0; i < oldPoints.length / 2; i++) {
    const k = `${oldPoints[2 * i]},${oldPoints[2 * i + 1]}`;
    if (!exact.has(k)) exact.set(k, i);
  }
  const out: Derivation[] = [];
  for (let i = 0; i < newPoints.length / 2; i++) {
    const x = newPoints[2 * i]!;
    const y = newPoints[2 * i + 1]!;
    const e = exact.get(`${x},${y}`);
    if (e !== undefined) {
      out.push({ from: [e], weights: [1] });
      continue;
    }
    const hit = locate(oldPoints, oldTris, x, y) ?? nearestTriangle(oldPoints, oldTris, x, y);
    if (hit) {
      const t = hit.t;
      out.push({
        from: [oldTris[3 * t]!, oldTris[3 * t + 1]!, oldTris[3 * t + 2]!],
        weights: hit.w,
      });
      continue;
    }
    // No triangles at all: copy the nearest old vertex.
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < oldPoints.length / 2; j++) {
      const d = (oldPoints[2 * j]! - x) ** 2 + (oldPoints[2 * j + 1]! - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (bestD === Infinity) throw new TopologyError('the old mesh has no vertices to derive from');
    out.push({ from: [best], weights: [1] });
  }
  return out;
}

/** Applies derivations to a per-vertex [x, y] array (for example, one keyform's positions). */
export function applyDerivations(values: Coords, derivations: readonly Derivation[]): Float32Array {
  const out = new Float32Array(2 * derivations.length);
  derivations.forEach((d, i) => {
    let x = 0;
    let y = 0;
    d.from.forEach((j, k) => {
      x += d.weights[k]! * values[2 * j]!;
      y += d.weights[k]! * values[2 * j + 1]!;
    });
    out[2 * i] = x;
    out[2 * i + 1] = y;
  });
  return out;
}

/** Directed boundary loops of a triangle mesh (edges used by exactly one triangle). */
export function boundaryLoops(tris: ArrayLike<number>): number[][] {
  const directed = new Set<string>();
  for (let t = 0; t < tris.length / 3; t++)
    for (let k = 0; k < 3; k++) directed.add(`${tris[3 * t + k]},${tris[3 * t + ((k + 1) % 3)]}`);
  const next = new Map<number, number>();
  for (const key of directed) {
    const [a, b] = key.split(',').map(Number) as [number, number];
    if (directed.has(`${b},${a}`)) continue;
    if (next.has(a))
      throw new TopologyError(
        `vertex ${a} is on the boundary twice (the mesh is not manifold there)`,
      );
    next.set(a, b);
  }
  const loops: number[][] = [];
  const used = new Set<number>();
  for (const start of [...next.keys()].sort((x, y) => x - y)) {
    if (used.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    while (!used.has(v)) {
      used.add(v);
      loop.push(v);
      const n = next.get(v);
      if (n === undefined) throw new TopologyError('an open boundary chain');
      v = n;
    }
    if (v !== start) throw new TopologyError('boundary chains merge');
    loops.push(loop);
  }
  return loops;
}

/**
 * Inserts a point into the mesh: splits the triangle that contains it into three, or, when it lies
 * on an edge, the one or two triangles of that edge into two each. Triangle winding is preserved.
 */
export function insertPoint(
  points: Coords,
  tris: ArrayLike<number>,
  x: number,
  y: number,
): TopoResult & { derivation: Derivation } {
  const hit = locate(points, tris, x, y);
  if (!hit) throw new TopologyError(`the point (${x}, ${y}) is outside the mesh`);
  const n = points.length / 2;
  const newPoints = new Float32Array(points.length + 2);
  newPoints.set(Array.from(points));
  newPoints[2 * n] = x;
  newPoints[2 * n + 1] = y;
  const t = hit.t;
  const v = [tris[3 * t]!, tris[3 * t + 1]!, tris[3 * t + 2]!];
  const derivation: Derivation = { from: v, weights: [...hit.w] };
  const out = Array.from(tris);
  const zero = hit.w.findIndex((w) => Math.abs(w) < 1e-6);
  const replace = (tri: number, from: number, to: number) => {
    for (let k = 0; k < 3; k++) if (out[3 * tri + k] === from) out[3 * tri + k] = to;
  };
  if (zero < 0) {
    // Three triangles: substitute the new vertex for each corner in turn.
    const base = out.slice(3 * t, 3 * t + 3);
    out.splice(3 * t, 3, ...base.map((u) => (u === v[0] ? n : u)));
    out.push(...base.map((u) => (u === v[1] ? n : u)), ...base.map((u) => (u === v[2] ? n : u)));
  } else {
    // On the edge opposite corner `zero`: split every triangle that has this edge.
    const e0 = v[(zero + 1) % 3]!;
    const e1 = v[(zero + 2) % 3]!;
    const count = out.length / 3;
    for (let s = 0; s < count; s++) {
      const tri = out.slice(3 * s, 3 * s + 3);
      if (!tri.includes(e0) || !tri.includes(e1)) continue;
      replace(s, e0, n);
      out.push(...tri.map((u) => (u === e1 ? n : u)));
    }
  }
  return { points: newPoints, triangles: Uint32Array.from(out), derivation };
}

/**
 * Removes vertices and their triangles, and fills each resulting hole by triangulating the ring of
 * neighbors. At the boundary, the ring is closed by a straight edge, and the hole is left open if
 * that would not give a simple polygon. Returns the old→new vertex map (-1 = removed).
 */
export function removeVertices(
  points: Coords,
  tris: ArrayLike<number>,
  remove: readonly number[],
): TopoResult & { map: Int32Array } {
  let cur = Array.from(tris);
  const gone = new Set(remove);
  for (const v of [...gone].sort((a, b) => a - b)) {
    const incident: number[][] = [];
    const rest: number[] = [];
    for (let t = 0; t < cur.length / 3; t++) {
      const tri = cur.slice(3 * t, 3 * t + 3);
      if (tri.includes(v)) incident.push(tri);
      else rest.push(...tri);
    }
    cur = rest;
    if (incident.length === 0) continue;
    // Link edges: for (v, b, c) in triangle order, the edge b → c.
    const next = new Map<number, number>();
    let bad = false;
    for (const tri of incident) {
      const k = tri.indexOf(v);
      const b = tri[(k + 1) % 3]!;
      const c = tri[(k + 2) % 3]!;
      if (next.has(b)) bad = true;
      next.set(b, c);
    }
    if (bad) continue;
    const targets = new Set(next.values());
    const starts = [...next.keys()].filter((b) => !targets.has(b));
    if (starts.length > 1) continue; // several fans: leave the hole open
    const ring: number[] = [];
    let s = starts[0] ?? next.keys().next().value!;
    const first = s;
    for (let guard = 0; guard <= next.size + 1; guard++) {
      ring.push(s);
      const nx = next.get(s);
      if (nx === undefined || nx === first) break;
      s = nx;
    }
    if (ring.length < 3) continue;
    const local = new Float64Array(2 * ring.length);
    ring.forEach((r, i) => {
      local[2 * i] = points[2 * r]!;
      local[2 * i + 1] = points[2 * r + 1]!;
    });
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      area += local[2 * i]! * local[2 * j + 1]! - local[2 * j]! * local[2 * i + 1]!;
    }
    if (!(area > 0)) continue; // a concave boundary notch: leave it open
    try {
      const filled = triangulate({ points: local, loops: [ring.map((_, i) => i)] });
      for (const i of filled) cur.push(ring[i]!);
    } catch {
      // Not a simple polygon: leave the hole open.
    }
  }
  const map = new Int32Array(points.length / 2).fill(-1);
  let k = 0;
  for (let i = 0; i < map.length; i++) if (!gone.has(i)) map[i] = k++;
  const out = new Float32Array(2 * k);
  for (let i = 0; i < map.length; i++)
    if (map[i]! >= 0) {
      out[2 * map[i]!] = points[2 * i]!;
      out[2 * map[i]! + 1] = points[2 * i + 1]!;
    }
  return { points: out, triangles: Uint32Array.from(cur.map((v) => map[v]!)), map };
}

/** Recomputes the triangles over the same vertices, keeping the current boundary. */
export function retriangulate(points: Coords, tris: ArrayLike<number>): Uint32Array {
  const loops = boundaryLoops(tris);
  if (loops.length === 0) throw new TopologyError('the mesh has no triangles');
  return triangulate({ points, loops });
}

/** Flips the edge shared by two triangles. The quad they form must be strictly convex. */
export function flipEdge(
  points: Coords,
  tris: ArrayLike<number>,
  a: number,
  b: number,
): Uint32Array {
  const out = Array.from(tris);
  const found: { t: number; third: number; forward: boolean }[] = [];
  for (let t = 0; t < out.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const u = out[3 * t + k]!;
      const w = out[3 * t + ((k + 1) % 3)]!;
      if ((u === a && w === b) || (u === b && w === a))
        found.push({ t, third: out[3 * t + ((k + 2) % 3)]!, forward: u === a });
    }
  }
  if (found.length !== 2)
    throw new TopologyError(`the edge ${a}–${b} is not shared by exactly two triangles`);
  const [f1, f2] = found as [(typeof found)[0], (typeof found)[0]];
  if (f1.forward === f2.forward)
    throw new TopologyError('the two triangles have opposite windings');
  // Normalize so t1 = (a, b, c) and t2 = (b, a, d).
  const [t1, t2] = f1.forward ? [f1, f2] : [f2, f1];
  const c = t1.third;
  const d = t2.third;
  const s = Math.sign(orient(...pt(points, a), ...pt(points, b), ...pt(points, c)));
  const o1 = Math.sign(orient(...pt(points, c), ...pt(points, a), ...pt(points, d)));
  const o2 = Math.sign(orient(...pt(points, d), ...pt(points, b), ...pt(points, c)));
  if (s === 0 || o1 !== s || o2 !== s)
    throw new TopologyError(`the edge ${a}–${b} cannot be flipped: its quad is not convex`);
  out.splice(3 * t1.t, 3, c, a, d);
  out.splice(3 * t2.t, 3, d, b, c);
  return Uint32Array.from(out);
}
