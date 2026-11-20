/** The Bézier control layer of warps: fitting, the Coons surface and drag weights. */
import { describe, expect, it } from 'vitest';
import {
  anchorHandles,
  controlCount,
  controlRole,
  fitNet,
  netSurface,
  netWeights,
} from '../src/bezier.js';

/** A 4 × 3-cell grid, sheared and scaled: bilinear, so the net reproduces it exactly. */
const rows = 3;
const cols = 4;
const grid: number[] = [];
for (let r = 0; r <= rows; r++)
  for (let c = 0; c <= cols; c++) grid.push(10 + 25 * c + 5 * r, 20 + 30 * r);

describe('Bézier control layer', () => {
  it('fits a net that reproduces the grid', () => {
    for (const n of [
      { bu: 1, bv: 1 },
      { bu: 2, bv: 3 },
      { bu: 4, bv: 2 },
    ]) {
      const net = fitNet(grid, rows, cols, n);
      expect(net.length).toBe(2 * controlCount(n));
      for (let r = 0; r <= rows; r++)
        for (let c = 0; c <= cols; c++) {
          const [x, y] = netSurface(net, n, c / cols, r / rows);
          const k = 2 * (r * (cols + 1) + c);
          expect(x).toBeCloseTo(grid[k]!, 9);
          expect(y).toBeCloseTo(grid[k + 1]!, 9);
        }
    }
  });

  it('weights a drag: the dragged corner fully, its edges by half, the middle by a quarter', () => {
    const n = { bu: 1, bv: 1 };
    const corner = 0;
    expect(controlRole(n, corner).kind).toBe('anchor');
    const w = netWeights(n, 2, 2, [corner, ...anchorHandles(n, corner)]);
    // 3 × 3 grid points, row-major.
    expect(Array.from(w).map((x) => Math.round(x * 1e9) / 1e9)).toEqual([
      1, 0.5, 0, 0.5, 0.25, 0, 0, 0, 0,
    ]);
    // A handle alone moves its edge's inner points only.
    const handle = anchorHandles(n, corner)[0]!;
    expect(controlRole(n, handle)).toEqual({ kind: 'handle', anchor: corner });
    const wh = netWeights(n, 2, 2, [handle]);
    expect(wh[0]).toBe(0);
    expect(wh[1]).toBeCloseTo(0.375, 9);
    expect(wh[2]).toBe(0);
    // Moving every control point moves every grid point by the same amount.
    const all = Array.from({ length: controlCount({ bu: 2, bv: 3 }) }, (_, i) => i);
    for (const x of netWeights({ bu: 2, bv: 3 }, rows, cols, all)) expect(x).toBeCloseTo(1, 9);
  });
});
