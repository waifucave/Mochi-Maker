/**
 * The three command laws (design 7.1), checked for every registered command:
 * 1. apply then undo gives the original document;
 * 2. undo then redo gives the post-command document;
 * 3. replaying the log gives an identical document.
 * Each command also round-trips through the project format.
 */
import { describe, expect, it } from 'vitest';
import {
  copyFragment,
  COMMANDS,
  MemoryAssetStore,
  MemoryFileSystem,
  canonicalText,
  checkArgs,
  describeCommand,
  listCommands,
  loadProject,
  replay,
  saveProject,
  type CommandCall,
} from '@mochi-maker/core';
import { ASSET, QUAD_TRIS, fixtureSession, quad } from './fixture.js';

/** A blend-shape parameter and a blend shape on the face mesh. */
const SHAPE: CommandCall[] = [
  {
    name: 'param.create',
    args: {
      exportId: 'ParamSmile',
      min: 0,
      max: 1,
      default: 0,
      keys: [0, 0.5, 1],
      type: 'blendShape',
    },
  },
  {
    name: 'blendShape.add',
    args: { target: '@mesh:ArtMesh_Face', parameter: '@param:ParamSmile', keys: [0, 1] },
  },
];
const SHAPE_REF = { target: '@mesh:ArtMesh_Face', parameter: '@param:ParamSmile' };

/** A copy of the neck rotation and everything below it, as the clipboard holds it. */
const NECK = (() => {
  const s = fixtureSession();
  return copyFragment(s.view, [s.view.resolve('@rot:Rotation_Neck', ['rotation'], 'x')]);
})();

/** One valid call per command, against the fixture. */
const SAMPLES: Record<string, CommandCall[]> = {
  'motion.reorder': [
    { name: 'motion.create', args: { name: 'wave', group: 'TapBody', duration: 1 } },
    { name: 'motion.reorder', args: { target: '@motion~"wave"', index: 0 } },
  ],
  'sound.create': [
    {
      name: 'sound.create',
      args: { name: 'hello', asset: ASSET, sampleRate: 16000, channels: 1, frames: 16000 },
    },
  ],
  'sound.update': [
    {
      name: 'sound.create',
      args: { name: 'hello', asset: ASSET, sampleRate: 16000, channels: 1, frames: 16000 },
    },
    { name: 'sound.update', args: { target: '$0', name: 'greeting' } },
  ],
  'sound.delete': [
    {
      name: 'sound.create',
      args: { name: 'hello', asset: ASSET, sampleRate: 16000, channels: 1, frames: 16000 },
    },
    { name: 'motion.update', args: { target: '@motion~"idle"', sound: '$0' } },
    { name: 'sound.delete', args: { target: '$0', cascade: true } },
    { name: 'part.create', args: {} },
  ],
  'blendShape.add': SHAPE,
  'blendShape.set': [
    ...SHAPE,
    {
      name: 'blendShape.set',
      args: { ...SHAPE_REF, key: 1, values: { opacity: -0.5, drawOrder: 3 } },
    },
  ],
  'blendShape.setKeys': [
    ...SHAPE,
    { name: 'blendShape.setKeys', args: { ...SHAPE_REF, keys: [0, 0.5, 1] } },
  ],
  'blendShape.setConstraints': [
    ...SHAPE,
    {
      name: 'blendShape.setConstraints',
      args: {
        ...SHAPE_REF,
        constraints: [
          {
            parameter: '@param:ParamAngleX',
            points: [
              [-30, 0],
              [0, 1],
            ],
          },
        ],
      },
    },
  ],
  'blendShape.reorder': [
    ...SHAPE,
    {
      name: 'param.create',
      args: { exportId: 'ParamWide', min: 0, max: 1, default: 0, type: 'blendShape' },
    },
    {
      name: 'blendShape.add',
      args: { target: '@mesh:ArtMesh_Face', parameter: '@param:ParamWide' },
    },
    {
      name: 'blendShape.reorder',
      args: { target: '@mesh:ArtMesh_Face', parameter: '@param:ParamWide', index: 0 },
    },
  ],
  'blendShape.remove': [...SHAPE, { name: 'blendShape.remove', args: SHAPE_REF }],
  'project.setCanvas': [{ name: 'project.setCanvas', args: { width: 800, pixelsPerUnit: 800 } }],
  'project.setExportSettings': [
    {
      name: 'project.setExportSettings',
      args: { mocVersion: 'auto', minimumVersion: 4, fileStem: 'hana' },
    },
  ],
  'object.rename': [
    {
      name: 'object.rename',
      args: { target: '@mesh:ArtMesh_Face', exportId: 'ArtMesh_Head', name: 'Head' },
    },
  ],
  'meta.setHitAreas': [
    {
      name: 'meta.setHitAreas',
      args: { hitAreas: [{ mesh: '@mesh:ArtMesh_Neck', name: 'Body' }] },
    },
  ],
  'meta.setStandardGroups': [
    { name: 'meta.setStandardGroups', args: { lipSync: ['@param:ParamAngleX'] } },
  ],
  'meta.setCombinedParameters': [
    {
      name: 'meta.setCombinedParameters',
      args: { pairs: [['@param:ParamAngleX', '@param:ParamEyeLOpen']] },
    },
  ],
  'meta.setUserData': [
    { name: 'meta.setUserData', args: { entries: [{ target: '@mesh:ArtMesh_Face', value: 'x' }] } },
  ],
  'pose.setGroups': [
    {
      name: 'pose.setGroups',
      args: { fadeIn: 0.3, groups: [[{ part: '@part:PartHead', links: ['@part:PartBody'] }]] },
    },
  ],
  'param.create': [
    {
      name: 'param.create',
      args: { exportId: 'ParamBreath', min: 0, max: 1, keys: [0, 0.5, 1], index: 0 },
    },
  ],
  'param.update': [
    {
      name: 'param.update',
      args: { target: '@param:ParamAngleX', min: -45, max: 45, group: '@pgroup:GroupFace' },
    },
  ],
  'param.setKeys': [
    { name: 'param.setKeys', args: { target: '@param:ParamAngleX', keys: [-30, -15, 0, 30] } },
  ],
  'param.reorder': [{ name: 'param.reorder', args: { target: '@param:ParamEyeLOpen', index: 0 } }],
  'param.delete': [{ name: 'param.delete', args: { target: '@param:ParamAngleX', cascade: true } }],
  'paramGroup.create': [
    { name: 'paramGroup.create', args: { exportId: 'GroupEyes', parent: '@pgroup:GroupFace' } },
  ],
  'paramGroup.update': [
    { name: 'paramGroup.create', args: { exportId: 'GroupEyes' } },
    { name: 'paramGroup.update', args: { target: '$0', parent: '@pgroup:GroupFace' } },
  ],
  'paramGroup.delete': [
    { name: 'param.update', args: { target: '@param:ParamAngleX', group: '@pgroup:GroupFace' } },
    { name: 'paramGroup.delete', args: { target: '@pgroup:GroupFace' } },
  ],
  'part.create': [
    {
      name: 'part.create',
      args: { exportId: 'PartArm', parent: '@part:PartBody', index: 0, drawOrder: 400 },
    },
  ],
  'part.update': [
    {
      name: 'part.update',
      args: {
        target: '@part:PartHead',
        enabled: false,
        visibleAtStart: false,
        sortingScope: 'inherit',
      },
    },
  ],
  'part.setOffscreen': [
    {
      name: 'part.setOffscreen',
      args: {
        target: '@part:PartHead',
        offscreen: true,
        blend: { color: 'overlay', alpha: 'atop' },
        masks: ['@mesh:ArtMesh_Face'],
        invert: true,
      },
    },
    { name: 'part.setOffscreen', args: { target: '@part:PartBody', offscreen: true } },
  ],
  'tree.move': [
    {
      name: 'tree.move',
      args: { target: '@mesh:ArtMesh_Face', parent: '@part:PartBody', index: 0 },
    },
  ],
  'part.delete': [{ name: 'part.delete', args: { target: '@part:PartBody', cascade: true } }],
  'mesh.create': [
    {
      name: 'mesh.create',
      args: {
        part: '@part:PartBody',
        layer: '@layer~face',
        uv: quad(10, 10, 20),
        triangles: QUAD_TRIS,
        opacity: 0.5,
      },
    },
  ],
  'mesh.update': [
    {
      name: 'mesh.update',
      args: {
        target: '@mesh:ArtMesh_Face',
        doubleSided: false,
        legacyBlend: 'multiplicative',
        layer: null,
      },
    },
    {
      name: 'mesh.update',
      args: { target: '@mesh:ArtMesh_Face', blend: { color: 'softLight', alpha: 'over' } },
    },
  ],
  'mesh.setClip': [
    {
      name: 'mesh.setClip',
      args: {
        target: '@mesh:ArtMesh_Neck',
        masks: ['@mesh:ArtMesh_Face', '@mesh:ArtMesh_EyeL'],
        invert: true,
      },
    },
  ],
  'mesh.setDeformer': [
    {
      name: 'mesh.setDeformer',
      args: { target: '@mesh:ArtMesh_Neck', deformer: '@warp:Warp_Face' },
    },
  ],
  'mesh.delete': [{ name: 'mesh.delete', args: { target: '@mesh:ArtMesh_Face', cascade: true } }],
  'layer.create': [
    {
      name: 'layer.create',
      args: { name: 'hair', asset: ASSET, x: 0, y: 0, width: 10, height: 10, index: 0 },
    },
  ],
  'layer.update': [{ name: 'layer.update', args: { target: '@layer~face', x: 5, visible: false } }],
  'layer.setImage': [
    {
      name: 'layer.setImage',
      args: {
        target: '@layer~face',
        asset: ASSET,
        x: 7,
        y: 3,
        width: 30,
        height: 20,
        notes: ['re-imported'],
      },
    },
  ],
  'layer.delete': [{ name: 'layer.delete', args: { target: '@layer~face', cascade: true } }],
  'deformer.createWarp': [
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Eye',
        parent: '@warp:Warp_Face',
        rows: 3,
        cols: 2,
        cellMode: 'triangles',
      },
    },
  ],
  'deformer.createRotation': [
    {
      name: 'deformer.createRotation',
      args: { parent: '@warp:Warp_Face', origin: { x: 0.5, y: 0.5 }, baseAngle: 90 },
    },
  ],
  'deformer.update': [
    {
      name: 'deformer.update',
      args: { target: '@warp:Warp_Face', enabled: false, cellMode: 'triangles', part: null },
    },
  ],
  'deformer.setParent': [
    { name: 'deformer.setParent', args: { target: '@warp:Warp_Face', parent: null } },
  ],
  'deformer.delete': [
    { name: 'deformer.delete', args: { target: '@rot:Rotation_Neck', cascade: true } },
  ],
  'rig.addBinding': [
    {
      name: 'rig.addBinding',
      args: { target: '@warp:Warp_Face', parameter: '@param:ParamAngleX', keys: [-30, 30] },
    },
  ],
  'rig.removeBinding': [
    {
      name: 'rig.removeBinding',
      args: { target: '@mesh:ArtMesh_EyeL', parameter: '@param:ParamEyeLOpen', keep: 0 },
    },
  ],
  'rig.addKey': [
    { name: 'param.setKeys', args: { target: '@param:ParamEyeLOpen', keys: [0, 0.25, 1] } },
    {
      name: 'rig.addKey',
      args: { target: '@mesh:ArtMesh_EyeL', parameter: '@param:ParamEyeLOpen', key: 0.25 },
    },
  ],
  'rig.removeKey': [
    {
      name: 'rig.removeKey',
      args: { target: '@rot:Rotation_Neck', parameter: '@param:ParamAngleX', key: 0 },
    },
  ],
  'rig.fillMissing': [
    { name: 'param.setKeys', args: { target: '@param:ParamEyeLOpen', keys: [0, 0.5, 1] } },
    {
      name: 'rig.addKey',
      args: { target: '@mesh:ArtMesh_EyeL', parameter: '@param:ParamEyeLOpen', key: 0.5 },
    },
    {
      name: 'keyform.set',
      args: {
        target: '@mesh:ArtMesh_EyeL',
        cell: { '@param:ParamEyeLOpen': 1 },
        values: { opacity: 0.6 },
      },
    },
    { name: 'rig.fillMissing', args: { target: '@mesh:ArtMesh_EyeL' } },
  ],
  'keyform.set': [
    {
      name: 'keyform.set',
      args: {
        target: '@warp:Warp_Face',
        values: {
          grid: quad(0, 0, 1).concat([
            [0, 0],
            [1, 1],
            [2, 2],
            [3, 3],
            [4, 4],
          ]),
          screen: [0.1, 0.2, 0.3],
        },
      },
    },
  ],
  'keyform.fillCorners': [
    {
      name: 'rig.addBinding',
      args: { target: '@rot:Rotation_Neck', parameter: '@param:ParamEyeLOpen' },
    },
    {
      name: 'keyform.set',
      args: {
        target: '@rot:Rotation_Neck',
        cell: { '@param:ParamAngleX': 0, '@param:ParamEyeLOpen': 0 },
        values: { scale: 0.5 },
      },
    },
    { name: 'keyform.fillCorners', args: { targets: ['@rot:Rotation_Neck'] } },
  ],
  'keyform.copy': [
    {
      name: 'keyform.copy',
      args: {
        target: '@mesh:ArtMesh_EyeL',
        from: { '@param:ParamEyeLOpen': 1 },
        to: { '@param:ParamEyeLOpen': 0 },
      },
    },
  ],
  'mesh.setTopology': [
    {
      name: 'mesh.setTopology',
      args: {
        target: '@mesh:ArtMesh_Face',
        uv: [...quad(0, 0, 200), [100, 100]],
        triangles: [
          [0, 1, 4],
          [1, 2, 4],
          [2, 3, 4],
          [3, 0, 4],
        ],
      },
    },
  ],
  'mesh.addVertices': [
    {
      name: 'mesh.addVertices',
      args: {
        target: '@mesh:ArtMesh_Face',
        points: [
          [50, 60],
          [100, 100],
        ],
      },
    },
  ],
  'mesh.deleteVertices': [
    { name: 'mesh.deleteVertices', args: { target: '@mesh:ArtMesh_Face', vertices: [3] } },
  ],
  'mesh.retriangulate': [
    {
      name: 'mesh.addVertices',
      args: {
        target: '@mesh:ArtMesh_Face',
        points: [
          [10, 100],
          [190, 100],
        ],
      },
    },
    { name: 'mesh.retriangulate', args: { target: '@mesh:ArtMesh_Face' } },
  ],
  'mesh.flipEdge': [
    { name: 'mesh.flipEdge', args: { target: '@mesh:ArtMesh_Face', edge: [0, 2] } },
  ],
  'mesh.moveUv': [
    { name: 'mesh.moveUv', args: { target: '@mesh:ArtMesh_Face', vertices: [1], offset: [1, 0] } },
  ],
  'mesh.moveVertices': [
    {
      name: 'mesh.moveVertices',
      args: {
        target: '@mesh:ArtMesh_EyeL',
        cell: { '@param:ParamEyeLOpen': 0 },
        vertices: [0],
        offset: [0, 0.05],
      },
    },
  ],
  'glue.create': [
    {
      name: 'glue.create',
      args: {
        meshA: '@mesh:ArtMesh_EyeL',
        meshB: '@mesh:ArtMesh_Face',
        pairs: [[1, 1, 2, 0]],
        intensity: 0.5,
        index: 0,
      },
    },
  ],
  'glue.setPairs': [
    {
      name: 'glue.setPairs',
      args: {
        target: '@glue:Glue_Neck',
        pairs: [
          [1, 0.3, 2, 0.7],
          [2, 0.5, 1, 0.5],
        ],
      },
    },
  ],
  'glue.reorder': [
    { name: 'glue.create', args: { meshA: '@mesh:ArtMesh_EyeL', meshB: '@mesh:ArtMesh_Face' } },
    { name: 'glue.reorder', args: { target: '$0', index: 0 } },
  ],
  'glue.delete': [{ name: 'glue.delete', args: { target: '@glue:Glue_Neck' } }],
  'expression.create': [
    {
      name: 'expression.create',
      args: {
        name: 'angry',
        fadeIn: 0.2,
        entries: [{ parameter: '@param:ParamAngleX', value: 2, blend: 'Multiply' }],
      },
    },
  ],
  'expression.update': [
    { name: 'expression.update', args: { target: '@expr~wink', fadeOut: null, entries: [] } },
  ],
  'expression.delete': [{ name: 'expression.delete', args: { target: '@expr~wink' } }],
  'motion.create': [
    { name: 'motion.create', args: { name: 'tap', group: 'TapBody', duration: 1.5 } },
  ],
  'motion.update': [
    {
      name: 'motion.update',
      args: { target: '@motion~idle', restrictedBeziers: true, fadeIn: 0.5 },
    },
  ],
  'motion.setCurve': [
    {
      name: 'motion.setCurve',
      args: {
        target: '@motion~idle',
        curve: {
          target: 'partOpacity',
          object: '@part:PartHead',
          fadeIn: 0,
          segments: [0, 1, 2, 1, 0],
        },
      },
    },
  ],
  'motion.setKeys': [
    {
      name: 'motion.setKeys',
      args: {
        target: '@motion~idle',
        curve: { target: 'parameter', object: '@param:ParamAngleX' },
        keys: [
          { time: 0, value: 0, interp: 'auto' },
          { time: 0.5, value: 10, interp: 'bezier', handles: [0.6, 12, 0.9, 3] },
          { time: 1, value: 0 },
        ],
        fadeIn: 0.2,
      },
    },
  ],
  'motion.insertKey': [
    {
      name: 'motion.insertKey',
      args: {
        target: '@motion~idle',
        curve: { target: 'model', model: 'Opacity' },
        time: 0.25,
        value: 0.5,
      },
    },
  ],
  'motion.deleteKeys': [
    {
      name: 'motion.deleteKeys',
      args: {
        target: '@motion~idle',
        curve: { target: 'parameter', object: '@param:ParamAngleX' },
        times: [1],
      },
    },
  ],
  'motion.moveKeys': [
    {
      name: 'motion.insertKey',
      args: {
        target: '@motion~idle',
        curve: { target: 'model', model: 'LipSync' },
        time: 1,
        value: 0,
      },
    },
    {
      name: 'motion.moveKeys',
      args: {
        target: '@motion~idle',
        curve: { target: 'model', model: 'LipSync' },
        times: [1],
        dt: 0.5,
        dv: 0.25,
      },
    },
  ],
  'motion.setInterpolation': [
    {
      name: 'motion.insertKey',
      args: {
        target: '@motion~idle',
        curve: { target: 'model', model: 'LipSync' },
        time: 0,
        value: 0,
      },
    },
    {
      name: 'motion.insertKey',
      args: {
        target: '@motion~idle',
        curve: { target: 'model', model: 'LipSync' },
        time: 1,
        value: 1,
      },
    },
    {
      name: 'motion.setInterpolation',
      args: {
        target: '@motion~idle',
        curve: { target: 'model', model: 'LipSync' },
        times: [0],
        interp: 'bezier',
      },
    },
  ],
  'objects.paste': [{ name: 'objects.paste', args: { fragment: NECK } }],
  'deformPath.create': [
    {
      name: 'deformPath.create',
      args: {
        targets: ['@mesh:ArtMesh_Face'],
        level: 2,
        points: [
          [10, 10],
          [60, 20],
        ],
      },
    },
  ],
  'deformPath.update': [
    {
      name: 'deformPath.create',
      args: {
        targets: ['@mesh:ArtMesh_Face'],
        level: 2,
        points: [
          [10, 10],
          [60, 20],
        ],
      },
    },
    {
      name: 'deformPath.update',
      args: {
        id: 1,
        points: [
          [12, 10],
          [60, 30],
          [90, 30],
        ],
        reach: 40,
      },
    },
  ],
  'deformPath.delete': [
    {
      name: 'deformPath.create',
      args: {
        targets: ['@mesh:ArtMesh_Face'],
        level: 2,
        points: [
          [10, 10],
          [60, 20],
        ],
      },
    },
    {
      name: 'deformPath.create',
      args: {
        targets: ['@mesh:ArtMesh_Face'],
        level: 2,
        points: [
          [10, 10],
          [60, 20],
        ],
      },
    },
    { name: 'deformPath.delete', args: { id: 1 } },
  ],
  'template.create': [
    { name: 'template.create', args: { name: 'Cut', motion: '@motion~idle', from: 0, to: 1 } },
  ],
  'template.add': [
    {
      name: 'template.add',
      args: {
        template: {
          name: 'Nod',
          duration: 1,
          curves: [
            {
              id: 'ParamAngleX',
              keys: [
                { time: 0, value: 0, interp: 'auto' },
                { time: 0.5, value: 10, interp: 'auto' },
                { time: 1, value: 0, interp: 'linear' },
              ],
            },
            { id: 'ParamMissing', keys: [{ time: 0, value: 1, interp: 'linear' }] },
          ],
        },
      },
    },
  ],
  'template.rename': [
    {
      name: 'template.add',
      args: {
        template: {
          name: 'Nod',
          duration: 1,
          curves: [
            {
              id: 'ParamAngleX',
              keys: [
                { time: 0, value: 0, interp: 'auto' },
                { time: 0.5, value: 10, interp: 'auto' },
                { time: 1, value: 0, interp: 'linear' },
              ],
            },
            { id: 'ParamMissing', keys: [{ time: 0, value: 1, interp: 'linear' }] },
          ],
        },
      },
    },
    { name: 'template.rename', args: { name: 'Nod', newName: 'Nod 2' } },
  ],
  'template.delete': [
    { name: 'template.create', args: { name: 'Cut', motion: '@motion~idle', from: 0, to: 1 } },
    {
      name: 'template.add',
      args: {
        template: {
          name: 'Nod',
          duration: 1,
          curves: [
            {
              id: 'ParamAngleX',
              keys: [
                { time: 0, value: 0, interp: 'auto' },
                { time: 0.5, value: 10, interp: 'auto' },
                { time: 1, value: 0, interp: 'linear' },
              ],
            },
            { id: 'ParamMissing', keys: [{ time: 0, value: 1, interp: 'linear' }] },
          ],
        },
      },
    },
    { name: 'template.delete', args: { name: 'Nod' } },
  ],
  'template.apply': [
    {
      name: 'template.add',
      args: {
        template: {
          name: 'Nod',
          duration: 1,
          curves: [
            {
              id: 'ParamAngleX',
              keys: [
                { time: 0, value: 0, interp: 'auto' },
                { time: 0.5, value: 10, interp: 'auto' },
                { time: 1, value: 0, interp: 'linear' },
              ],
            },
            { id: 'ParamMissing', keys: [{ time: 0, value: 1, interp: 'linear' }] },
          ],
        },
      },
    },
    { name: 'template.apply', args: { name: 'Nod', target: '@motion~idle', time: 0.25 } },
  ],
  'motion.removeCurve': [
    {
      name: 'motion.removeCurve',
      args: { target: '@motion~idle', curveTarget: 'parameter', object: '@param:ParamAngleX' },
    },
  ],
  'motion.setEvents': [
    {
      name: 'motion.setEvents',
      args: {
        target: '@motion~idle',
        events: [
          { time: 1, value: 'b' },
          { time: 0.5, value: 'a' },
        ],
      },
    },
  ],
  'motion.setMarkers': [
    {
      name: 'motion.setMarkers',
      args: {
        target: '@motion~idle',
        markers: [
          { time: 1, name: 'b' },
          { time: 0.5, name: 'a' },
        ],
      },
    },
    {
      name: 'motion.update',
      args: { target: '@motion~idle', workArea: { start: 0.25, end: 0.75 } },
    },
  ],
  'motion.delete': [{ name: 'motion.delete', args: { target: '@motion~idle' } }],
  'motionSync.addSetting': [
    {
      name: 'motionSync.addSetting',
      args: {
        name: 'Mouth',
        parameters: [{ parameter: '@param:ParamAngleX', damper: 0.1, smooth: 20 }],
        shapes: [[0], [1], [0.5], [0.2], [0.7], [0.9]],
      },
    },
  ],
  'motionSync.updateSetting': [
    {
      name: 'motionSync.addSetting',
      args: { name: 'Mouth', parameters: [{ parameter: '@param:ParamAngleX' }] },
    },
    {
      name: 'motionSync.updateSetting',
      args: {
        target: '@msync~Mouth',
        blendRatio: 1,
        elements: [{ id: 'Silence' }, { id: 'A', scale: 2 }],
        parameters: [{ parameter: '@param:ParamAngleX' }, { parameter: '@param:ParamEyeLOpen' }],
      },
    },
  ],
  'motionSync.removeSetting': [
    { name: 'motionSync.addSetting', args: { name: 'Mouth' } },
    { name: 'motionSync.removeSetting', args: { target: '@msync~Mouth' } },
  ],
  'motion.markersToEvents': [
    {
      name: 'motion.setMarkers',
      args: { target: '@motion~idle', markers: [{ time: 0.5, name: 'turn' }] },
    },
    { name: 'motion.markersToEvents', args: { target: '@motion~idle' } },
  ],
  'mesh.brushDeform': [
    {
      name: 'mesh.brushDeform',
      args: { target: '@mesh:ArtMesh_Face', center: [0, 0], radius: 120, offset: [6, -4] },
    },
    {
      name: 'mesh.brushDeform',
      args: {
        target: '@mesh:ArtMesh_EyeL',
        cell: { '@param:ParamEyeLOpen': 0 },
        center: [0.1, 0.1],
        radius: 0.1,
        hardness: 0.2,
        roundness: 0.5,
        angle: 30,
        offset: [0.02, 0],
      },
    },
  ],
  'mesh.subdivide': [{ name: 'mesh.subdivide', args: { target: '@mesh:ArtMesh_Face' } }],
  'mesh.fromStrokes': [
    {
      name: 'mesh.fromStrokes',
      args: {
        target: '@mesh:ArtMesh_Neck',
        strokes: [
          [
            [80, 180],
            [100, 200],
            [120, 215],
          ],
        ],
        width: 10,
      },
    },
  ],
  'objects.replaceText': [
    { name: 'objects.replaceText', args: { find: 'Face', replace: 'Head2' } },
    {
      name: 'objects.replaceText',
      args: { find: '^ArtMesh_(\\w+)$', replace: 'Mesh_$1', pattern: true, fields: ['exportId'] },
    },
  ],
  'physics.addSetting': [
    {
      name: 'physics.addSetting',
      args: {
        name: 'Skirt',
        index: 0,
        inputs: [],
        outputs: [],
        particles: [{ x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 }],
        normalization: {
          position: { min: -1, default: 0, max: 1 },
          angle: { min: -1, default: 0, max: 1 },
        },
      },
    },
  ],
  'physics.updateSetting': [
    {
      name: 'physics.updateSetting',
      args: {
        target: '@phys~Hair',
        name: 'Hair 2',
        inputs: [{ parameter: '@param:ParamEyeLOpen', weight: 50, type: 'Angle', reflect: true }],
        outputs: [],
        particles: [{ x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 }],
        normalization: {
          position: { min: -1, default: 0, max: 1 },
          angle: { min: -1, default: 0, max: 1 },
        },
      },
    },
  ],
  'physics.removeSetting': [{ name: 'physics.removeSetting', args: { target: '@phys~Hair' } }],
  'physics.setFps': [{ name: 'physics.setFps', args: { fps: 60 } }],
};

const text = (s: { doc: Parameters<typeof canonicalText>[0] }, includeSeq = true) =>
  canonicalText(s.doc, { includeSeq });

describe('command catalog', () => {
  it('has a sample call for every command', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(listCommands().map((c) => c.name));
  });

  it('describes every command, and every example matches its schema', () => {
    for (const { name } of listCommands()) {
      const d = describeCommand(name);
      expect(d.summary.length, name).toBeGreaterThan(10);
      expect(d.doc.length, name).toBeGreaterThan(10);
      expect(JSON.stringify(d.args)).toContain('"type":"object"');
      expect(d).toMatchObject({ scope: 'edit', undoable: true, readOnly: false });
      for (const ex of COMMANDS.get(name)!.examples) checkArgs(COMMANDS.get(name)!.args, ex.args);
    }
  });
});

describe.each(Object.entries(SAMPLES))('%s', (_name, calls) => {
  it('obeys apply/undo, undo/redo and replay, and round-trips through the project format', async () => {
    const s = fixtureSession();
    const before = text(s, false);
    const r = s.runBatch('sample', calls);
    expect(r.committed).toBe(true);
    expect(r.changes.length).toBeGreaterThan(0);
    expect(s.validate().violations).toEqual([]);
    const after = text(s);
    expect(after).not.toBe(text(fixtureSession()));

    s.undo();
    expect(text(s, false)).toBe(before);
    s.redo();
    expect(text(s)).toBe(after);

    const replayed = replay(JSON.parse(JSON.stringify(s.log)));
    expect(text(replayed)).toBe(after);

    const fs = new MemoryFileSystem();
    const assets = new MemoryAssetStore();
    assets.blobs.set(ASSET, new Uint8Array([1, 2, 3]));
    await saveProject(fs, 'p', s.doc, assets);
    const loaded = await loadProject(fs, 'p');
    expect(canonicalText(loaded.doc)).toBe(after);
  });
});
