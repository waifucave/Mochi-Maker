/** Guide images: parts kept as a visual reference, made from the snapshot. */
import type { Uid } from '@mochi-maker/core';
import type { Editor } from './editor.js';
import type { Viewport } from './viewport.js';

/** The guide-image parts at the top (a guide part inside another is shown and hidden with it). */
export function guidePartsOf(editor: Editor): Uid[] {
  return editor.view
    .ofKind('part')
    .filter((p) => p.guide)
    .map((p) => p.uid);
}

/**
 * Ctrl+Shift+5: the snapshot as a guide image, a part kept as a visual reference. Its picture
 * (at most 2048 pixels a side) becomes a layer, and a quad mesh over the place it covers on the
 * canvas shows it, in a new guide part at the back.
 */
export async function saveSnapshotAsGuide(
  editor: Editor,
  viewport: Viewport,
  author = 'person',
): Promise<{ part: Uid } | null> {
  const s = viewport.snapshot;
  const quad = viewport.snapshotCanvasQuad();
  if (!s || !quad) return null;
  const k = Math.min(1, 2048 / Math.max(s.width, s.height));
  const [w, h2] = [Math.max(1, Math.round(s.width * k)), Math.max(1, Math.round(s.height * k))];
  const c = new OffscreenCanvas(w, h2);
  c.getContext('2d')!.drawImage(s.image, 0, 0, w, h2);
  const png = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  const asset = await editor.assets.put(png);
  const n = guidePartsOf(editor).length + 1;
  const xs = quad.map((q) => q[0]);
  const ys = quad.map((q) => q[1]);
  const r = await editor.runItems(
    'Save snapshot as guide image',
    [
      {
        name: 'layer.create',
        args: {
          name: `Snapshot ${n}`,
          asset,
          x: Math.floor(Math.min(...xs)),
          y: Math.floor(Math.min(...ys)),
          width: w,
          height: h2,
        },
      },
      { name: 'part.create', args: { name: `Guide image ${n}`, guide: true, index: 0 } },
      {
        name: 'mesh.create',
        args: {
          name: `Guide image ${n}`,
          part: '$1',
          layer: '$0',
          uv: [
            [0, 0],
            [w, 0],
            [w, h2],
            [0, h2],
          ],
          positions: quad,
          triangles: [
            [0, 1, 2],
            [0, 2, 3],
          ],
        },
      },
    ],
    author,
  );
  const part = r?.results[1] as { uid: Uid } | Uid | undefined;
  return part ? { part: typeof part === 'string' ? part : part.uid } : null;
}
