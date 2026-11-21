/**
 * Model import, one value at a time: every golden project, exported at versions 3, 4
 * and 5, has one value changed at a time (the first and the last element of every field of the
 * model data), as another exporter might write it. Each change Mochi2D's writer and its strict
 * check accept must either come back from an unedited import and export with a bit-identical
 * evaluation, or be named in the import report, or be refused with a clear message (data the
 * document cannot hold: see docs/import.md). Nothing may change silently.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAssetStore } from '@mochi-maker/core';
import { ModelInstance, loadMoc, readMoc, validateMoc, writeMoc } from 'mochi2d/headless';
import { exportModel, importModel } from '../src/index.js';
import { GOLDENS } from './golden.js';
import { random } from './ordermodel.js';

const DATE = '2026-11-20T12:00:00.000Z';

type Typed = Float32Array | Int32Array | Uint8Array | Int8Array | Uint16Array | Int16Array;

/** Every typed-array field of the model data, as [path, array]. */
function fields(x: object, path = '', out: [string, Typed][] = []): [string, Typed][] {
  for (const [k, v] of Object.entries(x)) {
    if (ArrayBuffer.isView(v)) out.push([path + k, v as Typed]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) fields(v, `${path}${k}.`, out);
  }
  return out;
}

function at(data: object, path: string): Typed {
  let o: Record<string, unknown> = data as Record<string, unknown>;
  for (const p of path.split('.')) o = o[p] as Record<string, unknown>;
  return o as unknown as Typed;
}

const hex = (a: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex');

/** Whether two models evaluate bit for bit alike over seeded poses (render order included). */
function sameEvaluation(a: Uint8Array, b: Uint8Array, poses = 40): boolean {
  const ia = new ModelInstance(loadMoc(a));
  const ib = new ModelInstance(loadMoc(b));
  const P = ia.model.parameters;
  const rnd = random(5);
  for (let pose = 0; pose < poses; pose++) {
    for (let p = 0; p < ia.parameterValues.length; p++) {
      const span = P.max[p]! - P.min[p]!;
      const v = pose === 0 ? P.defaults[p]! : P.min[p]! - span / 4 + rnd() * span * 1.5;
      ia.parameterValues[p] = ib.parameterValues[p] = v;
    }
    for (let p = 0; p < ia.partOpacities.length; p++)
      ia.partOpacities[p] = ib.partOpacities[p] = pose === 0 ? 1 : rnd();
    ia.evaluate();
    ib.evaluate();
    const snap = (i: ModelInstance) =>
      [
        ...i.drawableVertices.map(hex),
        hex(i.drawableOpacity),
        hex(i.drawableDrawOrder),
        hex(i.drawableRenderOrder),
        hex(i.drawableMultiply),
        hex(i.drawableScreen),
        hex(i.drawableVisible),
      ].join();
    if (snap(ia) !== snap(ib)) return false;
  }
  return true;
}

/** A different value of the same kind. */
function change(a: Typed, i: number): void {
  const v = a[i]!;
  if (a instanceof Float32Array) a[i] = v === 0 ? 0.37 : v * 1.0137;
  else if (a instanceof Uint8Array || a instanceof Int8Array) a[i] = v ? 0 : 1;
  else a[i] = v + 1;
}

describe('model import: one changed value at a time', () => {
  for (const version of [3, 4, 5, 6] as const)
    it(`version ${version}: every accepted change is kept, reported or refused`, async () => {
      const silent: string[] = [];
      let kept = 0;
      for (const make of GOLDENS) {
        const g = await make();
        const first = await exportModel(g.session.doc, g.assets, { mocVersion: version }).catch(
          () => null,
        );
        const stem = g.session.view.project().exportSettings.fileStem;
        const moc = first?.files.get(`${stem}.moc3`);
        if (!first || !moc) continue; // the golden needs a later version
        for (const [path, values] of fields(readMoc(moc).data))
          for (const i of new Set([0, values.length - 1])) {
            if (values.length === 0) continue;
            const data = readMoc(moc).data;
            change(at(data, path), i);
            let bytes: Uint8Array;
            try {
              if (!validateMoc(data, { version, level: 'strict' }).valid) continue;
              bytes = writeMoc(data, { version });
            } catch {
              continue; // not a file the format allows
            }
            const files = new Map(first.files);
            files.set(`${stem}.moc3`, bytes);
            const assets = new MemoryAssetStore();
            const r = await importModel(files, `${stem}.model3.json`, assets, {
              date: DATE,
            }).catch((e: Error) => e);
            if (r instanceof Error) {
              // Refused with a message that says why.
              expect(r.message).toMatch(/does not fit the document|model settings do not list/);
              continue;
            }
            const again = (await exportModel(r.document, assets)).files.get(`${stem}.moc3`)!;
            if (sameEvaluation(bytes, again)) kept++;
            else if (!r.report.skipped.some((s) => /draw-order group entry/.test(s.what)))
              silent.push(`${stem} ${path}[${i}]`);
          }
      }
      expect(silent).toEqual([]);
      expect(kept).toBeGreaterThan(100);
    }, 300_000);
});
