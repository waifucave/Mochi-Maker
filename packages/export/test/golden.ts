/**
 * Golden projects 1–3 (design 7.2). Built from commands and procedurally drawn art, so they are
 * our own synthetic data. Each tests one area of the export, with expected values computed by hand
 * from the format's meaning (the rules of §1), not by an evaluator.
 *
 * The built projects are committed under test/golden/<name>.mochi; a test checks that building
 * them again gives the same files.
 */
import {
  MemoryAssetStore,
  MemoryFileSystem,
  Session,
  runItems,
  type CommandCall,
} from '@mochi-maker/core';
import { ART_OPERATIONS, encodePng, readWavInfo } from '@mochi-maker/art';
import { OPERATIONS } from '@mochi-maker/export';
import { reimportPsd } from '../../art/test/synthetic.js';
import type { Image } from '@mochi-maker/geometry';

export interface Golden {
  name: string;
  session: Session;
  assets: MemoryAssetStore;
}

/** A solid rectangle with a 1-pixel transparent border, so the atlas has edges to bleed. */
function swatch(w: number, h: number, rgb: [number, number, number]): Image {
  const data = new Uint8Array(w * h * 4);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) data.set([...rgb, 255], 4 * (y * w + x));
  return { width: w, height: h, data };
}

async function layer(
  assets: MemoryAssetStore,
  name: string,
  img: Image,
  x: number,
  y: number,
): Promise<CommandCall> {
  const asset = await assets.put(encodePng(img));
  return {
    name: 'layer.create',
    args: { name, asset, x, y, width: img.width, height: img.height },
  };
}

const quadUv = (w: number, h: number): [number, number][] => [
  [0, 0],
  [w, 0],
  [w, h],
  [0, h],
];
const QUAD: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 3],
];

/**
 * Golden 1 — one mesh, one parameter, two keys.
 * Canvas 400 × 300, ppu 400, origin (200, 150). The mesh is a 100 × 100 quad at (50, 50).
 * ParamA = 1 moves it 40 px right and halves its opacity.
 */
export async function golden1(): Promise<Golden> {
  const session = Session.create({
    width: 400,
    height: 300,
    pixelsPerUnit: 400,
    originX: 200,
    originY: 150,
  });
  const assets = new MemoryAssetStore();
  session.runBatch('golden 1', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden1', atlasSize: 1024 } },
    {
      name: 'param.create',
      args: { exportId: 'ParamA', name: 'A', min: 0, max: 1, default: 0, keys: [0, 1] },
    },
    { name: 'part.create', args: { exportId: 'PartBody', name: 'Body' } },
    await layer(assets, 'square', swatch(100, 100, [200, 80, 60]), 50, 50),
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Square',
        name: 'Square',
        part: '$2',
        layer: '$3',
        uv: quadUv(100, 100),
        triangles: QUAD,
      },
    },
    { name: 'rig.addBinding', args: { target: '$4', parameter: '$1' } },
    {
      name: 'keyform.set',
      args: {
        target: '$4',
        cell: { '@param:ParamA': 1 },
        values: {
          positions: [
            [90, 50],
            [190, 50],
            [190, 150],
            [90, 150],
          ],
          opacity: 0.5,
        },
      },
    },
    { name: 'meta.setHitAreas', args: { hitAreas: [{ mesh: '$4', name: 'Body' }] } },
  ]);
  return { name: 'golden-1-keyforms', session, assets };
}

/**
 * Golden 2 — a rotation inside a warp, and a mesh inside the rotation.
 * Canvas 400 × 400, ppu 400, origin (200, 200).
 * - Warp_Body: 2 × 2 bilinear cells over the rectangle (100, 50)–(300, 250). ParamShift = 1 moves
 *   every grid point 20 px right.
 * - Rotation_Head: origin at the warp's (0.5, 0.25). ParamAngle −30…30 turns it −30°…30°.
 * - ArtMesh_Head: a 40 × 20 quad stored in pixels around the rotation origin: (−20, −10)–(20, 10).
 */
export async function golden2(): Promise<Golden> {
  const session = Session.create({
    width: 400,
    height: 400,
    pixelsPerUnit: 400,
    originX: 200,
    originY: 200,
  });
  const assets = new MemoryAssetStore();
  session.runBatch('golden 2', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden2', atlasSize: 1024 } },
    {
      name: 'param.create',
      args: { exportId: 'ParamAngle', min: -30, max: 30, default: 0, keys: [-30, 0, 30] },
    },
    {
      name: 'param.create',
      args: { exportId: 'ParamShift', min: 0, max: 1, default: 0, keys: [0, 1] },
    },
    { name: 'part.create', args: { exportId: 'PartBody' } },
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Body',
        part: '$3',
        rows: 2,
        cols: 2,
        cellMode: 'bilinear',
        rect: { x: 100, y: 50, width: 200, height: 200 },
      },
    },
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rotation_Head', part: '$3', parent: '$4', origin: { x: 0.5, y: 0.25 } },
    },
    await layer(assets, 'head', swatch(40, 20, [90, 160, 220]), 0, 0),
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Head',
        part: '$3',
        deformer: '$5',
        layer: '$6',
        uv: quadUv(40, 20),
        positions: [
          [-20, -10],
          [20, -10],
          [20, 10],
          [-20, 10],
        ],
        triangles: QUAD,
      },
    },
    { name: 'rig.addBinding', args: { target: '$5', parameter: '$1' } },
    {
      name: 'keyform.set',
      args: { target: '$5', cell: { '@param:ParamAngle': -30 }, values: { angle: -30 } },
    },
    {
      name: 'keyform.set',
      args: { target: '$5', cell: { '@param:ParamAngle': 30 }, values: { angle: 30 } },
    },
    { name: 'rig.addBinding', args: { target: '$4', parameter: '$2' } },
    {
      name: 'keyform.set',
      args: {
        target: '$4',
        cell: { '@param:ParamShift': 1 },
        values: {
          grid: [0, 1, 2].flatMap((r) =>
            [0, 1, 2].map((c) => [120 + 100 * c, 50 + 100 * r] as [number, number]),
          ),
        },
      },
    },
  ]);
  return { name: 'golden-2-deformers', session, assets };
}

/**
 * Golden 3 — drawing: sorting scopes, keyformed draw order, masks (normal and inverted), colors
 * through a warp, glue, and a binding whose range ends early.
 * Canvas 200 × 200, ppu 200, origin (100, 100).
 * - Part_Back (own scope, draw order 400) holds Back_A and Back_B.
 * - Part_Front (own scope, draw order 600) holds Front (draw order 500; at ParamOrder = 1 the part
 *   sorts at 300, behind Part_Back).
 * - Back_B is clipped by Back_A; Front is clipped by Back_A inverted.
 * - Warp_Tint (root, 1 × 1) has multiply (1, 0.5, 1) and screen (0.2, 0, 0); Tinted (inside it,
 *   multiply (0.5, 1, 1), screen (0, 0.5, 0)) is in the root scope.
 * - Glue_AB pulls Back_A vertex 1 (60, 20) and Back_B vertex 0 (70, 20) to their midpoint.
 * - Blink: bound to ParamOrder with keys 0…0.5 only, so it is hidden when ParamOrder > 0.501.
 */
export async function golden3(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  session.runBatch('golden 3', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden3', atlasSize: 1024 } },
    {
      name: 'param.create',
      args: { exportId: 'ParamOrder', min: 0, max: 1, default: 0, keys: [0, 0.5, 1] },
    }, // $1
    { name: 'part.create', args: { exportId: 'Part_Back', sortingScope: 'own', drawOrder: 400 } }, // $2
    { name: 'part.create', args: { exportId: 'Part_Front', sortingScope: 'own', drawOrder: 600 } }, // $3
    await layer(assets, 'a', swatch(40, 40, [255, 0, 0]), 20, 20), // $4
    await layer(assets, 'b', swatch(40, 40, [0, 255, 0]), 70, 20), // $5
    await layer(assets, 'front', swatch(60, 30, [0, 0, 255]), 30, 50), // $6
    await layer(assets, 'tinted', swatch(30, 30, [128, 128, 128]), 120, 120), // $7
    {
      name: 'mesh.create',
      args: { exportId: 'Back_A', part: '$2', layer: '$4', uv: quadUv(40, 40), triangles: QUAD },
    }, // $8
    {
      name: 'mesh.create',
      args: { exportId: 'Back_B', part: '$2', layer: '$5', uv: quadUv(40, 40), triangles: QUAD },
    }, // $9
    {
      name: 'mesh.create',
      args: { exportId: 'Front', part: '$3', layer: '$6', uv: quadUv(60, 30), triangles: QUAD },
    }, // $10
    { name: 'mesh.setClip', args: { target: '$9', masks: ['$8'] } },
    { name: 'mesh.setClip', args: { target: '$10', masks: ['$8'], invert: true } },
    { name: 'rig.addBinding', args: { target: '$3', parameter: '$1', keys: [0, 1] } },
    {
      name: 'keyform.set',
      args: { target: '$3', cell: { '@param:ParamOrder': 1 }, values: { drawOrder: 300 } },
    },
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Tint',
        rows: 1,
        cols: 1,
        rect: { x: 110, y: 110, width: 50, height: 50 },
      },
    }, // $15
    {
      name: 'keyform.set',
      args: { target: '$15', values: { multiply: [1, 0.5, 1], screen: [0.2, 0, 0] } },
    },
    {
      name: 'mesh.create',
      args: {
        exportId: 'Tinted',
        deformer: '$15',
        layer: '$7',
        uv: quadUv(30, 30),
        positions: [
          [0.2, 0.2],
          [0.8, 0.2],
          [0.8, 0.8],
          [0.2, 0.8],
        ],
        triangles: QUAD,
      },
    }, // $17
    {
      name: 'keyform.set',
      args: { target: '$17', values: { multiply: [0.5, 1, 1], screen: [0, 0.5, 0] } },
    },
    {
      name: 'glue.create',
      args: { exportId: 'Glue_AB', meshA: '$8', meshB: '$9', pairs: [[1, 0.5, 0, 0.5]] },
    },
    await layer(assets, 'blink', swatch(10, 10, [0, 0, 0]), 0, 0), // $20
    {
      name: 'mesh.create',
      args: { exportId: 'Blink', layer: '$20', uv: quadUv(10, 10), triangles: QUAD },
    }, // $21
    { name: 'rig.addBinding', args: { target: '$21', parameter: '$1', keys: [0, 0.5] } },
  ]);
  return { name: 'golden-3-drawing', session, assets };
}

const rect = (x: number, y: number, w: number, h: number): [number, number][] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

/**
 * Golden 4 — masks and colors (M7).
 * Canvas 200 × 200, ppu 200, origin (100, 100).
 * Masks:
 * - Mask_1 (20, 20) 40 × 40 and Mask_2 (100, 20) 40 × 40.
 * - Union (10, 25) 140 × 15 is clipped by both: it shows only where either mask is.
 * - Inverted (10, 42) 140 × 15 is clipped by both, inverted: it shows only where neither is.
 * - Warp_Mask (root, 1 × 1 over (100, 100)–(180, 180)) holds Mask_3 at uv 0.25…0.75, so canvas
 *   (120, 120)–(160, 160). ParamMask = 1 moves the warp 20 px right. Follower (100, 135) 90 × 10 is
 *   clipped by Mask_3, so its visible part follows the warp.
 * Colors:
 * - The chain of §1 example d): Warp_Color (root, 1 × 1 over (10, 110)–(80, 180)) with
 *   multiply (0.5, 1, 1), screen (0.2, 0, 0); Rotation_Color at the warp's (0.5, 0.5) with
 *   multiply (0.8, 0.5, 1), screen (0.5, 0, 0); Chain inside it, 30 × 30 around the origin, with
 *   multiply (1.5, 1, 0.2), screen (0, 0.4, 0). Output: multiply (0.6, 0.5, 0.2), screen
 *   (0.6, 0.4, 0).
 * - Fade (160, 20) 30 × 30: ParamTint = 1 gives multiply (0, 0.5, 1) and screen (0.4, 0, 0).
 */
export async function golden4(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  const mesh = (exportId: string, layerRef: string, w: number, h: number, extra = {}) => ({
    name: 'mesh.create',
    args: { exportId, layer: layerRef, uv: quadUv(w, h), triangles: QUAD, ...extra },
  });
  session.runBatch('golden 4', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden4', atlasSize: 1024 } },
    {
      name: 'param.create',
      args: { exportId: 'ParamTint', min: 0, max: 1, default: 0, keys: [0, 1] },
    }, // $1
    {
      name: 'param.create',
      args: { exportId: 'ParamMask', min: 0, max: 1, default: 0, keys: [0, 1] },
    }, // $2
    await layer(assets, 'mask1', swatch(40, 40, [255, 0, 0]), 20, 20), // $3
    await layer(assets, 'mask2', swatch(40, 40, [0, 255, 0]), 100, 20), // $4
    await layer(assets, 'union', swatch(140, 15, [0, 0, 255]), 10, 25), // $5
    await layer(assets, 'inverted', swatch(140, 15, [255, 255, 0]), 10, 42), // $6
    await layer(assets, 'mask3', swatch(40, 40, [255, 0, 255]), 0, 0), // $7
    await layer(assets, 'follower', swatch(90, 10, [255, 255, 255]), 100, 135), // $8
    await layer(assets, 'chain', swatch(30, 30, [128, 128, 128]), 0, 0), // $9
    await layer(assets, 'fade', swatch(30, 30, [200, 200, 200]), 160, 20), // $10
    mesh('Mask_1', '$3', 40, 40), // $11
    mesh('Mask_2', '$4', 40, 40), // $12
    mesh('Union', '$5', 140, 15), // $13
    mesh('Inverted', '$6', 140, 15), // $14
    { name: 'mesh.setClip', args: { target: '$13', masks: ['$11', '$12'] } },
    { name: 'mesh.setClip', args: { target: '$14', masks: ['$11', '$12'], invert: true } },
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Mask',
        rows: 1,
        cols: 1,
        rect: { x: 100, y: 100, width: 80, height: 80 },
      },
    }, // $17
    mesh('Mask_3', '$7', 40, 40, { deformer: '$17', positions: rect(0.25, 0.25, 0.5, 0.5) }), // $18
    mesh('Follower', '$8', 90, 10), // $19
    { name: 'mesh.setClip', args: { target: '$19', masks: ['$18'] } },
    { name: 'rig.addBinding', args: { target: '$17', parameter: '$2' } },
    {
      name: 'keyform.set',
      args: {
        target: '$17',
        cell: { '@param:ParamMask': 1 },
        // Grid points are row-major: (120, 100), (200, 100), (120, 180), (200, 180).
        values: {
          grid: [
            [120, 100],
            [200, 100],
            [120, 180],
            [200, 180],
          ],
        },
      },
    },
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Color',
        rows: 1,
        cols: 1,
        rect: { x: 10, y: 110, width: 70, height: 70 },
      },
    }, // $23
    {
      name: 'keyform.set',
      args: { target: '$23', values: { multiply: [0.5, 1, 1], screen: [0.2, 0, 0] } },
    },
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rotation_Color', parent: '$23', origin: { x: 0.5, y: 0.5 } },
    }, // $25
    {
      name: 'keyform.set',
      args: { target: '$25', values: { multiply: [0.8, 0.5, 1], screen: [0.5, 0, 0] } },
    },
    mesh('Chain', '$9', 30, 30, { deformer: '$25', positions: rect(-15, -15, 30, 30) }), // $27
    {
      name: 'keyform.set',
      args: { target: '$27', values: { multiply: [1.5, 1, 0.2], screen: [0, 0.4, 0] } },
    },
    mesh('Fade', '$10', 30, 30), // $29
    { name: 'rig.addBinding', args: { target: '$29', parameter: '$1' } },
    {
      name: 'keyform.set',
      args: {
        target: '$29',
        cell: { '@param:ParamTint': 1 },
        values: { multiply: [0, 0.5, 1], screen: [0.4, 0, 0] },
      },
    },
  ]);
  return { name: 'golden-4-masks-colors', session, assets };
}

/**
 * Golden 5 — glue (M7).
 * Canvas 200 × 200, ppu 200, origin (100, 100). Meshes A (20, 20), B (80, 40), C (140, 20), each
 * 40 × 40.
 * - Glue_AB: A vertex 1 (60, 20) with weight 0.25 and B vertex 0 (80, 40) with weight 0.75.
 *   Its intensity follows ParamGlue: 0 at 0, 1 at 1.
 * - Glue_BC, after it: B vertex 0 with C vertex 3 (140, 60), and B vertex 1 (120, 40) with C
 *   vertex 0 (140, 20), all weights 0.5, intensity 1. B vertex 0 belongs to both glues, so
 *   Glue_BC sees Glue_AB's result (§1c.10).
 */
export async function golden5(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  session.runBatch('golden 5', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden5', atlasSize: 1024 } },
    {
      name: 'param.create',
      args: { exportId: 'ParamGlue', min: 0, max: 1, default: 0, keys: [0, 1] },
    }, // $1
    await layer(assets, 'a', swatch(40, 40, [255, 0, 0]), 20, 20), // $2
    await layer(assets, 'b', swatch(40, 40, [0, 255, 0]), 80, 40), // $3
    await layer(assets, 'c', swatch(40, 40, [0, 0, 255]), 140, 20), // $4
    {
      name: 'mesh.create',
      args: { exportId: 'A', layer: '$2', uv: quadUv(40, 40), triangles: QUAD },
    }, // $5
    {
      name: 'mesh.create',
      args: { exportId: 'B', layer: '$3', uv: quadUv(40, 40), triangles: QUAD },
    }, // $6
    {
      name: 'mesh.create',
      args: { exportId: 'C', layer: '$4', uv: quadUv(40, 40), triangles: QUAD },
    }, // $7
    {
      name: 'glue.create',
      args: { exportId: 'Glue_AB', meshA: '$5', meshB: '$6', pairs: [[1, 0.25, 0, 0.75]] },
    }, // $8
    { name: 'rig.addBinding', args: { target: '$8', parameter: '$1' } },
    {
      name: 'keyform.set',
      args: { target: '$8', cell: { '@param:ParamGlue': 0 }, values: { intensity: 0 } },
    },
    {
      name: 'keyform.set',
      args: { target: '$8', cell: { '@param:ParamGlue': 1 }, values: { intensity: 1 } },
    },
    {
      name: 'glue.create',
      args: {
        exportId: 'Glue_BC',
        meshA: '$6',
        meshB: '$7',
        pairs: [
          [0, 0.5, 3, 0.5],
          [1, 0.5, 0, 0.5],
        ],
        intensity: 1,
      },
    },
  ]);
  return { name: 'golden-5-glue', session, assets };
}

/**
 * Golden 6 — model metadata (M7): hit areas, display info, user data, standard groups.
 * Canvas 400 × 400, ppu 400, origin (200, 200).
 * - Parameter groups Face > Eyes. ParamEyeLOpen and ParamEyeROpen (0…1, default 1) are in Eyes;
 *   ParamMouthOpenY (0…1, default 0) is in Face; ParamAngleX and ParamAngleY are combined.
 * - Parts Head and Body. Meshes Head (150, 60) 100 × 100, Body (120, 200) 160 × 140, EyeL
 *   (170, 100) 20 × 10 (closed flat at ParamEyeLOpen = 0), Mouth (185, 135) 30 × 10 (twice as
 *   tall at ParamMouthOpenY = 1).
 * - Hit areas Head and Body; EyeBlink = the two eye parameters; LipSync = the mouth.
 * - User data on the Head mesh, the Head part and the mouth parameter.
 */
export async function golden6(): Promise<Golden> {
  const session = Session.create({
    width: 400,
    height: 400,
    pixelsPerUnit: 400,
    originX: 200,
    originY: 200,
  });
  const assets = new MemoryAssetStore();
  const unit = { min: 0, max: 1, keys: [0, 1] };
  const angle = { min: -30, max: 30, default: 0, keys: [-30, 0, 30] };
  session.runBatch('golden 6', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden6', atlasSize: 1024 } },
    { name: 'paramGroup.create', args: { exportId: 'ParamGroupFace', name: 'Face' } }, // $1
    {
      name: 'paramGroup.create',
      args: { exportId: 'ParamGroupEyes', name: 'Eyes', parent: '$1' },
    }, // $2
    {
      name: 'param.create',
      args: { exportId: 'ParamEyeLOpen', name: 'Eye L Open', default: 1, group: '$2', ...unit },
    }, // $3
    {
      name: 'param.create',
      args: { exportId: 'ParamEyeROpen', name: 'Eye R Open', default: 1, group: '$2', ...unit },
    }, // $4
    {
      name: 'param.create',
      args: { exportId: 'ParamMouthOpenY', name: 'Mouth Open', default: 0, group: '$1', ...unit },
    }, // $5
    { name: 'param.create', args: { exportId: 'ParamAngleX', name: 'Angle X', ...angle } }, // $6
    { name: 'param.create', args: { exportId: 'ParamAngleY', name: 'Angle Y', ...angle } }, // $7
    { name: 'part.create', args: { exportId: 'PartHead', name: 'Head' } }, // $8
    { name: 'part.create', args: { exportId: 'PartBody', name: 'Body' } }, // $9
    await layer(assets, 'head', swatch(100, 100, [240, 200, 170]), 150, 60), // $10
    await layer(assets, 'body', swatch(160, 140, [60, 90, 160]), 120, 200), // $11
    await layer(assets, 'eye', swatch(20, 10, [20, 20, 20]), 170, 100), // $12
    await layer(assets, 'mouth', swatch(30, 10, [180, 40, 40]), 185, 135), // $13
    {
      name: 'mesh.create',
      args: { exportId: 'Head', part: '$8', layer: '$10', uv: quadUv(100, 100), triangles: QUAD },
    }, // $14
    {
      name: 'mesh.create',
      args: { exportId: 'Body', part: '$9', layer: '$11', uv: quadUv(160, 140), triangles: QUAD },
    }, // $15
    {
      name: 'mesh.create',
      args: { exportId: 'EyeL', part: '$8', layer: '$12', uv: quadUv(20, 10), triangles: QUAD },
    }, // $16
    {
      name: 'mesh.create',
      args: { exportId: 'Mouth', part: '$8', layer: '$13', uv: quadUv(30, 10), triangles: QUAD },
    }, // $17
    { name: 'rig.addBinding', args: { target: '$16', parameter: '$3' } },
    {
      name: 'keyform.set',
      args: {
        target: '$16',
        cell: { '@param:ParamEyeLOpen': 0 },
        values: { positions: rect(170, 105, 20, 0) },
      },
    },
    { name: 'rig.addBinding', args: { target: '$17', parameter: '$5' } },
    {
      name: 'keyform.set',
      args: {
        target: '$17',
        cell: { '@param:ParamMouthOpenY': 1 },
        values: { positions: rect(185, 135, 30, 20) },
      },
    },
    {
      name: 'meta.setHitAreas',
      args: {
        hitAreas: [
          { mesh: '$14', name: 'Head' },
          { mesh: '$15', name: 'Body' },
        ],
      },
    },
    { name: 'meta.setStandardGroups', args: { eyeBlink: ['$3', '$4'], lipSync: ['$5'] } },
    { name: 'meta.setCombinedParameters', args: { pairs: [['$6', '$7']] } },
    {
      name: 'meta.setUserData',
      args: {
        entries: [
          { target: '$14', value: 'face' },
          { target: '$8', value: 'head part' },
          { target: '$5', value: 'mouth ✓' },
        ],
      },
    },
  ]);
  return { name: 'golden-6-metadata', session, assets };
}

/**
 * Golden 7 — blend shapes on positions (M8): what version 4 carries.
 * Canvas 400 × 400, ppu 400, origin (200, 200).
 * - Mouth (150, 200) 100 × 40, top level. Normal rig: ParamOpen = 1 moves its bottom edge 20 px down.
 *   - Blend shape ParamSmile (keys −1, 0, 1, base 0): at 1 the top corners rise 10 px, at −1 they
 *     sink 10 px. Constraint over ParamOpen: weight 1 at 0, 0 at 1, so opening the mouth fades the
 *     smile out.
 *   - Blend shape ParamWide (keys 0, 1, base 0): at 1 the left edge moves 10 px left and the right
 *     edge 10 px right. No constraints.
 * - Warp_Brow (root, 1 × 1 over (100, 50)–(300, 150)). Blend shape ParamLift (keys 0, 1): at 1 every
 *   grid point moves 20 px up. Brow is inside it at uv 0.25…0.75: canvas (150, 75)–(250, 125).
 */
export async function golden7(): Promise<Golden> {
  const session = Session.create({
    width: 400,
    height: 400,
    pixelsPerUnit: 400,
    originX: 200,
    originY: 200,
  });
  const assets = new MemoryAssetStore();
  const shape = (exportId: string, keys: number[]) => ({
    name: 'param.create',
    args: {
      exportId,
      min: keys[0]!,
      max: keys[keys.length - 1]!,
      default: 0,
      keys,
      type: 'blendShape',
    },
  });
  session.runBatch('golden 7', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden7', atlasSize: 1024 } },
    {
      name: 'param.create',
      args: { exportId: 'ParamOpen', min: 0, max: 1, default: 0, keys: [0, 1] },
    }, // $1
    shape('ParamSmile', [-1, 0, 1]), // $2
    shape('ParamWide', [0, 1]), // $3
    shape('ParamLift', [0, 1]), // $4
    await layer(assets, 'mouth', swatch(100, 40, [200, 60, 60]), 150, 200), // $5
    await layer(assets, 'brow', swatch(100, 50, [60, 40, 20]), 0, 0), // $6
    {
      name: 'mesh.create',
      args: { exportId: 'Mouth', layer: '$5', uv: quadUv(100, 40), triangles: QUAD },
    }, // $7
    { name: 'rig.addBinding', args: { target: '$7', parameter: '$1' } },
    {
      name: 'keyform.set',
      args: {
        target: '$7',
        cell: { '@param:ParamOpen': 1 },
        values: { positions: rect(150, 200, 100, 60) },
      },
    },
    { name: 'blendShape.add', args: { target: '$7', parameter: '$2' } },
    {
      name: 'blendShape.set',
      args: {
        target: '$7',
        parameter: '$2',
        key: 1,
        values: {
          positions: [
            [0, -10],
            [0, -10],
            [0, 0],
            [0, 0],
          ],
        },
      },
    },
    {
      name: 'blendShape.set',
      args: {
        target: '$7',
        parameter: '$2',
        key: -1,
        values: {
          positions: [
            [0, 10],
            [0, 10],
            [0, 0],
            [0, 0],
          ],
        },
      },
    },
    {
      name: 'blendShape.setConstraints',
      args: {
        target: '$7',
        parameter: '$2',
        constraints: [
          {
            parameter: '$1',
            points: [
              [0, 1],
              [1, 0],
            ],
          },
        ],
      },
    },
    { name: 'blendShape.add', args: { target: '$7', parameter: '$3' } },
    {
      name: 'blendShape.set',
      args: {
        target: '$7',
        parameter: '$3',
        key: 1,
        values: {
          positions: [
            [-10, 0],
            [10, 0],
            [10, 0],
            [-10, 0],
          ],
        },
      },
    },
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Brow',
        rows: 1,
        cols: 1,
        rect: { x: 100, y: 50, width: 200, height: 100 },
      },
    }, // $16
    { name: 'blendShape.add', args: { target: '$16', parameter: '$4' } },
    {
      name: 'blendShape.set',
      args: {
        target: '$16',
        parameter: '$4',
        key: 1,
        values: {
          grid: [
            [0, -20],
            [0, -20],
            [0, -20],
            [0, -20],
          ],
        },
      },
    },
    {
      name: 'mesh.create',
      args: {
        exportId: 'Brow',
        deformer: '$16',
        layer: '$6',
        uv: quadUv(100, 50),
        positions: rect(0.25, 0.25, 0.5, 0.5),
        triangles: QUAD,
      },
    },
  ]);
  return { name: 'golden-7-blend-positions', session, assets };
}

/**
 * Golden 8 — blend shapes on every value (M8): version 5 only.
 * Canvas 200 × 200, ppu 200, origin (100, 100). ParamBS (keys 0, 1, base 0) drives every blend
 * shape; ParamC and ParamC2 (normal, 0…1) constrain Face's.
 * - Face (20, 20) 40 × 40: at ParamBS = 1, opacity −0.5, multiply (−0.5, 0, 0), screen
 *   (0, 0.25, 0), draw order +20. Constraints: ParamC (0 → 1, 1 → 0) and ParamC2 (0 → 1, 1 → 0.5);
 *   the weight is their minimum.
 * - Part_BS (own sorting scope, draw order 500) holds Inner (120, 20) 40 × 40. At ParamBS = 1 the
 *   part's draw order goes −20, so it can sort at 480.
 * - Rotation_BS (root, origin (140, 60)): at ParamBS = 1, angle +30, origin x +10 px, scale +0.5.
 *   Arm is inside it, 20 × 10 around the origin, in pixels.
 * - Warp_Fade (root, 1 × 1 over (120, 120)–(180, 180)): at ParamBS = 1, opacity −0.5 and multiply
 *   (0, −0.5, 0). Tinted is inside it at uv 0.25…0.75.
 * The root group's members reach 480 (Part_BS) to 520 (Face), the range genuine files store for
 * this pattern.
 */
export async function golden8(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  const unit = { min: 0, max: 1, default: 0, keys: [0, 1] };
  session.runBatch('golden 8', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden8', atlasSize: 1024 } },
    { name: 'param.create', args: { exportId: 'ParamBS', type: 'blendShape', ...unit } }, // $1
    { name: 'param.create', args: { exportId: 'ParamC', ...unit } }, // $2
    { name: 'param.create', args: { exportId: 'ParamC2', ...unit } }, // $3
    await layer(assets, 'face', swatch(40, 40, [200, 200, 200]), 20, 20), // $4
    await layer(assets, 'inner', swatch(40, 40, [90, 160, 90]), 120, 20), // $5
    await layer(assets, 'arm', swatch(20, 10, [90, 90, 160]), 0, 0), // $6
    await layer(assets, 'tinted', swatch(30, 30, [160, 160, 160]), 0, 0), // $7
    {
      name: 'mesh.create',
      args: { exportId: 'Face', layer: '$4', uv: quadUv(40, 40), triangles: QUAD },
    }, // $8
    { name: 'blendShape.add', args: { target: '$8', parameter: '$1' } },
    {
      name: 'blendShape.set',
      args: {
        target: '$8',
        parameter: '$1',
        key: 1,
        values: { opacity: -0.5, multiply: [-0.5, 0, 0], screen: [0, 0.25, 0], drawOrder: 20 },
      },
    },
    {
      name: 'blendShape.setConstraints',
      args: {
        target: '$8',
        parameter: '$1',
        constraints: [
          {
            parameter: '$2',
            points: [
              [0, 1],
              [1, 0],
            ],
          },
          {
            parameter: '$3',
            points: [
              [0, 1],
              [1, 0.5],
            ],
          },
        ],
      },
    },
    { name: 'part.create', args: { exportId: 'Part_BS', sortingScope: 'own', drawOrder: 500 } }, // $12
    {
      name: 'mesh.create',
      args: { exportId: 'Inner', part: '$12', layer: '$5', uv: quadUv(40, 40), triangles: QUAD },
    }, // $13
    { name: 'blendShape.add', args: { target: '$12', parameter: '$1' } },
    {
      name: 'blendShape.set',
      args: { target: '$12', parameter: '$1', key: 1, values: { drawOrder: -20 } },
    },
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rotation_BS', origin: { x: 140, y: 60 } },
    }, // $16
    { name: 'blendShape.add', args: { target: '$16', parameter: '$1' } },
    {
      name: 'blendShape.set',
      args: {
        target: '$16',
        parameter: '$1',
        key: 1,
        values: { angle: 30, originX: 10, scale: 0.5 },
      },
    },
    {
      name: 'mesh.create',
      args: {
        exportId: 'Arm',
        deformer: '$16',
        layer: '$6',
        uv: quadUv(20, 10),
        positions: rect(-10, -5, 20, 10),
        triangles: QUAD,
      },
    },
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Fade',
        rows: 1,
        cols: 1,
        rect: { x: 120, y: 120, width: 60, height: 60 },
      },
    }, // $20
    { name: 'blendShape.add', args: { target: '$20', parameter: '$1' } },
    {
      name: 'blendShape.set',
      args: {
        target: '$20',
        parameter: '$1',
        key: 1,
        values: { opacity: -0.5, multiply: [0, -0.5, 0] },
      },
    },
    {
      name: 'mesh.create',
      args: {
        exportId: 'Tinted',
        deformer: '$20',
        layer: '$7',
        uv: quadUv(30, 30),
        positions: rect(0.25, 0.25, 0.5, 0.5),
        triangles: QUAD,
      },
    },
  ]);
  return { name: 'golden-8-blend-values', session, assets };
}

/**
 * Golden 9 — draw orders at the formula's edges. Each mesh is
 * a 10 × 10 quad in a row; ParamEdge (blend shape, keys 0 and 1) drives the draw-order deltas.
 * Values are float32. At ParamEdge = 0 / 1 the draw orders are:
 * - Near: 499.9995 (within 0.001 below 500), no blend shape → 500 / 500
 * - Below: 499.99896, no blend shape → 499 / 499
 * - Up: 500, delta +0.9995 → 500 / 501
 * - Small: 500, delta −0.0005 → 500 / 500
 * - Down: 500, delta −0.002 → 500 / 499
 * - Neg: −3.7, no blend shape → −3 / −3
 * - NegTarget: −3.7, delta 0 (a target that never contributes) → 0 / 0
 * - Part_Edge (own scope, draw order 500.7, delta −0.6) holds Inside → part key 500 / 499
 */
export async function golden9(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  const calls: CommandCall[] = [
    { name: 'project.setExportSettings', args: { fileStem: 'golden9', atlasSize: 1024 } },
    {
      name: 'param.create',
      args: { exportId: 'ParamEdge', min: 0, max: 1, default: 0, keys: [0, 1], type: 'blendShape' },
    },
    await layer(assets, 'dot', swatch(10, 10, [120, 120, 120]), 0, 0),
  ];
  const meshes: [string, number, number | null][] = [
    ['Near', 499.9995, null],
    ['Below', 499.99896, null],
    ['Up', 500, 0.9995],
    ['Small', 500, -0.0005],
    ['Down', 500, -0.002],
    ['Neg', -3.7, null],
    ['NegTarget', -3.7, 0],
  ];
  meshes.forEach(([id, drawOrder, delta], i) => {
    calls.push(
      {
        name: 'mesh.create',
        args: {
          exportId: id,
          layer: '$2',
          uv: quadUv(10, 10),
          positions: rect(10 + 20 * i, 10, 10, 10),
          triangles: QUAD,
          drawOrder,
        },
      },
      { name: 'keyform.set', args: { target: `@mesh:${id}`, values: { drawOrder } } },
    );
    if (delta !== null)
      calls.push(
        { name: 'blendShape.add', args: { target: `@mesh:${id}`, parameter: '@param:ParamEdge' } },
        {
          name: 'blendShape.set',
          args: {
            target: `@mesh:${id}`,
            parameter: '@param:ParamEdge',
            key: 1,
            values: { drawOrder: delta },
          },
        },
      );
  });
  calls.push(
    {
      name: 'part.create',
      args: { exportId: 'Part_Edge', sortingScope: 'own', drawOrder: 500.7 },
    },
    {
      name: 'mesh.create',
      args: {
        exportId: 'Inside',
        part: '@part:Part_Edge',
        layer: '$2',
        uv: quadUv(10, 10),
        positions: rect(10, 40, 10, 10),
        triangles: QUAD,
      },
    },
    { name: 'blendShape.add', args: { target: '@part:Part_Edge', parameter: '@param:ParamEdge' } },
    {
      name: 'blendShape.set',
      args: {
        target: '@part:Part_Edge',
        parameter: '@param:ParamEdge',
        key: 1,
        values: { drawOrder: -0.6 },
      },
    },
  );
  session.runBatch('golden 9', calls);
  return { name: 'golden-9-draw-order-edges', session, assets };
}

/**
 * Golden 10 — glue blend shapes: glue and blend shapes are
 * both flagged. Canvas 200 × 200, ppu 200, origin (100, 100). Three pairs of 20 × 20 meshes, side
 * by side with a 20 px gap; each pair is joined at A's vertex 1 and B's vertex 0, weights 0.5 / 0.5,
 * normal intensity 0.5. ParamGlueBS (blend shape, keys 0 and 1) drives:
 * - Glue_Up: +0.3 → intensity 0.5 + 0.3·g;
 * - Glue_Down: −0.5 → 0.5 − 0.5·g;
 * - Glue_Clamp: +0.8 → min(1, 0.5 + 0.8·g): a blend-shape target's intensity is clamped to 0…1.
 */
export async function golden10(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  const calls: CommandCall[] = [
    { name: 'project.setExportSettings', args: { fileStem: 'golden10', atlasSize: 1024 } },
    {
      name: 'param.create',
      args: {
        exportId: 'ParamGlueBS',
        min: 0,
        max: 1,
        default: 0,
        keys: [0, 1],
        type: 'blendShape',
      },
    },
    await layer(assets, 'tile', swatch(20, 20, [150, 100, 200]), 0, 0),
  ];
  const glues: [string, number][] = [
    ['Up', 0.3],
    ['Down', -0.5],
    ['Clamp', 0.8],
  ];
  glues.forEach(([name, delta], i) => {
    const y = 20 + 50 * i;
    for (const [side, x] of [
      ['A', 20],
      ['B', 60],
    ] as const)
      calls.push({
        name: 'mesh.create',
        args: {
          exportId: `${name}_${side}`,
          layer: '$2',
          uv: quadUv(20, 20),
          positions: rect(x, y, 20, 20),
          triangles: QUAD,
        },
      });
    calls.push(
      {
        name: 'glue.create',
        args: {
          exportId: `Glue_${name}`,
          meshA: `@mesh:${name}_A`,
          meshB: `@mesh:${name}_B`,
          pairs: [[1, 0.5, 0, 0.5]],
          intensity: 0.5,
        },
      },
      {
        name: 'blendShape.add',
        args: { target: `@glue:Glue_${name}`, parameter: '@param:ParamGlueBS' },
      },
      {
        name: 'blendShape.set',
        args: {
          target: `@glue:Glue_${name}`,
          parameter: '@param:ParamGlueBS',
          key: 1,
          values: { intensity: delta },
        },
      },
    );
  });
  session.runBatch('golden 10', calls);
  return { name: 'golden-10-glue-blend-shapes', session, assets };
}

/**
 * Golden 11 — expressions, pose and physics (M9). Canvas 200 × 200, ppu 200, origin (100, 100).
 * - Expressions: "smile" (fade in and out 0.5 s): ParamA Add 4, ParamB Multiply 1.5, ParamC
 *   Overwrite 7. "frown" (fade in 0): ParamA Add −2.
 * - Pose: one group, PartArmA (linked to PartArmLink) then PartArmB, fade 0.5 s. Parameters named
 *   PartArmA (default 0) and PartArmB (default 1) give the entries' values (§3o), so PartArmB
 *   is the visible entry and fades in.
 * - Physics: one setting, input ParamIn (X, 100 %), output ParamOut (Angle, particle 1), two
 *   particles. ParamIn's default is 5, so the pendulum's root starts displaced.
 */
export async function golden11(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  const param = (exportId: string, min: number, max: number, def: number) => ({
    name: 'param.create',
    args: { exportId, min, max, default: def },
  });
  const part = (exportId: string) => ({ name: 'part.create', args: { exportId } });
  const calls: CommandCall[] = [
    { name: 'project.setExportSettings', args: { fileStem: 'golden11', atlasSize: 1024 } },
    param('ParamA', -10, 10, 0),
    param('ParamB', 0, 2, 1),
    param('ParamC', -10, 10, 0),
    param('ParamIn', -10, 10, 5),
    param('ParamOut', -30, 30, 0),
    param('PartArmA', 0, 1, 0),
    param('PartArmB', 0, 1, 1),
    part('PartArmA'),
    part('PartArmB'),
    part('PartArmLink'),
    await layer(assets, 'tile', swatch(20, 20, [100, 150, 200]), 0, 0),
  ];
  for (const [i, p] of ['PartArmA', 'PartArmB', 'PartArmLink'].entries())
    calls.push({
      name: 'mesh.create',
      args: {
        exportId: `Mesh_${p}`,
        part: `@part:${p}`,
        layer: '$11',
        uv: quadUv(20, 20),
        positions: rect(20 + 40 * i, 20, 20, 20),
        triangles: QUAD,
      },
    });
  calls.push(
    {
      name: 'expression.create',
      args: {
        name: 'smile',
        fadeIn: 0.5,
        fadeOut: 0.5,
        entries: [
          { parameter: '@param:ParamA', value: 4, blend: 'Add' },
          { parameter: '@param:ParamB', value: 1.5, blend: 'Multiply' },
          { parameter: '@param:ParamC', value: 7, blend: 'Overwrite' },
        ],
      },
    },
    {
      name: 'expression.create',
      args: {
        name: 'frown',
        fadeIn: 0,
        fadeOut: 0,
        entries: [{ parameter: '@param:ParamA', value: -2, blend: 'Add' }],
      },
    },
    {
      name: 'pose.setGroups',
      args: {
        fadeIn: 0.5,
        groups: [
          [{ part: '@part:PartArmA', links: ['@part:PartArmLink'] }, { part: '@part:PartArmB' }],
        ],
      },
    },
    {
      name: 'physics.addSetting',
      args: {
        name: 'Swing',
        inputs: [{ parameter: '@param:ParamIn', weight: 100, type: 'X' }],
        outputs: [
          { parameter: '@param:ParamOut', weight: 100, type: 'Angle', particle: 1, scale: 1 },
        ],
        particles: [
          { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
          { x: 0, y: 10, mobility: 0.95, delay: 0.9, acceleration: 1.5, radius: 10 },
        ],
        normalization: {
          position: { min: -10, default: 0, max: 10 },
          angle: { min: -10, default: 0, max: 10 },
        },
      },
    },
  );
  session.runBatch('golden 11', calls);
  return { name: 'golden-11-animation', session, assets };
}

/**
 * Golden 12 — motions (M10). Canvas 200 × 200, ppu 200, origin (100, 100). Parameters −100…100,
 * default 0. Steps of 0.125 s keep every time exact in binary.
 * - "curves" (group TapBody, 2 s, fades 0): P_Linear (0,0)→(1,20)→(2,−10) linear; P_Step stepped
 *   to (0.5, 5) then inverse stepped to (1.5, 8); P_Bez a solved Bézier (0,0) c(0.25,10) c(0.75,30)
 *   (1,40), then linear to (2, 40); P_Fade constant 50 with its own 1 s fade-in; the model's
 *   Opacity from 1 to 0.5; events "half" at 0.5 s and "late" at 1.5 s.
 * - "close" (group TapHead, 2 s, fades 0): PartOpacity curves switch the pose group
 *   [Part_Open, Part_Closed] (fade 0) at 1 s.
 * - "loop" (group Idle, 1 s, fps 8, restricted Béziers): P_Loop linear (0,0)→(1,10); P_BezR a
 *   restricted Bézier (0,0) c(0.2,30) c(0.8,−10) (1,10).
 */
export async function golden12(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  const calls: CommandCall[] = [
    { name: 'project.setExportSettings', args: { fileStem: 'golden12', atlasSize: 1024 } },
    await layer(assets, 'tile', swatch(20, 20, [200, 120, 80]), 0, 0),
  ];
  for (const id of ['P_Linear', 'P_Step', 'P_Bez', 'P_Fade', 'P_Loop', 'P_BezR'])
    calls.push({ name: 'param.create', args: { exportId: id, min: -100, max: 100, default: 0 } });
  for (const [i, part] of ['Part_Open', 'Part_Closed'].entries())
    calls.push(
      { name: 'part.create', args: { exportId: part } },
      {
        name: 'mesh.create',
        args: {
          exportId: `Mesh_${part}`,
          part: `@part:${part}`,
          layer: '$1',
          uv: quadUv(20, 20),
          positions: rect(20 + 40 * i, 20, 20, 20),
          triangles: QUAD,
        },
      },
    );
  const curve = (motion: string, curve: Record<string, unknown>) => ({
    name: 'motion.setCurve',
    args: { target: `@motion~"${motion}"`, curve },
  });
  const param = (id: string, segments: number[], extra: Record<string, unknown> = {}) => ({
    target: 'parameter',
    object: `@param:${id}`,
    segments,
    ...extra,
  });
  calls.push(
    {
      name: 'motion.create',
      args: { name: 'curves', group: 'TapBody', duration: 2, fps: 8, fadeIn: 0, fadeOut: 0 },
    },
    curve('curves', { target: 'model', model: 'Opacity', segments: [0, 1, 0, 2, 0.5] }),
    curve('curves', param('P_Linear', [0, 0, 0, 1, 20, 0, 2, -10])),
    curve('curves', param('P_Step', [0, 0, 2, 0.5, 5, 3, 1.5, 8])),
    curve('curves', param('P_Bez', [0, 0, 1, 0.25, 10, 0.75, 30, 1, 40, 0, 2, 40])),
    curve('curves', param('P_Fade', [0, 50, 0, 2, 50], { fadeIn: 1 })),
    {
      name: 'motion.setEvents',
      args: {
        target: '@motion~"curves"',
        events: [
          { time: 0.5, value: 'half' },
          { time: 1.5, value: 'late' },
        ],
      },
    },
    {
      name: 'motion.create',
      args: { name: 'close', group: 'TapHead', duration: 2, fps: 8, fadeIn: 0, fadeOut: 0 },
    },
    curve('close', { target: 'partOpacity', object: '@part:Part_Open', segments: [0, 1, 2, 1, 0] }),
    curve('close', {
      target: 'partOpacity',
      object: '@part:Part_Closed',
      segments: [0, 0, 2, 1, 1],
    }),
    {
      name: 'motion.create',
      args: {
        name: 'loop',
        group: 'Idle',
        duration: 1,
        fps: 8,
        loop: true,
        restrictedBeziers: true,
        fadeIn: 0,
        fadeOut: 0,
      },
    },
    curve('loop', param('P_Loop', [0, 0, 0, 1, 10])),
    curve('loop', param('P_BezR', [0, 0, 1, 0.2, 30, 0.8, -10, 1, 10])),
    {
      name: 'pose.setGroups',
      args: { fadeIn: 0, groups: [[{ part: '@part:Part_Open' }, { part: '@part:Part_Closed' }]] },
    },
  );
  session.runBatch('golden 12', calls);
  return { name: 'golden-12-motions', session, assets };
}

/** A mono 16-bit WAV: a square wave of the given amplitude (RMS = amplitude), 16 kHz. */
export function squareWav(amplitude: number, seconds: number, rate = 16000): Uint8Array {
  const n = Math.round(seconds * rate);
  const wav = new Uint8Array(44 + 2 * n);
  const v = new DataView(wav.buffer);
  const tag = (o: number, t: string) =>
    [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + 2 * n, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, 2 * rate, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, 2 * n, true);
  const level = Math.round(amplitude * 32768);
  for (let i = 0; i < n; i++) v.setInt16(44 + 2 * i, (i >> 4) % 2 ? level : -level, true);
  return wav;
}

/**
 * Golden 13 — a motion with a sound. ParamMouthOpenY is the LipSync group; the motion
 * "talk" (TapBody, 1 s) starts "voice", one second of a ±0.5 square wave (RMS 0.5), so lip sync
 * opens the mouth by 0.5 while it plays (§3b.2, 3s).
 */
export async function golden13(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  const wav = squareWav(0.5, 1);
  const info = readWavInfo(wav);
  const asset = await assets.put(wav);
  session.runBatch('golden 13', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden13', atlasSize: 1024 } },
    await layer(assets, 'mouth', swatch(30, 10, [180, 40, 40]), 85, 95), // $1
    {
      name: 'param.create',
      args: { exportId: 'ParamMouthOpenY', min: 0, max: 1, default: 0, keys: [0, 1] },
    }, // $2
    {
      name: 'mesh.create',
      args: { exportId: 'Mouth', layer: '$1', uv: quadUv(30, 10), triangles: QUAD },
    }, // $3
    { name: 'rig.addBinding', args: { target: '$3', parameter: '$2' } },
    {
      name: 'keyform.set',
      args: {
        target: '$3',
        cell: { '@param:ParamMouthOpenY': 1 },
        values: { positions: rect(85, 95, 30, 20) },
      },
    },
    { name: 'meta.setStandardGroups', args: { lipSync: ['$2'] } },
    {
      name: 'sound.create',
      args: {
        name: 'voice',
        asset,
        sampleRate: info.sampleRate,
        channels: info.channels,
        frames: info.frames,
      },
    }, // $7
    {
      name: 'motion.create',
      args: { name: 'talk', group: 'TapBody', duration: 1, fps: 30, fadeIn: 0, fadeOut: 0 },
    }, // $8
    { name: 'motion.update', args: { target: '$8', sound: '$7' } },
  ]);
  return { name: 'golden-13-sound', session, assets };
}

/**
 * Golden 14 — re-import. A 200 × 150 PSD imported (layers, parts and generated meshes),
 * then edited and re-imported: Body recolored, Face moved 15 px right, Eye grown, 目 removed, Mouth
 * added. The meshes keep their positions; Face's and Eye's texture coordinates follow their layers'
 * new corners, 目's mesh stays with its old pixels, and Mouth is a layer without a mesh.
 */
export async function golden14(): Promise<Golden> {
  const session = Session.create({ width: 200, height: 150 });
  const assets = new MemoryAssetStore();
  const fs = new MemoryFileSystem();
  const ctx = { session, assets, fs };
  const path = 'art/character.psd';
  await fs.writeBytes(path, reimportPsd(1));
  await runItems(ctx, 'Import', [{ name: 'art.import', args: { path } }], {
    operations: ART_OPERATIONS,
  });
  session.run('project.setExportSettings', { fileStem: 'golden14', atlasSize: 1024 });
  await fs.writeBytes(path, reimportPsd(2));
  await runItems(ctx, 'Re-import', [{ name: 'art.reimport', args: { path } }], {
    operations: ART_OPERATIONS,
  });
  return { name: 'golden-14-reimport', session, assets };
}

/**
 * Golden 15 — nested deformers (M4), reparenting with conversion, and a canvas-space
 * edit. Canvas 400 × 400, ppu 400, origin (200, 200).
 * - Warp_Outer (root, 2 × 2 bilinear) over (50, 50)–(350, 350). ParamBend = 1 pushes its center
 *   point 30 px right and its top-middle point 10 px down.
 * - Rotation_Head inside it at (0.5, 0.3), that is (200, 140) at rest; scale 1.2 and angle 10° at
 *   ParamAngle = 0 (−20° and 40° at −30 and 30).
 * - Warp_Face (1 × 1) inside the rotation over (−60, −40)–(60, 40) pixels around its origin.
 * - Rotation_Eye inside the face warp at (0.3, 0.4), holding ArtMesh_Eye (20 × 10 pixels).
 * - ArtMesh_Face fills Warp_Face.
 * Then, through the deformer operations:
 * - mesh.reparent puts ArtMesh_Badge (a 30 × 30 square at (185, 300), bound to ParamBend: 20 px
 *   right at 1) into Warp_Face, keeping it in place at rest.
 * - deformer.reparent puts Rotation_Hat (root, origin (200, 100), scale 1.5, holding ArtMesh_Hat)
 *   under Rotation_Head, keeping its world frame: angle −10°, scale 1.25.
 * - keyform.moveInCanvas moves ArtMesh_Face's vertex 2 by (10, 5) canvas pixels.
 */
export async function golden15(): Promise<Golden> {
  const session = Session.create({
    width: 400,
    height: 400,
    pixelsPerUnit: 400,
    originX: 200,
    originY: 200,
  });
  const assets = new MemoryAssetStore();
  const grid = (x: number, y: number, w: number, h: number, n: number): [number, number][] =>
    [...Array(n + 1).keys()].flatMap((r) =>
      [...Array(n + 1).keys()].map((c) => [x + (w * c) / n, y + (h * r) / n] as [number, number]),
    );
  const bent = grid(50, 50, 300, 300, 2);
  bent[4] = [bent[4]![0] + 30, bent[4]![1]];
  bent[1] = [bent[1]![0], bent[1]![1] + 10];
  session.runBatch('golden 15', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden15', atlasSize: 1024 } },
    {
      name: 'param.create',
      args: { exportId: 'ParamBend', min: 0, max: 1, default: 0, keys: [0, 1] },
    }, // $1
    {
      name: 'param.create',
      args: { exportId: 'ParamAngle', min: -30, max: 30, default: 0, keys: [-30, 0, 30] },
    }, // $2
    { name: 'part.create', args: { exportId: 'PartBody' } }, // $3
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Outer',
        part: '$3',
        rows: 2,
        cols: 2,
        rect: { x: 50, y: 50, width: 300, height: 300 },
      },
    }, // $4
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rotation_Head', part: '$3', parent: '$4', origin: { x: 0.5, y: 0.3 } },
    }, // $5
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Face',
        part: '$3',
        parent: '$5',
        rows: 1,
        cols: 1,
        rect: { x: -60, y: -40, width: 120, height: 80 },
      },
    }, // $6
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rotation_Eye', part: '$3', parent: '$6', origin: { x: 0.3, y: 0.4 } },
    }, // $7
    await layer(assets, 'face', swatch(120, 80, [240, 200, 170]), 0, 0), // $8
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Face',
        part: '$3',
        deformer: '$6',
        layer: '$8',
        uv: quadUv(120, 80),
        positions: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        triangles: QUAD,
      },
    }, // $9
    await layer(assets, 'eye', swatch(20, 10, [40, 40, 90]), 0, 0), // $10
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Eye',
        part: '$3',
        deformer: '$7',
        layer: '$10',
        uv: quadUv(20, 10),
        positions: [
          [-10, -5],
          [10, -5],
          [10, 5],
          [-10, 5],
        ],
        triangles: QUAD,
      },
    }, // $11
    await layer(assets, 'badge', swatch(30, 30, [220, 60, 60]), 185, 300), // $12
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Badge',
        part: '$3',
        layer: '$12',
        uv: quadUv(30, 30),
        triangles: QUAD,
      },
    }, // $13
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rotation_Hat', part: '$3', origin: { x: 200, y: 100 } },
    }, // $14
    await layer(assets, 'hat', swatch(40, 20, [60, 160, 90]), 0, 0), // $15
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Hat',
        part: '$3',
        deformer: '$14',
        layer: '$15',
        uv: quadUv(40, 20),
        positions: [
          [-20, -10],
          [20, -10],
          [20, 10],
          [-20, 10],
        ],
        triangles: QUAD,
      },
    }, // $16
    { name: 'keyform.set', args: { target: '$14', values: { scale: 1.5 } } },
    { name: 'rig.addBinding', args: { target: '$4', parameter: '$1' } },
    {
      name: 'keyform.set',
      args: { target: '$4', cell: { '@param:ParamBend': 1 }, values: { grid: bent } },
    },
    { name: 'rig.addBinding', args: { target: '$5', parameter: '$2' } },
    { name: 'keyform.set', args: { target: '$5', all: true, values: { scale: 1.2 } } },
    ...(
      [
        [-30, -20],
        [0, 10],
        [30, 40],
      ] as const
    ).map(([key, angle]) => ({
      name: 'keyform.set',
      args: { target: '$5', cell: { '@param:ParamAngle': key }, values: { angle } },
    })),
    { name: 'rig.addBinding', args: { target: '$13', parameter: '$1' } },
    {
      name: 'mesh.moveVertices',
      args: { target: '$13', cell: { '@param:ParamBend': 1 }, offset: [20, 0] },
    },
  ]);
  const ctx = { session, assets };
  await runItems(
    ctx,
    'Reparent in place',
    [
      {
        name: 'mesh.reparent',
        args: { target: '@mesh:ArtMesh_Badge', deformer: '@warp:Warp_Face' },
      },
      {
        name: 'deformer.reparent',
        args: { target: '@rot:Rotation_Hat', parent: '@rot:Rotation_Head' },
      },
      {
        name: 'keyform.moveInCanvas',
        args: { target: '@mesh:ArtMesh_Face', points: [2], offset: [10, 5] },
      },
    ],
    { operations: OPERATIONS },
  );
  return { name: 'golden-15-nested-deformers', session, assets };
}

/**
 * Golden 16 — writer edges at version 3 (for the conformance pack): what no other golden
 * exports at version 3. Canvas 300 × 300, ppu 300, origin (150, 150).
 * - Part_Child is nested in Part_Root and sorts its own children (a nested draw-order group).
 * - ArtMesh_Grid is bound to two parameters: ParamX (−1, 0, 1) × ParamY (0, 1), six cells, each
 *   moving the quad and changing its opacity.
 * - Rotation_Spin at (200, 100) is bound to ParamSpin (repeating, −180…180) and ParamFlip (0, 1):
 *   ParamFlip = 1 mirrors it in x, and in y at ParamSpin 180. ArtMesh_Spun hangs from it.
 * - ArtMesh_Masked is clipped by ArtMesh_Mask; ArtMesh_Outside by the same mask, inverted.
 * - ArtMesh_Glow blends additively, ArtMesh_Shade multiplicatively and is single-sided.
 */
export async function golden16(): Promise<Golden> {
  const session = Session.create({
    width: 300,
    height: 300,
    pixelsPerUnit: 300,
    originX: 150,
    originY: 150,
  });
  const assets = new MemoryAssetStore();
  const rect = (x: number, y: number, w: number, h: number): [number, number][] => [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  session.runBatch('golden 16', [
    {
      name: 'project.setExportSettings',
      args: { fileStem: 'golden16', atlasSize: 1024, mocVersion: 3, minimumVersion: 3 },
    },
    {
      name: 'param.create',
      args: { exportId: 'ParamX', min: -1, max: 1, default: 0, keys: [-1, 0, 1] },
    },
    {
      name: 'param.create',
      args: { exportId: 'ParamY', min: 0, max: 1, default: 0, keys: [0, 1] },
    },
    {
      name: 'param.create',
      args: {
        exportId: 'ParamSpin',
        min: -180,
        max: 180,
        default: 0,
        keys: [-180, 0, 180],
        repeat: true,
      },
    },
    {
      name: 'param.create',
      args: { exportId: 'ParamFlip', min: 0, max: 1, default: 0, keys: [0, 1] },
    },
    { name: 'part.create', args: { exportId: 'Part_Root' } },
    {
      name: 'part.create',
      args: { exportId: 'Part_Child', parent: '@part:Part_Root', sortingScope: 'own' },
    },
    await layer(assets, 'grid', swatch(40, 40, [200, 90, 90]), 20, 20),
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Grid',
        part: '@part:Part_Child',
        layer: '@layer~grid',
        uv: quadUv(40, 40),
        triangles: QUAD,
      },
    },
    { name: 'rig.addBinding', args: { target: '@mesh:ArtMesh_Grid', parameter: '@param:ParamX' } },
    { name: 'rig.addBinding', args: { target: '@mesh:ArtMesh_Grid', parameter: '@param:ParamY' } },
    ...[-1, 0, 1].flatMap((x) =>
      [0, 1].map((y) => ({
        name: 'keyform.set',
        args: {
          target: '@mesh:ArtMesh_Grid',
          cell: { '@param:ParamX': x, '@param:ParamY': y },
          values: {
            positions: rect(20 + 30 * x, 20 + 40 * y, 40 + 10 * y, 40),
            opacity: 1 - 0.3 * y,
          },
        },
      })),
    ),
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rotation_Spin', part: '@part:Part_Root', origin: { x: 200, y: 100 } },
    },
    await layer(assets, 'spun', swatch(30, 10, [90, 200, 90]), 0, 0),
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Spun',
        part: '@part:Part_Root',
        deformer: '@rot:Rotation_Spin',
        layer: '@layer~spun',
        uv: quadUv(30, 10),
        positions: rect(0, -5, 30, 10),
        triangles: QUAD,
      },
    },
    {
      name: 'rig.addBinding',
      args: { target: '@rot:Rotation_Spin', parameter: '@param:ParamSpin' },
    },
    {
      name: 'rig.addBinding',
      args: { target: '@rot:Rotation_Spin', parameter: '@param:ParamFlip' },
    },
    ...[-180, 0, 180].flatMap((k) =>
      [0, 1].map((f) => ({
        name: 'keyform.set',
        args: {
          target: '@rot:Rotation_Spin',
          cell: { '@param:ParamSpin': k, '@param:ParamFlip': f },
          values: { angle: k, mirrorX: f === 1, mirrorY: f === 1 && k === 180 },
        },
      })),
    ),
    await layer(assets, 'mask', swatch(60, 60, [80, 80, 200]), 120, 180),
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Mask',
        part: '@part:Part_Root',
        layer: '@layer~mask',
        uv: quadUv(60, 60),
        triangles: QUAD,
      },
    },
    await layer(assets, 'masked', swatch(60, 30, [220, 220, 60]), 150, 200),
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Masked',
        part: '@part:Part_Root',
        layer: '@layer~masked',
        uv: quadUv(60, 30),
        triangles: QUAD,
      },
    },
    await layer(assets, 'outside', swatch(60, 30, [60, 220, 220]), 90, 190),
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Outside',
        part: '@part:Part_Root',
        layer: '@layer~outside',
        uv: quadUv(60, 30),
        triangles: QUAD,
      },
    },
    {
      name: 'mesh.setClip',
      args: { target: '@mesh:ArtMesh_Masked', masks: ['@mesh:ArtMesh_Mask'] },
    },
    {
      name: 'mesh.setClip',
      args: { target: '@mesh:ArtMesh_Outside', masks: ['@mesh:ArtMesh_Mask'], invert: true },
    },
    await layer(assets, 'glow', swatch(30, 30, [255, 160, 40]), 20, 220),
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Glow',
        part: '@part:Part_Child',
        layer: '@layer~glow',
        uv: quadUv(30, 30),
        triangles: QUAD,
      },
    },
    { name: 'mesh.update', args: { target: '@mesh:ArtMesh_Glow', legacyBlend: 'additive' } },
    await layer(assets, 'shade', swatch(30, 30, [120, 120, 120]), 60, 220),
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_Shade',
        part: '@part:Part_Child',
        layer: '@layer~shade',
        uv: quadUv(30, 30),
        triangles: QUAD,
      },
    },
    {
      name: 'mesh.update',
      args: { target: '@mesh:ArtMesh_Shade', legacyBlend: 'multiplicative', doubleSided: false },
    },
  ]);
  return { name: 'golden-16-writer-edges', session, assets };
}

/**
 * Golden 17 — motion sync. A mouth bound to ParamMouthOpenY (2 keys) and ParamMouthForm
 * (3 keys), and two motion-sync settings: «Mouth» with the six default elements and their shapes,
 * blended by likeliest element; «Soft» with three elements, one disabled and one scaled, blended by
 * weight, with damper and smoothing on its parameters. Written as golden17.motionsync3.json.
 */
export async function golden17(): Promise<Golden> {
  const session = Session.create({
    width: 200,
    height: 200,
    pixelsPerUnit: 200,
    originX: 100,
    originY: 100,
  });
  const assets = new MemoryAssetStore();
  session.runBatch('golden 17', [
    { name: 'project.setExportSettings', args: { fileStem: 'golden17', atlasSize: 1024 } },
    await layer(assets, 'mouth', swatch(40, 12, [190, 60, 70]), 80, 94), // $1
    {
      name: 'param.create',
      args: { exportId: 'ParamMouthOpenY', min: 0, max: 1, default: 0, keys: [0, 1] },
    }, // $2
    {
      name: 'param.create',
      args: { exportId: 'ParamMouthForm', min: -1, max: 1, default: 0, keys: [-1, 0, 1] },
    }, // $3
    {
      name: 'mesh.create',
      args: { exportId: 'Mouth', layer: '$1', uv: quadUv(40, 12), triangles: QUAD },
    }, // $4
    { name: 'rig.addBinding', args: { target: '$4', parameter: '$2' } },
    { name: 'rig.addBinding', args: { target: '$4', parameter: '$3' } },
    {
      name: 'keyform.set',
      args: {
        target: '$4',
        cell: { '@param:ParamMouthOpenY': 1, '@param:ParamMouthForm': 0 },
        values: { positions: rect(80, 90, 40, 24) },
      },
    },
    {
      name: 'keyform.set',
      args: {
        target: '$4',
        cell: { '@param:ParamMouthOpenY': 0, '@param:ParamMouthForm': 1 },
        values: { positions: rect(74, 94, 52, 10) },
      },
    },
    {
      name: 'keyform.set',
      args: {
        target: '$4',
        cell: { '@param:ParamMouthOpenY': 0, '@param:ParamMouthForm': -1 },
        values: { positions: rect(86, 94, 28, 12) },
      },
    },
    {
      name: 'motionSync.addSetting',
      args: {
        name: 'Mouth',
        parameters: [{ parameter: '$2' }, { parameter: '$3' }],
        shapes: [
          [0, 0],
          [1, 0],
          [0.3, 1],
          [0.4, -1],
          [0.6, 0.5],
          [0.8, -0.6],
        ],
      },
    },
    {
      name: 'motionSync.addSetting',
      args: {
        name: 'Soft',
        sampleRate: 60,
        smoothing: 40,
        blendRatio: 1,
        parameters: [
          { parameter: '$2', damper: 0.05, smooth: 30 },
          { parameter: '$3', damper: 0, smooth: 60 },
        ],
        elements: [{ id: 'Silence' }, { id: 'A', scale: 1.5 }, { id: 'O', enabled: false }],
        shapes: [
          [0, 0],
          [0.9, 0.2],
          [0.7, -0.8],
        ],
      },
    },
  ]);
  return { name: 'golden-17-motion-sync', session, assets };
}

export const GOLDENS = [
  golden1,
  golden2,
  golden3,
  golden4,
  golden5,
  golden6,
  golden7,
  golden8,
  golden9,
  golden10,
  golden11,
  golden12,
  golden13,
  golden14,
  golden15,
  golden16,
  golden17,
];
