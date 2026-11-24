/**
 * Rendering in the agent API (agent API design 2.5) through Mochi2D's NodeRenderer. Needs headless
 * Chromium; skipped where it is missing, except in CI's render job (MOCHI_MAKER_REQUIRE_RENDER=1).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { MochiError } from '@mochi-maker/core';
import { decodePng } from '@mochi-maker/art';
import { Project } from '@mochi-maker/api';
import { golden1, golden4 } from '../../export/test/golden.js';

/**
 * The limit for the tests here that render several poses through Mochi2D: the longest took 0.76 s
 * on two busy cores.
 */
const WORK = 30_000;

const projects: Project[] = [];
afterAll(async () => {
  for (const p of projects) await p.close();
});
async function open(build: typeof golden1) {
  const g = await build();
  const p = Project.fromSession(g.session, g.assets);
  projects.push(p);
  return p;
}

const canRender = await (async () => {
  const p = await open(golden1);
  try {
    await p.render({ width: 16, height: 16 });
    return true;
  } catch (e) {
    if (e instanceof MochiError && e.code === 'E_RENDER_UNAVAILABLE') return false;
    throw e;
  }
})();
const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';

const pixel = (png: Uint8Array, x: number, y: number) => {
  const img = decodePng(png, 'render');
  return Array.from(img.data.subarray(4 * (y * img.width + x), 4 * (y * img.width + x) + 4));
};
const near = (a: number[], b: number[], tol = 3) =>
  a.forEach((v, i) => expect(Math.abs(v - b[i]!), `${a} vs ${b}`).toBeLessThanOrEqual(tol));

describe.runIf(canRender || required)('rendering', () => {
  it('renders a pose, reference or fast, and frames an object', async () => {
    expect(canRender, 'rendering needs Playwright and Chromium').toBe(true);
    const p = await open(golden4);
    const view = { x: 0, y: 0, pixelsPerUnit: 200 };
    const ref = await p.render({
      width: 200,
      height: 200,
      view,
      reference: true,
      background: [0, 0, 0, 1],
    });
    expect(ref).toMatchObject({ width: 200, height: 200, reference: true, revision: p.revision });
    near(pixel(ref.png, 40, 32), [0, 0, 255, 255]); // Union over Mask_1 (golden 4)
    near(pixel(ref.png, 80, 32), [0, 0, 0, 255]);
    const fast = await p.render({ width: 200, height: 200, view, background: [0, 0, 0, 1] });
    expect(fast.reference).toBe(false);
    near(pixel(fast.png, 40, 32), [0, 0, 255, 255], 8);
    // Framing Fade (160, 20)–(190, 50) with no margin: the image center is inside it, tinted.
    const around = await p.render({
      width: 64,
      height: 64,
      around: '@mesh:Fade',
      margin: 0,
      parameters: { ParamTint: 1 },
      reference: true,
    });
    near(pixel(around.png, 32, 32), [102, 100, 200, 255]);
    // Room for a machine shared with other suites.
  }, 60_000);

  it('sweeps a parameter as a contact sheet or frames', { timeout: WORK }, async () => {
    const p = await open(golden1);
    const sheet = await p.sweep('@param:ParamA', { steps: 3, width: 64, height: 48 });
    expect(sheet.values).toEqual([0, 0.5, 1]);
    const img = decodePng(sheet.sheet!, 'sheet');
    expect([img.width, img.height]).toEqual([3 * 64 + 4 * 4, 48 + 2 * 4]);
    const frames = await p.sweep('@param:ParamA', {
      values: [0, 1],
      as: 'frames',
      width: 64,
      height: 48,
    });
    expect(frames.frames!.map((f) => f.parameters)).toEqual([{ ParamA: 0 }, { ParamA: 1 }]);
    expect(
      Buffer.compare(Buffer.from(frames.frames![0]!.png), Buffer.from(frames.frames![1]!.png)),
    ).not.toBe(0);
  });

  it('diffs two revisions visually', { timeout: WORK }, async () => {
    const p = await open(golden1);
    const r0 = p.revision;
    const same = await p.visualDiff(r0, r0, { width: 100, height: 75 });
    expect(same.metrics).toEqual({ rms: 0, changed: 0, max: 0 });
    p.transact('Move', (tx) =>
      tx.mesh.moveVertices({ target: '@mesh:ArtMesh_Square', all: true, offset: [30, 0] }),
    );
    const d = await p.visualDiff(r0, p.revision, { width: 100, height: 75 });
    expect(d.metrics.changed).toBeGreaterThan(0.01);
    expect(d.before.revision).toBe(r0);
    expect(d.after.revision).toBe(p.revision);
    const img = decodePng(d.diff, 'diff');
    expect([img.width, img.height]).toEqual([100, 75]);
  });
});

it('reports a missing renderer with a clear error', async () => {
  if (canRender) return;
  const p = await open(golden1);
  await expect(p.render()).rejects.toMatchObject({ code: 'E_RENDER_UNAVAILABLE' });
});
