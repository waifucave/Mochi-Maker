/**
 * Version 6 in the editor: a part drawn offscreen and an art mesh with a version 6 blend mode, set
 * in the Inspector. The view shows the version 6 model (loaded from its model data), the
 * offscreen's keyformed opacity reaches the shown model, and the editor's evaluation matches the
 * agent API's in Node. The version 6 golden renders as committed. Headless Chromium
 * through Playwright; skipped where Chromium is missing, except in CI's render job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Project } from '@mochi-maker/api';
import { golden3 } from '../../export/test/golden.js';
import { goldenOffscreens } from '../../export/test/goldenv6.js';
import { buildEditor, launch, openGolden, serve, type Browser } from './harness.js';

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
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const RENDERS = join(import.meta.dirname, 'golden-v6');

describe('version 6 in the editor', () => {
  it('draws a part offscreen and a mesh with a version 6 blend mode, as the API evaluates them', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    const g = await golden3();
    await openGolden(p, g.name);
    await p.evaluate(() => window.mochi.settled());

    // The part: drawn offscreen, multiplied, at half opacity.
    await p.evaluate(() => window.mochi.select('@part:Part_Back'));
    await p.getByTestId('offscreen').check();
    await p.evaluate(() => window.mochi.settled());
    await p.getByTestId('blend-color').first().selectOption('multiply');
    await p.evaluate(() => window.mochi.settled());
    await poll(() => p.getByTestId('blend-note').count()).toBe(1);
    await p.getByTestId('kf-opacity').fill('0.5');
    await p.getByTestId('kf-opacity').dispatchEvent('change');
    await p.evaluate(() => window.mochi.settled());

    // The mesh: overlay.
    await p.evaluate(() => window.mochi.select('@mesh:Back_A'));
    await p.getByTestId('blend-color').selectOption('overlay');
    await p.evaluate(() => window.mochi.settled());

    const shown = await p.evaluate(() => {
      const vp = window.mochiEditor.viewport;
      const m = vp.view.model!.runtime;
      return {
        error: vp.error,
        offscreenOpacity: Array.from(m.instance.offscreenOpacity),
        blendModes: Array.from(m.model.meshes.blendMode),
        version: vp.builds.at(-1)?.mode,
      };
    });
    expect(shown.error).toBeNull();
    expect(shown.offscreenOpacity).toEqual([0.5]);
    expect(shown.blendModes).toContain(12); // overlay over

    // The same edits in Node: the agent API evaluates the version 6 model from its data.
    const s = g.session;
    // Golden 3 asks for version 5, which refuses offscreens; the editor previews version 6 anyway.
    s.run('project.setExportSettings', { mocVersion: 'auto' });
    s.run('part.setOffscreen', {
      target: '@part:Part_Back',
      offscreen: true,
      blend: { color: 'multiply', alpha: 'over' },
    });
    s.run('keyform.set', { target: '@part:Part_Back', all: true, values: { opacity: 0.5 } });
    s.run('mesh.update', { target: '@mesh:Back_A', blend: { color: 'overlay', alpha: 'over' } });
    const e = await Project.fromSession(s, g.assets).evaluate({ vertices: true });
    expect(e.mocVersion).toBe(6);
    const page = await p.evaluate(() => window.mochi.evaluate().drawables);
    expect(page.length).toBe(e.drawables.length);
    for (const d of e.drawables) {
      const x = page.find((y) => y.id === d.id)!;
      expect(x.opacity, d.id).toBeCloseTo(d.opacity, 5);
      expect(x.renderOrder, d.id).toBe(d.renderOrder);
      x.vertices.forEach((v, i) => expect(v).toBeCloseTo(d.vertices![i]!, 2));
    }
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);

  it('renders the version 6 golden as committed, and differently without its version 6 parts', async () => {
    if (!browser) return;
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?nohome`);
    await p.waitForFunction(() => window.mochi !== undefined);
    const g = await goldenOffscreens();
    await openGolden(p, g.name);
    await p.evaluate(() => window.mochi.settled());
    const render = (parameters: Record<string, number>) =>
      p.evaluate(async (parameters) => {
        const ed = window.mochiEditor;
        const r = await ed.offscreen.render(ed.editor.session.doc, {
          width: 256,
          height: 256,
          parameters,
        });
        return { version: r.version, png: Array.from(r.png) };
      }, parameters);
    const poses: Record<string, Record<string, number>> = {
      default: {},
      fade: { ParamFade: 1 },
      'fade-bs': { ParamFade: 1, ParamBS: 1 },
    };
    const pngs: Record<string, Buffer> = {};
    for (const [name, parameters] of Object.entries(poses)) {
      const r = await render(parameters);
      expect(r.version).toBe(6);
      const png = Buffer.from(r.png);
      pngs[name] = png;
      const path = join(RENDERS, `${name}.png`);
      if (UPDATE || !existsSync(path)) {
        mkdirSync(RENDERS, { recursive: true });
        writeFileSync(path, png);
      }
      expect(png.equals(readFileSync(path)), name).toBe(true);
    }
    // The poses differ from each other, and the model without its version 6 parts differs too.
    expect(pngs.default!.equals(pngs.fade!)).toBe(false);
    expect(pngs.fade!.equals(pngs['fade-bs']!)).toBe(false);
    await p.evaluate(() =>
      window.mochi.run('plain', [
        { name: 'part.setOffscreen', args: { target: '@part:Part_Glass', offscreen: false } },
        { name: 'part.setOffscreen', args: { target: '@part:Part_Light', offscreen: false } },
        { name: 'mesh.update', args: { target: '@mesh:Shade', blend: null } },
        { name: 'mesh.update', args: { target: '@mesh:Cut', blend: null } },
      ]),
    );
    const plain = await render({});
    expect(plain.version).toBe(5);
    expect(Buffer.from(plain.png).equals(pngs.default!)).toBe(false);
    expect(errors).toEqual([]);
    await p.close();
  }, 120_000);
});
