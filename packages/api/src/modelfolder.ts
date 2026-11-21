/**
 * Reading a model folder for import: the folder a person points at, or the folder of the
 * `.model3.json` they name. Only that folder and its subfolders are read, a few levels deep;
 * nothing else (no archives, no downloads, no search elsewhere).
 */
import { MochiError, type FileSystem } from '@mochi-maker/core';

export interface ModelFolder {
  /** The folder the paths are relative to. */
  root: string;
  /** The `.model3.json`, relative to `root`. */
  settings: string;
  /** Every file below `root`, by relative path. */
  files: Map<string, Uint8Array>;
}

const MAX_FILES = 4096;
const MAX_DEPTH = 6;

export async function readModelFolder(fs: FileSystem, path: string): Promise<ModelFolder> {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '');
  let root = clean;
  let settings: string | null = null;
  if (clean.toLowerCase().endsWith('.model3.json')) {
    if (!(await fs.exists(clean)))
      throw new MochiError('E_MODEL_IMPORT', `${path} does not exist.`);
    const i = clean.lastIndexOf('/');
    root = i < 0 ? '.' : clean.slice(0, i) || '/';
    settings = i < 0 ? clean : clean.slice(i + 1);
  }
  const files = new Map<string, Uint8Array>();
  const walk = async (dir: string, rel: string, depth: number) => {
    for (const name of (await fs.list(dir)).sort()) {
      const full = `${dir}/${name}`;
      const r = rel ? `${rel}/${name}` : name;
      const inner = depth < MAX_DEPTH ? await fs.list(full) : [];
      if (inner.length > 0) await walk(full, r, depth + 1);
      else {
        try {
          files.set(r, await fs.readBytes(full));
        } catch {
          // an empty folder, or something that is not a file
        }
      }
      if (files.size > MAX_FILES)
        throw new MochiError(
          'E_MODEL_IMPORT',
          `${path} holds more than ${MAX_FILES} files; point at the model's own folder.`,
        );
    }
  };
  await walk(root, '', 0);
  if (!settings) {
    const found = [...files.keys()].filter(
      (f) => !f.includes('/') && f.toLowerCase().endsWith('.model3.json'),
    );
    if (found.length === 0)
      throw new MochiError(
        'E_MODEL_IMPORT',
        `${path} holds no .model3.json; point at a model folder or its .model3.json.`,
      );
    if (found.length > 1)
      throw new MochiError(
        'E_MODEL_IMPORT',
        `${path} holds ${found.length} .model3.json files (${found.join(', ')}); name the one to import.`,
      );
    settings = found[0]!;
  }
  return { root, settings, files };
}
