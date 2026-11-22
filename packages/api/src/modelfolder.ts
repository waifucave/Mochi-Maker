/**
 * Reading a model folder for import: the folder a person points at, or the folder of the
 * `.model3.json` they name. Only that folder and its subfolders are read, a few levels deep;
 * nothing else (no archives, no downloads, no search elsewhere).
 *
 * The folder is read within Mochi2D's caps for models from strangers (LIMITS.model): the size of
 * each file, of all of them together, and their number. A file larger than its cap is refused
 * before it is read, where the file system can tell its size.
 */
import {
  Budget,
  LIMITS,
  MochiError,
  isTooLarge,
  readCapped,
  tooLarge,
  type FileSystem,
} from '@mochi-maker/core';

export interface ModelFolder {
  /** The folder the paths are relative to. */
  root: string;
  /** The `.model3.json`, relative to `root`. */
  settings: string;
  /** Every file below `root`, by relative path. */
  files: Map<string, Uint8Array>;
}

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
  const caps = LIMITS.model;
  // First the list of files and their sizes, checked against the caps; then the reading.
  const found: [rel: string, full: string][] = [];
  const total = new Budget(caps.maxTotalBytes, `The model folder ${path}, all files together,`);
  const walk = async (dir: string, rel: string, depth: number) => {
    for (const name of (await fs.list(dir)).sort()) {
      const full = `${dir}/${name}`;
      const r = rel ? `${rel}/${name}` : name;
      const inner = depth < MAX_DEPTH ? await fs.list(full) : [];
      if (inner.length > 0) await walk(full, r, depth + 1);
      else {
        if (found.length >= caps.maxEntries) {
          const e = tooLarge(
            `The model folder ${path}`,
            found.length + 1,
            caps.maxEntries,
            'files',
          );
          e.message += " Point at the model's own folder.";
          throw e;
        }
        const size = fs.size ? await fs.size(full) : undefined;
        if (size !== undefined) {
          if (size > caps.maxEntryBytes) throw tooLarge(`${path}: ${r}`, size, caps.maxEntryBytes);
          total.take(size);
        }
        found.push([r, full]);
      }
    }
  };
  await walk(root, '', 0);
  const files = new Map<string, Uint8Array>();
  const unsized = new Budget(caps.maxTotalBytes, `The model folder ${path}, all files together,`);
  for (const [r, full] of found)
    try {
      const bytes = await readCapped(fs, full, caps.maxEntryBytes, `${path}: ${r}`);
      if (fs.size === undefined) unsized.take(bytes.length);
      files.set(r, bytes);
    } catch (e) {
      if (isTooLarge(e)) throw e;
      // an empty folder, or something that is not a file
    }
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
