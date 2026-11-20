/**
 * The packaged app's smoke test, for CI's desktop builds on Windows, macOS and Linux:
 * the app from out/ starts, opens golden 1's project folder, exports it, and quits. The dialogs are
 * answered by MOCHI_DESKTOP_PICKS, and the app is driven through Playwright's Electron driver.
 *
 * Usage: node smoke.mjs [platform] [arch]  (defaults: this machine's). Prints each step's time and
 * exits non-zero on any failure.
 */
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? process.arch;
const folder = join(here, 'out', `Mochi Maker-${platform}-${arch}`);
const GOLDEN = join(here, '..', 'export', 'test', 'golden', 'golden-1-keyforms.mochi');

/** The packaged executable: mochi-maker(.exe), or the binary inside the macOS app bundle. */
async function executable() {
  if (platform === 'win32') return join(folder, 'mochi-maker.exe');
  if (platform === 'darwin') {
    const bundle = (await readdir(folder)).find((f) => f.endsWith('.app'));
    if (!bundle) throw new Error(`No .app bundle in ${folder}`);
    const macos = join(folder, bundle, 'Contents', 'MacOS');
    const [bin] = await readdir(macos);
    return join(macos, bin);
  }
  return join(folder, 'mochi-maker');
}

const t0 = Date.now();
const step = (what) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);
async function until(what, fn, timeout = 60_000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const work = await mkdtemp(join(tmpdir(), 'mochi-smoke-'));
let app;
let failureLog = [];
try {
  const exe = await executable();
  if (!existsSync(exe)) throw new Error(`The packaged app is missing: ${exe}`);
  // The notices and license texts ship with every package.
  for (const f of [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'ASSETS.md',
    'mochi2d.THIRD_PARTY_NOTICES.md',
  ])
    if (!existsSync(join(folder, 'licenses', f))) throw new Error(`licenses/${f} is missing`);
  step('notices and license texts are in licenses/');
  const project = join(work, 'Square.mochi');
  const out = join(work, 'export');
  await cp(GOLDEN, project, { recursive: true });
  step(`starting ${exe}`);
  app = await _electron.launch({
    executablePath: exe,
    // Linux CI has no display: Ozone's headless platform and software GL.
    args: [
      ...(platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []),
      // Software GL where the runner has no usable GPU (Linux; MOCHI_SMOKE_SOFTWARE_GL=1).
      ...(platform === 'linux' || process.env.MOCHI_SMOKE_SOFTWARE_GL === '1'
        ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : []),
    ],
    env: {
      ...process.env,
      MOCHI_DESKTOP_HIDDEN: '1',
      MOCHI_DESKTOP_USER_DATA: join(work, 'user-data'),
      MOCHI_DESKTOP_PICKS: JSON.stringify([project, out]),
      MOCHI_DESKTOP_BRIDGE_PORT: '0',
    },
    timeout: 120_000,
  });
  // What the app says, for a failure's diagnosis.
  const log = [];
  app.process().stderr?.on('data', (d) => log.push(`[main] ${String(d).trimEnd()}`));
  app.process().stdout?.on('data', (d) => log.push(`[main] ${String(d).trimEnd()}`));
  app.process().on('exit', (code, signal) => log.push(`[exit] code ${code}, signal ${signal}`));
  failureLog = log;
  // A first start can be slow (a new executable is scanned on Windows runners).
  const page = await app.firstWindow({ timeout: 120_000 });
  page.on('console', (m) => log.push(`[page ${m.type()}] ${m.text()}`));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1400, 900);
    w.showInactive();
  });
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    log.push(`[page error] ${e.message}`);
  });
  step(`window: ${page.url()}`);
  await page.waitForFunction(() => window.mochi !== undefined, null, { timeout: 120_000 });
  step(`started: ${page.url()}`);
  // Glue and blend-shape authoring are off by default in every build.
  const features = await page.evaluate(() => ({
    ...window.mochiEditor.editor.features,
    glueCreate: window.mochi.describe('glue.create').available,
  }));
  if (features.glue !== false || features.blendShapes !== false || features.glueCreate !== false)
    throw new Error(`The feature flags are not off by default: ${JSON.stringify(features)}`);
  step('glue and blend shapes are off by default');
  const run = (id) => page.evaluate((i) => window.mochiEditor.keymap.run(i), id);
  // Open the project folder (the first pick).
  await run('file.openFolder');
  await until('the project opens', async () =>
    page.evaluate(() => window.mochiEditor.editor.name === 'Square'),
  );
  const meshes = await page.evaluate(
    () => window.mochi.query({ kind: 'artMesh', fields: ['uid'], limit: 1000 }).items.length,
  );
  step(`opened golden 1: ${meshes} art mesh(es)`);
  // Export into a folder (the second pick).
  await run('file.exportMoc');
  const files = ['golden1.moc3', 'golden1.model3.json', 'golden1.cdi3.json'];
  await until('the export is written', () => files.every((f) => existsSync(join(out, f))));
  const moc = await stat(join(out, 'golden1.moc3'));
  step(`exported: ${(await readdir(out)).join(', ')} (moc3 ${moc.size} bytes)`);
  if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
  // Quit: the app exits on its own after the last window closes.
  const exited = new Promise((r) => app.process().once('exit', r));
  await app.evaluate(({ app: a }) => a.quit());
  let timer;
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The app did not quit')), 30_000);
    }),
  ]).finally(() => clearTimeout(timer));
  app = undefined;
  step('quit');
  console.log('Smoke test passed.');
} catch (e) {
  console.error(e);
  if (failureLog.length) console.error(`What the app said:\n${failureLog.join('\n')}`);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
