/**
 * Blend shapes in the document: commands, errors, and how other commands keep them
 * consistent (mesh topology, key lists, parameter deletion).
 */
import { describe, expect, it } from 'vitest';
import {
  MochiError,
  checkInvariants,
  DocView,
  type ArtMesh,
  type CommandCall,
  type Document,
  type MeshDelta,
} from '@mochi-maker/core';
import { fixtureSession } from './fixture.js';

const SMILE: CommandCall[] = [
  {
    name: 'param.create',
    args: {
      exportId: 'ParamSmile',
      min: -1,
      max: 1,
      default: 0,
      keys: [-1, 0, 0.5, 1],
      type: 'blendShape',
    },
  },
  {
    name: 'blendShape.add',
    args: { target: '@mesh:ArtMesh_Face', parameter: '@param:ParamSmile' },
  },
];
const REF = { target: '@mesh:ArtMesh_Face', parameter: '@param:ParamSmile' };

function setup() {
  const s = fixtureSession();
  s.runBatch('smile', SMILE);
  const face = (): ArtMesh => s.view.ofKind('artMesh').find((m) => m.exportId === 'ArtMesh_Face')!;
  return { s, face };
}

function error(fn: () => unknown): MochiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof MochiError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

describe('blend shapes in the document', () => {
  it('add: all keys, the base nearest the default, zero deltas', () => {
    const { face } = setup();
    const [b] = face().blendShapes;
    expect(b!.keys).toEqual([-1, 0, 0.5, 1]);
    expect(b!.base).toBe(0);
    expect(b!.constraints).toEqual([]);
    for (const d of b!.deltas as MeshDelta[]) {
      expect(Array.from(d.positions)).toEqual(new Array(8).fill(0));
      expect([d.opacity, d.drawOrder, ...d.multiply, ...d.screen]).toEqual(new Array(8).fill(0));
    }
  });

  it('set: writes float32 deltas at a key, never at the base', () => {
    const { s, face } = setup();
    s.runBatch('set', [
      {
        name: 'blendShape.set',
        args: {
          ...REF,
          key: 1,
          values: {
            positions: [
              [1, 2],
              [3, 4],
              [5, 6],
              [7, 8.1],
            ],
            drawOrder: 20,
            multiply: [-0.5, 0, 0],
          },
        },
      },
    ]);
    const d = face().blendShapes[0]!.deltas[3] as MeshDelta;
    expect(Array.from(d.positions)).toEqual([1, 2, 3, 4, 5, 6, 7, Math.fround(8.1)]);
    expect(d.drawOrder).toBe(20);
    expect(d.multiply).toEqual([-0.5, 0, 0]);
    const base = error(() =>
      s.runBatch('x', [
        { name: 'blendShape.set', args: { ...REF, key: 0, values: { opacity: 1 } } },
      ]),
    );
    expect(base.code).toBe('E_RANGE');
    const field = error(() =>
      s.runBatch('x', [{ name: 'blendShape.set', args: { ...REF, key: 1, values: { angle: 1 } } }]),
    );
    expect(field.code).toBe('E_FIELD_NOT_APPLICABLE');
    const shape = error(() =>
      s.runBatch('x', [
        { name: 'blendShape.set', args: { ...REF, key: 1, values: { positions: [[0, 0]] } } },
      ]),
    );
    expect(shape.code).toBe('E_SHAPE');
  });

  it('refuses normal parameters, duplicates, layers, and bindings to blend-shape parameters', () => {
    const { s } = setup();
    const normal = error(() =>
      s.runBatch('x', [
        {
          name: 'blendShape.add',
          args: { target: '@mesh:ArtMesh_Face', parameter: '@param:ParamAngleX' },
        },
      ]),
    );
    expect(normal.code).toBe('E_RANGE');
    expect(normal.fixes?.[0]).toMatchObject({ command: 'param.create' });
    expect(error(() => s.runBatch('x', [{ name: 'blendShape.add', args: REF }])).code).toBe(
      'E_ALREADY_BOUND',
    );
    expect(
      error(() =>
        s.runBatch('x', [
          {
            name: 'blendShape.add',
            args: { target: '@layer~"face"', parameter: '@param:ParamSmile' },
          },
        ]),
      ).code,
    ).toMatch(/E_WRONG_KIND|E_BAD_REF/);
    expect(
      error(() =>
        s.runBatch('x', [
          {
            name: 'rig.addBinding',
            args: { target: '@mesh:ArtMesh_Face', parameter: '@param:ParamSmile' },
          },
        ]),
      ).code,
    ).toBe('E_RANGE');
  });

  it('setKeys keeps deltas at kept keys, zeroes new ones, and moves the base', () => {
    const { s, face } = setup();
    s.runBatch('set', [
      { name: 'blendShape.set', args: { ...REF, key: 1, values: { opacity: 0.25 } } },
      { name: 'blendShape.set', args: { ...REF, key: 0.5, values: { opacity: 0.5 } } },
      { name: 'blendShape.setKeys', args: { ...REF, keys: [0.5, 1], base: 0.5 } },
    ]);
    const b = face().blendShapes[0]!;
    expect(b.keys).toEqual([0.5, 1]);
    expect(b.base).toBe(0.5);
    expect((b.deltas as MeshDelta[]).map((d) => d.opacity)).toEqual([0, 0.25]);
  });

  it('constraints: ascending values, weights at most 1, even over the shape’s own parameter', () => {
    const { s, face } = setup();
    s.runBatch('c', [
      {
        name: 'blendShape.setConstraints',
        args: {
          ...REF,
          constraints: [
            {
              parameter: '@param:ParamAngleX',
              points: [
                [0, 1],
                [30, 0],
              ],
            },
          ],
        },
      },
    ]);
    expect(face().blendShapes[0]!.constraints[0]!.points).toEqual([
      [0, 1],
      [30, 0],
    ]);
    // A constraint over the blend shape's own parameter is valid.
    s.runBatch('own', [
      {
        name: 'blendShape.setConstraints',
        args: { ...REF, constraints: [{ parameter: '@param:ParamSmile', points: [[0, 1]] }] },
      },
    ]);
    expect(s.validate().violations).toEqual([]);
    // Weights above 1 act as 1, so they are refused with that fix; negative ones get a warning.
    const high = error(() =>
      s.runBatch('x', [
        {
          name: 'blendShape.setConstraints',
          args: { ...REF, constraints: [{ parameter: '@param:ParamAngleX', points: [[0, 1.5]] }] },
        },
      ]),
    );
    expect(high.code).toBe('E_RANGE');
    expect(high.fixes?.[0]).toMatchObject({ replace: { value: 1 } });
    s.runBatch('neg', [
      {
        name: 'blendShape.setConstraints',
        args: { ...REF, constraints: [{ parameter: '@param:ParamAngleX', points: [[0, -0.5]] }] },
      },
    ]);
    expect(s.validate().lint.map((l) => l.rule)).toContain('negative-constraint-weight');
    const order = error(() =>
      s.runBatch('x', [
        {
          name: 'blendShape.setConstraints',
          args: {
            ...REF,
            constraints: [
              {
                parameter: '@param:ParamAngleX',
                points: [
                  [1, 1],
                  [1, 0],
                ],
              },
            ],
          },
        },
      ]),
    );
    expect(order.code).toBe('E_RANGE');
  });

  it('mesh topology edits carry position deltas, linearly; the base stays zero', () => {
    const { s, face } = setup();
    const offsets = [
      [2, -4],
      [2, -4],
      [6, -4],
      [6, -4],
    ];
    s.runBatch('set', [
      { name: 'blendShape.set', args: { ...REF, key: 1, values: { positions: offsets } } },
      { name: 'mesh.addVertices', args: { target: '@mesh:ArtMesh_Face', points: [[50, 100]] } },
    ]);
    let b = face().blendShapes[0]!;
    const one = (b.deltas[3] as MeshDelta).positions;
    expect(one.length).toBe(10);
    // The x offset is 2 along the top edge and 6 along the bottom, a linear field: at y = 100
    // (halfway down the 200 px quad) the new vertex gets 4.
    expect(one[8]).toBeCloseTo(4, 5);
    expect(one[9]).toBeCloseTo(-4, 5);
    expect(Array.from((b.deltas[1] as MeshDelta).positions).every((x) => x === 0)).toBe(true);
    s.runBatch('del', [
      { name: 'mesh.deleteVertices', args: { target: '@mesh:ArtMesh_Face', vertices: [4] } },
    ]);
    b = face().blendShapes[0]!;
    expect(Array.from((b.deltas[3] as MeshDelta).positions)).toEqual(offsets.flat());
    expect(s.validate().violations).toEqual([]);
  });

  it('a key a blend shape uses cannot be removed from the parameter; the fix edits the shape', () => {
    const { s } = setup();
    const e = error(() =>
      s.runBatch('x', [
        { name: 'param.setKeys', args: { target: '@param:ParamSmile', keys: [-1, 0, 1] } },
      ]),
    );
    expect(e.code).toBe('E_KEY_IN_USE');
    expect(e.fixes?.[0]).toMatchObject({
      command: 'blendShape.setKeys',
      args: { keys: [-1, 0, 1] },
    });
    const fix = e.fixes![0] as { command: string; args: Record<string, unknown> };
    s.runBatch('fix', [{ name: fix.command, args: fix.args }]);
    s.runBatch('x', [
      { name: 'param.setKeys', args: { target: '@param:ParamSmile', keys: [-1, 0, 1] } },
    ]);
  });

  it('deleting a parameter with cascade removes its blend shapes and constraints over it', () => {
    const { s, face } = setup();
    s.runBatch('c', [
      {
        name: 'blendShape.setConstraints',
        args: {
          ...REF,
          constraints: [
            {
              parameter: '@param:ParamAngleX',
              points: [
                [0, 1],
                [30, 0],
              ],
            },
          ],
        },
      },
    ]);
    expect(
      error(() =>
        s.runBatch('x', [{ name: 'param.delete', args: { target: '@param:ParamAngleX' } }]),
      ).code,
    ).toBe('E_IN_USE');
    s.runBatch('x', [
      { name: 'param.delete', args: { target: '@param:ParamAngleX', cascade: true } },
    ]);
    expect(face().blendShapes[0]!.constraints).toEqual([]);
    s.runBatch('x', [
      { name: 'param.delete', args: { target: '@param:ParamSmile', cascade: true } },
    ]);
    expect(face().blendShapes).toEqual([]);
    expect(s.validate().violations).toEqual([]);
  });

  it('invariants: a non-zero base delta or a wrong delta size is caught', () => {
    const { s, face } = setup();
    const f = face();
    const b = f.blendShapes[0]!;
    const broken = (deltas: MeshDelta[]): Document => ({
      ...s.doc,
      objects: { ...s.doc.objects, [f.uid]: { ...f, blendShapes: [{ ...b, deltas }] } },
    });
    const d = b.deltas as MeshDelta[];
    const nonZeroBase = d.map((x, i) => (i === 1 ? { ...x, opacity: 0.1 } : x));
    expect(checkInvariants(new DocView(broken(nonZeroBase))).map((v) => v.message)).toContain(
      'the base key’s delta must be all zero',
    );
    const short = d.map((x) => ({ ...x, positions: new Float32Array(2) }));
    expect(
      checkInvariants(new DocView(broken(short))).some((v) => v.path.endsWith('.positions')),
    ).toBe(true);
  });

  it('glues take blend shapes on their intensity, with a warning when the clamp would act', () => {
    const { s } = setup();
    const glue = { target: '@glue:Glue_Neck', parameter: '@param:ParamSmile' };
    s.runBatch('glue', [
      { name: 'blendShape.add', args: glue },
      { name: 'blendShape.set', args: { ...glue, key: 1, values: { intensity: -0.5 } } },
    ]);
    const g = s.view.ofKind('glue')[0]!;
    expect(g.blendShapes[0]!.deltas.map((d) => (d as { intensity: number }).intensity)).toEqual([
      0, 0, 0, -0.5,
    ]);
    expect(s.validate().lint.map((l) => l.rule)).not.toContain('target-clamp-range');
    s.runBatch('i', [
      {
        name: 'keyform.set',
        args: { target: '@glue:Glue_Neck', all: true, values: { intensity: 1.5 } },
      },
    ]);
    expect(s.validate().lint.map((l) => l.rule)).toContain('target-clamp-range');
    s.runBatch('x', [
      { name: 'param.delete', args: { target: '@param:ParamSmile', cascade: true } },
    ]);
    expect(s.view.ofKind('glue')[0]!.blendShapes).toEqual([]);
  });

  it('authored opacities stay within 0…1', () => {
    const { s } = setup();
    const e = error(() =>
      s.runBatch('x', [
        {
          name: 'keyform.set',
          args: { target: '@mesh:ArtMesh_Face', all: true, values: { opacity: 1.5 } },
        },
      ]),
    );
    expect(e.code).toBe('E_RANGE');
    expect(e.fixes?.[0]).toMatchObject({ replace: { value: 1 } });
  });
});

describe('target clamp-range warnings', () => {
  it('warns when a deformer’s opacity or a rotation’s scale can leave its range', () => {
    const s = fixtureSession();
    s.runBatch('shape', [
      ...SMILE,
      {
        name: 'blendShape.add',
        args: { target: '@warp:Warp_Face', parameter: '@param:ParamSmile' },
      },
      {
        name: 'blendShape.add',
        args: { target: '@rot:Rotation_Neck', parameter: '@param:ParamSmile' },
      },
    ]);
    const rules = () => s.validate().lint.map((l) => l.rule);
    expect(rules()).not.toContain('target-clamp-range');
    // Opacity 1 plus +0.5 at key 1 reaches 1.5.
    s.runBatch('up', [
      {
        name: 'blendShape.set',
        args: {
          target: '@warp:Warp_Face',
          parameter: '@param:ParamSmile',
          key: 1,
          values: { opacity: 0.5 },
        },
      },
    ]);
    expect(rules()).toContain('target-clamp-range');
    // A constraint whose weights stay at 0 removes the reach.
    s.runBatch('c', [
      {
        name: 'blendShape.setConstraints',
        args: {
          target: '@warp:Warp_Face',
          parameter: '@param:ParamSmile',
          constraints: [{ parameter: '@param:ParamAngleX', points: [[0, 0]] }],
        },
      },
    ]);
    expect(rules()).not.toContain('target-clamp-range');
    // Scale 1 with −1 at key −1 reaches 0.
    s.runBatch('scale', [
      {
        name: 'blendShape.set',
        args: {
          target: '@rot:Rotation_Neck',
          parameter: '@param:ParamSmile',
          key: -1,
          values: { scale: -1 },
        },
      },
    ]);
    expect(rules()).toContain('target-clamp-range');
  });

  it('covers colors, draw order, angle and scale, with a milder hint above scale 10', () => {
    const s = fixtureSession();
    s.runBatch('shape', [
      ...SMILE,
      {
        name: 'blendShape.add',
        args: { target: '@rot:Rotation_Neck', parameter: '@param:ParamSmile' },
      },
    ]);
    const lint = () =>
      s
        .validate()
        .lint.filter((l) => l.rule.startsWith('target-') || l.rule.startsWith('rotation-'));
    expect(lint()).toEqual([]);
    const set = (target: string, values: Record<string, unknown>) =>
      s.runBatch('set', [
        {
          name: 'blendShape.set',
          args: { target, parameter: '@param:ParamSmile', key: 1, values },
        },
      ]);
    set('@mesh:ArtMesh_Face', { multiply: [0, 0.5, 0] });
    expect(
      lint()
        .map((l) => l.message)
        .join(),
    ).toContain('multiply color (green)');
    set('@mesh:ArtMesh_Face', { multiply: [0, 0, 0], drawOrder: 600 });
    expect(
      lint()
        .map((l) => l.message)
        .join(),
    ).toContain('draw order reaches 500…1100');
    set('@mesh:ArtMesh_Face', { drawOrder: 0 });
    set('@rot:Rotation_Neck', { angle: 4000 });
    expect(
      lint()
        .map((l) => l.message)
        .join(),
    ).toContain('its angle reaches -10…4010');
    set('@rot:Rotation_Neck', { angle: 0, scale: 20 });
    expect(lint().map((l) => l.rule)).toEqual(['rotation-scale-unusual']);
    set('@rot:Rotation_Neck', { scale: 200 });
    expect(lint().map((l) => l.rule)).toEqual(['target-clamp-range']);
  });
});
