/**
 * Re-import with change mapping (design 6): a PSD edited after import — pixels changed,
 * a layer moved, a layer grown, a layer added, a layer removed.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryAssetStore,
  MemoryFileSystem,
  Session,
  documentHash,
  runItems,
  type ArtMesh,
  type Layer,
} from '@mochi-maker/core';
import { ART_OPERATIONS, decodePng, type ReimportResult } from '@mochi-maker/art';
import { reimportPsd } from './synthetic.js';

const PATH = 'art/character.psd';

async function imported() {
  const session = Session.create({ width: 200, height: 150 });
  const assets = new MemoryAssetStore();
  const fs = new MemoryFileSystem();
  const ctx = { session, assets, fs };
  await fs.writeBytes(PATH, reimportPsd(1));
  await runItems(ctx, 'Import', [{ name: 'art.import', args: { path: PATH } }], {
    operations: ART_OPERATIONS,
  });
  await fs.writeBytes(PATH, reimportPsd(2));
  const reimport = (dryRun = false) =>
    runItems(ctx, 'Re-import', [{ name: 'art.reimport', args: { path: PATH } }], {
      operations: ART_OPERATIONS,
      dryRun,
    });
  const layer = (name: string) =>
    session.view.ofKind('layer').find((l) => l.name === name) as Layer;
  const meshOf = (name: string) =>
    session.view.ofKind('artMesh').find((m) => m.layer === layer(name).uid) as ArtMesh;
  return { session, assets, fs, reimport, layer, meshOf };
}

describe('art.reimport', () => {
  it('reports without changing anything on a dry run', async () => {
    const p = await imported();
    const hash = documentHash(p.session.doc);
    const rev = p.session.revision;
    const r = await p.reimport(true);
    expect(r.committed).toBe(false);
    expect(p.session.revision).toBe(rev);
    expect(documentHash(p.session.doc)).toBe(hash);
    const report = r.itemResults[0] as ReimportResult;
    expect(report.changed.map((c) => c.name).sort()).toEqual(['Body', 'Eye', 'Face']);
    expect(report.added.map((a) => a.path)).toEqual(['Head/Mouth']);
    expect(report.removed.map((a) => a.name)).toEqual(['目']);
  });

  it('replaces pixels, keeps meshes in place, remaps UVs, and flags what needs re-fitting', async () => {
    const p = await imported();
    const before = {
      body: p.meshOf('Body'),
      face: p.meshOf('Face'),
      eye: p.meshOf('Eye'),
      me: p.meshOf('目'),
      faceLayer: p.layer('Face'),
      bodyLayer: p.layer('Body'),
    };
    const rev = p.session.revision;
    const objects = p.session.doc.objects;
    const r = await p.reimport();
    expect(r.committed).toBe(true);
    expect(p.session.revision).toBe(rev + 1); // one transaction
    const report = r.itemResults[0] as ReimportResult;

    // Body: new pixels, same bounds and shape; its mesh is untouched and needs no re-fit.
    const body = report.changed.find((c) => c.name === 'Body')!;
    expect(body).toMatchObject({ boundsChanged: false, shapeChange: 0 });
    expect(p.layer('Body').asset).not.toBe(before.bodyLayer.asset);
    const px = decodePng(await p.assets.get(p.layer('Body').asset), 'body');
    expect(
      Array.from(px.data.subarray(4 * (10 * px.width + 10), 4 * (10 * px.width + 10) + 4)),
    ).toEqual([60, 160, 90, 255]);
    expect(p.meshOf('Body')).toEqual(before.body);

    // Face moved 15 px right: positions stay, UVs shift by −15, so the mesh shows the same canvas
    // pixels, and the art now lies partly outside it: re-fit.
    const face = p.meshOf('Face');
    expect(p.layer('Face').x).toBe(before.faceLayer.x + 15);
    expect(face.rig.keyforms).toEqual(before.face.rig.keyforms);
    expect(Array.from(face.uv).filter((_, i) => i % 2 === 0)).toEqual(
      Array.from(before.face.uv)
        .filter((_, i) => i % 2 === 0)
        .map((u) => Math.fround(u - 15)),
    );
    expect(Array.from(face.uv).filter((_, i) => i % 2 === 1)).toEqual(
      Array.from(before.face.uv).filter((_, i) => i % 2 === 1),
    );
    const refit = new Map(report.refit.map((x) => [x.mesh, x]));
    expect(refit.get(face.uid)?.reasons).toContain('art outside the mesh');
    expect(refit.get(face.uid)!.uncovered).toBeGreaterThan(0.05);
    // Eye grew: flagged as well.
    expect(refit.get(p.meshOf('Eye').uid)?.reasons).toContain('art outside the mesh');
    expect(report.changed.find((c) => c.name === 'Eye')).toMatchObject({ boundsChanged: true });
    expect(refit.has(before.body.uid)).toBe(false);

    // Mouth is new: a layer with its source, not meshed.
    const mouth = p.layer('Mouth');
    expect(mouth.source).toBe(`${PATH}#Head/Mouth`);
    expect(p.session.view.ofKind('artMesh').some((m) => m.layer === mouth.uid)).toBe(false);
    expect(report.added).toEqual([{ layer: mouth.uid, name: 'Mouth', path: 'Head/Mouth' }]);

    // 目 is gone from the file: its layer and mesh stay, flagged.
    expect(p.meshOf('目')).toEqual(before.me);
    expect(p.layer('目').notes).toContain(`missing from ${PATH} at re-import`);
    expect(report.removed).toEqual([
      { layer: p.layer('目').uid, name: '目', meshes: [before.me.uid] },
    ]);

    // Undo takes back the whole re-import (the UID counter stays, so UIDs are never reused).
    p.session.undo();
    expect(p.session.doc.objects).toEqual(objects);
  });

  it('is idempotent: re-importing the same file again changes nothing', async () => {
    const p = await imported();
    await p.reimport();
    const hash = documentHash(p.session.doc);
    const r = await p.reimport();
    const report = r.itemResults[0] as ReimportResult;
    expect(report.changed).toEqual([]);
    expect(report.added).toEqual([]);
    expect(report.unchanged).toBe(4);
    expect(documentHash(p.session.doc)).toBe(hash);
  });

  it('matches by name when a layer moved to another group, and when the file moved', async () => {
    const p = await imported();
    // The same art under another file name: every imported layer is a candidate.
    await p.fs.writeBytes('elsewhere/character-v2.psd', reimportPsd(1));
    const r = await runItems(
      { session: p.session, assets: p.assets, fs: p.fs },
      'Re-import',
      [{ name: 'art.reimport', args: { path: 'elsewhere/character-v2.psd' } }],
      { operations: ART_OPERATIONS },
    );
    const report = r.itemResults[0] as ReimportResult;
    expect(report.notes[0]).toContain('matching against every imported layer');
    expect(report.unchanged).toBe(4);
    expect(p.layer('Face').source).toBe('elsewhere/character-v2.psd#Head/Face');
  });
});
