/**
 * Reading files a person chooses or drops, within the caps on files from others (core's
 * LIMITS). Sizes are checked from the File objects before anything is read, so a file or folder
 * over a cap takes no memory.
 */
import { LIMITS, tooLarge, type ArchiveCaps } from '@mochi-maker/core';

/** One file's bytes, refused before reading when it is larger than `limit`. */
export async function fileBytes(
  f: File,
  limit: number = LIMITS.fileBytes,
  what = f.name,
): Promise<Uint8Array> {
  if (f.size > limit) throw tooLarge(what, f.size, limit);
  return new Uint8Array(await f.arrayBuffer());
}

/**
 * The files of a chosen folder (or several files), by their path in it, within `caps`: their
 * number, each one's size and the total, all checked before any is read.
 */
export async function folderBytes(
  files: readonly File[],
  caps: ArchiveCaps,
  what: string,
): Promise<Map<string, Uint8Array>> {
  if (files.length > caps.maxEntries) throw tooLarge(what, files.length, caps.maxEntries, 'files');
  let total = 0;
  for (const f of files) {
    const path = f.webkitRelativePath || f.name;
    if (f.size > caps.maxEntryBytes) throw tooLarge(`${what}: ${path}`, f.size, caps.maxEntryBytes);
    total += f.size;
  }
  if (total > caps.maxTotalBytes)
    throw tooLarge(`${what}, all files together,`, total, caps.maxTotalBytes);
  const map = new Map<string, Uint8Array>();
  for (const f of files)
    map.set(f.webkitRelativePath || f.name, new Uint8Array(await f.arrayBuffer()));
  return map;
}

/** A text file (JSON settings, key maps, templates), within the cap on one JSON file. */
export async function fileText(f: File, limit: number = LIMITS.projectFileBytes): Promise<string> {
  return new TextDecoder().decode(await fileBytes(f, limit));
}
