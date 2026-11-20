/**
 * The Timeline palette: the Dope Sheet and the Graph Editor switched with C,
 * keys inserted, moved, deleted, copied and pasted, keys from the sliders, «Paste Keyframes to
 * Selected Rows», «Adjust Spacing», «Reverse Keyframes», interpolation per segment, and playback.
 * Headless Chromium through Playwright; skipped where Chromium is missing, except in CI's render job.
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

const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 30_000 });

/** The motion «curves» of golden 12 open in the Animation workspace. */
async function open(): Promise<Page> {
  const p = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  (p as unknown as { errors: string[] }).errors = errors;
  await p.goto(`${url}?nohome`);
  await p.waitForFunction(() => window.mochi !== undefined);
  await openGolden(p, 'golden-12-motions');
  await p.evaluate(() => window.mochi.settled());
  await p.getByTestId('workspace-switcher').selectOption('animation');
  await p.locator('[data-motion="curves"]').click();
  await p.locator('[data-lane="P_Linear"]').waitFor();
  return p;
}
const errorsOf = (p: Page) => (p as unknown as { errors: string[] }).errors;

/** A curve's segments, by its parameter's export ID. */
const segments = (p: Page, param: string) =>
  p.evaluate((id) => {
    const m = window.mochi.get('@motion~curves') as {
      curves: { object: string | null; segments: number[]; auto: number[] }[];
    };
    const uid = (window.mochi.get(`@param:${id}`) as { uid: string }).uid;
    return m.curves.find((c) => c.object === uid) ?? null;
  }, param);
const keyTimes = (p: Page, label: string) =>
  p
    .locator(`[data-lane="${label}"] .keyframe`)
    .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.key!.split('@')[1])));
const laneAt = async (p: Page, label: string, fraction: number) => {
  const b = (await p.locator(`[data-lane="${label}"]`).boundingBox())!;
  return [b.x + b.width * fraction, b.y + b.height / 2] as const;
};
const seek = (p: Page, t: number) => p.evaluate((t) => window.mochiEditor.playback.seek(t), t);

describe('Timeline palette', () => {
  it('sets the work area and markers, fits the view, jumps between markers, and loops the work area', async () => {
    if (!browser) return;
    const p = await open();
    const motion = () =>
      p.evaluate(
        () =>
          window.mochi.get('@motion~curves') as {
            workArea: { start: number; end: number } | null;
            markers: { time: number; name: string }[];
          },
      );
    const leftOf = (sel: string) =>
      p.locator(sel).evaluate((e) => parseFloat((e as HTMLElement).style.left));
    // Shift+Home and Shift+End at the playhead.
    await seek(p, 0.5);
    await p.keyboard.press('Shift+Home');
    await poll(async () => (await motion()).workArea).toEqual({ start: 0.5, end: 2 });
    await seek(p, 1.5);
    await p.keyboard.press('Shift+End');
    await poll(async () => (await motion()).workArea).toEqual({ start: 0.5, end: 1.5 });
    expect(await leftOf('[data-testid="work-area"]')).toBeCloseTo(25, 3);
    // A start after the end is refused with a message, and nothing changes.
    await seek(p, 1.75);
    await p.keyboard.press('Shift+Home');
    expect((await motion()).workArea).toEqual({ start: 0.5, end: 1.5 });
    // Shift+F: the work area across the view (the key at 1 s in the middle); again: the whole.
    await p.keyboard.press('Shift+F');
    await poll(() => leftOf('[data-lane="P_Linear"] .keyframe[data-key="P_Linear@1"]')).toBeCloseTo(
      50,
      3,
    );
    expect(await leftOf('[data-testid="work-area"]')).toBeCloseTo(0, 3);
    await p.keyboard.press('Shift+F');
    await poll(() => leftOf('[data-lane="P_Linear"] .keyframe[data-key="P_Linear@1"]')).toBeCloseTo(
      50,
      3,
    );
    expect(await leftOf('[data-testid="work-area"]')).toBeCloseTo(25, 3);
    // Markers: Ctrl+click on the markers lane asks for a name; another from the API.
    const [x, y] = await laneAt(p, 'Markers', 0.75);
    await p.keyboard.down('Control');
    await p.mouse.click(x, y);
    await p.keyboard.up('Control');
    await p.getByTestId('ask-text').fill('turn');
    await p.getByTestId('ask-ok').click();
    await p.evaluate(() => window.mochiEditor.timeline.addMarker(0.25, 'blink'));
    await poll(async () => (await motion()).markers).toEqual([
      { time: 0.25, name: 'blink' },
      { time: 1.5, name: 'turn' },
    ]);
    expect(await p.locator('[data-lane="Markers"] .marker').count()).toBe(2);
    // Ctrl+K and Ctrl+J: the next and previous marker (the command bar stays closed).
    await seek(p, 0);
    await p.keyboard.press('Control+K');
    await poll(() => p.evaluate(() => window.mochiEditor.playback.time)).toBeCloseTo(0.25, 6);
    await p.keyboard.press('Control+K');
    await poll(() => p.evaluate(() => window.mochiEditor.playback.time)).toBeCloseTo(1.5, 6);
    await p.keyboard.press('Control+J');
    await poll(() => p.evaluate(() => window.mochiEditor.playback.time)).toBeCloseTo(0.25, 6);
    expect(await p.locator('.commandbar:not([hidden])').count()).toBe(0);
    // Playback loops the work area: every time shown is inside it, and it wraps.
    await p.keyboard.press('Enter');
    await poll(() => p.evaluate(() => window.mochiEditor.playback.playing)).toBe(true);
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      times.push(await p.evaluate(() => window.mochiEditor.playback.time));
      await new Promise((r) => setTimeout(r, 70));
    }
    await p.keyboard.press('Enter');
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0.5 - 1e-6);
    expect(Math.max(...times)).toBeLessThanOrEqual(1.5 + 1e-6);
    expect(times.some((t, i) => i > 0 && t < times[i - 1]!)).toBe(true);
    // One undo per change; the work area goes back step by step.
    await p.keyboard.press('Control+Z');
    await p.keyboard.press('Control+Z');
    await p.keyboard.press('Control+Z');
    await poll(async () => (await motion()).workArea).toEqual({ start: 0.5, end: 2 });
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('inserts, deletes, moves, copies and pastes keys in the Dope Sheet', async () => {
    if (!browser) return;
    const p = await open();
    expect(await p.getByTestId('timeline-mode').textContent()).toBe('Dope Sheet');
    expect(await keyTimes(p, 'P_Linear')).toEqual([0, 1, 2]);
    // Ctrl+click on a lane inserts a key, snapped to a frame, keeping the curve's shape.
    const [x, y] = await laneAt(p, 'P_Linear', 0.25);
    await p.keyboard.down('Control');
    await p.mouse.click(x, y);
    await p.keyboard.up('Control');
    await poll(() => keyTimes(p, 'P_Linear')).toEqual([0, 0.5, 1, 2]);
    expect((await segments(p, 'P_Linear'))!.segments.slice(0, 5)).toEqual([0, 0, 0, 0.5, 10]);
    // Select a key and delete it with Delete.
    await p.locator('[data-key="P_Linear@1"]').click();
    expect(await p.locator('[data-key="P_Linear@1"].on').count()).toBe(1);
    await p.keyboard.press('Delete');
    await poll(() => keyTimes(p, 'P_Linear')).toEqual([0, 0.5, 2]);
    // Drag a key: it moves by whole frames (fps 8 here).
    const key = p.locator('[data-key="P_Linear@0.5"]');
    const b = (await key.boundingBox())!;
    const lane = (await p.locator('[data-lane="P_Linear"]').boundingBox())!;
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(b.x + b.width / 2 + lane.width * 0.125, b.y + b.height / 2, { steps: 5 });
    await p.mouse.up();
    await poll(() => keyTimes(p, 'P_Linear')).toEqual([0, 0.75, 2]);
    // Copy, move the playhead, paste: the copy lands at the playhead.
    await p.locator('[data-key="P_Linear@0.75"]').click();
    await p.keyboard.press('Control+C');
    await seek(p, 1.5);
    await p.keyboard.press('Control+V');
    await poll(() => keyTimes(p, 'P_Linear')).toEqual([0, 0.75, 1.5, 2]);
    // Cut removes it again; undo brings it back.
    await p.locator('[data-key="P_Linear@1.5"]').click();
    await p.keyboard.press('Control+X');
    await poll(() => keyTimes(p, 'P_Linear')).toEqual([0, 0.75, 2]);
    await p.keyboard.press('Control+Z');
    await poll(() => keyTimes(p, 'P_Linear')).toEqual([0, 0.75, 1.5, 2]);
    // The arrow keys change the selected key's value by a hundredth of the range.
    await p.locator('[data-key="P_Linear@0.75"]').click();
    const before = (await segments(p, 'P_Linear'))!.segments[4]!;
    await p.keyboard.press('ArrowUp');
    await poll(async () => (await segments(p, 'P_Linear'))!.segments[4]).toBeCloseTo(before + 2, 6);
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('keys a parameter by moving its slider at the playhead', async () => {
    if (!browser) return;
    const p = await open();
    await seek(p, 1.25);
    await p.evaluate(() => {
      const uid = (window.mochi.get('@param:P_Step') as { uid: string }).uid;
      window.mochiEditor.editor.setPose(uid, 42);
    });
    await poll(() => keyTimes(p, 'P_Step')).toContain(1.25);
    expect(await keyTimes(p, 'P_Step')).toEqual([0, 0.5, 1.25, 1.5]);
    // Off: the slider no longer keys.
    await p.getByTestId('key-on-slider').uncheck();
    await seek(p, 1.75);
    await p.evaluate(() => {
      const uid = (window.mochi.get('@param:P_Step') as { uid: string }).uid;
      window.mochiEditor.editor.setPose(uid, 10);
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(await keyTimes(p, 'P_Step')).toEqual([0, 0.5, 1.25, 1.5]);
    await p.close();
  }, 120_000);

  it('pastes to selected rows, adjusts spacing and reverses keys', async () => {
    if (!browser) return;
    const p = await open();
    // Copy P_Linear's key at 1 (value 20), paste onto P_Fade with the ranges' ratio (same range).
    await p.locator('[data-key="P_Linear@1"]').click();
    await p.keyboard.press('Control+C');
    await p.locator('.track-name[data-row="P_Fade"]').click();
    await seek(p, 0.5);
    await p.getByTestId('timeline-menu').click();
    await p.getByTestId('paste-to-rows').click();
    await p.getByTestId('paste-how').selectOption('clamp');
    await p.getByTestId('paste-ok').click();
    await poll(() => keyTimes(p, 'P_Fade')).toEqual([0, 0.5, 2]);
    expect((await segments(p, 'P_Fade'))!.segments.slice(3, 5)).toEqual([0.5, 20]);
    // Adjust Spacing: P_Linear's keys at 0, 1 and 2 squeezed to half from the earliest.
    await p.locator('[data-key="P_Linear@0"]').click();
    await p.locator('[data-key="P_Linear@1"]').click({ modifiers: ['Shift'] });
    await p.locator('[data-key="P_Linear@2"]').click({ modifiers: ['Shift'] });
    await p.getByTestId('timeline-menu').click();
    await p.getByTestId('adjust-spacing').click();
    await p.getByTestId('spacing-percent').fill('50');
    await p.getByTestId('spacing-ok').click();
    await poll(() => keyTimes(p, 'P_Linear')).toEqual([0, 0.5, 1]);
    // Reverse Keyframes mirrors the values around the default (0): 0, 20, -10 → 0, -20, 10.
    for (const [i, t] of [0, 0.5, 1].entries()) {
      await p.locator(`[data-key="P_Linear@${t}"]`).click({ modifiers: i ? ['Shift'] : [] });
    }
    await p.getByTestId('timeline-menu').click();
    await p.getByTestId('reverse-keys').click();
    await poll(async () => (await segments(p, 'P_Linear'))!.segments).toEqual([
      0, 0, 0, 0.5, -20, 0, 1, 10,
    ]);
    expect(await keyTimes(p, 'P_Linear')).toEqual([0, 0.5, 1]);
    await p.close();
  }, 120_000);

  it('switches to the Graph Editor with C and sets interpolations; plays the motion', async () => {
    if (!browser) return;
    const p = await open();
    await p.locator('[data-key="P_Linear@0"]').click();
    await p.getByTestId('overlay').focus();
    await p.keyboard.press('c');
    expect(await p.getByTestId('timeline-mode').textContent()).toBe('Graph Editor');
    expect(await p.getByTestId('graph').isVisible()).toBe(true);
    // The selection carries over: Auto smooth on the first segment, then Bézier keeps its shape.
    await p.getByTestId('interp-auto').click();
    await poll(async () => (await segments(p, 'P_Linear'))!.auto).toEqual([0]);
    const auto = (await segments(p, 'P_Linear'))!.segments.slice(0, 9);
    await p.getByTestId('interp-bezier').click();
    await poll(async () => (await segments(p, 'P_Linear'))!.auto).toEqual([]);
    expect((await segments(p, 'P_Linear'))!.segments.slice(0, 9)).toEqual(auto);
    await p.getByTestId('interp-step').click();
    await poll(async () => (await segments(p, 'P_Linear'))!.segments.slice(0, 5)).toEqual([
      0, 0, 2, 1, 20,
    ]);
    // Moving keys a frame later with the right arrow (Graph Editor).
    await p.keyboard.press('ArrowRight');
    await poll(async () => (await segments(p, 'P_Linear'))!.segments.slice(0, 2)).toEqual([
      0.125, 0,
    ]);
    // The header button switches back.
    await p.getByTestId('timeline-mode').click();
    expect(await p.getByTestId('timeline-mode').textContent()).toBe('Dope Sheet');
    // Playback runs the motion through Mochi2D, and Stop ends it.
    await p.getByTestId('play').click();
    await poll(() => p.evaluate(() => window.mochiEditor.playback.time)).toBeGreaterThan(0.1);
    // Meanwhile the Parameter palette shows Mochi2D's base values (getParameterBase).
    const live = () =>
      p.evaluate(() => {
        const e = window.mochiEditor.editor;
        const uid = (window.mochi.get('@param:P_Bez') as { uid: string }).uid;
        return e.live?.get(uid) ?? null;
      });
    await poll(live).toBeGreaterThan(0);
    await p.getByTestId('play').click();
    expect(await p.evaluate(() => window.mochiEditor.playback.playing)).toBe(false);
    expect(await live()).toBe(null);
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);

  it('adds part-opacity and model tracks, events and curve fades', async () => {
    if (!browser) return;
    const p = await open();
    const part = await p.evaluate(
      () => (window.mochi.get('@part:Part_Open') as { uid: string }).uid,
    );
    await seek(p, 0.5);
    await p.getByTestId('track-add').selectOption(`partOpacity:${part}`);
    await p.locator('[data-lane="Part_Open · opacity"]').waitFor();
    expect(await keyTimes(p, 'Part_Open · opacity')).toEqual([0.5]);
    // The new row is selected, so its own fades show; a fade in for this curve only.
    await p.getByTestId('curve-fadeIn').fill('0.25');
    await p.getByTestId('curve-fadeIn').dispatchEvent('change');
    await poll(() =>
      p.evaluate(() => {
        const m = window.mochi.get('@motion~curves') as {
          curves: { target: string; fadeIn: number | null }[];
        };
        return m.curves.find((c) => c.target === 'partOpacity')?.fadeIn;
      }),
    ).toBe(0.25);
    // Seeking poses the part's opacity from its curve, without an error.
    await seek(p, 1);
    // A model curve (EyeBlink), keyed at the playhead.
    await p.getByTestId('track-add').selectOption('model:EyeBlink');
    await p.locator('[data-lane="Model · EyeBlink"]').waitFor();
    expect(await keyTimes(p, 'Model · EyeBlink')).toEqual([1]);
    // An event: Ctrl+click on the events lane asks for its value.
    const before = await p.locator('[data-lane="Events"] .event').count();
    const [x, y] = await laneAt(p, 'Events', 0.875);
    await p.keyboard.down('Control');
    await p.mouse.click(x, y);
    await p.keyboard.up('Control');
    await p.getByTestId('ask-text').fill('wave');
    await p.getByTestId('ask-ok').click();
    await poll(() => p.locator('[data-lane="Events"] .event').count()).toBe(before + 1);
    expect(await p.locator('[data-event="wave"]').count()).toBe(1);
    // The motion's own fades and length.
    await p.getByTestId('motion-fade-out').fill('0.5');
    await p.getByTestId('motion-fade-out').dispatchEvent('change');
    await poll(() =>
      p.evaluate(() => (window.mochi.get('@motion~curves') as { fadeOut: number }).fadeOut),
    ).toBe(0.5);
    expect(errorsOf(p)).toEqual([]);
    await p.close();
  }, 120_000);
});
