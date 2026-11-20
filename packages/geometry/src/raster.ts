/**
 * A tiny RGBA rasterizer for preview images (agent API design 3.1): images composited with
 * straight alpha, and lines for wireframes. Encoding to PNG happens elsewhere.
 */
import type { Coords } from './predicates.js';

export interface Image {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, straight alpha. */
  data: Uint8Array;
}

export type Rgba = readonly [number, number, number, number];

export function blankImage(width: number, height: number, fill: Rgba = [0, 0, 0, 0]): Image {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, 4 * i);
  return { width: Math.max(1, width), height: Math.max(1, height), data };
}

/** A light checkerboard, the usual backdrop for transparent art. */
export function checkerboard(width: number, height: number, cell = 8): Image {
  const img = blankImage(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 236 : 210;
      img.data.set([v, v, v, 255], 4 * (y * width + x));
    }
  return img;
}

/** Blends one straight-alpha pixel over the destination pixel. */
function blend(dst: Uint8Array, i: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const sa = a / 255;
  const da = dst[i + 3]! / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  dst[i] = Math.round((r * sa + dst[i]! * da * (1 - sa)) / oa);
  dst[i + 1] = Math.round((g * sa + dst[i + 1]! * da * (1 - sa)) / oa);
  dst[i + 2] = Math.round((b * sa + dst[i + 2]! * da * (1 - sa)) / oa);
  dst[i + 3] = Math.round(oa * 255);
}

/**
 * Draws a source image over the destination at (dx, dy) and scale s, with nearest sampling and an
 * extra opacity factor.
 */
export function drawImage(
  dst: Image,
  src: Image,
  dx: number,
  dy: number,
  s: number,
  opacity = 1,
): void {
  const x0 = Math.max(0, Math.floor(dx));
  const y0 = Math.max(0, Math.floor(dy));
  const x1 = Math.min(dst.width, Math.ceil(dx + src.width * s));
  const y1 = Math.min(dst.height, Math.ceil(dy + src.height * s));
  for (let y = y0; y < y1; y++) {
    const sy = Math.floor((y + 0.5 - dy) / s);
    if (sy < 0 || sy >= src.height) continue;
    for (let x = x0; x < x1; x++) {
      const sx = Math.floor((x + 0.5 - dx) / s);
      if (sx < 0 || sx >= src.width) continue;
      const si = 4 * (sy * src.width + sx);
      blend(
        dst.data,
        4 * (y * dst.width + x),
        src.data[si]!,
        src.data[si + 1]!,
        src.data[si + 2]!,
        src.data[si + 3]! * opacity,
      );
    }
  }
}

/** Draws a one-pixel line (Bresenham). */
export function drawLine(
  img: Image,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: Rgba,
): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xe = Math.round(x1);
  const ye = Math.round(y1);
  const dx = Math.abs(xe - x);
  const dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 100000; guard++) {
    if (x >= 0 && y >= 0 && x < img.width && y < img.height)
      blend(img.data, 4 * (y * img.width + x), color[0], color[1], color[2], color[3]);
    if (x === xe && y === ye) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** The scale that fits (width, height) into maxSize × maxSize, never enlarging. */
export function fitScale(width: number, height: number, maxSize: number): number {
  return Math.min(1, maxSize / Math.max(width, height, 1));
}

/**
 * A preview of a mesh over its image: checkerboard, the image, the triangle edges, and the
 * outline drawn stronger. Coordinates are image pixels; the mesh may extend past the image.
 */
export function meshPreview(
  image: Image,
  points: Coords,
  triangles: ArrayLike<number>,
  options: { maxSize?: number } = {},
): Image {
  let minX = 0;
  let minY = 0;
  let maxX = image.width;
  let maxY = image.height;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]!);
    maxX = Math.max(maxX, points[i]!);
    minY = Math.min(minY, points[i + 1]!);
    maxY = Math.max(maxY, points[i + 1]!);
  }
  const pad = 4;
  const s = fitScale(maxX - minX + 2 * pad, maxY - minY + 2 * pad, options.maxSize ?? 256);
  const w = Math.ceil((maxX - minX + 2 * pad) * s);
  const h = Math.ceil((maxY - minY + 2 * pad) * s);
  const out = checkerboard(w, h);
  const ox = (pad - minX) * s;
  const oy = (pad - minY) * s;
  drawImage(out, image, ox, oy, s);
  const edges = new Map<string, number>();
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k]!;
      const b = triangles[t + ((k + 1) % 3)]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  for (const [key, count] of edges) {
    const [a, b] = key.split(',').map(Number) as [number, number];
    const color: Rgba = count === 1 ? [220, 40, 90, 255] : [40, 110, 230, 170];
    drawLine(
      out,
      ox + points[2 * a]! * s,
      oy + points[2 * a + 1]! * s,
      ox + points[2 * b]! * s,
      oy + points[2 * b + 1]! * s,
      color,
    );
  }
  return out;
}
