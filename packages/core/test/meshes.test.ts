import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import {
  MemoryAssetStore,
  MochiError,
  Session,
  defineOperation,
  runItems,
  type ArtMesh,
  type Glue,
} from '@mochi-maker/core';
import { QUAD_TRIS, fixtureSession, quad } from './fixture.js';

const face = (s: Session) => s.view.get('mesh_0009') as ArtMesh;
const eye = (s: Session) => s.view.get('mesh_0010') as ArtMesh;
const glue = (s: Session) => s.view.get('glue_0012') as Glue;

describe('mesh topology commands', () => {
  it('carry deformation over to new vertices in every keyform', () => {
    const s = fixtureSession();
    // Bind the face and deform the key-30 keyform: shear x by y.
    s.run('rig.addBinding', {
      target: '@mesh:ArtMesh_Face',
      parameter: '@param:ParamAngleX',
      keys: [0, 30],
    });
    const sheared = quad(100, 100, 200).map(
      ([x, y]) => [x + (y - 100) * 0.5, y] as [number, number],
    );
    s.run('keyform.set', {
      target: '@mesh:ArtMesh_Face',
      cell: { '@param:ParamAngleX': 30 },
      values: { positions: sheared },
    });
    const { vertices } = s.run('mesh.addVertices', {
      target: '@mesh:ArtMesh_Face',
      points: [
        [100, 100],
        [0, 50],
      ],
    });
    expect(vertices).toEqual([4, 5]);
    const [rest, shear] = face(s).rig.keyforms;
    // uv (100, 100) is canvas (200, 200) at rest; sheared by 0.5·(200 − 100) = 50.
    expect([rest!.positions[8], rest!.positions[9]]).toEqual([200, 200]);
    expect([shear!.positions[8], shear!.positions[9]]).toEqual([250, 200]);
    // uv (0, 50) lies on the left edge: canvas (100, 150), sheared by 25.
    expect([shear!.positions[10], shear!.positions[11]]).toEqual([125, 150]);
    expect(s.validate().violations).toEqual([]);
  });

  it('keep glue pairs on surviving vertices and drop the others', () => {
    const s = fixtureSession();
    expect(glue(s).pairs).toEqual([[0, 0.5, 3, 0.5]]);
    s.run('mesh.addVertices', { target: '@mesh:ArtMesh_Face', points: [[100, 100]] });
    // Deleting face vertex 1 renumbers vertex 3 to 2.
    const r = s.run('mesh.deleteVertices', { target: '@mesh:ArtMesh_Face', vertices: [1] });
    expect(r.droppedGluePairs).toBe(0);
    expect(glue(s).pairs).toEqual([[0, 0.5, 2, 0.5]]);
    const r2 = s.run('mesh.deleteVertices', { target: '@mesh:ArtMesh_Face', vertices: [2] });
    expect(r2.droppedGluePairs).toBe(1);
    expect(glue(s).pairs).toEqual([]);
  });

  it('setTopology copies matching vertices exactly and interpolates the rest', () => {
    const s = fixtureSession();
    const before = face(s).rig.keyforms[0]!.positions;
    s.run('mesh.setTopology', {
      target: '@mesh:ArtMesh_Face',
      uv: [
        [200, 200],
        [0, 0],
        [200, 0],
        [0, 200],
        [100, 0],
      ],
      triangles: [
        [1, 4, 3],
        [4, 2, 0],
        [4, 0, 3],
      ],
    });
    const p = face(s).rig.keyforms[0]!.positions;
    expect([p[0], p[1]]).toEqual([before[4], before[5]]);
    expect([p[8], p[9]]).toEqual([200, 100]);
    expect(glue(s).pairs).toEqual([[0, 0.5, 3, 0.5]]); // face vertex 3 (0, 200) is now index 3 again
  });

  it('move vertices per keyform, and uv without touching positions', () => {
    const s = fixtureSession();
    s.run('mesh.moveVertices', {
      target: '@mesh:ArtMesh_EyeL',
      cell: { '@param:ParamEyeLOpen': 0 },
      vertices: [2, 3],
      offset: [0, -0.1],
    });
    const [closed, open] = eye(s).rig.keyforms;
    expect(closed!.positions[5]).toBe(Math.fround(Math.fround(0.3) - 0.1));
    expect(open!.positions[5]).toBe(Math.fround(0.3));
    s.run('mesh.moveUv', { target: '@mesh:ArtMesh_EyeL', offset: [1, 1] });
    expect(eye(s).uv[0]).toBe(21);
    expect(eye(s).rig.keyforms[1]!.positions[0]).toBe(Math.fround(0.1));
  });

  it('report impossible edits as E_TOPOLOGY or E_SHAPE', () => {
    const s = fixtureSession();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as MochiError).code;
      }
      return 'none';
    };
    expect(
      code(() => s.run('mesh.addVertices', { target: '@mesh:ArtMesh_Face', points: [[500, 500]] })),
    ).toBe('E_TOPOLOGY');
    expect(code(() => s.run('mesh.flipEdge', { target: '@mesh:ArtMesh_Face', edge: [0, 1] }))).toBe(
      'E_TOPOLOGY',
    );
    expect(
      code(() => s.run('mesh.deleteVertices', { target: '@mesh:ArtMesh_Face', vertices: [0, 1] })),
    ).toBe('E_SHAPE');
    expect(
      code(() =>
        s.run('mesh.moveUv', { target: '@mesh:ArtMesh_Face', vertices: [9], offset: [1, 1] }),
      ),
    ).toBe('E_SHAPE');
  });
});

const addQuad = defineOperation({
  name: 'test.addQuad',
  summary: 'A test operation that creates a mesh after an await.',
  doc: 'For tests.',
  args: Type.Object({ part: Type.String({ refOf: ['part'] }), size: Type.Number() }),
  result: Type.Object({ uid: Type.String() }),
  errors: [],
  examples: [],
  async run(_ctx, tx, args) {
    await new Promise((r) => setTimeout(r, 1));
    if (args.size < 0)
      tx.run('mesh.create', { part: args.part, uv: [[0, 0]], triangles: [[0, 0, 5]] });
    const r = tx.run('mesh.create', {
      part: args.part,
      uv: quad(0, 0, args.size),
      triangles: QUAD_TRIS,
    });
    return {
      result: r,
      previews: [
        {
          mediaType: 'image/png',
          data: new Uint8Array([1]),
          width: 1,
          height: 1,
          description: 'stub',
        },
      ],
    };
  },
});

describe('operations', () => {
  it('run inside one transaction with commands, and $n refers to item results', async () => {
    const s = Session.create();
    const ctx = { session: s, assets: new MemoryAssetStore() };
    const r = await runItems(
      ctx,
      'build',
      [
        { name: 'part.create', args: { exportId: 'PartA' } },
        { name: 'test.addQuad', args: { part: '$0', size: 10 } },
        { name: 'object.rename', args: { target: '$1', exportId: 'ArtMesh_Quad' } },
      ],
      { operations: [addQuad] },
    );
    expect(r.committed).toBe(true);
    expect(r.itemResults).toEqual([{ uid: 'part_0001' }, { uid: 'mesh_0002' }, {}]);
    expect(r.previews).toHaveLength(1);
    expect(s.history()).toEqual([{ label: 'build', author: 'person' }]);
    // The log holds plain commands only.
    const tx = s.log.at(-1) as { commands: { name: string }[] };
    expect(tx.commands.map((c) => c.name)).toEqual(['part.create', 'mesh.create', 'object.rename']);
  });

  it('dry runs commit nothing; failures name the item and the inner command', async () => {
    const s = Session.create();
    const ctx = { session: s, assets: new MemoryAssetStore() };
    const dry = await runItems(
      ctx,
      'dry',
      [
        { name: 'part.create', args: {} },
        { name: 'test.addQuad', args: { part: '$0', size: 5 } },
      ],
      {
        operations: [addQuad],
        dryRun: true,
      },
    );
    expect(dry.committed).toBe(false);
    expect(s.revision).toBe(0);
    await expect(
      runItems(
        ctx,
        'bad',
        [
          { name: 'part.create', args: {} },
          { name: 'test.addQuad', args: { part: '$0', size: -1 } },
        ],
        { operations: [addQuad] },
      ),
    ).rejects.toMatchObject({
      code: 'E_SHAPE',
      command: 'test.addQuad',
      at: 1,
      details: { inner: { command: 'mesh.create', at: 1 } },
    });
    expect(s.revision).toBe(0);
  });

  it('keep the session busy while running', async () => {
    const s = Session.create();
    const ctx = { session: s, assets: new MemoryAssetStore() };
    const p = runItems(
      ctx,
      'slow',
      [
        { name: 'part.create', args: {} },
        { name: 'test.addQuad', args: { part: '$0', size: 5 } },
      ],
      { operations: [addQuad] },
    );
    expect(() => s.run('param.create', { min: 0, max: 1 })).toThrow(
      expect.objectContaining({ code: 'E_BUSY' }),
    );
    await p;
    expect(s.run('param.create', { min: 0, max: 1 }).uid).toBe('param_0003');
  });
});
