/**
 * Crafted files for the caps on what Mochi Maker reads from others (limits.test.ts runs this).
 * Each case builds its file here, in memory or as sparse files on disk, then reads it with the
 * reader a person's file goes through, in this fresh process, and prints one line of JSON: the
 * error's code and message, and how much the process's peak memory (maximum resident set size)
 * grew while reading. The built packages (dist) are read, so build them first.
 *
 * Usage: node crafted.mjs <case>
 */
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode } from 'fast-png';
import { checkPng, readArt, readOraArt, readPsdArt } from '@mochi-maker/art';
import { loadProject } from '@mochi-maker/core';
import { NodeFileSystem } from '@mochi-maker/core/node';
import { readModelFolder } from '@mochi-maker/api';
import { readTemplate } from '@mochi-maker/export';

const MiB = 2 ** 20;
const GiB = 2 ** 30;

// ---------------------------------------------------------------- bytes

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le16 = (n) => [n & 255, (n >>> 8) & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A raw deflate stream that inflates to `n` zero bytes, written by hand with the fixed Huffman
 * codes: one literal 0, then matches of length 258 at distance 1. 13 bits give 258 bytes, so
 * 1 GiB takes under 7 MiB.
 */
function deflateZeros(n) {
  const out = [];
  let acc = 0;
  let bits = 0;
  const bit = (b) => {
    acc |= b << bits;
    if (++bits === 8) {
      out.push(acc);
      acc = 0;
      bits = 0;
    }
  };
  const code = (c, len) => {
    for (let i = len - 1; i >= 0; i--) bit((c >> i) & 1);
  };
  bit(1); // the last block
  bit(1); // fixed Huffman codes (01, low bit first)
  bit(0);
  code(0x30, 8); // literal 0
  let left = n - 1;
  for (; left >= 258; left -= 258) {
    code(0xc5, 8); // length 258 (symbol 285)
    code(0, 5); // distance 1
  }
  for (; left > 0; left--) code(0x30, 8);
  code(0, 7); // end of block
  if (bits > 0) out.push(acc);
  return Uint8Array.from(out);
}

/** zlib around a raw deflate stream of `n` zeros (its Adler-32 is computed, not inflated). */
function zlibZeros(n) {
  const adler = (((n % 65521) << 16) | 1) >>> 0;
  return concat([Uint8Array.from([0x78, 0x01]), deflateZeros(n), Uint8Array.from(u32(adler))]);
}

// ---------------------------------------------------------------- PNG

function chunk(type, data) {
  const td = concat([Uint8Array.from(ascii(type)), data]);
  return concat([Uint8Array.from(u32(data.length)), td, Uint8Array.from(u32(crc32(td)))]);
}

/** A PNG: 8-bit RGBA of the given size, with the given compressed image data and extra chunks. */
function png(width, height, idat, extra = []) {
  const ihdr = Uint8Array.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  return concat([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** The zlib data of a w × h RGBA image of zeros (rows with their filter bytes). */
const zeroImage = (w, h) => zlibZeros(h * (1 + 4 * w));

// ---------------------------------------------------------------- PSD

/**
 * A PSD of RGB 8-bit, written by hand: `layers` lists each layer's bounds and channels
 * ({ id, compression, data }); the composite image is raw zeros of the canvas size.
 */
function psd(width, height, layers) {
  const records = [];
  const images = [];
  for (const l of layers) {
    const channels = l.channels ?? [-1, 0, 1, 2].map((id) => ({ id, compression: 0 }));
    records.push(
      ...u32(l.top ?? 0),
      ...u32(l.left ?? 0),
      ...u32(l.bottom),
      ...u32(l.right),
      ...u16(channels.length),
    );
    for (const c of channels) {
      records.push(...u16(c.id & 0xffff), ...u32(2 + (c.data?.length ?? 0)));
      images.push(Uint8Array.from(u16(c.compression)), c.data ?? new Uint8Array(0));
    }
    records.push(...ascii('8BIMnorm'), 255, 0, 0, 0);
    records.push(...u32(12), ...u32(0), ...u32(0), 0, 0, 0, 0);
  }
  let info = concat([Uint8Array.from(u16(layers.length)), Uint8Array.from(records), ...images]);
  if (info.length % 2) info = concat([info, new Uint8Array(1)]);
  const layerInfo = concat([Uint8Array.from(u32(info.length)), info]);
  const layerAndMask = concat([layerInfo, Uint8Array.from(u32(0))]);
  return concat([
    Uint8Array.from([...ascii('8BPS'), ...u16(1), 0, 0, 0, 0, 0, 0, ...u16(3)]),
    Uint8Array.from([...u32(height), ...u32(width), ...u16(8), ...u16(3)]),
    Uint8Array.from([...u32(0), ...u32(0), ...u32(layerAndMask.length)]),
    layerAndMask,
    Uint8Array.from(u16(0)),
    new Uint8Array(3 * width * height),
  ]);
}

// ---------------------------------------------------------------- zip

/**
 * A zip written by hand: each entry gives its stored bytes, method (0 stored, 8 deflated), and
 * the CRC-32 and size its records declare (by default those of `plain`).
 */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Uint8Array.from(ascii(e.name));
    const crc = e.crc ?? crc32(e.plain ?? e.data);
    const size = e.size ?? (e.plain ?? e.data).length;
    const common = [
      ...le16(20),
      ...le16(0),
      ...le16(e.method ?? 0),
      ...le16(0),
      ...le16(0x21),
      ...le32(crc),
      ...le32(e.data.length),
      ...le32(size),
      ...le16(name.length),
      ...le16(0),
    ];
    const local = concat([Uint8Array.from([...le32(0x04034b50), ...common]), name, e.data]);
    central.push(
      concat([
        Uint8Array.from([
          ...le32(0x02014b50),
          ...le16(20),
          ...common,
          ...le16(0),
          ...le16(0),
          ...le16(0),
          ...le32(0),
          ...le32(offset),
        ]),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(central);
  const end = Uint8Array.from([
    ...le32(0x06054b50),
    ...le16(0),
    ...le16(0),
    ...le16(entries.length),
    ...le16(entries.length),
    ...le32(cd.length),
    ...le32(offset),
    ...le16(0),
  ]);
  return concat([...locals, cd, end]);
}

const text = (s) => new TextEncoder().encode(s);
const STACK = (src) =>
  `<?xml version="1.0"?><image w="64" h="64"><stack><layer name="A" src="${src}"/></stack></image>`;
/** An OpenRaster file whose one layer is the given zip entry. */
const ora = (layer) =>
  zip([
    { name: 'mimetype', data: text('image/openraster') },
    { name: 'stack.xml', data: text(STACK(layer.name)) },
    layer,
  ]);

// ---------------------------------------------------------------- folders on disk

/** A temporary folder with files: a number is a sparse file of that size, else the bytes. */
const made = [];
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-crafted-'));
  made.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const p = join(dir, path);
    mkdirSync(join(p, '..'), { recursive: true });
    if (typeof content === 'number') {
      writeFileSync(p, '');
      truncateSync(p, content);
    } else writeFileSync(p, content);
  }
  return dir;
}

const fs = new NodeFileSystem();
const MODEL = text(JSON.stringify({ Version: 3, FileReferences: { Moc: 'm.moc3', Textures: [] } }));
const MANIFEST = text(JSON.stringify({ format: 'mochi-maker-project', version: 15, seq: 1 }));

// ---------------------------------------------------------------- the cases

/** Each case: what to build, then how to read it (the build is not measured). */
const CASES = {
  // The meter: fast-png itself on a PNG whose data inflates to 256 MiB takes that and more.
  meter: () => {
    const f = png(64, 64, zlibZeros(256 * MiB));
    return () => void decode(f);
  },
  'png-side': () => {
    const f = png(100_000, 100_000, zeroImage(1, 1));
    return () => checkPng(f, 'side.png');
  },
  'png-pixels': () => {
    const f = png(16_000, 16_000, zeroImage(1, 1));
    return () => checkPng(f, 'pixels.png');
  },
  'png-bomb': () => {
    const f = png(64, 64, zlibZeros(GiB));
    return () => checkPng(f, 'bomb.png');
  },
  'png-profile': () => {
    const profile = chunk('iCCP', concat([text('icc'), Uint8Array.from([0, 0]), zlibZeros(GiB)]));
    const f = png(64, 64, zeroImage(64, 64), [profile]);
    return () => checkPng(f, 'profile.png');
  },
  'psd-ok': () => {
    const raw = new Uint8Array(16).fill(255);
    const channels = [-1, 0, 1, 2].map((id) => ({ id, compression: 0, data: raw }));
    const f = psd(8, 8, [{ bottom: 4, right: 4, channels }]);
    return () => {
      const art = readPsdArt(f, 'ok.psd');
      return { layers: art.layers.length, width: art.width };
    };
  },
  'psd-canvas': () => {
    const f = new Uint8Array(64);
    f.set([
      ...ascii('8BPS'),
      ...u16(1),
      0,
      0,
      0,
      0,
      0,
      0,
      ...u16(3),
      ...u32(30_000),
      ...u32(30_000),
    ]);
    f.set([...u16(8), ...u16(3)], 22);
    return () => readPsdArt(f, 'canvas.psd');
  },
  'psd-layer': () => {
    const f = psd(64, 64, [{ bottom: 20_000, right: 20_000 }]);
    return () => readPsdArt(f, 'layer.psd');
  },
  'psd-layers': () => {
    const f = psd(
      8,
      8,
      Array.from({ length: 2001 }, () => ({ bottom: 1, right: 1 })),
    );
    return () => readPsdArt(f, 'layers.psd');
  },
  'psd-total': () => {
    const f = psd(
      8000,
      4000,
      Array.from({ length: 10 }, () => ({ bottom: 4000, right: 8000 })),
    );
    return () => readPsdArt(f, 'total.psd');
  },
  'psd-zip': () => {
    const raw = new Uint8Array(64 * 64);
    const channels = [
      { id: -1, compression: 0, data: raw },
      { id: 0, compression: 2, data: zlibZeros(GiB) },
      { id: 1, compression: 0, data: raw },
      { id: 2, compression: 0, data: raw },
    ];
    const f = psd(64, 64, [{ bottom: 64, right: 64, channels }]);
    return () => readPsdArt(f, 'zip.psd');
  },
  'ora-entry': () => {
    const f = ora({ name: 'a.png', data: deflateZeros(1024), method: 8, size: GiB, crc: 0 });
    return () => readOraArt(f, 'entry.ora');
  },
  'ora-bomb': () => {
    const f = ora({ name: 'a.png', data: deflateZeros(GiB), method: 8, size: 100, crc: 0 });
    return () => readOraArt(f, 'bomb.ora');
  },
  'ora-entries': () => {
    const f = zip(Array.from({ length: 4001 }, (_, i) => ({ name: `f${i}`, data: text('x') })));
    return () => readOraArt(f, 'entries.ora');
  },
  'ora-layer': () => {
    const layer = png(100_000, 100_000, zeroImage(1, 1));
    const f = ora({ name: 'a.png', data: layer });
    return () => readOraArt(f, 'layer.ora');
  },
  'art-file': () => {
    const dir = folder({ 'big.psd': 600 * MiB });
    return () => readArt({ fs }, join(dir, 'big.psd'));
  },
  'model-file': () => {
    const dir = folder({ 'm.model3.json': MODEL, 'm.moc3': 100, 'texture.png': 100 * MiB });
    return () => readModelFolder(fs, dir);
  },
  'model-total': () => {
    const files = { 'm.model3.json': MODEL };
    for (let i = 0; i < 5; i++) files[`t${i}.png`] = 60 * MiB;
    const dir = folder(files);
    return () => readModelFolder(fs, dir);
  },
  'model-count': () => {
    const files = { 'm.model3.json': MODEL };
    for (let i = 0; i < 2000; i++) files[`f/${i}.txt`] = text('x');
    const dir = folder(files);
    return () => readModelFolder(fs, dir);
  },
  'project-file': () => {
    const dir = folder({ 'mochi-project.json': MANIFEST, 'parts.json': 100 * MiB });
    return () => loadProject(fs, dir);
  },
  'project-total': () => {
    const files = { 'mochi-project.json': MANIFEST };
    for (let i = 0; i < 9; i++) files[`meshes/${i}.json`] = 60 * MiB;
    const dir = folder(files);
    return () => loadProject(fs, dir);
  },
  'template-entry': () => {
    const f = zip([{ name: 'template.json', data: deflateZeros(1024), method: 8, size: GiB }]);
    return () => readTemplate(f);
  },
  'template-bomb': () => {
    const f = zip([
      { name: 'template.json', data: deflateZeros(GiB), method: 8, size: 10, crc: 0 },
    ]);
    return () => readTemplate(f);
  },
};

const name = process.argv[2];
const make = CASES[name];
if (!make) {
  console.error(`No case ${name}; the cases: ${Object.keys(CASES).join(', ')}`);
  process.exit(2);
}
const read = make();
const before = process.resourceUsage().maxRSS;
let out;
try {
  out = { ok: (await read()) ?? null };
} catch (e) {
  out = { code: e.code ?? null, message: e.message };
}
const after = process.resourceUsage().maxRSS;
out.peakMiB = Math.round((after - before) / 1024);
for (const d of made) rmSync(d, { recursive: true, force: true });
console.log(JSON.stringify(out));
