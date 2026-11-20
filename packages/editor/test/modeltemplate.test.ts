/**
 * Model templates in the editor: «Export Template…» downloads a .mochitemplate of
 * golden 15; the project is stripped to its bare art; «Apply Template…» loads the file, finds it by
 * search, lays it over the art (see-through with T, a right-drag scales, Fit goes back), matches
 * every mesh by name, and applies in one step; the result evaluates like the golden did. Headless
 * Chromium through Playwright; skipped where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
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
const POSES = [{}, { ParamAngle: 30 }, { ParamAngle: -17, ParamBend: 1 }];

describe('model templates', () => {
  it('exports a template, and applies it to bare art like the original', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-15-nested-deformers');
    await p.evaluate(() => window.mochi.settled());
    const shapes = () =>
      p.evaluate(async (poses) => {
        const out: Record<string, number[]>[] = [];
        for (const pose of poses) {
          window.mochi.setPose({ ParamAngle: 0, ParamBend: 0, ...pose });
          await window.mochi.settled();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const e = window.mochi.evaluate() as unknown as {
            drawables: { id: string; vertices: number[] }[];
          };
          out.push(Object.fromEntries(e.drawables.map((d) => [d.id, d.vertices])));
        }
        return out;
      }, POSES);
    const before = await shapes();
    // A motion in the template, for the preview.
    await p.evaluate(() =>
      window.mochiEditor.editor.transact('Nod', [
        { name: 'motion.create', args: { name: 'nod', duration: 1, fps: 30, loop: true } },
        {
          name: 'motion.setCurve',
          args: {
            target: '@motion~nod',
            curve: {
              target: 'parameter',
              object: '@param:ParamAngle',
              segments: [0, -30, 0, 0.5, 30, 0, 1, -30],
            },
          },
        },
      ]),
    );
    // Export Template…
    await p.evaluate(() => window.mochiEditor.keymap.run('model.exportTemplate'));
    await p.getByTestId('template-export').waitFor();
    await p.getByTestId('tpl-name').fill('Nested');
    await p.getByTestId('tpl-description').fill('Warps inside rotations');
    await p.getByTestId('tpl-author').fill('Mochi Maker tests');
    const [download] = await Promise.all([
      p.waitForEvent('download'),
      p.getByTestId('tpl-export').click(),
    ]);
    expect(download.suggestedFilename()).toBe('Nested.mochitemplate');
    const bytes = await readFile((await download.path())!);
    // The bare art: every mesh out of its deformers (in place), no deformers, no parameters.
    await p.evaluate(async () => {
      const v = window.mochi;
      const meshes = v.query({ kind: 'artMesh' }).items.map((m) => (m as { uid: string }).uid);
      await window.mochiEditor.editor.runItems('Strip', [
        ...meshes.map((m) => ({ name: 'mesh.reparent', args: { target: m, deformer: null } })),
        ...[
          '@rotation:Rotation_Hat',
          '@rotation:Rotation_Eye',
          '@warp:Warp_Face',
          '@rotation:Rotation_Head',
          '@warp:Warp_Outer',
        ].map((d) => ({ name: 'deformer.delete', args: { target: d, cascade: true } })),
        { name: 'param.delete', args: { target: '@param:ParamBend', cascade: true } },
        { name: 'param.delete', args: { target: '@param:ParamAngle', cascade: true } },
      ]);
      await v.settled();
    });
    expect(await p.evaluate(() => window.mochi.query({ kind: 'parameter' }).total)).toBe(0);
    // Apply Template…: load the file, find it, open it.
    await p.evaluate(() => window.mochiEditor.editor.select(null));
    await p.evaluate(() => window.mochiEditor.keymap.run('model.applyTemplate'));
    await p.getByTestId('template-apply').waitFor();
    await p.getByTestId('tpl-files').setInputFiles({
      name: 'Nested.mochitemplate',
      mimeType: 'application/zip',
      buffer: bytes,
    });
    await p.locator('[data-template="Nested"]').waitFor();
    await p.getByTestId('tpl-search').fill('nobody');
    expect(await p.locator('[data-template]').count()).toBe(0);
    await p.getByTestId('tpl-search').fill('tests rotations');
    expect(await p.locator('[data-template]').count()).toBe(1);
    await p.locator('[data-template="Nested"]').click();
    await p.getByTestId('tpl-pairs').waitFor();
    // Every target matched by name.
    await poll(() => p.locator('[data-testid="tpl-pairs"] .row').count()).toBe(4);
    expect(await p.locator('[data-testid="tpl-pairs"] .extra').allTextContents()).toEqual([
      'name',
      'name',
      'name',
      'name',
    ]);
    // The template's art over the target's: T cycles its see-through level.
    const alpha = () => p.evaluate(() => window.mochiEditor.viewport.templateGuide?.alpha);
    expect(await alpha()).toBe(0.5);
    await p.mouse.move(700, 450);
    await p.keyboard.press('t');
    expect(await alpha()).toBe(0.25);
    // A right-drag scales the layout; Fit goes back.
    const scale = () => p.evaluate(() => window.mochiEditor.viewport.templateGuide?.layout.scale);
    const box = (await p.locator('.view-body canvas').last().boundingBox())!;
    await p.mouse.move(box.x + 80, box.y + 120);
    await p.mouse.down({ button: 'right' });
    await p.mouse.move(box.x + 140, box.y + 120, { steps: 5 });
    await p.mouse.up({ button: 'right' });
    expect(await scale()).toBeGreaterThan(1.05);
    await p.getByTestId('tpl-fit').click();
    expect(await scale()).toBeCloseTo(1, 6);
    // The preview: template and result side by side, the template's motion playing on both.
    const steps = await p.evaluate(() => window.mochi.history().length);
    await p.getByTestId('tpl-preview-build').click();
    await poll(() => p.evaluate(() => window.mochiEditor.templatePreview() !== null)).toBe(true);
    await p.getByTestId('tpl-view-template').waitFor();
    await p.getByTestId('tpl-view-result').waitFor();
    await p.getByTestId('tpl-play').click();
    expect(await p.getByTestId('tpl-status').textContent()).toMatch(/1 curve\(s\) retargeted/);
    const samples: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      samples.push(
        await p.evaluate(() => {
          const pv = window.mochiEditor.templatePreview()!;
          return [
            pv.left.model!.getParameter('ParamAngle'),
            pv.right.model!.getParameter('ParamAngle'),
          ] as [number, number];
        }),
      );
      await new Promise((r) => setTimeout(r, 80));
    }
    const lefts = samples.map((x) => x[0]);
    // The motion moves the template, and the result follows it.
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeGreaterThan(20);
    for (const [l, r] of samples) expect(Math.abs(l - r)).toBeLessThan(10);
    // Previewing changes nothing.
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(steps);
    // Apply: one step.
    await p.getByTestId('tpl-apply').click();
    await p.getByTestId('template-apply').waitFor({ state: 'detached' });
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe(
      'Apply template Nested',
    );
    expect(await p.evaluate(() => window.mochiEditor.viewport.templateGuide)).toBe(null);
    const after = await shapes();
    let worst = 0;
    after.forEach((pose, i) => {
      for (const [id, v] of Object.entries(before[i]!))
        v.forEach((x, k) => (worst = Math.max(worst, Math.abs(x - pose[id]![k]!))));
    });
    // Canvas pixels.
    expect(worst).toBeLessThan(0.05);
    expect(errors).toEqual([]);
    await p.close();
  }, 180_000);
});
