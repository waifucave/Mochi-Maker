/**
 * The editor in headless Chromium (Playwright), on the golden projects. Skipped where Chromium is
 * missing, except in CI's render job (MOCHI_MAKER_REQUIRE_RENDER=1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { unzipSync } from 'fflate';
import { Project } from '@mochi-maker/api';
import { GOLDENS, golden1 } from '../../export/test/golden.js';
import { buildEditor, launch, openGolden, serve, type Browser, type Page } from './harness.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
let browser: Browser | null = null;
let server: Server | undefined;
let url = '';

beforeAll(async () => {
  browser = await launch();
  if (!browser) {
    if (required)
      throw new Error('Chromium is required (MOCHI_MAKER_REQUIRE_RENDER=1) but missing.');
    return;
  }
  const s = await serve(await buildEditor());
  server = s.server;
  url = s.url;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function page(): Promise<Page> {
  const p = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  (p as unknown as { errors: string[] }).errors = errors;
  await p.goto(`${url}?nohome`);
  await p.waitForFunction(() => window.mochi !== undefined);
  return p;
}

/**
 * expect.poll with room for CI's software-rendered pages. Test timeouts are generous too: a test
 * timed out once while another project's suite shared the machine.
 */
const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 30_000 });
const settled = (p: Page) => p.evaluate(() => window.mochi.settled());
const status = (p: Page) => p.getByTestId('status').textContent();

/** Page coordinates of a mesh's evaluated vertex. */
async function vertexClient(p: Page, uid: string, i: number): Promise<[number, number]> {
  return p.evaluate(
    ({ uid, i }) => {
      const vp = window.mochiEditor.viewport;
      const pts = vp.meshScreen(uid)!;
      const r = vp.overlay.getBoundingClientRect();
      return [r.left + pts[i]![0], r.top + pts[i]![1]] as [number, number];
    },
    { uid, i },
  );
}

const meshUid = (p: Page, exportId: string) =>
  p.evaluate((id) => (window.mochi.get(`@mesh:${id}`) as { uid: string }).uid, exportId);

const available = await launch().then(async (b) => {
  await b?.close();
  return b !== null;
});

describe.skipIf(!required && !available)('the editor', () => {
  it('opens every golden project and shows what Mochi2D evaluates for the export', async () => {
    const p = await page();
    for (const make of GOLDENS) {
      const g = await make();
      await openGolden(p, g.name);
      await settled(p);
      const shown = await p.evaluate(() => window.mochi.evaluate().drawables);
      // The same evaluation through the agent API's export in Node.
      const e = await Project.fromSession(g.session, g.assets).evaluate({ vertices: true });
      const posed = g.session.view.project().pose.groups.length > 0;
      expect(shown.length, g.name).toBe(e.drawables.length);
      for (const d of e.drawables) {
        const s = shown.find((x) => x.id === d.id)!;
        expect(s.uid, `${g.name} ${d.id}`).toBe(d.uid);
        // The editor shows the parts' own opacities: the pose groups' switching is an animation
        // effect, off while editing, and Mochi2D's scenario applies it.
        if (!posed) {
          expect(s.visible, `${g.name} ${d.id}`).toBe(d.visible);
          expect(s.opacity, `${g.name} ${d.id}`).toBeCloseTo(d.opacity, 5);
        }
        s.vertices.forEach((v, i) => expect(v).toBeCloseTo(d.vertices![i]!, 2));
      }
      expect(await p.getByTestId('project-name').textContent()).toBe(g.name);
    }
    expect((p as unknown as { errors: string[] }).errors).toEqual([]);
    await p.close();
  }, 240_000);

  it('draws overlays through the view transform, also after zooming and panning', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const check = () =>
      p.evaluate(() => {
        const vp = window.mochiEditor.viewport;
        const r = vp.overlay.getBoundingClientRect();
        const out: number[] = [];
        for (const [x, y] of [
          [100, 100],
          [600, 300],
          [r.width - 50, r.height - 40],
        ] as const) {
          const m = vp.view.toModel(r.left + x, r.top + y)!;
          const [sx, sy] = vp.modelToLocal(m.x, m.y);
          out.push(Math.hypot(sx - x, sy - y));
        }
        return out;
      });
    for (const d of await check()) expect(d).toBeLessThan(0.1);
    const box = (await p.getByTestId('overlay').boundingBox())!;
    await p.mouse.move(box.x + 300, box.y + 200);
    await p.mouse.wheel(0, -400);
    await p.mouse.move(box.x + 500, box.y + 300);
    await p.mouse.down({ button: 'middle' });
    await p.mouse.move(box.x + 450, box.y + 340, { steps: 4 });
    await p.mouse.up({ button: 'middle' });
    const t = await p.evaluate(() => window.mochiEditor.viewport.view.viewTransform);
    expect(t.zoom).toBeGreaterThan(1.5);
    for (const d of await check()) expect(d).toBeLessThan(0.1);
    // An edit rebuilds the preview, and the view keeps its zoom and pan.
    await p.evaluate(() =>
      window.mochi.transact('nudge', (tx) =>
        tx.mesh.moveVertices({ target: '@mesh:ArtMesh_Square', all: true, offset: [1, 0] }),
      ),
    );
    await settled(p);
    expect(await p.evaluate(() => window.mochiEditor.viewport.view.viewTransform)).toEqual(t);
    await p.close();
  }, 120_000);

  it('selects a mesh by clicking it, and moves a vertex in the keyform at the pose', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const uid = await meshUid(p, 'ArtMesh_Square');
    // Click inside the quad (between vertices 0 and 2).
    const a = await vertexClient(p, uid, 0);
    const c = await vertexClient(p, uid, 2);
    await p.mouse.click((a[0] + c[0]) / 2, (a[1] + c[1]) / 2);
    expect(await p.evaluate(() => window.mochi.selection().uid)).toBe(uid);
    await poll(() => p.getByTestId('export-id').inputValue()).toBe('ArtMesh_Square');

    // Drag vertex 0 by 30 CSS pixels right and 20 down, at ParamA = 0 (a key).
    const before = (await p.evaluate((u) => window.mochi.get(u), uid)) as {
      rig: { keyforms: { positions: [number, number][] }[] };
    };
    const [x, y] = await vertexClient(p, uid, 0);
    const expected = await p.evaluate(
      ({ x, y }) => {
        const vp = window.mochiEditor.viewport;
        const a = vp.clientToCanvas(x, y)!;
        const b = vp.clientToCanvas(x + 30, y + 20)!;
        return [b[0] - a[0], b[1] - a[1]];
      },
      { x, y },
    );
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x + 15, y + 10, { steps: 3 });
    await p.mouse.move(x + 30, y + 20, { steps: 3 });
    await p.mouse.up();
    await settled(p);
    const after = (await p.evaluate((u) => window.mochi.get(u), uid)) as typeof before;
    const history = await p.evaluate(() => window.mochi.history());
    expect(history.at(-1)).toEqual({ label: 'Move vertices', author: 'person' });
    // Keyform 0 (ParamA = 0) moved; keyform 1 did not.
    expect(
      after.rig.keyforms[0]!.positions[0]![0] - before.rig.keyforms[0]!.positions[0]![0],
    ).toBeCloseTo(expected[0]!, 2);
    expect(
      after.rig.keyforms[0]!.positions[0]![1] - before.rig.keyforms[0]!.positions[0]![1],
    ).toBeCloseTo(expected[1]!, 2);
    expect(after.rig.keyforms[1]!.positions).toEqual(before.rig.keyforms[1]!.positions);
    // The preview shows it: the vertex is under the pointer now.
    const [nx, ny] = await vertexClient(p, uid, 0);
    expect(Math.hypot(nx - x - 30, ny - y - 20)).toBeLessThan(0.6);
    // Drag frames patch the shown model in place (Mochi2D 0.6.0), and they match the lowering
    // exactly: after the commit, the new build has nothing left to patch.
    const stats = await p.evaluate(() => window.mochi.stats());
    expect(stats.dragFrames.length).toBeGreaterThan(0);
    expect(stats.builds.at(-1)).toMatchObject({ mode: 'patch', patches: 0 });
    // Undo is a value change too: patched, not reloaded.
    const loadsBefore = stats.builds.filter((b) => b.mode === 'load').length;

    // Undo with the keyboard.
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+z');
    await settled(p);
    expect(await p.evaluate((u) => window.mochi.get(u), uid)).toEqual(before);
    await p.keyboard.press('Control+Shift+z');
    await settled(p);
    const statsAfter = await p.evaluate(() => window.mochi.stats());
    expect(statsAfter.builds.filter((b) => b.mode === 'load').length).toBe(loadsBefore);
    expect(statsAfter.builds.at(-1)!.mode).toBe('patch');
    expect(await p.evaluate((u) => window.mochi.get(u), uid)).toEqual(after);
    await p.close();
  }, 120_000);

  it('edits keyforms only at a key: refuses between keys, with a hint and a fix', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const uid = await meshUid(p, 'ArtMesh_Square');
    await p.evaluate((u) => window.mochi.select(u), uid);
    await p.getByTestId('snap').uncheck();
    await p.evaluate(() => window.mochi.setPose({ ParamA: 0.5 }));
    await poll(() => p.getByTestId('keyform-refusal').textContent()).toContain('between its keys');
    // Dragging is refused too, with the same reason.
    const [x, y] = await vertexClient(p, uid, 1);
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x + 20, y, { steps: 2 });
    await p.mouse.up();
    expect(await status(p)).toContain('Move it to a key, or add a key here');
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(0);

    // At ParamA = 1 the inspector edits that keyform.
    await p.evaluate(() => window.mochi.setPose({ ParamA: 1 }));
    await poll(() => p.getByTestId('cell').textContent()).toContain('ParamA = 1');
    await p.getByTestId('kf-opacity').fill('0.25');
    await p.getByTestId('kf-opacity').press('Enter');
    await settled(p);
    const mesh = (await p.evaluate((u) => window.mochi.get(u), uid)) as {
      rig: { keyforms: { opacity: number; authored: boolean }[] };
    };
    expect(mesh.rig.keyforms[1]!.opacity).toBe(0.25);
    const shown = await p.evaluate(() => window.mochi.evaluate().drawables[0]!.opacity);
    expect(shown).toBeCloseTo(0.25, 5);

    // "Add a key here" adds ParamA = 0.5 to the parameter and the binding, in one transaction.
    await p.evaluate(() => window.mochi.setPose({ ParamA: 0.5 }));
    await p.getByTestId('add-key-here').click();
    await settled(p);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Add key here');
    await poll(() => p.getByTestId('cell').textContent()).toContain('ParamA = 0.5');
    await p.close();
  }, 120_000);

  it('adds, deletes and retriangulates vertices through mesh commands', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const uid = await meshUid(p, 'ArtMesh_Square');
    await p.evaluate((u) => window.mochi.select(u), uid);
    // Mesh editing (Ctrl+E), then its add-vertices sub-tool in Tool Details.
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+e');
    await p.getByTestId('tool-add').click();
    const a = await vertexClient(p, uid, 0);
    const b = await vertexClient(p, uid, 1);
    const c = await vertexClient(p, uid, 2);
    // A point inside triangle (0, 1, 2).
    await p.mouse.click((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3);
    await settled(p);
    const count = () =>
      p.evaluate((u) => (window.mochi.get(u) as { uv: number[][] }).uv.length, uid);
    expect(await count()).toBe(5);
    expect(await p.evaluate(() => window.mochi.selection().vertices)).toEqual([4]);
    // The new vertex is where the person clicked (the mesh looks the same).
    const v = await vertexClient(p, uid, 4);
    expect(
      Math.hypot(v[0] - (a[0] + b[0] + c[0]) / 3, v[1] - (a[1] + b[1] + c[1]) / 3),
    ).toBeLessThan(0.6);
    await p.getByTestId('subtool-arrow').click();
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Delete');
    await settled(p);
    expect(await count()).toBe(4);
    await p.getByTestId('retriangulate').click();
    await settled(p);
    const labels = (await p.evaluate(() => window.mochi.history())).map((h) => h.label);
    expect(labels).toEqual(['Add vertex', 'Delete vertices', 'Retriangulate']);
    // The confirm button on the canvas leaves mesh editing.
    await p.getByTestId('mesh-bar-confirm').click();
    expect(await p.evaluate(() => window.mochiEditor.editor.meshEdit)).toBeNull();
    await p.close();
  }, 120_000);

  it('drags vertices of nested meshes and deformer handles in canvas space (M4)', async () => {
    const p = await page();
    await openGolden(p, 'golden-15-nested-deformers');
    await settled(p);
    // Turn the head, so the chain above the face is rotated, scaled and bent.
    await p.evaluate(() =>
      window.mochi.setPose({ '@param:ParamAngle': 30, '@param:ParamBend': 1 }),
    );
    await settled(p);
    const uid = await meshUid(p, 'ArtMesh_Face');
    await p.evaluate((u) => window.mochi.select(u), uid);
    const drag = async (x: number, y: number, dx: number, dy: number) => {
      await p.mouse.move(x, y);
      await p.mouse.down();
      await p.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 });
      await p.mouse.move(x + dx, y + dy, { steps: 3 });
      await p.mouse.up();
      await settled(p);
    };
    const [x, y] = await vertexClient(p, uid, 0);
    await drag(x, y, 25, 15);
    expect(await p.evaluate(() => window.mochi.history().at(-1))).toEqual({
      label: 'Move vertices',
      author: 'person',
    });
    // The vertex is under the pointer: its local (u, v) came from the inverse of the forward map.
    const [nx, ny] = await vertexClient(p, uid, 0);
    expect(Math.hypot(nx - x - 25, ny - y - 15)).toBeLessThan(0.6);
    const face = (await p.evaluate((u) => window.mochi.get(u), uid)) as {
      rig: { keyforms: { positions: [number, number][] }[] };
    };
    expect(face.rig.keyforms[0]!.positions[0]![0]).not.toBe(0);
    expect(face.rig.keyforms[0]!.positions[1]).toEqual([1, 0]);
    // The arrow keys nudge in canvas pixels too, resolved through the deformers.
    const canvasAt = async () => {
      const [cx, cy] = await vertexClient(p, uid, 0);
      return p.evaluate(({ cx, cy }) => window.mochiEditor.viewport.clientToCanvas(cx, cy)!, {
        cx,
        cy,
      });
    };
    const c0 = await canvasAt();
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Shift+ArrowRight');
    await settled(p);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Nudge vertices');
    const c1 = await canvasAt();
    expect(c1[0] - c0[0]).toBeCloseTo(10, 1);
    expect(c1[1] - c0[1]).toBeCloseTo(0, 1);

    // A warp's grid point: select Warp_Face and drag its handle 0.
    const warp = await p.evaluate(
      () => (window.mochi.get('@warp:Warp_Face') as { uid: string }).uid,
    );
    await p.evaluate((u) => window.mochi.select(u), warp);
    const handle = () =>
      p.evaluate((u) => {
        const vp = window.mochiEditor.viewport;
        const r = vp.overlay.getBoundingClientRect();
        const h = vp.deformerHandles(u)![0]!;
        return [r.left + h[0], r.top + h[1]] as [number, number];
      }, warp);
    const [hx, hy] = await handle();
    await drag(hx, hy, -12, 18);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Move grid points');
    const [mx, my] = await handle();
    expect(Math.hypot(mx - hx + 12, my - hy - 18)).toBeLessThan(0.6);

    // Wrap a mesh in a new warp from the Inspector: it stays in place.
    const badge = await meshUid(p, 'ArtMesh_Badge');
    await p.evaluate((u) => window.mochi.select(u), badge);
    const before = await Promise.all([0, 1, 2, 3].map((i) => vertexClient(p, badge, i)));
    await p.getByTestId('wrap-warp').click();
    await p.getByTestId('deformer-create').click();
    await settled(p);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe(
      'Create warp deformer',
    );
    const parent = (await p.evaluate((u) => window.mochi.get(u), badge)) as { deformer: string };
    expect(
      await p.evaluate(
        (u) => (window.mochi.get(u) as { exportId: string }).exportId,
        parent.deformer,
      ),
    ).toBe('Warp_Badge');
    const after = await Promise.all([0, 1, 2, 3].map((i) => vertexClient(p, badge, i)));
    after.forEach(([ax, ay], i) =>
      expect(Math.hypot(ax - before[i]![0], ay - before[i]![1])).toBeLessThan(0.05),
    );
    // The new deformer is selected. Wrapping the badge again picks a free export ID.
    expect(await p.evaluate(() => window.mochi.selection().uid)).toBe(parent.deformer);
    await p.evaluate((u) => window.mochi.select(u), badge);
    await p.getByTestId('wrap-warp').click();
    await p.getByTestId('deformer-create').click();
    await settled(p);
    const again = (await p.evaluate((u) => window.mochi.get(u), badge)) as { deformer: string };
    expect(
      await p.evaluate(
        (u) => (window.mochi.get(u) as { exportId: string }).exportId,
        again.deformer,
      ),
    ).toBe('Warp_Badge2');
    expect((p as unknown as { errors: string[] }).errors).toEqual([]);
    await p.close();
  }, 180_000);

  it('runs commands from the command bar', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+k');
    await p.getByTestId('command-search').fill('param.create');
    await p.locator('[data-command="param.create"]').click();
    await p
      .getByTestId('command-args')
      .fill(JSON.stringify({ exportId: 'ParamNew', min: 0, max: 1, default: 0, keys: [0, 1] }));
    await p.getByTestId('command-run').click();
    await poll(() => p.getByTestId('command-output').textContent()).toContain('"committed": true');
    await p.keyboard.press('Escape');
    expect(await p.locator('[data-param="ParamNew"]').count()).toBe(1);
    // Errors come back in the agent API's shape.
    await p.keyboard.press('Control+k');
    await p.getByTestId('command-search').fill('param.create');
    await p.locator('[data-command="param.create"]').click();
    await p
      .getByTestId('command-args')
      .fill(JSON.stringify({ exportId: 'ParamNew', min: 0, max: 1 }));
    await p.getByTestId('command-run').click();
    await poll(() => p.getByTestId('command-output').textContent()).toContain('"category"');
    await p.close();
  }, 120_000);

  it('lets a person watch an agent work through window.mochi', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const r = await p.evaluate(() =>
      window.mochi.transact(
        'Rig a fade',
        (tx) => {
          const fade = tx.param.create({
            exportId: 'ParamFade',
            min: 0,
            max: 1,
            default: 0,
            keys: [0, 1],
          });
          tx.rig.addBinding({ target: '@mesh:ArtMesh_Square', parameter: fade.uid });
          tx.keyform.set({
            target: '@mesh:ArtMesh_Square',
            cell: { '@param:ParamA': 0, [fade.uid]: 1 },
            values: { opacity: 0 },
          });
          return fade.uid;
        },
        { author: 'agent:test' },
      ),
    );
    expect(r.committed).toBe(true);
    await settled(p);
    // The person sees it: history with the agent as author, the pose bar, the indicator.
    await p.locator('[data-tab="history"]').click();
    await poll(() => p.locator('[data-author="agent:test"]').count()).toBe(1);
    expect(await p.locator('[data-param="ParamFade"]').count()).toBe(1);
    await poll(() => p.getByTestId('agent-indicator').textContent()).toContain('agent:test');
    // The agent poses the editor and reads Mochi2D's evaluation back.
    await p.evaluate(() => window.mochi.setPose({ ParamFade: 1 }));
    const d = await p.evaluate(() => window.mochi.evaluate().drawables[0]!);
    expect(d.opacity).toBeCloseTo(0, 5);
    // Diffs and describe work as in the agent API.
    const diff = await p.evaluate(() => window.mochi.diff(0));
    expect(diff.added.map((a) => a.kind)).toEqual(['parameter']);
    expect(await p.evaluate(() => window.mochi.describe('mesh.moveVertices').name)).toBe(
      'mesh.moveVertices',
    );
    // A failing transaction leaves nothing behind.
    const failed = await p.evaluate(() => {
      try {
        window.mochi.transact('bad', (tx) => tx.param.delete({ target: '@param:Nope' }));
        return null;
      } catch (e) {
        return window.mochi.errorJson(e);
      }
    });
    expect(failed?.category).toBe('invalid_arguments');
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(1);
    // The person undoes the agent's change.
    await p.getByTestId('undo').click();
    await settled(p);
    expect(await p.locator('[data-param="ParamFade"]').count()).toBe(0);
    await p.close();
  }, 120_000);

  it('validates, runs the export check, and saves a project that opens again', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    await p.locator('[data-tab="validation"]').click();
    await p.getByTestId('export-check').click();
    await poll(() => status(p)).toContain('The export check passed');
    await p.evaluate(() =>
      window.mochi.transact('move', (tx) =>
        tx.mesh.moveVertices({ target: '@mesh:ArtMesh_Square', all: true, offset: [5, 0] }),
      ),
    );
    const download = p.waitForEvent('download');
    await p.locator('[data-menu="file"]').click();
    await p.getByTestId('menu-file.save').click();
    const file = await download;
    const chunks: Buffer[] = [];
    for await (const c of (await file.createReadStream())!) chunks.push(c as Buffer);
    const zip = unzipSync(new Uint8Array(Buffer.concat(chunks)));
    expect(Object.keys(zip)).toContain('golden-1-keyforms.mochi/mochi-project.json');
    const doc = await p.evaluate(() => window.mochi.get('@mesh:ArtMesh_Square'));
    const files = Object.fromEntries(
      Object.entries(zip).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
    );
    const reopened = await p.evaluate(async (f) => {
      const files = Object.fromEntries(
        Object.entries(f).map(([k, v]) => [k, Uint8Array.from(atob(v), (c) => c.charCodeAt(0))]),
      );
      await window.mochiEditor.openFiles(files);
      return window.mochi.get('@mesh:ArtMesh_Square');
    }, files);
    expect(reopened).toEqual(doc);
    await p.close();
  }, 120_000);

  // Timings: MOCHI_MAKER_BENCH=1.
  it.runIf(process.env.MOCHI_MAKER_BENCH === '1')(
    'benchmark: rebuilds and drags on golden 1 and the synthetic project',
    async () => {
      const { syntheticProject } = await import('../../export/test/synthetic.js');
      const { MemoryFileSystem, saveProject } = await import('@mochi-maker/core');
      const { openFiles } = await import('./harness.js');
      const p = await page();
      const lines: string[] = [];
      // A drag driven from inside the page: one pointer move per animation frame, so the frame
      // times include the editor's patch and evaluation and Mochi2D's drawing.
      const drag = async (uid: string, n: number) => {
        await p.evaluate(() => window.mochiEditor.viewport.dragFrames.splice(0));
        await p.evaluate((u) => window.mochi.select(u), uid);
        const [x, y] = await vertexClient(p, uid, 0);
        const frameTimes = await p.evaluate(
          async ({ x, y, n }) => {
            const el = window.mochiEditor.viewport.overlay;
            const fire = (type: string, cx: number, cy: number) =>
              el.dispatchEvent(
                new PointerEvent(type, {
                  clientX: cx,
                  clientY: cy,
                  button: 0,
                  buttons: 1,
                  pointerId: 1,
                  bubbles: true,
                }),
              );
            fire('pointerdown', x, y);
            const times: number[] = [];
            let last = performance.now();
            for (let i = 1; i <= n; i++) {
              await new Promise((r) => requestAnimationFrame(r));
              fire('pointermove', x + i, y + i / 2);
              const t = performance.now();
              times.push(t - last);
              last = t;
            }
            fire('pointerup', x + n, y + n / 2);
            return times.slice(1);
          },
          { x, y, n },
        );
        await settled(p);
        const work = await p.evaluate(() => window.mochiEditor.viewport.dragFrames.slice());
        const commit = (await p.evaluate(() => window.mochi.stats().builds)).at(-1)!;
        const med = (xs: number[]) =>
          xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
        const p90 = (xs: number[]) =>
          xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] ?? NaN;
        const r1 = (v: number) => Math.round(v * 10) / 10;
        return {
          frames: frameTimes.length,
          fps: r1(1000 / med(frameTimes)),
          frameMedian: r1(med(frameTimes)),
          frameP90: r1(p90(frameTimes)),
          patchAndEvaluate: { median: r1(med(work)), p90: r1(p90(work)) },
          commit: {
            mode: commit.mode,
            patches: commit.patches,
            total: r1(commit.total),
            lower: r1(commit.timings.lower),
          },
        };
      };
      const rebuild = async () => {
        const before = await p.evaluate(() => window.mochi.stats().builds.length);
        await p.evaluate(() =>
          window.mochi.transact('nudge', (tx) =>
            tx.mesh.moveVertices({ target: '@mesh:ArtMesh0', all: true, offset: [1, 0] }),
          ),
        );
        await settled(p);
        return p.evaluate((n) => window.mochi.stats().builds.slice(n), before);
      };
      const g1 = await golden1();
      await openGolden(p, g1.name);
      await settled(p);
      const open1 = (await p.evaluate(() => window.mochi.stats().builds))[0]!;
      lines.push(`golden 1 open: ${JSON.stringify(open1)}`);
      const d1 = await drag(await meshUid(p, 'ArtMesh_Square'), 60);
      lines.push(`golden 1 drag: ${JSON.stringify(d1)}`);

      const big = await syntheticProject();
      const fs = new MemoryFileSystem();
      await saveProject(fs, 'p', big.session.doc, big.assets);
      const files = Object.fromEntries(
        [...fs.files].filter(([k]) => k.startsWith('p/')).map(([k, v]) => [k.slice(2), v]),
      );
      const t0 = Date.now();
      await openFiles(p, files, 'synthetic');
      await settled(p);
      lines.push(
        `synthetic open: ${Date.now() - t0} ms in all; first build ${JSON.stringify((await p.evaluate(() => window.mochi.stats().builds)).at(-1))}`,
      );
      for (let i = 0; i < 3; i++)
        lines.push(`synthetic rebuild: ${JSON.stringify(await rebuild())}`);
      // A structural edit: a vertex added (Mochi2D replaces the data and keeps the textures).
      const nBuilds = await p.evaluate(() => window.mochi.stats().builds.length);
      await p.evaluate(() =>
        window.mochi.transact('add a vertex', (tx) =>
          tx.mesh.addVertices({ target: '@mesh:ArtMesh0', points: [[20, 20]] }),
        ),
      );
      await settled(p);
      lines.push(
        `synthetic structural edit: ${JSON.stringify(await p.evaluate((n) => window.mochi.stats().builds.slice(n), nBuilds))}`,
      );
      const d2 = await drag(await meshUid(p, 'ArtMesh0'), 40);
      lines.push(`synthetic drag: ${JSON.stringify(d2)}`);
      console.log(lines.join('\n'));
      await p.close();
    },
    600_000,
  );
});
