/**
 * PSD reading through ag-psd (MIT). Layers keep their pixels as stored (no cross-layer blending
 * is baked in), groups become group paths, and blend modes, opacity, clipping and visibility are
 * recorded. What cannot be carried over is noted, per layer and for the file.
 */
import { MochiError } from '@mochi-maker/core';
import { initializeCanvas, readPsd, type Layer as PsdLayer } from 'ag-psd';
import { normalizeBlendMode, type ImportedArt, type ImportedLayer } from './art.js';
import { trimImage } from './png.js';

let initialized = false;

/** Outside browsers there is no canvas; ag-psd only needs plain image-data objects. */
function ensureImageData(): void {
  if (initialized || typeof (globalThis as { document?: unknown }).document !== 'undefined') return;
  initializeCanvas(
    () => {
      throw new Error('no canvas available');
    },
    (width: number, height: number) =>
      ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
        colorSpace: 'srgb',
      }) as unknown as ImageData,
  );
  initialized = true;
}

export function readPsdArt(bytes: Uint8Array, name = 'PSD'): ImportedArt {
  ensureImageData();
  let psd;
  try {
    psd = readPsd(bytes, {
      useImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
    });
  } catch (e) {
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${name} could not be read as a PSD: ${(e as Error).message}`,
    );
  }
  const notes: string[] = [];
  if (psd.bitsPerChannel && psd.bitsPerChannel !== 8)
    notes.push(
      `The file uses ${psd.bitsPerChannel} bits per channel; layers were reduced to 8 bits.`,
    );
  if (psd.colorMode !== undefined && psd.colorMode !== 3)
    notes.push('The file is not in RGB color mode; colors may be wrong.');
  const layers: ImportedLayer[] = [];

  const walk = (
    children: PsdLayer[] | undefined,
    group: string[],
    hiddenAbove: boolean,
    groupNotes: string[],
  ) => {
    for (const l of children ?? []) {
      const lname = l.name ?? 'Layer';
      if (l.children) {
        const gn = [...groupNotes];
        const mode = normalizeBlendMode(l.blendMode);
        if (mode !== 'pass-through' && mode !== 'normal')
          gn.push(`group "${lname}" blends with ${mode}`);
        if (l.opacity !== undefined && l.opacity < 1)
          gn.push(`group "${lname}" has opacity ${Math.round(l.opacity * 100)}%`);
        if (l.mask) gn.push(`group "${lname}" has a mask (ignored)`);
        walk(l.children, [...group, lname], hiddenAbove || !!l.hidden, gn);
        continue;
      }
      const layerNotes = [...groupNotes];
      if (l.adjustment) {
        notes.push(`Adjustment layer "${lname}" was skipped.`);
        continue;
      }
      if (l.mask) layerNotes.push('its layer mask was ignored');
      if (l.text) layerNotes.push('a text layer, imported as its rendered pixels');
      if (l.effects) layerNotes.push('its layer effects were ignored');
      const data = l.imageData;
      if (!data || !l.right || !l.bottom || l.right <= (l.left ?? 0) || l.bottom <= (l.top ?? 0)) {
        notes.push(`Layer "${lname}" has no pixels and was skipped.`);
        continue;
      }
      let rgba: Uint8Array;
      if (data.data instanceof Uint8ClampedArray || data.data instanceof Uint8Array)
        rgba = new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.length);
      else {
        // 16- or 32-bit channels: scale down to 8 bits.
        const src = data.data as unknown as ArrayLike<number>;
        const max = src instanceof Float32Array ? 1 : 65535;
        rgba = new Uint8Array(src.length);
        for (let i = 0; i < src.length; i++)
          rgba[i] = Math.max(0, Math.min(255, Math.round((src[i]! / max) * 255)));
      }
      const trimmed = trimImage({ width: data.width, height: data.height, data: rgba });
      if (!trimmed) {
        notes.push(`Layer "${lname}" is fully transparent and was skipped.`);
        continue;
      }
      layers.push({
        name: lname,
        group,
        x: (l.left ?? 0) + trimmed.x,
        y: (l.top ?? 0) + trimmed.y,
        image: { ...trimmed.image, data: Uint8Array.from(trimmed.image.data) },
        visible: !l.hidden && !hiddenAbove,
        opacity: Math.round((l.opacity ?? 1) * 255) / 255,
        blendMode: normalizeBlendMode(l.blendMode),
        clipped: !!l.clipping,
        notes: layerNotes,
      });
    }
  };
  // ag-psd lists children bottom to top.
  walk(psd.children, [], false, []);
  return { format: 'psd', width: psd.width, height: psd.height, layers, notes };
}
