// The desktop app's identity, in one place: the packager (package.mjs) and the main process
// (src/identity.ts) both read it. The product name, «Mochi Maker», is not here and does not
// change: the data folder (userData) follows it.

/** The app identifier: the macOS bundle ID (helpers derive from it) and the Windows AppUserModelID. */
export const APP_ID = 'com.waifucave.mochimaker';

/** The macOS App Store category (LSApplicationCategoryType). */
export const MAC_CATEGORY = 'public.app-category.graphics-design';
