/** PNG decoding and encoding to and from 8-bit straight-alpha RGBA, through fast-png (MIT). */
import { MochiError } from '@mochi-maker/core';
import type { Image } from '@mochi-maker/geometry';
import { convertIndexedToRgb, decode, encode } from 'fast-png';

export function decodePng(bytes: Uint8Array, what = 'PNG'): Image {
  let png;
  try {
    png = decode(bytes);
  } catch (e) {
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${what} is not a readable PNG: ${(e as Error).message}`,
    );
  }
  const { width, height } = png;
  const out = new Uint8Array(width * height * 4);
  if (png.palette) {
    const rgb = convertIndexedToRgb(png);
    const ch = rgb.length / (width * height);
    for (let i = 0; i < width * height; i++) {
      out[4 * i] = rgb[ch * i]!;
      out[4 * i + 1] = rgb[ch * i + 1]!;
      out[4 * i + 2] = rgb[ch * i + 2]!;
      out[4 * i + 3] = ch === 4 ? rgb[ch * i + 3]! : 255;
    }
    return { width, height, data: out };
  }
  if (png.depth !== 8 && png.depth !== 16)
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${what}: ${png.depth}-bit grayscale PNGs are not supported; save it as 8-bit.`,
    );
  const ch = png.channels;
  const shift = png.depth === 16 ? 8 : 0;
  const d = png.data;
  const key = png.transparency;
  for (let i = 0; i < width * height; i++) {
    const v = (k: number) => d[ch * i + k]! >> shift;
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (ch === 1 || ch === 2) {
      r = g = b = v(0);
      if (ch === 2) a = v(1);
      else if (key && d[i] === key[0]) a = 0;
    } else {
      r = v(0);
      g = v(1);
      b = v(2);
      if (ch === 4) a = v(3);
      else if (key && d[3 * i] === key[0] && d[3 * i + 1] === key[1] && d[3 * i + 2] === key[2])
        a = 0;
    }
    out[4 * i] = r;
    out[4 * i + 1] = g;
    out[4 * i + 2] = b;
    out[4 * i + 3] = a;
  }
  return { width, height, data: out };
}

/** Encodes 8-bit RGBA. Deterministic: the same pixels always give the same bytes. */
export function encodePng(image: Image): Uint8Array {
  return encode({
    width: image.width,
    height: image.height,
    data: image.data,
    depth: 8,
    channels: 4,
  });
}

/** The image cropped to its pixels with alpha > 0, or null when it has none. */
export function trimImage(image: Image): { image: Image; x: number; y: number } | null {
  const { width: w, height: h, data } = image;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[4 * (y * w + x) + 3]! > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;
  if (tw === w && th === h) return { image, x: 0, y: 0 };
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++)
    out.set(data.subarray(4 * ((y + y0) * w + x0), 4 * ((y + y0) * w + x0 + tw)), 4 * y * tw);
  return { image: { width: tw, height: th, data: out }, x: x0, y: y0 };
}
