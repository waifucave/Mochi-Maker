/**
 * M13, compatibility targets (design 2.2): every golden project is exported at versions 3 to 6.
 * A version that carries the document must evaluate exactly like the reference (version 5, or 6
 * for a project that needs it) at several poses; a version that cannot must be refused, naming
 * each object that needs more, with a fix.
 */
import { describe, expect, it } from 'vitest';
import { DocView, MochiError } from '@mochi-maker/core';
import { exportModel, requiredVersion, type ExportProblem } from '@mochi-maker/export';
import { readMoc } from 'mochi2d/headless';
import { GOLDENS } from './golden.js';
import { evaluate } from './probe.js';

describe.each(GOLDENS.map((g) => [g.name, g] as const))('%s at versions 3 to 6', (_n, build) => {
  it('exports and evaluates like the reference version, or is refused with the objects that need more', async () => {
    const g = await build();
    const doc = new DocView(g.session.doc);
    const stem = doc.project().exportSettings.fileStem;
    const need = requiredVersion(doc);
    const top = need.version >= 6 ? 6 : 5;
    const reference = await exportModel(g.session.doc, g.assets, { mocVersion: top });
    const params = doc.project().parameterOrder.map((u) => doc.getAs(u, 'parameter'));
    // The default pose, each parameter's ends, and every parameter at 30 % of its range.
    const poses: Record<string, number>[] = [
      {},
      ...params.flatMap((p) => [{ [p.exportId]: p.min }, { [p.exportId]: p.max }]),
      Object.fromEntries(params.map((p) => [p.exportId, p.min + 0.3 * (p.max - p.min)])),
    ];
    for (const version of ([3, 4, 5, 6] as const).filter((v) => v !== top)) {
      if (version >= need.version) {
        const r = await exportModel(g.session.doc, g.assets, { mocVersion: version });
        expect(readMoc(r.files.get(`${stem}.moc3`)!).version).toBe(version);
        for (const pose of poses) {
          const a = evaluate(r, stem, pose);
          const b = evaluate(reference, stem, pose);
          expect([...a.keys()]).toEqual([...b.keys()]);
          for (const [id, d] of b) {
            const x = a.get(id)!;
            expect([x.visible, x.renderOrder], `${id} ${JSON.stringify(pose)}`).toEqual([
              d.visible,
              d.renderOrder,
            ]);
            expect(x.opacity).toBe(d.opacity);
            expect(x.vertices).toEqual(d.vertices);
            expect(x.multiplyColor).toEqual(d.multiplyColor);
            expect(x.screenColor).toEqual(d.screenColor);
          }
        }
      } else {
        const e = (await exportModel(g.session.doc, g.assets, { mocVersion: version }).catch(
          (x: unknown) => x,
        )) as MochiError;
        expect(e).toBeInstanceOf(MochiError);
        expect(e.code).toBe('E_EXPORT');
        const problems = (e.details!.problems as ExportProblem[]).filter(
          (p) => p.source === 'version',
        );
        const expected = need.reasons.filter((r) => r.version > version);
        expect(problems.map((p) => p.uid)).toEqual(expected.map((r) => r.uid));
        for (const p of problems) {
          expect(p.fix).toMatch(/^Export at version [456]/);
          expect(p.message).toContain(`version ${version} cannot carry it`);
        }
      }
    }
  });
});

describe('downgrade diagnostics', () => {
  it('name the blend shape and the values that need version 5, and the colors that need 4', async () => {
    const g = await GOLDENS[7]!(); // golden 8
    const reasons = requiredVersion(g.session.view).reasons;
    expect(reasons.map((r) => r.version)).toEqual([5, 5, 5, 5]);
    const face = reasons.find((r) => r.feature.includes('changes'))!;
    expect(face.feature).toContain(
      'ParamBS changes opacity, draw order, multiply color, screen color',
    );
    expect(face.fix).toContain('blendShape.set');
    const g4 = await GOLDENS[3]!(); // golden 4: colors
    const colors = requiredVersion(g4.session.view).reasons;
    expect(colors.every((r) => r.version === 4)).toBe(true);
    expect(colors[0]!.feature).toMatch(/multiply or screen colors in \d+ of \d+ keyform/);
    expect(colors[0]!.fix).toContain('keyform.set');
  });
});
