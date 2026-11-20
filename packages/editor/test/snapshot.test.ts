/**
 * The snapshot and guide images: Ctrl+5 takes a translucent copy of the pose, pinned to
 * the model (it stays while parameters move and follows zoom); 5 shows or hides it; Ctrl+Shift+5
 * saves it as a guide-image part; Ctrl+Alt+Shift+3 shows or hides the guide parts. Headless
 * Chromium through Playwright; skipped where Chromium is missing, except in CI's render job.
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

describe('snapshot and guide images', () => {
  it('takes, pins, hides and saves the snapshot; guide parts show and hide', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-1-keyforms');
    await p.evaluate(() => window.mochi.settled());
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+5');
    await poll(() => p.evaluate(() => window.mochiEditor.viewport.snapshot !== null)).toBe(true);
    const screen = () => p.evaluate(() => window.mochiEditor.viewport.snapshotScreen());
    const at0 = (await screen())!;
    // Parameters move the model, not the snapshot.
    await p.evaluate(() => window.mochi.setPose({ ParamA: 1 }));
    await p.evaluate(() => window.mochi.settled());
    expect(await screen()).toEqual(at0);
    // Zoom: the snapshot scales with the view about the canvas centre.
    await p.evaluate(() => window.mochiEditor.viewport.view.setView({ zoom: 2 }));
    const at2 = (await screen())!;
    const w0 = at0[1]![0] - at0[0]![0];
    expect(at2[1]![0] - at2[0]![0]).toBeCloseTo(2 * w0, 3);
    await p.evaluate(() => window.mochiEditor.viewport.view.setView({ zoom: 1 }));
    // 5 hides and shows it.
    await p.keyboard.press('5');
    expect(await p.evaluate(() => window.mochiEditor.viewport.snapshotShown)).toBe(false);
    await p.keyboard.press('5');
    expect(await p.evaluate(() => window.mochiEditor.viewport.snapshotShown)).toBe(true);
    // Ctrl+Shift+5: a guide-image part with a quad mesh over the snapshot's place.
    await p.keyboard.press('Control+Shift+5');
    await poll(() => p.evaluate(() => window.mochi.history().at(-1)?.label)).toBe(
      'Save snapshot as guide image',
    );
    const guide = (await p.evaluate(() =>
      (
        window.mochi.query({ kind: 'part' }) as unknown as {
          items: { uid: string; guide: boolean; children: string[] }[];
        }
      ).items.find((x) => x.guide),
    ))!;
    expect(guide.children).toHaveLength(1);
    expect(await p.locator('.extra', { hasText: 'guide' }).count()).toBeGreaterThan(0);
    // Ctrl+Alt+Shift+3 hides the guide parts, and shows them again.
    await p.keyboard.press('Control+Alt+Shift+3');
    expect(await p.evaluate((u) => window.mochiEditor.editor.hidden.has(u), guide.uid)).toBe(true);
    await p.keyboard.press('Control+Alt+Shift+3');
    expect(await p.evaluate((u) => window.mochiEditor.editor.hidden.has(u), guide.uid)).toBe(false);
    // The export leaves it out unless asked.
    const meshes = () =>
      p.evaluate(async () => {
        const r = (await window.mochi.export()) as unknown as {
          report: { counts: { artMeshes: number } };
        };
        return r.report.counts.artMeshes;
      });
    expect(await meshes()).toBe(1);
    // File › Export › Include Guide Images.
    await p.evaluate(() => window.mochiEditor.keymap.run('file.exportGuides'));
    expect(await meshes()).toBe(2);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
