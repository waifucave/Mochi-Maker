/**
 * The conformance pack (M12): every golden at versions 3, 4 and 5, scenarios in
 * Mochi2D's catalog formats with Mochi2D's results, and coverage of every writer path.
 */
import { VERSION } from '@mochi-maker/core';
import { describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  COVERAGE,
  conformancePack,
  packReadme,
  renderPack,
  staticPoses,
  type Pack,
} from '@mochi-maker/export';
import { GOLDENS, golden1, golden16 } from './golden.js';

/** The committed pack, for other implementations: `UPDATE_PACK=1` rewrites it from the goldens. */
const PACK_DIR = join(import.meta.dirname, '../../../conformance');
const PRODUCER = `mochi-maker ${VERSION}`;

let all: Promise<Pack> | undefined;
const pack = () =>
  (all ??= Promise.all(GOLDENS.map((g) => g())).then((gs) =>
    conformancePack(
      gs.map((g) => ({ name: g.name, doc: g.session.doc, assets: g.assets })),
      { producer: PRODUCER },
    ),
  ));
const json = (p: Pack, path: string) =>
  JSON.parse(new TextDecoder().decode(p.files.get(path)!)) as Record<string, unknown>;

describe('conformance pack', () => {
  it('exports every golden at every version that can carry it, and says why not otherwise', async () => {
    const p = await pack();
    const { entries } = p.manifest;
    expect(entries).toHaveLength(GOLDENS.length * 4);
    for (const e of entries) {
      if (e.status === 'skipped') expect(e.reason).toMatch(/Version [345] cannot carry this model/);
      else expect(e.errors, `${e.project} v${e.version}`).toEqual([]);
    }
    // Every version is exercised by several goldens.
    for (const v of [3, 4, 5, 6])
      expect(
        entries.filter((e) => e.version === v && e.status === 'exported').length,
      ).toBeGreaterThan(8);
  }, 120_000);

  it('covers every writer path', async () => {
    const { coverage } = (await pack()).manifest;
    for (const c of COVERAGE) expect(coverage[c.path], c.path).not.toEqual([]);
    // Version-3 paths are covered at version 3 too.
    for (const path of Object.keys(coverage).filter((k) => k.startsWith('moc: ')))
      expect(
        coverage[path]!.some((e) => e.endsWith(' v3')),
        path,
      ).toBe(true);
  }, 120_000);

  it('writes scenarios in Mochi2D formats, results beside them, and a manifest of hashes', async () => {
    const p = await pack();
    const e = p.manifest.entries.find(
      (x) => x.project === 'golden-11-animation' && x.version === 5,
    )!;
    const kinds = new Set(e.scenarios.map((s) => s.id.split('.').slice(2, 3)[0]));
    for (const k of [
      'default',
      'key',
      'mid',
      'low',
      'high',
      'random',
      'expression',
      'physics',
      'pose',
    ])
      expect(kinds, k).toContain(k);
    const sc = json(p, e.scenarios[0]!.file);
    expect(sc).toMatchObject({ format: 'mochi2d-scenario/0', model: e.model });
    expect(p.files.has(e.model!)).toBe(true);
    const res = json(p, e.scenarios[0]!.result);
    expect(res).toMatchObject({ format: 'mochi2d-result/0', error: null });
    const anim = e.scenarios.find((s) => s.kind === 'animation')!;
    expect(json(p, anim.file)).toMatchObject({ format: 'mochi2d-anim-scenario/0' });
    expect(json(p, anim.result)).toMatchObject({ format: 'mochi2d-anim-result/0', error: null });
    // IDs are unique across the pack (results are paired by ID).
    const ids = p.manifest.entries.flatMap((x) => x.scenarios.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    // The manifest lists every file with its hash.
    expect(p.manifest.files.map((f) => f.path).sort()).toEqual([...p.files.keys()].sort());
    expect(p.manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  }, 120_000);

  it('poses every key, midpoint, out-of-range value and two-parameter cell', async () => {
    const g = await golden16();
    const labels = staticPoses(g.session.doc, 1, 2).map((x) => x.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'default',
        'key.ParamX.0',
        'key.ParamX.2',
        'mid.ParamX.1',
        'low.ParamSpin',
        'high.ParamSpin',
        'cell.ArtMesh_Grid.5',
        'centre.ArtMesh_Grid.0',
        'cell.Rotation_Spin.0',
        'parts.half',
        'random.1.1',
      ]),
    );
  });

  it('renders the default pose and a few random poses, each at its own pose', async () => {
    const g = await golden1();
    const p = await conformancePack([{ name: g.name, doc: g.session.doc, assets: g.assets }], {
      versions: [5],
      renderPoses: 2,
    });
    const e = p.manifest.entries[0]!;
    expect(e.renders!.map((r) => r.id)).toEqual([
      'golden-1-keyforms.v5.render.random.1.0',
      'golden-1-keyforms.v5.render.random.1.1',
    ]);
    // A render scenario's pose is that of the static random pose with the same index.
    const base = 'golden-1-keyforms/v5/scenarios';
    const r0 = json(p, `${base}/golden-1-keyforms.v5.render.random.1.0.json`);
    const s0 = json(p, `${base}/golden-1-keyforms.v5.random.1.0.json`);
    expect(r0.parameters).toEqual(s0.parameters);
    expect(r0.partOpacities).toEqual(s0.partOpacities);
    expect(r0.render).toEqual({ width: 512, height: 512 });
    expect(Object.keys(r0.parameters as object).length).toBeGreaterThan(0);
    // The renderer is given each scenario's pose.
    const seen: { parameters: Record<string, number> }[] = [];
    await renderPack(p, {
      producer: 'test',
      async render(_files, _settings, size, pose) {
        seen.push(pose!);
        return {
          png: new Uint8Array([1]),
          ...size,
          pixelsPerUnit: 1,
          center: [0, 0],
          renderer: 'test',
          reference: true,
          notes: [],
        };
      },
    });
    expect(seen).toHaveLength(3);
    expect(seen[0]!.parameters).toEqual({});
    expect(seen[1]!.parameters).toEqual(s0.parameters);
    expect(p.manifest.entries[0]!.renders!.every((r) => r.png && r.json)).toBe(true);
    expect(json(p, p.manifest.entries[0]!.renders![1]!.json!)).toMatchObject({
      format: 'mochi2d-render/0',
      scenario: 'golden-1-keyforms.v5.render.random.1.1',
      error: null,
    });
  });

  it('is the same for the same input and seed', async () => {
    const g = await golden1();
    const run = () =>
      conformancePack([{ name: g.name, doc: g.session.doc, assets: g.assets }], { seed: 7 });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.manifest).toEqual(b.manifest);
  });

  it('is committed in conformance/, up to date with the goldens', async () => {
    const p = await pack();
    if (process.env.UPDATE_PACK === '1') {
      // Renders need headless Chromium (Mochi2D's NodeRenderer).
      const { openPackRenderer } = await import('@mochi-maker/api');
      const renderer = await openPackRenderer();
      const full: Pack = { files: new Map(p.files), manifest: structuredClone(p.manifest) };
      try {
        await renderPack(full, renderer);
      } finally {
        await renderer.close();
      }
      await rm(PACK_DIR, { recursive: true, force: true });
      for (const [path, bytes] of full.files) {
        await mkdir(dirname(join(PACK_DIR, path)), { recursive: true });
        await writeFile(join(PACK_DIR, path), bytes);
      }
      await writeFile(
        join(PACK_DIR, 'manifest.json'),
        JSON.stringify(full.manifest, null, 2) + '\n',
      );
      await writeFile(join(PACK_DIR, 'README.md'), packReadme(full.manifest));
    }
    // Everything but the renders is compared here (they need Chromium; UPDATE_PACK=1 makes them).
    const committed = JSON.parse(
      await readFile(join(PACK_DIR, 'manifest.json'), 'utf8'),
    ) as Pack['manifest'];
    expect(committed.entries.filter((e) => e.render?.png).length).toBe(
      p.manifest.entries.filter((e) => e.status === 'exported').length,
    );
    // The renders at random poses: three per export, all made.
    for (const e of committed.entries.filter((x) => x.status === 'exported'))
      expect(e.renders?.filter((r) => r.png).length, `${e.project} v${e.version}`).toBe(3);
    const strip = (m: Pack['manifest']) => ({
      ...m,
      entries: m.entries.map((e) => ({
        ...e,
        render: e.render && { id: e.render.id },
        renders: e.renders?.map((r) => ({ id: r.id })),
      })),
      files: m.files.filter((f) => !f.path.includes('/renders/')),
    });
    expect(strip(committed)).toEqual(strip(p.manifest));
    expect(await readFile(join(PACK_DIR, 'README.md'), 'utf8')).toBe(packReadme(committed));
  }, 300_000);
});
