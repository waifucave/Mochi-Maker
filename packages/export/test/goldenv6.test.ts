/**
 * Version 6 golden projects (goldenv6.ts; the committed project and its export hashes are checked
 * with the other goldens in golden.test.ts): Mochi2D's checks at both levels, the export, the
 * import round trip through real files, the lowering cache, values computed by hand, and what an
 * earlier version is told.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAssetStore, MochiError } from '@mochi-maker/core';
import {
  ModelInstance,
  mocModelFromData,
  readMoc,
  validateMoc,
  writeMoc,
  type MocData,
} from 'mochi2d/headless';
import { PreviewBuilder, exportModel, importModel } from '../src/index.js';
import { GOLDENS_V6, goldenOffscreens } from './goldenv6.js';

/**
 * The limit for the tests here that export at version 6 and check it in Mochi2D: the longest took
 * 0.34 s on two busy cores.
 */
const WORK = 30_000;

/** Model data as JSON, typed arrays as lists: for hashing and comparing. */
const json = (d: MocData) =>
  JSON.stringify(d, (_k, v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as never) : v));

async function built(make: typeof goldenOffscreens) {
  const g = await make();
  const builder = new PreviewBuilder(g.assets);
  const build = await builder.build(g.session.doc);
  return { g, builder, build, data: build.lowered.data };
}

/** An instance of the data at a pose (parameters by ID, others at their defaults). */
function at(data: MocData, pose: Record<string, number>) {
  const i = new ModelInstance(mocModelFromData(data, 6));
  const P = i.model.parameters;
  P.ids.forEach((id, k) => (i.parameterValues[k] = pose[id] ?? P.defaults[k]!));
  i.evaluate();
  return i;
}

describe.each(GOLDENS_V6.map((g) => [g.name, g] as const))('%s', (_name, make) => {
  it('exports at version 6, which Mochi2D checks at both levels', { timeout: WORK }, async () => {
    const { g, data, build } = await built(make);
    expect(build.version).toBe(6);
    expect(validateMoc(data, { version: 6, level: 'official' }).valid).toBe(true);
    expect(validateMoc(data, { version: 6, level: 'strict' }).diagnostics).toEqual([]);
    const r = await exportModel(g.session.doc, g.assets);
    expect(r.report.mocVersion).toBe(6);
    const moc = r.files.get(`${g.session.view.project().exportSettings.fileStem}.moc3`)!;
    expect(validateMoc(moc, { level: 'strict' }).diagnostics).toEqual([]);
    // The file holds the data the preview shows.
    expect(json(readMoc(moc).data)).toBe(json(data));
  });

  it('exports, imports and exports again, byte for byte', async () => {
    const { g } = await built(make);
    const first = await exportModel(g.session.doc, g.assets);
    const stem = g.session.view.project().exportSettings.fileStem;
    const assets = new MemoryAssetStore();
    const r = await importModel(first.files, `${stem}.model3.json`, assets, {
      date: '2026-11-21T00:00:00.000Z',
    });
    expect(r.report.skipped).toEqual([]);
    expect(r.report.source.mocVersion).toBe(6);
    const again = await exportModel(r.document, assets);
    for (const [path, bytes] of first.files) {
      if (path === 'mochi-export.json') continue;
      expect(Buffer.from(again.files.get(path)!).equals(Buffer.from(bytes)), path).toBe(true);
    }
  });

  it('patches values through the lowering cache exactly as a full lowering', async () => {
    const { g, builder } = await built(make);
    const s = g.session;
    // Part_Light: an offscreen without blend shapes (objects with blend shapes lower in full).
    s.run('keyform.set', {
      target: '@part:Part_Light',
      values: { opacity: 0.75, multiply: [0.5, 0.5, 1], screen: [0, 0.1, 0] },
    });
    s.run('keyform.set', { target: '@mesh:Shade', values: { opacity: 0.5 } });
    // The builder's cache patches the values; a fresh builder lowers in full.
    const patched = await builder.build(s.doc);
    expect(patched.lowering.mode).toBe('values');
    const full = await new PreviewBuilder(g.assets).build(s.doc);
    expect(full.lowering.mode).toBe('full');
    expect(json(patched.lowered.data)).toBe(json(full.lowered.data));
  });
});

describe('offscreens and blend modes: values by hand', () => {
  it('keyforms the offscreen’s opacity and tints, and clamps an offscreen with blend shapes', async () => {
    const { data } = await built(goldenOffscreens);
    // Offscreens in part order: Part_Glass, then Part_Light.
    expect(Array.from(data.offscreens!.part)).toEqual([0, 1]);
    expect(Array.from(data.offscreens!.blendMode)).toEqual([6, 10 | (1 << 8)]);
    expect(Array.from(data.offscreens!.flags)).toEqual([4, 4]);
    expect(data.offscreens!.maskCount[1]).toBe(1);
    const ids = data.artMeshes.ids;
    const code = (id: string) => data.artMeshes.blendMode![ids.indexOf(id)];
    expect([code('Shade'), code('Cut'), code('Glow'), code('Back')]).toEqual([
      12,
      5 | (1 << 8),
      1,
      0,
    ]);
    // Ten entries in the root group: eight meshes and the two offscreens.
    expect(data.drawOrderGroups.entryCount[0]).toBe(10);

    const glass = (pose: Record<string, number>) => {
      const i = at(data, pose);
      return {
        opacity: i.offscreenOpacity[0]!,
        multiply: Array.from(i.offscreenMultiply.slice(0, 3)),
        screen: Array.from(i.offscreenScreen.slice(0, 3)),
        light: i.offscreenOpacity[1]!,
      };
    };
    expect(glass({})).toEqual({ opacity: 1, multiply: [1, 0.5, 0.5], screen: [0, 0, 0], light: 1 });
    const half = glass({ ParamFade: 0.5 });
    expect(half.opacity).toBeCloseTo(0.625, 6);
    expect(half.multiply.map((x) => +x.toFixed(6))).toEqual([1, 0.75, 0.75]);
    expect(half.screen.map((x) => +x.toFixed(6))).toEqual([0.1, 0, 0]);
    // ParamBS at 1: −0.5 opacity and +0.3 green screen; at ParamFade 1 the opacity is clamped.
    const both = glass({ ParamFade: 1, ParamBS: 1 });
    expect(both.opacity).toBe(0);
    expect(both.screen.map((x) => +x.toFixed(6))).toEqual([0.2, 0.3, 0]);
    expect(glass({ ParamBS: 1 }).opacity).toBeCloseTo(0.5, 6);
  });

  it('draws in group order, the offscreens where their parts are', async () => {
    const { data } = await built(goldenOffscreens);
    const i = at(data, {});
    const ids = data.artMeshes.ids;
    const order = ids
      .map((id, k) => [id, i.drawableRenderOrder[k]!] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
    // Back (400) and Mask (450) first; then, at 500, the tree's order: Part_Glass's meshes,
    // Shade, Cut, Glow; Part_Light (600) last.
    expect(order).toEqual(['Back', 'Mask', 'Red', 'Green', 'Shade', 'Cut', 'Glow', 'Blue']);
    expect(Array.from(i.offscreenRenderOrder)).toEqual([2, 8]);
  });

  it('reads the blending from the code in version 6, and keeps the file’s flag bits', async () => {
    const { g } = await built(goldenOffscreens);
    const first = await exportModel(g.session.doc, g.assets);
    const stem = g.session.view.project().exportSettings.fileStem;
    // Glow is additive: code 1. Its flag bits 0–1, which version 6 does not read, are cleared.
    const moc = readMoc(first.files.get(`${stem}.moc3`)!).data;
    const glow = moc.artMeshes.ids.indexOf('Glow');
    expect(moc.artMeshes.blendMode![glow]).toBe(1);
    moc.artMeshes.flags[glow] = moc.artMeshes.flags[glow]! & ~3;
    const files = new Map(first.files);
    files.set(`${stem}.moc3`, writeMoc(moc, { version: 6 }));
    const assets = new MemoryAssetStore();
    const r = await importModel(files, `${stem}.model3.json`, assets, {
      date: '2026-11-21T00:00:00.000Z',
    });
    const mesh = Object.values(r.document.objects).find(
      (o) => o.kind === 'artMesh' && o.exportId === 'Glow',
    ) as { legacyBlend: string; blend: unknown };
    expect(mesh).toMatchObject({ legacyBlend: 'additive', blend: null });
    const again = await exportModel(r.document, assets);
    expect(
      Buffer.from(again.files.get(`${stem}.moc3`)!).equals(Buffer.from(files.get(`${stem}.moc3`)!)),
    ).toBe(true);
  });

  it('names what needs version 6 when an earlier version is asked for', async () => {
    const { g } = await built(goldenOffscreens);
    const err = await exportModel(g.session.doc, g.assets, { mocVersion: 5 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MochiError);
    const details = (err as MochiError).details as { problems: { code: string; uid?: string }[] };
    const named = details.problems
      .filter((p) => p.code === 'feature-needs-version')
      .map((p) => p.uid);
    const v = g.session.view;
    const uid = (ref: string) => v.resolve(ref, ['part', 'artMesh'], 'ref');
    expect(named.sort()).toEqual(
      ['@part:Part_Glass', '@part:Part_Light', '@mesh:Shade', '@mesh:Cut'].map(uid).sort(),
    );
    // Without them, the same project exports at version 5.
    const s = g.session;
    s.run('part.setOffscreen', { target: '@part:Part_Glass', offscreen: false });
    s.run('part.setOffscreen', { target: '@part:Part_Light', offscreen: false });
    s.run('mesh.update', { target: '@mesh:Shade', blend: null });
    s.run('mesh.update', { target: '@mesh:Cut', blend: null });
    const r = await exportModel(s.doc, g.assets);
    expect(r.report.mocVersion).toBe(5);
  });
});
