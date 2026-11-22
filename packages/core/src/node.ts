/** Node.js implementations of the core's I/O interfaces. Only this module imports Node APIs. */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MochiError } from './errors.js';
import type { FileSystem } from './fs.js';

export class NodeFileSystem implements FileSystem {
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }
  async writeText(path: string, text: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(text));
  }
  async readBytes(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        throw new MochiError('E_NOT_FOUND', `No such file: ${path}`);
      throw e;
    }
  }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async list(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).sort();
    } catch {
      return [];
    }
  }
  async size(path: string): Promise<number | undefined> {
    try {
      const s = await stat(path);
      return s.isFile() ? s.size : undefined;
    } catch {
      return undefined;
    }
  }
  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
