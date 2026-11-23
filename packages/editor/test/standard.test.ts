/**
 * Standard parameters in New Parameter: picking one fills in its ID, name and range and
 * says what changing them costs; the Eye blink and Lip sync groups are offered for their usual
 * members; a custom ID that differs from a standard one only by letter case is warned about; a
 * standard ID in use is not offered again; New Parameter Group offers the standard group IDs.
 * Headless Chromium through Playwright; skipped where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { buildEditor, launch, serve, type Browser, type Page } from './harness.js';

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

const values = (p: Page) =>
  Promise.all(
    ['param-id', 'param-name', 'param-min', 'param-default', 'param-max'].map((t) =>
      p.getByTestId(t).inputValue(),
    ),
  );
const groups = (p: Page) =>
  p.evaluate(() => {
    const v = window.mochiEditor.editor.view;
    const g = v.project().standardGroups;
    const ids = (us: string[]) => us.map((u) => v.getAs(u, 'parameter').exportId);
    return { eyeBlink: ids(g.eyeBlink), lipSync: ids(g.lipSync) };
  });

describe('standard parameters in New Parameter', () => {
  it('fills in a picked one, offers its group, warns about case and ranges', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);

    // Pick ParamEyeLOpen: its values, the note, and the Eye blink offer (checked).
    await p.getByTestId('param-create').click();
    await p.getByTestId('param-standard').selectOption('ParamEyeLOpen');
    expect(await values(p)).toEqual(['ParamEyeLOpen', 'Left eye open', '0', '1', '1']);
    expect(await p.getByTestId('param-standard-note').textContent()).toMatch(/Auto-Setup/);
    expect(await p.getByTestId('param-meaning').textContent()).toMatch(/0 closed/);
    expect(await p.getByTestId('param-group-check').isVisible()).toBe(true);
    expect(await p.getByTestId('param-group-check').isChecked()).toBe(true);
    // A documented variant (an eye opening wider, to 2) is quiet.
    await p.getByTestId('param-max').fill('2');
    expect(await p.getByTestId('param-standard-note').getAttribute('class')).toBe('hint');
    expect(await p.getByTestId('param-standard-note').textContent()).toMatch(/also a usual one/);
    // A range past the documented ones is called out; back to the standard one, it is calm again.
    await p.getByTestId('param-max').fill('3');
    expect(await p.getByTestId('param-standard-note').getAttribute('class')).toBe('refusal');
    expect(await p.getByTestId('param-standard-note').textContent()).toMatch(
      /neither the standard 0 \/ 1 \/ 1 nor another usual one/,
    );
    await p.getByTestId('param-max').fill('1');
    expect(await p.getByTestId('param-standard-note').getAttribute('class')).toBe('hint');
    await p.getByTestId('param-create-ok').click();
    await p.locator('[data-param="ParamEyeLOpen"]').waitFor();
    expect(
      await p.evaluate(() => {
        const x = window.mochi.get('@param:ParamEyeLOpen') as Record<string, unknown>;
        return [x.name, x.min, x.default, x.max];
      }),
    ).toEqual(['Left eye open', 0, 1, 1]);
    expect(await groups(p)).toEqual({ eyeBlink: ['ParamEyeLOpen'], lipSync: [] });

    // ParamMouthOpenY with the Lip sync offer turned down; ParamEyeLOpen is no longer offered.
    await p.getByTestId('param-create').click();
    // (Playwright's isDisabled does not apply to <option>: read the property.)
    expect(
      await p
        .locator('[data-testid="param-standard"] option[value="ParamEyeLOpen"]')
        .evaluate((o) => [(o as HTMLOptionElement).disabled, o.textContent]),
    ).toEqual([true, 'ParamEyeLOpen · Left eye open · in use']);
    await p.getByTestId('param-standard').selectOption('ParamMouthOpenY');
    expect(await p.getByTestId('param-group-check').isVisible()).toBe(true);
    await p.getByTestId('param-group-check').uncheck();
    await p.getByTestId('param-create-ok').click();
    await p.locator('[data-param="ParamMouthOpenY"]').waitFor();
    expect(await groups(p)).toEqual({ eyeBlink: ['ParamEyeLOpen'], lipSync: [] });

    // A custom ID differing from a standard one only by letter case: warned, still allowed.
    await p.getByTestId('param-create').click();
    await p.getByTestId('param-id').fill('ParamAnglex');
    expect(await p.getByTestId('param-warning').textContent()).toMatch(
      /standard ID ParamAngleX only by letter case/,
    );
    expect(await p.getByTestId('param-group-check').isVisible()).toBe(false);
    await p.getByTestId('param-id').fill('ParamTail');
    expect(await p.getByTestId('param-warning').textContent()).toBe('');
    // Typing a standard ID exactly shows its group offer too.
    await p.getByTestId('param-id').fill('ParamEyeROpen');
    expect(await p.getByTestId('param-group-check').isVisible()).toBe(true);
    await p.getByTestId('param-id').fill('ParamAnglex');
    await p.getByTestId('param-create-ok').click();
    await p.locator('[data-param="ParamAnglex"]').waitFor();

    // New Parameter Group offers the standard group IDs.
    await p.getByTestId('param-menu').click();
    await p.getByTestId('menu-new-param-group').click();
    await p.getByTestId('group-standard').selectOption('ParamGroupEyes');
    expect(await p.getByTestId('group-id').inputValue()).toBe('ParamGroupEyes');
    expect(await p.getByTestId('group-name').inputValue()).toBe('Eyes');
    await p.getByTestId('group-create-ok').click();
    await expect
      .poll(
        () =>
          p.evaluate(() =>
            window.mochiEditor.editor.view
              .ofKind('parameterGroup')
              .map((g) => [g.exportId, g.name]),
          ),
        { timeout: 30_000 },
      )
      .toEqual([['ParamGroupEyes', 'Eyes']]);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('accepts each kind of documented variant quietly, and warns past them or on a new ID', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await p.getByTestId('param-create').click();
    const note = async () => [
      await p.getByTestId('param-standard-note').getAttribute('class'),
      await p.getByTestId('param-standard-note').textContent(),
    ];
    const range = async (id: string, [min, def, max]: [number, number, number]) => {
      await p.getByTestId('param-standard').selectOption(id);
      await p.getByTestId('param-min').fill(String(min));
      await p.getByTestId('param-default').fill(String(def));
      await p.getByTestId('param-max').fill(String(max));
      return note();
    };
    const quiet = [
      ['ParamAngleX', [-45, 0, 45]],
      ['ParamArmLA', [-100, 0, 100]],
      ['ParamArmRB', [-10, 0, 10]],
      ['ParamEyeROpen', [-0.5, 1, 1]],
      ['ParamMouthOpenY', [0, 0, 1.5]],
      ['ParamEyeBallForm', [0, 0, 1]],
    ] as const;
    for (const [id, r] of quiet) {
      const [cls, text] = await range(id, [...r]);
      expect([id, cls], text!).toEqual([id, 'hint']);
      expect(text).toMatch(/also a usual one/);
    }
    for (const [id, r] of [
      ['ParamAngleX', [-60, 0, 60]],
      ['ParamArmLA', [-40, 0, 40]],
      ['ParamMouthOpenY', [0, 0, 2.5]],
    ] as const) {
      const [cls] = await range(id, [...r]);
      expect([id, cls]).toEqual([id, 'refusal']);
    }
    // The ID of a picked standard parameter changed: a warning.
    await p.getByTestId('param-standard').selectOption('ParamBreath');
    expect((await note())[0]).toBe('hint');
    await p.getByTestId('param-id').fill('ParamBreathing');
    expect(await note()).toEqual([
      'refusal',
      expect.stringMatching(/no longer the standard ID ParamBreath/),
    ]);
    await p.close();
  }, 120_000);
});
