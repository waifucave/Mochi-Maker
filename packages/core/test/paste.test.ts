/** Copy and paste of objects: within a project and into another one. */
import { describe, expect, it } from 'vitest';
import { Session, copyFragment, type ArtMesh, type Rotation, type Warp } from '../src/index.js';
import { fixtureSession } from './fixture.js';

const ref = (s: Session, r: string) =>
  s.view.resolve(r, ['artMesh', 'warp', 'rotation', 'part', 'parameter'], 'x');

describe('copy and paste', () => {
  it('pastes a deformer with everything below it, rebound to the copies, in one step', () => {
    const s = fixtureSession();
    const f = copyFragment(s.view, [ref(s, '@rot:Rotation_Neck')]);
    expect(f.roots).toHaveLength(1);
    const kinds = f.objects.map((o) => (o as { kind: string }).kind);
    expect(kinds.filter((k) => k === 'warp' || k === 'rotation')).toHaveLength(2);
    const before = s.view.ofKind('artMesh').length;
    const r = s.transact('paste', (tx) =>
      tx.run('objects.paste', { fragment: f, part: '@part:PartBody' }),
    ).results[0] as { roots: string[]; created: number; unbound: unknown[] };
    expect(r.unbound).toEqual([]);
    const rot = s.view.getAs(r.roots[0]!, 'rotation') as Rotation;
    expect(rot.exportId).toBe('Rotation_Neck_2');
    expect(rot.rig.bindings[0]!.parameter).toBe(ref(s, '@param:ParamAngleX'));
    // The warp inside follows the copy, and so do the meshes in it and the eye's mask.
    const warp = s.view.ofKind('warp').find((w) => w.parent === rot.uid) as Warp;
    expect(warp.exportId).toBe('Warp_Face_2');
    const meshes = s.view.ofKind('artMesh').filter((m) => m.deformer === warp.uid);
    expect(meshes.map((m) => m.exportId)).toEqual(['ArtMesh_EyeL_2']);
    // The eye's mask, the face, was not copied but is here: the copy keeps it.
    expect(meshes[0]!.clip?.masks).toEqual([ref(s, '@mesh:ArtMesh_Face')]);
    // The copy at the top goes into the given part; the ones below keep theirs.
    expect(rot.part).toBe(ref(s, '@part:PartBody'));
    expect(meshes[0]!.part).toBe(
      ref(s, '@mesh:ArtMesh_EyeL') && s.view.getAs(ref(s, '@mesh:ArtMesh_EyeL'), 'artMesh').part,
    );
    expect(s.view.ofKind('artMesh').length).toBe(before + meshes.length);
    s.undo();
    expect(s.view.ofKind('artMesh').length).toBe(before);
  });

  it('pastes into another project: parameters by ID, the rest reported', () => {
    const src = fixtureSession();
    const f = copyFragment(src.view, [ref(src, '@mesh:ArtMesh_EyeL')]);
    const dst = Session.create({ width: 400, height: 400 });
    dst.transact('setup', (tx) => {
      tx.run('param.create', {
        exportId: 'ParamEyeLOpen',
        min: 0,
        max: 1,
        default: 1,
        keys: [0, 1],
      });
      tx.run('part.create', { exportId: 'P' });
    });
    const r = dst.transact('paste', (tx) =>
      tx.run('objects.paste', { fragment: f, part: '@part:P' }),
    ).results[0] as { roots: string[]; unbound: { what: string; ref: string }[] };
    const eye = dst.view.getAs(r.roots[0]!, 'artMesh') as ArtMesh;
    expect(eye.exportId).toBe('ArtMesh_EyeL');
    expect(eye.rig.bindings[0]!.parameter).toBe(dst.view.ofKind('parameter')[0]!.uid);
    // Its deformer and its mask are not in this project.
    expect(eye.deformer).toBe(null);
    expect(eye.clip).toBe(null);
    expect(r.unbound.map((u) => u.what).sort()).toEqual(['deformer', 'mask']);
    // A project without the parameter: the binding goes, keeping the forms at its default (1).
    const bare = Session.create({ width: 400, height: 400 });
    const r2 = bare.transact('paste', (tx) => tx.run('objects.paste', { fragment: f }))
      .results[0] as {
      roots: string[];
      unbound: { what: string; ref: string }[];
    };
    const eye2 = bare.view.getAs(r2.roots[0]!, 'artMesh') as ArtMesh;
    expect(eye2.rig.bindings).toEqual([]);
    const srcEye = src.view.getAs(ref(src, '@mesh:ArtMesh_EyeL'), 'artMesh') as ArtMesh;
    expect(eye2.rig.keyforms[0]!.opacity).toBe(srcEye.rig.keyforms[1]!.opacity);
    expect(r2.unbound).toContainEqual(
      expect.objectContaining({ what: 'parameter', ref: 'ParamEyeLOpen' }),
    );
    // Not a fragment: refused.
    expect(() =>
      bare.transact('x', (tx) =>
        tx.run('objects.paste', { fragment: { format: 'other' } as never }),
      ),
    ).toThrow();
  });
});
