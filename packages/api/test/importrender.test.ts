/**
 * Model import keeps the file's order, seen in renders: the shuffled synthetic models of
 * packages/export/test/ordermodel.ts (stacking only the file's order decides) render the same
 * after an unedited import and export, at the default pose and at seeded poses, with Mochi2D's
 * reference renderer. Needs headless Chromium; skipped where it is missing, except in CI's render
 * job (MOCHI_MAKER_REQUIRE_RENDER=1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportModel } from '@mochi-maker/export';
import { openPackRenderer } from '@mochi-maker/api';
import { random, shuffledImport } from '../../export/test/ordermodel.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
let renderer: Awaited<ReturnType<typeof openPackRenderer>> | null = null;
beforeAll(async () => {
  try {
    renderer = await openPackRenderer();
  } catch (e) {
    if (required) throw e;
  }
}, 120_000);
afterAll(async () => {
  await renderer?.close();
});

describe('model import keeps the file’s order: renders', () => {
  for (const version of [3, 5] as const)
    it(`a shuffled version ${version} model renders the same after import and export`, async () => {
      if (!renderer) return;
      const m = await shuffledImport(version, 4);
      const again = await exportModel(m.document, m.assets);
      const original = new Map(m.files);
      const rnd = random(11);
      for (let pose = 0; pose < 4; pose++) {
        const parameters: Record<string, number> =
          pose === 0 ? {} : { ParamX: -1.25 + rnd() * 2.5 };
        const partOpacities: Record<string, number> =
          pose === 0 ? {} : { PartA: rnd(), PartB: rnd() };
        const size = { width: 256, height: 256 };
        const a = await renderer.render(original, 'order.model3.json', size, {
          parameters,
          partOpacities,
        });
        const b = await renderer.render(again.files, 'order.model3.json', size, {
          parameters,
          partOpacities,
        });
        expect(Buffer.from(b.png).equals(Buffer.from(a.png)), `pose ${pose}`).toBe(true);
      }
    }, 120_000);
});
