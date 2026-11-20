/**
 * Expressions and pose in the editor: the Expression palette (recording, blends,
 * preview by Mochi2D), pose groups in the Parts palette (links, preview by Mochi2D's pose), and
 * the export of both. Headless Chromium; skipped where Chromium is missing, except in CI's render
 * job.
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
const param = (p: Page, id: string) =>
  p.evaluate((i) => window.mochiEditor.viewport.model!.getParameter(i) as number, id);
const partOpacity = (p: Page, id: string) =>
  p.evaluate((i) => window.mochiEditor.viewport.model!.getPartOpacity(i) as number, id);

async function page(): Promise<Page> {
  const p = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  (p as unknown as { errors: string[] }).errors = errors;
  await p.goto(`${url}?nohome`);
  await p.waitForFunction(() => window.mochi !== undefined, null, { timeout: 60_000 });
  await openGolden(p, 'golden-11-animation');
  await settled(p);
  return p;
}

const available = await launch().then(async (b) => {
  await b?.close();
  return b !== null;
});

describe.skipIf(!required && !available)('expressions and pose', () => {
  it('previews, records and exports expressions from the Expression palette', async () => {
    const p = await page();
    await p.locator('[data-tab="expression"]').click();
    expect(await p.locator('[data-expression]').allTextContents()).toEqual([
      expect.stringContaining('smile'),
      expect.stringContaining('frown'),
    ]);
    // Preview «smile» on the shown model: Add 4, Multiply 1.5 (default 1), Set 7.
    await p.locator('[data-expression="smile"]').click();
    await p.getByTestId('expression-preview').check();
    await poll(() => param(p, 'ParamA')).toBeCloseTo(4, 2);
    expect(await param(p, 'ParamB')).toBeCloseTo(1.5, 2);
    expect(await param(p, 'ParamC')).toBeCloseTo(7, 2);
    await p.getByTestId('expression-preview').uncheck();
    await poll(() => param(p, 'ParamA')).toBeCloseTo(0, 2);

    // Record from the pose: Add stores the difference from the default.
    await p.evaluate(() => window.mochi.setPose({ ParamA: 3, ParamB: 2, ParamC: -2 }));
    await p.getByTestId('expression-new').click();
    await settled(p);
    const entries = () =>
      p.evaluate(() =>
        window.mochiEditor.editor.view
          .ofKind('expression')
          .at(-1)!
          .entries.map((e) => [
            window.mochiEditor.editor.view.getAs(e.parameter, 'parameter').exportId,
            e.value,
            e.blend,
          ]),
      );
    expect(await entries()).toEqual([
      ['ParamA', 3, 'Add'],
      ['ParamB', 1, 'Add'],
      ['ParamC', -2, 'Add'],
    ]);
    // As Set: the values themselves. As Multiply: the factor; a default of 0 has none, and is left out.
    await p.getByTestId('expression-blend').selectOption('Overwrite');
    await p.getByTestId('expression-record').click();
    await settled(p);
    expect(await entries()).toEqual([
      ['ParamA', 3, 'Overwrite'],
      ['ParamB', 2, 'Overwrite'],
      ['ParamC', -2, 'Overwrite'],
    ]);
    await p.getByTestId('expression-blend').selectOption('Multiply');
    await p.getByTestId('expression-record').click();
    await settled(p);
    expect(await entries()).toEqual([['ParamB', 2, 'Multiply']]);
    await poll(() => p.getByTestId('status').textContent()).toContain('Left out ParamA, ParamC');
    // An entry's value and blend in the table.
    await p.getByTestId('entry-value-0').fill('1.25');
    await p.getByTestId('entry-value-0').press('Enter');
    await p.getByTestId('entry-blend-0').selectOption('Add');
    await settled(p);
    expect(await entries()).toEqual([['ParamB', 1.25, 'Add']]);
    // The export lists it in the model settings and parses it back.
    const r = await p.evaluate(() => window.mochi.export());
    expect(r.report.problems.filter((x) => x.severity === 'error')).toEqual([]);
    expect(r.files.filter((f) => f.endsWith('.exp3.json')).length).toBe(3);
    const labels = (await p.evaluate(() => window.mochi.history())).map((h) => h.label);
    expect(labels).toEqual([
      'New expression',
      'Record expression',
      'Record expression',
      'Edit expression',
      'Edit expression',
    ]);
    expect((p as unknown as { errors: string[] }).errors).toEqual([]);
    await p.close();
  }, 180_000);

  it('edits pose groups and links in the Parts palette, and previews them with Mochi2D', async () => {
    const p = await page();
    const uid = (id: string) =>
      p.evaluate((i) => (window.mochi.get(`@part:${i}`) as { uid: string }).uid, id);
    // The group shows in the Parts palette, and on its rows.
    expect(await p.locator('[data-pose-group]').count()).toBe(1);
    expect(
      await p
        .locator(`[data-palette="parts"] .row[data-uid="${await uid('PartArmA')}"] .extra`)
        .textContent(),
    ).toContain('pose 1');
    // Preview: the part picked shows, the other hides, and the link follows its part.
    await p.getByTestId('pose-preview').check();
    await p.getByTestId('pose-show-PartArmA').check();
    await poll(() => partOpacity(p, 'PartArmA')).toBeCloseTo(1, 2);
    await poll(() => partOpacity(p, 'PartArmB')).toBeCloseTo(0, 2);
    // The link follows its part (Mochi2D's pose decides the exact value).
    await poll(() => partOpacity(p, 'PartArmLink')).toBeGreaterThan(0.9);
    await p.getByTestId('pose-show-PartArmB').check();
    await poll(() => partOpacity(p, 'PartArmB')).toBeCloseTo(1, 2);
    await poll(() => partOpacity(p, 'PartArmLink')).toBeLessThan(0.1);
    await p.getByTestId('pose-preview').uncheck();
    // Links: PartArmB now links PartArmLink too.
    await p.getByTestId('pose-links-PartArmB').selectOption([await uid('PartArmLink')]);
    await settled(p);
    const groups = () =>
      p.evaluate(() =>
        window.mochiEditor.editor.view
          .project()
          .pose.groups.map((g) =>
            g.map((e) => [
              (window.mochi.get(e.part) as { exportId: string }).exportId,
              e.links.map((l) => (window.mochi.get(l) as { exportId: string }).exportId),
            ]),
          ),
      );
    expect(await groups()).toEqual([
      [
        ['PartArmA', ['PartArmLink']],
        ['PartArmB', ['PartArmLink']],
      ],
    ]);
    // A new group from the selection takes the part out of its old group; one part warns.
    await p.evaluate(async (u) => window.mochi.select(u), await uid('PartArmB'));
    await p.getByTestId('pose-new-group').click();
    await settled(p);
    expect(await groups()).toEqual([[['PartArmA', ['PartArmLink']]], [['PartArmB', []]]]);
    expect(await p.locator('[data-pose-group] .warn').count()).toBe(2);
    const lint = await p.evaluate(() => window.mochi.validate());
    expect(
      (lint as { lint: { rule: string }[] }).lint.filter((l) => l.rule === 'pose-small-group')
        .length,
    ).toBe(2);
    // Undo brings the group back; the export writes the pose and parses it.
    await p.getByTestId('undo').click();
    await settled(p);
    expect((await groups())[0]!.length).toBe(2);
    const r = await p.evaluate(() => window.mochi.export());
    expect(r.files).toContain('golden11.pose3.json');
    expect(r.report.problems.filter((x) => x.severity === 'error')).toEqual([]);
    expect((p as unknown as { errors: string[] }).errors).toEqual([]);
    await p.close();
  }, 180_000);
});
