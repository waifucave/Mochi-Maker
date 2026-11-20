/**
 * The getting-started guide (docs/guide/), followed step by step in the editor as a
 * person would: the example PSD (guide-art.ts) imported, its meshes, five parameters, the standard
 * groups, two rotation deformers with keys, the eyes and the mouth keyed in the view, physics for
 * the hair, and the export, which then loads and moves in Mochi2D. With UPDATE_GUIDE=1 it also
 * writes the example PSD and the guide's screenshots into docs/guide/. Headless Chromium through
 * Playwright; skipped where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { MemoryFileSource, ModelRuntime } from 'mochi2d/headless';
import { buildEditor, launch, serve, type Browser, type Page } from './harness.js';
import { IDLE_MOTION, examplePsd } from './guide-art.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
const UPDATE = process.env.UPDATE_GUIDE === '1';
const GUIDE = fileURLToPath(new URL('../../../docs/guide/', import.meta.url));
/** The README's own screenshots (the others are the guide's). */
const README_IMG = fileURLToPath(new URL('../../../docs/img/', import.meta.url));
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

const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 30_000 });
const settled = (p: Page) => p.evaluate(() => window.mochi.settled());

/** A screenshot for the guide (only with UPDATE_GUIDE=1): the page, or one element of it. */
async function shot(
  p: Page,
  name: string,
  testid?: string,
  dir = join(GUIDE, 'img'),
): Promise<void> {
  if (!UPDATE) return;
  await settled(p);
  await new Promise((r) => setTimeout(r, 200));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  if (testid) {
    // A clip of the page: elements that re-render would not hold still for an element shot.
    const el =
      testid === 'inspector' ? p.locator('section.inspector').first() : p.getByTestId(testid);
    await p.screenshot({ path, clip: (await el.boundingBox())! });
  } else await p.screenshot({ path });
}

const uidOf = (p: Page, ref: string) =>
  p.evaluate((r) => (window.mochi.get(r) as { uid: string }).uid, ref);
/** The client-space box of a mesh as drawn now. */
const meshBox = (p: Page, uid: string) =>
  p.evaluate((u) => {
    const vp = window.mochiEditor.viewport;
    const pts = vp.meshScreen(u)!;
    const r = vp.overlay.getBoundingClientRect();
    const xs = pts.map((q) => r.left + q[0]);
    const ys = pts.map((q) => r.top + q[1]);
    return {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    };
  }, uid);
const drag = async (
  p: Page,
  from: readonly [number, number],
  to: readonly [number, number],
  modifier?: 'Alt' | 'Control',
) => {
  await p.mouse.move(from[0], from[1]);
  if (modifier) await p.keyboard.down(modifier);
  await p.mouse.down();
  await p.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await p.mouse.move(to[0], to[1], { steps: 4 });
  await p.mouse.up();
  if (modifier) await p.keyboard.up(modifier);
};

/** The selected rotation deformer's origin handle, in client space. */
const pivot = (p: Page) =>
  p.evaluate(() => {
    const vp = window.mochiEditor.viewport;
    const o = vp.rotationHandles(window.mochiEditor.editor.selection.uid!)![0];
    const r = vp.overlay.getBoundingClientRect();
    return [r.left + o[0], r.top + o[1]] as [number, number];
  });

/** New… on the Parameter palette: a standard parameter picked from the list. */
async function newParameter(
  p: Page,
  name: string,
  id: string,
  [min, def, max]: [number, number, number],
): Promise<void> {
  await p.getByTestId('param-create').click();
  await p.getByTestId('param-standard').selectOption(id);
  // The standard list fills in the ID, name and range.
  expect(
    await Promise.all(
      ['param-id', 'param-name', 'param-min', 'param-default', 'param-max'].map((t) =>
        p.getByTestId(t).inputValue(),
      ),
    ),
  ).toEqual([id, name, String(min), String(def), String(max)]);
  if (id === 'ParamEyeLOpen') await shot(p, '03-new-parameter', 'new-parameter');
  await p.getByTestId('param-create-ok').click();
  await p.locator(`[data-param="${id}"]`).waitFor();
}

/** Picks a parameter for the key buttons (objects are selected) and adds keys. */
async function addKeys(p: Page, id: string, count: 2 | 3): Promise<void> {
  await p.locator(`[data-param="${id}"] .pname`).click();
  await p.getByTestId(count === 2 ? 'add-two-keys' : 'add-three-keys').click();
  await settled(p);
}

/** Types a keyform field in the Inspector at the current pose. */
async function keyform(p: Page, field: string, value: number): Promise<void> {
  await p.getByTestId(`kf-${field}`).fill(String(value));
  await p.getByTestId(`kf-${field}`).press('Enter');
  await settled(p);
}

describe('the getting-started guide', () => {
  it('goes from a layered PSD to a model that loads and moves in Mochi2D', async () => {
    if (!browser) return;
    const psd = examplePsd();
    if (UPDATE) {
      await mkdir(join(GUIDE, 'img'), { recursive: true });
      await writeFile(join(GUIDE, 'mochi.psd'), psd);
    }
    const p = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);

    // 1. Import: File › Import Art. One ArtMesh per layer, with an automatic mesh.
    await p.getByTestId('import-art').setInputFiles({
      name: 'mochi.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      buffer: Buffer.from(psd),
    });
    await poll(() =>
      p.evaluate(() => window.mochiEditor.editor.view.ofKind('artMesh').length),
    ).toBe(7);
    await p.evaluate(() => window.mochiEditor.keymap.run('view.fit'));
    await shot(p, '01-imported');
    // 2. The meshes: Show › Wireframes.
    await p.evaluate(() => window.mochiEditor.keymap.run('view.wireframes'));
    await shot(p, '02-meshes');
    await p.evaluate(() => window.mochiEditor.keymap.run('view.wireframes'));

    // 3. Parameters.
    await newParameter(p, 'Angle Z', 'ParamAngleZ', [-30, 0, 30]);
    await newParameter(p, 'Left eye open', 'ParamEyeLOpen', [0, 1, 1]);
    await newParameter(p, 'Right eye open', 'ParamEyeROpen', [0, 1, 1]);
    await newParameter(p, 'Mouth open', 'ParamMouthOpenY', [0, 0, 1]);
    await newParameter(p, 'Front hair sway', 'ParamHairFront', [-1, 0, 1]);

    // 4. The standard groups, on each parameter's Inspector.
    for (const [id, group] of [
      ['ParamEyeLOpen', 'eyeBlink'],
      ['ParamEyeROpen', 'eyeBlink'],
      ['ParamMouthOpenY', 'lipSync'],
    ] as const) {
      await p.evaluate(() => window.mochiEditor.editor.select(null));
      await p.locator(`[data-param="${id}"] .pname`).click();
      await p.getByTestId(`group-${group}`).check();
      await settled(p);
      if (id === 'ParamMouthOpenY') await shot(p, '04-groups', 'inspector');
    }
    expect(
      await p.evaluate(() => {
        const v = window.mochiEditor.editor.view;
        const ids = (us: string[]) => us.map((u) => v.getAs(u, 'parameter').exportId);
        const g = v.project().standardGroups;
        return [ids(g.eyeBlink), ids(g.lipSync)];
      }),
    ).toEqual([['ParamEyeLOpen', 'ParamEyeROpen'], ['ParamMouthOpenY']]);

    // 5. A rotation deformer for the head: select the head's meshes, Create Rotation Deformer.
    const head = await Promise.all(
      ['Face', 'Eye_R', 'Eye_L', 'Mouth', 'Hair_front', 'Hair_back'].map((n) =>
        uidOf(p, `@mesh:ArtMesh_${n}`),
      ),
    );
    await p.evaluate((us) => window.mochiEditor.editor.selectMany(us), head);
    await p.evaluate(() => window.mochiEditor.keymap.run('model.createRotation'));
    await p.getByTestId('deformer-id').fill('Rotation_Head');
    await shot(p, '05-create-rotation', 'create-deformer');
    await p.getByTestId('deformer-create').click();
    await poll(() =>
      p.evaluate(() => window.mochiEditor.editor.view.ofKind('rotation').length),
    ).toBe(1);
    // Its pivot at the neck (Ctrl+drag the origin: the contents stay), then the head tilt:
    // ParamAngleZ, three keys, ±10° at the ends.
    const face = await meshBox(p, head[0]!);
    const neck: [number, number] = [(face.x0 + face.x1) / 2, face.y1 - (face.y1 - face.y0) * 0.05];
    await drag(p, await pivot(p), neck, 'Control');
    await settled(p);
    await addKeys(p, 'ParamAngleZ', 3);
    await p.evaluate(() => window.mochi.setPose({ ParamAngleZ: -30 }));
    await keyform(p, 'angle', -10);
    await p.evaluate(() => window.mochi.setPose({ ParamAngleZ: 30 }));
    await keyform(p, 'angle', 10);
    await shot(p, '06-head-tilt');
    await p.evaluate(() => window.mochi.setPose({ ParamAngleZ: 0 }));

    // 6. A rotation deformer for the front hair, inside the head's: ParamHairFront, ±8°.
    await p.evaluate(
      (u) => window.mochiEditor.editor.selectMany([u]),
      await uidOf(p, '@mesh:ArtMesh_Hair_front'),
    );
    await p.evaluate(() => window.mochiEditor.keymap.run('model.createRotation'));
    await p.getByTestId('deformer-id').fill('Rotation_HairFront');
    await p.getByTestId('deformer-create').click();
    await poll(() =>
      p.evaluate(() => window.mochiEditor.editor.view.ofKind('rotation').length),
    ).toBe(2);
    await drag(
      p,
      await pivot(p),
      [(face.x0 + face.x1) / 2, face.y0 + (face.y1 - face.y0) * 0.05],
      'Control',
    );
    await settled(p);
    await addKeys(p, 'ParamHairFront', 3);
    await p.evaluate(() => window.mochi.setPose({ ParamHairFront: -1 }));
    await keyform(p, 'angle', -8);
    await p.evaluate(() => window.mochi.setPose({ ParamHairFront: 1 }));
    await keyform(p, 'angle', 8);
    await p.evaluate(() => window.mochi.setPose({ ParamHairFront: 0 }));

    // 7. The eyes: two keys each; shut, the eye's box squashed in the view (edit level 3, Alt-drag
    // the top corner down to scale about the center).
    for (const [mesh, param] of [
      ['Eye_L', 'ParamEyeLOpen'],
      ['Eye_R', 'ParamEyeROpen'],
    ] as const) {
      const eye = await uidOf(p, `@mesh:ArtMesh_${mesh}`);
      await p.evaluate((u) => window.mochiEditor.editor.selectMany([u]), eye);
      await addKeys(p, param, 2);
      await p.evaluate((id) => window.mochi.setPose({ [id]: 0 }), param);
      await settled(p);
      await p.keyboard.press('Digit3');
      const b = await meshBox(p, eye);
      await drag(p, [b.x0, b.y0], [b.x0, b.y0 + (b.y1 - b.y0) * 0.45], 'Alt');
      await settled(p);
      if (mesh === 'Eye_R') await shot(p, '07-eye-shut');
      await p.keyboard.press('Digit2');
      await p.evaluate((id) => window.mochi.setPose({ [id]: 1 }), param);
    }
    // 8. The mouth: two keys; open, the box stretched down.
    const mouth = await uidOf(p, '@mesh:ArtMesh_Mouth');
    await p.evaluate((u) => window.mochiEditor.editor.selectMany([u]), mouth);
    await addKeys(p, 'ParamMouthOpenY', 2);
    await p.evaluate(() => window.mochi.setPose({ ParamMouthOpenY: 1 }));
    await settled(p);
    await p.keyboard.press('Digit3');
    {
      const b = await meshBox(p, mouth);
      await drag(p, [b.x1, b.y1], [b.x1, b.y1 + (b.y1 - b.y0) * 0.6], 'Alt');
    }
    await settled(p);
    await shot(p, '08-mouth-open');
    await p.keyboard.press('Digit2');
    await p.evaluate(() => window.mochi.setPose({ ParamMouthOpenY: 0 }));

    // 9. Physics for the hair: Modeling › Physics…, a group fed by the head's tilt that swings
    // the front hair.
    await p.evaluate(() => window.mochiEditor.editor.select(null));
    await p.evaluate(() => window.mochiEditor.keymap.run('model.physics'));
    await p.getByTestId('physics').waitFor();
    await p.getByTestId('physics-new-name').fill('Hair');
    await p.getByTestId('physics-new-pendulum').selectOption('Two stages');
    await p.getByTestId('physics-add').click();
    await settled(p);
    await p.getByTestId('input-add').click();
    await settled(p);
    await p.getByTestId('input-param-0').selectOption({ label: 'Angle Z (ParamAngleZ)' });
    await settled(p);
    await p.getByTestId('output-add').click();
    await settled(p);
    await p
      .getByTestId('output-param-0')
      .selectOption({ label: 'Front hair sway (ParamHairFront)' });
    await settled(p);
    await shot(p, '09-physics', 'physics');
    expect(
      await p.evaluate(() => {
        const v = window.mochiEditor.editor.view;
        const s = v.ofKind('physicsSetting')[0]!;
        const id = (u: string) => v.getAs(u, 'parameter').exportId;
        return [s.inputs.map((x) => id(x.parameter)), s.outputs.map((x) => id(x.parameter))];
      }),
    ).toEqual([['ParamAngleZ'], ['ParamHairFront']]);
    await p.keyboard.press('Escape');

    // The sample model's idle motion (samples/mochi), and the README's Animation screenshot: the
    // Animation workspace with the motion in the Timeline, half-way through.
    await p.evaluate(() => window.mochiEditor.physics.close());
    await p.evaluate(
      (calls) => window.mochiEditor.editor.transact('Idle motion', calls),
      IDLE_MOTION,
    );
    await p.getByTestId('workspace-switcher').selectOption('animation');
    await p.evaluate(() => {
      const pb = window.mochiEditor.playback;
      pb.select(window.mochiEditor.editor.view.ofKind('motion')[0]!.uid);
      pb.changed();
      pb.seek(1.5);
    });
    expect(await p.evaluate(() => window.mochiEditor.playback.current?.name)).toBe('idle');
    await shot(p, 'animation', undefined, README_IMG);
    await p.getByTestId('workspace-switcher').selectOption('modeling');

    // 10. Export: File › Export as MOC3 File, a zip of the model's files.
    const [download] = await Promise.all([
      p.waitForEvent('download'),
      p.evaluate(() => window.mochiEditor.keymap.run('file.exportMoc')),
    ]);
    const zip = unzipSync(new Uint8Array(await readFile((await download.path())!)));
    const files = new Map(Object.entries(zip));
    expect([...files.keys()].filter((f) => !f.includes('/')).sort()).toEqual(
      expect.arrayContaining(['model.cdi3.json', 'model.moc3', 'model.model3.json']),
    );
    expect(errors).toEqual([]);
    await p.close();

    // 11. In Mochi2D: it loads, blinks, tilts, and the hair swings after the head.
    const stem = [...files.keys()].find((f) => f.endsWith('.model3.json'))!;
    const rt = await ModelRuntime.load(new MemoryFileSource('guide', files), stem);
    const ids = rt.parameters.map((x) => x.id);
    expect([...ids].sort()).toEqual(
      ['ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamHairFront', 'ParamMouthOpenY'].sort(),
    );
    rt.setParameter('ParamAngleZ', 30);
    let hair = 0;
    for (let i = 0; i < 60; i++) {
      rt.update(1 / 60);
      hair = Math.max(hair, Math.abs(rt.getParameter('ParamHairFront')));
    }
    expect(hair).toBeGreaterThan(0.05);
  }, 240_000);
});
