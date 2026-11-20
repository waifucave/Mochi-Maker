/** The deform path: binding points to a path, and moving them with it. */
import { describe, expect, it } from 'vitest';
import { bindPoints, skin, type Pt } from '../src/deformpath.js';

const pts = Float64Array.from([0, 0, 50, 10, 100, 0, 100, 40, 300, 300]);
const path: Pt[] = [
  [0, 0],
  [100, 0],
];

describe('deform path', () => {
  it('moves nothing while the path stays, and nothing beyond reach', () => {
    const b = bindPoints(path, pts, 50);
    expect(Array.from(skin(path, path, pts, b))).toEqual(Array.from(pts));
    expect(b[4]!.w).toBe(0);
    const moved = skin(
      path,
      [
        [0, 0],
        [100, 30],
      ],
      pts,
      b,
    );
    expect([moved[8], moved[9]]).toEqual([300, 300]);
  });

  it('carries points on the path fully, and turns nearby ones with the segment', () => {
    const b = bindPoints(path, pts, 50);
    const after: Pt[] = [
      [0, 0],
      [0, 100],
    ];
    const m = skin(path, after, pts, b);
    // The end point goes with the path's end; the start stays.
    expect([m[0], m[1]]).toEqual([0, 0]);
    expect(m[4]).toBeCloseTo(0, 9);
    expect(m[5]).toBeCloseTo(100, 9);
    // (50, 10) is 10 px off the path's middle: turned 90°, it is 10 px off the new middle,
    // pulled back by the fall-off (1 − (10/50)²)² = 0.9216.
    const w = (1 - (10 / 50) ** 2) ** 2;
    expect(m[2]).toBeCloseTo(50 + w * (-10 - 50), 9);
    expect(m[3]).toBeCloseTo(10 + w * (50 - 10), 9);
  });

  it('translates with a one-point path', () => {
    const one: Pt[] = [[50, 0]];
    const b = bindPoints(one, pts, 1000);
    const m = skin(one, [[70, 0]], pts, b);
    expect(m[2]! - 50).toBeCloseTo(20 * b[1]!.w, 9);
    expect(b[1]!.w).toBeGreaterThan(0.99);
  });
});
