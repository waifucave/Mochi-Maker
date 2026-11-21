/**
 * Recording from the viewport (turning a rotation deformer keys the parameter that turns
 * it) and the Template palette (New from the selected keys, insert at the playhead by parameter ID
 * with the unmatched ones shown, rename, delete, export and import). Headless Chromium through
 * Playwright; skipped where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
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

async function page(golden: string): Promise<Page> {
  const p = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  (p as unknown as { errors: string[] }).errors = errors;
  await p.goto(`${url}?nohome`);
  await p.waitForFunction(() => window.mochi !== undefined);
  await openGolden(p, golden);
  await p.evaluate(() => window.mochi.settled());
  return p;
}
const errorsOf = (p: Page) => (p as unknown as { errors: string[] }).errors;
const seek = (p: Page, t: number) => p.evaluate((t) => window.mochiEditor.playback.seek(t), t);
const history = (p: Page) => p.evaluate(() => window.mochi.history().map((h) => h.label));

/** A parameter curve's keys in a motion, as [time, value] pairs, by export IDs and names. */
const keys = (p: Page, motion: string, param: string) =>
  p.evaluate(
    ({ motion, param }) => {
      const m = window.mochi.get(`@motion~${motion}`) as {
        curves: { object: string | null; segments: number[] }[];
      };
      const uid = (window.mochi.get(`@param:${param}`) as { uid: string }).uid;
      const s = m.curves.find((c) => c.object === uid)?.segments;
      if (!s) return [];
      const out: [number, number][] = [[s[0]!, s[1]!]];
      for (let i = 2; i < s.length; i += s[i] === 1 ? 7 : 3) {
        const o = s[i] === 1 ? 5 : 1;
        out.push([s[i + o]!, s[i + o + 1]!]);
      }
      return out;
    },
    { motion, param },
  );

describe('recording and templates', () => {
  it('keys the parameter that turns a rotation deformer dragged in the animation view', async () => {
    if (!browser) return;
    const p = await page('golden-2-deformers');
    const rot = (await p.evaluate(() => window.mochi.get('@rotation:Rotation_Head'))) as {
      uid: string;
      rig: { bindings: { parameter: string }[]; keyforms: { angle: number }[] };
    };
    const param = (await p.evaluate(
      (u) => (window.mochi.get(u) as { exportId: string }).exportId,
      rot.rig.bindings[0]!.parameter,
    )) as string;
    await p.evaluate(() =>
      window.mochi.transact('Motion', (tx) =>
        tx.run('motion.create', { name: 'rec', duration: 2, fps: 30 }),
      ),
    );
    await p.getByTestId('workspace-switcher').selectOption('animation');
    await p.locator('[data-motion="rec"]').click();
    await p.evaluate((u) => {
      window.mochi.select(u);
      window.mochiEditor.editor.setLevel(2);
    }, rot.uid);
    await seek(p, 0.5);
    const handles = () =>
      p.evaluate((u) => {
        const vp = window.mochiEditor.viewport;
        const r = vp.overlay.getBoundingClientRect();
        return vp.rotationHandles(u)!.map(([x, y]) => [r.left + x, r.top + y] as [number, number]);
      }, rot.uid);
    const turn = async (radians: number) => {
      const [o, tip] = await handles();
      const a0 = Math.atan2(tip![1] - o![1], tip![0] - o![0]);
      const len = Math.hypot(tip![0] - o![0], tip![1] - o![1]);
      await p.mouse.move(tip![0], tip![1]);
      await p.mouse.down();
      for (let k = 1; k <= 8; k++) {
        const a = a0 + (radians * k) / 8;
        await p.mouse.move(o![0] + len * Math.cos(a), o![1] + len * Math.sin(a));
      }
      await p.mouse.up();
    };
    // 0.3 rad ≈ 17.2°: the angle keys go −30, 0, 30 with the parameter, so it reads 17.2 too.
    await turn(0.3);
    await poll(() => keys(p, 'rec', param)).toHaveLength(1);
    const [[t, v]] = (await keys(p, 'rec', param)) as [[number, number]];
    expect(t).toBeCloseTo(0.5, 6);
    expect(Math.abs(v)).toBeCloseTo((0.3 * 180) / Math.PI, 0);
    expect((await history(p)).at(-1)).toBe('Key from drag');
    // The rotation's forms are untouched: recording poses, it does not model.
    const after = (await p.evaluate((u) => window.mochi.get(u), rot.uid)) as typeof rot;
    expect(after.rig.keyforms.map((k) => k.angle)).toEqual(rot.rig.keyforms.map((k) => k.angle));
    // One key per drag, at the playhead: a second drag elsewhere adds one more.
    await seek(p, 1.5);
    await turn(-0.5);
    await poll(() => keys(p, 'rec', param)).toHaveLength(2);
    // Record drags off: the same drag is the modeling turn again (at a key of the parameter).
    await p.getByTestId('record-drags').uncheck();
    await p.evaluate(
      (u) => window.mochiEditor.editor.setPoseRaw(u, 0),
      rot.rig.bindings[0]!.parameter,
    );
    await turn(0.2);
    await poll(async () => (await history(p)).at(-1)).toBe('Rotate');
    expect(await keys(p, 'rec', param)).toHaveLength(2);
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('makes templates from selected keys and inserts them at the playhead', async () => {
    if (!browser) return;
    const p = await page('golden-12-motions');
    await p.getByTestId('workspace-switcher').selectOption('animation');
    await p.locator('[data-tab="template"]').click();
    await p.locator('[data-motion="curves"]').click();
    await p.locator('[data-lane="P_Linear"]').waitFor();
    // Select P_Linear's keys at 0 and 1: New takes that range.
    await p.locator('[data-key="P_Linear@0"]').click();
    await p.locator('[data-key="P_Linear@1"]').click({ modifiers: ['Shift'] });
    await p.getByTestId('template-new').click();
    expect(await p.getByTestId('template-from').inputValue()).toBe('0');
    expect(await p.getByTestId('template-to').inputValue()).toBe('1');
    await p.getByTestId('template-name').fill('Rise');
    await p.getByTestId('template-ok').click();
    await p.locator('[data-template="Rise"]').waitFor();
    const t = await p.evaluate(() => window.mochi.get('project'));
    const rise = (t as { animationTemplates: { name: string; curves: { id: string }[] }[] })
      .animationTemplates[0]!;
    expect(rise.curves.map((c) => c.id)).toEqual(['P_Linear', 'P_Step', 'P_Bez', 'P_Fade']);
    // A taken name is refused in the dialog, which stays open.
    await p.getByTestId('template-new').click();
    await p.getByTestId('template-name').fill('Rise');
    await p.getByTestId('template-ok').click();
    await poll(() => p.getByTestId('template-message').textContent()).toContain('exists already');
    expect(await p.locator('body > .backdrop').count()).toBe(1);
    await p.keyboard.press('Escape');
    expect(await p.locator('body > .backdrop').count()).toBe(0);
    // Insert into the «close» motion at 0.5 s: P_Linear gets 0 at 0.5 and 20 at 1.5.
    await p.locator('[data-motion="close"]').click();
    await seek(p, 0.5);
    await p.locator('[data-template="Rise"]').click();
    await poll(() => keys(p, 'close', 'P_Linear')).toEqual([
      [0.5, 0],
      [1.5, 20],
    ]);
    expect((await history(p)).at(-1)).toBe('Insert template “Rise”');
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('shows unmatched parameters before inserting; renames, deletes, exports and imports', async () => {
    if (!browser) return;
    const p = await page('golden-12-motions');
    await p.getByTestId('workspace-switcher').selectOption('animation');
    await p.locator('[data-tab="template"]').click();
    await p.locator('[data-motion="close"]').click();
    const file = {
      format: 'mochi-maker-animation-template',
      version: 1,
      templates: [
        {
          name: 'Blink',
          duration: 0.3,
          curves: [
            {
              id: 'P_Step',
              keys: [
                { time: 0, value: 0, interp: 'linear' },
                { time: 0.1, value: 50, interp: 'linear' },
                { time: 0.3, value: 0, interp: 'linear' },
              ],
            },
            { id: 'ParamEyeLOpen', keys: [{ time: 0, value: 1, interp: 'linear' }] },
          ],
        },
      ],
    };
    await p.getByTestId('template-import-file').setInputFiles({
      name: 'blink.template.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    });
    await p.locator('[data-template="Blink"]').waitFor();
    expect(await p.locator('.template .warn-mark').textContent()).toBe('1 unmatched');
    await seek(p, 1);
    await p.locator('[data-template="Blink"]').click();
    expect(await p.getByTestId('template-unmatched').textContent()).toBe('ParamEyeLOpen');
    await p.getByTestId('template-insert-ok').click();
    await poll(async () => (await keys(p, 'close', 'P_Step')).length).toBe(3);
    expect((await keys(p, 'close', 'P_Step'))[1]![0]).toBeCloseTo(1.1, 6);
    // Export it: the file reads back as the same template.
    await p.getByTestId('template-menu-Blink').click();
    const [download] = await Promise.all([
      p.waitForEvent('download'),
      p.getByTestId('template-export').click(),
    ]);
    expect(download.suggestedFilename()).toBe('Blink.template.json');
    const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(saved).toEqual(file);
    // Rename, then delete; importing the file again brings it back.
    await p.getByTestId('template-menu-Blink').click();
    await p.getByTestId('template-rename').click();
    await p.getByTestId('ask-text').fill('Blink 2');
    await p.getByTestId('ask-ok').click();
    await p.locator('[data-template="Blink 2"]').waitFor();
    await p.getByTestId('template-menu-Blink 2').click();
    await p.getByTestId('template-delete').click();
    await poll(() => p.locator('.template').count()).toBe(0);
    await p.getByTestId('template-import-file').setInputFiles({
      name: 'blink.template.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(saved)),
    });
    await p.locator('[data-template="Blink"]').waitFor();
    // A file that is not a template file is refused with a message.
    await p.getByTestId('template-import-file').setInputFiles({
      name: 'x.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"format":"other"}'),
    });
    await poll(() => p.getByTestId('status').textContent()).toContain('not a Mochi Maker');
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);
});
