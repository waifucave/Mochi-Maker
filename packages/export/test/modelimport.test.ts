/**
 * Model import (roadmap M16): `.moc3` → project → `.moc3` without an edit.
 *
 * Every golden project, exported at versions 3, 4 and 5 where it can be, is imported and
 * exported again. Mochi2D's evaluation of the original and of the re-export is bit-identical over
 * 300 seeded random poses (every drawable's vertices, opacity, draw and render order and colors),
 * the runtime files carry the same content (parsed JSON), and the texture pages are the same
 * bytes. Where the re-exported `.moc3` is byte-identical is recorded too (`BYTE_IDENTICAL`).
 * Then one edit after import changes only what it edits.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  DocView,
  MemoryAssetStore,
  MochiError,
  NO_FEATURES,
  Session,
  loadProject,
  saveProject,
} from '@mochi-maker/core';
import { NodeFileSystem } from '@mochi-maker/core/node';
import { ModelInstance, loadMoc, readMoc, writeMoc, type MocData } from 'mochi2d/headless';
import { exportModel, importModel, invertF32, MODEL_IMPORT_NOTICE } from '../src/index.js';
import { GOLDENS, golden1, golden12, golden2, golden5, golden8 } from './golden.js';

const DATE = '2026-11-20T12:00:00.000Z';
const POSES = 300;

/** mulberry32: a seeded random source. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bytesOf = (
  a: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number },
) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex');

/** Evaluates both models at the same seeded poses; returns the first difference, or null. */
function compareEvaluation(a: Uint8Array, b: Uint8Array, seed: number): string | null {
  const ma = loadMoc(a);
  const mb = loadMoc(b);
  const ia = new ModelInstance(ma);
  const ib = new ModelInstance(mb);
  const ids = (m: typeof ma, k: 'parameters' | 'parts' | 'meshes') =>
    (m as unknown as Record<string, { ids: string[] }>)[k]!.ids;
  for (const k of ['parameters', 'parts', 'meshes'] as const)
    if (ids(ma, k).join() !== ids(mb, k).join())
      return `${k} differ: ${ids(ma, k)} / ${ids(mb, k)}`;
  const rnd = random(seed);
  const P = ma.parameters;
  const snapshot = (i: ModelInstance) => [
    ...i.drawableVertices.map(bytesOf),
    bytesOf(i.drawableOpacity),
    bytesOf(i.drawableDrawOrder),
    bytesOf(i.drawableRenderOrder),
    bytesOf(i.drawableMultiply),
    bytesOf(i.drawableScreen),
    bytesOf(i.drawableVisible),
  ];
  for (let pose = 0; pose < POSES; pose++) {
    for (let p = 0; p < ia.parameterValues.length; p++) {
      const lo = P.min[p]!;
      const hi = P.max[p]!;
      const span = hi - lo;
      const v = pose === 0 ? P.defaults[p]! : lo - span / 4 + rnd() * span * 1.5;
      ia.parameterValues[p] = v;
      ib.parameterValues[p] = v;
    }
    for (let p = 0; p < ia.partOpacities.length; p++) {
      const v = pose === 0 ? 1 : rnd();
      ia.partOpacities[p] = v;
      ib.partOpacities[p] = v;
    }
    ia.evaluate();
    ib.evaluate();
    const sa = snapshot(ia);
    const sb = snapshot(ib);
    for (let k = 0; k < sa.length; k++) if (sa[k] !== sb[k]) return `pose ${pose}, array ${k}`;
  }
  return null;
}

const json = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

/** Golden × version cases whose re-exported .moc3 is byte-identical (filled by the test). */
const table: { golden: string; version: number; mocBytes: boolean; reason?: string }[] = [];

describe('model import: the round trip', () => {
  it('inverts float32 conversions exactly where an inverse exists', () => {
    const ppu = 2048;
    const o = 1024;
    for (const px of [0, 1, 1023.25, 1276.84375, 4000.5, -12.75]) {
      const t = Math.fround((Math.fround(px) - o) / ppu);
      const r = invertF32(t, t * ppu + o, (x) => Math.fround((x - o) / ppu));
      expect(r.exact).toBe(true);
      expect(Math.fround((r.value - o) / ppu)).toBe(t);
    }
  });

  for (const [gi, make] of GOLDENS.entries())
    it(`golden ${gi + 1}: versions 3–6 export again bit for bit in evaluation`, async () => {
      for (const version of [3, 4, 5, 6] as const) {
        const g = await make();
        let first;
        try {
          first = await exportModel(g.session.doc, g.assets, { mocVersion: version });
        } catch {
          continue; // the golden cannot be carried at this version
        }
        const stem = g.session.view.project().exportSettings.fileStem;
        const assets = new MemoryAssetStore();
        const imported = await importModel(first.files, `${stem}.model3.json`, assets, {
          date: DATE,
        });
        expect(imported.notices).toEqual([MODEL_IMPORT_NOTICE]);
        expect(imported.report.source.mocVersion).toBe(version);
        expect(imported.report.inexact).toBe(0);
        expect(imported.report.skipped).toEqual([]);
        const again = await exportModel(imported.document, assets);
        expect(again.report.mocVersion).toBe(version);
        // The same files, with the same content.
        expect([...again.files.keys()].sort()).toEqual([...first.files.keys()].sort());
        for (const [path, bytes] of first.files) {
          const other = again.files.get(path)!;
          if (path.endsWith('.json')) expect(json(other), path).toEqual(json(bytes));
          else if (!path.endsWith('.moc3'))
            expect(Buffer.from(other).equals(Buffer.from(bytes)), path).toBe(true);
        }
        const moc = `${stem}.moc3`;
        const diff = compareEvaluation(
          first.files.get(moc)!,
          again.files.get(moc)!,
          gi * 10 + version,
        );
        expect(diff, `golden ${gi + 1} v${version}`).toBeNull();
        const same = Buffer.from(first.files.get(moc)!).equals(Buffer.from(again.files.get(moc)!));
        table.push({ golden: `golden ${gi + 1}`, version, mocBytes: same });
        // The project records where it came from, and survives saving and reopening.
        const origin = new DocView(imported.document).project().importedFrom!;
        expect(origin).toMatchObject({ format: 'moc3', date: DATE, mocVersion: version });
        expect(origin.files).toContain(moc);
        Session.open(imported.document);
      }
    }, 120_000);

  it('the sample model (samples/mochi) exports again byte for byte', async () => {
    const dir = join(import.meta.dirname, '../../../samples/mochi');
    const files = new Map<string, Uint8Array>();
    for (const f of await readdir(dir, { recursive: true, withFileTypes: true }))
      if (f.isFile())
        files.set(
          relative(dir, join(f.parentPath, f.name)).split('\\').join('/'),
          await readFile(join(f.parentPath, f.name)),
        );
    const assets = new MemoryAssetStore();
    const r = await importModel(files, 'mochi.model3.json', assets, { date: DATE });
    expect(r.report.skipped).toEqual([]);
    expect(r.report.features).toMatchObject({ glue: false, blendShapes: false });
    const again = await exportModel(r.document, assets, { features: NO_FEATURES });
    expect([...again.files.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, bytes] of files)
      expect(Buffer.from(again.files.get(path)!).equals(Buffer.from(bytes)), path).toBe(true);
  });

  it('records which re-exported .moc3 files are byte-identical', () => {
    expect(table.filter((t) => !t.mocBytes)).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(
      table
        .map((t) => `${t.golden} v${t.version}: ${t.mocBytes ? 'same bytes' : 'different bytes'}`)
        .join('\n'),
    );
    expect(table.length).toBeGreaterThan(30);
  });
});

/** The fields of two model data whose values differ, as group.field. */
function changedFields(a: MocData, b: MocData): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (ArrayBuffer.isView(x) || Array.isArray(x)) {
      if (
        JSON.stringify(Array.from(x as ArrayLike<unknown>)) !==
        JSON.stringify(Array.from(y as ArrayLike<unknown>))
      )
        out.push(path);
    } else if (x && typeof x === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y as object)]))
        walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
          path ? `${path}.${k}` : k,
        );
    } else if (!Object.is(x, y)) out.push(path);
  };
  walk(a, b, '');
  return out;
}

async function imported(make: typeof golden2, version: 3 | 4 | 5) {
  const g = await make();
  const first = await exportModel(g.session.doc, g.assets, { mocVersion: version });
  const stem = g.session.view.project().exportSettings.fileStem;
  const assets = new MemoryAssetStore();
  const r = await importModel(first.files, `${stem}.model3.json`, assets, { date: DATE });
  return { first, stem, assets, ...r };
}

describe('model import: editing and limits', () => {
  it('after one edit, the re-export changes only what the edit changed', async () => {
    const m = await imported(golden2, 5);
    const s = Session.open(m.document);
    s.run('mesh.moveVertices', {
      target: '@mesh:ArtMesh_Head',
      all: true,
      vertices: [0],
      offset: [3, 0],
    });
    s.run('param.update', { target: '@param:ParamAngle', min: -45, max: 45 });
    const again = await exportModel(s.doc, m.assets);
    const a = readMoc(m.first.files.get(`${m.stem}.moc3`)!).data;
    const b = readMoc(again.files.get(`${m.stem}.moc3`)!).data;
    expect(changedFields(a, b)).toEqual(['parameters.max', 'parameters.min', 'keyformPositions']);
    // Only the head mesh's first vertex moved (x by 3 px in its rotation's pixel space).
    const changed = [...a.keyformPositions.keys()].filter(
      (i) => a.keyformPositions[i] !== b.keyformPositions[i],
    );
    const head = a.artMeshes.ids.indexOf('ArtMesh_Head');
    const firstPos = a.artMeshKeyforms.firstPosition[a.artMeshes.firstKeyform[head]!]!;
    expect(changed).toEqual(
      Array.from(
        { length: a.artMeshes.keyformCount[head]! },
        (_, k) => a.artMeshKeyforms.firstPosition[a.artMeshes.firstKeyform[head]! + k]!,
      ),
    );
    expect(b.keyformPositions[firstPos]! - a.keyformPositions[firstPos]!).toBeCloseTo(3, 4);
    const p = a.parameters.ids.indexOf('ParamAngle');
    expect([b.parameters.min[p], b.parameters.max[p]]).toEqual([-45, 45]);
    // The runtime files are unchanged, apart from what names the range (none here).
    for (const [path, bytes] of m.first.files)
      if (path.endsWith('.json') && !path.endsWith('motionsync3.json'))
        expect(Buffer.from(again.files.get(path)!).equals(Buffer.from(bytes)), path).toBe(true);
  });

  it('keeps glue with the flags off, and the export says which flag it needs', async () => {
    const g = await golden5();
    const first = await exportModel(g.session.doc, g.assets, { mocVersion: 5 });
    const assets = new MemoryAssetStore();
    const r = await importModel(first.files, 'golden5.model3.json', assets, {
      date: DATE,
      features: NO_FEATURES,
    });
    expect(r.report.features).toMatchObject({ glue: true, blendShapes: false });
    expect(r.report.features.lines.join(' ')).toMatch(
      /uses glue.*does not export while the glue feature is off/,
    );
    const view = new DocView(r.document);
    expect(view.ofKind('glue').length).toBeGreaterThan(0);
    // The project opens and edits; it does not export while glue is off.
    const s = Session.open(r.document, { features: NO_FEATURES });
    s.run('param.update', { target: view.ofKind('parameter')[0]!.uid, decimals: 2 });
    await expect(exportModel(s.doc, assets, { features: NO_FEATURES })).rejects.toMatchObject({
      code: 'E_FEATURE_OFF',
    });
    expect(
      (await exportModel(s.doc, assets, { features: { glue: true, blendShapes: false } })).report
        .mocVersion,
    ).toBe(5);
  });

  it('refuses a damaged file, and a missing file, with a clear message', async () => {
    const m = await imported(golden2, 5);
    const files = new Map(m.first.files);
    // A version 5 file marked as version 6: Mochi2D reads it, but it does not load.
    const moc = Uint8Array.from(files.get(`${m.stem}.moc3`)!);
    moc[4] = 6;
    files.set(`${m.stem}.moc3`, moc);
    const err = await importModel(files, `${m.stem}.model3.json`, new MemoryAssetStore(), {
      date: DATE,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MochiError);
    expect((err as MochiError).code).toBe('E_MODEL_IMPORT');
    expect((err as MochiError).message).toMatch(new RegExp(`^${m.stem}\\.moc3 does not load: `));
    files.delete(`${m.stem}.moc3`);
    await expect(
      importModel(files, `${m.stem}.model3.json`, new MemoryAssetStore(), { date: DATE }),
    ).rejects.toThrow(/is not in the model folder/);
  });

  it('keeps a value with no exact inverse as the file has it, until it is edited', async () => {
    // A model not written by Mochi Maker: a top-level position nudged by one float32 step, which
    // no canvas pixel value exports to exactly.
    const m = await imported(golden1, 5);
    const moc = readMoc(m.first.files.get(`${m.stem}.moc3`)!);
    const F = new Float32Array(1);
    const I = new Int32Array(F.buffer);
    // Near the canvas origin a pixel step is coarser than a step of the stored value.
    const P = moc.data.keyformPositions;
    let at = 0;
    for (let i = 0; i < P.length; i++) if (P[i] !== 0 && Math.abs(P[i]!) < Math.abs(P[at]!)) at = i;
    F[0] = P[at]!;
    I[0]! += 1;
    P[at] = F[0]!;
    const files = new Map(m.first.files);
    files.set(`${m.stem}.moc3`, writeMoc(moc.data, { version: 5 }));
    const assets = new MemoryAssetStore();
    const r = await importModel(files, `${m.stem}.model3.json`, assets, { date: DATE });
    expect(r.report.inexact).toBeGreaterThan(0);
    // Unedited, the export writes the file's value again: the whole model data is the file's.
    const again = readMoc(
      (await exportModel(r.document, assets)).files.get(`${m.stem}.moc3`)!,
    ).data;
    expect(again.keyformPositions[at]).toBe(P[at]);
    expect(changedFields(moc.data, again)).toEqual([]);
    // Once the value is edited, it is the document's again.
    const s = Session.open(r.document);
    s.run('mesh.moveVertices', { target: '@mesh:ArtMesh_Square', all: true, offset: [1, 0] });
    const edited = readMoc((await exportModel(s.doc, assets)).files.get(`${m.stem}.moc3`)!).data;
    expect(changedFields(moc.data, edited)).toEqual(['keyformPositions']);
  });

  it('keeps mirror flags on rotation blend-shape deltas, which the document has no place for', async () => {
    const m = await imported(golden8, 5);
    const moc = readMoc(m.first.files.get(`${m.stem}.moc3`)!);
    const RK = moc.data.rotationKeyforms;
    RK.mirrorX.fill(1);
    RK.mirrorY.fill(1);
    const files = new Map(m.first.files);
    files.set(`${m.stem}.moc3`, writeMoc(moc.data, { version: 5 }));
    const assets = new MemoryAssetStore();
    const r = await importModel(files, `${m.stem}.model3.json`, assets, { date: DATE });
    const again = readMoc((await exportModel(r.document, assets)).files.get(`${m.stem}.moc3`)!);
    expect(changedFields(moc.data, again.data)).toEqual([]);
  });

  it('reads motions as Mochi2D does: a curve that takes no effect is left out and reported', async () => {
    const m = await imported(golden12, 5);
    const path = [...m.first.files.keys()].find((f) => f.endsWith('.motion3.json'))!;
    const j = JSON.parse(new TextDecoder().decode(m.first.files.get(path)!));
    // A model curve after the parameter curves comes after a later kind, so it takes no effect.
    j.Curves.push({ Target: 'Model', Id: 'EyeBlink', Segments: [0, 1, 0, 1, 0] });
    j.Meta.CurveCount += 1;
    j.Meta.TotalSegmentCount += 1;
    j.Meta.TotalPointCount += 2;
    const files = new Map(m.first.files);
    files.set(path, new TextEncoder().encode(JSON.stringify(j)));
    const assets = new MemoryAssetStore();
    const r = await importModel(files, `${m.stem}.model3.json`, assets, { date: DATE });
    expect(r.report.skipped.map((x) => x.what)).toEqual([
      `1 curve(s) at the end of motion ${path.slice(path.indexOf('motions/'))}`,
    ]);
    // Everything else comes back as it was.
    const again = await exportModel(r.document, assets);
    expect(json(again.files.get(path)!)).toEqual(json(m.first.files.get(path)!));
  });

  it('saves and reopens with its origin and texture pages', async () => {
    const m = await imported(golden2, 4);
    const dir = await mkdtemp(join(tmpdir(), 'mochi-import-'));
    try {
      const fs = new NodeFileSystem();
      await saveProject(fs, dir, m.document, m.assets);
      const back = await loadProject(fs, dir);
      const view = new DocView(back.doc);
      expect(view.project().importedFrom).toEqual(new DocView(m.document).project().importedFrom);
      expect(view.ofKind('layer').every((l) => l.texturePage)).toBe(true);
      const again = await exportModel(back.doc, back.assets);
      expect(
        Buffer.from(again.files.get(`${m.stem}.moc3`)!).equals(
          Buffer.from(m.first.files.get(`${m.stem}.moc3`)!),
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
