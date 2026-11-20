/**
 * Physics files in (`physics.import`), its round trip through our writer, and guide
 * images left out of the export unless the settings ask for them.
 */
import { describe, expect, it } from 'vitest';
import { Session, runItems, type Document } from '@mochi-maker/core';
import { OPERATIONS, exportModel } from '@mochi-maker/export';
import { GOLDENS, golden1, golden11 } from './golden.js';

const physicsOf = (files: Map<string, Uint8Array>) =>
  [...files].find(([p]) => p.endsWith('.physics3.json'))?.[1];

/** A copy of a document without its physics settings. */
function withoutPhysics(doc: Document): Session {
  const s = Session.open(doc);
  s.transact('no physics', (tx) => {
    for (const u of s.view.project().physicsOrder) tx.run('physics.removeSetting', { target: u });
    tx.run('physics.setFps', { fps: 0 });
  });
  return s;
}
const run = (
  s: Session,
  assets: Parameters<typeof exportModel>[1],
  args: unknown,
  dryRun = false,
) =>
  runItems({ session: s, assets }, 'Import physics', [{ name: 'physics.import', args }], {
    operations: OPERATIONS,
    dryRun,
  });

describe('physics.import', () => {
  it('round-trips every golden with physics: export, import into a copy without, export again', async () => {
    let checked = 0;
    for (const make of GOLDENS) {
      const g = await make();
      const first = physicsOf((await exportModel(g.session.doc, g.assets)).files);
      if (!first) continue;
      const copy = withoutPhysics(g.session.doc);
      expect(physicsOf((await exportModel(copy.doc, g.assets)).files)).toBeUndefined();
      const r = await run(copy, g.assets, { text: new TextDecoder().decode(first) });
      expect(r.itemResults[0]).toMatchObject({ replaced: [], unmatched: [] });
      const again = physicsOf((await exportModel(copy.doc, g.assets)).files)!;
      expect(new TextDecoder().decode(again), g.name).toBe(new TextDecoder().decode(first));
      expect(Buffer.from(again).equals(Buffer.from(first))).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('replaces settings of the same name, reports unmatched parameters, and dry runs', async () => {
    const g = await golden11();
    const file = JSON.parse(
      new TextDecoder().decode(physicsOf((await exportModel(g.session.doc, g.assets)).files)!),
    );
    // Another tool's file: the same setting, stronger, with an output to a parameter we lack.
    file.PhysicsSettings[0].Input[0].Weight = 80;
    file.PhysicsSettings[0].Output.push({
      ...file.PhysicsSettings[0].Output[0],
      Destination: { Target: 'Parameter', Id: 'ParamNope' },
    });
    file.Meta.TotalOutputCount += 1;
    const text = JSON.stringify(file);
    const before = g.session.revision;
    const dry = await run(g.session, g.assets, { text }, true);
    expect(dry.itemResults[0]).toMatchObject({
      added: [],
      replaced: ['Swing'],
      unmatched: [{ setting: 'Swing', kind: 'output', parameter: 'ParamNope' }],
    });
    expect(g.session.revision).toBe(before);
    await run(g.session, g.assets, { text });
    const settings = g.session.view.ofKind('physicsSetting');
    expect(settings).toHaveLength(1);
    expect(settings[0]!.inputs[0]!.weight).toBe(80);
    expect(settings[0]!.outputs).toHaveLength(1);
    g.session.undo();
    expect(g.session.view.ofKind('physicsSetting')[0]!.inputs[0]!.weight).toBe(100);
    await expect(run(g.session, g.assets, { text: '{"no":1}' })).rejects.toThrow(
      /Not a physics file/,
    );
  });
});

describe('guide images in the export', () => {
  it('are left out, with everything in them, unless the settings include them', async () => {
    const g = await golden1();
    g.session.transact('guide', (tx) => {
      tx.run('part.create', { exportId: 'Guide', guide: true });
      tx.run('mesh.create', {
        exportId: 'ArtMesh_Guide',
        part: '@part:Guide',
        layer: g.session.view.ofKind('layer')[0]!.uid,
        uv: [
          [0, 0],
          [10, 0],
          [0, 10],
        ],
        positions: [
          [0, 0],
          [10, 0],
          [0, 10],
        ],
        triangles: [[0, 1, 2]],
      });
      // A mesh of the model clipped by the guide mesh: the clip goes with it.
      tx.run('mesh.setClip', { target: '@mesh:ArtMesh_Square', masks: ['@mesh:ArtMesh_Guide'] });
    });
    const off = await exportModel(g.session.doc, g.assets);
    expect(off.report.counts.artMeshes).toBe(1);
    expect(Object.values(off.report.ids.parts)).not.toContain('Guide');
    g.session.transact('include', (tx) =>
      tx.run('project.setExportSettings', { includeGuideImages: true }),
    );
    const on = await exportModel(g.session.doc, g.assets);
    expect(on.report.counts.artMeshes).toBe(2);
    expect(Object.values(on.report.ids.parts)).toContain('Guide');
  });
});
