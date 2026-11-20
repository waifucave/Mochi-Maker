import { describe, expect, it } from 'vitest';
import {
  MANIFEST,
  MemoryAssetStore,
  MemoryFileSystem,
  MochiError,
  canonicalText,
  decodeBundle,
  loadProject,
  readBundle,
  saveProject,
  type Migration,
} from '@mochi-maker/core';
import { ASSET, fixtureSession } from './fixture.js';

async function saved() {
  const s = fixtureSession();
  const fs = new MemoryFileSystem();
  const assets = new MemoryAssetStore();
  assets.blobs.set(ASSET, new Uint8Array([1, 2, 3]));
  await saveProject(fs, 'p.mochi', s.doc, assets);
  return { s, fs, assets };
}

async function loadError(fs: MemoryFileSystem, options = {}): Promise<MochiError> {
  try {
    await loadProject(fs, 'p.mochi', options);
  } catch (e) {
    return e as MochiError;
  }
  throw new Error('expected an error');
}

describe('project folder', () => {
  it('has the documented layout', async () => {
    const { fs } = await saved();
    expect([...fs.files.keys()].sort()).toEqual([
      `p.mochi/assets/sha256-${ASSET}.png`,
      'p.mochi/deformers/rot_0007.json',
      'p.mochi/deformers/warp_0008.json',
      'p.mochi/expressions/expr_0013.json',
      'p.mochi/glues.json',
      'p.mochi/layers.json',
      'p.mochi/meshes/mesh_0009.json',
      'p.mochi/meshes/mesh_0010.json',
      'p.mochi/meshes/mesh_0011.json',
      'p.mochi/mochi-project.json',
      'p.mochi/motions/motion_0014.json',
      'p.mochi/motionsync.json',
      'p.mochi/parameters.json',
      'p.mochi/parts.json',
      'p.mochi/physics.json',
      'p.mochi/sounds.json',
    ]);
    const manifest = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    expect(manifest).toMatchObject({ format: 'mochi-maker-project', version: 12, seq: 16 });
  });

  it('rewrites only changed files, and removes stale object files', async () => {
    const { s, fs, assets } = await saved();
    expect(await saveProject(fs, 'p.mochi', s.doc, assets)).toEqual({ written: [], removed: [] });
    s.run('keyform.set', { target: '@mesh:ArtMesh_Neck', values: { opacity: 0.5 } });
    expect(await saveProject(fs, 'p.mochi', s.doc, assets)).toEqual({
      written: ['meshes/mesh_0011.json'],
      removed: [],
    });
    s.run('mesh.delete', { target: '@mesh:ArtMesh_Neck', cascade: true });
    const r = await saveProject(fs, 'p.mochi', s.doc, assets);
    expect(r.removed).toEqual(['meshes/mesh_0011.json']);
  });

  it('loads to the same document, and the loaded assets resolve', async () => {
    const { s, fs } = await saved();
    const { doc, assets } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
    expect([...(await assets.get(ASSET))]).toEqual([1, 2, 3]);
  });

  it('refuses to save when an asset is missing', async () => {
    const s = fixtureSession();
    await expect(
      saveProject(new MemoryFileSystem(), 'q', s.doc, new MemoryAssetStore()),
    ).rejects.toMatchObject({ code: 'E_ASSET_MISSING' });
  });

  it('keeps unknown keys from newer writers of the same version', async () => {
    const { s, fs, assets } = await saved();
    const path = 'p.mochi/meshes/mesh_0009.json';
    const json = JSON.parse(await fs.readText(path));
    json.futureField = { hello: [1, 2] };
    await fs.writeText(path, JSON.stringify(json));
    const { doc } = await loadProject(fs, 'p.mochi');
    await saveProject(fs, 'p.mochi', doc, assets);
    expect(JSON.parse(await fs.readText(path)).futureField).toEqual({ hello: [1, 2] });
    expect(s.doc).toBeDefined();
  });

  it('refuses newer format versions and damaged files with clear errors', async () => {
    const { fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 13 }));
    expect((await loadError(fs)).code).toBe('E_PROJECT_TOO_NEW');

    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify(m));
    await fs.writeText('p.mochi/meshes/mesh_0010.json', '{ not json');
    expect((await loadError(fs)).message).toMatch(/mesh_0010.json is not valid JSON/);

    await fs.writeText(
      'p.mochi/meshes/mesh_0010.json',
      JSON.stringify({ kind: 'artMesh', uid: 'mesh_0010' }),
    );
    expect((await loadError(fs)).message).toMatch(/mesh_0010.json: .*missing/);

    await fs.remove('p.mochi/meshes/mesh_0010.json');
    const e = await loadError(fs);
    expect(e.code).toBe('E_PROJECT_FORMAT');
    expect(e.message).toMatch(/mesh_0010/);
  });

  it('runs migrations step by step', async () => {
    const { s, fs } = await saved();
    // Pretend the format is at version 14, and what we saved (version 12) has a renamed field.
    const path = `p.mochi/${MANIFEST}`;
    const m = JSON.parse(await fs.readText(path));
    m.project.canvasOld = m.project.canvas;
    delete m.project.canvas;
    await fs.writeText(path, JSON.stringify(m));
    const calls: number[] = [];
    const migrations: Migration[] = [
      {
        from: 12,
        migrate(bundle) {
          calls.push(12);
          const mm = bundle.get(MANIFEST) as { project: Record<string, unknown> };
          mm.project.canvas = mm.project.canvasOld;
          delete mm.project.canvasOld;
        },
      },
      { from: 13, migrate: () => void calls.push(13) },
    ];
    const doc = decodeBundle(await readBundle(fs, 'p.mochi'), { migrations, currentVersion: 14 });
    expect(calls).toEqual([12, 13]);
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
    expect(() =>
      decodeBundle(new Map([[MANIFEST, { ...m, version: 1 }]]), {
        migrations: [],
        currentVersion: 2,
      }),
    ).toThrow(/No migration from project version 1/);
  });

  it('migrates version-1 projects: layers get opacity, blend mode, clipping and notes', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 1 }));
    const layers = JSON.parse(await fs.readText('p.mochi/layers.json'));
    for (const l of layers.layers)
      for (const k of ['opacity', 'blendMode', 'clipped', 'notes']) delete l[k];
    await fs.writeText('p.mochi/layers.json', JSON.stringify(layers));
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });

  it('migrates version-2 projects: parts, meshes and deformers get empty blend-shape lists', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 2 }));
    const parts = JSON.parse(await fs.readText('p.mochi/parts.json'));
    for (const p of parts.parts) delete p.blendShapes;
    await fs.writeText('p.mochi/parts.json', JSON.stringify(parts));
    let stripped = 0;
    for (const dir of ['meshes', 'deformers'])
      for (const name of await fs.list(`p.mochi/${dir}`)) {
        const o = JSON.parse(await fs.readText(`p.mochi/${dir}/${name}`));
        delete o.blendShapes;
        stripped++;
        await fs.writeText(`p.mochi/${dir}/${name}`, JSON.stringify(o));
      }
    expect(stripped).toBeGreaterThan(0);
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });

  it('migrates version-3 projects: glues get empty blend-shape lists', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 3 }));
    const glues = JSON.parse(await fs.readText('p.mochi/glues.json'));
    expect(glues.glues.length).toBeGreaterThan(0);
    for (const g of glues.glues) delete g.blendShapes;
    await fs.writeText('p.mochi/glues.json', JSON.stringify(glues));
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });

  it('migrates version-4 projects: no sounds, and motions without one', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    delete m.project.soundOrder;
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 4 }));
    for (const name of await fs.list('p.mochi/motions')) {
      const o = JSON.parse(await fs.readText(`p.mochi/motions/${name}`));
      delete o.sound;
      await fs.writeText(`p.mochi/motions/${name}`, JSON.stringify(o));
    }
    await fs.remove('p.mochi/sounds.json');
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });

  it('migrates version-6 projects: no animation templates', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    delete m.project.animationTemplates;
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 6 }));
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
    expect((doc.objects.project as { animationTemplates: unknown[] }).animationTemplates).toEqual(
      [],
    );
  });

  it('migrates version-7 projects: no deform paths', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    delete m.project.deformPaths;
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 7 }));
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });

  it('migrates version-8 projects: no guide images', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    delete m.project.exportSettings.includeGuideImages;
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 8 }));
    const parts = JSON.parse(await fs.readText('p.mochi/parts.json'));
    for (const p of parts.parts) delete p.guide;
    await fs.writeText('p.mochi/parts.json', JSON.stringify(parts));
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });

  it('migrates version-9 projects: motions without a work area or markers', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    delete m.project.motionSyncOrder;
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 9 }));
    await fs.remove('p.mochi/motionsync.json');
    const motions = (await fs.list('p.mochi/motions')).filter((f) => f.endsWith('.json'));
    expect(motions.length).toBeGreaterThan(0);
    for (const f of motions) {
      const mo = JSON.parse(await fs.readText(`p.mochi/motions/${f}`));
      delete mo.workArea;
      delete mo.markers;
      delete mo.motionSync;
      await fs.writeText(`p.mochi/motions/${f}`, JSON.stringify(mo));
    }
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });

  it('keeps a work area and markers, and refuses a work area that ends before it starts', async () => {
    const s = fixtureSession();
    s.runBatch('w', [
      {
        name: 'motion.update',
        args: { target: '@motion~idle', workArea: { start: 0.5, end: 1.5 } },
      },
      {
        name: 'motion.setMarkers',
        args: {
          target: '@motion~idle',
          markers: [
            { time: 1.5, name: 'b' },
            { time: 0.25, name: 'a' },
          ],
        },
      },
    ]);
    const mo = s.query({ kind: 'motion' }).items[0]!;
    const full = s.get(mo.uid as string) as { workArea: unknown; markers: unknown };
    expect(full.workArea).toEqual({ start: 0.5, end: 1.5 });
    expect(full.markers).toEqual([
      { time: 0.25, name: 'a' },
      { time: 1.5, name: 'b' },
    ]);
    expect(() =>
      s.runBatch('bad', [
        { name: 'motion.update', args: { target: '@motion~idle', workArea: { start: 1, end: 1 } } },
      ]),
    ).toThrow(/start before it ends/);
    // Saved and loaded with the motion.
    const fs = new MemoryFileSystem();
    const assets = new MemoryAssetStore();
    assets.blobs.set(ASSET, new Uint8Array([1, 2, 3]));
    await saveProject(fs, 'p.mochi', s.doc, assets);
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });

  it('migrates version-10 projects: no motion-sync settings', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    delete m.project.motionSyncOrder;
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 10 }));
    await fs.remove('p.mochi/motionsync.json');
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });

  it('migrates version-11 projects: motions without a motion-sync setting', async () => {
    const { s, fs } = await saved();
    const m = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...m, version: 11 }));
    const motions = (await fs.list('p.mochi/motions')).filter((f) => f.endsWith('.json'));
    expect(motions.length).toBeGreaterThan(0);
    for (const f of motions) {
      const mo = JSON.parse(await fs.readText(`p.mochi/motions/${f}`));
      delete mo.motionSync;
      await fs.writeText(`p.mochi/motions/${f}`, JSON.stringify(mo));
    }
    const { doc } = await loadProject(fs, 'p.mochi');
    expect(canonicalText(doc)).toBe(canonicalText(s.doc));
  });
});
