/**
 * The app identifier at run time. On Windows the AppUserModelID decides taskbar grouping, pinning
 * and jump lists, so it is set early, before any window. macOS takes the bundle ID from the
 * packaged Info.plist (package.mjs). The product name and the data folder are left alone: no
 * `app.setName`.
 */
import { APP_ID } from '../identity.mjs';

export { APP_ID };

/** Sets the Windows AppUserModelID; returns it, or null on other systems. */
export function applyIdentity(
  app: { setAppUserModelId(id: string): void },
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  app.setAppUserModelId(APP_ID);
  return APP_ID;
}
