/**
 * Find and replace: plain text and patterns, the preview and its problems, one
 * undoable step, and references that stay attached (they are UIDs).
 */
import { describe, expect, it } from 'vitest';
import { DocView, canonicalText, planReplace } from '@mochi-maker/core';
import { fixtureSession } from './fixture.js';

const ids = (s: ReturnType<typeof fixtureSession>, kind: string) =>
  s.query({ kind: kind as never }).items.map((o) => (o as { exportId: string }).exportId);

describe('find and replace', () => {
  it('previews every change in IDs and names, of the four groups only', () => {
    const s = fixtureSession();
    const { changes, problems } = planReplace(new DocView(s.doc), {
      find: 'Face',
      replace: 'Head',
    });
    expect(problems).toEqual([]);
    // GroupFace (a parameter group) is not in the four groups.
    expect(changes.map((c) => `${c.kind}.${c.field}: ${c.from} → ${c.to}`)).toEqual(
      expect.arrayContaining([
        'warp.exportId: Warp_Face → Warp_Head',
        'artMesh.exportId: ArtMesh_Face → ArtMesh_Head',
      ]),
    );
    expect(changes.some((c) => c.from === 'GroupFace')).toBe(false);
    // Limited to names, or to a kind.
    const names = planReplace(new DocView(s.doc), {
      find: 'Face',
      replace: 'Head',
      fields: ['name'],
    });
    expect(names.changes.every((c) => c.field === 'name')).toBe(true);
    const meshes = planReplace(new DocView(s.doc), {
      find: 'Face',
      replace: 'X',
      kinds: ['artMesh'],
    });
    expect(new Set(meshes.changes.map((c) => c.kind))).toEqual(new Set(['artMesh']));
  });

  it('applies in one step, refuses a result with duplicate or invalid IDs, and keeps references', () => {
    const s = fixtureSession();
    const before = canonicalText(s.doc);
    const rigOf = (ref: string) => {
      const v = new DocView(s.doc);
      return JSON.stringify((v.get(v.resolve(ref, ['artMesh'])) as { rig: unknown }).rig);
    };
    const rig = rigOf('@mesh:ArtMesh_Face');
    // ArtMesh_Face → ArtMesh_EyeL is taken: refused, nothing changes.
    expect(() =>
      s.runBatch('r', [
        {
          name: 'objects.replaceText',
          args: { find: 'Face', replace: 'EyeL', kinds: ['artMesh'] },
        },
      ]),
    ).toThrow(/would also be the export ID/);
    expect(() =>
      s.runBatch('r', [
        { name: 'objects.replaceText', args: { find: 'Param', replace: 'Param-' } },
      ]),
    ).toThrow(/not a valid export ID/);
    expect(() =>
      s.runBatch('r', [
        { name: 'objects.replaceText', args: { find: '(', replace: 'x', pattern: true } },
      ]),
    ).toThrow(/not a valid pattern/);
    expect(canonicalText(s.doc)).toBe(before);
    // Swapping two IDs with a pattern works: the result is checked as a whole.
    const r = s.runBatch('Swap', [
      {
        name: 'objects.replaceText',
        args: {
          find: '^ArtMesh_(Face|EyeL)$',
          replace: 'ArtMesh_X$1',
          pattern: true,
          fields: ['exportId'],
        },
      },
    ]);
    expect((r.results[0] as { changes: unknown[] }).changes).toHaveLength(2);
    expect(ids(s, 'artMesh')).toEqual(expect.arrayContaining(['ArtMesh_XFace', 'ArtMesh_XEyeL']));
    // Plain text: $ is literal; case-insensitive on request.
    s.runBatch('Lit', [
      {
        name: 'objects.replaceText',
        args: { find: 'angle', replace: '$Angle', ignoreCase: true, fields: ['name'] },
      },
    ]);
    const angle = s
      .query({ kind: 'parameter' })
      .items.find((o) => (o as { exportId: string }).exportId === 'ParamAngleX') as {
      name: string;
    };
    expect(angle.name).toContain('$Angle');
    // The references are UIDs: the mesh's bindings are the same.
    expect(rigOf('@mesh:ArtMesh_XFace')).toBe(rig);
    // One undo per replace.
    s.undo();
    s.undo();
    expect(canonicalText(s.doc)).toBe(before);
  });
});
