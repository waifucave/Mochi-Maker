/**
 * A folder of PNG layers, with an optional order file:
 *
 * - `layers.json`: {"width"?, "height"?, "layers": [{"file", "name"?, "x"?, "y"?, "group"?,
 *   "visible"?, "opacity"?, "blendMode"?, "clipped"?}]}, bottom to top. `group` is a path such as
 *   "Head/Eyes".
 * - or `order.txt`: one file name per line, bottom to top.
 *
 * Without either, files are taken in natural name order. Positions default to (0, 0), which suits
 * the common export of full-canvas layers; transparent borders are trimmed either way.
 */
import {
  Budget,
  LIMITS,
  MochiError,
  checkImageSize,
  joinPath,
  parseJson,
  readCapped,
  tooLarge,
  type FileSystem,
} from '@mochi-maker/core';
import { normalizeBlendMode, type ImportedArt, type ImportedLayer } from './art.js';
import { decodePng, trimImage } from './png.js';

interface Entry {
  file: string;
  name?: string;
  x?: number;
  y?: number;
  group?: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  clipped?: boolean;
}

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export async function readPngFolderArt(fs: FileSystem, dir: string): Promise<ImportedArt> {
  const names = (await fs.list(dir)).filter((n) => /\.png$/i.test(n));
  const notes: string[] = [];
  let entries: Entry[];
  let width: number | undefined;
  let height: number | undefined;
  if (await fs.exists(joinPath(dir, 'layers.json'))) {
    const text = new TextDecoder().decode(
      await readCapped(fs, joinPath(dir, 'layers.json'), LIMITS.projectFileBytes),
    );
    const json = parseJson(text) as {
      width?: number;
      height?: number;
      layers?: Entry[];
    };
    if (!json || !Array.isArray(json.layers))
      throw new MochiError('E_ASSET_FORMAT', `${dir}/layers.json must have a "layers" list.`);
    entries = json.layers;
    width = json.width;
    height = json.height;
    const listed = new Set(entries.map((e) => e.file));
    for (const n of names)
      if (!listed.has(n)) notes.push(`${n} is not listed in layers.json and was skipped.`);
  } else if (await fs.exists(joinPath(dir, 'order.txt'))) {
    entries = new TextDecoder()
      .decode(await readCapped(fs, joinPath(dir, 'order.txt'), LIMITS.projectFileBytes))
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((file) => ({ file }));
  } else entries = [...names].sort(natural.compare).map((file) => ({ file }));
  if (entries.length === 0)
    throw new MochiError('E_ASSET_FORMAT', `${dir} contains no PNG layers.`);

  if (entries.length > LIMITS.layers) throw tooLarge(dir, entries.length, LIMITS.layers, 'layers');
  const pixels = new Budget(LIMITS.layerPixels, `${dir}'s layers, together,`, 'pixels');
  const layers: ImportedLayer[] = [];
  let maxX = 0;
  let maxY = 0;
  for (const e of entries) {
    const path = joinPath(dir, e.file);
    if (!(await fs.exists(path))) {
      notes.push(`${e.file} does not exist and was skipped.`);
      continue;
    }
    const img = decodePng(await readCapped(fs, path, LIMITS.fileBytes, e.file), e.file, pixels);
    maxX = Math.max(maxX, (e.x ?? 0) + img.width);
    maxY = Math.max(maxY, (e.y ?? 0) + img.height);
    const trimmed = trimImage(img);
    if (!trimmed) {
      notes.push(`${e.file} is fully transparent and was skipped.`);
      continue;
    }
    layers.push({
      name: e.name ?? e.file.replace(/\.png$/i, ''),
      group: e.group ? e.group.split('/').filter(Boolean) : [],
      x: (e.x ?? 0) + trimmed.x,
      y: (e.y ?? 0) + trimmed.y,
      image: trimmed.image,
      visible: e.visible ?? true,
      opacity: e.opacity ?? 1,
      blendMode: normalizeBlendMode(e.blendMode),
      clipped: e.clipped ?? false,
      notes: [],
    });
  }
  const canvas = { width: width ?? maxX, height: height ?? maxY };
  checkImageSize(canvas.width, canvas.height, `${dir}'s canvas`);
  return { format: 'png-folder', ...canvas, layers, notes };
}
