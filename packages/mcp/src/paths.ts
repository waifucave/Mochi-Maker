/**
 * File access for agents (agent API design 6, item 5): only inside the directories the person
 * allowed. Paths are resolved, and checked after following symbolic links.
 */
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { MochiError } from '@mochi-maker/core';

/** The real path of `p`, following links in its longest existing prefix. */
function realish(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(head), ...tail.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(p);
      tail.push(head.slice(up.length + 1));
      head = up;
    }
  }
}

export class PathPolicy {
  readonly roots: string[];
  constructor(allowed: string[]) {
    this.roots = allowed.map(realish);
  }

  /** The resolved path, or E_FORBIDDEN when it is outside every allowed directory. */
  check(path: string, what: string): string {
    const real = realish(path);
    const inside = this.roots.some((r) => {
      const rel = relative(r, real);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    if (!inside)
      throw new MochiError(
        'E_FORBIDDEN',
        `${what} ${path} is outside the allowed directories (${this.roots.join(', ')}). Ask the person to start the server with --allow-dir for it.`,
        { path: 'args.path' },
      );
    return real;
  }
}
