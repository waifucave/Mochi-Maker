/**
 * The desktop app end to end: the built app started in Electron (headless, through
 * Playwright's Electron driver), with the dialogs driven by MOCHI_DESKTOP_PICKS. It opens a
 * project folder, saves it straight to disk, exports to a folder, imports and live-links art,
 * auto-saves, recovers after the app is killed, connects the bridge in the main process, and
 * keeps the page sandboxed. Skipped where the Electron binary is missing (it is downloaded by
 * npm install), unless MOCHI_MAKER_REQUIRE_DESKTOP=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const DESKTOP = join(here, '..');
const GOLDEN = join(here, '../../export/test/golden');
const require = createRequire(import.meta.url);

function electronPath(): string | null {
  try {
    const p = require('electron') as unknown as string;
    return typeof p === 'string' && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const exe = electronPath();
const required = process.env.MOCHI_MAKER_REQUIRE_DESKTOP === '1';

type ElectronApp = Awaited<ReturnType<(typeof import('playwright-core'))['_electron']['launch']>>;
type Page = Awaited<ReturnType<ElectronApp['firstWindow']>>;

let work: string;

beforeAll(async () => {
  if (!exe) {
    if (required) throw new Error('The Electron binary is required but missing.');
    return;
  }
  // The editor's build, then the desktop app around it.
  const { build } = await import('vite');
  const editor = join(here, '../../editor');
  await build({ root: editor, configFile: join(editor, 'vite.config.ts'), logLevel: 'warn' });
  execFileSync(process.execPath, [join(DESKTOP, 'build.mjs')], { stdio: 'ignore' });
  work = await mkdtemp(join(tmpdir(), 'mochi-desktop-e2e-'));
}, 300_000);

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

/** The Linux build from `npm run package:linux -w @mochi-maker/desktop`, when it is there. */
const PACKAGED = join(DESKTOP, 'out', 'Mochi Maker-linux-x64', 'mochi-maker');

async function start(
  userData: string,
  picks: (string | null)[] = [],
  env: Record<string, string> = {},
  packaged = false,
): Promise<{ app: ElectronApp; page: Page; errors: string[] }> {
  const { _electron } = await import('playwright-core');
  const app = await _electron.launch({
    executablePath: packaged ? PACKAGED : exe!,
    args: [
      '--no-sandbox',
      '--ozone-platform=headless',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      ...(packaged ? [] : [join(DESKTOP, 'app')]),
    ],
    env: {
      ...process.env,
      MOCHI_DESKTOP_HIDDEN: '1',
      MOCHI_DESKTOP_USER_DATA: userData,
      MOCHI_DESKTOP_PICKS: JSON.stringify(picks),
      MOCHI_DESKTOP_BRIDGE_PORT: '0',
      ...env,
    },
  });
  const page = await app.firstWindow();
  // Headless Ozone leaves the window at 1×1 until it is sized and shown (nothing is on a screen).
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setSize(1400, 900);
    w.showInactive();
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => window.mochi !== undefined, null, { timeout: 60_000 });
  return { app, page, errors };
}

const run = (p: Page, id: string) => p.evaluate((i) => window.mochiEditor.keymap.run(i), id);
const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 30_000 });

describe.skipIf(!exe && !required)('the desktop app', () => {
  it('opens, saves to disk, exports, live-links art, and keeps the page sandboxed', async () => {
    const project = join(work, 'Square.mochi');
    await cp(join(GOLDEN, 'golden-1-keyforms.mochi'), project, { recursive: true });
    const out = join(work, 'export');
    const art = join(work, 'art.png');
    await cp(join(GOLDEN, 'golden-1-keyforms.mochi', 'assets'), join(work, 'assets-copy'), {
      recursive: true,
    });
    const png = (await readdir(join(work, 'assets-copy')))[0]!;
    await cp(join(work, 'assets-copy', png), art);
    // The fourth pick answers the question on close: the art import left unsaved work.
    const { app, page, errors } = await start(join(work, 'data1'), [project, out, art, 'discard']);
    // No Node in the page, only the preload's API.
    expect(await page.evaluate(() => typeof (window as { require?: unknown }).require)).toBe(
      'undefined',
    );
    expect(await page.evaluate(() => typeof (window as { process?: unknown }).process)).toBe(
      'undefined',
    );
    expect(await page.evaluate(() => typeof window.mochiDesktop)).toBe('object');
    // Paths not chosen in a dialog are refused.
    expect(
      await page.evaluate(() =>
        window.mochiDesktop!.readArt('/etc/passwd').then(
          () => 'read',
          (e: Error) => e.message,
        ),
      ),
    ).toMatch(/outside the folders chosen/);
    // Open the project folder (the first dialog), change it, save it straight to disk.
    await run(page, 'file.openFolder');
    await poll(() => page.evaluate(() => window.mochiEditor.editor.name)).toBe('Square');
    await page.evaluate(() =>
      window.mochiEditor.editor.transact('Rename', [
        { name: 'object.rename', args: { target: '@mesh:ArtMesh_Square', name: 'Renamed' } },
      ]),
    );
    await run(page, 'file.save');
    await poll(
      async () =>
        JSON.parse(await readFile(join(project, 'meshes', 'mesh_0004.json'), 'utf8')).name,
    ).toBe('Renamed');
    // Export to a folder (the second dialog).
    await run(page, 'file.exportMoc');
    await poll(() => existsSync(join(out, 'golden1.moc3'))).toBe(true);
    // Import art (the third dialog); a change to the file on disk re-imports it.
    await run(page, 'file.importArt');
    await poll(() => page.evaluate(() => window.mochiEditor.link.status.watching)).toBe(true);
    const before = await page.evaluate(() => window.mochi.history().length);
    await writeFile(art, await readFile(join(work, 'assets-copy', png)));
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(art, Buffer.concat([await readFile(art)]));
    // A changed modification time with the same bytes is "unchanged"; the check ran.
    await poll(() => page.evaluate(() => window.mochiEditor.link.status.lastCheck)).toBeGreaterThan(
      0,
    );
    expect(await page.evaluate(() => window.mochi.history().length)).toBeGreaterThanOrEqual(before);
    // The bridge in the main process: the editor is its host.
    await poll(() => page.evaluate(() => window.mochiEditor.host.state)).toBe('connected');
    const b = (await page.evaluate(() => window.mochiDesktop!.bridge())) as { port: number };
    const info = await (await fetch(`http://127.0.0.1:${b.port}/`)).json();
    expect(info).toMatchObject({ studio: { connected: true } });
    // The page cannot navigate away or open windows.
    await page.evaluate(() => {
      window.location.href = 'https://example.com/';
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(page.url()).toBe('mochi://app/index.html');
    expect(errors).toEqual([]);
    await app.close();
  }, 180_000);

  it('auto-saves unsaved work, and offers it after the app is killed', async () => {
    const data = join(work, 'data2');
    const project = join(work, 'Crash.mochi');
    await cp(join(GOLDEN, 'golden-2-deformers.mochi'), project, { recursive: true });
    const first = await start(data, [project]);
    await run(first.page, 'file.openFolder');
    await poll(() => first.page.evaluate(() => window.mochiEditor.editor.name)).toBe('Crash');
    await first.page.evaluate(() =>
      window.mochiEditor.editor.transact('Rename', [
        { name: 'object.rename', args: { target: '@mesh:ArtMesh_Head', name: 'Unsaved' } },
      ]),
    );
    expect(await first.page.evaluate(() => window.mochiEditor.desktop!.autosaveNow())).toBe(true);
    const keys = await readdir(join(data, 'autosave'));
    expect(keys.filter((k) => k !== 'session.lock')).toHaveLength(1);
    // Killed: no clean end, the lock stays.
    first.app.process().kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    const second = await start(data);
    await second.page.locator('[data-testid="recovery"]').waitFor({ timeout: 30_000 });
    await second.page.locator('[data-testid^="recover-"]').first().click();
    await poll(() =>
      second.page.evaluate(
        () => (window.mochi.get('@mesh:ArtMesh_Head') as { name: string } | undefined)?.name,
      ),
    ).toBe('Unsaved');
    // The recovered copy is unsaved work; saving goes back to its folder.
    expect(await second.page.evaluate(() => window.mochiEditor.desktop!.dirty)).toBe(true);
    await run(second.page, 'file.save');
    await poll(
      async () =>
        JSON.parse(
          await readFile(join(project, 'meshes', 'mesh_0007.json'), 'utf8').catch(() => '{}'),
        ).name,
    ).toBe('Unsaved');
    // Saved: the page has told the main process, so closing asks nothing.
    await poll(() => second.page.evaluate(() => window.mochiEditor.desktop!.dirty)).toBe(false);
    expect(second.errors).toEqual([]);
    await second.app.close();
    // A clean close: the next start offers nothing.
    const third = await start(data);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await third.page.locator('[data-testid="recovery"]').count()).toBe(0);
    await third.app.close();
  }, 240_000);

  it('asks before closing with unsaved work: Cancel keeps the window, Save saves then closes', async () => {
    const data = join(work, 'data4');
    const project = join(work, 'Close.mochi');
    await cp(join(GOLDEN, 'golden-1-keyforms.mochi'), project, { recursive: true });
    const { app, page, errors } = await start(data, [project, 'cancel', 'save']);
    await run(page, 'file.openFolder');
    await poll(() => page.evaluate(() => window.mochiEditor.editor.name)).toBe('Close');
    await page.evaluate(() =>
      window.mochiEditor.editor.transact('Rename', [
        { name: 'object.rename', args: { target: '@mesh:ArtMesh_Square', name: 'OnClose' } },
      ]),
    );
    const closeWindow = () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    // Cancel: the window stays, the work too.
    await new Promise((r) => setTimeout(r, 300));
    await closeWindow();
    await new Promise((r) => setTimeout(r, 500));
    expect(await page.evaluate(() => window.mochiEditor.desktop!.dirty)).toBe(true);
    expect(errors).toEqual([]);
    // Save: the page saves to the folder, then the window closes and the app quits.
    const exited = new Promise((r) => app.process().once('exit', r));
    await closeWindow();
    await exited;
    expect(JSON.parse(await readFile(join(project, 'meshes', 'mesh_0004.json'), 'utf8')).name).toBe(
      'OnClose',
    );
    // A clean close: nothing to recover next time.
    expect((await readdir(join(data, 'autosave'))).filter((k) => k !== 'session.lock')).toEqual([]);
  }, 120_000);

  it('starts with glue and blend-shape authoring off', async () => {
    const { app, page } = await start(join(work, 'data-features'));
    expect(await page.evaluate(() => window.mochiEditor.editor.features)).toEqual({
      glue: false,
      blendShapes: false,
    });
    expect(await page.evaluate(() => window.mochi.describe('glue.create').available)).toBe(false);
    await app.close();
  }, 120_000);

  it('imports a model folder chosen in the native dialog, after the notice', async () => {
    const model = join(here, '../../../conformance/golden-1-keyforms/v5/model');
    const { app, page, errors } = await start(join(work, 'data-import'), [model]);
    await page.evaluate(() => window.mochiEditor.keymap.run('file.importModel'));
    await page.getByTestId('model-notice-ok').click();
    await poll(() => page.getByTestId('import-report').count()).toBe(1);
    expect(await page.evaluate(() => window.mochiEditor.editor.name)).toBe('golden1');
    expect(
      await page.evaluate(() => window.mochiEditor.editor.view.project().importedFrom?.mocVersion),
    ).toBe(5);
    // A new project with no folder, and unsaved: closing would ask.
    expect(await page.evaluate(() => window.mochiEditor.desktop!.dir)).toBeNull();
    expect(await page.evaluate(() => window.mochiEditor.desktop!.dirty)).toBe(true);
    expect(errors).toEqual([]);
    // Nothing to ask about on close.
    await page.evaluate(() => {
      const d = window.mochiEditor.desktop!;
      d.saved = window.mochiEditor.editor.session.revision;
      d.report();
    });
    await app.close();
  }, 120_000);

  it("carries the notices and every bundled package's license text", async () => {
    const licenses = await readdir(join(DESKTOP, 'app', 'licenses'));
    expect(licenses.sort()).toEqual([
      'ASSETS.md',
      'LICENSE',
      'TERMS.md',
      'THIRD_PARTY_NOTICES.md',
      'ag-psd.LICENSE.txt',
      'base64-js.LICENSE.txt',
      'fast-png.LICENSE.txt',
      'fflate.LICENSE.txt',
      'iobuffer.LICENSE.txt',
      'mochi2d.LICENSE.txt',
      'mochi2d.THIRD_PARTY_NOTICES.md',
      'mp4-muxer.LICENSE.txt',
      'pako.LICENSE.txt',
      'sinclair-typebox.LICENSE.txt',
      'ws.LICENSE.txt',
    ]);
  });

  it.skipIf(!existsSync(PACKAGED))(
    'the packaged Linux build starts and serves the editor from its archive',
    async () => {
      const { app, page, errors } = await start(join(work, 'data3'), [], {}, true);
      expect(page.url()).toBe('mochi://app/index.html');
      expect(await page.evaluate(() => window.mochiDesktop!.info())).toMatchObject({
        platform: 'linux',
        keep: 5,
      });
      expect(await page.evaluate(() => window.mochiEditor.editor.name)).toBe('Untitled');
      // Glue and blend-shape authoring are off by default in the packaged build too.
      expect(await page.evaluate(() => window.mochiEditor.editor.features)).toEqual({
        glue: false,
        blendShapes: false,
      });
      expect(errors).toEqual([]);
      await app.close();
      // The notices and license texts, next to the executable and inside the app.
      const licenses = await readdir(join(dirname(PACKAGED), 'licenses'));
      expect(licenses).toEqual(
        expect.arrayContaining([
          'LICENSE',
          'THIRD_PARTY_NOTICES.md',
          'ASSETS.md',
          'mochi2d.THIRD_PARTY_NOTICES.md',
          'fflate.LICENSE.txt',
        ]),
      );
    },
    120_000,
  );
});
