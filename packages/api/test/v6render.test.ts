/**
 * The agent API on a version 6 model (the version 6 golden, packages/export/test/goldenv6.ts):
 * evaluate and render go through the version 6 export like any other. The render shows what only
 * version 6 has: the same model without its offscreens and version 6 blend modes renders
 * differently. Rendering needs headless Chromium; that part is skipped where it is missing, except
 * in CI's render job.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Project } from '@mochi-maker/api';
import { goldenOffscreens } from '../../export/test/goldenv6.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
const projects: Project[] = [];
afterAll(async () => {
  for (const p of projects) await p.close();
});

async function render(p: Project) {
  try {
    return await p.render({ width: 128, height: 128, reference: true });
  } catch (e) {
    if (!required && /Chromium|Playwright/.test((e as Error).message)) return null;
    throw e;
  }
}

describe('the agent API on a version 6 model', () => {
  it('evaluates and renders it from its version 6 export', async () => {
    const g = await goldenOffscreens();
    const p = Project.fromSession(g.session, g.assets);
    projects.push(p);
    const e = await p.evaluate({ parameters: { ParamFade: 1 } });
    expect(e.mocVersion).toBe(6);
    // In the tree's order: the two parts' meshes, then the top level's.
    expect(e.drawables.map((d) => d.id)).toEqual([
      'Red',
      'Green',
      'Blue',
      'Back',
      'Mask',
      'Shade',
      'Cut',
      'Glow',
    ]);
    const back = e.drawables.find((d) => d.id === 'Back')!;
    for (const [k, v] of Object.entries({ minX: 10, minY: 10, maxX: 190, maxY: 190 }))
      expect(back.bounds[k as keyof typeof back.bounds]).toBeCloseTo(v, 4);
    expect(back.renderOrder).toBe(0);

    const img = await render(p);
    if (!img) return;
    expect(img.reference).toBe(true);
    const plain = await goldenOffscreens();
    const s = plain.session;
    s.run('part.setOffscreen', { target: '@part:Part_Glass', offscreen: false });
    s.run('part.setOffscreen', { target: '@part:Part_Light', offscreen: false });
    s.run('mesh.update', { target: '@mesh:Shade', blend: null });
    s.run('mesh.update', { target: '@mesh:Cut', blend: null });
    const q = Project.fromSession(s, plain.assets);
    projects.push(q);
    const other = await render(q);
    expect(Buffer.from(other!.png).equals(Buffer.from(img.png))).toBe(false);
  }, 120_000);
});
