/**
 * Auto-saved copies. While a project has unsaved changes, the editor sends its files
 * every minute; each copy goes to `<userData>/autosave/<key>/<time>/`, with `meta.json`, and the
 * newest five per project are kept. A save of the project removes its copies. A lock file marks
 * a running session: when the app starts and finds one, the last session did not end cleanly, and
 * the copies left are offered for recovery.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFolder, writeFolder } from './projectfs.js';

export const KEEP = 5;

export interface AutosaveMeta {
  key: string;
  name: string;
  /** The project's folder, when it has one. */
  dir: string | null;
  time: number;
}

export class Autosaves {
  /** Whether the last session ended without removing its lock (a crash). */
  crashed = false;

  constructor(
    readonly root: string,
    readonly keep = KEEP,
    private readonly now: () => number = Date.now,
  ) {}

  private get lock(): string {
    return join(this.root, 'session.lock');
  }

  /** Starts a session: notes whether the last one crashed, and takes the lock. */
  async begin(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    try {
      await readFile(this.lock);
      this.crashed = true;
    } catch {
      this.crashed = false;
    }
    await writeFile(this.lock, String(process.pid));
  }

  /** A clean end: the lock goes. */
  async end(): Promise<void> {
    await rm(this.lock, { force: true });
  }

  private safeKey(key: string): string {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(key)) throw new Error(`Not an auto-save key: ${key}`);
    return key;
  }

  async save(
    meta: Omit<AutosaveMeta, 'time'>,
    files: [string, Uint8Array][],
  ): Promise<AutosaveMeta> {
    const key = this.safeKey(meta.key);
    const time = this.now();
    const dir = join(this.root, key, String(time));
    await writeFolder(join(dir, 'project'), files);
    const full = { ...meta, key, time };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(full));
    const times = await this.times(key);
    for (const t of times.slice(0, Math.max(0, times.length - this.keep)))
      await rm(join(this.root, key, String(t)), { recursive: true, force: true });
    return full;
  }

  private async times(key: string): Promise<number[]> {
    try {
      return (await readdir(join(this.root, key)))
        .filter((n) => /^\d+$/.test(n))
        .map(Number)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /** The newest copy of each project. */
  async latest(): Promise<AutosaveMeta[]> {
    const out: AutosaveMeta[] = [];
    let keys: string[] = [];
    try {
      keys = (await readdir(this.root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
    for (const key of keys) {
      const t = (await this.times(key)).at(-1);
      if (t === undefined) continue;
      try {
        out.push(JSON.parse(await readFile(join(this.root, key, String(t), 'meta.json'), 'utf8')));
      } catch {
        // A copy cut short by the crash itself: skipped.
      }
    }
    return out.sort((a, b) => b.time - a.time);
  }

  async read(key: string, time: number): Promise<[string, Uint8Array][]> {
    return readFolder(join(this.root, this.safeKey(key), String(Math.trunc(time)), 'project'));
  }

  /** Removes a project's copies (after it was saved, or when recovery is declined). */
  async clear(key: string): Promise<void> {
    await rm(join(this.root, this.safeKey(key)), { recursive: true, force: true });
  }
}
