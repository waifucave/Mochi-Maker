/**
 * The physics dialog (M9): authoring through physics commands, a live test with
 * Mochi2D's physics in the View area, observed peaks and the rescale to 100 %. Headless Chromium;
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
const settled = (p: Page) => p.evaluate(() => window.mochi.settled());

const available = await launch().then(async (b) => {
  await b?.close();
  return b !== null;
});

describe.skipIf(!required && !available)('the physics dialog', () => {
  it('edits physics as commands, tests it live, and rescales an output to 100 %', async () => {
    const p = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined, null, { timeout: 60_000 });
    await openGolden(p, 'golden-11-animation');
    await settled(p);
    await p.locator('[data-menu="modeling"]').click();
    await p.getByTestId('menu-model.physics').click();
    await poll(() => p.getByTestId('physics').count()).toBe(1);
    expect(await p.locator('[data-physics="Swing"]').count()).toBe(1);

    // The test runs Mochi2D's physics in the View area: the output swings away from its default.
    const out = () =>
      p.evaluate(() => window.mochiEditor.viewport.model!.getParameter('ParamOut') as number);
    expect(await out()).toBeCloseTo(0, 3);
    await p.getByTestId('physics-test').check();
    const pad = (await p.getByTestId('physics-pad').boundingBox())!;
    await p.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
    await p.mouse.down();
    await p.mouse.move(pad.x + pad.width - 2, pad.y + pad.height / 2, { steps: 8 });
    await poll(async () => Math.abs(await out())).toBeGreaterThan(1e-3);
    await p.mouse.up();
    // The peak is observed, and «100 % ↑» rescales the output so it would reach the range's end.
    await poll(() =>
      p.evaluate(() => {
        const d = window.mochiEditor.physics;
        const v = window.mochiEditor.editor.view;
        const param = v.ofKind('parameter').find((x) => x.exportId === 'ParamOut')!;
        const k = d.peakOf(param);
        return Math.max(k.above, k.below);
      }),
    ).toBeGreaterThan(0.01);
    const scale0 = await p.evaluate(
      () => window.mochiEditor.editor.view.ofKind('physicsSetting')[0]!.outputs[0]!.scale,
    );
    const side = await p.evaluate(() => {
      const v = window.mochiEditor.editor.view;
      const param = v.ofKind('parameter').find((x) => x.exportId === 'ParamOut')!;
      const k = window.mochiEditor.physics.peakOf(param);
      return k.above >= k.below ? 'above' : 'below';
    });
    if (side === 'above') await p.getByTestId('rescale-above-0').click();
    else await p.locator('button', { hasText: '100 % ↓' }).first().click();
    await settled(p);
    const scale1 = await p.evaluate(
      () => window.mochiEditor.editor.view.ofKind('physicsSetting')[0]!.outputs[0]!.scale,
    );
    expect(scale1).not.toBe(scale0);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Rescale output');

    // A new group from presets; without outputs, the dialog says it cannot move anything.
    await p.getByTestId('physics-new-name').fill('Hair');
    await p.getByTestId('physics-new-pendulum').selectOption('Two stages');
    await p.getByTestId('physics-add').click();
    await settled(p);
    expect(
      await p.evaluate(() =>
        window.mochiEditor.editor.view
          .ofKind('physicsSetting')
          .map((s) => [s.name, s.particles.length]),
      ),
    ).toEqual([
      ['Swing', 2],
      ['Hair', 3],
    ]);
    await poll(() => p.getByTestId('physics-problem').first().textContent()).toContain('no inputs');
    // Inputs and outputs through the tables.
    await p.getByTestId('input-add').click();
    await p.getByTestId('output-add').click();
    await settled(p);
    const hair = await p.evaluate(
      () => window.mochiEditor.editor.view.ofKind('physicsSetting')[1]!,
    );
    expect(hair.inputs.length).toBe(1);
    expect(hair.outputs[0]).toMatchObject({ particle: 2, type: 'Angle', weight: 100, scale: 1 });
    await p.getByTestId('output-scale-0').fill('2.5');
    await p.getByTestId('output-scale-0').press('Enter');
    await settled(p);
    expect(
      await p.evaluate(
        () => window.mochiEditor.editor.view.ofKind('physicsSetting')[1]!.outputs[0]!.scale,
      ),
    ).toBe(2.5);
    // Leaving a group out of the test is the view's, not the document's.
    const n = await p.evaluate(() => window.mochi.history().length);
    await p.getByTestId('physics-on-Hair').uncheck();
    await settled(p);
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(n);
    // Every edit was a physics command, undoable.
    const labels = (await p.evaluate(() => window.mochi.history())).map((h) => h.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Add physics',
        'Add physics input',
        'Add physics output',
        'Edit physics',
      ]),
    );
    // Closing the dialog stops the test.
    await p.keyboard.press('Escape');
    expect(await p.evaluate(() => window.mochiEditor.viewport.simulate)).toBe(false);
    expect(errors).toEqual([]);
    await p.close();
  }, 180_000);
});
