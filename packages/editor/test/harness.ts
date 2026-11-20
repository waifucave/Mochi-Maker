/**
 * Browser-test harness: builds the editor with Vite, serves it on a local port, and drives it in
 * headless Chromium through Playwright (the pre-installed one, or npm's global package, as Mochi2D
 * finds it). Projects are opened from their folders as the editor's zip input would.
 */
import { createServer, type Server } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const EDITOR_DIR = join(here, '..');
export const GOLDEN_DIR = join(here, '../../export/test/golden');

type Playwright = typeof import('playwright-core');
export type Browser = Awaited<ReturnType<Playwright['chromium']['launch']>>;
export type Page = Awaited<ReturnType<Browser['newPage']>>;

const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--force-color-profile=srgb',
];

export function loadPlaywright(): Playwright | null {
  const req = createRequire(import.meta.url);
  const global = join(dirname(dirname(process.execPath)), 'lib', 'node_modules');
  const candidates = [
    process.env.MOCHI2D_PLAYWRIGHT,
    'playwright',
    join(global, 'playwright'),
    'playwright-core',
  ];
  for (const c of candidates)
    if (c)
      try {
        return req(c) as Playwright;
      } catch {
        /* next */
      }
  return null;
}

export async function launch(
  extraArgs: string[] = [],
  options: { features?: boolean } = {},
): Promise<Browser | null> {
  const pw = loadPlaywright();
  if (!pw) return null;
  let browser: Browser;
  try {
    browser = await pw.chromium.launch({ args: [...CHROMIUM_ARGS, ...extraArgs] });
  } catch {
    const exe = process.env.MOCHI2D_CHROMIUM ?? '/opt/pw-browsers/chromium';
    if (!existsSync(exe)) return null;
    browser = await pw.chromium.launch({
      args: [...CHROMIUM_ARGS, ...extraArgs, '--headless', '--no-sandbox'],
      executablePath: exe,
    });
  }
  return options.features === false ? browser : withFeatures(browser);
}

/**
 * The tests run with glue and blend-shape authoring on, as the editor's settings switch them on:
 * every new page gets them in its stored settings before the editor starts.
 */
function withFeatures(browser: Browser): Browser {
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args: Parameters<Browser['newPage']>) => {
    const page = await newPage(...args);
    await page.addInitScript(() => {
      try {
        const key = 'mochi-maker.settings';
        const s = JSON.parse(localStorage.getItem(key) ?? '{}');
        localStorage.setItem(
          key,
          JSON.stringify({ ...s, featureGlue: true, featureBlendShapes: true }),
        );
      } catch {
        /* no storage: the features stay off */
      }
    });
    return page;
  };
  return browser;
}

/** Builds the editor into dist/ (once per test run). */
export async function buildEditor(): Promise<string> {
  const { build } = await import('vite');
  await build({
    root: EDITOR_DIR,
    configFile: join(EDITOR_DIR, 'vite.config.ts'),
    logLevel: 'warn',
  });
  return join(EDITOR_DIR, 'dist');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
};

export async function serve(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const path = join(
      dir,
      decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/\/$/, '/index.html'),
    );
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, server };
}

/** A folder's files, path → bytes. */
export async function folderFiles(dir: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const walk = async (d: string) => {
    for (const name of await readdir(d)) {
      const p = join(d, name);
      if ((await stat(p)).isDirectory()) await walk(p);
      else out[relative(dir, p).split('\\').join('/')] = new Uint8Array(await readFile(p));
    }
  };
  await walk(dir);
  return out;
}

/** Opens a golden project in the page through the editor's own open path. */
export async function openGolden(page: Page, name: string): Promise<void> {
  await openFolder(page, join(GOLDEN_DIR, `${name}.mochi`), name);
}

/** Opens a project folder in the page. */
export async function openFolder(page: Page, dir: string, name: string): Promise<void> {
  await openFiles(page, await folderFiles(dir), name);
}

export async function openFiles(
  page: Page,
  files: Record<string, Uint8Array>,
  name: string,
): Promise<void> {
  const plain = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
  );
  await page.evaluate(
    async ({ plain, name }) => {
      const files = Object.fromEntries(
        Object.entries(plain).map(([k, v]) => [
          k,
          Uint8Array.from(atob(v), (c) => c.charCodeAt(0)),
        ]),
      );
      await window.mochiEditor.openFiles(files, name);
    },
    { plain, name },
  );
}
