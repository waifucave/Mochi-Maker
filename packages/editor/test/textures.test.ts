/**
 * Textures and pictures from others in the editor (docs/limits.md): a model whose texture is past
 * the caps, or lies about its size, is refused at import with words that say which; a project
 * holding such a picture is refused by the preview and by the offscreen renderer (the bridge's
 * renders), before Mochi2D sees it; and what Mochi2D warns about the shown model reaches the
 * message bar. Headless Chromium through Playwright; skipped where Chromium is missing, except
 * in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIE, PAST } from '../../api/test/crafted.js';
import {
  GOLDEN_DIR,
  buildEditor,
  folderFiles,
  launch,
  openFiles,
  openGolden,
  serve,
  type Browser,
} from './harness.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
const MODEL = join(import.meta.dirname, '../../../conformance/golden-5-glue/v5/model');
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

/** The conformance pack's model of golden 5, its texture replaced, in a new folder. */
function craftedModel(texture: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-model-'));
  for (const f of readdirSync(MODEL, { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue;
    const rel = join(f.parentPath, f.name).slice(MODEL.length + 1);
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const bytes = readFileSync(join(MODEL, rel));
    writeFileSync(join(dir, rel), rel.endsWith('.png') ? texture : bytes);
  }
  return dir;
}

async function page() {
  const p = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${url}?nohome`);
  await p.waitForFunction(() => window.mochi !== undefined);
  return { p, errors };
}

const status = (p: Awaited<ReturnType<typeof page>>['p']) => p.getByTestId('status').textContent();

describe('textures from others in the editor', () => {
  it('refuses a model whose texture is past the caps, or lies about its size', async () => {
    if (!browser) return;
    const { p, errors } = await page();
    for (const [texture, words] of [
      [PAST, /too large: 20000 × 1000 pixels, more than the 16384 pixels a side/],
      [LIE, /damaged or crafted: its image data holds less than the 8000 × 8000 pixels/],
    ] as const) {
      const [chooser] = await Promise.all([
        p.waitForEvent('filechooser'),
        (async () => {
          await p.evaluate(() => window.mochiEditor.keymap.run('file.importModel'));
          if (await p.getByTestId('model-notice-ok').count())
            await p.getByTestId('model-notice-ok').click();
        })(),
      ]);
      // Wait for the import itself (with its refusal), then check what it left.
      const before = await p.evaluate(() => window.mochiEditor.importsDone());
      await chooser.setFiles(craftedModel(texture));
      await p.waitForFunction((n) => window.mochiEditor.importsDone() > n, before, {
        timeout: 120_000,
      });
      expect(await status(p)).toMatch(words);
      expect(await p.getByTestId('import-report').count()).toBe(0);
    }
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('refuses a project holding such a picture in the preview and the offscreen renderer', async () => {
    if (!browser) return;
    const { p, errors } = await page();
    const files = await folderFiles(join(GOLDEN_DIR, 'golden-3-drawing.mochi'));
    const asset = Object.keys(files).find((k) => k.startsWith('assets/') && k.endsWith('.png'))!;
    files[asset] = PAST;
    await openFiles(p, files, 'golden-3-drawing');
    await expect.poll(() => status(p), { timeout: 30_000 }).toMatch(/too large: 20000 × 1000/);
    expect(await p.evaluate(() => window.mochiEditor.viewport.error)).toMatch(/too large/);
    const offscreen = await p.evaluate(async () => {
      const ed = window.mochiEditor;
      return ed.offscreen
        .render(ed.editor.session.doc, { width: 64, height: 64 })
        .then(() => 'rendered')
        .catch((e: Error) => e.message);
    });
    expect(offscreen).toMatch(/too large: 20000 × 1000 pixels/);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('tells the person what Mochi2D warns about the shown model, once', async () => {
    if (!browser) return;
    const { p, errors } = await page();
    await openGolden(p, 'golden-13-sound');
    await p.evaluate(() => window.mochi.settled());
    const told = await p.evaluate(() => {
      const ed = window.mochiEditor;
      const vp = ed.viewport;
      const seen: string[] = [];
      ed.editor.on('message', (m: { text: string }) => seen.push(m.text));
      const w = vp.view.model!.warnings as string[];
      w.push('motions/idle.motion3.json: its sound sounds/voice.mp3 is not a WAV file');
      vp.reportWarnings();
      vp.reportWarnings();
      return { seen, bar: document.querySelector('[data-testid="status"]')!.textContent };
    });
    expect(told.seen.filter((t) => t.startsWith('The preview: '))).toHaveLength(1);
    expect(told.bar).toMatch(/The preview: motions\/idle\.motion3\.json: its sound .* not a WAV/);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
