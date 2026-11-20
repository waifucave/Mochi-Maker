import { describe, expect, it } from 'vitest';
import { DocView } from '@mochi-maker/core';
import { MemoryFileSource, ModelRuntime, mocModelFromData, readMoc } from 'mochi2d/headless';
import { PreviewBuilder, exportModel } from '../src/index.js';
import { GOLDENS } from './golden.js';
import { syntheticProject } from './synthetic.js';

describe('preview builds', () => {
  it('writes the export’s .moc3 and textures for every golden', async () => {
    for (const make of GOLDENS) {
      const g = await make();
      const builder = new PreviewBuilder(g.assets);
      const p = await builder.build(g.session.doc);
      const e = await exportModel(g.session.doc, g.assets);
      const stem = new DocView(g.session.doc).project().exportSettings.fileStem;
      for (const path of [`${stem}.moc3`, `${stem}.model3.json`])
        expect(p.files.get(path), `${g.name}: ${path}`).toEqual(e.files.get(path));
      for (const [path, bytes] of e.files)
        if (path.endsWith('.png')) expect(p.files.get(path), path).toEqual(bytes);
      expect(p.atlasReused).toBe(false);
      const again = await builder.build(g.session.doc);
      expect(again.atlasReused).toBe(true);
      const runtime = await ModelRuntime.load(MemoryFileSource.fromFiles(p.files), p.settings);
      expect(runtime.instance.drawableVertices.length).toBe(p.lowered.uids.artMeshes.length);
    }
  });

  it('reuses the atlas when only keyforms change, and rebuilds it when UVs change', async () => {
    const g = await GOLDENS[0]!();
    const builder = new PreviewBuilder(g.assets);
    await builder.build(g.session.doc);
    const mesh = g.session.view.ofKind('artMesh')[0]!;
    g.session.transact('move', (tx) =>
      tx.run('mesh.moveVertices', { target: mesh.uid, all: true, offset: [3, 0] }),
    );
    expect((await builder.build(g.session.doc)).atlasReused).toBe(true);
    g.session.transact('uv', (tx) =>
      tx.run('mesh.moveUv', { target: mesh.uid, vertices: [0], offset: [-2, 0] }),
    );
    expect((await builder.build(g.session.doc)).atlasReused).toBe(false);
  });

  // Timings: MOCHI_MAKER_BENCH=1 npx vitest run packages/export/test/preview.test.ts
  it.runIf(process.env.MOCHI_MAKER_BENCH === '1')(
    'benchmark',
    async () => {
      const rows: string[] = [];
      const time = (fn: () => unknown, n = 5) => {
        const t: number[] = [];
        for (let i = 0; i < n; i++) {
          const a = performance.now();
          fn();
          t.push(performance.now() - a);
        }
        return t.sort((a, b) => a - b)[Math.floor(n / 2)]!;
      };
      const projects = [];
      for (const make of GOLDENS) projects.push(await make());
      const t0 = performance.now();
      const big = await syntheticProject();
      rows.push(`synthetic project generated in ${(performance.now() - t0).toFixed(0)} ms`);
      projects.push({ name: 'synthetic', ...big });
      for (const g of projects) {
        const builder = new PreviewBuilder(g.assets);
        const cold = await builder.build(g.session.doc);
        const warm: number[] = [];
        let last = cold;
        for (let i = 0; i < 5; i++) {
          last = await builder.build(g.session.doc);
          warm.push(last.timings.total);
        }
        warm.sort((a, b) => a - b);
        const moc = last.files.get([...last.files.keys()].find((k) => k.endsWith('.moc3'))!)!;
        const fromData = time(() => mocModelFromData(last.lowered.data, last.version));
        const read = time(() => readMoc(moc));
        const t = last.timings;
        rows.push(
          `${g.name}: drawables ${last.lowered.uids.artMeshes.length}, moc ${(moc.length / 1024).toFixed(0)} KiB; ` +
            `cold ${cold.timings.total.toFixed(1)} ms (atlas ${cold.timings.atlas.toFixed(1)}); ` +
            `warm ${warm[2]!.toFixed(1)} ms (lower ${t.lower.toFixed(1)}, write ${t.write.toFixed(1)}, files ${t.files.toFixed(1)}); ` +
            `mocModelFromData ${fromData.toFixed(1)} ms; readMoc ${read.toFixed(1)} ms`,
        );
      }
      console.log(rows.join('\n'));
    },
    600_000,
  );
});
