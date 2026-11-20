import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MeshGenerationError,
  alphaMask,
  boundaryLoops,
  dilate,
  generateMesh,
  locate,
  loopArea2,
  meshPreview,
  orientIdx,
  removeSaddles,
  seededRandom,
  traceOutlines,
} from '@mochi-maker/geometry';

/** RGBA image of random overlapping discs (and optionally a hole punched in the first). */
function blobs(seed: number, w: number, h: number, count: number, hole: boolean): Uint8Array {
  const rnd = seededRandom(seed);
  const img = new Uint8Array(w * h * 4);
  const discs: [number, number, number][] = [];
  for (let i = 0; i < count; i++)
    discs.push([rnd() * w, rnd() * h, 3 + rnd() * Math.min(w, h) * 0.3]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (const [cx, cy, r] of discs)
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < r * r) a = 255;
      if (
        hole &&
        discs[0] &&
        (x + 0.5 - discs[0][0]) ** 2 + (y + 0.5 - discs[0][1]) ** 2 < (discs[0][2] * 0.4) ** 2
      )
        a = 0;
      img[4 * (y * w + x) + 3] = a;
      img[4 * (y * w + x)] = 200;
    }
  return img;
}

function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const img = new Uint8Array(w * h * 4);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img[4 * (y * w + x) + 3] = 255;
  return img;
}

describe('outlines', () => {
  it('trace a rectangle, a ring and two islands', () => {
    const m = alphaMask(rect(10, 10, 2, 3, 7, 9), 10, 10);
    const { mask, pad } = dilate(m, 0);
    const loops = traceOutlines(mask);
    expect(loops).toHaveLength(1);
    expect(loopArea2(loops[0]!) / 2).toBe(30);
    expect(loops[0]!.length / 2).toBe(4);
    expect(pad).toBe(1);

    const ring = rect(12, 12, 1, 1, 11, 11);
    for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) ring[4 * (y * 12 + x) + 3] = 0;
    const r = traceOutlines(dilate(alphaMask(ring, 12, 12), 0).mask);
    expect(r.map((l) => loopArea2(l) / 2).sort((a, b) => a - b)).toEqual([-16, 100]);
  });

  it('removes saddles so outlines never touch', () => {
    const img = new Uint8Array(4 * 4 * 4);
    img[4 * (1 * 4 + 1) + 3] = 255;
    img[4 * (2 * 4 + 2) + 3] = 255;
    const { mask } = dilate(alphaMask(img, 4, 4), 0);
    removeSaddles(mask);
    const loops = traceOutlines(mask);
    expect(loops).toHaveLength(1);
    expect(loopArea2(loops[0]!) / 2).toBe(3);
  });

  it('dilates by the margin', () => {
    const { mask } = dilate(alphaMask(rect(5, 5, 2, 2, 3, 3), 5, 5), 2);
    expect(mask.data.reduce((s, v) => s + v, 0)).toBe(25);
  });
});

describe('mesh generation', () => {
  it('covers every opaque pixel, with valid forward-facing triangles', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 1, max: 6 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 4 }),
        (seed, count, hole, margin) => {
          const w = 64;
          const h = 48;
          const img = blobs(seed, w, h, count, hole);
          let mesh;
          try {
            mesh = generateMesh(img, w, h, {
              margin,
              spacing: 6,
              seed,
              minIslandArea: 0,
              minHoleArea: 0,
            });
          } catch (e) {
            if (e instanceof MeshGenerationError && e.reason === 'empty') return;
            throw e;
          }
          const { points, triangles } = mesh;
          for (let t = 0; t < triangles.length; t += 3)
            expect(
              orientIdx(points, triangles[t]!, triangles[t + 1]!, triangles[t + 2]!),
            ).toBeGreaterThan(0);
          // Every opaque pixel (its four corners, nudged inward) lies in the mesh.
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              if (img[4 * (y * w + x) + 3]! < 8) continue;
              for (const [cx, cy] of [
                [0.01, 0.01],
                [0.99, 0.01],
                [0.01, 0.99],
                [0.99, 0.99],
              ] as const)
                expect(
                  locate(points, triangles, x + cx, y + cy, 1e-6),
                  `pixel ${x},${y}`,
                ).not.toBeNull();
            }
          // The outline is a proper boundary: each boundary loop is one of the outline loops.
          expect(boundaryLoops(triangles).length).toBe(mesh.loops.length);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('is deterministic, and density follows the spacing', () => {
    const img = blobs(7, 120, 90, 4, true);
    const a = generateMesh(img, 120, 90, { spacing: 8, seed: 3 });
    const b = generateMesh(img, 120, 90, { spacing: 8, seed: 3 });
    expect([...a.points]).toEqual([...b.points]);
    expect([...a.triangles]).toEqual([...b.triangles]);
    const coarse = generateMesh(img, 120, 90, { spacing: 16, seed: 3 });
    expect(coarse.points.length).toBeLessThan(a.points.length / 2);
    expect(a.stats.holes).toBeGreaterThanOrEqual(0);
  });

  it('drops small islands and fills small holes', () => {
    const img = rect(40, 40, 5, 5, 35, 35);
    img[4 * (0 * 40 + 0) + 3] = 255; // a 1-pixel speck
    for (let y = 18; y < 20; y++) for (let x = 18; x < 20; x++) img[4 * (y * 40 + x) + 3] = 0; // a tiny hole
    const m = generateMesh(img, 40, 40, { margin: 0, spacing: 10 });
    expect(m.stats.islands).toBe(1);
    expect(m.stats.holes).toBe(0);
  });

  it('reports empty images and too many vertices', () => {
    expect(() => generateMesh(new Uint8Array(16 * 4), 4, 4)).toThrow(MeshGenerationError);
    expect(() =>
      generateMesh(rect(200, 200, 0, 0, 200, 200), 200, 200, { spacing: 2, maxVertices: 100 }),
    ).toThrow(/vertices/);
  });

  it('makes a preview image', () => {
    const img = blobs(3, 50, 40, 3, false);
    const m = generateMesh(img, 50, 40, { spacing: 6 });
    const p = meshPreview({ width: 50, height: 40, data: img }, m.points, m.triangles, {
      maxSize: 64,
    });
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(64);
    expect(p.data.length).toBe(p.width * p.height * 4);
  });
});
