/**
 * Feature flags in the editor: with glue and blend-shape authoring off (the shipped default), a
 * project that holds glue opens, the glue's Inspector fields are read-only with a notice, New
 * Parameter offers no blend-shape parameter, the export is refused with the same message, and
 * Environment Settings › Features switches them on. Headless Chromium through Playwright; skipped
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
  // Without the harness's settings: the editor's own defaults.
  browser = await launch([], { features: false });
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

describe('feature flags in the editor', () => {
  it('opens a project with glue, hides the authoring, refuses the export, and switches on', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    expect(await p.evaluate(() => window.mochiEditor.editor.features)).toEqual({
      glue: false,
      blendShapes: false,
    });
    await openGolden(p, 'golden-5-glue');
    await p.evaluate(() => window.mochi.settled());
    // The glue: a notice, its fields read-only.
    const glue = await p.evaluate(
      () => window.mochiEditor.editor.view.ofKind('glue')[0]!.uid as string,
    );
    await p.evaluate((u) => window.mochiEditor.editor.select(u), glue);
    expect(await p.getByTestId('feature-off').textContent()).toBe(
      'Glue is not available in this build.',
    );
    expect(await p.locator('section.inspector input').first().isDisabled()).toBe(true);
    expect(await p.getByTestId('kf-intensity').count()).toBe(0);
    // Everything else works: a mesh can be renamed.
    await p.evaluate(() =>
      window.mochiEditor.editor.transact('Rename', [
        { name: 'object.rename', args: { target: '@mesh:A', name: 'Renamed' } },
      ]),
    );
    // A glue command is refused with the message, as for an agent.
    const refused = await p.evaluate(() =>
      window.mochi
        .run('x', [{ name: 'glue.setPairs', args: { target: '@glue:Glue_AB', pairs: [] } }], {
          author: 'person',
        })
        .then(
          () => 'ran',
          (e: { code: string; message: string }) => `${e.code}: ${e.message}`,
        ),
    );
    expect(refused).toMatch(/E_FEATURE_OFF: .*Glue is not available in this build\./);
    expect(
      await p.evaluate(
        () => (window.mochi.describe('glue.create') as { available?: boolean }).available,
      ),
    ).toBe(false);
    // New Parameter: no blend-shape parameter.
    await p.getByTestId('param-create').click();
    expect(await p.getByText('Blend Shape (its keys add a shape on top)').count()).toBe(0);
    expect(await p.locator('body > .backdrop').count()).toBe(1);
    await p.keyboard.press('Escape');
    expect(await p.locator('body > .backdrop').count()).toBe(0);
    // The export is refused, with the same message.
    await p.evaluate(() => window.mochiEditor.keymap.run('file.exportMoc'));
    await expect
      .poll(() => p.getByTestId('status').textContent())
      .toMatch(/Glue is not available in this build\./);
    // Environment Settings › Features: glue authoring on.
    await p.evaluate(() => window.mochiEditor.keymap.run('file.settings'));
    await p.locator('[data-setting="featureGlue"]').check();
    expect(await p.evaluate(() => window.mochiEditor.editor.features.glue)).toBe(true);
    expect(await p.locator('body > .backdrop').count()).toBe(1);
    await p.keyboard.press('Escape');
    expect(await p.locator('body > .backdrop').count()).toBe(0);
    await p.evaluate((u) => window.mochiEditor.editor.select(u), glue);
    await expect.poll(() => p.getByTestId('kf-intensity').count()).toBe(1);
    expect(await p.getByTestId('feature-off').count()).toBe(0);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
