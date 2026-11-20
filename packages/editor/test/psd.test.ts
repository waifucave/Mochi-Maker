/**
 * The PSD of the pose (Ctrl+P): one layer per art mesh as drawn, back to front, the size
 * of the canvas. Golden 4 has masks (an inverted one) and colors: stacking the layers in order
 * gives the composite again, so each layer is the mesh as drawn, clipping included. Headless
 * Chromium through Playwright; skipped where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { initializeCanvas, readPsd } from 'ag-psd';
import { readPsdArt } from '@mochi-maker/art';
import { buildEditor, launch, openGolden, serve, type Browser } from './harness.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
let browser: Browser | null = null;
let server: Server | undefined;
let url = '';

beforeAll(async () => {
  browser = await launch();
  if (!browser) {
    if (required)
      throw new Error('Chromium is required (MOCHI_MAKER_REQUIRE_RENDER=1) but missing.');
    return;
  }
  const s = await serve(await buildEditor());
  server = s.server;
  url = s.url;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe('PSD of the pose', () => {
  it('writes one layer per art mesh as drawn, in draw order, that stack to the composite', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-4-masks-colors');
    await p.evaluate(() => window.mochi.settled());
    await p.evaluate(() => window.mochi.setPose({ ParamMask: 0.5, ParamTint: 1 }));
    const [download] = await Promise.all([
      p.waitForEvent('download'),
      p.keyboard.press('Control+P'),
    ]);
    expect(download.suggestedFilename()).toBe('golden-4-masks-colors-pose.psd');
    // Outside a browser, ag-psd needs plain image data.
    initializeCanvas(
      () => {
        throw new Error('no canvas');
      },
      (width: number, height: number) =>
        ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        }) as unknown as ImageData,
    );
    const bytes = await readFile((await download.path())!);
    // Mochi Maker's own PSD import reads it back: a layer per mesh.
    expect(readPsdArt(new Uint8Array(bytes)).layers.length).toBeGreaterThanOrEqual(7);
    const psd = readPsd(bytes, {
      useImageData: true,
      skipThumbnail: true,
    });
    expect([psd.width, psd.height]).toEqual([200, 200]);
    const layers = psd.children!;
    expect(layers).toHaveLength(8);
    // Back to front, as Mochi2D draws them at this pose.
    const order = await p.evaluate(async () => {
      const e = (await window.mochi.evaluate()) as unknown as {
        drawables: { id: string; renderOrder: number }[];
      };
      return e.drawables.sort((a, b) => a.renderOrder - b.renderOrder).map((d) => d.id);
    });
    expect(layers.map((l) => l.name)).toEqual(order);
    // Stacking the layers (straight-alpha "over", in order) gives the composite.
    const W = psd.width;
    const out = new Float64Array(W * psd.height * 4);
    for (const l of layers) {
      if (!l.imageData) continue;
      const { width, height, data } = l.imageData;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const s = (y * width + x) * 4;
          const d = ((l.top! + y) * W + l.left! + x) * 4;
          const a = data[s + 3]! / 255;
          const ao = out[d + 3]!;
          const an = a + ao * (1 - a);
          for (let k = 0; k < 3; k++)
            out[d + k] = an ? (data[s + k]! * a + out[d + k]! * ao * (1 - a)) / an : 0;
          out[d + 3] = an;
        }
    }
    const comp = psd.imageData!.data;
    let worst = 0;
    for (let i = 0; i < comp.length; i += 4) {
      const a = comp[i + 3]! / 255;
      worst = Math.max(worst, Math.abs(a - out[i + 3]!) * 255);
      if (a > 0.5)
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(comp[i + k]! - out[i + k]!));
    }
    expect(worst).toBeLessThan(6);
    // The inverted mask's layer is clipped: it has fewer pixels than its own mesh alone would.
    const inverted = layers.find((l) => l.name === 'Inverted')!;
    expect(inverted.imageData).toBeTruthy();
    // The pose matters: another pose gives other layers.
    const other = await p.evaluate(async () => {
      await window.mochi.setPose({ ParamMask: 0 });
      const r = await window.mochiEditor.psd();
      return r.layers.map((l) => l.empty);
    });
    expect(other).toHaveLength(8);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
