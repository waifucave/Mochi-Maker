/**
 * Mochi2D's refusals in Mochi Maker's words. Passing one of Mochi2D's caps (an archive's, a
 * texture's, a file's) is `E_TOO_LARGE` ("too large"), like passing one of Mochi Maker's own; a
 * damaged or crafted archive or texture is `E_ASSET_FORMAT`. The caps passed are LIMITS', so the
 * messages and numbers are the same whichever side refuses.
 */
import { MochiError, tooLarge } from '@mochi-maker/core';
import {
  ArchiveLimitError,
  FileLimitError,
  TextureFormatError,
  TextureLimitError,
  UnsupportedArchiveError,
  ZipFormatError,
  readTextureHeader,
  type TextureHeader,
} from 'mochi2d/headless';

/** The name of an image format as people know it. */
export const FORMAT_NAMES: Record<TextureHeader['format'], string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
  ico: 'ICO',
};

/**
 * Mochi2D's error as a MochiError where it is one of its refusals (anything else is returned
 * as it is). `label` names what was read (an archive, a model).
 */
/** `e` as an instance of `cls`, or an Error of the same name (module comment), or null. */
function as<T>(e: unknown, cls: abstract new (...a: never[]) => T, name: string): T | null {
  return e instanceof cls || (e instanceof Error && e.name === name) ? (e as T) : null;
}

export function fromMochi2d(e: unknown, label: string): unknown {
  // Errors from Mochi2D's Node renderer are rebuilt in Node by name, from another bundle than
  // mochi2d/headless: the same name and fields, another class. So the name is matched too.
  const archive = as(e, ArchiveLimitError, 'ArchiveLimitError');
  if (archive) {
    const { kind, size, limit, path } = archive;
    if (kind === 'entries') return tooLarge(label, size, limit, 'files');
    if (kind === 'total') return tooLarge(`${label}, all files read together,`, size, limit);
    return tooLarge(`${label}: ${path}`, size, limit);
  }
  const file = as(e, FileLimitError, 'FileLimitError');
  if (file) {
    if (file.kind === 'total')
      return tooLarge(`${label}, all files together,`, file.size, file.limit);
    return tooLarge(`${label}: ${file.path}`, file.size, file.limit);
  }
  const texture = as(e, TextureLimitError, 'TextureLimitError');
  if (texture) {
    const { kind, size, limit, path, width, height } = texture;
    const what = `${label}: the texture ${path}`;
    const dims = `${width} × ${height} pixels`;
    if (kind === 'total') return tooLarge(`${label}'s textures, together,`, size, limit, 'pixels');
    if (kind === 'side')
      return new MochiError(
        'E_TOO_LARGE',
        `${what} is too large: ${dims}, more than the ${limit} pixels a side Mochi Maker accepts.`,
      );
    return tooLarge(`${what} (${dims})`, size, limit, 'pixels');
  }
  const format = as(e, TextureFormatError, 'TextureFormatError');
  if (format) return new MochiError('E_ASSET_FORMAT', `${label}: ${format.message}`);
  const unsupported = as(e, UnsupportedArchiveError, 'UnsupportedArchiveError');
  if (unsupported)
    return new MochiError(
      'E_ASSET_FORMAT',
      `${label} is not a zip archive: ${unsupported.message}`,
    );
  const zip = as(e, ZipFormatError, 'ZipFormatError');
  if (zip)
    return new MochiError(
      'E_ASSET_FORMAT',
      `${label} is damaged or is not a zip archive: ${zip.message}`,
    );
  return e;
}

/**
 * What an image declares, read by Mochi2D from its header without decoding it: its format and
 * size. A file in a format Mochi2D does not read (AVIF, HEIF, TIFF, JPEG XL, SVG…), or a damaged
 * header, is refused with Mochi2D's words, as `E_ASSET_FORMAT`.
 */
export function imageHeader(path: string, bytes: Uint8Array): TextureHeader {
  try {
    return readTextureHeader(path, bytes);
  } catch (e) {
    throw fromMochi2d(e, path);
  }
}
