/**
 * Model templates: a template exported from golden 15 (nested warps and rotations) and
 * applied to golden 15's art without any rig evaluates like the golden at every pose tried;
 * matching by name and by shape; the merge and add choices for parameters and physics (golden
 * 11); the file round trip; corrections by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  DocView,
  MemoryAssetStore,
  Session,
  runItems,
  type Uid,
} from '@mochi-maker/core';
import {
  OPERATIONS,
  exportModel,
  exportTemplate,
  matchTemplate,
  readTemplate,
  retargetMotion,
  templateZip,
  type TemplateApplyResult,
} from '@mochi-maker/export';
import { golden11, golden15, golden17, type Golden } from './golden.js';
import { evaluate } from './probe.js';

/** An empty project with the golden's canvas. */
function artOnly(g: Golden): Session {
  const c = new DocView(g.session.doc).project().canvas;
  return Session.create({
    width: c.width,
    height: c.height,
    pixelsPerUnit: c.pixelsPerUnit,
    originX: c.originX,
    originY: c.originY,
  });
}

/** The golden's art only: its layers and meshes where they are drawn at rest, without any rig. */
async function target(g: Golden, rename: (id: string) => string = (x) => x) {
  const v = new DocView(g.session.doc);
  const s = artOnly(g);
  const stem = v.project().exportSettings.fileStem;
  const rest = evaluate(await exportModel(g.session.doc, g.assets), stem);
  const c = v.project().canvas;
  const calls: { name: string; args: unknown }[] = [
    { name: 'project.setExportSettings', args: { fileStem: 'target' } },
    { name: 'part.create', args: { exportId: 'PartArt', name: 'Art' } },
  ];
  const layerRef = new Map<Uid, string>();
  for (const l of v.ofKind('layer')) {
    layerRef.set(l.uid, `$${calls.length}`);
    calls.push({
      name: 'layer.create',
      args: { name: l.name, asset: l.asset, x: l.x, y: l.y, width: l.width, height: l.height },
    });
  }
  for (const m of v.ofKind('artMesh')) {
    const d = rest.get(m.exportId)!;
    const positions: [number, number][] = [];
    for (let i = 0; i < d.vertices.length; i += 2)
      positions.push([
        d.vertices[i]! * c.pixelsPerUnit + c.originX,
        -d.vertices[i + 1]! * c.pixelsPerUnit + c.originY,
      ]);
    const uv: [number, number][] = [];
    for (let i = 0; i < m.uv.length; i += 2) uv.push([m.uv[i]!, m.uv[i + 1]!]);
    const triangles: [number, number, number][] = [];
    for (let i = 0; i < m.triangles.length; i += 3)
      triangles.push([m.triangles[i]!, m.triangles[i + 1]!, m.triangles[i + 2]!]);
    calls.push({
      name: 'mesh.create',
      args: {
        exportId: rename(m.exportId),
        name: rename(m.name),
        part: '$1',
        layer: m.layer ? layerRef.get(m.layer) : undefined,
        uv,
        triangles,
        positions,
      },
    });
  }
  s.runBatch('art', calls);
  return { session: s, assets: g.assets };
}

/** Runs modelTemplate.apply on a session (the operation, as agents run it). */
async function apply(
  t: { session: Session; assets: MemoryAssetStore },
  files: Map<string, Uint8Array>,
  args: Record<string, unknown> = {},
): Promise<TemplateApplyResult> {
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const r = await runItems(
    { session: t.session, assets: t.assets },
    'Apply template',
    [
      {
        name: 'modelTemplate.apply',
        args: { files: Object.fromEntries([...files].map(([p, b]) => [p, b64(b)])), ...args },
      },
    ],
    { operations: OPERATIONS },
  );
  return r.itemResults[0] as TemplateApplyResult;
}

const close = (a: number[], b: number[], tol: number) => {
  expect(a.length).toBe(b.length);
  let worst = 0;
  a.forEach((x, i) => (worst = Math.max(worst, Math.abs(x - b[i]!))));
  expect(worst).toBeLessThan(tol);
};

describe('model templates', () => {
  it('names its operation apart from every command (animation templates have template.apply)', () => {
    for (const op of OPERATIONS) expect(COMMANDS.has(op.name), op.name).toBe(false);
  });

  it('round-trips a template file with its name, description, author and thumbnail', async () => {
    const g = await golden15();
    const files = await exportTemplate(g.session.doc, g.assets, {
      name: 'Nested',
      description: 'Warps in rotations',
      author: 'Mochi Maker tests',
      thumbnail: new Uint8Array([137, 80, 78, 71]),
    });
    const t = await readTemplate(templateZip(files));
    expect(t.meta).toMatchObject({
      format: 'mochi-maker-template',
      name: 'Nested',
      author: 'Mochi Maker tests',
      includes: { physics: true },
      counts: { meshes: 4, deformers: 5, parameters: 2 },
    });
    expect(t.thumbnail).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(new DocView(t.doc).ofKind('artMesh').length).toBe(4);
  });

  it('applied to the art of another project, evaluates like the template at every pose', async () => {
    const g = await golden15();
    const files = await exportTemplate(g.session.doc, g.assets, { name: 'Nested' });
    const t = await target(g);
    t.session.runBatch('empty', [{ name: 'part.create', args: { exportId: 'PartEmpty' } }]);
    const r = await apply(t, files);
    expect(r.pairs.map((p) => p.by)).toEqual(['name', 'name', 'name', 'name']);
    expect(r.unmatched).toEqual([]);
    expect(r.parameters.added.sort()).toEqual(['ParamAngle', 'ParamBend']);
    expect(r.deformers).toHaveLength(5);
    const a = await exportModel(g.session.doc, g.assets);
    const b = await exportModel(t.session.doc, t.assets);
    const poses: Record<string, number>[] = [
      {},
      { ParamAngle: 30 },
      { ParamAngle: -17, ParamBend: 1 },
      { ParamBend: 0.4, ParamAngle: 12 },
    ];
    for (const pose of poses) {
      const ea = evaluate(a, 'golden15', pose);
      const eb = evaluate(b, 'target', pose);
      for (const [id, d] of ea) close(eb.get(id)!.vertices, d.vertices, 2e-4);
    }
    // The template's parts (on by default): every target sits in its template mesh's part, in
    // the template's order.
    expect(r.parts.added.length).toBeGreaterThan(0);
    const TV = new DocView(g.session.doc);
    const DV = new DocView(t.session.doc);
    const partId = (v: DocView, m: { part: Uid | null }) =>
      m.part ? v.getAs(m.part, 'part').exportId : null;
    for (const p of r.pairs) {
      const tm = TV.ofKind('artMesh').find((x) => x.exportId === p.template)!;
      expect(partId(DV, DV.getAs(p.target, 'artMesh'))).toBe(partId(TV, tm));
    }
    expect(r.parameterIds).toEqual({ ParamBend: 'ParamBend', ParamAngle: 'ParamAngle' });
    // The art's own part, emptied by applying, is gone; a part that was empty before stays.
    expect(r.parts.removed).toEqual(['PartArt']);
    expect(DV.ofKind('part').some((x) => x.exportId === 'PartArt')).toBe(false);
    expect(DV.ofKind('part').some((x) => x.exportId === 'PartEmpty')).toBe(true);
    // One transaction: one undo takes it all back.
    t.session.undo();
    expect(new DocView(t.session.doc).ofKind(['warp', 'rotation'])).toHaveLength(0);
  });

  it('retargets a motion by parameter ID, leaving out curves that did not come along', () => {
    const motion = {
      Version: 3,
      Meta: { CurveCount: 3, TotalSegmentCount: 3, TotalPointCount: 4 },
      Curves: [
        { Target: 'Parameter', Id: 'ParamA', Segments: [0, 0, 0, 1, 1] },
        { Target: 'Parameter', Id: 'ParamGone', Segments: [0, 0, 0, 1, 1] },
        { Target: 'PartOpacity', Id: 'PartX', Segments: [0, 1, 0, 1, 0] },
      ],
    };
    const r = retargetMotion(motion, { ParamA: 'ParamA_2' });
    expect(r.motion.Curves.map((c) => c.Id)).toEqual(['ParamA_2', 'PartX']);
    expect(r.dropped).toEqual(['ParamGone']);
    expect(r.motion.Meta).toMatchObject({
      CurveCount: 2,
      TotalSegmentCount: 2,
      TotalPointCount: 4,
    });
  });

  it('keeps the target’s part tree when asked', async () => {
    const g = await golden15();
    const files = await exportTemplate(g.session.doc, g.assets, { name: 'Nested' });
    const t = await target(g);
    const r = await apply(t, files, { options: { parts: false } });
    expect(r.parts).toEqual({ merged: [], added: [], removed: [] });
    const DV = new DocView(t.session.doc);
    expect(DV.ofKind('part').map((p) => p.exportId)).toEqual(['PartArt']);
    expect(
      DV.ofKind('artMesh').every((m) => DV.getAs(m.part!, 'part').exportId === 'PartArt'),
    ).toBe(true);
  });

  it('matches by shape when names differ, and takes corrections by hand', async () => {
    const g = await golden15();
    const t = await target(g, (id) => `Piece_${id.length}${id.slice(-2)}`);
    const T = new DocView(g.session.doc);
    const D = new DocView(t.session.doc);
    const targets = D.ofKind('artMesh').map((m) => m.uid);
    const m = matchTemplate(T, D, targets, { scale: 1, x: 0, y: 0 });
    expect(m.pairs.every((p) => p.by === 'shape')).toBe(true);
    // Each target is paired with the template mesh it was made from (same order).
    const tm = T.ofKind('artMesh');
    expect(
      m.pairs.map((p) => [
        D.getAs(p.target, 'artMesh').name,
        T.getAs(p.template, 'artMesh').exportId,
      ]),
    ).toEqual(
      expect.arrayContaining(
        tm.map((x) => [`Piece_${x.name.length}${x.name.slice(-2)}`, x.exportId]),
      ),
    );
    // By hand: a target left out, another paired explicitly.
    const files = await exportTemplate(g.session.doc, g.assets, { name: 'Nested' });
    const first = D.ofKind('artMesh')[0]!;
    const r = await apply(t, files, {
      pairs: [
        { target: first.uid, template: null },
        { target: D.ofKind('artMesh')[1]!.uid, template: tm[1]!.exportId },
      ],
    });
    expect(r.pairs).toHaveLength(3);
    expect(r.pairs.find((p) => p.target === D.ofKind('artMesh')[1]!.uid)).toMatchObject({
      template: tm[1]!.exportId,
      by: 'hand',
    });
    expect(r.unmatched).toEqual([first.uid]);
  });

  it('merges or adds parameters and physics that already exist', async () => {
    const g = await golden11();
    const files = await exportTemplate(g.session.doc, g.assets, { name: 'Swing' });
    // A target that already has ParamIn (another range) and a physics setting called Swing.
    const prepared = async () => {
      const t = await target(g);
      t.session.runBatch('existing', [
        { name: 'param.create', args: { exportId: 'ParamIn', min: -5, max: 5, keys: [-5, 0, 5] } },
        { name: 'param.create', args: { exportId: 'ParamOut', min: -30, max: 30 } },
        {
          name: 'physics.addSetting',
          args: {
            name: 'Swing',
            inputs: [{ parameter: '@param:ParamIn', weight: 100, type: 'X', reflect: false }],
            outputs: [
              {
                parameter: '@param:ParamOut',
                weight: 100,
                type: 'Angle',
                reflect: false,
                particle: 1,
                scale: 1,
              },
            ],
            particles: [
              { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
              { x: 0, y: 10, mobility: 0.9, delay: 0.9, acceleration: 1.5, radius: 10 },
            ],
            normalization: {
              position: { min: -10, default: 0, max: 10 },
              angle: { min: -10, default: 0, max: 10 },
            },
          },
        },
      ]);
      return t;
    };
    const merged = await prepared();
    const r1 = await apply(merged, files);
    expect(r1.parameters.merged).toEqual(expect.arrayContaining(['ParamIn', 'ParamOut']));
    expect(r1.physics).toEqual({ replaced: ['Swing'], added: [] });
    const v1 = new DocView(merged.session.doc);
    // The target's own ParamIn stays (its range too); it gains the keys the template uses.
    const pin = v1.ofKind('parameter').filter((p) => p.exportId.startsWith('ParamIn'));
    expect(pin).toHaveLength(1);
    expect([pin[0]!.min, pin[0]!.max]).toEqual([-5, 5]);
    expect(v1.ofKind('physicsSetting')).toHaveLength(1);
    const added = await prepared();
    const r2 = await apply(added, files, { options: { parameters: 'add', physics: 'add' } });
    expect(r2.parameters.added).toEqual(expect.arrayContaining(['ParamIn_2', 'ParamOut_2']));
    expect(r2.physics).toEqual({ replaced: [], added: ['Swing 2'] });
    const v2 = new DocView(added.session.doc);
    expect(v2.ofKind('physicsSetting').map((s) => s.name)).toEqual(['Swing', 'Swing 2']);
    // The added setting reads the added parameters.
    const s2 = v2.ofKind('physicsSetting')[1]!;
    expect(v2.getAs(s2.inputs[0]!.parameter, 'parameter').exportId).toBe('ParamIn_2');
    // Without physics: none.
    const none = await prepared();
    const r3 = await apply(none, files, { options: { physics: 'none' } });
    expect(r3.physics).toEqual({ replaced: [], added: [] });
  });

  it('carries motion-sync settings, merged or added by name', async () => {
    const g = await golden17();
    const files = await exportTemplate(g.session.doc, g.assets, { name: 'Talk' });
    const fresh = await target(g);
    const r = await apply(fresh, files);
    expect(r.motionSync).toEqual({ replaced: [], added: ['Mouth', 'Soft'] });
    // The result's motion-sync file is the golden's, byte for byte.
    const a = await exportModel(g.session.doc, g.assets);
    const b = await exportModel(fresh.session.doc, fresh.assets);
    expect(new TextDecoder().decode(b.files.get('target.motionsync3.json')!)).toBe(
      new TextDecoder().decode(a.files.get('golden17.motionsync3.json')!),
    );
    // A target that already has «Mouth»: merge replaces it, add makes «Mouth 2».
    const withMouth = async () => {
      const t = await target(g);
      t.session.runBatch('mouth', [{ name: 'motionSync.addSetting', args: { name: 'Mouth' } }]);
      return t;
    };
    const m = await withMouth();
    expect((await apply(m, files)).motionSync).toEqual({ replaced: ['Mouth'], added: ['Soft'] });
    expect(new DocView(m.session.doc).ofKind('motionSyncSetting')).toHaveLength(2);
    const ad = await withMouth();
    const r2 = await apply(ad, files, { options: { motionSync: 'add' } });
    expect(r2.motionSync).toEqual({ replaced: [], added: ['Mouth 2', 'Soft'] });
    const none = await withMouth();
    const r3 = await apply(none, files, { options: { motionSync: 'none' } });
    expect(r3.motionSync).toEqual({ replaced: [], added: [] });
    // A template made without them carries none.
    const without = await exportTemplate(g.session.doc, g.assets, { name: 'T', motionSync: false });
    const r4 = await apply(await target(g), without);
    expect(r4.motionSync).toEqual({ replaced: [], added: [] });
  });
});
