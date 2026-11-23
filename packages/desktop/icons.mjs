// The app icon, built from its one source, packages/editor/public/mochi-maker.svg (drawn by hand
// for the project): PNGs at each size, the Windows .ico and the macOS .icns, into icons/.
//
// The SVG is rasterized here, by a small rasterizer that reads only what that file holds: one
// `rect` with `rx`, and `path`s made of absolute M, L, C and Z, each with a `fill`, in a 1024
// viewBox. Anything else is refused, so the file cannot grow past what is drawn. Coverage is
// sampled 4 × 4 per pixel; the PNGs are encoded with fast-png (already a dependency).
//
//   node icons.mjs        writes icons/ and prints what it wrote
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encode } from 'fast-png';

const here = fileURLToPath(new URL('.', import.meta.url));
export const ICON_SOURCE = `${here}../editor/public/mochi-maker.svg`;
export const ICON_DIR = `${here}icons`;
const VIEW = 1024;

// ---------------------------------------------------------------- the SVG, as shapes

const attrs = (tag) =>
  Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

const K = 0.5522847498; // a quarter circle as a cubic

/** The shapes of the source: each a fill color and a list of closed polygons (flattened). */
export function readShapes(svg) {
  const body = svg.replace(/<!--[\s\S]*?-->/g, '');
  const root = body.match(/<svg\b[^>]*>/)?.[0];
  if (!root || attrs(root).viewBox !== `0 0 ${VIEW} ${VIEW}`)
    throw new Error(`The icon must be an <svg> with viewBox="0 0 ${VIEW} ${VIEW}".`);
  const shapes = [];
  for (const [tag, name] of body.matchAll(/<([a-z]+)\b[^>]*\/?>/g)) {
    if (name === 'svg') continue;
    const a = attrs(tag);
    if (!/^#[0-9a-f]{6}$/i.test(a.fill ?? ''))
      throw new Error(`<${name}> needs a fill of the form #rrggbb.`);
    let d;
    if (name === 'rect') {
      const [x, y, w, h, r] = ['x', 'y', 'width', 'height', 'rx'].map((k) => Number(a[k] ?? 0));
      const c = r * K;
      d =
        `M ${x + r} ${y} L ${x + w - r} ${y} C ${x + w - r + c} ${y} ${x + w} ${y + r - c} ${x + w} ${y + r} ` +
        `L ${x + w} ${y + h - r} C ${x + w} ${y + h - r + c} ${x + w - r + c} ${y + h} ${x + w - r} ${y + h} ` +
        `L ${x + r} ${y + h} C ${x + r - c} ${y + h} ${x} ${y + h - r + c} ${x} ${y + h - r} ` +
        `L ${x} ${y + r} C ${x} ${y + r - c} ${x + r - c} ${y} ${x + r} ${y} Z`;
    } else if (name === 'path') d = a.d;
    else throw new Error(`The icon may hold only <rect> and <path>, not <${name}>.`);
    shapes.push({ fill: a.fill, polygons: flatten(d) });
  }
  if (shapes.length === 0) throw new Error('The icon draws nothing.');
  return shapes;
}

function flatten(d) {
  const tokens = d.trim().split(/[\s,]+/);
  const polygons = [];
  let poly = null;
  let x = 0;
  let y = 0;
  for (let i = 0; i < tokens.length;) {
    const cmd = tokens[i++];
    const num = () => {
      const v = Number(tokens[i++]);
      if (!Number.isFinite(v)) throw new Error(`A path number is missing after ${cmd}.`);
      return v;
    };
    if (cmd === 'M') {
      poly = [[(x = num()), (y = num())]];
      polygons.push(poly);
    } else if (cmd === 'L') poly.push([(x = num()), (y = num())]);
    else if (cmd === 'C') {
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
      for (let k = 1; k <= 32; k++) {
        const t = k / 32;
        const u = 1 - t;
        poly.push([
          u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      x = x3;
      y = y3;
    } else if (cmd === 'Z') poly = null;
    else throw new Error(`The icon's paths may use M, L, C and Z only, not ${cmd}.`);
  }
  return polygons;
}

// ---------------------------------------------------------------- rasterizing

/** The icon at `size` × `size` pixels, straight-alpha RGBA. */
export function rasterize(shapes, size) {
  const S = 4; // samples per pixel, on each axis
  const scale = size / VIEW;
  const out = new Float64Array(size * size * 4); // premultiplied, 0..1
  for (const { fill, polygons } of shapes) {
    const rgb = [1, 3, 5].map((k) => parseInt(fill.slice(k, k + 2), 16) / 255);
    const cover = new Float64Array(size * size);
    const edges = polygons.flatMap((p) =>
      p
        .map((a, k) => [a, p[(k + 1) % p.length]])
        .map(([a, b]) => [a[0] * scale, a[1] * scale, b[0] * scale, b[1] * scale]),
    );
    for (let sy = 0; sy < size * S; sy++) {
      const y = (sy + 0.5) / S;
      const xs = [];
      for (const [x0, y0, x1, y1] of edges)
        if ((y0 <= y && y < y1) || (y1 <= y && y < y0))
          xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      xs.sort((a, b) => a - b);
      const row = Math.floor(sy / S) * size;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k] * S - 0.5));
        const to = Math.min(size * S - 1, Math.floor(xs[k + 1] * S - 0.5));
        for (let sx = from; sx <= to; sx++) cover[row + Math.floor(sx / S)] += 1 / (S * S);
      }
    }
    for (let i = 0; i < size * size; i++) {
      const a = Math.min(1, cover[i]);
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) out[4 * i + c] = rgb[c] * a + out[4 * i + c] * (1 - a);
      out[4 * i + 3] = a + out[4 * i + 3] * (1 - a);
    }
  }
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = out[4 * i + 3];
    for (let c = 0; c < 3; c++) rgba[4 * i + c] = a ? Math.round((out[4 * i + c] / a) * 255) : 0;
    rgba[4 * i + 3] = Math.round(a * 255);
  }
  return rgba;
}

const png = (shapes, size) =>
  encode({ width: size, height: size, data: rasterize(shapes, size), depth: 8, channels: 4 });

// ---------------------------------------------------------------- containers

/** A Windows .ico of PNG images (read by Windows Vista and later). */
export function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, k) => {
    const e = 6 + 16 * k;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => Buffer.from(i.data))]);
}

/** A macOS .icns of PNG images, by their icon types. */
export function icns(entries) {
  const parts = entries.map(([type, data]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'latin1');
    h.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([h, Buffer.from(data)]);
  });
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'latin1');
  h.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([h, ...parts]);
}

// ---------------------------------------------------------------- the build

/** Writes icons/: icon-<size>.png, mochi-maker.ico, mochi-maker.icns. Returns their hashes. */
export async function buildIcons(dir = ICON_DIR) {
  const shapes = readShapes(await readFile(ICON_SOURCE, 'utf8'));
  await mkdir(dir, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngs = new Map(sizes.map((s) => [s, png(shapes, s)]));
  const files = {};
  for (const [s, data] of pngs) files[`icon-${s}.png`] = data;
  files['mochi-maker.ico'] = ico(
    [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: pngs.get(size) })),
  );
  files['mochi-maker.icns'] = icns([
    ['ic11', pngs.get(32)],
    ['ic12', pngs.get(64)],
    ['ic07', pngs.get(128)],
    ['ic13', pngs.get(256)],
    ['ic08', pngs.get(256)],
    ['ic14', pngs.get(512)],
    ['ic09', pngs.get(512)],
    ['ic10', pngs.get(1024)],
  ]);
  const hashes = {};
  for (const [name, data] of Object.entries(files)) {
    await writeFile(`${dir}/${name}`, data);
    hashes[name] = createHash('sha256').update(data).digest('hex');
  }
  return hashes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hashes = await buildIcons();
  for (const [name, h] of Object.entries(hashes)) console.log(`${name}  ${h.slice(0, 16)}`);
}
