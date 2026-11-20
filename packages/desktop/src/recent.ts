/** Recent projects: the last ten project folders opened or saved, newest first. */
import { readFile, writeFile } from 'node:fs/promises';
import { isFolder } from './projectfs.js';

export const MAX_RECENT = 10;

export class Recent {
  constructor(private readonly file: string) {}

  private async load(): Promise<string[]> {
    try {
      const v = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  async add(dir: string): Promise<void> {
    const list = [dir, ...(await this.load()).filter((d) => d !== dir)].slice(0, MAX_RECENT);
    await writeFile(this.file, JSON.stringify(list, null, 2));
  }

  /** The recent folders that still exist. */
  async list(): Promise<string[]> {
    const out: string[] = [];
    for (const d of await this.load()) if (await isFolder(d)) out.push(d);
    return out;
  }
}
