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
export function fromMochi2d(e: unknown, label: string): unknown {
  if (e instanceof ArchiveLimitError) {
    if (e.kind === 'entries') return tooLarge(label, e.size, e.limit, 'files');
    if (e.kind === 'total') return tooLarge(`${label}, all files read together,`, e.size, e.limit);
    return tooLarge(`${label}: ${e.path}`, e.size, e.limit);
  }
  if (e instanceof FileLimitError) {
    if (e.kind === 'total') return tooLarge(`${label}, all files together,`, e.size, e.limit);
    return tooLarge(`${label}: ${e.path}`, e.size, e.limit);
  }
  if (e instanceof TextureLimitError) {
    const what = `${label}: the texture ${e.path}`;
    const dims = `${e.width} × ${e.height} pixels`;
    const err =
      e.kind === 'total'
        ? tooLarge(`${label}'s textures, together,`, e.size, e.limit, 'pixels')
        : e.kind === 'side'
          ? new MochiError(
              'E_TOO_LARGE',
              `${what} is too large: ${dims}, more than the ${e.limit} pixels a side Mochi Maker accepts.`,
            )
          : tooLarge(`${what} (${dims})`, e.size, e.limit, 'pixels');
    return err;
  }
  if (e instanceof TextureFormatError)
    return new MochiError('E_ASSET_FORMAT', `${label}: ${e.message}`);
  if (e instanceof UnsupportedArchiveError)
    return new MochiError('E_ASSET_FORMAT', `${label} is not a zip archive: ${e.message}`);
  if (e instanceof ZipFormatError)
    return new MochiError(
      'E_ASSET_FORMAT',
      `${label} is damaged or is not a zip archive: ${e.message}`,
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
