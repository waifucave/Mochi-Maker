/**
 * The Bézier control layer of warps in the viewport: at edit level 2 a selected warp
 * shows its control net, and dragging a control point bends the grid smoothly; at level 1 the
 * grid's points move one by one. Headless Chromium through Playwright; skipped where Chromium is
 * missing, except in CI's render job.
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

type Warp = { uid: string; rig: { keyforms: { grid: [number, number][] }[] } };
const grid = (p: Page) =>
  p.evaluate(() => (window.mochi.get('@warp:Warp_Body') as Warp).rig.keyforms[0]!.grid);
const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 30_000 });
const drag = async (p: Page, from: [number, number], to: [number, number]) => {
  await p.mouse.move(from[0], from[1]);
  await p.mouse.down();
  await p.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await p.mouse.move(to[0], to[1], { steps: 4 });
  await p.mouse.up();
};

describe('warp Bézier control layer', () => {
  it('bends the grid from a control point at level 2, and moves single points at level 1', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-2-deformers');
    await p.evaluate(() => window.mochi.settled());
    const uid = await p.evaluate(() => (window.mochi.get('@warp:Warp_Body') as Warp).uid);
    await p.evaluate((u) => {
      window.mochi.select(u);
      window.mochiEditor.editor.setLevel(2);
    }, uid);
    // One Bézier division each way: the net is the four corners and their eight handles.
    for (const id of ['bezier-cols', 'bezier-rows']) {
      await p.getByTestId(id).fill('1');
      await p.getByTestId(id).dispatchEvent('change');
    }
    const net = () =>
      p.evaluate((u) => {
        const vp = window.mochiEditor.viewport;
        const r = vp.overlay.getBoundingClientRect();
        const w = window.mochi.get(u) as never;
        return vp.bezierScreen(w)!.map(([x, y]) => [r.left + x, r.top + y] as [number, number]);
      }, uid);
    expect(await net()).toHaveLength(4 + 8);
    const before = await grid(p);
    const corner = (await net())[0]!;
    await drag(p, corner, [corner[0] + 30, corner[1] + 20]);
    await p.evaluate(() => window.mochi.settled());
    const after = await grid(p);
    const moved = before.map((b, i): [number, number] => [
      after[i]![0] - b[0],
      after[i]![1] - b[1],
    ]);
    const d = moved[0]!;
    expect(Math.hypot(d[0], d[1])).toBeGreaterThan(5);
    // The corner fully, the points between it and the next corners by half, the centre by a quarter.
    for (const [i, f] of [
      [1, 0.5],
      [3, 0.5],
      [4, 0.25],
      [2, 0],
      [8, 0],
    ] as const) {
      expect(moved[i]![0]).toBeCloseTo(d[0] * f, 3);
      expect(moved[i]![1]).toBeCloseTo(d[1] * f, 3);
    }
    // Level 1: no net; a grid point moves alone.
    await p.evaluate(() => window.mochiEditor.editor.setLevel(1));
    const pts = await p.evaluate((u) => {
      const vp = window.mochiEditor.viewport;
      const r = vp.overlay.getBoundingClientRect();
      return vp.deformerHandles(u)!.map(([x, y]) => [r.left + x, r.top + y] as [number, number]);
    }, uid);
    const g1 = await grid(p);
    await drag(p, pts[4]!, [pts[4]![0] + 15, pts[4]![1]]);
    await p.evaluate(() => window.mochi.settled());
    const g2 = await grid(p);
    const changed = g2.map((q, i) => q[0] !== g1[i]![0] || q[1] !== g1[i]![1]);
    expect(changed).toEqual([false, false, false, false, true, false, false, false, false]);
    // Undo takes back the level-1 move; the document holds only the grid.
    await p.keyboard.press('Control+Z');
    await p.evaluate(() => window.mochi.settled());
    expect(await grid(p)).toEqual(g1);
    expect(
      Object.keys((await p.evaluate(() => window.mochi.get('@warp:Warp_Body'))) as object),
    ).not.toContain('bezier');
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('generates the four-corner forms with Ctrl+4', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-16-writer-edges');
    await p.evaluate(() => window.mochi.settled());
    type Mesh = {
      uid: string;
      rig: { keyforms: { positions: [number, number][]; opacity: number }[] };
    };
    // Spoil a corner (ParamX 1, ParamY 1: cell 5), then generate it from the edges.
    await p.evaluate(() =>
      window.mochi.transact('spoil', (tx) =>
        tx.run('keyform.set', {
          target: '@mesh:ArtMesh_Grid',
          cell: { '@param:ParamX': 1, '@param:ParamY': 1 },
          values: { opacity: 0.1 },
        }),
      ),
    );
    const uid = await p.evaluate(() => (window.mochi.get('@mesh:ArtMesh_Grid') as Mesh).uid);
    await p.evaluate((u) => window.mochi.select(u), uid);
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+4');
    await poll(() => p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe(
      'Four-corner forms',
    );
    const k = await p.evaluate(() => (window.mochi.get('@mesh:ArtMesh_Grid') as Mesh).rig.keyforms);
    // The edges move it 30 px per X and 40 px per Y, widen it 10 px and fade it 0.3: so does the corner.
    expect(k[5]!.opacity).toBeCloseTo(0.7, 5);
    expect(k[5]!.positions[0]![0]).toBeCloseTo(50, 4);
    expect(k[5]!.positions[0]![1]).toBeCloseTo(60, 4);
    expect(k[5]!.positions[1]![0]).toBeCloseTo(100, 4);
    await p.close();
  }, 120_000);
});
