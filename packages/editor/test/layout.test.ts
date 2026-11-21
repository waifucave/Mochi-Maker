/**
 * The familiar layout: the frame, docking and workspaces, view tabs, keys
 * and their rebinding, navigation, selection, the transform box and rotation handles, mesh
 * editing, and the warnings at the point of action. Headless Chromium through Playwright; skipped
 * where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
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

async function page(home = false): Promise<Page> {
  const p = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  (p as unknown as { errors: string[] }).errors = errors;
  await p.goto(home ? url : `${url}?nohome`);
  await p.waitForFunction(() => window.mochi !== undefined);
  return p;
}
const errorsOf = (p: Page) => (p as unknown as { errors: string[] }).errors;
const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 30_000 });
const settled = (p: Page) => p.evaluate(() => window.mochi.settled());
const status = (p: Page) => p.getByTestId('status').textContent();
const statusCode = (p: Page) => p.getByTestId('status').getAttribute('data-code');
/** The tip in Tool Details (tips no longer cover the canvas). */
const tipCode = (p: Page) => p.getByTestId('tip').getAttribute('data-code');
const uidOf = (p: Page, ref: string) =>
  p.evaluate((r) => (window.mochi.get(r) as { uid: string }).uid, ref);
const center = async (p: Page, selector: string) => {
  const b = (await p.locator(selector).first().boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2] as const;
};
/** Page coordinates of a mesh's evaluated vertex. */
const vertexClient = (p: Page, uid: string, i: number) =>
  p.evaluate(
    ({ uid, i }) => {
      const vp = window.mochiEditor.viewport;
      const pts = vp.meshScreen(uid)!;
      const r = vp.overlay.getBoundingClientRect();
      return [r.left + pts[i]![0], r.top + pts[i]![1]] as [number, number];
    },
    { uid, i },
  );
const drag = async (p: Page, from: readonly [number, number], to: readonly [number, number]) => {
  await p.mouse.move(from[0], from[1]);
  await p.mouse.down();
  await p.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await p.mouse.move(to[0], to[1], { steps: 4 });
  await p.mouse.up();
};

const available = await launch().then(async (b) => {
  await b?.close();
  return b !== null;
});

describe.skipIf(!required && !available)('the familiar layout', () => {
  it('has the frame: menu bar, toolbar with the workspace switcher, View area, palettes', async () => {
    const p = await page(true);
    // Home opens at startup, and closes when a file opens.
    await poll(() => p.getByTestId('home').count()).toBe(1);
    await openGolden(p, 'golden-15-nested-deformers');
    await settled(p);
    expect(await p.getByTestId('home').count()).toBe(0);
    const menus = await p.locator('.menubar .menu-title').allTextContents();
    expect(menus).toEqual(['File', 'Edit', 'Show', 'Modeling', 'Animation', 'Window', 'Help']);
    // The workspace switcher is at the toolbar's left end.
    expect(await p.locator('.toolbar > *').first().getAttribute('data-testid')).toBe(
      'workspace-switcher',
    );
    expect(await p.getByTestId('workspace-switcher').inputValue()).toBe('modeling');
    // Parts at the upper left, Parameter below it on the left; the draw-order strip left of the canvas.
    const parts = (await p.locator('[data-tab="parts"]').boundingBox())!;
    const param = (await p.locator('[data-tab="parameter"]').boundingBox())!;
    const canvas = (await p.getByTestId('overlay').boundingBox())!;
    const strip = (await p.getByTestId('draw-strip').boundingBox())!;
    expect(parts.x).toBeLessThan(canvas.x);
    expect(parts.y).toBeLessThan(param.y);
    expect(param.x).toBeLessThan(canvas.x);
    expect(strip.x + strip.width).toBeLessThanOrEqual(canvas.x + 1);
    // The palettes, the familiar ones and Mochi Maker's own, in the Window menu.
    await p.locator('[data-menu="window"]').click();
    for (const id of [
      'parts',
      'deformer',
      'parameter',
      'inspector',
      'toolDetails',
      'project',
      'log',
      'timeline',
      'scene',
    ])
      expect(await p.getByTestId(`menu-window.palette.${id}`).count()).toBe(1);
    await p.keyboard.press('Escape');
    await p.mouse.click(10, 880);
    // Terms the users see.
    await p.evaluate(() => window.mochi.select('@mesh:ArtMesh_Face'));
    expect(await p.getByTestId('inspector-kind').textContent()).toContain('ArtMesh');
    await p.evaluate(() => window.mochi.select('@warp:Warp_Face'));
    expect(await p.getByTestId('inspector-kind').textContent()).toContain('Warp Deformer');
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('docks palettes: as a tab, between groups, floating; layouts per workspace, with a reset', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const groupOf = (id: string) => p.evaluate((i) => window.mochiEditor.dock.find(i), id);
    // History onto the Inspector's group: it joins as a tab.
    await drag(
      p,
      await center(p, '[data-tab="history"]'),
      await center(p, '.dock-group:has([data-tab="inspector"])'),
    );
    expect(await groupOf('history')).toEqual(await groupOf('inspector'));
    // Log to the top edge of the Parameter group: a new group, inserted before it.
    const param = (await p.locator('.dock-group:has([data-tab="parameter"])').boundingBox())!;
    await drag(p, await center(p, '[data-tab="log"]'), [param.x + param.width / 2, param.y + 8]);
    const log = await groupOf('log');
    const par = await groupOf('parameter');
    expect(log!.region).toBe('left');
    expect(log!.group).toBe(par!.group - 1);
    // Validation over the View area: it floats.
    await drag(p, await center(p, '[data-tab="validation"]'), [700, 400]);
    expect((await groupOf('validation'))!.region).toBe('floating');
    // The floating window takes another palette as a tab.
    await drag(p, await center(p, '[data-tab="agents"]'), await center(p, '.floating'));
    expect(await groupOf('agents')).toEqual(await groupOf('validation'));
    // Dragging the empty strip of a group moves the whole group (here: onto the right region).
    const before = await p.evaluate(() => window.mochiEditor.dock.layout.right.groups.length);
    const tools = (await p
      .locator('.dock-group:has([data-tab="toolDetails"]) .group-strip')
      .boundingBox())!;
    await drag(
      p,
      [tools.x + tools.width - 5, tools.y + tools.height / 2],
      await center(p, '.dock-group:has([data-tab="parts"])'),
    );
    expect(await groupOf('toolDetails')).toEqual(await groupOf('parts'));
    expect(await p.evaluate(() => window.mochiEditor.dock.layout.right.groups.length)).toBe(
      before - 1,
    );
    // A tab's right-click menu closes it; the Window menu brings it back.
    await p.locator('[data-tab="scene"]').count(); // not shown in Modeling
    await p.locator('[data-tab="project"]').click({ button: 'right' });
    await p.getByTestId('tab-close').click();
    expect(await groupOf('project')).toBeNull();
    await p.locator('[data-menu="window"]').click();
    await p.getByTestId('menu-window.palette.project').click();
    expect(await groupOf('project')).not.toBeNull();

    // Each workspace keeps its own layout.
    const modeling = await p.evaluate(() => JSON.stringify(window.mochiEditor.dock.layout));
    await p.getByTestId('workspace-switcher').selectOption('animation');
    expect(await p.locator('[data-tab="timeline"]').count()).toBe(1);
    await p.getByTestId('workspace-switcher').selectOption('modeling');
    expect(await p.evaluate(() => JSON.stringify(window.mochiEditor.dock.layout))).toBe(modeling);
    // Hide all palettes, then bring them back.
    await p.evaluate(() => window.mochiEditor.keymap.run('window.hideAll'));
    expect(await p.locator('.dock-group').count()).toBe(0);
    await p.evaluate(() => window.mochiEditor.keymap.run('window.showAll'));
    expect(await p.locator('.dock-group').count()).toBeGreaterThan(0);
    // The layout survives a reload; Reset Current Layout restores the initial one.
    await p.reload();
    await p.waitForFunction(() => window.mochi !== undefined);
    expect(await groupOf('validation')).toMatchObject({ region: 'floating' });
    await p.locator('[data-menu="window"]').click();
    await p.getByTestId('menu-window.resetLayout').click();
    expect(await groupOf('validation')).toMatchObject({ region: 'bottom' });
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('switches workspace with the view tab, keeps a pose per tab, and has custom workspaces', async () => {
    const p = await page();
    await openGolden(p, 'golden-12-motions');
    await settled(p);
    const ws = () => p.getByTestId('workspace-switcher').inputValue();
    await p.evaluate(() => window.mochi.setPose({ P_Linear: 10 }));
    // A new Animation View switches to the Animation workspace.
    await p.keyboard.press('Control+Shift+n');
    expect(await ws()).toBe('animation');
    expect(await p.locator('.view-tab').count()).toBe(2);
    // Each tab keeps its own parameter values.
    await p.evaluate(() => window.mochi.setPose({ P_Linear: -20 }));
    await p.locator('.view-tab').first().click();
    expect(await ws()).toBe('modeling');
    expect((await p.evaluate(() => window.mochi.pose())).P_Linear).toBe(10);
    await p.locator('.view-tab').nth(1).click();
    expect((await p.evaluate(() => window.mochi.pose())).P_Linear).toBe(-20);
    // Turned off in the settings, selecting a tab keeps the workspace.
    await p.evaluate(() => window.mochiEditor.settings.set('autoSwitchWorkspace', false));
    await p.locator('.view-tab').first().click();
    expect(await ws()).toBe('animation');
    // Ctrl+W closes the current tab; the last one stays.
    await p.keyboard.press('Control+w');
    expect(await p.locator('.view-tab').count()).toBe(1);
    await p.keyboard.press('Control+w');
    expect(await p.locator('.view-tab').count()).toBe(1);
    // A custom workspace from the current layout, in the switcher.
    await p.locator('[data-menu="window"]').click();
    await p.locator('.ctx-menu button', { hasText: 'Workspace ▸' }).click();
    await p.locator('.ctx-menu.submenu button', { hasText: 'Workspace Settings' }).click();
    await p.getByTestId('workspace-add').click();
    expect(await p.locator('body > .backdrop').count()).toBe(1);
    await p.keyboard.press('Escape');
    expect(await p.locator('body > .backdrop').count()).toBe(0);
    expect(await p.locator('[data-testid="workspace-switcher"] option').allTextContents()).toEqual([
      'Modeling',
      'Animation',
      'Workspace 3',
    ]);
    await p.close();
  }, 120_000);

  it('plays a motion in the Timeline palette', async () => {
    const p = await page();
    await openGolden(p, 'golden-12-motions');
    await settled(p);
    await p.getByTestId('workspace-switcher').selectOption('animation');
    const first = p.locator('[data-motion]').first();
    await first.click();
    expect(await p.locator('.track').count()).toBeGreaterThan(0);
    // End jumps to the end of the motion, Home to its start; the pose follows the curves.
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('End');
    const end = await p.evaluate(() => window.mochiEditor.playback.time);
    expect(end).toBeGreaterThan(0);
    await p.keyboard.press('Home');
    expect(await p.evaluate(() => window.mochiEditor.playback.time)).toBe(0);
    await p.keyboard.press('PageDown');
    expect(await p.evaluate(() => window.mochiEditor.playback.time)).toBeGreaterThan(0);
    await p.keyboard.press('Enter');
    await poll(() => p.evaluate(() => window.mochiEditor.playback.time)).toBeGreaterThan(0.1);
    await p.keyboard.press('Enter');
    expect(await p.evaluate(() => window.mochiEditor.playback.playing)).toBe(false);
    await p.close();
  }, 120_000);

  it('rebinds keys, warns about duplicates, exports and imports them; Command on macOS', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+Alt+Shift+K');
    await p.getByTestId('shortcut-search').fill('level edit 3');
    expect(await p.locator('.shortcut-row').count()).toBe(1);
    // Search by key, several words narrowing.
    await p.getByTestId('shortcut-search').fill('ctrl+e');
    expect(await p.locator('[data-action="mesh.toggle"]').count()).toBe(1);
    // Add a second key to Level Edit 3: Numpad3 (the keypad is a different key).
    await p.getByTestId('shortcut-search').fill('level edit 3');
    await p.getByTestId('add-key-level.3').click();
    await p.keyboard.press('Numpad3');
    expect(await p.evaluate(() => window.mochiEditor.keymap.keysOf('level.3'))).toEqual([
      '3',
      'Numpad3',
    ]);
    // A duplicate key is marked.
    await p.getByTestId('shortcut-search').fill('lasso');
    await p.getByTestId('add-key-tool.lasso').click();
    await p.keyboard.press('a');
    await poll(() => p.getByTestId('shortcut-message').textContent()).toContain(
      'more than one command',
    );
    expect(await p.locator('.key.conflict').count()).toBeGreaterThan(0);
    expect(await p.locator('body > .backdrop').count()).toBe(1);
    await p.keyboard.press('Escape');
    expect(await p.locator('body > .backdrop').count()).toBe(0);
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Numpad3');
    expect(await p.evaluate(() => window.mochiEditor.editor.level)).toBe(3);
    // Export and import: the file is platform-neutral.
    const file = await p.evaluate(() => window.mochiEditor.keymap.exportFile());
    expect(file.bindings['level.3']).toEqual(['3', 'Numpad3']);
    await p.evaluate(() => window.mochiEditor.keymap.resetAll());
    expect(await p.evaluate(() => window.mochiEditor.keymap.keysOf('level.3'))).toEqual(['3']);
    await p.evaluate((f) => window.mochiEditor.keymap.importFile(f), file);
    expect(await p.evaluate(() => window.mochiEditor.keymap.keysOf('level.3'))).toEqual([
      '3',
      'Numpad3',
    ]);
    // Only changes are stored: a later version's new default keys appear without a reset.
    const stored = await p.evaluate(() => localStorage.getItem('mochi-maker.shortcuts'));
    expect(Object.keys(JSON.parse(stored!))).toEqual(
      expect.arrayContaining(['level.3', 'tool.lasso']),
    );
    expect(Object.keys(JSON.parse(stored!))).not.toContain('edit.undo');
    // On macOS, Command stands in for Ctrl.
    await p.evaluate(() =>
      window.mochi.transact(
        'nudge',
        (tx) => tx.mesh.moveVertices({ target: '@mesh:ArtMesh_Square', all: true, offset: [1, 0] }),
        { author: 'person' },
      ),
    );
    await p.evaluate(() => (window.mochiEditor.keymap.mac = true));
    expect(await p.evaluate(() => window.mochiEditor.keymap.shortcut('edit.undo'))).toBe('⌘Z');
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Meta+z');
    await settled(p);
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(0);
    await p.close();
  }, 120_000);

  it('navigates: flip, rotate, pan along one axis, fit, levels and tools', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const vp = () =>
      p.evaluate(() => ({
        ...window.mochiEditor.viewport.view.viewTransform,
        flipped: window.mochiEditor.viewport.flipped,
      }));
    await p.getByTestId('overlay').focus();
    // R tapped flips the canvas; overlays still land on the vertices.
    await p.keyboard.press('r');
    expect((await vp()).flipped).toBe(true);
    const uid = await uidOf(p, '@mesh:ArtMesh_Square');
    const [x, y] = await vertexClient(p, uid, 0);
    // The vertex drawn at (x, y) on the flipped canvas is hit by a click at its mirrored place.
    const hit = await p.evaluate(
      ({ x, y }) => {
        const vp = window.mochiEditor.viewport;
        const r = vp.root.getBoundingClientRect();
        const [ux, uy] = vp.unflip(r.left + r.right - x, y);
        return [ux, uy];
      },
      { x, y },
    );
    expect(hit[0]).toBeCloseTo(x, 3);
    await p.keyboard.press('r');
    expect((await vp()).flipped).toBe(false);
    // R held and dragged turns the canvas; Ctrl+0 fits and clears it.
    const box = (await p.getByTestId('overlay').boundingBox())!;
    await p.keyboard.down('r');
    await drag(
      p,
      [box.x + box.width / 2 + 200, box.y + box.height / 2],
      [box.x + box.width / 2, box.y + box.height / 2 - 200],
    );
    await p.keyboard.up('r');
    expect(Math.abs((await vp()).rotation)).toBeGreaterThan(45);
    expect((await vp()).flipped).toBe(false); // a drag is not a tap
    await p.keyboard.press('Control+0');
    expect((await vp()).rotation).toBe(0);
    // View controls: full scale shows canvas pixels as screen pixels.
    await p.getByTestId('full-scale').click();
    const ppu = await p.evaluate(
      () => window.mochiEditor.editor.view.project().canvas.pixelsPerUnit,
    );
    expect((await vp()).pixelsPerUnit).toBeCloseTo(ppu, 3);
    await poll(() => p.getByTestId('zoom').inputValue()).toBe('100');
    await p.getByTestId('zoom').fill('50');
    await p.getByTestId('zoom').press('Enter');
    expect((await vp()).pixelsPerUnit).toBeCloseTo(ppu / 2, 3);
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+0');
    // Space+Shift+drag pans along the first direction only.
    const t0 = await vp();
    await p.keyboard.down('Space');
    await p.keyboard.down('Shift');
    await drag(p, [box.x + 300, box.y + 300], [box.x + 420, box.y + 330]);
    await p.keyboard.up('Shift');
    await p.keyboard.up('Space');
    const t1 = await vp();
    expect(t1.x).not.toBe(t0.x);
    expect(t1.y).toBe(t0.y);
    // Levels and tools.
    await p.keyboard.press('1');
    expect(await p.evaluate(() => window.mochiEditor.editor.level)).toBe(1);
    await p.keyboard.press('2');
    expect(await p.getByTestId('level-2').getAttribute('class')).toContain('on');
    await p.keyboard.press('l');
    expect(await p.evaluate(() => window.mochiEditor.viewport.tool)).toBe('lasso');
    await p.keyboard.press('a');
    expect(await p.evaluate(() => window.mochiEditor.viewport.tool)).toBe('arrow');
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('selects, locks and hides: Shift+click, Ctrl+A, the Ctrl+2 and Ctrl+3 families', async () => {
    const p = await page();
    await openGolden(p, 'golden-15-nested-deformers');
    await settled(p);
    const face = await uidOf(p, '@mesh:ArtMesh_Face');
    const badge = await uidOf(p, '@mesh:ArtMesh_Badge');
    const at = async (uid: string) => {
      const pts = await Promise.all([0, 1, 2].map((i) => vertexClient(p, uid, i)));
      return [
        (pts[0]![0] + pts[1]![0] + pts[2]![0]) / 3,
        (pts[0]![1] + pts[1]![1] + pts[2]![1]) / 3,
      ] as const;
    };
    const fc = await at(face);
    await p.mouse.click(fc[0], fc[1]);
    const bc = await at(badge);
    await p.keyboard.down('Shift');
    await p.mouse.click(bc[0], bc[1]);
    await p.keyboard.up('Shift');
    expect((await p.evaluate(() => window.mochi.selection().uids)).sort()).toEqual(
      [badge, face].sort(),
    );
    // Ctrl+2 locks the selection: a locked mesh can't be picked on the canvas.
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+2');
    await p.keyboard.press('Escape');
    await p.mouse.click(bc[0], bc[1]);
    expect(await p.evaluate(() => window.mochi.selection().uids)).not.toContain(badge);
    // Ctrl+A leaves locked objects out.
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+a');
    const all = await p.evaluate(() => window.mochi.selection().uids);
    expect(all).not.toContain(badge);
    expect(all).not.toContain(face);
    expect(all.length).toBeGreaterThan(0);
    await p.keyboard.press('Control+Alt+2');
    // Ctrl+3 hides: the view stops drawing it; the document is unchanged.
    await p.evaluate((u) => window.mochi.select(u), badge);
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+3');
    await settled(p);
    const shown = await p.evaluate(() => window.mochi.evaluate().drawables);
    expect(shown.find((d) => d.uid === badge)!.visible).toBe(false);
    expect(
      (await p.evaluate((u) => window.mochi.get(u), badge)) as { enabled: boolean },
    ).toMatchObject({ enabled: true });
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(0);
    await p.keyboard.press('Control+Alt+3');
    await settled(p);
    expect(
      (await p.evaluate(() => window.mochi.evaluate().drawables)).find((d) => d.uid === badge)!
        .visible,
    ).toBe(true);
    // In the Parts palette: hide by its toggle, Ctrl+click a row toggles it in the selection.
    await p.locator(`[data-palette="parts"] .row[data-uid="${face}"] [data-toggle="hide"]`).click();
    expect(await p.evaluate((u) => window.mochiEditor.editor.isHidden(u), face)).toBe(true);
    await p
      .locator(`[data-palette="parts"] .row[data-uid="${face}"] .name`)
      .click({ modifiers: ['Control'] });
    expect(await p.evaluate(() => window.mochi.selection().uids)).toEqual([badge, face]);
    // A right-click on a nested mesh lists its parent deformers.
    await p.evaluate((u) => window.mochiEditor.editor.setHidden([u], false), face);
    await settled(p);
    const fc2 = await at(face);
    await p.mouse.click(fc2[0], fc2[1], { button: 'right' });
    await p.getByTestId('ancestor-Warp_Face').click();
    expect(await p.evaluate(() => window.mochi.selection().uid)).toBe(
      await uidOf(p, '@warp:Warp_Face'),
    );
    // Ctrl+D selects the parent deformer.
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+d');
    expect(await p.evaluate(() => window.mochi.selection().uid)).toBe(
      await uidOf(p, '@rotation:Rotation_Head'),
    );
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('transforms with the box (levels 2 and 3) and turns rotation deformers by their handle', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const sq = await uidOf(p, '@mesh:ArtMesh_Square');
    await p.evaluate((u) => window.mochi.select(u), sq);
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('3');
    const before = await Promise.all([0, 1, 2, 3].map((i) => vertexClient(p, sq, i)));
    const cx = before.reduce((s, v) => s + v[0], 0) / 4;
    const cy = before.reduce((s, v) => s + v[1], 0) / 4;
    // Inside the box: the whole mesh moves.
    await drag(p, [cx, cy], [cx + 40, cy + 10]);
    await settled(p);
    const moved = await Promise.all([0, 1, 2, 3].map((i) => vertexClient(p, sq, i)));
    moved.forEach((v, i) => {
      expect(v[0] - before[i]![0]).toBeCloseTo(40, 0);
      expect(v[1] - before[i]![1]).toBeCloseTo(10, 0);
    });
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Transform');
    // A corner scales about the opposite corner; Shift keeps proportions.
    const xs = moved.map((v) => v[0]);
    const ys = moved.map((v) => v[1]);
    const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    await p.keyboard.down('Shift');
    await drag(p, [x1, y1], [x1 + (x1 - x0) / 2, y1 + 5]);
    await p.keyboard.up('Shift');
    await settled(p);
    const scaled = await Promise.all([0, 1, 2, 3].map((i) => vertexClient(p, sq, i)));
    const sx =
      (Math.max(...scaled.map((v) => v[0])) - Math.min(...scaled.map((v) => v[0]))) / (x1 - x0);
    const sy =
      (Math.max(...scaled.map((v) => v[1])) - Math.min(...scaled.map((v) => v[1]))) / (y1 - y0);
    expect(sx).toBeCloseTo(1.5, 1);
    expect(sy).toBeCloseTo(1.5, 1);
    expect(Math.min(...scaled.map((v) => v[0]))).toBeCloseTo(x0, 0);
    await p.keyboard.press('2');
    await p.close();

    // A rotation deformer's handle: the handle follows the pointer around the origin.
    const q = await page();
    await openGolden(q, 'golden-15-nested-deformers');
    await settled(q);
    const rot = await uidOf(q, '@rotation:Rotation_Head');
    await q.evaluate((u) => window.mochi.select(u), rot);
    const handles = () =>
      q.evaluate((u) => {
        const vp = window.mochiEditor.viewport;
        const r = vp.overlay.getBoundingClientRect();
        return vp.rotationHandles(u)!.map(([x, y]) => [r.left + x, r.top + y] as [number, number]);
      }, rot);
    const [o, tip] = await handles();
    const a0 = Math.atan2(tip![1] - o![1], tip![0] - o![0]);
    const target: [number, number] = [
      o![0] + 60 * Math.cos(a0 + 0.5),
      o![1] + 60 * Math.sin(a0 + 0.5),
    ];
    await drag(q, tip!, target);
    await settled(q);
    expect(await q.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Rotate');
    const [o2, tip2] = await handles();
    const a1 = Math.atan2(tip2![1] - o2![1], tip2![0] - o2![0]);
    expect(a1 - a0).toBeCloseTo(0.5, 1);
    expect(errorsOf(q)).toEqual([]);
    await q.close();
  }, 180_000);

  it('Ctrl-drags a deformer without its contents; a plain drag moves them, with a tip', async () => {
    const p = await page();
    await openGolden(p, 'golden-15-nested-deformers');
    await settled(p);
    const face = await uidOf(p, '@mesh:ArtMesh_Face');
    const warp = await uidOf(p, '@warp:Warp_Face');
    await p.evaluate((u) => window.mochi.select(u), warp);
    const handle = () =>
      p.evaluate((u) => {
        const vp = window.mochiEditor.viewport;
        const r = vp.overlay.getBoundingClientRect();
        const h = vp.deformerHandles(u)![0]!;
        return [r.left + h[0], r.top + h[1]] as [number, number];
      }, warp);
    const v0 = await vertexClient(p, face, 0);
    // Plain: the contents move along, and a tip says how to avoid it.
    await p.keyboard.press('1');
    await drag(p, await handle(), [(await handle())[0] - 20, (await handle())[1] - 15]);
    await settled(p);
    expect(await tipCode(p)).toBe('tip:ctrl-deformer');
    expect(await statusCode(p)).not.toBe('tip:ctrl-deformer');
    const v1 = await vertexClient(p, face, 0);
    expect(Math.hypot(v1[0] - v0[0], v1[1] - v0[1])).toBeGreaterThan(0.5);
    // Ctrl: the warp changes, the face stays where it is.
    const h = await handle();
    await p.keyboard.down('Control');
    await drag(p, h, [h[0] + 25, h[1] + 20]);
    await p.keyboard.up('Control');
    await settled(p);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe(
      'Move grid points (contents stay)',
    );
    const v2 = await vertexClient(p, face, 0);
    expect(Math.hypot(v2[0] - v1[0], v2[1] - v1[1])).toBeLessThan(0.6);
    const h2 = await handle();
    expect(Math.hypot(h2[0] - h[0] - 25, h2[1] - h[1] - 20)).toBeLessThan(0.6);
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('warns at the point of action: default forms, one key, "@" in IDs, children outside', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const sq = await uidOf(p, '@mesh:ArtMesh_Square');
    await p.evaluate((u) => window.mochi.select(u), sq);
    // ParamA defaults to 0: editing there changes the default form. A tip says so once.
    await p.getByTestId('kf-opacity').fill('0.5');
    await p.getByTestId('kf-opacity').press('Enter');
    await settled(p);
    expect(await tipCode(p)).toBe('tip:default-form');
    // Closed with ×, it stays in the Log.
    await p.getByTestId('tip-close').click();
    expect(await p.getByTestId('tip').count()).toBe(0);
    // With Lock Default Forms on (Ctrl+Shift+1), it is refused.
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Control+Shift+Digit1');
    expect(await p.getByTestId('default-locked').count()).toBe(1);
    const n = await p.evaluate(() => window.mochi.history().length);
    await p.getByTestId('kf-opacity').fill('0.25');
    await p.getByTestId('kf-opacity').press('Enter');
    expect(await statusCode(p)).toBe('E_DEFAULT_LOCKED');
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(n);
    // At the other key it works.
    await p.evaluate(() => window.mochi.setPose({ ParamA: 1 }));
    await p.getByTestId('kf-opacity').fill('0.25');
    await p.getByTestId('kf-opacity').press('Enter');
    expect(await p.evaluate(() => window.mochi.history().length)).toBe(n + 1);
    await p.keyboard.press('Control+Shift+Digit1');
    // A binding with one key is flagged.
    await p.evaluate(() =>
      window.mochi.transact(
        'one key',
        (tx) => {
          const q = tx.param.create({
            exportId: 'ParamOne',
            min: 0,
            max: 1,
            default: 0,
            keys: [0, 1],
          });
          tx.rig.addBinding({ target: '@mesh:ArtMesh_Square', parameter: q.uid, keys: [1] });
        },
        { author: 'person' },
      ),
    );
    await poll(() => p.getByTestId('one-key').count()).toBe(1);
    // "+2 keys" on the Parameter palette adds keys at both ends for the selection.
    await p.locator('[data-param="ParamOne"] .pname').click();
    await p.getByTestId('add-two-keys').click();
    await poll(() => p.getByTestId('one-key').count()).toBe(0);
    // "@" in a parameter ID.
    await p.getByTestId('param-create').click();
    await p.getByTestId('param-id').fill('Param@X');
    expect(await p.getByTestId('param-warning').textContent()).toContain('"@"');
    expect(await p.locator('body > .backdrop').count()).toBe(1);
    await p.keyboard.press('Escape');
    expect(await p.locator('body > .backdrop').count()).toBe(0);
    // A child outside its parent warp (golden 15's bent warp after moving a vertex far out).
    await openGolden(p, 'golden-15-nested-deformers');
    await settled(p);
    await p.evaluate(() => window.mochi.select('@mesh:ArtMesh_Face'));
    const face = await uidOf(p, '@mesh:ArtMesh_Face');
    const v = await vertexClient(p, face, 0);
    await drag(p, v, [v[0] - 160, v[1] - 160]);
    await settled(p);
    await poll(() => statusCode(p)).toBe('warn:outside-parent');
    expect(await status(p)).toContain('ArtMesh_Face sticks out of its parent warp Warp_Face');
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('edits meshes: Esc cancels the changes; moving a vertex keeps the image in place', async () => {
    const p = await page();
    await openGolden(p, 'golden-1-keyforms');
    await settled(p);
    const sq = await uidOf(p, '@mesh:ArtMesh_Square');
    // A double-click on an ArtMesh enters mesh editing.
    const pts = await Promise.all([0, 2].map((i) => vertexClient(p, sq, i)));
    await p.mouse.dblclick((pts[0]![0] + pts[1]![0]) / 2, (pts[0]![1] + pts[1]![1]) / 2);
    expect(await p.evaluate(() => window.mochiEditor.editor.meshEdit?.uids)).toEqual([sq]);
    expect(await p.locator('.menubar .menu-title', { hasText: 'Mesh Edit mode' }).count()).toBe(1);
    const before = (await p.evaluate((u) => window.mochi.get(u), sq)) as {
      uv: number[][];
      rig: { keyforms: { positions: number[][] }[] };
    };
    const v = await vertexClient(p, sq, 0);
    await drag(p, v, [v[0] + 12, v[1] + 8]);
    await settled(p);
    const after = (await p.evaluate((u) => window.mochi.get(u), sq)) as typeof before;
    // Every keyform moved by the same offset, and the texture coordinates followed.
    const d0 = after.rig.keyforms[0]!.positions[0]![0]! - before.rig.keyforms[0]!.positions[0]![0]!;
    const d1 = after.rig.keyforms[1]!.positions[0]![0]! - before.rig.keyforms[1]!.positions[0]![0]!;
    expect(d0).toBeGreaterThan(1);
    expect(d1).toBeCloseTo(d0, 3);
    expect(after.uv[0]![0]! - before.uv[0]![0]!).not.toBe(0);
    // Esc cancels: back to how it was, and out of mesh editing.
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('Escape');
    await settled(p);
    expect(await p.evaluate(() => window.mochiEditor.editor.meshEdit)).toBeNull();
    expect(await p.evaluate((u) => window.mochi.get(u), sq)).toEqual(before);
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('sets draw order on the strip, and creates a rotation deformer by dragging', async () => {
    const p = await page();
    await openGolden(p, 'golden-3-drawing');
    await settled(p);
    const mesh = (await p.evaluate(() => window.mochi.query({ kind: 'artMesh' }))) as unknown as {
      items?: { uid: string }[];
    };
    const uid =
      mesh.items?.[0]?.uid ??
      (await p.evaluate(() => window.mochiEditor.editor.view.ofKind('artMesh')[0]!.uid));
    await p.evaluate((u) => window.mochi.select(u), uid);
    const mark = (await p.locator(`[data-mark="${uid}"]`).boundingBox())!;
    const strip = (await p.locator('.draw-scale').boundingBox())!;
    await drag(
      p,
      [mark.x + mark.width / 2, mark.y + mark.height / 2],
      [mark.x + mark.width / 2, strip.y + strip.height * 0.1],
    );
    await settled(p);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe('Draw order');
    const k = (await p.evaluate((u) => window.mochi.get(u), uid)) as {
      rig: { keyforms: { drawOrder: number }[] };
    };
    expect(k.rig.keyforms.some((x) => Math.abs(x.drawOrder - 900) < 15)).toBe(true);
    // The drag-to-create rotation tool: pivot at the press, Standard Angle from the direction.
    await p.evaluate(() => window.mochiEditor.keymap.run('tool.rotation'));
    const box = (await p.getByTestId('overlay').boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await drag(p, [x, y], [x + 80, y]);
    await settled(p);
    expect(await p.evaluate(() => window.mochi.history().at(-1)!.label)).toBe(
      'Create rotation deformer',
    );
    const r = (await p.evaluate(() => window.mochi.get(window.mochi.selection().uid!))) as {
      kind: string;
      baseAngle: number;
    };
    expect(r.kind).toBe('rotation');
    expect(r.baseAngle).toBeCloseTo(-90, 0);
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);
});
