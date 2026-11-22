/**
 * Zip archives from others (OpenRaster files, zipped projects, templates), read with Mochi2D's
 * zip reader within caps (LIMITS). It inflates an entry only when it is read, counts the bytes
 * really inflated, stops an entry that inflates past its declared size, and checks every CRC-32.
 * Its errors become ours: passing a cap is `E_TOO_LARGE` ("too large"); anything else wrong with
 * the archive is `E_ASSET_FORMAT` ("damaged").
 */
import { formatSize, type ArchiveCaps } from '@mochi-maker/core';
import { sourceFromZip, type ZipFileSource } from 'mochi2d/headless';
import { fromMochi2d } from './mochi2d.js';

const zipError = fromMochi2d;

/** Opens an archive within the caps (its directory is read; nothing is inflated yet). */
export function openZip(label: string, bytes: Uint8Array, caps: ArchiveCaps): ZipFileSource {
  try {
    return sourceFromZip(label, bytes, caps);
  } catch (e) {
    throw zipError(e, label);
  }
}

/** One entry's bytes, within the archive's caps. */
export async function readEntry(
  zip: ZipFileSource,
  label: string,
  path: string,
): Promise<Uint8Array> {
  try {
    return await zip.read(path);
  } catch (e) {
    throw zipError(e, label);
  }
}

/** Every file in an archive, by path, within the caps. */
export async function readZip(
  label: string,
  bytes: Uint8Array,
  caps: ArchiveCaps,
): Promise<Map<string, Uint8Array>> {
  const zip = openZip(label, bytes, caps);
  const files = new Map<string, Uint8Array>();
  for (const path of zip.list()) files.set(path, await readEntry(zip, label, path));
  return files;
}

/** The caps as people read them, for docs and messages. */
export const describeCaps = (c: ArchiveCaps): string =>
  `${formatSize(c.maxEntryBytes)} a file, ${formatSize(c.maxTotalBytes)} in all, ${formatSize(c.maxEntries, 'files')}`;
