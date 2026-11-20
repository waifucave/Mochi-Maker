/**
 * Project folders and export folders on disk. A project is written file by file, and
 * the files of the project's own layout that the new save no longer has are removed, so a saved
 * folder is exactly the project. Other files in the folder are left alone.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** Files of the project layout (core's project folder), by their path in the folder. */
const PROJECT_FILE =
  /^(mochi-project\.json|[a-z]+\.json|(meshes|deformers|expressions|motions)\/[^/]+\.json|assets\/sha256-[0-9a-f]{64}\.[a-z0-9]+)$/;

async function walk(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else if (e.isFile()) out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/** Every file of a folder, by its path inside it (with /). */
export async function readFolder(dir: string): Promise<[string, Uint8Array][]> {
  const out: [string, Uint8Array][] = [];
  for (const p of await walk(dir)) out.push([p, new Uint8Array(await readFile(join(dir, p)))]);
  return out;
}

/** Writes a file through a temporary name, so a crash never leaves half a file. */
async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

/** Saves a project's files into its folder, removing project files it no longer has. */
export async function writeProject(dir: string, files: [string, Uint8Array][]): Promise<void> {
  const keep = new Set(files.map(([p]) => p));
  for (const [p] of files)
    if (!PROJECT_FILE.test(p) || p.includes('..'))
      throw new Error(`${p} is not a file of a Mochi Maker project.`);
  for (const [p, b] of files) await writeAtomic(join(dir, p), b);
  let existing: string[] = [];
  try {
    existing = await walk(dir);
  } catch {
    existing = [];
  }
  for (const p of existing) if (PROJECT_FILE.test(p) && !keep.has(p)) await rm(join(dir, p));
}

/** Writes export files into a folder (relative paths only). */
export async function writeFolder(dir: string, files: [string, Uint8Array][]): Promise<void> {
  for (const [p, b] of files) {
    if (p.startsWith('/') || p.split('/').includes('..') || p.includes('\\'))
      throw new Error(`${p} is not a relative path inside the folder.`);
    await writeAtomic(join(dir, p), b);
  }
}

export async function isFolder(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
