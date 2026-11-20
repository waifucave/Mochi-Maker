/**
 * Find and Replace (Ctrl+F): the live preview with its problems, Replace All as one
 * undoable step, and the references that follow. Headless Chromium through Playwright; skipped
 * where Chromium is missing, except in CI's render job.
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

describe('Find and Replace', () => {
  it('previews, refuses problems, replaces in one step, and keeps references', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-11-animation');
    await p.evaluate(() => window.mochi.settled());
    const physicsInput = () =>
      p.evaluate(() => {
        const uid = (window.mochi.query({ kind: 'physicsSetting' }).items[0] as { uid: string })
          .uid;
        const s = window.mochi.get(uid) as unknown as { inputs: { parameter: string }[] };
        return (window.mochi.get(s.inputs[0]!.parameter) as { exportId: string }).exportId;
      });
    expect(await physicsInput()).toBe('ParamIn');
    await p.keyboard.press('Control+F');
    await p.getByTestId('find-replace').waitFor();
    // A pattern, IDs only: ParamX → PrmX.
    await p.getByTestId('fr-pattern').check();
    await p.getByTestId('fr-names').uncheck();
    await p.getByTestId('fr-find').fill('^Param(\\w+)$');
    await p.getByTestId('fr-replace').fill('Prm$1');
    await poll(() => p.locator('[data-testid="fr-preview"] .row').count()).toBe(5);
    expect(await p.locator('[data-change="exportId:ParamIn"]').textContent()).toContain(
      'ParamIn → PrmIn',
    );
    expect(await p.getByTestId('fr-apply').isDisabled()).toBe(false);
    // A result with a duplicate ID is shown as a problem and cannot be applied.
    await p.getByTestId('fr-replace').fill('PrmA');
    await poll(() => p.getByTestId('fr-summary').textContent()).toMatch(/problem/);
    expect(await p.getByTestId('fr-apply').isDisabled()).toBe(true);
    expect(await p.locator('[data-testid="fr-preview"] .row.problem').count()).toBeGreaterThan(0);
    // Back to the good replacement; Replace All.
    await p.getByTestId('fr-replace').fill('Prm$1');
    await p.getByTestId('fr-apply').click();
    await poll(physicsInput).toBe('PrmIn');
    // The preview is redone: nothing matches now.
    await poll(() => p.getByTestId('fr-summary').textContent()).toBe('Nothing matches.');
    const history = await p.evaluate(() => window.mochi.history().at(-1)!.label);
    expect(history).toBe('Replace "^Param(\\w+)$" with "Prm$1"');
    // One undo brings every ID back.
    await p.keyboard.press('Escape');
    await p.keyboard.press('Control+Z');
    await poll(physicsInput).toBe('ParamIn');
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
