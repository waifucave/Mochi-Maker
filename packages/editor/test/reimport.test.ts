/**
 * Re-import in the editor: the live link re-imports the art when it is saved, and the
 * Re-import button does it by hand. The File System Access picker needs a person, so the test
 * links a file object with the same interface (name, getFile) and changes what it returns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { reimportPsd } from '../../art/test/synthetic.js';
import { buildEditor, launch, serve, type Browser, type Page } from './harness.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
const available = await launch().then(async (b) => {
  await b?.close();
  return b !== null;
});

let browser: Browser | null = null;
let server: Server | undefined;
let page: Page;

beforeAll(async () => {
  if (!available) {
    if (required)
      throw new Error('Chromium is required (MOCHI_MAKER_REQUIRE_RENDER=1) but missing.');
    return;
  }
  browser = await launch();
  const s = await serve(await buildEditor());
  server = s.server;
  page = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${s.url}?nohome`);
  await page.waitForFunction(() => window.mochi !== undefined);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 15_000 });
const settled = () => page.evaluate(() => window.mochi.settled());
const history = () => page.evaluate(() => window.mochi.history().map((h) => h.label));
const layers = () =>
  page.evaluate(() =>
    (
      window.mochi.query({ kind: 'layer', fields: ['name'], limit: 100 }).items as {
        name: string;
      }[]
    ).map((l) => l.name),
  );
const psd = (v: 1 | 2) => ({
  name: 'character.psd',
  mimeType: 'image/vnd.adobe.photoshop',
  buffer: Buffer.from(reimportPsd(v)),
});

/** Puts a version of the art "on disk" for the linked file. */
const save = (v: 1 | 2, modified: number) =>
  page.evaluate(
    ({ b64, modified }) => {
      (window as unknown as { art: { bytes: Uint8Array; modified: number } }).art = {
        bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
        modified,
      };
    },
    { b64: Buffer.from(reimportPsd(v)).toString('base64'), modified },
  );

describe.skipIf(!required && !available)('re-import in the editor', () => {
  it('imports art, links it, and re-imports it within about a second of a save', async () => {
    await page.getByTestId('import-art').setInputFiles(psd(1));
    await poll(layers).toEqual(['Body', 'Face', 'Eye', '目']);
    await settled();
    await save(1, 1000);
    await page.evaluate(() =>
      window.mochiEditor.link.link({
        name: 'character.psd',
        getFile: async () => {
          const a = (window as unknown as { art: { bytes: Uint8Array; modified: number } }).art;
          return new File([a.bytes as BlobPart], 'character.psd', { lastModified: a.modified });
        },
      }),
    );
    await poll(() => page.getByTestId('link-status').textContent()).toBe('Linked: character.psd');
    // Linking a file the project already matches changes nothing.
    expect(await history()).toEqual(['Import character.psd']);

    // The person saves the edited PSD.
    const before = await page.evaluate(() => window.mochi.stats().builds.length);
    await save(2, 2000);
    const t0 = Date.now();
    await poll(history).toEqual(['Import character.psd', 'Re-import character.psd (live link)']);
    await settled();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2500); // half-second checks, plus the re-import and the preview
    expect(await page.evaluate((n) => window.mochi.stats().builds.length > n, before)).toBe(true);
    expect(await layers()).toEqual(['Body', 'Face', 'Eye', '目', 'Mouth']);
    // The Art tab shows the report; a re-fit row selects its mesh.
    await poll(() => page.locator('[data-reimport="re-fit"]').count()).toBe(2);
    await page.locator('[data-reimport="re-fit"]').first().click();
    expect(await page.evaluate(() => window.mochi.selection().uid)).toMatch(/^mesh_/);
    expect(await page.locator('[data-reimport="added"]').textContent()).toContain('Head/Mouth');
    expect(await page.locator('[data-reimport="removed"]').textContent()).toContain('目');
    console.log(`live link: saved → re-imported and shown in ${elapsed} ms`);

    // Undo takes the whole re-import back.
    await page.getByTestId('undo').click();
    await settled();
    expect(await layers()).toEqual(['Body', 'Face', 'Eye', '目']);
  }, 60_000);

  it('waits for the person’s drag before re-importing', async () => {
    // The checks are called directly here (the timer is covered above), so the test does not
    // depend on how the page's timers are scheduled on a busy machine.
    const box = (await page.getByTestId('overlay').boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await save(2, 3000);
    expect(await page.evaluate(() => window.mochiEditor.editor.inGesture)).toBe(true);
    expect(await page.evaluate(() => window.mochiEditor.link.check())).toBe(false);
    expect((await history()).at(-1)).not.toBe('Re-import character.psd (live link)');
    await page.mouse.up();
    expect(await page.evaluate(() => window.mochiEditor.editor.inGesture)).toBe(false);
    await poll(async () => {
      await page.evaluate(() => window.mochiEditor.link.check());
      return (await history()).at(-1);
    }).toBe('Re-import character.psd (live link)');
    await settled();
  }, 60_000);

  it('re-imports by hand with the Re-import button', async () => {
    await page.evaluate(() => window.mochiEditor.link.unlink());
    await poll(() => page.getByTestId('link-status').isVisible()).toBe(false);
    await page.getByTestId('reimport-art').setInputFiles(psd(1));
    await poll(async () => (await history()).at(-1)).toBe('Re-import character.psd');
    await settled();
    // Version 1 again: Face back in place, 目 back (matched again, its note cleared); Mouth stays.
    expect(await layers()).toEqual(['Body', 'Face', 'Eye', '目', 'Mouth']);
    const me = await page.evaluate(
      () =>
        (
          window.mochi.query({ kind: 'layer', where: { name: '目' }, fields: ['notes'] })
            .items[0] as { notes: string[] }
        ).notes,
    );
    expect(me).toEqual([]);
  }, 60_000);
});
