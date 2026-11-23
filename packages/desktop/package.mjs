/**
 * Packages the built app (app/, from build.mjs) as an unsigned Mochi Maker for one platform, with
 * @electron/packager, into out/. Usage: node package.mjs [linux|win32|darwin] [x64|arm64].
 * Builds for Windows and macOS are best made on those systems (see docs/desktop.md); nothing here
 * signs or notarizes.
 */
import { packager } from '@electron/packager';
import { cp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID, APP_VERSION, MAC_CATEGORY } from './identity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? process.arch;
if (!existsSync(join(here, 'app', 'main.js'))) {
  console.error('Build the app first: node build.mjs');
  process.exit(1);
}
const electronVersion = JSON.parse(
  await readFile(join(dirname(require.resolve('electron/package.json')), 'package.json'), 'utf8'),
).version;
const paths = await packager({
  dir: join(here, 'app'),
  out: join(here, 'out'),
  name: 'Mochi Maker',
  executableName: 'mochi-maker',
  appVersion: APP_VERSION,
  appCopyright: 'Mochi Maker contributors, MIT License',
  electronVersion,
  platform,
  arch,
  // macOS: the bundle ID; the helpers' IDs derive from it (<id>.helper…, <id>.loginhelper).
  appBundleId: APP_ID,
  // The app icon (build.mjs makes it): the packager takes the .icns on macOS and the .ico on
  // Windows; Linux has none in the file, and the window sets its own (main.ts).
  icon: join(here, 'icons', 'mochi-maker'),
  appCategoryType: MAC_CATEGORY,
  asar: true,
  overwrite: true,
  prune: false,
  win32metadata: {
    CompanyName: 'Mochi Maker contributors',
    ProductName: 'Mochi Maker',
    FileDescription: 'Mochi Maker',
  },
});
// The notices and license texts also sit next to the executable (or the .app), beside Electron's
// own LICENSE and LICENSES.chromium.html.
for (const p of paths) {
  await cp(join(here, 'app', 'licenses'), join(p, 'licenses'), { recursive: true });
  console.log(p);
}
