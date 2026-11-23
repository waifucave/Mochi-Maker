// Builds the desktop app into app/: the main process (ESM) and the preload (CommonJS, as a
// sandboxed preload must be) bundled with Vite, the editor's build as the renderer, and the
// notices and license texts in licenses/ (package.mjs also puts them next to the executable).
import { build } from 'vite';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { APP_VERSION } from './identity.mjs';
import { ICON_DIR, buildIcons } from './icons.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const app = `${here}app`;
const external = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

await rm(app, { recursive: true, force: true });
await mkdir(app, { recursive: true });
const lib = (entry, fileName, format) =>
  build({
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir: app,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      ssr: true,
      lib: { entry: `${here}src/${entry}`, formats: [format], fileName: () => fileName },
      rollupOptions: { external },
    },
    ssr: { noExternal: true },
  });
// The app icon, from its one source (icons.mjs): icons/ for the packager, and the window's own.
await buildIcons();
await cp(`${ICON_DIR}/icon-512.png`, `${app}/icon.png`);
await lib('main.ts', 'main.js', 'es');
await lib('preload.ts', 'preload.cjs', 'cjs');
// The editor, built by its own config (npm run build:editor).
await cp(`${here}../editor/dist`, `${app}/renderer`, { recursive: true });
// Mochi Maker's license and notices, and the license text of every package the app carries
// (THIRD_PARTY_NOTICES.md lists them), with Mochi2D's own notices for the code its build includes.
const root = `${here}../../`;
const licenses = `${app}/licenses`;
await mkdir(licenses, { recursive: true });
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'ASSETS.md', 'TERMS.md'])
  await cp(`${root}${f}`, `${licenses}/${f}`);
const BUNDLED = [
  '@sinclair/typebox',
  'ag-psd',
  'pako',
  'base64-js',
  'fast-png',
  'iobuffer',
  'fflate',
  'ws',
  'mochi2d',
  'mp4-muxer',
];
for (const name of BUNDLED) {
  const dir = `${root}node_modules/${name}`;
  const text = (await readdir(dir)).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  if (!text) throw new Error(`no license text in ${dir}`);
  await cp(`${dir}/${text}`, `${licenses}/${name.replace('@', '').replace('/', '-')}.LICENSE.txt`);
}
await cp(
  `${root}node_modules/mochi2d/THIRD_PARTY_NOTICES.md`,
  `${licenses}/mochi2d.THIRD_PARTY_NOTICES.md`,
);
await writeFile(
  `${app}/package.json`,
  JSON.stringify(
    {
      name: 'mochi-maker',
      productName: 'Mochi Maker',
      // Mochi Maker's version (identity.mjs: the root package.json's).
      version: APP_VERSION,
      // Windows packages need an author (the executable's company name).
      author: 'Mochi Maker contributors',
      type: 'module',
      main: 'main.js',
    },
    null,
    2,
  ),
);
console.log('built', app);
