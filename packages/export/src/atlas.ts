/**
 * Texture atlas (design 4.3, step 3).
 *
 * Each layer used by an exported mesh contributes one region: the union of its meshes' UV bounds
 * (in layer pixels, which may extend past the image by the mesh margin), plus padding. Regions are
 * packed into pages with a deterministic skyline packer, tallest first. Each page is then trimmed
 * to the smallest power-of-two size that holds its regions. Transparent pixels inside a region take
 * the color of the nearest opaque pixel ("bleeding"), so apps that filter without premultiplying
 * show no dark fringes.
 */
import { MochiError, type DocReader, type Uid } from '@mochi-maker/core';
import type { Image } from '@mochi-maker/geometry';
import type { TexturePlacement } from './lower.js';

export const ATLAS_PADDING = 4;

export interface AtlasRegion {
  layer: Uid;
  page: number;
  /** Position on the page. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The region's top-left corner in layer pixels. */
  layerX: number;
  layerY: number;
}

export interface Atlas {
  pages: Image[];
  regions: AtlasRegion[];
  placement: Map<Uid, TexturePlacement>;
}

interface Need {
  layer: Uid;
  order: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** The layer regions the exported meshes use. */
export function atlasNeeds(doc: DocReader): Need[] {
  const bounds = new Map<Uid, [number, number, number, number]>();
  const project = doc.project();
  for (const m of doc.ofKind('artMesh')) {
    if (!m.layer) continue;
    const b = bounds.get(m.layer) ?? [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.uv.length; i += 2) {
      b[0] = Math.min(b[0], m.uv[i]!);
      b[1] = Math.min(b[1], m.uv[i + 1]!);
      b[2] = Math.max(b[2], m.uv[i]!);
      b[3] = Math.max(b[3], m.uv[i + 1]!);
    }
    bounds.set(m.layer, b);
  }
  const needs: Need[] = [];
  for (const [layer, [x0, y0, x1, y1]] of bounds) {
    if (!Number.isFinite(x0)) continue;
    const ax = Math.floor(x0) - ATLAS_PADDING;
    const ay = Math.floor(y0) - ATLAS_PADDING;
    needs.push({
      layer,
      order: project.layerOrder.indexOf(layer),
      x0: ax,
      y0: ay,
      w: Math.ceil(x1) + ATLAS_PADDING - ax,
      h: Math.ceil(y1) + ATLAS_PADDING - ay,
    });
  }
  return needs;
}

/** Skyline bottom-left packing of one page; returns positions, or null for regions that do not fit. */
function packPage(items: Need[], size: number): Map<Uid, [number, number]> {
  // The skyline: segments [x, width, height].
  let sky: [number, number, number][] = [[0, size, 0]];
  const placed = new Map<Uid, [number, number]>();
  for (const it of items) {
    let best: { x: number; y: number; i: number } | null = null;
    for (let i = 0; i < sky.length; i++) {
      const x = sky[i]![0];
      if (x + it.w > size) break;
      let y = 0;
      let width = 0;
      for (let j = i; j < sky.length && width < it.w; j++) {
        y = Math.max(y, sky[j]![2]);
        width += sky[j]![1];
      }
      if (y + it.h > size) continue;
      if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y, i };
    }
    if (!best) continue;
    placed.set(it.layer, [best.x, best.y]);
    // Raise the skyline under the new region.
    const next: [number, number, number][] = [];
    const left = best.x;
    const right = best.x + it.w;
    for (const [x, w, h] of sky) {
      const end = x + w;
      if (end <= left || x >= right) {
        next.push([x, w, h]);
        continue;
      }
      if (x < left) next.push([x, left - x, h]);
      if (end > right) next.push([right, end - right, h]);
    }
    next.push([left, it.w, best.y + it.h]);
    next.sort((a, b) => a[0] - b[0]);
    // Merge neighbors of equal height.
    sky = [];
    for (const s of next) {
      const last = sky[sky.length - 1];
      if (last && last[2] === s[2] && last[0] + last[1] === s[0]) last[1] += s[1];
      else sky.push([...s]);
    }
  }
  return placed;
}

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * Packs the regions and draws the pages. `images` holds each needed layer's decoded image.
 * Throws E_EXPORT when a region is larger than a page.
 */
export function buildAtlas(
  doc: DocReader,
  images: ReadonlyMap<Uid, Image>,
  pageSize: number,
): Atlas {
  const needs = atlasNeeds(doc).sort((a, b) => b.h - a.h || b.w - a.w || a.order - b.order);
  for (const n of needs)
    if (n.w > pageSize || n.h > pageSize) {
      const layer = doc.get(n.layer);
      const want = Math.min(8192, pow2(Math.max(n.w, n.h)));
      throw new MochiError(
        'E_EXPORT',
        `Layer "${layer && 'name' in layer ? layer.name : n.layer}" needs ${n.w} × ${n.h} pixels, more than an atlas page of ${pageSize}.`,
        {
          fixes:
            want > pageSize
              ? [
                  {
                    description: `Use ${want}-pixel atlas pages`,
                    command: 'project.setExportSettings',
                    args: { atlasSize: want },
                  },
                ]
              : [],
        },
      );
    }
  let remaining = needs;
  const regions: AtlasRegion[] = [];
  const pages: Image[] = [];
  const placement = new Map<Uid, TexturePlacement>();
  while (remaining.length > 0) {
    const page = pages.length;
    const placed = packPage(remaining, pageSize);
    let usedW = 1;
    let usedH = 1;
    for (const n of remaining) {
      const p = placed.get(n.layer);
      if (!p) continue;
      usedW = Math.max(usedW, p[0] + n.w);
      usedH = Math.max(usedH, p[1] + n.h);
    }
    const width = Math.min(pageSize, pow2(usedW));
    const height = Math.min(pageSize, pow2(usedH));
    const data = new Uint8Array(width * height * 4);
    for (const n of remaining) {
      const p = placed.get(n.layer);
      if (!p) continue;
      const [x, y] = p;
      regions.push({
        layer: n.layer,
        page,
        x,
        y,
        width: n.w,
        height: n.h,
        layerX: n.x0,
        layerY: n.y0,
      });
      placement.set(n.layer, {
        page,
        pageWidth: width,
        pageHeight: height,
        offsetX: x - n.x0,
        offsetY: y - n.y0,
      });
      const img = images.get(n.layer);
      if (img) blit(data, width, img, n, x, y);
      bleed(data, width, x, y, n.w, n.h);
    }
    pages.push({ width, height, data });
    remaining = remaining.filter((n) => !placed.has(n.layer));
  }
  regions.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  return { pages, regions, placement };
}

function blit(
  page: Uint8Array,
  pageWidth: number,
  img: Image,
  n: Need,
  px: number,
  py: number,
): void {
  for (let j = 0; j < n.h; j++) {
    const sy = n.y0 + j;
    if (sy < 0 || sy >= img.height) continue;
    for (let i = 0; i < n.w; i++) {
      const sx = n.x0 + i;
      if (sx < 0 || sx >= img.width) continue;
      const s = 4 * (sy * img.width + sx);
      page.set(img.data.subarray(s, s + 4), 4 * ((py + j) * pageWidth + px + i));
    }
  }
}

/** Gives transparent pixels the color of an opaque neighbor, spreading outward a few steps. */
function bleed(
  page: Uint8Array,
  pageWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const known = new Uint8Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++)
      known[j * w + i] = page[4 * ((y + j) * pageWidth + x + i) + 3]! > 0 ? 1 : 0;
  for (let step = 0; step < ATLAS_PADDING + 4; step++) {
    const next = known.slice();
    let changed = false;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        if (known[j * w + i]) continue;
        for (const [di, dj] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h || !known[nj * w + ni]) continue;
          const src = 4 * ((y + nj) * pageWidth + x + ni);
          const dst = 4 * ((y + j) * pageWidth + x + i);
          page[dst] = page[src]!;
          page[dst + 1] = page[src + 1]!;
          page[dst + 2] = page[src + 2]!;
          next[j * w + i] = 1;
          changed = true;
          break;
        }
      }
    known.set(next);
    if (!changed) break;
  }
}
