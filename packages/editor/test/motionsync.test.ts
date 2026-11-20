/**
 * The Motion Sync dialog on golden 17: the settings, a shape cell, «From pose», adding a
 * setting, and the preview: a synthesized «a» as a WAV, through Mochi2D's analysis on the shown
 * model, opens the mouth and fills the meter. Headless Chromium through Playwright; skipped where
 * Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { synthesizeVowel } from 'mochi2d/headless';
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

/** 16-bit mono PCM WAV. */
function wav(samples: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) =>
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2),
  );
  return b;
}

describe('Motion Sync dialog', () => {
  it('edits settings and shapes, and previews a WAV through Mochi2D’s analysis', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-17-motion-sync');
    await p.evaluate(() => window.mochi.settled());
    await p.evaluate(() => window.mochiEditor.keymap.run('model.motionSync'));
    await p.getByTestId('motion-sync').waitFor();
    expect(
      await p
        .locator('[data-setting]')
        .evaluateAll((e) => e.map((x) => (x as HTMLElement).dataset.setting)),
    ).toEqual(['Mouth', 'Soft']);
    const mouth = () =>
      p.evaluate(
        () => window.mochi.get('@msync~Mouth') as { shapes: number[][]; blendRatio: number },
      );
    // A shape cell: A's mouth opening.
    await p.getByTestId('ms-shape-A-ParamMouthOpenY').fill('0.75');
    await p.keyboard.press('Tab');
    await poll(async () => (await mouth()).shapes[1]![0]).toBe(0.75);
    // From pose: O's row from the sliders.
    await p.evaluate(() => window.mochi.setPose({ ParamMouthOpenY: 0.4, ParamMouthForm: -0.5 }));
    await p.getByTestId('ms-from-pose-O').click();
    await poll(async () => (await mouth()).shapes[5]).toEqual([0.4, -0.5]);
    await p.getByTestId('ms-blend').fill('0.5');
    await p.keyboard.press('Tab');
    await poll(async () => (await mouth()).blendRatio).toBe(0.5);
    // Each change is one undo.
    const n = await p.evaluate(() => window.mochi.history().length);
    await p.evaluate(() => window.mochiEditor.editor.undo());
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(n - 1);
    await poll(async () => (await mouth()).blendRatio).toBe(0);
    // Adding a setting drives the mouth parameters by default.
    await p.getByTestId('ms-add').click();
    await poll(() => p.locator('[data-setting]').count()).toBe(3);
    expect(
      await p.evaluate(
        () => (window.mochi.get('@msync~"Mouth 2"') as { parameters: unknown[] }).parameters.length,
      ),
    ).toBe(2);
    // …at typical vowel shapes, which the dialog calls a starting point.
    expect(
      await p.evaluate(
        () => (window.mochi.get('@msync~"Mouth 2"') as { shapes: number[][] }).shapes,
      ),
    ).toEqual([
      [0, 0],
      [1, 0],
      [0.3, 1],
      [0.4, -1],
      [0.6, 0.5],
      [0.8, -0.6],
    ]);
    expect(await p.getByTestId('ms-shapes-hint').textContent()).toMatch(/starting point/);
    await p.locator('[data-setting="Mouth"]').click();
    // The preview: an «a» opens the mouth.
    await p.evaluate(() => window.mochi.setPose({ ParamMouthOpenY: 0, ParamMouthForm: 0 }));
    await p.evaluate(() => window.mochi.settled());
    const rate = 16000;
    await p.getByTestId('ms-wav').setInputFiles({
      name: 'a.wav',
      mimeType: 'audio/wav',
      buffer: wav(synthesizeVowel([750, 1250, 2600], 1.5, rate), rate),
    });
    await poll(() => p.getByTestId('ms-status').textContent()).toMatch(/Playing a.wav/);
    await poll(() =>
      p.evaluate(() => window.mochiEditor.viewport.model!.runtime.getParameter('ParamMouthOpenY')),
    ).toBeGreaterThan(0.3);
    expect(await p.locator('.ms-bar').count()).toBe(6);
    await p.getByTestId('ms-stop').click();
    // The preview applies each parameter's smooth % (the file's smoothing, which Mochi2D leaves
    // off by default), and says so: at 100 the mouth stays where it started.
    expect(await p.getByTestId('ms-preview-note').textContent()).toMatch(/applies each parameter/);
    await p.getByTestId('ms-smooth-ParamMouthOpenY').fill('100');
    await p.keyboard.press('Tab');
    await poll(() =>
      p.evaluate(() =>
        (window.mochi.get('@msync~Mouth') as { parameters: { smooth: number }[] }).parameters.map(
          (q) => q.smooth,
        ),
      ),
    ).toContain(100);
    await p.evaluate(() => window.mochi.setPose({ ParamMouthOpenY: 0, ParamMouthForm: 0 }));
    await p.evaluate(() => window.mochi.settled());
    await p.getByTestId('ms-wav').setInputFiles({
      name: 'held.wav',
      mimeType: 'audio/wav',
      buffer: wav(synthesizeVowel([750, 1250, 2600], 1.5, rate), rate),
    });
    await poll(() => p.getByTestId('ms-status').textContent()).toMatch(/Playing held.wav/);
    const most = await p.evaluate(async () => {
      let m = 0;
      const end = performance.now() + 1200;
      while (performance.now() < end) {
        const rt = window.mochiEditor.viewport.model?.runtime;
        if (rt) m = Math.max(m, rt.getParameter('ParamMouthOpenY'));
        await new Promise((r) => requestAnimationFrame(r));
      }
      return m;
    });
    expect(most).toBeLessThan(0.05);
    await p.getByTestId('ms-stop').click();
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('gives a motion a sound and a motion-sync setting in the timeline', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-17-motion-sync');
    await p.evaluate(() => window.mochi.settled());
    await p.evaluate(() =>
      window.mochiEditor.editor.transact('New motion', [
        { name: 'motion.create', args: { name: 'talk', group: 'Talk', duration: 1.2 } },
      ]),
    );
    await p.getByTestId('workspace-switcher').selectOption('animation');
    await p.locator('[data-motion="talk"]').click();
    // Without a sound, the motion-sync choice waits.
    expect(await p.getByTestId('motion-sync').isDisabled()).toBe(true);
    const rate = 16000;
    await p.getByTestId('motion-sound-file').setInputFiles({
      name: 'a.wav',
      mimeType: 'audio/wav',
      buffer: wav(synthesizeVowel([750, 1250, 2600], 1.2, rate), rate),
    });
    const motion = () =>
      p.evaluate(() => {
        const m = window.mochi.get('@motion~talk') as { sound: string | null; motionSync: string };
        const s = m.sound ? (window.mochi.get(m.sound) as { name: string }).name : null;
        const ms = m.motionSync ? (window.mochi.get(m.motionSync) as { name: string }).name : null;
        return { sound: s, motionSync: ms };
      });
    await poll(motion).toEqual({ sound: 'a', motionSync: null });
    await poll(() => p.getByTestId('motion-sync').isEnabled()).toBe(true);
    await p.getByTestId('motion-sync').selectOption({ label: 'Motion sync: Soft' });
    await poll(motion).toEqual({ sound: 'a', motionSync: 'Soft' });
    // One undo goes back to lip sync.
    await p.evaluate(() => window.mochiEditor.editor.undo());
    await poll(motion).toEqual({ sound: 'a', motionSync: null });
    expect(errors).toEqual([]);
  });
});
