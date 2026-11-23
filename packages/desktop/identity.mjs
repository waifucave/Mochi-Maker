import rootPackage from '../../package.json' with { type: 'json' };

// The desktop app's identity, in one place: the build (build.mjs), the packager (package.mjs) and
// the main process (src/identity.ts) read it. The product name, «Mochi Maker», is not here and does not
// change: the data folder (userData) follows it.

/** The app identifier: the macOS bundle ID (helpers derive from it) and the Windows AppUserModelID. */
export const APP_ID = 'com.waifucave.mochimaker';

/** The macOS App Store category (LSApplicationCategoryType). */
export const MAC_CATEGORY = 'public.app-category.graphics-design';

/**
 * The app's version: the root package.json's, Mochi Maker's one version. The build writes it into
 * the app's package.json (Electron's app.getVersion(), the macOS About panel), and the packager
 * into the macOS bundle and the Windows file properties. A release tag must be v plus this
 * (the Desktop workflow checks it before anything is published). It is imported, not read at run
 * time, so the main process's bundle carries it.
 */
export const APP_VERSION = rootPackage.version;
