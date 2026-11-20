/**
 * Rotation origins in canvas pixels: the Inspector shows a rotation's origin on the
 * canvas, at its keyform's pose, whatever its parent, and a typed value is mapped back into the
 * parent's space (keyform.moveInCanvas). Here a rotation inside another rotation, on golden 1. Headless Chromium through Playwright; skipped where Chromium is missing,
 * except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
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

const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 30_000 });

describe('rotation origins in canvas pixels', () => {
  it('shows and takes a nested rotation’s origin on the canvas', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-1-keyforms');
    await p.evaluate(() => window.mochi.settled());
    // Rotation_Outer at (300, 300) on the canvas; Rotation_Inner inside it, 20 pixels above its
    // origin (a rotation's children are in pixels around its origin): (300, 280) on the canvas.
    await p.evaluate(() =>
      window.mochiEditor.editor.transact('Rotations', [
        {
          name: 'deformer.createRotation',
          args: { exportId: 'Rotation_Outer', origin: { x: 300, y: 300 } },
        },
        {
          name: 'deformer.createRotation',
          args: { exportId: 'Rotation_Inner', parent: '$0', origin: { x: 0, y: -20 } },
        },
      ]),
    );
    const inner = await p.evaluate(
      () => (window.mochi.get('@rot:Rotation_Inner') as { uid: string }).uid,
    );
    await p.evaluate((u) => window.mochiEditor.editor.select(u), inner);
    const field = (f: string) => p.getByTestId(`kf-${f}`);
    await poll(async () => Number(await field('originX').inputValue())).toBeCloseTo(300, 1);
    expect(Number(await field('originY').inputValue())).toBeCloseTo(280, 1);
    expect(await p.locator('label.field', { has: field('originX') }).textContent()).toContain(
      'canvas',
    );
    // Typed on the canvas: 330 is 30 pixels right of the parent's origin in its own space.
    await field('originX').fill('330');
    await field('originX').press('Enter');
    const local = () =>
      p.evaluate(() => {
        const k = (
          window.mochi.get('@rot:Rotation_Inner') as {
            rig: { keyforms: { originX: number; originY: number }[] };
          }
        ).rig.keyforms[0]!;
        return [k.originX, k.originY];
      });
    await poll(async () => (await local())[0]).toBeCloseTo(30, 2);
    expect((await local())[1]).toBeCloseTo(-20, 2);
    await poll(async () => Number(await field('originX').inputValue())).toBeCloseTo(330, 1);
    // One undoable step.
    await p.evaluate(() => window.mochiEditor.editor.undo());
    await poll(async () => (await local())[0]).toBeCloseTo(0, 4);
    // The parent turned by 90°: the inner origin is still 20 pixels from (300, 300), elsewhere.
    await p.evaluate(() =>
      window.mochiEditor.editor.transact('Turn', [
        { name: 'keyform.set', args: { target: '@rot:Rotation_Outer', values: { angle: 90 } } },
      ]),
    );
    await p.evaluate((u) => window.mochiEditor.editor.select(u), inner);
    const canvas = async () => [
      Number(await field('originX').inputValue()),
      Number(await field('originY').inputValue()),
    ];
    await poll(async () => {
      const [x, y] = await canvas();
      return Math.round(Math.hypot(x! - 300, y! - 300) * 100) / 100;
    }).toBeCloseTo(20, 1);
    const [tx, ty] = await canvas();
    expect(Math.abs(tx! - 300)).toBeGreaterThan(19);
    // Typing it back to (300, 280) gives a local origin turned the other way.
    await field('originX').fill('300');
    await field('originX').press('Enter');
    await poll(async () => Number(await field('originX').inputValue())).toBeCloseTo(300, 1);
    await field('originY').fill('280');
    await field('originY').press('Enter');
    await poll(async () => Number(await field('originY').inputValue())).toBeCloseTo(280, 1);
    const [lx, ly] = await local();
    expect(Math.hypot(lx!, ly!)).toBeCloseTo(20, 1);
    expect(Math.abs(lx!)).toBeGreaterThan(19);
    expect(ty).toBeCloseTo(300, 0);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
