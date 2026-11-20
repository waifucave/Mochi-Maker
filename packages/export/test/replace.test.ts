/**
 * Find and replace in the export: renamed parameters and parts reach every file that
 * names them (the .moc3, physics, pose, expressions, motions and display info), since everything
 * else refers to them by UID; the export loads and evaluates as before.
 */
import { describe, expect, it } from 'vitest';
import { exportModel } from '@mochi-maker/export';
import { readMoc } from 'mochi2d/headless';
import { golden11, golden12 } from './golden.js';

const text = (files: Map<string, Uint8Array>, ext: string) =>
  [...files]
    .filter(([p]) => p.endsWith(ext))
    .map(([, b]) => new TextDecoder().decode(b))
    .join('\n');

describe('find and replace in the export', () => {
  it('carries new parameter and part IDs into physics, pose, expressions and display info', async () => {
    const g = await golden11();
    const before = await exportModel(g.session.doc, g.assets);
    g.session.runBatch('Rename', [
      {
        name: 'objects.replaceText',
        args: { find: '^Param', replace: 'Prm', pattern: true },
      },
      { name: 'objects.replaceText', args: { find: 'PartArm', replace: 'PartLimb' } },
    ]);
    const after = await exportModel(g.session.doc, g.assets);
    for (const ext of ['.physics3.json', '.exp3.json', '.cdi3.json']) {
      const t = text(after.files, ext);
      expect(t, ext).toMatch(/"Prm/);
      expect(t.match(/"Param(?!eter)\w*/g) ?? [], ext).toEqual([]);
    }
    const pose = text(after.files, '.pose3.json');
    expect(pose).toMatch(/PartLimbA/);
    expect(pose).not.toMatch(/PartArm/);
    // The .moc3 has the new IDs and the same structure; its loaded values are unchanged.
    const moc = (r: typeof after) =>
      readMoc([...r.files].find(([p]) => p.endsWith('.moc3'))![1]).data as unknown as {
        parameters: { ids: string[] };
        parts: { ids: string[] };
      };
    expect(moc(after).parameters.ids.filter((id) => id.startsWith('Param'))).toEqual([]);
    expect(moc(after).parameters.ids).toContain('PrmIn');
    expect(moc(after).parts.ids).toEqual(
      moc(before).parts.ids.map((id) => id.replace('PartArm', 'PartLimb')),
    );
    expect(after.files.size).toBe(before.files.size);
  });

  it('carries new parameter IDs into the motions', async () => {
    const g = await golden12();
    g.session.runBatch('Rename', [
      { name: 'objects.replaceText', args: { find: 'P_', replace: 'Q_', kinds: ['parameter'] } },
    ]);
    const r = await exportModel(g.session.doc, g.assets);
    const motions = text(r.files, '.motion3.json');
    expect(motions).toMatch(/"Id": "Q_Linear"/);
    expect(motions).not.toMatch(/"Id": "P_/);
  });
});
