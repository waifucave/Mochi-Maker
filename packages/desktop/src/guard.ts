/**
 * The paths the page may reach (M14): only folders and files the person chose in a
 * native dialog (or opened from the recent list), and the app's own folders. Every path the
 * preload passes in is checked here: absolute, no NUL, resolved through symbolic links, and inside
 * an allowed root.
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class ForbiddenPath extends Error {
  readonly code = 'E_FORBIDDEN';
}

/** The real path of p, or of its nearest existing ancestor with the rest appended. */
async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return resolve(await real(parent), basename(p));
  }
}

export class PathGuard {
  private readonly roots = new Set<string>();

  /** Allows a folder and everything in it (or one file). */
  async allow(path: string): Promise<void> {
    this.roots.add(await real(resolve(path)));
  }

  /** The checked, resolved path; throws ForbiddenPath otherwise. */
  async check(path: unknown): Promise<string> {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0'))
      throw new ForbiddenPath('A path must be a non-empty string.');
    if (!isAbsolute(path)) throw new ForbiddenPath(`Not an absolute path: ${path}`);
    const p = await real(resolve(path));
    for (const root of this.roots) {
      const rel = relative(root, p);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`)))
        return p;
    }
    throw new ForbiddenPath(
      `${path} is outside the folders chosen in this session; choose it in a dialog first.`,
    );
  }
}
