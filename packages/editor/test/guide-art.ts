/**
 * The getting-started guide's example art: a small character, «Mochi», drawn here in
 * code and written as a layered PSD with ag-psd, so that the guide's steps can be followed (and are
 * tested) from the same file. Seven layers, bottom to top: Hair back, Body, Face, Eye R, Eye L,
 * Mouth, Hair front. 600 × 800 pixels; each layer is cropped to its pixels.
 */
import { initializeCanvas, writePsdUint8Array, type Layer, type Psd } from 'ag-psd';

const W = 600;
const H = 800;
type RGBA = [number, number, number, number];
/** A layer: its name, and the color at a point (null: transparent there). */
type Paint = (x: number, y: number) => RGBA | null;

const hex = (s: string): RGBA => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
  255,
];
const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const SKIN = hex('#f6d7c3');
const LAYERS: [string, Paint][] = [
  ['Hair back', (x, y) => (inEllipse(x, y, 300, 310, 178, 215) ? hex('#4a3a6a') : null)],
  [
    'Body',
    (x, y) =>
      x >= 268 && x <= 332 && y >= 420 && y <= 560
        ? SKIN
        : inEllipse(x, y, 300, 700, 165, 175) && y <= 790
          ? hex('#7fb3d5')
          : null,
  ],
  ['Face', (x, y) => (inEllipse(x, y, 300, 300, 140, 160) ? SKIN : null)],
  ...(
    [
      ['Eye R', 245],
      ['Eye L', 355],
    ] as const
  ).map(([name, cx]): [string, Paint] => [
    name,
    (x, y) =>
      inEllipse(x, y, cx + 7, 292, 7, 7)
        ? hex('#ffffff')
        : inEllipse(x, y, cx, 305, 22, 30)
          ? hex('#2c2340')
          : null,
  ]),
  ['Mouth', (x, y) => (inEllipse(x, y, 300, 388, 30, 11) ? hex('#c85a6a') : null)],
  [
    'Hair front',
    (x, y) => {
      if (!inEllipse(x, y, 300, 265, 162, 150)) return null;
      // Bangs: a scalloped lower edge.
      const edge = 215 + 28 * Math.abs(Math.sin(((x - 138) / 54) * Math.PI));
      return y <= edge ? hex('#5b4a80') : null;
    },
  ],
];

/** Coverage by 4 × 4 samples a pixel, for smooth edges. */
function rasterize(paint: Paint): {
  data: Uint8ClampedArray;
  box: [number, number, number, number];
} {
  const data = new Uint8ClampedArray(W * H * 4);
  let [x0, y0, x1, y1] = [W, H, -1, -1];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const c = paint(x + (i + 0.5) / 4, y + (j + 0.5) / 4);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      if (a === 0) continue;
      const o = (y * W + x) * 4;
      data[o] = Math.round(r / a);
      data[o + 1] = Math.round(g / a);
      data[o + 2] = Math.round(b / a);
      data[o + 3] = Math.round((a / 16) * 255);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return { data, box: [x0, y0, x1 + 1, y1 + 1] };
}

const imageData = (
  width: number,
  height: number,
  data = new Uint8ClampedArray(width * height * 4),
) => ({ width, height, data, colorSpace: 'srgb' }) as unknown as ImageData;

/** The example PSD's bytes (deterministic). */
export function examplePsd(): Uint8Array {
  initializeCanvas(
    () => {
      throw new Error('no canvas');
    },
    (w, h) => imageData(w, h),
  );
  const composite = new Uint8ClampedArray(W * H * 4);
  const children: Layer[] = [];
  for (const [name, paint] of LAYERS) {
    const { data, box } = rasterize(paint);
    const [x0, y0, x1, y1] = box;
    const cw = x1 - x0;
    const ch = y1 - y0;
    const crop = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++)
      crop.set(data.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x1) * 4), y * cw * 4);
    children.push({
      name,
      top: y0,
      left: x0,
      bottom: y1,
      right: x1,
      imageData: imageData(cw, ch, crop),
    });
    // Source-over, for the composite image.
    for (let i = 0; i < W * H; i++) {
      const a = data[i * 4 + 3]! / 255;
      if (a === 0) continue;
      const b = composite[i * 4 + 3]! / 255;
      const out = a + b * (1 - a);
      for (let c = 0; c < 3; c++)
        composite[i * 4 + c] = Math.round(
          (data[i * 4 + c]! * a + composite[i * 4 + c]! * b * (1 - a)) / out,
        );
      composite[i * 4 + 3] = Math.round(out * 255);
    }
  }
  const psd: Psd = { width: W, height: H, children, imageData: imageData(W, H, composite) };
  return writePsdUint8Array(psd, { generateThumbnail: false });
}

/**
 * The sample model's extra: a three-second idle motion that sways the head (ParamAngleZ), looped.
 * Commands for any surface; `$0` is the motion.
 */
export const IDLE_MOTION: { name: string; args: Record<string, unknown> }[] = [
  {
    name: 'motion.create',
    args: { name: 'idle', group: 'Idle', duration: 3, fps: 30, loop: true },
  },
  {
    name: 'motion.setCurve',
    args: {
      target: '$0',
      curve: {
        target: 'parameter',
        object: '@param:ParamAngleZ',
        segments: [0, 0, 1, 0.5, 0, 1, -12, 1.5, -12, 1, 2, -12, 2.5, 0, 3, 0],
      },
    },
  },
];
