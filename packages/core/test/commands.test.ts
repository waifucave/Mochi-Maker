import { describe, expect, it } from 'vitest';
import { MochiError, Session, type ArtMesh, type Part, type Rotation } from '@mochi-maker/core';
import { QUAD_TRIS, fixtureSession, quad } from './fixture.js';

function error(fn: () => unknown): MochiError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MochiError);
    return e as MochiError;
  }
  throw new Error('expected an error');
}

describe('references', () => {
  it('accept UIDs, export IDs and display names', () => {
    const s = fixtureSession();
    const v = s.view;
    expect(v.resolve('@mesh:ArtMesh_Face', ['artMesh'])).toBe('mesh_0009');
    expect(v.resolve('@mesh~"Left eye"', ['artMesh'])).toBe('mesh_0010');
    expect(v.resolve('@deformer:Warp_Face', ['warp', 'rotation'])).toBe('warp_0008');
    expect(v.resolve('mesh_0009', ['artMesh'])).toBe('mesh_0009');
  });

  it('explain what went wrong', () => {
    const s = fixtureSession();
    expect(error(() => s.view.resolve('@mesh:Nope', ['artMesh'])).code).toBe('E_NOT_FOUND');
    expect(error(() => s.view.resolve('part_0004', ['artMesh'])).code).toBe('E_WRONG_KIND');
    expect(error(() => s.view.resolve('ArtMesh_Face', ['artMesh'])).code).toBe('E_BAD_REF');
    s.run('object.rename', { target: '@mesh:ArtMesh_Neck', name: 'Face' });
    const e = error(() => s.view.resolve('@mesh~Face', ['artMesh']));
    expect(e.code).toBe('E_AMBIGUOUS_REF');
    expect(e.details?.candidates).toHaveLength(2);
  });
});

describe('transactions', () => {
  it('are atomic, and name the failing command', () => {
    const s = fixtureSession();
    const before = s.doc;
    const e = error(() =>
      s.runBatch('t', [
        { name: 'param.create', args: { exportId: 'ParamNew', min: 0, max: 1 } },
        { name: 'param.create', args: { exportId: 'ParamNew', min: 0, max: 1 } },
      ]),
    );
    expect(e.code).toBe('E_DUPLICATE_ID');
    expect(e.at).toBe(1);
    expect(e.command).toBe('param.create');
    expect(e.fixes[0]).toMatchObject({ replace: { path: 'args.exportId', value: 'ParamNew_2' } });
    expect(s.doc).toBe(before);
  });

  it('dry runs report changes and lint, and commit nothing', () => {
    const s = fixtureSession();
    const rev = s.revision;
    const r = s.runBatch(
      't',
      [{ name: 'param.create', args: { exportId: 'ParamUnused', min: 0, max: 1 } }],
      { dryRun: true },
    );
    expect(r.committed).toBe(false);
    expect(r.changes.map((c) => c.change)).toContain('added');
    expect(r.lint?.some((l) => l.rule === 'unused-parameter')).toBe(true);
    expect(s.revision).toBe(rev);
    expect(s.query({ kind: 'parameter' }).total).toBe(2);
  });

  it('check the expected revision', () => {
    const s = fixtureSession();
    const e = error(() => s.run('param.create', { min: 0, max: 1 }, { expectRevision: 0 }));
    expect(e.code).toBe('E_REVISION_MISMATCH');
    expect(e.details?.since).toEqual([{ revision: 1, label: 'fixture', author: 'person' }]);
  });

  it('notify listeners with the author', () => {
    const s = fixtureSession();
    const events: string[] = [];
    s.onChange((e) => events.push(`${e.revision} ${e.author} ${e.label}`));
    s.run('param.create', { min: 0, max: 1 }, { author: 'agent:test' });
    s.undo();
    expect(events).toEqual(['2 agent:test param.create', '3 agent:test Undo param.create']);
  });

  it('reject unknown commands and bad arguments with paths', () => {
    const s = fixtureSession();
    expect(error(() => s.runBatch('t', [{ name: 'param.make', args: {} }])).code).toBe(
      'E_UNKNOWN_COMMAND',
    );
    const e = error(() =>
      s.runBatch('t', [{ name: 'param.create', args: { min: 'zero', max: 1 } }]),
    );
    expect(e.code).toBe('E_SCHEMA');
    expect(e.path).toBe('args.min');
  });
});

describe('parameters', () => {
  it('default keys come from min, default and max, rounded to float32', () => {
    const s = Session.create();
    const { uid } = s.run('param.create', { min: 0, max: 0.3 });
    const p = s.get(uid);
    expect(p.keys).toEqual([0, Math.fround(0.3)]);
    expect(p.default).toBe(0);
  });

  it('refuse to drop a key that a binding uses, with fixes that work', () => {
    const s = fixtureSession();
    const e = error(() => s.run('param.setKeys', { target: '@param:ParamAngleX', keys: [-30, 0] }));
    expect(e.code).toBe('E_KEY_IN_USE');
    const fix = e.fixes[0] as { command: string; args: Record<string, unknown> };
    s.runBatch('apply fix', [
      { name: fix.command, args: fix.args },
      { name: 'param.setKeys', args: { target: '@param:ParamAngleX', keys: [-30, 0] } },
    ]);
    expect((s.view.get('rot_0007') as Rotation).rig.bindings[0]!.keys).toEqual([-30, 0]);
  });

  it('delete with cascade unbinds and removes references', () => {
    const s = fixtureSession();
    expect(error(() => s.run('param.delete', { target: '@param:ParamEyeLOpen' })).code).toBe(
      'E_IN_USE',
    );
    s.run('param.delete', { target: '@param:ParamEyeLOpen', cascade: true });
    const eye = s.view.get('mesh_0010') as ArtMesh;
    expect(eye.rig.bindings).toEqual([]);
    expect(eye.rig.keyforms[0]!.opacity).toBe(1); // the slice at the default (1) is kept
    expect(s.view.project().standardGroups.eyeBlink).toEqual([]);
    expect(s.query({ kind: 'expression', fields: ['entries'] }).items[0]!.entries).toEqual([]);
    expect(s.validate().violations).toEqual([]);
  });
});

describe('rigs and keyforms', () => {
  it('keys must be on the parameter; the fix adds the key', () => {
    const s = fixtureSession();
    const e = error(() =>
      s.run('rig.addKey', {
        target: '@mesh:ArtMesh_EyeL',
        parameter: '@param:ParamEyeLOpen',
        key: 0.5,
      }),
    );
    expect(e.code).toBe('E_KEY_NOT_ON_PARAMETER');
    const fix = e.fixes[0] as { command: string; args: Record<string, unknown> };
    s.runBatch('fix', [
      { name: fix.command, args: fix.args },
      {
        name: 'rig.addKey',
        args: { target: '@mesh:ArtMesh_EyeL', parameter: '@param:ParamEyeLOpen', key: 0.5 },
      },
    ]);
    const eye = s.view.get('mesh_0010') as ArtMesh;
    expect(eye.rig.keyforms.map((k) => k.opacity)).toEqual([0, 0.5, 1]);
  });

  it('cells must name every binding with one of its keys', () => {
    const s = fixtureSession();
    const e = error(() =>
      s.run('keyform.set', {
        target: '@mesh:ArtMesh_EyeL',
        cell: { '@param:ParamEyeLOpen': 0.4 },
        values: { opacity: 1 },
      }),
    );
    expect(e.code).toBe('E_BAD_CELL');
    expect(e.fixes).toHaveLength(2);
    expect(
      error(() => s.run('keyform.set', { target: '@mesh:ArtMesh_EyeL', values: { opacity: 1 } }))
        .code,
    ).toBe('E_BAD_CELL');
    expect(
      error(() =>
        s.run('keyform.set', { target: '@mesh:ArtMesh_EyeL', all: true, values: { angle: 1 } }),
      ).code,
    ).toBe('E_FIELD_NOT_APPLICABLE');
    expect(
      error(() =>
        s.run('keyform.set', {
          target: '@mesh:ArtMesh_EyeL',
          all: true,
          values: { positions: [[0, 0]] },
        }),
      ).code,
    ).toBe('E_SHAPE');
  });

  it('sets positions, colors and mirror flags, rounded to float32', () => {
    const s = fixtureSession();
    s.run('keyform.set', {
      target: '@mesh:ArtMesh_Face',
      values: { positions: quad(0.1, 0, 1), multiply: [0.5, 1.5, 1] },
    });
    s.run('keyform.set', { target: '@rot:Rotation_Neck', all: true, values: { mirrorX: true } });
    const face = s.view.get('mesh_0009') as ArtMesh;
    expect(face.rig.keyforms[0]!.positions[0]).toBe(Math.fround(0.1));
    expect(face.rig.keyforms[0]!.multiply).toEqual([0.5, 1.5, 1]);
    expect((s.view.get('rot_0007') as Rotation).rig.keyforms.every((k) => k.mirrorX)).toBe(true);
  });

  it('binding twice is refused', () => {
    const s = fixtureSession();
    expect(
      error(() =>
        s.run('rig.addBinding', {
          target: '@mesh:ArtMesh_EyeL',
          parameter: '@param:ParamEyeLOpen',
        }),
      ).code,
    ).toBe('E_ALREADY_BOUND');
  });
});

describe('the part tree', () => {
  it('moves parts and meshes, and refuses cycles', () => {
    const s = fixtureSession();
    s.run('tree.move', { target: '@mesh:ArtMesh_Neck', parent: '@part:PartHead', index: 0 });
    expect((s.view.get('part_0005') as Part).children[0]).toBe('mesh_0011');
    expect(
      error(() => s.run('tree.move', { target: '@part:PartBody', parent: '@part:PartHead' })).code,
    ).toBe('E_CYCLE');
    s.run('tree.move', { target: '@part:PartHead', parent: null, index: 0 });
    expect(s.view.project().root).toEqual(['part_0005', 'part_0004']);
    expect(s.validate().violations).toEqual([]);
  });

  it('deletes a part with its contents and cleans every reference', () => {
    const s = fixtureSession();
    expect(error(() => s.run('part.delete', { target: '@part:PartHead' })).code).toBe('E_IN_USE');
    s.run('part.delete', { target: '@part:PartHead', cascade: true });
    expect(s.query({ kind: 'artMesh' }).items.map((m) => m.exportId)).toEqual(['ArtMesh_Neck']);
    expect(s.query({ kind: 'glue' }).total).toBe(0); // the glue lost its face mesh
    expect(s.view.project().hitAreas).toEqual([]);
    expect(s.query({ kind: 'rotation', fields: ['part'] }).items[0]!.part).toBe(null);
    expect(s.validate().violations).toEqual([]);
  });
});

describe('deformers', () => {
  it('keeps parents before children when reparenting', () => {
    const s = fixtureSession();
    const { uid } = s.run('deformer.createRotation', {
      exportId: 'Rotation_Body',
      origin: { x: 200, y: 500 },
    });
    s.run('deformer.setParent', { target: '@rot:Rotation_Neck', parent: uid });
    expect(s.view.project().deformerOrder).toEqual([uid, 'rot_0007', 'warp_0008']);
    expect(
      error(() => s.run('deformer.setParent', { target: uid, parent: '@warp:Warp_Face' })).code,
    ).toBe('E_CYCLE');
  });

  it('delete with cascade attaches children to the parent', () => {
    const s = fixtureSession();
    expect(error(() => s.run('deformer.delete', { target: '@warp:Warp_Face' })).code).toBe(
      'E_IN_USE',
    );
    s.run('deformer.delete', { target: '@warp:Warp_Face', cascade: true });
    expect((s.view.get('mesh_0010') as ArtMesh).deformer).toBe('rot_0007');
    expect(s.validate().violations).toEqual([]);
  });

  it('a warp inside a rotation needs a rect', () => {
    const s = fixtureSession();
    expect(
      error(() => s.run('deformer.createWarp', { parent: '@rot:Rotation_Neck', rows: 1, cols: 1 }))
        .code,
    ).toBe('E_RANGE');
  });
});

describe('meshes and glue', () => {
  it('check shapes', () => {
    const s = fixtureSession();
    expect(
      error(() => s.run('mesh.create', { uv: quad(0, 0, 1), triangles: [[0, 1, 4]] })).code,
    ).toBe('E_SHAPE');
    expect(
      error(() =>
        s.run('mesh.create', { uv: quad(0, 0, 1), positions: [[0, 0]], triangles: QUAD_TRIS }),
      ).code,
    ).toBe('E_SHAPE');
    expect(
      error(() =>
        s.run('glue.create', {
          meshA: '@mesh:ArtMesh_Face',
          meshB: '@mesh:ArtMesh_Neck',
          pairs: [[9, 0.5, 0, 0.5]],
        }),
      ).code,
    ).toBe('E_SHAPE');
  });

  it('default positions are the layer position plus uv', () => {
    const s = fixtureSession();
    const face = s.view.get('mesh_0009') as ArtMesh;
    expect([...face.rig.keyforms[0]!.positions.slice(0, 4)]).toEqual([100, 100, 300, 100]);
  });

  it('clipping masks are cleaned when a mask mesh is deleted', () => {
    const s = fixtureSession();
    s.run('mesh.delete', { target: '@mesh:ArtMesh_Face', cascade: true });
    expect((s.view.get('mesh_0010') as ArtMesh).clip).toBe(null);
  });
});

describe('motions', () => {
  it('validate segments', () => {
    const s = fixtureSession();
    const bad = (segments: number[]) =>
      error(() =>
        s.run('motion.setCurve', {
          target: '@motion~idle',
          curve: { target: 'parameter', object: '@param:ParamAngleX', segments },
        }),
      ).code;
    expect(bad([0, 0, 5, 1, 1])).toBe('E_SCHEMA');
    expect(bad([0, 0, 1, 1, 1, 2, 2])).toBe('E_SCHEMA');
    expect(bad([1, 0, 0, 0.5, 1])).toBe('E_SCHEMA');
    s.run('motion.setCurve', {
      target: '@motion~idle',
      curve: { target: 'model', model: 'EyeBlink', segments: [0, 1, 1, 0.3, 1, 0.6, 0, 1, 0] },
    });
    expect(s.query({ kind: 'motion' }).items[0]!.curveCount).toBe(2);
  });
});
