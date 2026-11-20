/**
 * Feature flags in the export: with glue (or blend shapes) off, a project that holds them is
 * refused with the same message as the commands; the same project exports once they are removed,
 * and exports with the flag on. (The other tests and the conformance pack run with both flags on.)
 */
import { describe, expect, it } from 'vitest';
import { DocView, MochiError, NO_FEATURES } from '@mochi-maker/core';
import { exportModel, featuresUsed } from '@mochi-maker/export';
import { golden1, golden5, golden7 } from './golden.js';

const refused = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: MochiError) => ({ code: e.code, message: e.message }),
  );

describe('feature flags in the export', () => {
  it('glue off: a project with glue is refused; without it, it exports', async () => {
    const g = await golden5();
    expect(featuresUsed(new DocView(g.session.doc))).toMatchObject({ glue: true });
    const off = { glue: false, blendShapes: true };
    expect(await refused(exportModel(g.session.doc, g.assets, { features: off }))).toEqual({
      code: 'E_FEATURE_OFF',
      message: 'Glue is not available in this build.',
    });
    // With the flag on, as the other tests run, it exports.
    expect((await exportModel(g.session.doc, g.assets)).report.counts.glues).toBeGreaterThan(0);
    // The glue removed (still possible with the flag off), it exports.
    g.session.features = off;
    for (const glue of new DocView(g.session.doc).ofKind('glue'))
      g.session.run('glue.delete', { target: glue.uid } as never);
    const r = await exportModel(g.session.doc, g.assets, { features: off });
    expect(r.report.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('blend shapes off: a project with blend shapes is refused', async () => {
    const g = await golden7();
    expect(featuresUsed(new DocView(g.session.doc))).toMatchObject({ blendShapes: true });
    expect(
      await refused(
        exportModel(g.session.doc, g.assets, { features: { glue: true, blendShapes: false } }),
      ),
    ).toEqual({ code: 'E_FEATURE_OFF', message: 'Blend shapes are not available in this build.' });
  });

  it('a project with neither exports with both flags off', async () => {
    const g = await golden1();
    expect(featuresUsed(new DocView(g.session.doc))).toEqual(NO_FEATURES);
    const r = await exportModel(g.session.doc, g.assets, { features: NO_FEATURES });
    expect(r.report.mocVersion).toBeGreaterThanOrEqual(3);
  });
});
