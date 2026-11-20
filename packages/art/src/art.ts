/** The format-neutral result of reading layered art. */
import type { Image } from '@mochi-maker/geometry';

export interface ImportedLayer {
  name: string;
  /** Names of the enclosing groups, outermost first. */
  group: string[];
  /** Canvas position of the image's top-left pixel (after trimming). */
  x: number;
  y: number;
  /** 8-bit straight-alpha RGBA, trimmed to its non-transparent pixels. */
  image: Image;
  visible: boolean;
  opacity: number;
  /** Normalized blend mode name: normal, multiply, screen, overlay, ... */
  blendMode: string;
  /** Clipped to the layer below (PSD clipping masks). */
  clipped: boolean;
  notes: string[];
}

export interface ImportedArt {
  format: 'psd' | 'ora' | 'png-folder' | 'png';
  width: number;
  height: number;
  /** Bottom to top. */
  layers: ImportedLayer[];
  /** Things the importer could not carry over, for the import report. */
  notes: string[];
}

/** Normalizes blend-mode names from different formats to one vocabulary. */
export function normalizeBlendMode(raw: string | undefined): string {
  if (!raw) return 'normal';
  const s = raw
    .toLowerCase()
    .replace(/^svg:/, '')
    .replace(/^krita:/, '')
    .replace(/[\s_]+/g, '-');
  const map: Record<string, string> = {
    'src-over': 'normal',
    'pass-through': 'pass-through',
    plus: 'linear-dodge',
    'linear-dodge': 'linear-dodge',
    add: 'linear-dodge',
  };
  return map[s] ?? s;
}
