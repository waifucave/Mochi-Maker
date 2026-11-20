/**
 * M7, rig completeness: goldens 4–6 exported, loaded in Mochi2D and checked against values computed
 * by hand from the format's meaning (§1c.7, 1c.9, 1c.10; §2c; §3b, 3h, 3p,
 * 3s, 3t). The pixel check renders through Mochi2D's own `mochi2d render`, which needs headless
 * Chromium; it is skipped where Chromium is not available, except in CI's render job, which
 * requires it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '@mochi-maker/art';
import { exportModel, type ExportResult } from '@mochi-maker/export';
import { parseDisplayInfo, parseUserData, readMoc } from 'mochi2d/headless';
import { golden4, golden5, golden6 } from './golden.js';
import { evaluate, expectVertices, out, runtime } from './probe.js';

const text = (r: ExportResult, path: string) =>
  JSON.parse(new TextDecoder().decode(r.files.get(path)!)) as Record<string, unknown>;

// ------------------------------------------------------------------------ pixel rendering
const CLI = join(
  dirname(createRequire(import.meta.url).resolve('mochi2d/package.json')),
  'dist/tools/mochi2d.js',
);

/** Renders the export 1:1 (canvas pixel = image pixel) on black, or returns null without Chromium. */
function render(r: ExportResult, stem: string, params: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-maker-render-'));
  try {
    for (const [path, bytes] of r.files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), bytes);
    }
    const png = join(dir, 'out.png');
    execFileSync(
      process.execPath,
      [
        CLI,
        'render',
        join(dir, `${stem}.model3.json`),
        '--out',
        png,
        '--size',
        '200x200',
        '--view',
        '0,0,200',
        '--background',
        '#000000',
        '--effects',
        'physics=off,eyeBlink=off,breath=off,look=off,idle=off,lipSync=off,pose=off,expressions=off',
        '--params',
        Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join(','),
      ],
      { stdio: 'pipe' },
    );
    return decodePng(readFileSync(png), 'render');
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const canRender = await (async () => {
  const g = await golden4();
  return render(await exportModel(g.session.doc, g.assets), 'golden4', {}) !== null;
})();

// ------------------------------------------------------------------------ golden 4
describe('golden 4: masks and colors', () => {
  it('writes the mask lists and the inverted flag', async () => {
    const g = await golden4();
    const r = await exportModel(g.session.doc, g.assets);
    const { data } = readMoc(r.files.get('golden4.moc3')!);
    const ids = data.artMeshes.ids;
    const idx = (id: string) => ids.indexOf(id);
    const masksOf = (id: string) =>
      Array.from(
        data.maskEntries.subarray(
          data.artMeshes.firstMask[idx(id)]!,
          data.artMeshes.firstMask[idx(id)]! + data.artMeshes.maskCount[idx(id)]!,
        ),
      ).map((m) => ids[m]);
    expect(masksOf('Union')).toEqual(['Mask_1', 'Mask_2']);
    expect(masksOf('Inverted')).toEqual(['Mask_1', 'Mask_2']);
    expect(masksOf('Follower')).toEqual(['Mask_3']);
    expect(masksOf('Mask_1')).toEqual([]);
    expect(data.artMeshes.flags[idx('Union')]! & 8).toBe(0);
    expect(data.artMeshes.flags[idx('Inverted')]! & 8).toBe(8);
    expect(data.artMeshes.flags[idx('Follower')]! & 8).toBe(0);
    expect(r.report.mocVersion).toBe(5);
  });

  it('a mask inside a warp follows it', async () => {
    const g = await golden4();
    const r = await exportModel(g.session.doc, g.assets);
    for (const shift of [0, 0.5, 1]) {
      const d = evaluate(r, 'golden4', { ParamMask: shift }).get('Mask_3')!;
      const x = 120 + 20 * shift;
      expectVertices(
        d.vertices,
        [
          [x, 120],
          [x + 40, 120],
          [x + 40, 160],
          [x, 160],
        ].flatMap(([px, py]) => out(px!, py!, 100, 100, 200)),
      );
    }
  });

  it('colors combine down warp → rotation → mesh as in §1 example d), clamped once', async () => {
    const g = await golden4();
    const r = await exportModel(g.session.doc, g.assets);
    const chain = evaluate(r, 'golden4').get('Chain')!;
    // Rotation accumulated: multiply 0.8·0.5 = 0.4, 0.5·1, 1·1; screen 0.5 + 0.2 − 0.1 = 0.6.
    // Mesh: multiply 1.5·0.4 = 0.6, 1·0.5, 0.2·1; screen 0 + 0.6, 0.4 + 0, 0.
    expectVertices(chain.multiplyColor, [0.6, 0.5, 0.2, 1], 1e-6);
    expectVertices(chain.screenColor, [0.6, 0.4, 0, 1], 1e-6);
    // The rotation origin is the warp's (0.5, 0.5): canvas (45, 145). Children are in pixels.
    expectVertices(chain.vertices.slice(0, 2), out(30, 130, 100, 100, 200));
  });

  it('keyformed colors interpolate', async () => {
    const g = await golden4();
    const r = await exportModel(g.session.doc, g.assets);
    for (const t of [0, 0.25, 1]) {
      const fade = evaluate(r, 'golden4', { ParamTint: t }).get('Fade')!;
      expectVertices(fade.multiplyColor, [1 - t, 1 - 0.5 * t, 1, 1], 1e-6);
      expectVertices(fade.screenColor, [0.4 * t, 0, 0, 1], 1e-6);
    }
  });

  // CI's render job sets MOCHI_MAKER_REQUIRE_RENDER=1, so a missing browser fails there instead of
  // skipping.
  const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
  it.runIf(canRender || required)(
    'renders masks and colors as computed (mochi2d render)',
    async () => {
      expect(canRender, 'mochi2d render needs Playwright and Chromium').toBe(true);
      const g = await golden4();
      const r = await exportModel(g.session.doc, g.assets);
      const at = (img: { width: number; data: Uint8Array }, x: number, y: number) =>
        Array.from(img.data.subarray(4 * (y * img.width + x), 4 * (y * img.width + x) + 3));
      const near = (actual: number[], expected: number[], what: string) =>
        actual.forEach((v, i) =>
          expect(
            Math.abs(v - expected[i]!),
            `${what}: ${actual} vs ${expected}`,
          ).toBeLessThanOrEqual(2),
        );
      // Fragment color (§2c) of an opaque texel c with multiply M and screen S.
      const shade = (c: number[], m: number[], s: number[]) =>
        c.map((ci, i) => {
          const x = (ci / 255) * m[i]!;
          return Math.round(255 * (x + s[i]! - x * s[i]!));
        });

      const rest = render(r, 'golden4', { ParamMask: 0, ParamTint: 1 })!;
      near(at(rest, 40, 32), [0, 0, 255], 'Union over Mask_1');
      near(at(rest, 80, 32), [0, 0, 0], 'Union outside both masks');
      near(at(rest, 120, 32), [0, 0, 255], 'Union over Mask_2');
      near(at(rest, 40, 50), [255, 0, 0], 'Inverted hidden over Mask_1');
      near(at(rest, 80, 50), [255, 255, 0], 'Inverted outside both masks');
      near(at(rest, 125, 140), [255, 255, 255], 'Follower inside Mask_3');
      near(at(rest, 175, 140), [0, 0, 0], 'Follower outside Mask_3');
      near(at(rest, 45, 145), shade([128, 128, 128], [0.6, 0.5, 0.2], [0.6, 0.4, 0]), 'Chain');
      near(at(rest, 175, 35), shade([200, 200, 200], [0, 0.5, 1], [0.4, 0, 0]), 'Fade');

      const moved = render(r, 'golden4', { ParamMask: 1, ParamTint: 0 })!;
      near(at(moved, 125, 140), [0, 0, 0], 'Follower outside the moved mask');
      near(at(moved, 175, 140), [255, 255, 255], 'Follower inside the moved mask');
      near(at(moved, 175, 35), [200, 200, 200], 'Fade untinted');
    },
    // Two renders through mochi2d render; room for a machine shared with other suites.
    60_000,
  );
});

// ------------------------------------------------------------------------ golden 5
describe('golden 5: glue', () => {
  it('glues pull by weight × intensity, pair by pair and glue by glue (§1c.10)', async () => {
    const g = await golden5();
    const r = await exportModel(g.session.doc, g.assets);
    const P = (px: number, py: number) => out(px, py, 100, 100, 200) as [number, number];
    const toward = (p: [number, number], q: [number, number], w: number): [number, number] => [
      p[0] + (q[0] - p[0]) * w,
      p[1] + (q[1] - p[1]) * w,
    ];
    for (const intensity of [0, 0.5, 1]) {
      const m = evaluate(r, 'golden5', { ParamGlue: intensity });
      // Glue_AB, from the positions before the pair.
      const a1 = P(60, 20);
      const b0 = P(80, 40);
      const a1g = toward(a1, b0, 0.25 * intensity);
      const b0g = toward(b0, a1, 0.75 * intensity);
      // Glue_BC sees Glue_AB's result for B vertex 0.
      const c3 = P(140, 60);
      const b0gg = toward(b0g, c3, 0.5);
      const c3g = toward(c3, b0g, 0.5);
      const mid = toward(P(120, 40), P(140, 20), 0.5);
      expectVertices(m.get('A')!.vertices.slice(2, 4), a1g);
      expectVertices(m.get('B')!.vertices.slice(0, 4), [...b0gg, ...mid]);
      expectVertices(m.get('C')!.vertices.slice(0, 2), mid);
      expectVertices(m.get('C')!.vertices.slice(6, 8), c3g);
      // Untouched vertices stay.
      expectVertices(m.get('A')!.vertices.slice(0, 2), P(20, 20));
    }
    // §1 example b) in canvas pixels, at intensity 0.5: A1 (62.5, 22.5), B0 (72.5, 32.5).
    const half = evaluate(r, 'golden5', { ParamGlue: 0.5 });
    expectVertices(half.get('A')!.vertices.slice(2, 4), P(62.5, 22.5));
  });

  it('writes glue pairs as (vertex of A, weight of A), (vertex of B, weight of B)', async () => {
    const g = await golden5();
    const r = await exportModel(g.session.doc, g.assets);
    const { data } = readMoc(r.files.get('golden5.moc3')!);
    expect(data.glues.ids).toEqual(['Glue_AB', 'Glue_BC']);
    expect(Array.from(data.glueInfo.vertex)).toEqual([1, 0, 0, 3, 1, 0]);
    expect(Array.from(data.glueInfo.weight)).toEqual([0.25, 0.75, 0.5, 0.5, 0.5, 0.5]);
    expect(Array.from(data.glues.infoCount)).toEqual([2, 4]);
    expect(Array.from(data.glueKeyforms.intensity)).toEqual([0, 1, 1]);
  });
});

// ------------------------------------------------------------------------ golden 6
describe('golden 6: hit areas, display info, user data and standard groups', () => {
  it('writes the settings, display-info and user-data files', async () => {
    const g = await golden6();
    const r = await exportModel(g.session.doc, g.assets);
    const settings = text(r, 'golden6.model3.json');
    expect(settings.Groups).toEqual([
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ]);
    expect(settings.HitAreas).toEqual([
      { Id: 'Head', Name: 'Head' },
      { Id: 'Body', Name: 'Body' },
    ]);
    expect((settings.FileReferences as Record<string, unknown>).UserData).toBe(
      'golden6.userdata3.json',
    );
    expect(text(r, 'golden6.cdi3.json')).toEqual({
      Version: 3,
      Parameters: [
        { Id: 'ParamEyeLOpen', GroupId: 'ParamGroupEyes', Name: 'Eye L Open' },
        { Id: 'ParamEyeROpen', GroupId: 'ParamGroupEyes', Name: 'Eye R Open' },
        { Id: 'ParamMouthOpenY', GroupId: 'ParamGroupFace', Name: 'Mouth Open' },
        { Id: 'ParamAngleX', GroupId: '', Name: 'Angle X' },
        { Id: 'ParamAngleY', GroupId: '', Name: 'Angle Y' },
      ],
      ParameterGroups: [
        { Id: 'ParamGroupFace', GroupId: '', Name: 'Face' },
        { Id: 'ParamGroupEyes', GroupId: 'ParamGroupFace', Name: 'Eyes' },
      ],
      Parts: [
        { Id: 'PartHead', Name: 'Head' },
        { Id: 'PartBody', Name: 'Body' },
      ],
      CombinedParameters: [['ParamAngleX', 'ParamAngleY']],
    });
    const userData = text(r, 'golden6.userdata3.json');
    expect(userData).toEqual({
      Version: 3,
      Meta: { UserDataCount: 3, TotalUserDataSize: 4 + 9 + 9 },
      UserData: [
        { Target: 'ArtMesh', Id: 'Head', Value: 'face' },
        { Target: 'Part', Id: 'PartHead', Value: 'head part' },
        { Target: 'Parameter', Id: 'ParamMouthOpenY', Value: 'mouth ✓' },
      ],
    });
    // Mochi2D's parsers read both.
    expect(() =>
      parseDisplayInfo(r.files.get('golden6.cdi3.json')!, 'golden6.cdi3.json'),
    ).not.toThrow();
    expect(() =>
      parseUserData(r.files.get('golden6.userdata3.json')!, 'golden6.userdata3.json'),
    ).not.toThrow();
  });

  it('an app sees the display names, groups and hit areas', async () => {
    const g = await golden6();
    const model = await runtime(await exportModel(g.session.doc, g.assets), 'golden6');
    const p = new Map(model.parameters.map((x) => [x.id, x]));
    expect(p.get('ParamEyeLOpen')).toMatchObject({ name: 'Eye L Open', group: 'Eyes' });
    expect(p.get('ParamMouthOpenY')).toMatchObject({ name: 'Mouth Open', group: 'Face' });
    expect(model.parts.map((x) => [x.id, x.name])).toEqual([
      ['PartHead', 'Head'],
      ['PartBody', 'Body'],
    ]);
    expect(model.hitAreas).toEqual([
      { id: 'Head', name: 'Head' },
      { id: 'Body', name: 'Body' },
    ]);
    model.evaluate();
    // Head covers canvas (150, 60)–(250, 160); Body (120, 200)–(280, 340). Model units, y up.
    expect(model.hitAreasAt(...(out(200, 80, 200, 200, 400) as [number, number]))).toEqual([
      'Head',
    ]);
    expect(model.hitAreasAt(...(out(200, 300, 200, 200, 400) as [number, number]))).toEqual([
      'Body',
    ]);
    expect(model.hitAreasAt(...(out(20, 20, 200, 200, 400) as [number, number]))).toEqual([]);
  });

  it('eye blink drives the EyeBlink parameters, and the eye closes', async () => {
    const g = await golden6();
    const model = await runtime(await exportModel(g.session.doc, g.assets), 'golden6');
    for (const e of ['idle', 'breath', 'look', 'physics', 'lipSync', 'pose'] as const)
      model.setEffect(e, false);
    model.setEffect('eyeBlink', true);
    let minL = 1;
    let closedHeight = Infinity;
    for (let f = 0; f < 60 * 12; f++) {
      model.update(1 / 60);
      const l = model.getParameter('ParamEyeLOpen');
      expect(model.getParameter('ParamEyeROpen')).toBeCloseTo(l, 6);
      expect(model.getParameter('ParamMouthOpenY')).toBe(0);
      if (l < minL) {
        minL = l;
        const b = model.drawableBounds('EyeL')!;
        closedHeight = b.maxY - b.minY;
      }
    }
    expect(minL).toBeLessThan(0.1);
    // The eye is 10 px tall when open and flat when closed: height = 10·l px = 10·l/400 units.
    expect(closedHeight).toBeCloseTo((10 * minL) / 400, 5);
  });

  it('lip sync adds the sound’s level to the LipSync parameter', async () => {
    const g = await golden6();
    const model = await runtime(await exportModel(g.session.doc, g.assets), 'golden6');
    for (const e of ['idle', 'breath', 'look', 'physics', 'eyeBlink', 'pose'] as const)
      model.setEffect(e, false);
    model.setEffect('lipSync', true);
    // One second of a ±0.5 square wave, 16-bit mono at 16 kHz: its RMS is 0.5.
    const rate = 16000;
    const n = rate;
    const wav = new Uint8Array(44 + 2 * n);
    const v = new DataView(wav.buffer);
    const tag = (o: number, s: string) =>
      [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    tag(0, 'RIFF');
    v.setUint32(4, 36 + 2 * n, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, 2 * rate, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    tag(36, 'data');
    v.setUint32(40, 2 * n, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + 2 * i, (i >> 4) % 2 ? 16384 : -16384, true);
    expect(model.startLipSyncWav(wav)).toBe(true);
    for (let f = 0; f < 20; f++) model.update(1 / 60);
    expect(model.getParameter('ParamMouthOpenY')).toBeCloseTo(0.5, 2);
    const b = model.drawableBounds('Mouth')!;
    // The mouth is 10 px tall closed and 20 px at 1: 15 px at 0.5.
    expect((b.maxY - b.minY) * 400).toBeCloseTo(15, 0);
  });
});
