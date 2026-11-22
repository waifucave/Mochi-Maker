/**
 * PNG decoding and encoding to and from 8-bit straight-alpha RGBA, through fast-png (MIT).
 *
 * Before decoding, a PNG's chunks are checked here: its declared size against the image caps
 * (LIMITS), and its compressed data, inflated in small steps and counted but not kept, against
 * what that size holds, more or less. fast-png inflates all of it at once, so without this check a small file
 * could inflate to gigabytes.
 */
import { LIMITS, MochiError, checkImageSize, tooLarge, type Budget } from '@mochi-maker/core';
import type { Image } from '@mochi-maker/geometry';
import { convertIndexedToRgb, decode, encode } from 'fast-png';
import { Unzlib } from 'fflate';
import { FORMAT_NAMES, imageHeader } from './mochi2d.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Adam7 passes: x start, y start, x step, y step. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

/** The bytes a PNG's image data inflates to, by its header: rows with their filter bytes. */
function rawSize(w: number, h: number, depth: number, channels: number, interlace: number) {
  const row = (pw: number) => 1 + Math.ceil((pw * depth * channels) / 8);
  if (interlace !== 1) return h * row(w);
  let n = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = Math.ceil((w - x0) / dx);
    const ph = Math.ceil((h - y0) / dy);
    if (pw > 0 && ph > 0) n += ph * row(pw);
  }
  return n;
}

/**
 * Inflates zlib data in small steps, counting what comes out without keeping it, and calls
 * `over` (which throws) the moment the count passes `max`. A step's input is 16 KiB, so its
 * output is at most about 16 MiB (deflate inflates at most about 1,032 times).
 */
export function inflateCount(parts: Uint8Array[], max: number, over: (n: number) => never): number {
  let n = 0;
  const z = new Unzlib((chunk) => {
    n += chunk.length;
    if (n > max) over(n);
  });
  const STEP = 16384;
  try {
    for (const p of parts)
      for (let i = 0; i < p.length; i += STEP) z.push(p.subarray(i, i + STEP), false);
    z.push(new Uint8Array(0), true);
  } catch (e) {
    if (e instanceof MochiError) throw e;
    // A damaged stream: fast-png reports it in its own words.
  }
  return n;
}

/**
 * Checks a PNG before it is decoded (module comment): its size against the caps, and its image
 * data and color profile against what they may inflate to. Data that is not a PNG is left for the
 * decoder to refuse.
 */
export function checkPng(bytes: Uint8Array, what = 'PNG', budget?: Budget): void {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (o: number) => String.fromCharCode(...bytes.subarray(o + 4, o + 8));
  if (type(8) !== 'IHDR') return;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = bytes[24]!;
  const channels = CHANNELS[bytes[25]!] ?? 4;
  const interlace = bytes[28]!;
  checkImageSize(width, height, what);
  budget?.take(width * height);
  const idat: Uint8Array[] = [];
  let profile: Uint8Array | undefined;
  for (let o = 8; o + 12 <= bytes.length;) {
    const len = view.getUint32(o);
    const t = type(o);
    const data = bytes.subarray(o + 8, Math.min(bytes.length, o + 8 + len));
    if (t === 'IHDR' && o !== 8)
      throw new MochiError('E_ASSET_FORMAT', `${what} is damaged: it has more than one header.`);
    if (t === 'IDAT') idat.push(data);
    if (t === 'iCCP' && !profile) {
      const z = data.indexOf(0);
      if (z >= 0) profile = data.subarray(z + 2);
    }
    if (t === 'IEND') break;
    o += 12 + len;
  }
  const raw = rawSize(width, height, depth, channels, interlace);
  const n = inflateCount(idat, raw, () => {
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${what} is damaged or crafted: its image data inflates to more than a ${width} × ${height} image holds.`,
    );
  });
  // A header that declares more than the data holds: fast-png would allocate the declared size.
  if (n < raw)
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${what} is damaged or crafted: its image data holds less than the ${width} × ${height} pixels its header declares.`,
    );
  if (profile)
    inflateCount([profile], LIMITS.pngProfileBytes, (n) => {
      throw tooLarge(`${what}'s embedded color profile`, n, LIMITS.pngProfileBytes);
    });
}

/** Formats Mochi2D does not load as textures, by their first bytes (generic signatures). */
function otherFormat(b: Uint8Array): string | null {
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'avif' || brand === 'avis') return 'AVIF';
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'HEIF';
  }
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'TIFF';
  if ((b[0] === 0xff && b[1] === 0x0a) || ascii(4, 4) === 'JXL ') return 'JPEG XL';
  if (/^\s*<(\?xml|svg)/i.test(ascii(0, 64))) return 'SVG';
  return null;
}

/**
 * Refuses data that is not a PNG, plainly: the format it is, where it is one Mochi2D reads the
 * header of (a JPEG, a WebP…) or one it does not load at all (AVIF, HEIF, TIFF, JPEG XL, SVG).
 */
function notPng(bytes: Uint8Array, what: string): never {
  const other = otherFormat(bytes);
  if (other)
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${what} is a${other === 'AVIF' ? 'n' : ''} ${other} image, not a PNG. Mochi Maker reads PNG images, and ${other} is not a texture format models can use; save it as PNG.`,
    );
  let header;
  try {
    header = imageHeader(what, bytes);
  } catch {
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${what} is not a readable PNG: it is damaged, or not an image. Mochi Maker reads PNG images.`,
    );
  }
  throw new MochiError(
    'E_ASSET_FORMAT',
    `${what} is a ${FORMAT_NAMES[header.format]} image, not a PNG. Mochi Maker reads PNG images; save it as PNG.`,
  );
}

/**
 * Decodes a PNG to 8-bit RGBA, within the image caps; `budget` also counts its pixels toward a
 * total (an art file's layers).
 */
export function decodePng(bytes: Uint8Array, what = 'PNG', budget?: Budget): Image {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) notPng(bytes, what);
  checkPng(bytes, what, budget);
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
