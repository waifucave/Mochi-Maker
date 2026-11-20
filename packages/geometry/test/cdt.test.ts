import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  incircle,
  insideEvenOdd,
  orientIdx,
  seededRandom,
  triangulate,
} from '@mochi-maker/geometry';

interface Case {
  points: number[];
  loops: number[][];
}

/** Checks a triangulation of a region bounded by loops. Returns the covered area. */
export function checkTriangulation(
  points: ArrayLike<number>,
  tris: ArrayLike<number>,
  loops: number[][],
): number {
  const flat = loops.map((l) => l.flatMap((i) => [points[2 * i]!, points[2 * i + 1]!]));
  let area = 0;
  const edgeUse = new Map<string, number>();
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const o = orientIdx(points, a, b, c);
    expect(o).toBeGreaterThan(0);
    area += o / 2;
    const cx = (points[2 * a]! + points[2 * b]! + points[2 * c]!) / 3;
    const cy = (points[2 * a + 1]! + points[2 * b + 1]! + points[2 * c + 1]!) / 3;
    expect(insideEvenOdd(cx, cy, flat)).toBe(true);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = `${u},${v}`;
      expect(edgeUse.has(k)).toBe(false); // no two triangles share a directed edge: no overlaps
      edgeUse.set(k, t);
    }
  }
  // Every loop edge exists (possibly split at collinear points, so test coverage by direction).
  const loopEdges = new Set<string>();
  for (const l of loops)
    for (let i = 0; i < l.length; i++) loopEdges.add(`${l[i]},${l[(i + 1) % l.length]}`);
  for (const e of loopEdges) {
    const [u, v] = e.split(',');
    expect(
      edgeUse.has(`${u},${v}`) ||
        edgeUse.has(`${v},${u}`) ||
        collinearSplit(points, Number(u), Number(v), edgeUse),
    ).toBe(true);
  }
  // Delaunay for interior edges that are not loop edges.
  for (const [k, t] of edgeUse) {
    const [u, v] = k.split(',').map(Number) as [number, number];
    const back = edgeUse.get(`${v},${u}`);
    if (back === undefined || loopEdges.has(k) || loopEdges.has(`${v},${u}`)) continue;
    const w = [tris[back]!, tris[back + 1]!, tris[back + 2]!].find((x) => x !== u && x !== v)!;
    const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const scale =
      Math.max(...[a, b, c].map((i) => Math.abs(points[2 * i]!) + Math.abs(points[2 * i + 1]!))) **
        4 || 1;
    expect(incircle(points, a, b, c, w)).toBeLessThanOrEqual(1e-9 * scale);
  }
  return area;
}

function collinearSplit(
  points: ArrayLike<number>,
  u: number,
  v: number,
  edges: Map<string, number>,
): boolean {
  // Accept a loop edge represented by a chain through collinear points.
  for (const k of edges.keys()) {
    const [a] = k.split(',').map(Number) as [number, number];
    if (a !== u) continue;
    const [, b] = k.split(',').map(Number) as [number, number];
    if (orientIdx(points, u, v, b) === 0 && b !== v)
      return collinearSplit(points, b, v, edges) || edges.has(`${b},${v}`);
  }
  return false;
}

function polyArea(points: number[], loop: number[]): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    s += points[2 * a]! * points[2 * b + 1]! - points[2 * b]! * points[2 * a + 1]!;
  }
  return s / 2;
}

/** A random star-shaped polygon, optionally with a star-shaped hole, plus interior points. */
function starCase(seed: number, n: number, interior: number, hole: boolean): Case {
  const rnd = seededRandom(seed);
  const points: number[] = [];
  const outer: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 60 + rnd() * 40;
    outer.push(points.length / 2);
    points.push(Math.round(100 + r * Math.cos(a)), Math.round(100 + r * Math.sin(a)));
  }
  const loops = [outer];
  if (hole) {
    const h: number[] = [];
    const m = 3 + Math.floor(rnd() * 6);
    for (let i = m - 1; i >= 0; i--) {
      const a = (i / m) * Math.PI * 2;
      const r = 10 + rnd() * 20;
      h.push(points.length / 2);
      points.push(100 + r * Math.cos(a), 100 + r * Math.sin(a));
    }
    loops.push(h);
  }
  const flat = loops.map((l) => l.flatMap((i) => [points[2 * i]!, points[2 * i + 1]!]));
  for (let i = 0; i < interior; i++) {
    const x = 20 + rnd() * 160;
    const y = 20 + rnd() * 160;
    if (insideEvenOdd(x, y, flat)) points.push(x, y);
  }
  return { points, loops };
}

describe('constrained Delaunay triangulation', () => {
  it('triangulates a square with a square hole', () => {
    const points = [0, 0, 10, 0, 10, 10, 0, 10, 3, 3, 3, 7, 7, 7, 7, 3];
    const loops = [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ];
    const tris = triangulate({ points, loops });
    expect(checkTriangulation(points, tris, loops)).toBeCloseTo(100 - 16, 9);
  });

  it('keeps islands inside holes (even-odd)', () => {
    const points = [
      0, 0, 30, 0, 30, 30, 0, 30, 5, 5, 5, 25, 25, 25, 25, 5, 10, 10, 20, 10, 20, 20, 10, 20,
    ];
    const loops = [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11],
    ];
    const tris = triangulate({ points, loops });
    expect(checkTriangulation(points, tris, loops)).toBeCloseTo(900 - 400 + 100, 9);
  });

  it('handles collinear boundary points and a cocircular grid', () => {
    const points: number[] = [];
    const loop: number[] = [];
    for (let i = 0; i < 10; i++) (loop.push(points.length / 2), points.push(i * 10, 0));
    for (let i = 0; i < 10; i++) (loop.push(points.length / 2), points.push(100, i * 10));
    for (let i = 10; i > 0; i--) (loop.push(points.length / 2), points.push(i * 10, 100));
    for (let i = 10; i > 0; i--) (loop.push(points.length / 2), points.push(0, i * 10));
    for (let x = 10; x < 100; x += 10) for (let y = 10; y < 100; y += 10) points.push(x, y);
    const tris = triangulate({ points, loops: [loop] });
    expect(checkTriangulation(points, tris, [loop])).toBeCloseTo(10000, 6);
    expect(tris.length / 3).toBe(200);
  });

  it('recovers constraints that pass through other points, and merges duplicates', () => {
    const points = [0, 0, 10, 0, 10, 10, 0, 10, 5, 5, 0, 0];
    const tris = triangulate({ points, loops: [[0, 1, 2, 3]], edges: [[0, 2]] });
    expect(checkTriangulation(points, tris, [[0, 1, 2, 3]])).toBeCloseTo(100, 9);
    const edges = new Set<string>();
    for (let t = 0; t < tris.length; t += 3)
      for (let k = 0; k < 3; k++) edges.add(`${tris[t + k]},${tris[t + ((k + 1) % 3)]}`);
    expect(edges.has('0,4') || edges.has('4,0')).toBe(true);
    expect(edges.has('4,2') || edges.has('2,4')).toBe(true);
    expect([...tris].includes(5)).toBe(false);
  });

  it('is correct on random polygons with holes and interior points', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 3, max: 60 }),
        fc.integer({ min: 0, max: 200 }),
        fc.boolean(),
        (seed, n, k, hole) => {
          const c = starCase(seed, n, k, hole);
          const tris = triangulate(c);
          const expected = c.loops.reduce((s, l) => s + polyArea(c.points, l), 0);
          expect(checkTriangulation(c.points, tris, c.loops)).toBeCloseTo(expected, 6);
        },
      ),
      { numRuns: 300 },
    );
    // Room for a machine shared with other suites.
  }, 60_000);
});
