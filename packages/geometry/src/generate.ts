/**
 * Automatic mesh generation from an image's alpha (design 3.4).
 *
 * outline (outline.ts) → interior points on a jittered grid → constrained Delaunay triangulation
 * (cdt.ts). Coordinates are image pixels (the layer's own pixel space); outlines lie on pixel
 * corners before simplification, and the mesh extends `margin` pixels beyond the opaque pixels.
 */
import { triangulate } from './cdt.js';
import {
  alphaMask,
  dilate,
  loopArea2,
  loopsIntersect,
  removeSaddles,
  resampleLoop,
  simplifyLoop,
  traceOutlines,
} from './outline.js';
import { insideEvenOdd, seededRandom, segmentDistance2 } from './predicates.js';

export interface MeshOptions {
  /** Alpha (0–255) at or above which a pixel counts as opaque. Default 8. */
  alphaThreshold?: number;
  /** Pixels the outline keeps outside the opaque pixels. Default 3. */
  margin?: number;
  /** Maximum deviation of the simplified outline from the traced one, in pixels. Default 1.5. */
  tolerance?: number;
  /** Distance between interior points, in pixels. When given, it is used as it is. */
  spacing?: number;
  /**
   * The spacing to use when `spacing` is not given, before clamping. Default: the spacing that
   * gives about 120 interior points per island.
   */
  defaultSpacing?: number;
  /**
   * When `spacing` is not given, the default is clamped so an island of average size gets between
   * these numbers of interior points. Default [30, 600].
   */
  islandPointRange?: [number, number];
  /** Maximum outline edge length, in pixels. Default: the spacing. */
  boundarySpacing?: number;
  /** Islands smaller than this many square pixels are dropped. Default 16. */
  minIslandArea?: number;
  /** Holes smaller than this many square pixels are filled. Default 16. */
  minHoleArea?: number;
  /** Seed for the interior-point jitter. Default 1. */
  seed?: number;
  /** Refuse to produce more vertices than this. Default 65535 (the format limit). */
  maxVertices?: number;
}

export interface GeneratedMesh {
  /** Vertex positions in image pixels, [x0, y0, ...]. */
  points: Float32Array;
  /** Triangles as vertex-index triples, positively oriented (forward-facing). */
  triangles: Uint32Array;
  /** Outline loops as vertex-index lists (outer loops positive, holes negative). */
  loops: number[][];
  stats: {
    islands: number;
    holes: number;
    outlinePoints: number;
    interiorPoints: number;
    spacing: number;
    tolerance: number;
  };
}

export class MeshGenerationError extends Error {
  constructor(
    message: string,
    readonly reason: 'empty' | 'too-many-vertices' | 'failed',
  ) {
    super(message);
  }
}

const f32 = (x: number) => Math.fround(x);

export function generateMesh(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  options: MeshOptions = {},
): GeneratedMesh {
  const threshold = options.alphaThreshold ?? 8;
  const margin = Math.max(0, Math.round(options.margin ?? 3));
  const minIsland = options.minIslandArea ?? 16;
  const minHole = options.minHoleArea ?? 16;
  const maxVertices = options.maxVertices ?? 65535;

  const base = alphaMask(rgba, width, height, threshold);
  const { mask, pad } = dilate(base, margin);
  removeSaddles(mask);
  let loops = traceOutlines(mask).map((l) => l.map((v) => v - pad));
  // Drop small islands, fill small holes.
  loops = loops.filter((l) => {
    const a = loopArea2(l) / 2;
    return a > 0 ? a >= minIsland : -a >= minHole;
  });
  // Holes whose island was dropped are dropped with it.
  const outers = loops.filter((l) => loopArea2(l) > 0);
  loops = loops.filter(
    (l) =>
      loopArea2(l) > 0 ||
      outers.some(
        (o) => insideEvenOdd(l[0]! + 0.5, l[1]! + 0.5, [o]) || insideEvenOdd(l[0]!, l[1]!, [o]),
      ),
  );
  if (loops.length === 0)
    throw new MeshGenerationError('The image has no opaque pixels above the threshold.', 'empty');

  const area = outers.reduce((s, l) => s + loopArea2(l) / 2, 0);
  const islands = outers.length;
  const perIsland = area / islands;
  let spacing: number;
  if (options.spacing !== undefined) spacing = options.spacing;
  else {
    const [lo, hi] = options.islandPointRange ?? [30, 600];
    const fallback = options.defaultSpacing ?? Math.sqrt(perIsland / 120);
    spacing = Math.min(Math.max(fallback, Math.sqrt(perIsland / hi)), Math.sqrt(perIsland / lo));
  }
  spacing = Math.max(2, spacing);
  const boundarySpacing = options.boundarySpacing ?? spacing;

  // Simplify, halving the tolerance until outlines no longer cross.
  let tolerance = Math.min(options.tolerance ?? 1.5, Math.max(0, margin - 0.5));
  let simple: number[][] = [];
  for (;;) {
    simple = loops.map((l) => resampleLoop(simplifyLoop(l, tolerance), boundarySpacing).map(f32));
    if (!loopsIntersect(simple)) break;
    if (tolerance === 0) throw new MeshGenerationError('The traced outlines intersect.', 'failed');
    tolerance = tolerance < 0.2 ? 0 : tolerance / 2;
  }

  // Interior points: a jittered grid, away from the outline.
  const rand = seededRandom(options.seed ?? 1);
  const interior: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of simple)
    for (let i = 0; i < l.length; i += 2) {
      minX = Math.min(minX, l[i]!);
      maxX = Math.max(maxX, l[i]!);
      minY = Math.min(minY, l[i + 1]!);
      maxY = Math.max(maxY, l[i + 1]!);
    }
  const keepAway2 = (spacing * 0.6) ** 2;
  const segs: number[] = [];
  for (const l of simple) {
    const n = l.length / 2;
    for (let i = 0; i < n; i++)
      segs.push(l[2 * i]!, l[2 * i + 1]!, l[2 * ((i + 1) % n)]!, l[2 * ((i + 1) % n) + 1]!);
  }
  // Bucket outline segments for the distance test.
  const cell = spacing * 2;
  const buckets = new Map<string, number[]>();
  for (let s = 0; s < segs.length; s += 4) {
    const x0 = Math.floor(Math.min(segs[s]!, segs[s + 2]!) / cell) - 1;
    const x1 = Math.floor(Math.max(segs[s]!, segs[s + 2]!) / cell) + 1;
    const y0 = Math.floor(Math.min(segs[s + 1]!, segs[s + 3]!) / cell) - 1;
    const y1 = Math.floor(Math.max(segs[s + 1]!, segs[s + 3]!) / cell) + 1;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        const b = buckets.get(k);
        if (b) b.push(s);
        else buckets.set(k, [s]);
      }
  }
  for (let y = minY + spacing / 2; y < maxY; y += spacing)
    for (let x = minX + spacing / 2; x < maxX; x += spacing) {
      const px = f32(x + (rand() - 0.5) * 0.6 * spacing);
      const py = f32(y + (rand() - 0.5) * 0.6 * spacing);
      if (!insideEvenOdd(px, py, simple)) continue;
      const near = buckets.get(`${Math.floor(px / cell)},${Math.floor(py / cell)}`) ?? [];
      if (
        near.some(
          (s) =>
            segmentDistance2(px, py, segs[s]!, segs[s + 1]!, segs[s + 2]!, segs[s + 3]!) <
            keepAway2,
        )
      )
        continue;
      interior.push(px, py);
    }

  const outlineCount = simple.reduce((s, l) => s + l.length / 2, 0);
  const total = outlineCount + interior.length / 2;
  if (total > maxVertices)
    throw new MeshGenerationError(
      `The mesh would have ${total} vertices (limit ${maxVertices}). Use a larger spacing.`,
      'too-many-vertices',
    );

  const points = new Float32Array(2 * total);
  const loopIdx: number[][] = [];
  let k = 0;
  for (const l of simple) {
    const idx: number[] = [];
    for (let i = 0; i < l.length; i += 2) {
      points[2 * k] = l[i]!;
      points[2 * k + 1] = l[i + 1]!;
      idx.push(k++);
    }
    loopIdx.push(idx);
  }
  points.set(interior, 2 * k);
  const triangles = triangulate({ points, loops: loopIdx });
  return {
    points,
    triangles,
    loops: loopIdx,
    stats: {
      islands,
      holes: simple.length - islands,
      outlinePoints: outlineCount,
      interiorPoints: interior.length / 2,
      spacing,
      tolerance,
    },
  };
}
