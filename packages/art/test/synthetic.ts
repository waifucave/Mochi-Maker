/**
 * Synthetic layered art, generated in the tests. Shapes are drawn procedurally.
 */
import { initializeCanvas, writePsd, type Psd } from 'ag-psd';
import { zipSync, strToU8 } from 'fflate';
import type { Image } from '@mochi-maker/geometry';
import { encodePng } from '@mochi-maker/art';

export function shape(
  w: number,
  h: number,
  kind: 'disc' | 'rect' | 'ring',
  rgb: [number, number, number],
  pad = 0,
): Image {
  const data = new Uint8Array(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - pad;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const inside =
        kind === 'rect'
          ? x >= pad && y >= pad && x < w - pad && y < h - pad
          : kind === 'disc'
            ? d < r
            : d < r && d > r * 0.5;
      if (inside) data.set([...rgb, 255], 4 * (y * w + x));
    }
  return { width: w, height: h, data };
}

let canvasReady = false;
function ready(): void {
  if (canvasReady) return;
  initializeCanvas(
    () => {
      throw new Error('no canvas');
    },
    (width: number, height: number) =>
      ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
        colorSpace: 'srgb',
      }) as unknown as ImageData,
  );
  canvasReady = true;
}

const img = (i: Image) =>
  ({
    width: i.width,
    height: i.height,
    data: new Uint8ClampedArray(i.data),
    colorSpace: 'srgb',
  }) as unknown as ImageData;

/**
 * A 200×150 PSD: Body (rect); group Head { Face (disc), Eye (ring, multiply, 80 %), Shade (clipped
 * to Eye), Hidden (hidden) }; 目 (a Unicode name); Empty (no pixels).
 */
export function syntheticPsd(): Uint8Array {
  ready();
  const psd: Psd = {
    width: 200,
    height: 150,
    children: [
      {
        name: 'Body',
        left: 50,
        top: 80,
        imageData: img(shape(100, 60, 'rect', [90, 120, 200], 2)),
      },
      {
        name: 'Head',
        opened: true,
        children: [
          {
            name: 'Face',
            left: 60,
            top: 10,
            imageData: img(shape(80, 80, 'disc', [250, 220, 200])),
          },
          {
            name: 'Eye',
            left: 80,
            top: 30,
            imageData: img(shape(20, 20, 'ring', [40, 40, 40])),
            blendMode: 'multiply',
            opacity: 0.8,
          },
          {
            name: 'Shade',
            left: 80,
            top: 30,
            imageData: img(shape(20, 20, 'disc', [0, 0, 255])),
            clipping: true,
          },
          {
            name: 'Hidden',
            left: 100,
            top: 30,
            imageData: img(shape(20, 20, 'disc', [0, 255, 0])),
            hidden: true,
          },
        ],
      },
      { name: '目', left: 150, top: 10, imageData: img(shape(30, 30, 'disc', [10, 10, 10])) },
      {
        name: 'Empty',
        left: 0,
        top: 0,
        imageData: img({ width: 10, height: 10, data: new Uint8Array(400) }),
      },
    ],
  };
  return new Uint8Array(writePsd(psd, { generateThumbnail: false }));
}

/** An OpenRaster file: stack (top first) = [Hat (hidden), group Head(x+10) [Eye, Face], Body]. */
export function syntheticOra(): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.5" w="120" h="100">
  <stack>
    <layer name="Hat" src="data/hat.png" x="30" y="0" visibility="hidden"/>
    <stack name="Head &amp; face" x="10" y="0" composite-op="svg:src-over">
      <layer name="Eye" src="data/eye.png" x="30" y="25" composite-op="svg:multiply" opacity="0.5"/>
      <layer name="Face" src="data/face.png" x="20" y="10"/>
    </stack>
    <layer name="Body" src="data/body.png" x="20" y="60"/>
  </stack>
</image>`;
  return zipSync({
    mimetype: strToU8('image/openraster'),
    'stack.xml': strToU8(xml),
    'data/hat.png': encodePng(shape(40, 20, 'rect', [200, 0, 0])),
    'data/eye.png': encodePng(shape(12, 12, 'disc', [0, 0, 0])),
    'data/face.png': encodePng(shape(50, 50, 'disc', [255, 210, 190])),
    'data/body.png': encodePng(shape(80, 40, 'rect', [80, 80, 160], 1)),
  });
}

/**
 * A PSD before and after an edit, for re-import. 200×150.
 * Version 1: Body (rect, blue); group Head { Face (disc at 60,10), Eye (ring 20×20 at 80,30) }; 目.
 * Version 2: Body recolored (same shape); Face moved 15 px right; Eye grown to 30×30 at 75,25;
 * 目 removed; Mouth added in Head.
 */
export function reimportPsd(version: 1 | 2): Uint8Array {
  ready();
  const v2 = version === 2;
  const head = [
    {
      name: 'Face',
      left: v2 ? 75 : 60,
      top: 10,
      imageData: img(shape(80, 80, 'disc', [250, 220, 200])),
    },
    v2
      ? { name: 'Eye', left: 75, top: 25, imageData: img(shape(30, 30, 'ring', [40, 40, 40])) }
      : { name: 'Eye', left: 80, top: 30, imageData: img(shape(20, 20, 'ring', [40, 40, 40])) },
    ...(v2
      ? [{ name: 'Mouth', left: 95, top: 65, imageData: img(shape(30, 8, 'rect', [200, 40, 60])) }]
      : []),
  ];
  const psd: Psd = {
    width: 200,
    height: 150,
    children: [
      {
        name: 'Body',
        left: 50,
        top: 80,
        imageData: img(shape(100, 60, 'rect', v2 ? [60, 160, 90] : [90, 120, 200], 2)),
      },
      { name: 'Head', opened: true, children: head },
      ...(v2
        ? []
        : [
            { name: '目', left: 150, top: 10, imageData: img(shape(30, 30, 'disc', [10, 10, 10])) },
          ]),
    ],
  };
  return new Uint8Array(writePsd(psd, { generateThumbnail: false }));
}
