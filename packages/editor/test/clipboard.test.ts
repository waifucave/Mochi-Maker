/**
 * Cut, copy and paste of objects: Ctrl+C on a warp copies it with everything below it;
 * Ctrl+V into a selected rotation pastes it there in place, as one undoable step; Ctrl+X removes
 * the originals; the system clipboard carries a copy into another project, which binds parameters
 * by ID and reports the rest. Headless Chromium through Playwright; skipped where Chromium is
 * missing, except in CI's render job.
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
const count = (p: Page, kind: string) =>
  p.evaluate(
    (k) =>
      (window.mochi.query({ kind: k as never }) as unknown as { items: unknown[] }).items.length,
    kind,
  );
const label = (p: Page) => p.evaluate(() => window.mochi.history().at(-1)?.label);
const uid = (p: Page, ref: string) =>
  p.evaluate((r) => (window.mochi.get(r) as { uid: string }).uid, ref);

describe('cut, copy and paste of objects', () => {
  it('copies a warp with its contents, pastes it into a rotation in place, cuts, and undoes', async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    await openGolden(p, 'golden-15-nested-deformers');
    await p.evaluate(() => window.mochi.settled());
    const meshes0 = await count(p, 'artMesh');
    const warps0 = await count(p, 'warp');
    // Warp_Face holds Rotation_Eye and the face, badge and eye meshes.
    await p.evaluate((u) => window.mochi.select(u), await uid(p, '@warp:Warp_Face'));
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+C');
    await poll(() =>
      p.evaluate(() => window.mochiEditor.clipboard.fragment?.roots.length ?? 0),
    ).toBe(1);
    const evalOf = () =>
      p.evaluate(
        () =>
          window.mochi.evaluate() as unknown as { drawables: { id: string; vertices: number[] }[] },
      );
    const faceBefore = (await evalOf()).drawables.find((d) => d.id === 'ArtMesh_Face')!.vertices;
    // Paste into Rotation_Hat: the copies stay where the originals are drawn.
    await p.evaluate((u) => window.mochi.select(u), await uid(p, '@rot:Rotation_Hat'));
    await p.keyboard.press('Control+V');
    await poll(() => label(p)).toBe('Paste 1 object(s)');
    await p.evaluate(() => window.mochi.settled());
    expect(await count(p, 'artMesh')).toBe(meshes0 + 3);
    expect(await count(p, 'warp')).toBe(warps0 + 1);
    const copy = (await p.evaluate(() => window.mochi.get('@warp:Warp_Face_2'))) as {
      parent: string;
    };
    expect(copy.parent).toBe(await uid(p, '@rot:Rotation_Hat'));
    const faceCopy = (await evalOf()).drawables.find((d) => d.id === 'ArtMesh_Face_2')!.vertices;
    faceCopy.forEach((x, i) => expect(x).toBeCloseTo(faceBefore[i]!, 3));
    // The copies are selected; undo takes the paste back in one step.
    expect((await p.evaluate(() => window.mochi.selection())).uid).toBe(
      await uid(p, '@warp:Warp_Face_2'),
    );
    await p.keyboard.press('Control+Z');
    expect(await count(p, 'artMesh')).toBe(meshes0);
    // Cut: copied, and the originals are gone.
    await p.evaluate((u) => window.mochi.select(u), await uid(p, '@warp:Warp_Face'));
    await p.keyboard.press('Control+X');
    await poll(() => count(p, 'artMesh')).toBe(meshes0 - 3);
    await p.keyboard.press('Control+Z');
    expect(await count(p, 'artMesh')).toBe(meshes0);

    // Another project, in another tab: through the system clipboard.
    const q = await ctx.newPage();
    q.on('pageerror', (e) => errors.push(e.message));
    await q.goto(`${url}?nohome`);
    await q.waitForFunction(() => window.mochi !== undefined);
    await openGolden(q, 'golden-1-keyforms');
    await q.evaluate(() => window.mochi.settled());
    const before = await count(q, 'artMesh');
    await q.getByTestId('overlay').focus();
    await q.keyboard.press('Control+V');
    await poll(() => label(q)).toBe('Paste 1 object(s)');
    expect(await count(q, 'artMesh')).toBe(before + 3);
    // golden 1 has no ParamBend or ParamAngle, nor the parent deformer: reported.
    await poll(() => q.getByTestId('status').textContent()).toContain('not bound here');
    const img = (await q.evaluate(() => window.mochi.get('@mesh:ArtMesh_Face'))) as {
      layer: string;
    };
    expect(img.layer).toBeTruthy();
    expect(
      (await q.evaluate(() => window.mochi.validate())) as { violations: unknown[] },
    ).toMatchObject({ violations: [] });
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
