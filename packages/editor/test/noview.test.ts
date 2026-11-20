/**
 * The editor without WebGL2: Chromium with WebGL turned off, as on a GPU-less virtual
 * machine. The editor still starts, says in the View area why the model is not drawn, and opens,
 * edits, saves and exports. Headless Chromium through Playwright; skipped where Chromium is
 * missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { buildEditor, launch, openGolden, serve, type Browser } from './harness.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
let browser: Browser | null = null;
let server: Server | undefined;
let url = '';

beforeAll(async () => {
  browser = await launch(['--disable-webgl', '--disable-webgl2', '--disable-3d-apis']);
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

describe('without WebGL2', () => {
  it('starts, says why the view is empty, and still opens, edits, saves and exports', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined, null, { timeout: 30_000 });
    expect(await p.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))).toBe(
      false,
    );
    expect(await p.getByTestId('no-view').textContent()).toMatch(/needs WebGL2/);
    await openGolden(p, 'golden-1-keyforms');
    await p.evaluate(() => window.mochi.settled());
    expect(await p.evaluate(() => window.mochiEditor.editor.name)).toBe('golden-1-keyforms');
    // Edit.
    await p.evaluate(() =>
      window.mochiEditor.editor.transact('Rename', [
        { name: 'object.rename', args: { target: '@mesh:ArtMesh_Square', name: 'Renamed' } },
      ]),
    );
    expect(
      await p.evaluate(() => (window.mochi.get('@mesh:ArtMesh_Square') as { name: string }).name),
    ).toBe('Renamed');
    // Save: the project as a zip.
    const [saved] = await Promise.all([
      p.waitForEvent('download'),
      p.evaluate(() => window.mochiEditor.keymap.run('file.save')),
    ]);
    const project = unzipSync(new Uint8Array(await readFile((await saved.path())!)));
    expect(Object.keys(project).some((f) => f.endsWith('mochi-project.json'))).toBe(true);
    // Export: the model's files, checked by Mochi2D in the page (no WebGL needed).
    const [exported] = await Promise.all([
      p.waitForEvent('download'),
      p.evaluate(() => window.mochiEditor.keymap.run('file.exportMoc')),
    ]);
    const model = unzipSync(new Uint8Array(await readFile((await exported.path())!)));
    expect(Object.keys(model)).toEqual(
      expect.arrayContaining(['golden1.moc3', 'golden1.model3.json', 'golden1.cdi3.json']),
    );
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
