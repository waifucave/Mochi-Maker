/**
 * Export fuzzing (design 7.4): random documents → export at every target version that can carry
 * them → the writer rules hold, Mochi2D validates (official and strict), loads, and evaluates
 * random poses without errors or non-finite values. Exporting twice gives the same bytes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryAssetStore, MochiError, Session, type CommandCall } from '@mochi-maker/core';
import { encodePng } from '@mochi-maker/art';
import { checkWriterRules, exportModel, requiredVersion } from '@mochi-maker/export';
import { readMoc, scenarioResult, validateMoc } from 'mochi2d/headless';
import { seededRandom } from '@mochi-maker/geometry';

const SWATCH = (() => {
  const data = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) data.set([120, 140, 160, 255], 4 * i);
  return { width: 32, height: 32, data };
})();

async function randomDocument(seed: number) {
  const rnd = seededRandom(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(l: T[]): T | undefined => (l.length ? l[int(l.length)] : undefined);
  const session = Session.create({
    width: 512,
    height: 512,
    pixelsPerUnit: 512,
    originX: 256,
    originY: 256,
  });
  const assets = new MemoryAssetStore();
  const asset = await assets.put(encodePng(SWATCH));
  const calls: CommandCall[] = [
    { name: 'layer.create', args: { name: 'swatch', asset, x: 0, y: 0, width: 32, height: 32 } },
  ];
  session.runBatch('layer', calls);
  const layer = session.view.ofKind('layer')[0]!.uid;
  const params: string[] = [];
  const parts: string[] = [];
  const deformers: { uid: string; kind: 'warp' | 'rotation' }[] = [];
  const meshes: string[] = [];
  const run = (c: CommandCall) => {
    try {
      return session.runBatch(c.name, [c]).results[0] as { uid?: string };
    } catch (e) {
      if (e instanceof MochiError) return undefined;
      throw e;
    }
  };
  for (let i = 0, n = 1 + int(4); i < n; i++) {
    const keys = [0, 0.5, 1].filter(() => rnd() < 0.8);
    const r = run({
      name: 'param.create',
      args: { min: -1, max: 1, default: 0, keys: keys.length ? [-1, ...keys] : [-1, 1] },
    });
    if (r?.uid) params.push(r.uid);
  }
  for (let i = 0, n = int(4); i < n; i++) {
    const r = run({
      name: 'part.create',
      args: {
        parent: rnd() < 0.5 ? (pick(parts) ?? null) : null,
        sortingScope: rnd() < 0.5 ? 'own' : 'inherit',
        drawOrder: 400 + int(200),
      },
    });
    if (r?.uid) parts.push(r.uid);
  }
  for (let i = 0, n = int(5); i < n; i++) {
    const parent = rnd() < 0.6 ? pick(deformers) : undefined;
    const inRotation = parent?.kind === 'rotation';
    if (rnd() < 0.5) {
      const rect =
        parent === undefined
          ? { x: 100 + int(100), y: 100 + int(100), width: 100 + int(200), height: 100 + int(200) }
          : inRotation
            ? { x: -50, y: -50, width: 100, height: 100 }
            : { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
      const r = run({
        name: 'deformer.createWarp',
        args: {
          parent: parent?.uid ?? null,
          part: pick(parts) ?? null,
          rows: 1 + int(3),
          cols: 1 + int(3),
          cellMode: rnd() < 0.5 ? 'bilinear' : 'triangles',
          rect,
        },
      });
      if (r?.uid) deformers.push({ uid: r.uid, kind: 'warp' });
    } else {
      const origin =
        parent === undefined
          ? { x: 100 + int(300), y: 100 + int(300) }
          : inRotation
            ? { x: int(40) - 20, y: int(40) - 20 }
            : { x: rnd(), y: rnd() };
      const r = run({
        name: 'deformer.createRotation',
        args: {
          parent: parent?.uid ?? null,
          part: pick(parts) ?? null,
          origin,
          baseAngle: int(90),
        },
      });
      if (r?.uid) deformers.push({ uid: r.uid, kind: 'rotation' });
    }
  }
  for (let i = 0, n = 1 + int(6); i < n; i++) {
    const def = rnd() < 0.6 ? pick(deformers) : undefined;
    const s = def === undefined ? 40 : def.kind === 'warp' ? 0.3 : 20;
    const ox = def === undefined ? 100 + int(300) : def.kind === 'warp' ? rnd() * 0.6 : -10;
    const oy = def === undefined ? 100 + int(300) : def.kind === 'warp' ? rnd() * 0.6 : -10;
    const r = run({
      name: 'mesh.create',
      args: {
        part: pick(parts) ?? null,
        deformer: def?.uid ?? null,
        layer,
        uv: [
          [0, 0],
          [32, 0],
          [32, 32],
          [0, 32],
        ],
        positions: [
          [ox, oy],
          [ox + s, oy],
          [ox + s, oy + s],
          [ox, oy + s],
        ],
        triangles: [
          [0, 1, 2],
          [0, 2, 3],
        ],
        doubleSided: rnd() < 0.7,
        drawOrder: 300 + int(400),
      },
    });
    if (r?.uid) meshes.push(r.uid);
  }
  // Bindings and keyform values.
  for (const t of [...meshes, ...deformers.map((d) => d.uid), ...parts]) {
    for (let b = int(3); b > 0; b--)
      run({ name: 'rig.addBinding', args: { target: t, parameter: pick(params)! } });
    const kind = session.view.get(t)!.kind;
    const values =
      kind === 'artMesh'
        ? {
            opacity: rnd(),
            drawOrder: 300 + int(400),
            ...(rnd() < 0.3
              ? { multiply: [rnd(), rnd(), rnd()], screen: [rnd() * 0.5, 0, 0] }
              : {}),
          }
        : kind === 'rotation'
          ? { angle: int(90) - 45, scale: 0.5 + rnd() }
          : kind === 'warp'
            ? { opacity: 0.5 + rnd() * 0.5 }
            : { drawOrder: 300 + int(400) };
    run({ name: 'keyform.set', args: { target: t, all: true, values } });
  }
  if (meshes.length >= 2 && rnd() < 0.5)
    run({
      name: 'mesh.setClip',
      args: { target: meshes[0]!, masks: [meshes[1]!], invert: rnd() < 0.5 },
    });
  if (meshes.length >= 2 && rnd() < 0.5)
    run({
      name: 'glue.create',
      args: { meshA: meshes[0]!, meshB: meshes[1]!, pairs: [[0, 0.5, 1, 0.5]] },
    });
  // Blend shapes: on random targets, with random deltas and constraints.
  const shapes: string[] = [];
  for (let i = 0, n = int(3); i < n; i++) {
    const r = run({
      name: 'param.create',
      args: {
        min: -1,
        max: 1,
        default: 0,
        keys: rnd() < 0.5 ? [-1, 0, 1] : [0, 1],
        type: 'blendShape',
      },
    });
    if (r?.uid) shapes.push(r.uid);
  }
  const small = (scale: number) => (rnd() - 0.5) * 2 * scale;
  const glueUids = session.view.ofKind('glue').map((g) => g.uid);
  for (const t of [...meshes, ...deformers.map((d) => d.uid), ...parts, ...glueUids]) {
    const p = rnd() < 0.5 ? pick(shapes) : undefined;
    if (!p) continue;
    run({ name: 'blendShape.add', args: { target: t, parameter: p } });
    const o = session.view.get(t)!;
    const space =
      o.kind === 'artMesh' || o.kind === 'warp'
        ? (o.kind === 'artMesh' ? o.deformer : o.parent) === null
          ? 10
          : session.view.get((o.kind === 'artMesh' ? o.deformer : o.parent)!)!.kind === 'warp'
            ? 0.05
            : 5
        : 0;
    const positionsOnly = rnd() < 0.5;
    const values =
      o.kind === 'artMesh'
        ? {
            positions: Array.from({ length: o.uv.length / 2 }, () => [small(space), small(space)]),
            ...(positionsOnly
              ? {}
              : { opacity: small(0.5), drawOrder: small(30), multiply: [small(0.5), 0, 0] }),
          }
        : o.kind === 'warp'
          ? {
              grid: Array.from({ length: (o.rows + 1) * (o.cols + 1) }, () => [
                small(space),
                small(space),
              ]),
              ...(positionsOnly ? {} : { opacity: small(0.5), screen: [0, small(0.3), 0] }),
            }
          : o.kind === 'rotation'
            ? { angle: small(30), scale: small(0.3), originX: small(5) }
            : o.kind === 'glue'
              ? { intensity: small(0.4) }
              : { drawOrder: small(40) };
    run({ name: 'blendShape.set', args: { target: t, parameter: p, key: 1, values } });
    if (rnd() < 0.5 && params.length > 0)
      run({
        name: 'blendShape.setConstraints',
        args: {
          target: t,
          parameter: p,
          constraints: [
            {
              parameter: pick(params)!,
              points: [
                [-1, rnd()],
                [1, rnd()],
              ],
            },
          ],
        },
      });
  }
  return {
    session,
    assets,
    params: [...params, ...shapes].map((p) => session.view.getAs(p, 'parameter').exportId),
    rnd,
  };
}

describe('export fuzzing', () => {
  it('random documents export, validate, load and evaluate at every version that can carry them', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), async (seed) => {
        const { session, assets, params, rnd } = await randomDocument(seed);
        const need = requiredVersion(session.view).version;
        for (const version of [3, 4, 5] as const) {
          if (version < need) {
            await expect(
              exportModel(session.doc, assets, { mocVersion: version }),
            ).rejects.toMatchObject({ code: 'E_EXPORT' });
            continue;
          }
          const r = await exportModel(session.doc, assets, { mocVersion: version });
          const moc = r.files.get('model.moc3')!;
          expect(validateMoc(moc, { level: 'official' }).valid).toBe(true);
          expect(validateMoc(moc, { level: 'strict' }).valid).toBe(true);
          expect(checkWriterRules(readMoc(moc).data, version)).toEqual([]);
          const again = await exportModel(session.doc, assets, { mocVersion: version });
          expect(Buffer.from(again.files.get('model.moc3')!).equals(Buffer.from(moc))).toBe(true);
          for (let k = 0; k < 4; k++) {
            const parameters = Object.fromEntries(params.map((p) => [p, rnd() * 2.4 - 1.2]));
            const res = scenarioResult(
              { moc, settings: r.files.get('model.model3.json')! },
              { format: 'mochi2d-scenario/0', id: 'fuzz', parameters },
            ) as {
              error: unknown;
              drawables: { vertices: number[]; opacity: number }[];
            };
            expect(res.error).toBeNull();
            for (const d of res.drawables) {
              expect(d.vertices.every(Number.isFinite)).toBe(true);
              expect(Number.isFinite(d.opacity)).toBe(true);
            }
          }
        }
      }),
      { numRuns: 60 },
    );
  }, 300_000);
});
