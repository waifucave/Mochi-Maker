/**
 * Caps on what Mochi Maker reads from files it did not make: art files, model folders, project
 * folders and archives, templates, and what the bridge and the MCP server are handed. Each reader
 * checks its caps before it allocates for what a file declares, so a small crafted file cannot
 * make it take gigabytes. Passing a cap is refused with `E_TOO_LARGE`, whose message says "too
 * large"; a file that is damaged or does not follow its format is refused with another code
 * (`E_ASSET_FORMAT`, `E_PROJECT_FORMAT`, `E_MODEL_IMPORT`).
 *
 * docs/limits.md lists the caps and what bounds each reader's memory.
 */
import { MochiError } from './errors.js';
import type { FileSystem } from './fs.js';

const MiB = 2 ** 20;

/** Caps on a zip archive, in the form Mochi2D's `ArchiveLimits` takes. */
export interface ArchiveCaps {
  /** The most one entry may inflate to, in bytes. */
  maxEntryBytes: number;
  /** The most all entries read may inflate to together, in bytes. */
  maxTotalBytes: number;
  /** The most entries the archive's directory may list. */
  maxEntries: number;
}

export const LIMITS = {
  /** One file read whole, where no smaller cap applies: a PSD, OpenRaster file, PNG, template. */
  fileBytes: 512 * MiB,
  /** One image's width or height, in pixels. */
  imageSide: 16384,
  /** One image's pixels (width × height): 2^27, 512 MiB as 8-bit RGBA. */
  imagePixels: 2 ** 27,
  /** Layers in one art file or PNG folder (groups included). */
  layers: 2000,
  /** The pixels of all layers (and masks) of one art file together: 2^28, 1 GiB as RGBA. */
  layerPixels: 2 ** 28,
  /** An embedded color profile in a PNG, inflated. */
  pngProfileBytes: 16 * MiB,
  /** A model folder: Mochi2D's caps for models from strangers, applied to the folder's files. */
  model: { maxEntryBytes: 64 * MiB, maxTotalBytes: 256 * MiB, maxEntries: 2000 } as ArchiveCaps,
  /** A zipped project or a template (a project inside): more files than a model has. */
  projectArchive: {
    maxEntryBytes: 256 * MiB,
    maxTotalBytes: 1024 * MiB,
    maxEntries: 50_000,
  } as ArchiveCaps,
  /** An OpenRaster file's zip: its stack.xml and layer PNGs. */
  artArchive: {
    maxEntryBytes: 256 * MiB,
    maxTotalBytes: 512 * MiB,
    maxEntries: 4000,
  } as ArchiveCaps,
  /** One JSON file of a project folder. */
  projectFileBytes: 64 * MiB,
  /** All JSON files of a project folder together. */
  projectBytes: 512 * MiB,
  /** Files in a project folder's object folders together. */
  projectFiles: 50_000,
  /** One JSON-RPC message on the MCP server's standard input. */
  mcpMessageBytes: 64 * MiB,
} as const;

/** "512 MiB", "1.5 GiB", "2,000 files": a size or count as people read it. */
export function formatSize(n: number, unit: 'bytes' | string = 'bytes'): string {
  if (unit !== 'bytes') return `${n.toLocaleString('en-US')} ${unit}`;
  const at = (scale: number, name: string) =>
    `${(Math.round((n / scale) * 10) / 10).toLocaleString('en-US')} ${name}`;
  if (n >= 1024 * MiB) return at(1024 * MiB, 'GiB');
  if (n >= MiB) return at(MiB, 'MiB');
  if (n >= 1024) return at(1024, 'KiB');
  return `${n} bytes`;
}

/**
 * The refusal for passing a cap: "<what> is too large: <size> (Mochi Maker accepts at most
 * <limit>)". `size` may be a lower bound (what was counted when the cap was passed).
 */
export function tooLarge(
  what: string,
  size: number,
  limit: number,
  unit: 'bytes' | string = 'bytes',
): MochiError {
  return new MochiError(
    'E_TOO_LARGE',
    `${what} is too large: ${size > limit ? `${formatSize(size, unit)}, ` : ''}more than the ${formatSize(limit, unit)} Mochi Maker accepts.`,
    { details: { size, limit, unit } },
  );
}

/** True for the refusal of a cap (so a caller that rewraps errors keeps it apart). */
export function isTooLarge(e: unknown): e is MochiError {
  return e instanceof MochiError && e.code === 'E_TOO_LARGE';
}

/**
 * Reads a whole file within a cap. Where the file system can tell a file's size, a larger file is
 * refused before it is read; otherwise after (the file system's own read bounds the memory).
 */
export async function readCapped(
  fs: FileSystem,
  path: string,
  limit: number,
  what = path,
): Promise<Uint8Array> {
  const size = fs.size ? await fs.size(path) : undefined;
  if (size !== undefined && size > limit) throw tooLarge(what, size, limit);
  const bytes = await fs.readBytes(path);
  if (bytes.length > limit) throw tooLarge(what, bytes.length, limit);
  return bytes;
}

/** A running count against a cap: of pixels over an art file's layers, bytes over a folder's files. */
export class Budget {
  private used = 0;
  constructor(
    readonly limit: number,
    readonly what: string,
    readonly unit: 'bytes' | string = 'bytes',
  ) {}
  /** Counts `n` more, or refuses if that passes the cap. */
  take(n: number): void {
    this.used += n;
    if (this.used > this.limit) throw tooLarge(this.what, this.used, this.limit, this.unit);
  }
  get total(): number {
    return this.used;
  }
}

/** Refuses an image whose declared size passes the per-image caps. */
export function checkImageSize(width: number, height: number, what: string): void {
  if (width > LIMITS.imageSide || height > LIMITS.imageSide)
    throw new MochiError(
      'E_TOO_LARGE',
      `${what} is too large: ${width} × ${height} pixels, more than the ${LIMITS.imageSide} pixels a side Mochi Maker accepts.`,
      { details: { width, height, limit: LIMITS.imageSide, unit: 'pixels a side' } },
    );
  if (width * height > LIMITS.imagePixels)
    throw new MochiError(
      'E_TOO_LARGE',
      `${what} is too large: ${width} × ${height} pixels, more than the ${formatSize(LIMITS.imagePixels, 'pixels')} in one image Mochi Maker accepts.`,
      { details: { width, height, limit: LIMITS.imagePixels, unit: 'pixels' } },
    );
}
