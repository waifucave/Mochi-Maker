/**
 * Deformer mapping and the deformer operations (M4): the Newton inverse, reparenting
 * that keeps things in place through every kind of parent, and canvas-space edits.
 */
import { describe, expect, it } from 'vitest';
import {
  DocView,
  MemoryAssetStore,
  MochiError,
  Session,
  replay,
  runItems,
  type CommandCall,
} from '@mochi-maker/core';
import { DeformerMapper, OPERATIONS, invertMap } from '@mochi-maker/export';

const QUAD: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 3],
];

/**
 * A root warp bent at rest (non-affine), a rotation inside it (angle 25°, scale 0.8), and a root
 * rotation; a mesh at the root with a blend shape.
 */
function scene(): Session {
  const s = Session.create({
    width: 400,
    height: 400,
    pixelsPerUnit: 400,
    originX: 200,
    originY: 200,
  });
  s.runBatch('scene', [
    { name: 'project.setExportSettings', args: { fileStem: 'scene' } },
    {
      name: 'param.create',
      args: { exportId: 'ParamA', min: 0, max: 1, default: 0, keys: [0, 1] },
    }, // $1
    {
      name: 'param.create',
      args: {
        exportId: 'ParamShape',
        min: 0,
        max: 1,
        default: 0,
        keys: [0, 1],
        type: 'blendShape',
      },
    }, // $2
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Bent',
        rows: 2,
        cols: 2,
        rect: { x: 50, y: 50, width: 300, height: 300 },
      },
    }, // $3
    {
      name: 'keyform.set',
      args: {
        target: '$3',
        values: {
          grid: [
            [50, 50],
            [200, 70],
            [350, 50],
            [60, 200],
            [230, 215],
            [340, 200],
            [50, 350],
            [200, 330],
            [350, 350],
          ],
        },
      },
    },
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rotation_In', parent: '$3', origin: { x: 0.6, y: 0.4 } },
    }, // $5
    { name: 'keyform.set', args: { target: '$5', values: { angle: 25, scale: 0.8 } } },
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rotation_Root', origin: { x: 120, y: 260 } },
    }, // $7
    { name: 'keyform.set', args: { target: '$7', values: { angle: -40, scale: 2 } } },
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_A',
        uv: [
          [0, 0],
          [40, 0],
          [40, 30],
          [0, 30],
        ],
        positions: [
          [150, 150],
          [190, 155],
          [185, 185],
          [148, 180],
        ],
        triangles: QUAD,
      },
    }, // $9
    { name: 'rig.addBinding', args: { target: '$9', parameter: '$1' } },
    {
      name: 'mesh.moveVertices',
      args: { target: '$9', cell: { '@param:ParamA': 1 }, offset: [12, -7] },
    },
    { name: 'blendShape.add', args: { target: '$9', parameter: '$2' } },
    {
      name: 'blendShape.set',
      args: {
        target: '$9',
        parameter: '$2',
        key: 1,
        values: {
          positions: [
            [5, 0],
            [0, 5],
            [-5, 0],
            [0, -5],
          ],
        },
      },
    },
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_Child',
        parent: '$5',
        rows: 1,
        cols: 1,
        rect: { x: -30, y: -30, width: 60, height: 60 },
      },
    }, // $14
    {
      name: 'mesh.create',
      args: {
        exportId: 'ArtMesh_InWarp',
        deformer: '$14',
        uv: [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        positions: [
          [0.2, 0.2],
          [0.8, 0.25],
          [0.7, 0.9],
          [0.1, 0.7],
        ],
        triangles: QUAD,
      },
    },
  ] as CommandCall[]);
  return s;
}

/** The UID of the object with this export ID. */
const uidOf = (s: Session, exportId: string) =>
  [...new DocView(s.doc).all()].find((o) => 'exportId' in o && o.exportId === exportId)!.uid;

const run = (s: Session, items: CommandCall[]) =>
  runItems({ session: s, assets: new MemoryAssetStore() }, 'test', items, {
    operations: OPERATIONS,
  });

/** Mesh vertices in canvas pixels at a pose. */
const vertices = (s: Session, pose: Record<string, number> = {}) => {
  const doc = new DocView(s.doc);
  const byId = Object.fromEntries(
    Object.entries(pose).map(([id, v]) => [
      doc.ofKind('parameter').find((p) => p.exportId === id)!.uid,
      v,
    ]),
  );
  const m = new DeformerMapper(doc, byId);
  const out = new Map<string, Float64Array>();
  for (const [u, p] of m.meshVertices()) out.set(doc.getAs(u, 'artMesh').exportId, p);
  return out;
};

const maxDistance = (a: Map<string, Float64Array>, b: Map<string, Float64Array>) => {
  let max = 0;
  for (const [k, p] of a) {
    const q = b.get(k)!;
    for (let i = 0; i < p.length; i += 2)
      max = Math.max(max, Math.hypot(p[i]! - q[i]!, p[i + 1]! - q[i + 1]!));
  }
  return max;
};

describe('invertMap', () => {
  it('inverts a smooth non-linear map by damped Newton steps', () => {
    const f = (p: Float64Array) => {
      const points = new Float64Array(p.length);
      const jacobians = new Float64Array(2 * p.length);
      for (let i = 0; i < p.length; i += 2) {
        const [u, v] = [p[i]!, p[i + 1]!];
        points[i] = u + 0.3 * Math.sin(v) + 0.1 * u * u * u;
        points[i + 1] = v + 0.2 * u * v;
        jacobians.set([1 + 0.3 * u * u, 0.3 * Math.cos(v), 0.2 * v, 1 + 0.2 * u], 2 * i);
      }
      return { points, jacobians };
    };
    const truth = Float64Array.of(0.5, 0.5, 2, -1, -1.5, 3);
    const r = invertMap(f, f(truth).points, new Float64Array(6), { tolerance: 1e-10 });
    expect(r.maxError).toBeLessThan(1e-10);
    r.points.forEach((v, i) => expect(v).toBeCloseTo(truth[i]!, 8));
  });
});

describe('mesh.reparent', () => {
  it('keeps a mesh in place through a bent warp, a rotation in it, a root rotation and back', async () => {
    const s = scene();
    const start = vertices(s);
    const atA = vertices(s, { ParamA: 1 });
    const shaped = vertices(s, { ParamShape: 1 });
    const original = new DocView(s.doc).getAs(uidOf(s, 'ArtMesh_A'), 'artMesh');
    for (const to of [
      '@warp:Warp_Bent',
      '@rot:Rotation_In',
      '@rot:Rotation_Root',
      '@warp:Warp_Child',
      null,
    ]) {
      const r = await run(s, [
        { name: 'mesh.reparent', args: { target: '@mesh:ArtMesh_A', deformer: to } },
      ]);
      expect(r.committed).toBe(true);
      expect((r.itemResults[0] as { maxShift: number }).maxShift).toBeLessThan(1e-3);
      // In place at rest, at the other keyform (parents at rest) and with the blend shape on.
      expect(maxDistance(start, vertices(s))).toBeLessThan(1e-3);
      if (to !== '@warp:Warp_Child') {
        expect(maxDistance(atA, vertices(s, { ParamA: 1 }))).toBeLessThan(1e-3);
        expect(maxDistance(shaped, vertices(s, { ParamShape: 1 }))).toBeLessThan(1e-3);
      }
    }
    // Back at the root: the stored values return (to float32 round-off).
    const back = new DocView(s.doc).getAs(uidOf(s, 'ArtMesh_A'), 'artMesh');
    expect(back.deformer).toBeNull();
    back.rig.keyforms.forEach((k, i) =>
      k.positions.forEach((v, j) =>
        expect(v).toBeCloseTo(original.rig.keyforms[i]!.positions[j]!, 2),
      ),
    );
  });

  it('records mesh.setDeformer with local values, so the log replays without the operation', async () => {
    const s = scene();
    await run(s, [
      { name: 'mesh.reparent', args: { target: '@mesh:ArtMesh_A', deformer: '@rot:Rotation_In' } },
    ]);
    const last = s.log.at(-1)!;
    expect(last.op === 'tx' && last.commands.map((c) => c.name)).toEqual(['mesh.setDeformer']);
    const again = replay(s.log);
    expect(again.doc).toEqual(s.doc);
    s.undo();
    expect(new DocView(s.doc).getAs(uidOf(s, 'ArtMesh_A'), 'artMesh').deformer).toBeNull();
  });
});

describe('reparenting under a disabled deformer', () => {
  it('converts as usual; maxShift leaves out the mesh it hides', async () => {
    const s = scene();
    const start = vertices(s).get('ArtMesh_A')!;
    s.run('deformer.update', { target: '@warp:Warp_Bent', enabled: false });
    const r = await run(s, [
      { name: 'mesh.reparent', args: { target: '@mesh:ArtMesh_A', deformer: '@rot:Rotation_In' } },
    ]);
    // The mesh is hidden now (its deformer's parent is disabled), so nothing drawn moved.
    expect((r.itemResults[0] as { maxShift: number }).maxShift).toBe(0);
    expect(vertices(s).has('ArtMesh_A')).toBe(false);
    // Enabled again, it is where it was.
    s.run('deformer.update', { target: '@warp:Warp_Bent', enabled: true });
    const after = vertices(s).get('ArtMesh_A')!;
    for (let i = 0; i < start.length; i++) expect(after[i]).toBeCloseTo(start[i]!, 3);
  });
});

describe('deformer.reparent', () => {
  it('moves a rotation into a bent warp with its world frame, children in place', async () => {
    const s = scene();
    // A mesh in the root rotation, to watch.
    s.run('mesh.create', {
      exportId: 'ArtMesh_R',
      deformer: '@rot:Rotation_Root',
      uv: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      positions: [
        [-10, -5],
        [10, -5],
        [10, 5],
        [-10, 5],
      ],
      triangles: QUAD,
    });
    const start = vertices(s);
    for (const to of ['@warp:Warp_Bent', '@rot:Rotation_In', '@warp:Warp_Child', null]) {
      const r = await run(s, [
        { name: 'deformer.reparent', args: { target: '@rot:Rotation_Root', parent: to } },
      ]);
      expect(r.committed).toBe(true);
      expect(maxDistance(start, vertices(s))).toBeLessThan(1e-3);
    }
    const k = new DocView(s.doc).ofKind('rotation').find((o) => o.exportId === 'Rotation_Root')!.rig
      .keyforms[0]!;
    // Back at the root: its own values again (scale is unit-free; the exporter applies 1/ppu).
    expect(k.angle).toBeCloseTo(-40, 3);
    expect(k.scale).toBeCloseTo(2, 4);
    expect(k.originX).toBeCloseTo(120, 2);
    expect(k.originY).toBeCloseTo(260, 2);
  });

  it('matches angle and scale through a rotation (scale normalization across the 1/ppu factor)', async () => {
    const s = scene();
    await run(s, [
      {
        name: 'deformer.reparent',
        args: { target: '@rot:Rotation_Root', parent: '@rot:Rotation_In' },
      },
    ]);
    const doc = new DocView(s.doc);
    const k = doc.ofKind('rotation').find((o) => o.exportId === 'Rotation_Root')!.rig.keyforms[0]!;
    // Rotation_In's world frame: its 25° and 0.8 plus the bent warp's direction and size at its
    // origin; measure the warp's part with the mapper and check the composition.
    const m = new DeformerMapper(doc);
    const j = m.jacobians(uidOf(s, 'Rotation_In'), [0, 0]);
    const inAngle = (Math.atan2(j[2]!, j[0]!) * 180) / Math.PI;
    const inScale = Math.sqrt(Math.abs(j[0]! * j[3]! - j[1]! * j[2]!));
    expect(k.angle + inAngle).toBeCloseTo(-40, 3);
    expect(k.scale * inScale).toBeCloseTo(2, 4);
  });

  it('moves a warp into a rotation: grid points exactly, children within maxShift', async () => {
    const s = scene();
    const start = vertices(s);
    const r = await run(s, [
      { name: 'deformer.reparent', args: { target: '@warp:Warp_Child', parent: null } },
    ]);
    const shift = (r.itemResults[0] as { maxShift: number }).maxShift;
    expect(shift).toBeLessThan(1e-3);
    expect(maxDistance(start, vertices(s))).toBeLessThan(shift + 1e-5);
    const r2 = await run(s, [
      {
        name: 'deformer.reparent',
        args: { target: '@warp:Warp_Child', parent: '@warp:Warp_Bent' },
      },
    ]);
    // Inside a bent warp, a warp's cells interpolate in the bent space: children move between
    // grid points, and maxShift says how far.
    const shift2 = (r2.itemResults[0] as { maxShift: number }).maxShift;
    expect(maxDistance(start, vertices(s))).toBeLessThan(shift2 + 1e-5);
    expect(shift2).toBeLessThan(5);
  });

  it('refuses a cycle', async () => {
    const s = scene();
    const r = run(s, [
      {
        name: 'deformer.reparent',
        args: { target: '@warp:Warp_Bent', parent: '@warp:Warp_Child' },
      },
    ]);
    await expect(r).rejects.toMatchObject({ code: 'E_CYCLE' } satisfies Partial<MochiError>);
  });
});

describe('keyform.moveInCanvas', () => {
  it('moves vertices of a mesh deep in the chain to canvas targets at the cell’s pose', async () => {
    const s = scene();
    s.run('rig.addBinding', { target: '@rot:Rotation_In', parameter: '@param:ParamA' });
    s.run('keyform.set', {
      target: '@rot:Rotation_In',
      cell: { '@param:ParamA': 1 },
      values: { angle: 70 },
    });
    s.run('rig.addBinding', { target: '@mesh:ArtMesh_InWarp', parameter: '@param:ParamA' });
    const before = vertices(s, { ParamA: 1 }).get('ArtMesh_InWarp')!;
    await run(s, [
      {
        name: 'keyform.moveInCanvas',
        args: {
          target: '@mesh:ArtMesh_InWarp',
          cell: { '@param:ParamA': 1 },
          points: [1, 3],
          offset: [7, -4],
        },
      },
      {
        name: 'keyform.moveInCanvas',
        args: {
          target: '@mesh:ArtMesh_InWarp',
          cell: { '@param:ParamA': 1 },
          points: [0],
          positions: [[201, 199]],
        },
      },
    ]);
    const after = vertices(s, { ParamA: 1 }).get('ArtMesh_InWarp')!;
    expect(after[2]! - before[2]!).toBeCloseTo(7, 3);
    expect(after[3]! - before[3]!).toBeCloseTo(-4, 3);
    expect(after[6]! - before[6]!).toBeCloseTo(7, 3);
    expect(after[0]!).toBeCloseTo(201, 3);
    expect(after[1]!).toBeCloseTo(199, 3);
    expect(after[4]).toBe(before[4]);
    // The rest keyform is untouched.
    const k0 = new DocView(s.doc).getAs(uidOf(s, 'ArtMesh_InWarp'), 'artMesh').rig.keyforms[0]!;
    expect(Array.from(k0.positions)).toEqual(
      Array.from(Float32Array.of(0.2, 0.2, 0.8, 0.25, 0.7, 0.9, 0.1, 0.7)),
    );
    const last = s.log.at(-1)!;
    expect(last.op === 'tx' && last.commands.map((c) => c.name)).toEqual([
      'keyform.set',
      'keyform.set',
    ]);
  });

  it('refuses a cell that names a parameter the object is not bound to', async () => {
    const s = scene();
    const r = run(s, [
      {
        name: 'keyform.moveInCanvas',
        args: { target: '@warp:Warp_Child', cell: { '@param:ParamA': 0 }, offset: [1, 0] },
      },
    ]);
    await expect(r).rejects.toMatchObject({ code: 'E_BAD_CELL' });
  });

  it('moves warp grid points and a rotation origin', async () => {
    const s = scene();
    const origin = () =>
      new DeformerMapper(new DocView(s.doc)).toCanvas(uidOf(s, 'Rotation_In'), [0, 0]);
    const o0 = origin();
    await run(s, [
      { name: 'keyform.moveInCanvas', args: { target: '@rot:Rotation_In', offset: [10, 0] } },
    ]);
    const o1 = origin();
    expect(o1[0]! - o0[0]!).toBeCloseTo(10, 3);
    expect(o1[1]! - o0[1]!).toBeCloseTo(0, 3);
    const after = vertices(s).get('ArtMesh_InWarp')!;
    await run(s, [
      {
        name: 'keyform.moveInCanvas',
        args: { target: '@warp:Warp_Child', points: [0, 1, 2, 3], offset: [0, 6] },
      },
    ]);
    const moved = vertices(s).get('ArtMesh_InWarp')!;
    for (let i = 1; i < moved.length; i += 2) expect(moved[i]! - after[i]!).toBeCloseTo(6, 3);
  });
});

describe('deformer.remove', () => {
  it('deletes a deformer and keeps its children in place, converted into its parent', async () => {
    const s = scene();
    // Put a mesh and a warp into the rotation inside the bent warp, then remove that rotation.
    await run(s, [
      { name: 'mesh.reparent', args: { target: '@mesh:ArtMesh_A', deformer: '@rot:Rotation_In' } },
    ]);
    const start = vertices(s);
    const r = await run(s, [{ name: 'deformer.remove', args: { target: '@rot:Rotation_In' } }]);
    expect(r.committed).toBe(true);
    const res = r.itemResults[0] as { meshes: number; deformers: number; maxShift: number };
    expect(res.meshes).toBeGreaterThanOrEqual(1);
    expect(res.maxShift).toBeLessThan(1e-3);
    const doc = new DocView(s.doc);
    expect(doc.ofKind('rotation').some((d) => d.exportId === 'Rotation_In')).toBe(false);
    expect(doc.getAs(uidOf(s, 'ArtMesh_A'), 'artMesh').deformer).toBe(uidOf(s, 'Warp_Bent'));
    expect(maxDistance(start, vertices(s))).toBeLessThan(1e-3);
    // One undo brings it back.
    s.undo();
    expect(new DocView(s.doc).ofKind('rotation').some((d) => d.exportId === 'Rotation_In')).toBe(
      true,
    );
  });
});
