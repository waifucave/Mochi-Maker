/**
 * PSD reading through ag-psd (MIT). Layers keep their pixels as stored (no cross-layer blending
 * is baked in), groups become group paths, and blend modes, opacity, clipping and visibility are
 * recorded. What cannot be carried over is noted, per layer and for the file.
 */
import {
  Budget,
  LIMITS,
  MochiError,
  checkImageSize,
  isTooLarge,
  tooLarge,
} from '@mochi-maker/core';
import { initializeCanvas, readPsd, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { normalizeBlendMode, type ImportedArt, type ImportedLayer } from './art.js';
import { inflateCount, trimImage } from './png.js';

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

const OPTIONS = {
  useImageData: true,
  skipCompositeImageData: true,
  skipThumbnail: true,
  skipLinkedFilesData: true,
} as const;

const area = (b: { top?: number; left?: number; bottom?: number; right?: number }) => {
  const w = Math.max(0, (b.right ?? 0) - (b.left ?? 0));
  const h = Math.max(0, (b.bottom ?? 0) - (b.top ?? 0));
  return { w, h };
};

/**
 * Checks a PSD against the caps before its pixels are decoded (LIMITS): the canvas from the
 * file's header; then, from a pass that reads the layers' records and keeps their channel data
 * as stored, the number of layers, each layer's and mask's size, all of them together, and every
 * zip-compressed channel, inflated in small steps and counted, against the size it is for.
 */
function checkPsd(bytes: Uint8Array, name: string): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 26 || String.fromCharCode(...bytes.subarray(0, 4)) !== '8BPS') return;
  const height = view.getUint32(14);
  const width = view.getUint32(18);
  const depth = view.getUint16(22);
  checkImageSize(width, height, name);
  let psd: Psd;
  try {
    psd = readPsd(bytes, { ...OPTIONS, useRawData: true });
  } catch (e) {
    throw new MochiError(
      'E_ASSET_FORMAT',
      `${name} could not be read as a PSD: ${(e as Error).message}`,
    );
  }
  const perChannel = Math.max(1, depth / 8);
  const pixels = new Budget(LIMITS.layerPixels, `${name}'s layers, together,`, 'pixels');
  let count = 0;
  const walk = (children: PsdLayer[] | undefined) => {
    for (const l of children ?? []) {
      if (++count > LIMITS.layers) throw tooLarge(name, count, LIMITS.layers, 'layers');
      const lname = `${name}: layer "${l.name ?? 'Layer'}"`;
      const sizes = new Map<number, number>();
      const box = (b: typeof l | undefined, what: string, ids: number[]) => {
        if (!b) return;
        const { w, h } = area(b);
        if (w === 0 || h === 0) return;
        checkImageSize(w, h, what);
        pixels.take(w * h);
        const n = depth === 1 ? Math.ceil(w / 8) * h : w * h * perChannel;
        for (const id of ids) sizes.set(id, n);
      };
      box(l, lname, [0, 1, 2, 3, 4, -1]);
      box(l.mask as typeof l | undefined, `${lname}'s mask`, [-2]);
      box(l.realMask as typeof l | undefined, `${lname}'s mask`, [-3]);
      const raw = (
        l as { rawData?: { channels: { id: number; compression: number; data?: Uint8Array }[] } }
      ).rawData;
      for (const c of raw?.channels ?? []) {
        if ((c.compression !== 2 && c.compression !== 3) || !c.data) continue;
        const max = sizes.get(c.id) ?? 0;
        inflateCount([c.data], max, () => {
          throw new MochiError(
            'E_ASSET_FORMAT',
            `${lname} is damaged or crafted: its compressed channel data inflates to more than the layer holds.`,
          );
        });
      }
      walk(l.children);
    }
  };
  walk(psd.children);
}

export function readPsdArt(bytes: Uint8Array, name = 'PSD'): ImportedArt {
  ensureImageData();
  checkPsd(bytes, name);
  let psd;
  try {
    psd = readPsd(bytes, OPTIONS);
  } catch (e) {
    if (isTooLarge(e)) throw e;
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
