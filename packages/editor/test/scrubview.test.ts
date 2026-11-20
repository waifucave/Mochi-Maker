/**
 * Scrubbing with physics in the editor: with the Timeline stopped, the playhead shows
 * golden 11's pendulum as physics has it at that time, the same whichever way the playhead got
 * there; the Physics switch turns it off. Headless Chromium through Playwright; skipped where
 * Chromium is missing, except in CI's render job.
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

describe('scrubbing with physics', () => {
  it('shows the pendulum at the playhead, the same from any direction', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-11-animation');
    await p.evaluate(() => window.mochi.settled());
    // A motion that swings ParamIn, the pendulum's input.
    await p.evaluate(() =>
      window.mochi.transact('Swing', (tx) => {
        tx.run('motion.create', { name: 'swing', duration: 4, fps: 30 });
        tx.run('motion.setKeys', {
          target: '@motion~swing',
          curve: { target: 'parameter', object: '@param:ParamIn' },
          keys: [
            { time: 0, value: 0, interp: 'auto' },
            { time: 0.5, value: 10, interp: 'auto' },
            { time: 1, value: -10, interp: 'auto' },
            { time: 1.5, value: 0 },
          ],
        });
      }),
    );
    await p.evaluate(() => window.mochi.settled());
    await p.getByTestId('workspace-switcher').selectOption('animation');
    await p.locator('[data-motion="swing"]').click();
    const out = () =>
      p.evaluate(() => window.mochiEditor.viewport.model!.runtime.getParameter('ParamOut'));
    const at = async (t: number) => {
      await p.evaluate((t) => window.mochiEditor.playback.seek(t), t);
      await poll(() => p.evaluate(() => window.mochiEditor.playback.lastScrub?.frame ?? -1)).toBe(
        Math.round(t * 30),
      );
      return out();
    };
    // At 2 s the input has been back at 0 for half a second: only physics moves ParamOut.
    const forward = await at(2);
    expect(Math.abs(forward)).toBeGreaterThan(0.01);
    expect(await p.evaluate(() => window.mochiEditor.viewport.scrubbing)).toBe(true);
    // Back to 0.3 s, then to 2 s again: the same value, bit for bit.
    await at(0.3);
    expect(await at(2)).toBe(forward);
    const scrub = await p.evaluate(() => window.mochiEditor.playback.lastScrub!);
    expect(scrub.steps).toBeLessThan(10);
    // Off: the playhead shows the curves only, and physics stops.
    await p.getByTestId('scrub-physics').uncheck();
    expect(await p.evaluate(() => window.mochiEditor.viewport.scrubbing)).toBe(false);
    // Leaving the Animation workspace also turns it off.
    await p.getByTestId('scrub-physics').check();
    await poll(() => p.evaluate(() => window.mochiEditor.viewport.scrubbing)).toBe(true);
    await p.getByTestId('workspace-switcher').selectOption('modeling');
    expect(await p.evaluate(() => window.mochiEditor.viewport.scrubbing)).toBe(false);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
