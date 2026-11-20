/**
 * The deform path in the viewport: drawn with the P tool over a selected ArtMesh,
 * dragging its points reshapes the keyform at the pose; in the animation view at levels 2 and 3
 * the same drag poses the parameter that moves the mesh and keys it. Headless Chromium through
 * Playwright; skipped where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { buildEditor, launch, openGolden, serve, type Browser, type Page } from './harness.js';

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

const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 30_000 });

async function page(): Promise<Page> {
  const p = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  (p as unknown as { errors: string[] }).errors = errors;
  await p.goto(`${url}?nohome`);
  await p.waitForFunction(() => window.mochi !== undefined);
  await openGolden(p, 'golden-1-keyforms');
  await p.evaluate(() => window.mochi.settled());
  return p;
}
const errorsOf = (p: Page) => (p as unknown as { errors: string[] }).errors;
/** Page coordinates of a canvas point. */
const client = (p: Page, x: number, y: number) =>
  p.evaluate(
    ([x, y]) => {
      const vp = window.mochiEditor.viewport;
      const r = vp.overlay.getBoundingClientRect();
      const [lx, ly] = vp.canvasToLocal(x!, y!);
      return [r.left + lx, r.top + ly] as [number, number];
    },
    [x, y],
  );
type Mesh = { uid: string; rig: { keyforms: { positions: [number, number][] }[] } };
const positions = (p: Page, i = 0) =>
  p.evaluate(
    (i) => (window.mochi.get('@mesh:ArtMesh_Square') as Mesh).rig.keyforms[i]!.positions,
    i,
  );
const dragCanvas = async (p: Page, from: [number, number], to: [number, number]) => {
  const a = await client(p, ...from);
  const b = await client(p, ...to);
  await p.mouse.move(...a);
  await p.mouse.down();
  for (let k = 1; k <= 6; k++)
    await p.mouse.move(a[0] + ((b[0] - a[0]) * k) / 6, a[1] + ((b[1] - a[1]) * k) / 6);
  await p.mouse.up();
};

describe('deform path', () => {
  it('reshapes a keyform from a path drawn over the mesh', async () => {
    if (!browser) return;
    const p = await page();
    const mesh = await p.evaluate(() => (window.mochi.get('@mesh:ArtMesh_Square') as Mesh).uid);
    await p.evaluate((u) => window.mochi.select(u), mesh);
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('p');
    expect(await p.evaluate(() => window.mochiEditor.viewport.tool)).toBe('path');
    // Along the square's top edge, (50, 50) to (150, 50), then Enter.
    for (const [x, y] of [
      [50, 50],
      [150, 50],
    ] as const)
      await p.mouse.click(...(await client(p, x, y)));
    await p.keyboard.press('Enter');
    expect(await p.evaluate(() => window.mochiEditor.viewport.paths.length)).toBe(1);
    // Saved in the project, as a helper the export leaves out.
    const saved = () =>
      p.evaluate(
        () =>
          (window.mochi.get('project') as { deformPaths: { points: number[][] }[] }).deformPaths,
      );
    expect((await saved())[0]!.points).toHaveLength(2);
    await poll(() => p.getByTestId('path-state').textContent()).toContain('1 path(s)');
    const before = await positions(p);
    // Drag the path's end down 30 px: the top-right corner follows it, the top-left stays, and
    // the bottom corners, 100 px away (reach 60), stay.
    await dragCanvas(p, [150, 50], [150, 80]);
    await p.evaluate(() => window.mochi.settled());
    const after = await positions(p);
    // Clicks land on whole screen pixels, so the path is within a pixel of the corners.
    const near = (q: [number, number], x: number, y: number) => {
      expect(q[0]).toBeCloseTo(x, 0);
      expect(q[1]).toBeCloseTo(y, 0);
    };
    near(after[0]!, 50, 50);
    near(after[1]!, 150, 80);
    expect(after[2]).toEqual(before[2]);
    expect(after[3]).toEqual(before[3]);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Deform path');
    // The path moved with the drag, in the same step.
    expect((await saved())[0]!.points[1]![1]).toBeCloseTo(80, 0);
    await p.keyboard.press('Control+Z');
    await p.evaluate(() => window.mochi.settled());
    expect(await positions(p)).toEqual(before);
    expect((await saved())[0]!.points[1]![1]).toBeCloseTo(50, 0);
    // Paths belong to their level: none shows at level 3.
    await p.evaluate(() => window.mochiEditor.editor.setLevel(3));
    expect(await p.evaluate(() => window.mochiEditor.viewport.visiblePaths().length)).toBe(0);
    // Esc cancels a path being drawn.
    await p.mouse.click(...(await client(p, 60, 60)));
    expect(await p.evaluate(() => window.mochiEditor.viewport.drawingPath !== null)).toBe(true);
    await p.keyboard.press('Escape');
    expect(await p.evaluate(() => window.mochiEditor.viewport.drawingPath)).toBe(null);
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('records: in the animation view the drag keys the parameter that moves the mesh', async () => {
    if (!browser) return;
    const p = await page();
    await p.evaluate(() =>
      window.mochi.transact('Motion', (tx) =>
        tx.run('motion.create', { name: 'rec', duration: 2, fps: 30 }),
      ),
    );
    await p.getByTestId('workspace-switcher').selectOption('animation');
    await p.locator('[data-motion="rec"]').click();
    const mesh = await p.evaluate(() => (window.mochi.get('@mesh:ArtMesh_Square') as Mesh).uid);
    await p.evaluate((u) => {
      window.mochi.select(u);
      window.mochiEditor.viewport.pathReach = 1000;
    }, mesh);
    await p.evaluate(() => window.mochiEditor.playback.seek(1));
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('p');
    // A one-point path at the square's centre, dragged 20 px right: ParamA moves it 40 px per 1.
    await p.mouse.click(...(await client(p, 100, 100)));
    await p.keyboard.press('Enter');
    const forms = await positions(p);
    await dragCanvas(p, [100, 100], [120, 100]);
    await poll(() => p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Key from drag');
    const m = (await p.evaluate(() => window.mochi.get('@motion~rec'))) as {
      curves: { segments: number[] }[];
    };
    expect(m.curves).toHaveLength(1);
    expect(m.curves[0]!.segments[0]).toBeCloseTo(1, 6);
    expect(m.curves[0]!.segments[1]).toBeCloseTo(0.5, 1);
    // The forms are untouched.
    expect(await positions(p)).toEqual(forms);
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);
});
