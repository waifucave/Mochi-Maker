/**
 * The brushes and mesh tools in the editor: brush selection (B) with B, C and V + drag for
 * size, angle and hardness; the deform brush (one undo per stroke, no double-click into mesh
 * editing); the add-points brush; splitting into four; mirrored editing; stroke meshing with
 * Shift+E; reset to the imported mesh; markers to events. Headless Chromium through Playwright;
 * skipped where Chromium is missing, except in CI's render job.
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
const MESH = 'mesh_0004';

async function open(): Promise<Page & { errors: string[] }> {
  const p = (await browser!.newPage({ viewport: { width: 1400, height: 900 } })) as Page & {
    errors: string[];
  };
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  await p.goto(`${url}?nohome`);
  await p.waitForFunction(() => window.mochi !== undefined);
  await openGolden(p, 'golden-1-keyforms');
  await p.evaluate(() => window.mochi.settled());
  await p.evaluate((m) => window.mochiEditor.editor.select(m), MESH);
  return p;
}

/** The mesh's vertices on the page (client pixels). */
const verts = (p: Page) =>
  p.evaluate((m) => {
    const vp = window.mochiEditor.viewport;
    const r = vp.overlay.getBoundingClientRect();
    return vp.meshScreen(m)!.map(([x, y]) => [x + r.left, y + r.top] as [number, number]);
  }, MESH);
const run = (p: Page, id: string) => p.evaluate((i) => window.mochiEditor.keymap.run(i), id);
const brush = (p: Page) => p.evaluate(() => ({ ...window.mochiEditor.viewport.brush }));
const positions = (p: Page, i = 0) =>
  p.evaluate(
    ([m, i]) =>
      (
        window.mochi.get(m as string) as { rig: { keyforms: { positions: number[][] }[] } }
      ).rig.keyforms[i as number]!.positions.flat(),
    [MESH, i] as const,
  );
async function drag(p: Page, from: [number, number], to: [number, number], steps = 8) {
  await p.mouse.move(from[0], from[1]);
  await p.mouse.down();
  await p.mouse.move(to[0], to[1], { steps });
  await p.mouse.up();
}

describe('brushes and mesh tools', () => {
  it('selects by painting, and sets the brush with B, C and V + drag', async () => {
    if (!browser) return;
    const p = await open();
    const v = await verts(p);
    // B (tap): brush selection.
    await p.mouse.move(v[0]![0], v[0]![1]);
    await p.keyboard.press('b');
    expect(await p.evaluate(() => window.mochiEditor.viewport.tool)).toBe('brush');
    // B + drag: the size grows by the drag; the tool stays.
    const r0 = (await brush(p)).radius;
    await p.keyboard.down('b');
    await drag(p, [v[0]![0], v[0]![1]], [v[0]![0] + 40, v[0]![1]]);
    await p.keyboard.up('b');
    expect((await brush(p)).radius).toBeCloseTo(r0 + 40, 0);
    expect(await p.evaluate(() => window.mochiEditor.viewport.tool)).toBe('brush');
    // C + drag: the angle; V + drag: the hardness.
    await p.keyboard.down('c');
    await drag(p, [v[0]![0], v[0]![1]], [v[0]![0] + 30, v[0]![1]]);
    await p.keyboard.up('c');
    await p.keyboard.down('v');
    await drag(p, [v[0]![0], v[0]![1]], [v[0]![0] + 40, v[0]![1]]);
    await p.keyboard.up('v');
    const b = await brush(p);
    expect(b.angle).toBeCloseTo(30, 0);
    expect(b.hardness).toBeCloseTo(0.7, 2);
    // A small brush: painting along the top edge selects its two vertices only.
    await p.evaluate(() => (window.mochiEditor.viewport.brush.radius = 12));
    await p.evaluate((m) => window.mochiEditor.editor.enterMeshEdit(), MESH);
    await drag(p, v[0]!, v[1]!, 20);
    await poll(() => p.evaluate(() => window.mochiEditor.editor.selection.vertices)).toEqual([
      0, 1,
    ]);
    // Alt removes.
    await p.keyboard.down('Alt');
    await drag(p, [v[1]![0] - 2, v[1]![1]], [v[1]![0] + 2, v[1]![1]]);
    await p.keyboard.up('Alt');
    await poll(() => p.evaluate(() => window.mochiEditor.editor.selection.vertices)).toEqual([0]);
    expect(p.errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('deforms with the falloff in the keyform, one undo per stroke, without the double-click', async () => {
    if (!browser) return;
    const p = await open();
    await run(p, 'tool.deformBrush');
    await p.evaluate(() =>
      Object.assign(window.mochiEditor.viewport.brush, { radius: 30, hardness: 1 }),
    );
    const before = await positions(p);
    const v = await verts(p);
    const steps = await p.evaluate(() => window.mochi.history().length);
    await drag(p, v[2]!, [v[2]![0] + 20, v[2]![1]]);
    await poll(() => p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Deform brush');
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(steps + 1);
    const after = await positions(p);
    // Vertex 2 moved right (canvas pixels: 20 screen pixels), the others stayed.
    expect(after[4]!).toBeGreaterThan(before[4]! + 5);
    expect([after[0], after[1], after[2], after[3], after[6], after[7]]).toEqual([
      before[0],
      before[1],
      before[2],
      before[3],
      before[6],
      before[7],
    ]);
    // The other keyform is untouched.
    expect(await positions(p, 1)).toEqual([90, 50, 190, 50, 190, 150, 90, 150]);
    // A double-click does not enter mesh editing with the deform brush.
    await p.mouse.dblclick((v[0]![0] + v[2]![0]) / 2, (v[0]![1] + v[2]![1]) / 2);
    expect(await p.evaluate(() => window.mochiEditor.editor.meshEdit)).toBe(null);
    await p.keyboard.press('Control+Z');
    await poll(() => positions(p)).toEqual(before);
    expect(p.errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('splits into four, adds points by brush, edits mirrored, meshes strokes, and resets', async () => {
    if (!browser) return;
    const p = await open();
    await p.evaluate(() => window.mochiEditor.editor.enterMeshEdit());
    const count = () =>
      p.evaluate((m) => (window.mochi.get(m) as { uv: number[][] }).uv.length, MESH);
    await run(p, 'mesh.subdivide');
    // 4 vertices and 5 edges: 9 vertices, 8 triangles.
    await poll(count).toBe(9);
    // The add-points brush: a stroke inside the mesh adds vertices a radius apart.
    await run(p, 'tool.addBrush');
    await p.evaluate(() => (window.mochiEditor.viewport.brush.radius = 8));
    const v = await verts(p);
    const [a, c] = [v[0]!, v[2]!];
    await drag(
      p,
      [a[0] + (c[0] - a[0]) * 0.15, a[1] + (c[1] - a[1]) * 0.3],
      [a[0] + (c[0] - a[0]) * 0.85, a[1] + (c[1] - a[1]) * 0.3],
      30,
    );
    await poll(count).toBeGreaterThan(9);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe(
      'Add vertices (brush)',
    );
    // Mirrored editing: the square spans canvas x 50–150 at rest, so its axis is x = 100.
    await p.evaluate(() => {
      const vp = window.mochiEditor.viewport;
      vp.mirrorEdit = true;
      vp.mirrorAxis = 100;
    });
    await run(p, 'tool.arrow');
    const uv0 = await p.evaluate(
      (m) => (window.mochi.get(m) as { uv: number[][] }).uv.flat(),
      MESH,
    );
    await p.evaluate((m) => window.mochiEditor.editor.select(m, [0]), MESH);
    const w = await verts(p);
    await drag(p, w[0]!, [w[0]![0] + 10, w[0]![1]]);
    await poll(() =>
      p.evaluate((m) => (window.mochi.get(m) as { uv: number[][] }).uv.flat(), MESH),
    ).not.toEqual(uv0);
    const uv1 = await p.evaluate(
      (m) => (window.mochi.get(m) as { uv: number[][] }).uv.flat(),
      MESH,
    );
    // Vertex 0 moved right; its partner, vertex 1, moved left by as much.
    expect(uv1[0]! - uv0[0]!).toBeGreaterThan(1);
    expect(uv1[2]! - uv0[2]!).toBeCloseTo(-(uv1[0]! - uv0[0]!), 3);
    expect(uv1[1]).toBe(uv0[1]);
    // Reset to the imported mesh: regenerated from the layer.
    await run(p, 'mesh.resetImported');
    await poll(() => p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe(
      'Reset to the imported mesh',
    );
    // Stroke meshing: two strokes, then Shift+E.
    await run(p, 'mesh.confirm');
    await run(p, 'tool.stroke');
    await p.evaluate(() => (window.mochiEditor.viewport.brush.radius = 10));
    const s = await verts(p);
    const at = (fx: number, fy: number): [number, number] => [
      s[0]![0] + (s[2]![0] - s[0]![0]) * fx,
      s[0]![1] + (s[2]![1] - s[0]![1]) * fy,
    ];
    await drag(p, at(0.2, 0.2), at(0.8, 0.8), 20);
    await drag(p, at(0.2, 0.8), at(0.5, 0.5), 10);
    expect(await p.evaluate(() => window.mochiEditor.viewport.strokes.length)).toBe(2);
    await p.keyboard.press('Shift+E');
    await poll(() => p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe(
      'Mesh from strokes',
    );
    expect(await p.evaluate(() => window.mochiEditor.viewport.strokes.length)).toBe(0);
    // Two strips: an even number of vertices, two per sample.
    expect((await count()) % 2).toBe(0);
    expect(await p.evaluate(() => window.mochi.validate().violations)).toEqual([]);
    expect(p.errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('writes markers as events from the Timeline (one undo)', async () => {
    if (!browser) return;
    const p = await open();
    await p.evaluate(() =>
      window.mochiEditor.editor.transact('M', [
        { name: 'motion.create', args: { name: 'm', duration: 1 } },
        {
          name: 'motion.setMarkers',
          args: { target: '@motion~m', markers: [{ time: 0.5, name: 'hit' }] },
        },
      ]),
    );
    await p.getByTestId('workspace-switcher').selectOption('animation');
    await p.locator('[data-motion="m"]').click();
    await run(p, 'anim.markersToEvents');
    await poll(() =>
      p.evaluate(() => (window.mochi.get('@motion~m') as { events: unknown[] }).events),
    ).toEqual([{ time: 0.5, value: 'hit' }]);
    expect(await p.locator('[data-lane="Events"] [data-event="hit"]').count()).toBe(1);
    expect(p.errors).toEqual([]);
    await p.close();
  }, 120_000);
});
