/**
 * The mesh tools in core: the brush's falloff, mesh.brushDeform, mesh.subdivide (the mesh
 * looks the same), mesh.fromStrokes (strips along strokes) and motion.markersToEvents.
 */
import { describe, expect, it } from 'vitest';
import { DocView, brushWeight } from '@mochi-maker/core';
import { strokeStrip, subdivide } from '@mochi-maker/geometry';
import { fixtureSession } from './fixture.js';

const mesh = (s: ReturnType<typeof fixtureSession>, ref: string) => {
  const v = new DocView(s.doc);
  return v.getAs(v.resolve(ref, ['artMesh']), 'artMesh');
};

describe('brush and mesh tools', () => {
  it('weighs 1 inside the hardness, falls smoothly to 0 at the edge, and follows angle and roundness', () => {
    const b = { radius: 10, hardness: 0.5 };
    expect(brushWeight(0, 0, b)).toBe(1);
    expect(brushWeight(5, 0, b)).toBe(1);
    expect(brushWeight(7.5, 0, b)).toBeCloseTo(0.5, 6);
    expect(brushWeight(10, 0, b)).toBe(0);
    const flat = { radius: 10, hardness: 1, roundness: 0.5 };
    expect(brushWeight(0, 6, flat)).toBe(0);
    expect(brushWeight(6, 0, flat)).toBe(1);
    expect(brushWeight(0, 6, { ...flat, angle: 90 })).toBe(1);
  });

  it('moves the vertices under the brush by their weight, in one keyform', () => {
    const s = fixtureSession();
    const before = Array.from(mesh(s, '@mesh:ArtMesh_Face').rig.keyforms[0]!.positions);
    const r = s.runBatch('Brush', [
      {
        name: 'mesh.brushDeform',
        args: {
          target: '@mesh:ArtMesh_Face',
          center: [before[0]!, before[1]!],
          radius: 20,
          hardness: 1,
          offset: [5, 0],
        },
      },
    ]);
    expect(r.results[0]).toEqual({ moved: 1 });
    const after = Array.from(mesh(s, '@mesh:ArtMesh_Face').rig.keyforms[0]!.positions);
    expect(after[0]).toBeCloseTo(before[0]! + 5, 4);
    expect(after.slice(2)).toEqual(before.slice(2));
  });

  it('splits every triangle into four, the mesh looking the same in every keyform', () => {
    const s = fixtureSession();
    const m0 = mesh(s, '@mesh:ArtMesh_EyeL');
    const r = s.runBatch('Split', [
      { name: 'mesh.subdivide', args: { target: '@mesh:ArtMesh_EyeL' } },
    ]);
    expect(r.results[0]).toMatchObject({ vertexCount: 9, triangleCount: 8 });
    const m1 = mesh(s, '@mesh:ArtMesh_EyeL');
    m1.rig.keyforms.forEach((k, i) => {
      const old = m0.rig.keyforms[i]!.positions;
      // The old vertices keep their places; a midpoint is halfway along its edge.
      expect(Array.from(k.positions.slice(0, 8))).toEqual(Array.from(old));
    });
    const g = subdivide([0, 0, 2, 0, 0, 2], [0, 1, 2]);
    expect(Array.from(g.points)).toEqual([0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1]);
    expect(g.triangles.length).toBe(12);
  });

  it('meshes strips along strokes, keeping the keyforms', () => {
    const strip = strokeStrip(
      [
        [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
      ],
      4,
      10,
    );
    expect(Array.from(strip.points)).toEqual([0, 2, 0, -2, 10, 2, 10, -2, 20, 2, 20, -2]);
    expect(strip.triangles.length).toBe(12);
    const s = fixtureSession();
    const r = s.runBatch('Strokes', [
      {
        name: 'mesh.fromStrokes',
        args: {
          target: '@mesh:ArtMesh_Face',
          strokes: [
            [
              [20, 20],
              [180, 180],
            ],
            [
              [20, 180],
              [60, 140],
            ],
          ],
          width: 20,
          spacing: 40,
        },
      },
    ]);
    expect(r.results[0]).toMatchObject({ vertexCount: 18, triangleCount: 14 });
    expect(() =>
      s.runBatch('None', [
        {
          name: 'mesh.fromStrokes',
          args: { target: '@mesh:ArtMesh_Face', strokes: [[[1, 1]]], width: 5 },
        },
      ]),
    ).toThrow(/no mesh/);
  });

  it('writes markers as events in one step, without doubles', () => {
    const s = fixtureSession();
    s.runBatch('M', [
      {
        name: 'motion.setMarkers',
        args: {
          target: '@motion~idle',
          markers: [
            { time: 1, name: 'b' },
            { time: 0.25, name: 'a' },
          ],
        },
      },
    ]);
    const r = s.runBatch('E', [
      { name: 'motion.markersToEvents', args: { target: '@motion~idle' } },
    ]);
    expect(r.results[0]).toEqual({ added: 2 });
    const again = s.runBatch('E', [
      { name: 'motion.markersToEvents', args: { target: '@motion~idle' } },
    ]);
    expect(again.results[0]).toEqual({ added: 0 });
    const v = new DocView(s.doc);
    const m = v.getAs(v.resolve('@motion~idle', ['motion']), 'motion');
    expect(m.events).toEqual([
      { time: 0.25, value: 'a' },
      { time: 1, value: 'b' },
    ]);
  });
});
