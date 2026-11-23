/**
 * Model import in the editor (File › Import Model…), with the shipped defaults (glue and blend
 * shapes off): the notice shows once with «Got it», a model folder opens as a new project, the
 * import report says what the model uses, the Project palette shows where it came from, the glue
 * stays (read-only, with a notice) and the export is refused while glue is off. The folder is a
 * model of the conformance pack (Mochi Maker's own export of golden 5). Headless Chromium through
 * Playwright; skipped where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { buildEditor, launch, serve, type Browser, type Page } from './harness.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
/** For what follows a command that builds or exports: the condition, with room for a slow run. */
const POLL = { timeout: 30_000 };
const MODEL = join(import.meta.dirname, '../../../conformance/golden-5-glue/v5/model');
let browser: Browser | null = null;
let server: Server | undefined;
let url = '';

beforeAll(async () => {
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

/**
 * Waits for the page's next model import to finish (with its report or a refusal), however long
 * it takes, and returns how long it took: an import waits behind the preview build of the one
 * before, which under load took up to about 0.9 s here. What follows an import is then checked
 * at once, not polled for a time.
 */
async function imported(p: Page, before: number): Promise<number> {
  const t = Date.now();
  await p.waitForFunction((n) => window.mochiEditor.importsDone() > n, before, {
    timeout: 120_000,
  });
  return Date.now() - t;
}
const importsDone = (p: Page) => p.evaluate(() => window.mochiEditor.importsDone());

describe('model import in the editor', () => {
  it('shows the notice once, opens the folder as a project, and reports what it uses', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    // The notice, with «Got it»; then the folder dialog.
    await p.evaluate(() => window.mochiEditor.keymap.run('file.importModel'));
    expect(await p.getByTestId('model-notice').textContent()).toBe(
      "You are opening a finished model for editing. Do this only with models you made or have permission to edit. The model's terms of use still apply.",
    );
    expect(
      await p.locator('[data-testid="model-notice-dialog"] input[type=checkbox]').count(),
    ).toBe(0);
    const [chooser] = await Promise.all([
      p.waitForEvent('filechooser'),
      p.getByTestId('model-notice-ok').click(),
    ]);
    let done = await importsDone(p);
    await chooser.setFiles(MODEL);
    await imported(p, done++);
    expect(await p.getByTestId('import-report').count()).toBe(1);
    const report = (await p.getByTestId('import-report').textContent())!;
    expect(report).toMatch(/Imported golden5\.model3\.json \(\.moc3 version 5\)/);
    expect(report).toMatch(
      /This model uses glue\. The project keeps it, and it does not export while the glue feature is off\./,
    );
    expect(await p.evaluate(() => window.mochiEditor.editor.name)).toBe('golden5');
    // Escape closes the report: it has the focus after the folder dialog.
    await p.keyboard.press('Escape');
    expect(await p.getByTestId('import-report').count()).toBe(0);
    // Where it came from, in the Project palette.
    await p.evaluate(() => window.mochiEditor.dock.show('project'));
    await expect.poll(() => p.getByTestId('project-origin').count(), POLL).toBe(1);
    expect(await p.getByTestId('project-origin').textContent()).toMatch(
      /Imported from a \.moc3.*version 5/,
    );
    // The glue stays, read-only, and the export is refused while glue is off.
    await p.evaluate(() => window.mochi.settled());
    const glue = await p.evaluate(
      () => window.mochiEditor.editor.view.ofKind('glue')[0]!.uid as string,
    );
    await p.evaluate((u) => window.mochiEditor.editor.select(u), glue);
    expect(await p.getByTestId('feature-off').textContent()).toBe(
      'Glue is not available in this build.',
    );
    await p.evaluate(() => window.mochiEditor.keymap.run('file.exportMoc'));
    await expect
      .poll(() => p.getByTestId('status').textContent(), POLL)
      .toMatch(/Glue is not available in this build\./);
    // The second import: no notice, straight to the folder dialog.
    const [again] = await Promise.all([
      p.waitForEvent('filechooser'),
      p.evaluate(() => window.mochiEditor.keymap.run('file.importModel')),
    ]);
    expect(await p.getByTestId('model-notice').count()).toBe(0);
    await again.setFiles(MODEL);
    await imported(p, done++);
    expect(await p.getByTestId('import-report').count()).toBe(1);
    // An import while a report is still open replaces it: one report, the new one.
    await p.evaluate(() =>
      document.querySelector('[data-testid="import-report"]')!.setAttribute('data-old', ''),
    );
    const [third] = await Promise.all([
      p.waitForEvent('filechooser'),
      p.evaluate(() => window.mochiEditor.keymap.run('file.importModel')),
    ]);
    await third.setFiles(MODEL);
    await imported(p, done++);
    expect(await p.locator('[data-testid="import-report"][data-old]').count()).toBe(0);
    expect(await p.getByTestId('import-report').count()).toBe(1);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
