/** Image helpers for previews: contact sheets and difference images (agent API design 2.5). */
import type { Image } from '@mochi-maker/geometry';

/** Tiles placed in a grid, left to right and top to bottom, on a background. */
export function contactSheet(
  tiles: Image[],
  columns: number,
  background: [number, number, number, number] = [255, 255, 255, 255],
  gap = 4,
): Image {
  const w = tiles[0]!.width;
  const h = tiles[0]!.height;
  const rows = Math.ceil(tiles.length / columns);
  const width = columns * w + (columns + 1) * gap;
  const height = rows * h + (rows + 1) * gap;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(background, 4 * i);
  tiles.forEach((t, k) => {
    const x0 = gap + (k % columns) * (w + gap);
    const y0 = gap + Math.floor(k / columns) * (h + gap);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = 4 * (y * w + x);
        const d = 4 * ((y0 + y) * width + x0 + x);
        // Straight alpha over the background.
        const a = t.data[s + 3]! / 255;
        for (let c = 0; c < 3; c++)
          data[d + c] = Math.round(t.data[s + c]! * a + background[c]! * (1 - a));
        data[d + 3] = 255;
      }
  });
  return { width, height, data };
}

export interface DiffMetrics {
  /** Root mean square difference over RGBA, 0–1. */
  rms: number;
  /** Fraction of pixels where some channel differs by more than 2/255. */
  changed: number;
  /** The largest channel difference, 0–255. */
  max: number;
}

/**
 * A difference image: unchanged pixels show the "after" image dimmed to gray; changed pixels show
 * in red, brighter for larger differences.
 */
export function difference(before: Image, after: Image): { image: Image; metrics: DiffMetrics } {
  if (before.width !== after.width || before.height !== after.height)
    throw new Error('Images of different sizes cannot be compared.');
  const n = before.width * before.height;
  const data = new Uint8Array(n * 4);
  let sum = 0;
  let changed = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 4; c++) {
      const x = Math.abs(before.data[4 * i + c]! - after.data[4 * i + c]!);
      sum += (x / 255) ** 2;
      d = Math.max(d, x);
    }
    max = Math.max(max, d);
    const gray = Math.round(
      ((after.data[4 * i]! + after.data[4 * i + 1]! + after.data[4 * i + 2]!) / 3) *
        (after.data[4 * i + 3]! / 255) *
        0.35 +
        40,
    );
    if (d > 2) {
      changed++;
      data.set([Math.min(255, 128 + d), 32, 32, 255], 4 * i);
    } else data.set([gray, gray, gray, 255], 4 * i);
  }
  return {
    image: { width: before.width, height: before.height, data },
    metrics: { rms: Math.sqrt(sum / (n * 4)), changed: changed / n, max },
  };
}
