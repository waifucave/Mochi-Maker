/**
 * M8, blend shapes (difference-based interpolation): goldens 7 and 8 exported, loaded in Mochi2D and compared with values computed by hand
 * from §1c.4 (result + w·s, w the minimum of the constraint curves) and the draw-order
 * formula.
 */
import { describe, expect, it } from 'vitest';
import { MochiError } from '@mochi-maker/core';
import {
  drawOrderKey,
  exportModel,
  requiredVersion,
  type ExportProblem,
} from '@mochi-maker/export';
import { readMoc } from 'mochi2d/headless';
import { golden1, golden10, golden7, golden8, golden9 } from './golden.js';
import { evaluate, expectVertices, out } from './probe.js';

describe('the draw-order formula', () => {
  it('reproduces every test vector', () => {
    const F = Math.fround;
    // [D, blend-shape deltas or null for an object that is not a target, expected]
    const vectors: [number, number[] | null, number][] = [
      [F(499.999512), null, 500],
      [F(499.998962), null, 499],
      [F(499.999512), [-0.3], 499],
      [500, [0.9995], 501],
      [500, [-0.0005], 500],
      [500, [-0.002], 499],
      [F(500.5), [0.6], 500],
      [F(500.7), [-0.6], 499],
      [500, [0.4995, 0.5], 501],
      [F(505.621), [8.8], 513],
      [F(-3.7), null, -3],
      [F(-3.7), [0], 0],
      [F(-5.5), [7.3], 2],
      [F(2.5), [-3.2], 0],
    ];
    for (const [D, deltas, expected] of vectors) {
      const B = (deltas ?? []).reduce((s, x) => F(s + F(x)), 0);
      expect(drawOrderKey(D, B, deltas !== null), `${D} ${deltas}`).toBe(expected);
    }
  });
});

describe('golden 7: blend shapes on positions', () => {
  // Mouth: corners (150, 200)–(250, 240); ParamOpen moves the bottom edge 20 px down.
  // ParamSmile moves the top corners by −10·smile px in y, weighted by 1 − open (the constraint).
  // ParamWide moves the left edge −10·wide px and the right edge +10·wide px in x.
  const mouth = (smile: number, open: number, wide: number) => {
    const top = 200 - 10 * smile * (1 - open);
    const bottom = 240 + 20 * open;
    return [
      [150 - 10 * wide, top],
      [250 + 10 * wide, top],
      [250 + 10 * wide, bottom],
      [150 - 10 * wide, bottom],
    ].flatMap(([x, y]) => out(x!, y!, 200, 200, 400));
  };
  const poses: [number, number, number, number][] = [
    // smile, open, wide, lift
    [1, 0, 0, 0],
    [-0.5, 0, 0, 0.5],
    [1, 0.5, 0, 1],
    [0.5, 0.25, 1, 0],
    [1, 1, 0.5, 0.25],
  ];

  for (const version of [4, 5] as const)
    it(`evaluates as computed at version ${version}`, async () => {
      const g = await golden7();
      const r = await exportModel(g.session.doc, g.assets, { mocVersion: version });
      expect(readMoc(r.files.get('golden7.moc3')!).version).toBe(version);
      for (const [smile, open, wide, lift] of poses) {
        const m = evaluate(r, 'golden7', {
          ParamSmile: smile,
          ParamOpen: open,
          ParamWide: wide,
          ParamLift: lift,
        });
        expectVertices(m.get('Mouth')!.vertices, mouth(smile, open, wide));
        // Brow: the warp's grid rises 20·lift px, so the brow at uv 0.25…0.75 does too.
        expectVertices(
          m.get('Brow')!.vertices,
          [
            [150, 75],
            [250, 75],
            [250, 125],
            [150, 125],
          ].flatMap(([x, y]) => out(x!, y! - 20 * lift, 200, 200, 400)),
        );
      }
    });

  it('auto picks version 4 when only positions move', async () => {
    const g = await golden7();
    g.session.runBatch('min 3', [
      { name: 'project.setExportSettings', args: { mocVersion: 'auto', minimumVersion: 3 } },
    ]);
    const r = await exportModel(g.session.doc, g.assets);
    expect(r.report.mocVersion).toBe(4);
    expect(r.report.versionReason).toContain('blend shapes on positions');
  });

  it('writes deltas after the normal keyforms, with the base keyform all zero', async () => {
    const g = await golden7();
    const r = await exportModel(g.session.doc, g.assets);
    const { data } = readMoc(r.files.get('golden7.moc3')!);
    const kb = data.blendShapeKeyformBindings!;
    const pb = data.blendShapeParameterBindings!;
    const t = data.artMeshBlendShapeTargets!;
    const mouth = data.artMeshes.ids.indexOf('Mouth');
    expect(Array.from(t.object)).toEqual([mouth]);
    expect(t.bindingCount[0]).toBe(2);
    const normal = data.artMeshes.keyformCount.reduce((a, b) => a + b, 0);
    // ParamSmile: keys −1, 0, 1, base index 1; its keyforms follow all normal keyforms.
    const smile = t.firstBinding[0]!;
    expect(kb.firstKeyform[smile]).toBe(normal);
    expect(kb.keyformCount[smile]).toBe(3);
    expect(pb.baseKey[kb.parameterBinding[smile]!]).toBe(1);
    const run = (k: number) => {
      const p = data.artMeshKeyforms.firstPosition[k]!;
      return Array.from(data.keyformPositions.subarray(p, p + 8));
    };
    expect(run(normal + 1).every((x) => x === 0)).toBe(true);
    // Key 1: the top corners' y offsets, −10 px = −0.025 model units.
    expectVertices(run(normal + 2), [0, -0.025, 0, -0.025, 0, 0, 0, 0], 1e-7);
    // Every blend-shape position comes after every normal position.
    const lastNormal = Math.max(
      ...Array.from(data.artMeshKeyforms.firstPosition.subarray(0, normal)),
      ...Array.from(data.warpKeyforms.firstPosition.subarray(0, data.warpDeformers.band.length)),
    );
    expect(data.artMeshKeyforms.firstPosition[normal]!).toBeGreaterThan(lastNormal);
    // The constraint: ParamOpen, weights 1 at 0 and 0 at 1.
    const c = data.blendShapeConstraintEntries![kb.firstConstraintEntry[smile]!]!;
    expect(data.parameters.ids[data.blendShapeConstraints!.parameter[c]!]).toBe('ParamOpen');
    expect(Array.from(data.blendShapeConstraintValues!.weight)).toEqual([1, 0]);
    // Blend-shape parameters own their blend-shape bindings, and no normal ones.
    const ps = data.parameters;
    const i = ps.ids.indexOf('ParamSmile');
    expect(ps.type![i]).toBe(1);
    expect(ps.bindingCount[i]).toBe(0);
    expect(ps.blendShapeBindingCount![i]).toBe(1);
  });
});

describe('golden 8: blend shapes on every value', () => {
  // Face's weight: min(1 − c, 1 − 0.5·c2).
  const poses: [number, number, number][] = [
    // bs, c, c2
    [0, 0, 0],
    [1, 0, 0],
    [0.5, 0.5, 0.6],
    [1, 0.2, 1],
    [0.25, 0, 0],
  ];

  it('evaluates opacity, colors, draw order, rotations and part order as computed', async () => {
    const g = await golden8();
    const r = await exportModel(g.session.doc, g.assets);
    for (const [bs, c, c2] of poses) {
      const m = evaluate(r, 'golden8', { ParamBS: bs, ParamC: c, ParamC2: c2 });
      const w = Math.min(1 - c, 1 - 0.5 * c2);
      const face = m.get('Face')!;
      expect(face.opacity).toBeCloseTo(1 - 0.5 * bs * w, 6);
      expectVertices(face.multiplyColor, [1 - 0.5 * bs * w, 1, 1, 1], 1e-6);
      expectVertices(face.screenColor, [0, 0.25 * bs * w, 0, 1], 1e-6);
      const faceOrder = drawOrderKey(500, Math.fround(20 * bs * w), true);
      expect((face as unknown as { drawOrder: number }).drawOrder).toBe(faceOrder);

      // Rotation_BS: origin (140 + 10·bs, 60), angle 30·bs, scale 1 + 0.5·bs; Arm in pixels.
      const t = (30 * bs * Math.PI) / 180;
      const k = 1 + 0.5 * bs;
      const ox = 140 + 10 * bs;
      expectVertices(
        m.get('Arm')!.vertices,
        [
          [-10, -5],
          [10, -5],
          [10, 5],
          [-10, 5],
        ].flatMap(([px, py]) =>
          out(
            ox + k * (Math.cos(t) * px! - Math.sin(t) * py!),
            60 + k * (Math.sin(t) * px! + Math.cos(t) * py!),
            100,
            100,
            200,
          ),
        ),
      );

      // Warp_Fade: opacity 1 − 0.5·bs and multiply green 1 − 0.5·bs, passed to Tinted.
      const tinted = m.get('Tinted')!;
      expect(tinted.opacity).toBeCloseTo(1 - 0.5 * bs, 6);
      expectVertices(tinted.multiplyColor, [1, 1 - 0.5 * bs, 1, 1], 1e-6);

      // Render order: keys Face = faceOrder, Part_BS = 500 − 20·bs, Arm = Tinted = 500; ties
      // keep the root's order (Face, Part_BS, Arm, Tinted).
      const keys: [string, number][] = [
        ['Face', faceOrder],
        ['Inner', drawOrderKey(500, Math.fround(-20 * bs), true)],
        ['Arm', 500],
        ['Tinted', 500],
      ];
      const expected = keys
        .map((x, i) => ({ id: x[0], key: x[1], i }))
        .sort((a, b) => a.key - b.key || a.i - b.i)
        .map((x) => x.id);
      const actual = [...m.values()].sort((a, b) => a.renderOrder - b.renderOrder).map((d) => d.id);
      expect(actual, `pose ${bs}, ${c}, ${c2}`).toEqual(expected);
    }
  });

  it('writes the group range the members can reach: 480…520 at the root', async () => {
    const g = await golden8();
    const r = await exportModel(g.session.doc, g.assets);
    const { data } = readMoc(r.files.get('golden8.moc3')!);
    const gs = data.drawOrderGroups;
    expect([gs.minDrawOrder[0], gs.maxDrawOrder[0]]).toEqual([480, 520]);
    expect([gs.minDrawOrder[1], gs.maxDrawOrder[1]]).toEqual([500, 500]);
  });

  it('gives blend-shape keyforms their own color entries, holding deltas', async () => {
    const g = await golden8();
    const r = await exportModel(g.session.doc, g.assets);
    const { data } = readMoc(r.files.get('golden8.moc3')!);
    const kb = data.blendShapeKeyformBindings!;
    const t = data.artMeshBlendShapeTargets!;
    const face = data.artMeshes.ids.indexOf('Face');
    const b = t.firstBinding[Array.from(t.object).indexOf(face)]!;
    const k1 = kb.firstKeyform[b]! + 1;
    const mc = data.artMeshKeyforms.multiplyColor![k1]!;
    const sc = data.artMeshKeyforms.screenColor![k1]!;
    expect(mc).toBe(sc);
    expect(mc).toBeGreaterThanOrEqual(data.multiplyColors!.r.length - 16);
    expect([data.multiplyColors!.r[mc], data.screenColors!.g[sc]]).toEqual([-0.5, 0.25]);
    expect(data.artMeshKeyforms.drawOrder[k1]).toBe(20);
    expect(data.artMeshKeyforms.drawOrder[k1 - 1]).toBe(0);
    // The rotation's origin offset is converted to model units: 10 px / 200.
    const rt = data.rotationBlendShapeTargets!;
    expect(rt.object.length).toBe(1);
    const rk = kb.firstKeyform[rt.firstBinding[0]!]! + 1;
    expect(data.rotationKeyforms.originX[rk]).toBeCloseTo(0.05, 7);
    // Scale offsets get the same 1/ppu factor as the rotation's scale (design 3.5).
    expect(data.rotationKeyforms.scale[rk]).toBeCloseTo(0.5 / 200, 9);
    expect(data.partBlendShapeTargets!.object.length).toBe(1);
  });

  it('version 4 cannot carry it: the export names what needs version 5', async () => {
    const g = await golden8();
    const e = (await exportModel(g.session.doc, g.assets, { mocVersion: 4 }).catch(
      (x: unknown) => x,
    )) as MochiError;
    expect(e).toBeInstanceOf(MochiError);
    expect(e.code).toBe('E_EXPORT');
    const problems = (e.details!.problems as ExportProblem[]).filter((p) => p.source === 'version');
    const text = problems.map((p) => p.message).join('\n');
    expect(text).toContain('blend shapes on a rotation');
    expect(text).toContain('blend shapes on a part');
    expect(text).toContain('blend shapes on opacity, draw order or colors');
    expect(problems.length).toBe(4); // Face, Part_BS, Rotation_BS, Warp_Fade
  });
});

describe('golden 9: draw orders at the formula’s edges (Mochi2D 0.3.0)', () => {
  const expected: Record<string, [number, number]> = {
    Near: [500, 500],
    Below: [499, 499],
    Up: [500, 501],
    Small: [500, 500],
    Down: [500, 499],
    Neg: [-3, -3],
    NegTarget: [0, 0],
  };
  // Root order of the draw-order objects: the meshes in creation order, then Part_Edge.
  const rootOrder = [...Object.keys(expected), 'Inside'];

  it('reports the formula’s draw orders, and sorts by them', async () => {
    const g = await golden9();
    const r = await exportModel(g.session.doc, g.assets);
    for (const [i, edge] of [0, 1].entries()) {
      const m = evaluate(r, 'golden9', { ParamEdge: edge });
      for (const [id, values] of Object.entries(expected))
        expect((m.get(id) as unknown as { drawOrder: number }).drawOrder, `${id} at ${edge}`).toBe(
          values[i],
        );
      const keys = new Map(Object.entries(expected).map(([id, v]) => [id, v[i]!]));
      keys.set('Inside', i === 0 ? 500 : 499); // Part_Edge's key
      const sorted = rootOrder
        .map((id, k) => ({ id, key: keys.get(id)!, k }))
        .sort((a, b) => a.key - b.key || a.k - b.k)
        .map((x) => x.id);
      const actual = [...m.values()].sort((a, b) => a.renderOrder - b.renderOrder).map((d) => d.id);
      expect(actual, `ParamEdge = ${edge}`).toEqual(sorted);
    }
  });

  it('writes the root range from −3 (Neg) to 501 (Up)', async () => {
    const g = await golden9();
    const r = await exportModel(g.session.doc, g.assets);
    const { data } = readMoc(r.files.get('golden9.moc3')!);
    expect([data.drawOrderGroups.minDrawOrder[0], data.drawOrderGroups.maxDrawOrder[0]]).toEqual([
      -3, 501,
    ]);
    // Part_Edge's own group holds Inside at 500.
    expect([data.drawOrderGroups.minDrawOrder[1], data.drawOrderGroups.maxDrawOrder[1]]).toEqual([
      500, 500,
    ]);
  });
});

describe('golden 10: glue blend shapes', () => {
  // A's vertex 1 is at x = 40 and B's vertex 0 at x = 60: with weights 0.5 / 0.5, A moves by
  // 20·0.5·I px, so I = (x − 40) / 10. A glue that is a blend-shape target is clamped to 0…1.
  const expected = (delta: number, g: number) => Math.min(1, Math.max(0, 0.5 + delta * g));

  it('adds the blend shape to the intensity, clamped for targets', async () => {
    const g = await golden10();
    const r = await exportModel(g.session.doc, g.assets);
    const { data } = readMoc(r.files.get('golden10.moc3')!);
    expect(Array.from(data.glueBlendShapeTargets!.object)).toEqual([0, 1, 2]);
    expect(r.report.mocVersion).toBe(5);
    for (const v of [0, 0.5, 1]) {
      const m = evaluate(r, 'golden10', { ParamGlueBS: v });
      for (const [name, delta] of [
        ['Up', 0.3],
        ['Down', -0.5],
        ['Clamp', 0.8],
      ] as const) {
        const x = m.get(`${name}_A`)!.vertices[2]! * 200 + 100;
        const intensity = (x - 40) / 10;
        expect(intensity, `${name} at ${v}`).toBeCloseTo(expected(delta, v), 5);
      }
    }
  });

  it('needs version 5', async () => {
    const g = await golden10();
    const reasons = requiredVersion(g.session.view).reasons;
    expect(reasons.map((x) => x.feature)).toEqual([
      'blend shapes on a glue: ParamGlueBS (version 5)',
      'blend shapes on a glue: ParamGlueBS (version 5)',
      'blend shapes on a glue: ParamGlueBS (version 5)',
    ]);
  });
});

describe('version 5 clamps targets, version 4 clamps nothing', () => {
  it('caps a version-5 target’s draw order at 1000', () => {
    const F = Math.fround;
    expect(drawOrderKey(F(999.5), 0, true)).toBe(999);
    expect(drawOrderKey(F(1000.5), 0, true)).toBe(1000);
    expect(drawOrderKey(1500, 0, true)).toBe(1000);
    expect(drawOrderKey(1e6, 0, true)).toBe(1000);
    expect(drawOrderKey(1500, 0, false)).toBe(1500);
    // Contributions are added one at a time.
    expect(drawOrderKey(500, [0.8, -0.8], true)).toBe(500);
  });

  it('evaluates a draw order of 1500 on a target as 1000 in version 5 and 1500 in version 4', async () => {
    const g = await golden1();
    g.session.runBatch('target', [
      {
        name: 'param.create',
        args: { exportId: 'ParamT', min: 0, max: 1, default: 0, type: 'blendShape' },
      },
      {
        name: 'keyform.set',
        args: { target: '@mesh:ArtMesh_Square', all: true, values: { drawOrder: 1500 } },
      },
      {
        name: 'blendShape.add',
        args: { target: '@mesh:ArtMesh_Square', parameter: '@param:ParamT' },
      },
      {
        name: 'blendShape.set',
        args: {
          target: '@mesh:ArtMesh_Square',
          parameter: '@param:ParamT',
          key: 1,
          values: {
            positions: [
              [1, 0],
              [1, 0],
              [1, 0],
              [1, 0],
            ],
          },
        },
      },
    ]);
    const order = async (v: 4 | 5) => {
      const r = await exportModel(g.session.doc, g.assets, { mocVersion: v });
      const d = evaluate(r, 'golden1').get('ArtMesh_Square') as unknown as { drawOrder: number };
      const { data } = readMoc(r.files.get('golden1.moc3')!);
      return {
        drawOrder: d.drawOrder,
        range: [data.drawOrderGroups.minDrawOrder[0], data.drawOrderGroups.maxDrawOrder[0]],
      };
    };
    const v5 = await order(5);
    expect(v5.range).toEqual([1000, 1000]);
    expect(v5.drawOrder).toBe(1000);
    const v4 = await order(4);
    expect(v4).toEqual({ drawOrder: 1500, range: [1500, 1500] });
  });
});
