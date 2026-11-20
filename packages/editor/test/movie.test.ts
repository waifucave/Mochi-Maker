/**
 * Exporting images and video: PNG frames with transparency, the work area with physics
 * from the motion's start, WebM with an alpha channel (decoded again by the browser), MP4 where
 * there is an H.264 encoder, the dialog's download and Cancel, and `window.mochi.exportMovie`.
 * Headless Chromium through Playwright; skipped where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { buildEditor, launch, openGolden, serve, type Browser, type Page } from './harness.js';
import { readElements } from '../src/webm.js';

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

const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 60_000 });

/** Golden 11 (physics: ParamIn swings ParamOut) with a motion «swing» that moves ParamIn. */
async function open(): Promise<Page & { errors: string[] }> {
  const p = (await browser!.newPage({ viewport: { width: 1400, height: 900 } })) as Page & {
    errors: string[];
  };
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  await p.goto(`${url}?nohome`);
  await p.waitForFunction(() => window.mochi !== undefined);
  await openGolden(p, 'golden-11-animation');
  await p.evaluate(() => window.mochi.settled());
  await p.evaluate(() =>
    window.mochiEditor.editor.transact('Swing', [
      { name: 'motion.create', args: { name: 'swing', duration: 1, fps: 30 } },
      {
        name: 'motion.setCurve',
        args: {
          target: '@motion~swing',
          curve: {
            target: 'parameter',
            object: '@param:ParamIn',
            segments: [0, -10, 0, 0.5, 10, 0, 1, -10],
          },
        },
      },
    ]),
  );
  return p;
}

/** Renders in the page; returns the file names, and the bytes of the named files as base64. */
const render = (p: Page, s: Record<string, unknown>, keep: string[] | 'all' = []) =>
  p.evaluate(
    async ({ s, keep }) => {
      const r = await window.mochiEditor.movie.render({
        motion: '@motion~swing',
        format: 'png',
        width: 128,
        height: 128,
        fps: 30,
        background: null,
        range: 'scene',
        ...s,
      } as never);
      const b64 = (b: Uint8Array) => {
        let t = '';
        for (const x of b) t += String.fromCharCode(x);
        return btoa(t);
      };
      return {
        ...r,
        names: [...r.files.keys()],
        files: Object.fromEntries(
          [...r.files]
            .filter(([n]) => keep === 'all' || keep.includes(n))
            .map(([n, b]) => [n, b64(b)]),
        ),
      };
    },
    { s, keep },
  );

/** Decodes a video in the page and samples a frame: the alpha at a corner, opaque pixels, a color. */
const decode = (p: Page, b64: string, type: string, time: number) =>
  p.evaluate(
    async ({ b64, type, time }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(new Blob([bytes], { type }));
      await new Promise((ok, fail) => {
        v.onloadeddata = ok;
        v.onerror = () => fail(new Error(`cannot decode: ${v.error?.message}`));
      });
      // Chromium can fire «seeked», with readyState 4, before the frame reaches the element:
      // drawn then, the frame comes out empty (2 decodes in 60 under load). Wait until
      // the seeked frame is presented.
      const presented = new Promise<void>((ok, fail) => {
        v.requestVideoFrameCallback(() => ok());
        setTimeout(() => fail(new Error('the seeked frame was never presented')), 10_000);
      });
      v.currentTime = time;
      await new Promise((ok) => (v.onseeked = ok));
      await presented;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = c.getContext('2d')!;
      g.drawImage(v, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 200) opaque++;
      return {
        width: v.videoWidth,
        height: v.videoHeight,
        duration: v.duration,
        corner: [d[0], d[1], d[2], d[3]],
        opaque,
        pixels: c.width * c.height,
      };
    },
    { b64, type, time },
  );

describe('image and video export', () => {
  it('renders PNG frames, and the work area as the same frames as the whole scene', async () => {
    if (!browser) return;
    const p = await open();
    const all = await render(p, {}, 'all');
    // 1 s at 30 fps, not looping: frames 0 to 30.
    expect(all.frames).toBe(31);
    expect(all.names[0]).toBe('swing_0000.png');
    expect(all.names.at(-1)).toBe('swing_0030.png');
    const png = Buffer.from(all.files['swing_0010.png']!, 'base64');
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(128);
    // The swing moves the model: frames differ.
    expect(all.files['swing_0000.png']).not.toBe(all.files['swing_0015.png']);
    // The work area: frames 15 to 24, byte for byte the frames of the whole scene, since physics
    // runs from the motion's start either way.
    await p.evaluate(() =>
      window.mochiEditor.editor.transact('Work area', [
        {
          name: 'motion.update',
          args: { target: '@motion~swing', workArea: { start: 0.5, end: 0.8 } },
        },
      ]),
    );
    const wa = await render(p, { range: 'workArea' }, 'all');
    expect([wa.first, wa.frames]).toEqual([15, 10]);
    expect(wa.names[0]).toBe('swing_0015.png');
    for (const n of wa.names) expect(wa.files[n], n).toBe(all.files[n]);
    // A looping motion leaves out its last instant (its first again).
    await p.evaluate(() =>
      window.mochiEditor.editor.transact('Loop', [
        { name: 'motion.update', args: { target: '@motion~swing', loop: true } },
      ]),
    );
    expect((await render(p, { fps: 10 })).frames).toBe(10);
    // The agent surface gives the same, with defaults for what it leaves out.
    const viaAgent = await p.evaluate(async () => {
      const r = await window.mochi.exportMovie({ motion: '@motion~swing', fps: 10, width: 64 });
      return { frames: r.frames, format: r.format, width: r.width, height: r.height };
    });
    // Golden 11's canvas is 200 pixels square: the default height.
    expect(viaAgent).toEqual({ frames: 10, format: 'png', width: 64, height: 200 });
    expect(p.errors).toEqual([]);
    await p.close();
  }, 180_000);

  it('encodes WebM with an alpha channel the browser decodes, and MP4 where it can', async () => {
    if (!browser) return;
    const p = await open();
    const r = await render(p, { format: 'webm', width: 127, height: 96 }, ['swing.webm']);
    // Video sizes are even.
    expect([r.width, r.height, r.alpha, r.codec?.slice(0, 4)]).toEqual([128, 96, true, 'vp09']);
    const bytes = Buffer.from(r.files['swing.webm']!, 'base64');
    // The WebM itself: AlphaMode on the track, BlockAdditions with the alpha on each frame.
    const els = readElements(bytes);
    const [ebml] = els[0]!;
    const [segId, seg] = els[1]!;
    expect([ebml, segId]).toEqual([0x1a45dfa3, 0x18538067]);
    const top = readElements(seg!);
    const tracks = top.find(([id]) => id === 0x1654ae6b)![1];
    expect(Buffer.from(tracks).includes(Buffer.from([0x53, 0xc0, 0x81, 0x01]))).toBe(true);
    const clusters = top.filter(([id]) => id === 0x1f43b675);
    const groups = clusters.flatMap(([, c]) => readElements(c).filter(([id]) => id === 0xa0));
    expect(groups).toHaveLength(31);
    // Decoded by Chromium: transparent at the corner, opaque on the model.
    const d = await decode(p, r.files['swing.webm']!, 'video/webm', 0.5);
    expect([d.width, d.height]).toEqual([128, 96]);
    expect(d.duration).toBeCloseTo(31 / 30, 1);
    expect(d.corner[3]).toBeLessThan(10);
    expect(d.opaque).toBeGreaterThan(20);
    // With a background, no alpha stream: SimpleBlocks.
    const solid = await render(p, { format: 'webm', background: '#336699' }, ['swing.webm']);
    expect(solid.alpha).toBe(false);
    const sd = await decode(p, solid.files['swing.webm']!, 'video/webm', 0.2);
    expect(sd.corner[3]).toBe(255);
    expect(Math.abs(sd.corner[2]! - 0x99)).toBeLessThan(12);
    // MP4 where the platform has an H.264 encoder.
    const support = await p.evaluate(() => window.mochiEditor.movie.support());
    if (support.mp4) {
      const mp4 = await render(p, { format: 'mp4', background: '#336699' }, ['swing.mp4']);
      const md = await decode(p, mp4.files['swing.mp4']!, 'video/mp4', 0.2);
      expect([md.width, md.height]).toEqual([128, 128]);
      expect(md.corner[3]).toBe(255);
      expect(Math.abs(md.corner[2]! - 0x99)).toBeLessThan(12);
      // No transparency in MP4.
      await expect(render(p, { format: 'mp4', background: null })).rejects.toThrow(/background/);
    }
    expect(p.errors).toEqual([]);
    await p.close();
  }, 180_000);

  it('exports from the dialog (Ctrl+I) as a zip, and Cancel stops a long export', async () => {
    if (!browser) return;
    const p = await open();
    await p.keyboard.press('Control+I');
    await p.getByTestId('movie-dialog').waitFor();
    await p.getByTestId('movie-width').fill('64');
    await p.getByTestId('movie-height').fill('64');
    await p.getByTestId('movie-fps').fill('10');
    await p.getByTestId('movie-fps').dispatchEvent('change');
    expect(await p.getByTestId('movie-info').textContent()).toMatch(/^11 frames \(0–10\)/);
    // No work area yet: only the scene.
    expect(
      await p
        .locator('[data-testid="movie-range"] option[value="workArea"]')
        .evaluate((o) => [(o as HTMLOptionElement).disabled, o.outerHTML]),
    ).toEqual([true, expect.any(String)]);
    const [download] = await Promise.all([
      p.waitForEvent('download'),
      p.getByTestId('movie-export').click(),
    ]);
    expect(download.suggestedFilename()).toBe('swing.zip');
    const zip = unzipSync(new Uint8Array(await readFile((await download.path())!)));
    expect(Object.keys(zip)).toHaveLength(11);
    expect(Object.keys(zip)[0]).toBe('swing/swing_0000.png');
    await p.getByTestId('movie-dialog').waitFor({ state: 'detached' });
    // A long export (120 fps, 512 pixels), cancelled once it has started.
    await p.keyboard.press('Control+Shift+M');
    await p.getByTestId('movie-dialog').waitFor();
    await p.getByTestId('movie-width').fill('512');
    await p.getByTestId('movie-height').fill('512');
    await p.getByTestId('movie-fps').fill('120');
    await p.getByTestId('movie-export').click();
    await poll(() =>
      p.getByTestId('movie-progress').evaluate((e) => (e as HTMLProgressElement).value),
    ).toBeGreaterThan(0);
    await p.getByTestId('movie-cancel').click();
    await poll(() => p.getByTestId('movie-status').textContent()).toBe('Cancelled.');
    // The dialog stays, ready again.
    expect(await p.getByTestId('movie-export').isDisabled()).toBe(false);
    expect(p.errors).toEqual([]);
    await p.close();
  }, 180_000);
});
