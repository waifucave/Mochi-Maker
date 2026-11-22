/**
 * Reading a model for import: the folder a person points at, the folder of the `.model3.json`
 * they name, or a zip of the model. Only that folder and its subfolders are read, a few levels
 * deep, or that zip's entries; nothing else (no downloads, no search elsewhere).
 *
 * A model is read within Mochi2D's caps for models from strangers (LIMITS.model): the size of
 * each file, of all of them together, and their number, the same for a folder's files and a
 * zip's entries. A folder's file larger than its cap is refused before it is read, where the file
 * system can tell its size; a zip is read with Mochi2D's zip reader within the same caps.
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
import { readZip } from '@mochi-maker/art';

export interface ModelFolder {
  /** The folder the paths are relative to. */
  root: string;
  /** The `.model3.json`, relative to `root`. */
  settings: string;
  /** Every file below `root`, by relative path. */
  files: Map<string, Uint8Array>;
}

const MAX_DEPTH = 6;

/** The settings file of a zip: the shallowest `.model3.json`, refused when several share it. */
function zipSettings(path: string, names: string[]): string {
  const all = names.filter((n) => n.toLowerCase().endsWith('.model3.json'));
  const depth = (n: string) => n.split('/').length;
  const top = Math.min(...all.map(depth));
  const found = all.filter((n) => depth(n) === top);
  if (found.length === 0)
    throw new MochiError('E_MODEL_IMPORT', `${path} holds no .model3.json; it is not a model zip.`);
  if (found.length > 1)
    throw new MochiError(
      'E_MODEL_IMPORT',
      `${path} holds ${found.length} .model3.json files (${found.join(', ')}); unzip it and name the one to import.`,
    );
  return found[0]!;
}

/** A model zip, within LIMITS.model: the zip itself, and its entries with Mochi2D's zip reader. */
async function readModelZip(fs: FileSystem, path: string): Promise<ModelFolder> {
  const caps = LIMITS.model;
  const bytes = await readCapped(fs, path, caps.maxTotalBytes, path);
  const files = await readZip(path, bytes, caps);
  return { root: path, settings: zipSettings(path, [...files.keys()]), files };
}

export async function readModelFolder(fs: FileSystem, path: string): Promise<ModelFolder> {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (clean.toLowerCase().endsWith('.zip')) {
    if (!(await fs.exists(clean)))
      throw new MochiError('E_MODEL_IMPORT', `${path} does not exist.`);
    return readModelZip(fs, clean);
  }
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
