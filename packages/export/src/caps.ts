/**
 * The caps Mochi Maker passes Mochi2D, in one place (docs/limits.md).
 *
 * - **A model from others** (an imported model folder or zip) is read within LIMITS: Mochi2D's
 *   suggested archive caps for models from strangers, the same caps on a folder's files, and
 *   Mochi Maker's image caps for its textures. Mochi Maker reads those files itself, so it checks
 *   them itself, with these numbers.
 * - **A model Mochi Maker builds** (the editor's view, its renders, the template preview, the
 *   agent API's and the conformance pack's renders) is checked against `BUILD_TEXTURES`: what an
 *   export may hold. Its pages are at most the largest atlas, textures kept from an imported
 *   model at most the import's caps, and the export refuses a model whose textures pass Mochi2D's
 *   default total, so every export loads with Mochi2D's defaults.
 *
 * Mochi2D's `files` caps are not passed: they apply to files Mochi2D reads from a folder, a URL
 * or a pick, and Mochi Maker hands it files it has already read, within LIMITS.
 */
import { LIMITS, type TextureCaps } from '@mochi-maker/core';
import { DEFAULT_TEXTURE_LIMITS } from 'mochi2d/headless';

/** The largest atlas page an export writes (`exportSettings.atlasSize`). */
export const MAX_ATLAS = 8192;

/** What a model Mochi Maker builds may declare (module comment); all within Mochi2D's defaults. */
export const BUILD_TEXTURES: TextureCaps = {
  maxSide: Math.max(MAX_ATLAS, LIMITS.textures.maxSide),
  maxPixels: Math.max(MAX_ATLAS * MAX_ATLAS, LIMITS.textures.maxPixels),
  maxTotalPixels: DEFAULT_TEXTURE_LIMITS.maxTotalPixels,
};

/** The caps for a model from others, as Mochi2D takes them. */
export const FOREIGN_MODEL = {
  archive: LIMITS.model,
  textures: LIMITS.textures,
  files: LIMITS.modelFiles,
};
