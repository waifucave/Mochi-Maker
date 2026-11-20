/** A small but complete rig used by many tests. Synthetic: no model data. */
import { Session, type CommandCall } from '@mochi-maker/core';

export const ASSET = 'a'.repeat(64);

export const quad = (x: number, y: number, s: number): [number, number][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];
export const QUAD_TRIS: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 3],
];

export const FIXTURE_CALLS: CommandCall[] = [
  {
    name: 'param.create',
    args: {
      exportId: 'ParamAngleX',
      name: 'Angle X',
      min: -30,
      max: 30,
      default: 0,
      keys: [-30, 0, 30],
    },
  }, // $0
  {
    name: 'param.create',
    args: {
      exportId: 'ParamEyeLOpen',
      name: 'Eye L open',
      min: 0,
      max: 1,
      default: 1,
      keys: [0, 1],
    },
  }, // $1
  { name: 'paramGroup.create', args: { exportId: 'GroupFace', name: 'Face' } }, // $2
  { name: 'part.create', args: { exportId: 'PartBody', name: 'Body' } }, // $3
  {
    name: 'part.create',
    args: { exportId: 'PartHead', name: 'Head', parent: '$3', sortingScope: 'own' },
  }, // $4
  {
    name: 'layer.create',
    args: { name: 'face', asset: ASSET, x: 100, y: 100, width: 200, height: 200 },
  }, // $5
  {
    name: 'deformer.createRotation',
    args: { exportId: 'Rotation_Neck', origin: { x: 200, y: 320 }, part: '$4' },
  }, // $6
  {
    name: 'deformer.createWarp',
    args: {
      exportId: 'Warp_Face',
      parent: '$6',
      rows: 2,
      cols: 2,
      rect: { x: -100, y: -220, width: 200, height: 200 },
      part: '$4',
    },
  }, // $7
  {
    name: 'mesh.create',
    args: {
      exportId: 'ArtMesh_Face',
      name: 'Face',
      part: '$4',
      layer: '$5',
      uv: quad(0, 0, 200),
      triangles: QUAD_TRIS,
    },
  }, // $8
  {
    name: 'mesh.create',
    args: {
      exportId: 'ArtMesh_EyeL',
      name: 'Left eye',
      part: '$4',
      deformer: '$7',
      uv: quad(20, 20, 40),
      positions: quad(0.1, 0.1, 0.2),
      triangles: QUAD_TRIS,
    },
  }, // $9
  {
    name: 'mesh.create',
    args: {
      exportId: 'ArtMesh_Neck',
      name: 'Neck',
      part: '$3',
      uv: quad(80, 180, 40),
      triangles: QUAD_TRIS,
    },
  }, // $10
  { name: 'rig.addBinding', args: { target: '$9', parameter: '$1' } },
  {
    name: 'keyform.set',
    args: { target: '$9', cell: { '@param:ParamEyeLOpen': 0 }, values: { opacity: 0 } },
  },
  { name: 'rig.addBinding', args: { target: '$6', parameter: '$0' } },
  {
    name: 'keyform.set',
    args: { target: '$6', cell: { '@param:ParamAngleX': 30 }, values: { angle: 10 } },
  },
  {
    name: 'keyform.set',
    args: { target: '$6', cell: { '@param:ParamAngleX': -30 }, values: { angle: -10 } },
  },
  { name: 'mesh.setClip', args: { target: '$9', masks: ['$8'] } },
  {
    name: 'glue.create',
    args: { exportId: 'Glue_Neck', meshA: '$10', meshB: '$8', pairs: [[0, 0.5, 3, 0.5]] },
  }, // $17
  { name: 'expression.create', args: { name: 'wink', entries: [{ parameter: '$1', value: -1 }] } }, // $18
  { name: 'motion.create', args: { name: 'idle', duration: 2, fps: 30, loop: true } }, // $19
  {
    name: 'motion.setCurve',
    args: {
      target: '$19',
      curve: { target: 'parameter', object: '$0', segments: [0, 0, 0, 1, 10, 0, 2, 0] },
    },
  },
  {
    name: 'physics.addSetting',
    args: {
      name: 'Hair',
      inputs: [{ parameter: '$0', weight: 100, type: 'X' }],
      outputs: [{ parameter: '$1', weight: 100, type: 'Angle', particle: 1, scale: 1 }],
      particles: [
        { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
        { x: 0, y: 10, mobility: 0.9, delay: 0.8, acceleration: 1.5, radius: 10 },
      ],
      normalization: {
        position: { min: -10, default: 0, max: 10 },
        angle: { min: -10, default: 0, max: 10 },
      },
    },
  }, // $21
  { name: 'meta.setHitAreas', args: { hitAreas: [{ mesh: '$8', name: 'Head' }] } },
  { name: 'meta.setStandardGroups', args: { eyeBlink: ['$1'] } },
];

export function fixtureSession(): Session {
  const s = Session.create({ width: 400, height: 600 });
  s.runBatch('fixture', FIXTURE_CALLS);
  return s;
}
