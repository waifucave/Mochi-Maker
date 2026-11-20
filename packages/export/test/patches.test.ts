/**
 * Value patches (Mochi2D 0.6.0): for value-only edits the patches turn the shown data into the
 * new lowering exactly, and patching a loaded model evaluates like a rebuild, bit for bit.
 */
import { describe, expect, it } from 'vitest';
import { DocView, type Session } from '@mochi-maker/core';
import { MemoryFileSource, ModelRuntime, mocModelFromData, ModelInstance } from 'mochi2d/headless';
import { PreviewBuilder, applyDataPatches, dataPatches } from '../src/index.js';
import { golden1, golden3, golden4, golden7, golden10 } from './golden.js';

async function lowered(builder: PreviewBuilder, s: Session) {
  return (await builder.build(s.doc)).lowered.data;
}

const evaluateAll = (inst: ModelInstance) => {
  inst.evaluate();
  return {
    v: inst.drawableVertices.map((x) => Array.from(x)),
    o: Array.from(inst.drawableOpacity),
    d: Array.from(inst.drawableDrawOrder),
    r: Array.from(inst.drawableRenderOrder),
    m: Array.from(inst.drawableMultiply),
    s: Array.from(inst.drawableScreen),
  };
};

describe('value patches', () => {
  it('turn the shown data into the new lowering for value edits, and evaluate like a rebuild', async () => {
    const cases: [string, () => ReturnType<typeof golden1>, (s: Session) => void][] = [
      [
        'mesh positions',
        golden1,
        (s) =>
          s.run('mesh.moveVertices', {
            target: '@mesh:ArtMesh_Square',
            all: true,
            offset: [7, -3],
          }),
      ],
      [
        'mesh opacity',
        golden1,
        (s) =>
          s.run('keyform.set', {
            target: '@mesh:ArtMesh_Square',
            cell: { '@param:ParamA': 1 },
            values: { opacity: 0.2 },
          }),
      ],
      [
        'colors',
        golden4,
        (s) => {
          const m = s.view.ofKind('artMesh')[0]!;
          s.run('keyform.set', {
            target: m.uid,
            all: true,
            values: { multiply: [0.5, 0.25, 1], screen: [0.1, 0, 0] },
          });
        },
      ],
      [
        'blend-shape delta',
        golden7,
        (s) => {
          const m = s.view.ofKind('artMesh').find((x) => x.blendShapes.length > 0)!;
          const b = m.blendShapes[0]!;
          const key = b.keys.find((k) => k !== b.base)!;
          s.run('blendShape.set', {
            target: m.uid,
            parameter: b.parameter,
            key,
            values: {
              positions: Array.from({ length: m.uv.length / 2 }, () => [3, 1] as [number, number]),
            },
          });
        },
      ],
      [
        'glue intensity',
        golden10,
        (s) => {
          const g = s.view.ofKind('glue')[0]!;
          s.run('keyform.set', { target: g.uid, all: true, values: { intensity: 0.25 } });
        },
      ],
    ];
    for (const [name, make, edit] of cases) {
      const g = await make();
      const builder = new PreviewBuilder(g.assets);
      const before = await lowered(builder, g.session);
      edit(g.session);
      const b = await builder.build(g.session.doc);
      const patches = dataPatches(before, b.lowered.data);
      expect(patches, name).not.toBeNull();
      expect(patches!.length, name).toBeGreaterThan(0);
      // Patching the old data gives the new data exactly.
      const copy = structuredClone(before);
      applyDataPatches(copy, patches!);
      expect(dataPatches(copy, b.lowered.data), name).toEqual([]);
      // A model patched in place evaluates like the rebuilt one, bit for bit.
      const patched = new ModelInstance(mocModelFromData(before, b.version));
      evaluateAll(patched);
      patched.patch(patches!);
      const rebuilt = new ModelInstance(mocModelFromData(b.lowered.data, b.version));
      expect(evaluateAll(patched), name).toEqual(evaluateAll(rebuilt));
    }
  });

  it('refuse structural edits', async () => {
    const g = await golden1();
    const builder = new PreviewBuilder(g.assets);
    const before = await lowered(builder, g.session);
    const mesh = g.session.view.ofKind('artMesh')[0]!;
    g.session.run('mesh.addVertices', { target: mesh.uid, points: [[50, 50]] });
    expect(dataPatches(before, await lowered(builder, g.session))).toBeNull();
    g.session.undo();
    g.session.run('param.create', { exportId: 'ParamNew', min: 0, max: 1, keys: [0, 1] });
    expect(dataPatches(before, await lowered(builder, g.session))).toBeNull();
    // A draw order that moves its group's range changes the groups too: not a patch.
    const g3 = await golden3();
    const b3 = new PreviewBuilder(g3.assets);
    const before3 = await lowered(b3, g3.session);
    g3.session.run('keyform.set', { target: '@mesh:Front', all: true, values: { drawOrder: 450 } });
    expect(dataPatches(before3, await lowered(b3, g3.session))).toBeNull();
    // An unchanged document needs no patch.
    g.session.undo();
    expect(dataPatches(before, await lowered(builder, g.session))).toEqual([]);
    void DocView;
    void MemoryFileSource;
    void ModelRuntime;
  });
});
