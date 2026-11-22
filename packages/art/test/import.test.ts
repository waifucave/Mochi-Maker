import { describe, expect, it } from 'vitest';
import {
  MemoryAssetStore,
  MemoryFileSystem,
  MochiError,
  Session,
  canonicalText,
  loadProject,
  replay,
  runItems,
  saveProject,
  type ArtMesh,
  type Layer,
  type Part,
} from '@mochi-maker/core';
import { locate } from '@mochi-maker/geometry';
import {
  ART_OPERATIONS,
  decodePng,
  encodePng,
  readOraArt,
  readPngFolderArt,
  readPsdArt,
} from '@mochi-maker/art';
import { encode } from 'fast-png';
import { shape, syntheticOra, syntheticPsd } from './synthetic.js';
import { examplePsd } from '../../editor/test/guide-art.js';

function context() {
  const session = Session.create();
  const fs = new MemoryFileSystem();
  const assets = new MemoryAssetStore();
  return { session, fs, assets };
}

const run = (
  ctx: ReturnType<typeof context>,
  items: { name: string; args: unknown }[],
  dryRun = false,
) => runItems(ctx, 'test', items, { operations: ART_OPERATIONS, dryRun });

describe('PSD', () => {
  it('reads groups, positions, visibility, blend modes, opacity, clipping and names', () => {
    const art = readPsdArt(syntheticPsd());
    expect(art.width).toBe(200);
    expect(
      art.layers.map((l) => [
        [...l.group, l.name].join('/'),
        l.x,
        l.y,
        l.image.width,
        l.visible,
        l.blendMode,
        l.clipped,
      ]),
    ).toEqual([
      ['Body', 52, 82, 96, true, 'normal', false],
      ['Head/Face', 60, 10, 80, true, 'normal', false],
      ['Head/Eye', 80, 30, 20, true, 'multiply', false],
      ['Head/Shade', 80, 30, 20, true, 'normal', true],
      ['Head/Hidden', 100, 30, 20, false, 'normal', false],
      ['目', 150, 10, 30, true, 'normal', false],
    ]);
    expect(art.layers[2]!.opacity).toBeCloseTo(0.8, 2);
    expect(art.notes.some((n) => n.includes('Empty'))).toBe(true);
  });

  it('reports a damaged file', () => {
    expect(() => readPsdArt(new Uint8Array([1, 2, 3]))).toThrow(MochiError);
  });
});

describe('OpenRaster', () => {
  it('reads nested stacks bottom to top, with offsets, opacity, visibility and modes', async () => {
    const art = await readOraArt(syntheticOra());
    expect(
      art.layers.map((l) => [
        [...l.group, l.name].join('/'),
        l.x,
        l.y,
        l.visible,
        l.blendMode,
        l.opacity,
      ]),
    ).toEqual([
      ['Body', 21, 61, true, 'normal', 1],
      ['Head & face/Face', 30, 10, true, 'normal', 1],
      ['Head & face/Eye', 40, 25, true, 'multiply', 0.5],
      ['Hat', 30, 0, false, 'normal', 1],
    ]);
  });

  it('refuses a zip that is not OpenRaster', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    await expect(readOraArt(zipSync({ mimetype: strToU8('application/zip') }))).rejects.toThrow(
      /not an OpenRaster/,
    );
  });
});

describe('PNG folder', () => {
  it('uses layers.json, order.txt, or natural name order', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeBytes('f/layer10.png', encodePng(shape(30, 30, 'disc', [1, 2, 3])));
    await fs.writeBytes('f/layer2.png', encodePng(shape(30, 30, 'rect', [1, 2, 3], 5)));
    expect((await readPngFolderArt(fs, 'f')).layers.map((l) => [l.name, l.x, l.y])).toEqual([
      ['layer2', 5, 5],
      ['layer10', 0, 0],
    ]);
    await fs.writeText('f/order.txt', 'layer10.png\n# comment\nlayer2.png\n');
    expect((await readPngFolderArt(fs, 'f')).layers.map((l) => l.name)).toEqual([
      'layer10',
      'layer2',
    ]);
    await fs.writeText(
      'f/layers.json',
      JSON.stringify({
        width: 100,
        height: 100,
        layers: [{ file: 'layer2.png', name: 'Back', x: 10, y: 20, group: 'A/B', visible: false }],
      }),
    );
    const art = await readPngFolderArt(fs, 'f');
    expect(art.layers.map((l) => [l.name, l.group, l.x, l.y, l.visible])).toEqual([
      ['Back', ['A', 'B'], 15, 25, false],
    ]);
    expect(art.notes).toEqual(['layer10.png is not listed in layers.json and was skipped.']);
  });

  it('decodes grayscale and 16-bit PNGs', () => {
    const gray = encode({
      width: 2,
      height: 1,
      data: new Uint8Array([10, 255, 200, 0]),
      depth: 8,
      channels: 2,
    });
    expect([...decodePng(gray).data]).toEqual([10, 10, 10, 255, 200, 200, 200, 0]);
    const deep = encode({
      width: 1,
      height: 1,
      data: new Uint16Array([65535, 0, 32768, 65535]),
      depth: 16,
      channels: 4,
    });
    expect([...decodePng(deep).data]).toEqual([255, 0, 128, 255]);
  });
});

describe('art.import', () => {
  it('imports a PSD into parts, layers and meshes in one transaction', async () => {
    const ctx = context();
    await ctx.fs.writeBytes('art/char.psd', syntheticPsd());
    const r = await run(ctx, [{ name: 'art.import', args: { path: 'art/char.psd', spacing: 10 } }]);
    const res = r.itemResults[0] as {
      parts: string[];
      layers: string[];
      meshes: string[];
      notes: string[];
    };
    expect(res.layers).toHaveLength(6);
    expect(res.meshes).toHaveLength(5); // the hidden layer has no mesh
    const v = ctx.session.view;
    expect(v.project().canvas).toMatchObject({
      width: 200,
      height: 150,
      pixelsPerUnit: 200,
      originX: 100,
      originY: 75,
    });
    const head = v.ofKind('part')[0] as Part;
    expect([head.exportId, head.name]).toEqual(['Part_Head', 'Head']);
    const meshes = v.ofKind('artMesh') as ArtMesh[];
    expect(meshes.slice(0, 4).map((m) => [m.exportId, m.name, m.part])).toEqual([
      ['ArtMesh_Body', 'Body', null],
      ['ArtMesh_Face', 'Face', head.uid],
      ['ArtMesh_Eye', 'Eye', head.uid],
      ['ArtMesh_Shade', 'Shade', head.uid],
    ]);
    // No ASCII letters in the name "目": a generated export ID, and the name as display name.
    expect([meshes[4]!.name, meshes[4]!.part]).toEqual(['目', null]);
    expect(meshes[4]!.exportId).toMatch(/^ArtMesh\d+$/);
    // PSD clipping became a clipping mask, and the blend mode is noted.
    expect(meshes[3]!.clip).toEqual({ masks: [meshes[2]!.uid], invert: false });
    const eye = v.ofKind('layer').find((l) => l.name === 'Eye') as Layer;
    expect(eye.blendMode).toBe('multiply');
    expect(eye.notes).toContain('blend mode multiply is not applied');
    expect(res.notes.some((n) => n.includes('Empty'))).toBe(true);
    // Meshes sit at their layer's canvas position and cover the layer's opaque pixels.
    const face = meshes[1]!;
    const faceLayer = v.get(face.layer!) as Layer;
    expect(face.rig.keyforms[0]!.positions[0]).toBe(face.uv[0]! + faceLayer.x);
    const img = decodePng(await ctx.assets.get(faceLayer.asset));
    for (let y = 0; y < img.height; y += 3)
      for (let x = 0; x < img.width; x += 3)
        if (img.data[4 * (y * img.width + x) + 3]! >= 8)
          expect(locate(face.uv, face.triangles, x + 0.5, y + 0.5)).not.toBeNull();
    // A preview PNG comes back.
    expect(r.previews).toHaveLength(1);
    const p = decodePng(r.previews[0]!.data);
    expect([p.width, p.height]).toEqual([200, 150]);
    // The log holds plain commands: replay rebuilds the document without the PSD.
    expect(canonicalText(replay(JSON.parse(JSON.stringify(ctx.session.log))).doc)).toBe(
      canonicalText(ctx.session.doc),
    );
    // And the project saves with its assets.
    const out = new MemoryFileSystem();
    await saveProject(out, 'p', ctx.session.doc, ctx.assets);
    const loaded = await loadProject(out, 'p');
    expect(canonicalText(loaded.doc)).toBe(canonicalText(ctx.session.doc));
    expect([...(await loaded.assets.get(faceLayer.asset))]).toEqual([
      ...(await ctx.assets.get(faceLayer.asset)),
    ]);
  });

  it('puts the layers of art without groups into one part named after the file', async () => {
    const ctx = context();
    await ctx.fs.writeBytes('art/mochi.psd', examplePsd());
    const r = await run(ctx, [{ name: 'art.import', args: { path: 'art/mochi.psd' } }]);
    const res = r.itemResults[0] as { parts: string[]; meshes: string[] };
    const v = ctx.session.view;
    const parts = v.ofKind('part');
    expect(parts.map((p) => [p.exportId, p.name, p.parent])).toEqual([
      ['Part_mochi', 'mochi', null],
    ]);
    expect(res.parts).toEqual([parts[0]!.uid]);
    expect(res.meshes).toHaveLength(7);
    expect(v.ofKind('artMesh').every((m) => m.part === parts[0]!.uid)).toBe(true);
    expect(v.project().root).toEqual([parts[0]!.uid]);
    // With a parent given, the layers go there and no part is made.
    const ctx2 = context();
    await ctx2.fs.writeBytes('art/mochi.psd', examplePsd());
    await run(ctx2, [
      { name: 'part.create', args: { exportId: 'PartBody', name: 'Body' } },
      { name: 'art.import', args: { path: 'art/mochi.psd', parent: '$0' } },
    ]);
    expect(ctx2.session.view.ofKind('part').map((p) => p.exportId)).toEqual(['PartBody']);
  });

  it('imports OpenRaster and PNG folders; dry runs commit nothing; is deterministic', async () => {
    const ctx = context();
    await ctx.fs.writeBytes('a.ora', syntheticOra());
    const dry = await run(ctx, [{ name: 'art.import', args: { path: 'a.ora' } }], true);
    expect(dry.committed).toBe(false);
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(ctx.session.revision).toBe(0);
    await run(ctx, [{ name: 'art.import', args: { path: 'a.ora', meshes: false } }]);
    expect(ctx.session.view.ofKind('layer').map((l) => l.name)).toEqual([
      'Body',
      'Face',
      'Eye',
      'Hat',
    ]);
    expect(ctx.session.view.ofKind('artMesh')).toHaveLength(0);

    const twice = async () => {
      const c = context();
      await c.fs.writeBytes('a.ora', syntheticOra());
      await run(c, [{ name: 'art.import', args: { path: 'a.ora' } }]);
      return canonicalText(c.session.doc);
    };
    expect(await twice()).toBe(await twice());

    const c2 = context();
    await c2.fs.writeBytes('dir/one.png', encodePng(shape(40, 40, 'disc', [1, 1, 1])));
    const r = await run(c2, [{ name: 'art.import', args: { path: 'dir', parent: null } }]);
    expect((r.itemResults[0] as { meshes: string[] }).meshes).toHaveLength(1);
  });

  it('reports unknown formats and missing files', async () => {
    const ctx = context();
    await ctx.fs.writeText('notes.txt', 'hello');
    await expect(
      run(ctx, [{ name: 'art.import', args: { path: 'notes.txt' } }]),
    ).rejects.toMatchObject({ code: 'E_ASSET_FORMAT', command: 'art.import', at: 0 });
    await expect(
      run(ctx, [{ name: 'art.import', args: { path: 'nope.psd' } }]),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });
});

describe('mesh.generate and mesh.regenerate', () => {
  it('generate from a layer, then rebuild with another density, keeping keyforms', async () => {
    const ctx = context();
    await ctx.fs.writeBytes('one.png', encodePng(shape(60, 60, 'disc', [9, 9, 9])));
    await run(ctx, [{ name: 'art.import', args: { path: 'one.png', meshes: false } }]);
    const g = await run(ctx, [
      { name: 'param.create', args: { exportId: 'ParamX', min: 0, max: 1, keys: [0, 1] } },
      { name: 'mesh.generate', args: { layer: '@layer~one', spacing: 15 } },
      { name: 'rig.addBinding', args: { target: '$1', parameter: '$0' } },
      {
        name: 'mesh.moveVertices',
        args: { target: '$1', cell: { '@param:ParamX': 1 }, offset: [10, 0] },
      },
    ]);
    expect(g.previews).toHaveLength(1);
    const uid = (g.itemResults[1] as { uid: string }).uid;
    const before = (ctx.session.view.get(uid) as ArtMesh).uv.length / 2;
    const r = await run(ctx, [{ name: 'mesh.regenerate', args: { target: uid, spacing: 6 } }]);
    const m = ctx.session.view.get(uid) as ArtMesh;
    expect(m.uv.length / 2).toBeGreaterThan(before);
    expect((r.itemResults[0] as { vertexCount: number }).vertexCount).toBe(m.uv.length / 2);
    // Key 1 is the rest shifted by 10 in x, for every vertex, old or new.
    const [rest, moved] = m.rig.keyforms;
    for (let i = 0; i < rest!.positions.length; i += 2)
      expect(moved!.positions[i]! - rest!.positions[i]!).toBeCloseTo(10, 4);
  });

  it('explain failures with fixes', async () => {
    const ctx = context();
    await ctx.fs.writeBytes('big.png', encodePng(shape(600, 600, 'rect', [1, 1, 1])));
    await run(ctx, [{ name: 'art.import', args: { path: 'big.png', meshes: false } }]);
    const err = await run(ctx, [
      { name: 'mesh.generate', args: { layer: '@layer~big', spacing: 2 } },
    ]).catch((e: MochiError) => e);
    expect(err).toMatchObject({ code: 'E_TOPOLOGY', command: 'mesh.generate' });
    expect((err as MochiError).fixes[0]).toMatchObject({ replace: { path: 'args.spacing' } });
    ctx.assets.blobs.clear();
    await expect(
      run(ctx, [{ name: 'mesh.generate', args: { layer: '@layer~big' } }]),
    ).rejects.toMatchObject({ code: 'E_ASSET_MISSING' });
  });
});

describe('operation catalog', () => {
  it('every operation has docs, and every example matches its schema', async () => {
    const { checkArgs, describeCommand } = await import('@mochi-maker/core');
    for (const op of ART_OPERATIONS) {
      const d = describeCommand(op.name, ART_OPERATIONS);
      expect(d.kind).toBe('operation');
      expect(d.doc.length).toBeGreaterThan(50);
      expect(op.examples.length).toBeGreaterThan(0);
      for (const ex of op.examples) checkArgs(op.args, ex.args);
    }
  });
});

describe('import details', () => {
  it('default spacing follows the canvas, clamped to 30–600 interior vertices per island', async () => {
    const ctx = context();
    await ctx.fs.writeBytes('art/char.psd', syntheticPsd());
    const r = await run(ctx, [{ name: 'art.import', args: { path: 'art/char.psd' } }]);
    const res = r.itemResults[0] as {
      meshStats: { mesh: string; vertices: number; spacing: number }[];
    };
    expect(res.meshStats).toHaveLength(5);
    // Canvas 200 × 150: 200 / 64 = 3.125 px, but the small layers clamp it to ≤ 600 points per island.
    for (const s of res.meshStats) expect(s.spacing).toBeGreaterThanOrEqual(3.125 - 1e-9);
    const face = res.meshStats[1]!; // an 80 px disc (plus margin): area ≈ 5,600 px²
    expect(face.spacing).toBeCloseTo(Math.sqrt((Math.PI * 43 * 43) / 600), 0);
  });

  it('clipping can be switched off, and what was done is noted', async () => {
    const on = context();
    await on.fs.writeBytes('c.psd', syntheticPsd());
    const r1 = await run(on, [{ name: 'art.import', args: { path: 'c.psd' } }]);
    expect(
      (r1.itemResults[0] as { notes: string[] }).notes.some((n) =>
        /Head\/Shade: clipped by .*ArtMesh_Eye/.test(n),
      ),
    ).toBe(true);
    const off = context();
    await off.fs.writeBytes('c.psd', syntheticPsd());
    const r2 = await run(off, [{ name: 'art.import', args: { path: 'c.psd', clipping: false } }]);
    expect(off.session.view.ofKind('artMesh').every((m) => m.clip === null)).toBe(true);
    expect((r2.itemResults[0] as { notes: string[] }).notes).toContain(
      'Head/Shade: clipped in the source; not applied (clipping off)',
    );
  });
});
