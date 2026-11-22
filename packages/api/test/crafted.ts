/**
 * Crafted pictures for the tests of the caps on textures (textures.test.ts, and the editor's).
 * Built here, in a few hundred KiB at most: zlib data written with the fixed Huffman codes, which
 * inflates to any number of zero bytes.
 */
import { crc32 } from 'node:zlib';

/** zlib data that inflates to `n` zero bytes, written with the fixed Huffman codes (13 bits per 258). */
export function zlibZeros(n: number): Uint8Array {
  const out: number[] = [0x78, 0x01];
  let acc = 0;
  let bits = 0;
  const bit = (b: number) => {
    acc |= b << bits;
    if (++bits === 8) {
      out.push(acc);
      acc = 0;
      bits = 0;
    }
  };
  const code = (c: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bit((c >> i) & 1);
  };
  bit(1);
  bit(1);
  bit(0);
  code(0x30, 8);
  let left = n - 1;
  for (; left >= 258; left -= 258) {
    code(0xc5, 8);
    code(0, 5);
  }
  for (; left > 0; left--) code(0x30, 8);
  code(0, 7);
  if (bits > 0) out.push(acc);
  const adler = (((n % 65521) << 16) | 1) >>> 0;
  out.push(adler >>> 24, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255);
  return Uint8Array.from(out);
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type: string, data: Uint8Array): Buffer {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([Buffer.from(u32(data.length)), td, Buffer.from(u32(crc32(td)))]);
}
/** An 8-bit RGBA PNG of zeros declaring w × h, with `data` as its image data. */
export function png(w: number, h: number, data: Uint8Array): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', Uint8Array.from([...u32(w), ...u32(h), 8, 6, 0, 0, 0])),
      chunk('IDAT', data),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}
/** An honest PNG of zeros: its data inflates to exactly what w × h holds. */
export const honest = (w: number, h: number) => png(w, h, zlibZeros(h * (1 + 4 * w)));
/** A lying PNG: a few hundred bytes declaring w × h. */
export const lying = (w: number, h: number) => png(w, h, zlibZeros(64 * 1024));

/** Past the side cap (20,000 pixels wide), honest: its data holds that size. */
export const PAST = honest(20_000, 1000);
/** Within the caps by its header (8,000 × 8,000), but a few hundred bytes. */
export const LIE = lying(8000, 8000);
/** Past the caps by its header, and a few hundred bytes. */
export const LIE_PAST = lying(100_000, 100_000);
