/**
 * The desktop app's identifier (identity.mjs): the packager gives it to macOS as the bundle ID, and
 * the main process sets it as the Windows AppUserModelID before any window. The product name is
 * not part of it, so the data folder stays where it is. The packaged app is checked by smoke.mjs
 * on each system (macOS: the Info.plist of the app and its helpers; Windows: the call made).
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ID, MAC_CATEGORY } from '../identity.mjs';
import { applyIdentity } from '../src/identity.js';

const DESKTOP = join(import.meta.dirname, '..');

describe('the app identifier', () => {
  it('is com.waifucave.mochimaker, with a macOS category', () => {
    expect(APP_ID).toBe('com.waifucave.mochimaker');
    expect(MAC_CATEGORY).toBe('public.app-category.graphics-design');
  });

  it('is set as the AppUserModelID on Windows only', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const calls: string[] = [];
      const r = applyIdentity({ setAppUserModelId: (id) => calls.push(id) }, platform);
      expect(calls).toEqual(platform === 'win32' ? [APP_ID] : []);
      expect(r).toBe(platform === 'win32' ? APP_ID : null);
    }
  });

  it('goes to the packager as the bundle ID, and the product name stays', async () => {
    const pkg = await readFile(join(DESKTOP, 'package.mjs'), 'utf8');
    expect(pkg).toMatch(/appBundleId: APP_ID,/);
    expect(pkg).toMatch(/appCategoryType: MAC_CATEGORY,/);
    expect(pkg).not.toMatch(/helperBundleId/); // the helpers derive from the bundle ID
    expect(pkg).toMatch(/name: 'Mochi Maker',/);
    const main = await readFile(join(DESKTOP, 'src/main.ts'), 'utf8');
    expect(main).toMatch(/applyIdentity\(app\)/);
    expect(main).not.toMatch(/setName\(/);
    const build = await readFile(join(DESKTOP, 'build.mjs'), 'utf8');
    expect(build).toMatch(/productName: 'Mochi Maker',/);
  });
});
