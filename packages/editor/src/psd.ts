/**
 * «Export PSD of the Pose» (Ctrl+P): the model at the pose
 * the editor shows, as a Photoshop file the size of the canvas, with one layer per art mesh as
 * drawn (its deformation, opacity, colors and clipping), back to front in draw order, and the whole
 * image as the composite. Layers are cropped to their pixels; a mesh not drawn at the pose is an
 * empty layer. Written with ag-psd.
 */
import { writePsdUint8Array, type Layer, type Psd } from 'ag-psd';
import type { Editor } from './editor.js';
import { pixels } from './movie.js';
import type { Offscreen } from './offscreen.js';

export interface PsdResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  layers: { name: string; exportId: string; empty: boolean }[];
}

function crop(rgba: Uint8ClampedArray, width: number, height: number) {
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (rgba[(y * width + x) * 4 + 3]! > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    data.set(
      rgba.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4),
      y * w * 4,
    );
  return {
    left: x0,
    top: y0,
    right: x1 + 1,
    bottom: y1 + 1,
    imageData: { width: w, height: h, data },
  };
}

export async function exportPsd(editor: Editor, offscreen: Offscreen): Promise<PsdResult> {
  const r = await offscreen.layers(editor.doc, editor.poseByExportId());
  const children: Layer[] = [];
  const info: PsdResult['layers'] = [];
  for (const l of r.layers) {
    const c = crop(await pixels(l.png, r.width, r.height), r.width, r.height);
    const name = l.name || l.exportId;
    children.push(c ? { name, ...c } : { name, left: 0, top: 0, right: 0, bottom: 0 });
    info.push({ name, exportId: l.exportId, empty: !c });
  }
  const whole = await pixels(r.whole, r.width, r.height);
  const psd: Psd = {
    width: r.width,
    height: r.height,
    imageData: { width: r.width, height: r.height, data: whole },
    children,
  };
  return {
    bytes: writePsdUint8Array(psd, { generateThumbnail: false }),
    width: r.width,
    height: r.height,
    layers: info,
  };
}
