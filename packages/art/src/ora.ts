/**
 * OpenRaster (.ora) reading: a zip with stack.xml and PNG layers, read with Mochi2D's zip reader
 * within LIMITS.artArchive, and the layers within the image caps. In stack.xml the first child of a stack is the topmost; layers are returned bottom to top.
 */
import { Budget, LIMITS, MochiError, checkImageSize, tooLarge } from '@mochi-maker/core';
import { normalizeBlendMode, type ImportedArt, type ImportedLayer } from './art.js';
import { decodePng, trimImage } from './png.js';
import { openZip, readEntry } from './zip.js';
import { parseXml, type XmlElement } from './xml.js';

export async function readOraArt(bytes: Uint8Array, name = 'ORA'): Promise<ImportedArt> {
  const zip = openZip(name, bytes, LIMITS.artArchive);
  const entries = new Set(zip.list());
  const entry = (path: string) => (entries.has(path) ? readEntry(zip, name, path) : undefined);
  const mimetype = await entry('mimetype');
  if (mimetype && new TextDecoder().decode(mimetype).trim() !== 'image/openraster')
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${name} is not an OpenRaster file (mimetype is not image/openraster).`,
    );
  const stackXml = await entry('stack.xml');
  if (!stackXml) throw new MochiError('E_ASSET_FORMAT', `${name} has no stack.xml.`);
  const doc = parseXml(new TextDecoder().decode(stackXml));
  const image = doc.children.find((c) => c.name === 'image');
  if (!image) throw new MochiError('E_ASSET_FORMAT', `${name}: stack.xml has no <image> element.`);
  const width = Number(image.attributes.w);
  const height = Number(image.attributes.h);
  if (!(width > 0) || !(height > 0))
    throw new MochiError('E_ASSET_FORMAT', `${name}: the image size is missing.`);
  checkImageSize(width, height, name);
  const notes: string[] = [];
  const layers: ImportedLayer[] = [];
  const pixels = new Budget(LIMITS.layerPixels, `${name}'s layers, together,`, 'pixels');
  let count = 0;
  const planned: {
    elName: string;
    src: string;
    x: number;
    y: number;
    hidden: boolean;
    group: string[];
    notes: string[];
    a: Record<string, string | undefined>;
  }[] = [];

  const walk = (
    stack: XmlElement,
    group: string[],
    ox: number,
    oy: number,
    hidden: boolean,
    groupNotes: string[],
  ) => {
    for (const el of [...stack.children].reverse()) {
      if (el.name !== 'stack' && el.name !== 'layer') continue;
      if (++count > LIMITS.layers) throw tooLarge(name, count, LIMITS.layers, 'layers');
      const a = el.attributes;
      const elName = a.name ?? (el.name === 'stack' ? 'Group' : 'Layer');
      const x = ox + Number(a.x ?? 0);
      const y = oy + Number(a.y ?? 0);
      const isHidden = hidden || a.visibility === 'hidden';
      if (el.name === 'stack') {
        const gn = [...groupNotes];
        const mode = normalizeBlendMode(a['composite-op']);
        if (mode !== 'normal' && mode !== 'pass-through')
          gn.push(`group "${elName}" blends with ${mode}`);
        if (a.opacity !== undefined && Number(a.opacity) < 1)
          gn.push(`group "${elName}" has opacity ${Math.round(Number(a.opacity) * 100)}%`);
        walk(el, [...group, elName], x, y, isHidden, gn);
        continue;
      }
      const src = a.src;
      if (!src || !entries.has(src)) {
        notes.push(
          `Layer "${elName}" refers to a missing file ${src ?? '(none)'} and was skipped.`,
        );
        continue;
      }
      if (!/\.png$/i.test(src)) {
        notes.push(`Layer "${elName}" is not a PNG (${src}) and was skipped.`);
        continue;
      }
      planned.push({ elName, src, x, y, hidden: isHidden, group, notes: groupNotes, a });
    }
  };
  const top = image.children.find((c) => c.name === 'stack');
  if (top) walk(top, [], 0, 0, false, []);
  for (const l of planned) {
    const data = (await readEntry(zip, name, l.src))!;
    const trimmed = trimImage(decodePng(data, `${name}/${l.src}`, pixels));
    if (!trimmed) {
      notes.push(`Layer "${l.elName}" is fully transparent and was skipped.`);
      continue;
    }
    const a = l.a;
    layers.push({
      name: l.elName,
      group: l.group,
      x: l.x + trimmed.x,
      y: l.y + trimmed.y,
      image: trimmed.image,
      visible: !l.hidden,
      opacity: a.opacity !== undefined ? Math.max(0, Math.min(1, Number(a.opacity))) : 1,
      blendMode: normalizeBlendMode(a['composite-op']),
      clipped: false,
      notes: [...l.notes],
    });
  }
  return { format: 'ora', width, height, layers, notes };
}
