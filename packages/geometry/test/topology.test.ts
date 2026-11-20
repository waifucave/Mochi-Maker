import { describe, expect, it } from 'vitest';
import {
  TopologyError,
  applyDerivations,
  boundaryLoops,
  derivePoints,
  flipEdge,
  insertPoint,
  orientIdx,
  removeVertices,
  retriangulate,
} from '@mochi-maker/geometry';

const area = (p: ArrayLike<number>, t: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < t.length; i += 3) s += orientIdx(p, t[i]!, t[i + 1]!, t[i + 2]!) / 2;
  return s;
};

// A 2×2-cell grid: vertices 0..8, row-major, 8 triangles.
const GRID = Float32Array.from([0, 0, 10, 0, 20, 0, 0, 10, 10, 10, 20, 10, 0, 20, 10, 20, 20, 20]);
const GRID_TRIS = Uint32Array.from([
  0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 3, 4, 7, 3, 7, 6, 4, 5, 8, 4, 8, 7,
]);

describe('mesh topology', () => {
  it('inserts a point inside a triangle or on an edge, keeping area and winding', () => {
    const a = insertPoint(GRID, GRID_TRIS, 6, 2);
    expect(a.triangles.length / 3).toBe(10);
    expect(area(a.points, a.triangles)).toBeCloseTo(400, 9);
    const pos = applyDerivations(GRID, [a.derivation]);
    expect([...pos]).toEqual([6, 2]);
    const b = insertPoint(GRID, GRID_TRIS, 5, 5); // on the diagonal 0–4
    expect(b.triangles.length / 3).toBe(10);
    expect(area(b.points, b.triangles)).toBeCloseTo(400, 9);
    for (let i = 0; i < b.triangles.length; i += 3)
      expect(
        orientIdx(b.points, b.triangles[i]!, b.triangles[i + 1]!, b.triangles[i + 2]!),
      ).toBeGreaterThan(0);
    expect(() => insertPoint(GRID, GRID_TRIS, 30, 30)).toThrow(TopologyError);
  });

  it('removes an interior vertex and fills the hole', () => {
    const r = removeVertices(GRID, GRID_TRIS, [4]);
    expect(r.points.length / 2).toBe(8);
    expect([...r.map]).toEqual([0, 1, 2, 3, -1, 4, 5, 6, 7]);
    expect(area(r.points, r.triangles)).toBeCloseTo(400, 9);
    expect(boundaryLoops(r.triangles)).toHaveLength(1);
  });

  it('removes a boundary vertex', () => {
    const r = removeVertices(GRID, GRID_TRIS, [1]); // the middle of the top edge: refilled straight
    expect(area(r.points, r.triangles)).toBeCloseTo(400, 9);
    const corner = removeVertices(GRID, GRID_TRIS, [0]);
    expect(area(corner.points, corner.triangles)).toBeCloseTo(350, 9);
  });

  it('retriangulates over the same vertices and boundary', () => {
    const t = retriangulate(GRID, GRID_TRIS);
    expect(t.length).toBe(GRID_TRIS.length);
    expect(area(GRID, t)).toBeCloseTo(400, 9);
  });

  it('flips an edge of a convex quad and refuses otherwise', () => {
    const t = flipEdge(GRID, GRID_TRIS, 0, 4);
    expect(area(GRID, t)).toBeCloseTo(400, 9);
    const edges = new Set<string>();
    for (let i = 0; i < t.length; i += 3)
      for (let k = 0; k < 3; k++) edges.add(`${t[i + k]},${t[i + ((k + 1) % 3)]}`);
    expect(edges.has('1,3') || edges.has('3,1')).toBe(true);
    expect(() => flipEdge(GRID, GRID_TRIS, 0, 1)).toThrow(/not shared/);
  });

  it('derives new points from an old mesh: exact copies, interpolation and extrapolation', () => {
    const d = derivePoints(GRID, GRID_TRIS, Float32Array.from([10, 10, 5, 2, 25, 0]));
    expect(d[0]).toEqual({ from: [4], weights: [1] });
    // A deformed keyform: everything shifted by (+1, +2) and scaled ×2 → derivations follow.
    const deformed = GRID.map((v, i) => (i % 2 === 0 ? 2 * v + 1 : 2 * v + 2));
    const out = applyDerivations(deformed, d);
    expect([...out]).toEqual([21, 22, 11, 6, 51, 2]);
  });
});
