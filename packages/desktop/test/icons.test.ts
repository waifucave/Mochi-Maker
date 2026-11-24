/**
 * The app icon: one hand-written SVG (packages/editor/public/mochi-maker.svg) and what the build
 * makes from it (icons.mjs): PNGs, the Windows .ico and the macOS .icns. The smoke test checks
 * the packaged app's icon on each system.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decode } from 'fast-png';
import { ICON_SOURCE, buildIcons, rasterize, readShapes } from '../icons.mjs';

/**
 * The limit for the tests here that rasterize the icon at every size, twice: the longest took 1.2
 * s on two busy cores.
 */
const WORK = 30_000;

const ROOT = join(import.meta.dirname, '../../..');
const svg = readFileSync(ICON_SOURCE, 'utf8');

describe('the app icon', () => {
  it('is one SVG of a green rounded square and a white dome, and nothing else', () => {
    const shapes = readShapes(svg);
    expect(shapes.map((s: { fill: string }) => s.fill)).toEqual(['#3f9b5a', '#ffffff']);
    expect(svg).not.toMatch(/<(text|image|use|font|style|linearGradient|filter)\b|href=/);
    // The rasterizer refuses what the file does not hold.
    expect(() => readShapes(svg.replace('<rect', '<circle cx="1" '))).toThrow(
      /only <rect> and <path>/,
    );
    expect(() => readShapes(svg.replace(' Z"', ' Q 1 1 2 2 Z"'))).toThrow(/M, L, C and Z only/);
  });

  it('draws the mochi white in the middle of green, with transparent corners', () => {
    const px = rasterize(readShapes(svg), 64);
    const at = (x: number, y: number) =>
      Array.from(px.slice(4 * (y * 64 + x), 4 * (y * 64 + x) + 4));
    expect(at(32, 34)).toEqual([255, 255, 255, 255]); // the mochi
    expect(at(32, 10)).toEqual([0x3f, 0x9b, 0x5a, 255]); // the square, above it
    expect(at(0, 0)[3]).toBe(0); // outside the rounded corner
    // Wider than tall: the white spans more columns than rows.
    const white = (x: number, y: number) => at(x, y)[3] === 255 && at(x, y)[0] === 255;
    const cols = [...Array(64).keys()].filter((x) => white(x, 34)).length;
    const rows = [...Array(64).keys()].filter((y) => white(32, y)).length;
    expect(cols).toBeGreaterThan(rows);
  });

  it(
    'builds PNGs, an .ico and an .icns, the same bytes every time',
    { timeout: WORK },
    async () => {
      const a = await buildIcons(mkdtempSync(join(tmpdir(), 'icons-')));
      const dir = mkdtempSync(join(tmpdir(), 'icons-'));
      const b = await buildIcons(dir);
      expect(b).toEqual(a);
      const png = decode(readFileSync(join(dir, 'icon-256.png')));
      expect([png.width, png.height, png.channels]).toEqual([256, 256, 4]);
      // The .ico: seven PNG images, 16 to 256.
      const ico = readFileSync(join(dir, 'mochi-maker.ico'));
      expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 7]);
      const offset = ico.readUInt32LE(6 + 16 * 6 + 12);
      expect(ico.subarray(offset + 1, offset + 4).toString('latin1')).toBe('PNG');
      // The .icns: its length, then the types macOS reads, 16@2x to 512@2x.
      const icns = readFileSync(join(dir, 'mochi-maker.icns'));
      expect(icns.subarray(0, 4).toString('latin1')).toBe('icns');
      expect(icns.readUInt32BE(4)).toBe(icns.length);
      const types: string[] = [];
      for (let o = 8; o < icns.length; o += icns.readUInt32BE(o + 4))
        types.push(icns.subarray(o, o + 4).toString('latin1'));
      expect(types).toEqual(['ic11', 'ic12', 'ic07', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10']);
    },
  );

  it('is the editor’s favicon, and the packager and the window use what the build makes', () => {
    expect(readFileSync(join(ROOT, 'packages/editor/index.html'), 'utf8')).toContain(
      '<link rel="icon" type="image/svg+xml" href="./mochi-maker.svg" />',
    );
    expect(readFileSync(join(ROOT, 'packages/desktop/package.mjs'), 'utf8')).toContain(
      "icon: join(here, 'icons', 'mochi-maker'),",
    );
    expect(readFileSync(join(ROOT, 'packages/desktop/src/main.ts'), 'utf8')).toMatch(
      /icon: WINDOW_ICON,/,
    );
  });
});
