/**
 * OpenRaster (.ora) reading: a zip with stack.xml and PNG layers. Unzipping uses fflate (MIT).
 * In stack.xml the first child of a stack is the topmost; layers are returned bottom to top.
 */
import { MochiError } from '@mochi-maker/core';
import { unzipSync } from 'fflate';
import { normalizeBlendMode, type ImportedArt, type ImportedLayer } from './art.js';
import { decodePng, trimImage } from './png.js';
import { parseXml, type XmlElement } from './xml.js';

export function readOraArt(bytes: Uint8Array, name = 'ORA'): ImportedArt {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new MochiError('E_ASSET_FORMAT', `${name} is not a zip archive: ${(e as Error).message}`);
  }
  const mimetype = files['mimetype'];
  if (mimetype && new TextDecoder().decode(mimetype).trim() !== 'image/openraster')
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${name} is not an OpenRaster file (mimetype is not image/openraster).`,
    );
  const stackXml = files['stack.xml'];
  if (!stackXml) throw new MochiError('E_ASSET_FORMAT', `${name} has no stack.xml.`);
  const doc = parseXml(new TextDecoder().decode(stackXml));
  const image = doc.children.find((c) => c.name === 'image');
  if (!image) throw new MochiError('E_ASSET_FORMAT', `${name}: stack.xml has no <image> element.`);
  const width = Number(image.attributes.w);
  const height = Number(image.attributes.h);
  if (!(width > 0) || !(height > 0))
    throw new MochiError('E_ASSET_FORMAT', `${name}: the image size is missing.`);
  const notes: string[] = [];
  const layers: ImportedLayer[] = [];

  const walk = (
    stack: XmlElement,
    group: string[],
    ox: number,
    oy: number,
    hidden: boolean,
    groupNotes: string[],
  ) => {
    for (const el of [...stack.children].reverse()) {
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
      if (el.name !== 'layer') continue;
      const src = a.src;
      const data = src ? files[src] : undefined;
      if (!data) {
        notes.push(
          `Layer "${elName}" refers to a missing file ${src ?? '(none)'} and was skipped.`,
        );
        continue;
      }
      if (!/\.png$/i.test(src!)) {
        notes.push(`Layer "${elName}" is not a PNG (${src}) and was skipped.`);
        continue;
      }
      const trimmed = trimImage(decodePng(data, `${name}/${src}`));
      if (!trimmed) {
        notes.push(`Layer "${elName}" is fully transparent and was skipped.`);
        continue;
      }
      layers.push({
        name: elName,
        group,
        x: x + trimmed.x,
        y: y + trimmed.y,
        image: trimmed.image,
        visible: !isHidden,
        opacity: a.opacity !== undefined ? Math.max(0, Math.min(1, Number(a.opacity))) : 1,
        blendMode: normalizeBlendMode(a['composite-op']),
        clipped: false,
        notes: [...groupNotes],
      });
    }
  };
  const top = image.children.find((c) => c.name === 'stack');
  if (top) walk(top, [], 0, 0, false, []);
  return { format: 'ora', width, height, layers, notes };
}
