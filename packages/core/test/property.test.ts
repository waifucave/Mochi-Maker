/**
 * Property tests (design 7.1): random command sequences, with undo and redo mixed in.
 * Commands may fail with a structured error, but never with an internal error or an invariant
 * violation, and after any sequence:
 * - the invariants hold;
 * - replaying the log gives the same document;
 * - undoing everything gives the starting document, and redoing everything gives the end;
 * - save → load → save is byte-identical.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MemoryAssetStore,
  MemoryFileSystem,
  MochiError,
  Session,
  canonicalText,
  loadProject,
  projectFiles,
  replay,
  saveProject,
  type CommandCall,
  type DocObject,
} from '@mochi-maker/core';
import { ASSET, QUAD_TRIS, fixtureSession, quad } from './fixture.js';

interface Step {
  op: number;
  a: number;
  b: number;
  c: number;
  flag: boolean;
}

const pick = <T>(list: T[], n: number): T | undefined =>
  list.length === 0 ? undefined : list[n % list.length];
const uids = (s: Session, kinds: DocObject['kind'][]) => s.view.ofKind(kinds).map((o) => o.uid);
const KEYS = [-30, -15, 0, 0.5, 1, 15, 30];
const NAMES = ['A', 'B', 'C', 'Param1', 'ArtMesh9', 'Bad Name'];

/** A random existing binding: its object, parameter and keys. */
function pickBinding(
  s: Session,
  st: Step,
): { target: string; parameter: string; keys: number[] } | undefined {
  const all = s.view
    .ofKind(['part', 'artMesh', 'warp', 'rotation', 'glue'])
    .flatMap((o) =>
      o.rig.bindings.map((b) => ({ target: o.uid, parameter: b.parameter, keys: b.keys })),
    );
  return pick(all, st.a + st.b);
}

type Builder = (s: Session, st: Step) => CommandCall | CommandCall[] | 'undo' | 'redo' | undefined;

const BUILDERS: Builder[] = [
  (_s, st) => ({
    name: 'param.create',
    args: {
      min: -Math.abs(st.c),
      max: Math.abs(st.c) + 1,
      keys: st.flag ? [-Math.abs(st.c), 0] : undefined,
    },
  }),
  (s, st) => {
    const p = pick(uids(s, ['parameter']), st.a);
    return p === undefined
      ? undefined
      : {
          name: 'param.setKeys',
          args: { target: p, keys: KEYS.filter((_, i) => (st.b >> i) & 1) },
        };
  },
  (s, st) => {
    const p = pick(uids(s, ['parameter']), st.a);
    return p === undefined
      ? undefined
      : { name: 'param.delete', args: { target: p, cascade: st.flag } };
  },
  (s, st) => ({
    name: 'part.create',
    args: { parent: st.flag ? (pick(uids(s, ['part']), st.a) ?? null) : null, index: st.b % 3 },
  }),
  (s, st) => {
    const t = pick(uids(s, ['part', 'artMesh']), st.a);
    return t === undefined
      ? undefined
      : {
          name: 'tree.move',
          args: {
            target: t,
            parent: st.flag ? (pick(uids(s, ['part']), st.b) ?? null) : null,
            index: st.c & 3,
          },
        };
  },
  (s, st) => {
    const p = pick(uids(s, ['part']), st.a);
    return p === undefined
      ? undefined
      : { name: 'part.delete', args: { target: p, cascade: st.flag } };
  },
  (s, st) => ({
    name: 'mesh.create',
    args: {
      part: pick(uids(s, ['part']), st.a) ?? null,
      deformer: st.flag ? (pick(uids(s, ['warp', 'rotation']), st.b) ?? null) : null,
      layer: pick(uids(s, ['layer']), st.c & 7) ?? null,
      uv: quad(st.c, st.b % 50, 10),
      triangles: QUAD_TRIS,
    },
  }),
  (s, st) => {
    const m = pick(uids(s, ['artMesh']), st.a);
    return m === undefined
      ? undefined
      : { name: 'mesh.delete', args: { target: m, cascade: st.flag } };
  },
  (s, st) => {
    const m = pick(uids(s, ['artMesh']), st.a);
    const k = pick(uids(s, ['artMesh']), st.b);
    return m === undefined || k === undefined
      ? undefined
      : { name: 'mesh.setClip', args: { target: m, masks: st.flag ? [k] : [], invert: st.c > 0 } };
  },
  (s, st) => {
    const parent = st.flag ? (pick(uids(s, ['warp']), st.a) ?? null) : null;
    return {
      name: 'deformer.createWarp',
      args: {
        parent,
        rows: 1 + (st.b % 3),
        cols: 1 + (st.c & 3),
        cellMode: st.c > 0 ? 'triangles' : 'bilinear',
      },
    };
  },
  (s, st) => ({
    name: 'deformer.createRotation',
    args: {
      parent: st.flag ? (pick(uids(s, ['warp', 'rotation']), st.a) ?? null) : null,
      origin: { x: st.b, y: st.c },
    },
  }),
  (s, st) => {
    const d = pick(uids(s, ['warp', 'rotation']), st.a);
    return d === undefined
      ? undefined
      : {
          name: 'deformer.setParent',
          args: {
            target: d,
            parent: st.flag ? (pick(uids(s, ['warp', 'rotation']), st.b) ?? null) : null,
          },
        };
  },
  (s, st) => {
    const d = pick(uids(s, ['warp', 'rotation']), st.a);
    return d === undefined
      ? undefined
      : { name: 'deformer.delete', args: { target: d, cascade: st.flag } };
  },
  (s, st) => {
    const t = pick(uids(s, ['part', 'artMesh', 'warp', 'rotation', 'glue']), st.a);
    const p = pick(uids(s, ['parameter']), st.b);
    return t === undefined || p === undefined
      ? undefined
      : {
          name: 'rig.addBinding',
          args: { target: t, parameter: p, index: st.flag ? 0 : undefined },
        };
  },
  (s, st) => {
    const b = pickBinding(s, st);
    return b === undefined
      ? undefined
      : { name: 'rig.removeBinding', args: { target: b.target, parameter: b.parameter } };
  },
  (s, st) => {
    const b = pickBinding(s, st);
    if (!b) return undefined;
    if (!st.flag) {
      const key = pick(b.keys, st.c & 7);
      return key === undefined
        ? undefined
        : [{ name: 'rig.removeKey', args: { target: b.target, parameter: b.parameter, key } }];
    }
    // Add a new key halfway between two of the parameter's keys, then add it to the binding.
    const param = s.view.getAs(b.parameter, 'parameter');
    const i = st.c & 7;
    const lo = param.keys[i % param.keys.length]!;
    const hi = param.keys[(i % param.keys.length) + 1];
    if (hi === undefined) return undefined;
    const key = (lo + hi) / 2;
    return [
      { name: 'param.setKeys', args: { target: param.uid, keys: [...param.keys, key] } },
      { name: 'rig.addKey', args: { target: b.target, parameter: b.parameter, key } },
    ];
  },
  (s, st) => {
    const b = pickBinding(s, st);
    if (!b) return undefined;
    const o = s.view.get(b.target) as {
      rig: { bindings: { parameter: string; keys: number[] }[] };
    };
    const cell = Object.fromEntries(
      o.rig.bindings.map((x, i) => [
        x.parameter,
        x.keys[(((st.c + i) % x.keys.length) + x.keys.length) % x.keys.length]!,
      ]),
    );
    const kind = s.view.get(b.target)!.kind;
    const values =
      kind === 'part'
        ? { drawOrder: st.b }
        : kind === 'glue'
          ? { intensity: 0.5 }
          : kind === 'rotation'
            ? { originX: st.c }
            : { opacity: 0.25 };
    return { name: 'keyform.set', args: { target: b.target, cell, values } };
  },
  (s, st) => {
    const t = pick(uids(s, ['part', 'artMesh', 'warp', 'rotation', 'glue']), st.a);
    if (!t) return undefined;
    const kind = s.view.get(t)!.kind;
    const values =
      kind === 'part'
        ? { drawOrder: st.c * 10 }
        : kind === 'glue'
          ? { intensity: st.b / 100 }
          : kind === 'rotation'
            ? { angle: st.c, mirrorY: st.flag }
            : { opacity: (st.b % 100) / 100 };
    return { name: 'keyform.set', args: { target: t, all: true, values } };
  },
  (s, st) => {
    const t = pick(uids(s, ['part', 'artMesh', 'warp', 'rotation', 'glue']), st.a);
    return t === undefined ? undefined : { name: 'rig.fillMissing', args: { target: t } };
  },
  (s, st) => {
    const a = pick(uids(s, ['artMesh']), st.a);
    const b = pick(uids(s, ['artMesh']), st.b);
    return a === undefined || b === undefined
      ? undefined
      : { name: 'glue.create', args: { meshA: a, meshB: b, pairs: [[0, 0.5, st.c & 3, 0.5]] } };
  },
  (s, st) => {
    const t = pick(uids(s, ['parameter', 'part', 'artMesh', 'warp', 'rotation', 'glue']), st.a);
    return t === undefined
      ? undefined
      : {
          name: 'object.rename',
          args: { target: t, exportId: pick(NAMES, st.b), name: `n${st.c}` },
        };
  },
  (_s, st) => ({
    name: 'layer.create',
    args: { name: `l${st.a}`, asset: ASSET, x: st.c, y: st.b, width: 1 + st.a, height: 1 + st.b },
  }),
  (s, st) => {
    // Add a vertex at a triangle's centroid.
    const m = pick(s.view.ofKind('artMesh'), st.a);
    if (!m || m.triangles.length === 0) return undefined;
    const t = (st.b % (m.triangles.length / 3)) * 3;
    const c = [0, 1].map(
      (k) =>
        (m.uv[2 * m.triangles[t]! + k]! +
          m.uv[2 * m.triangles[t + 1]! + k]! +
          m.uv[2 * m.triangles[t + 2]! + k]!) /
        3,
    );
    return { name: 'mesh.addVertices', args: { target: m.uid, points: [[c[0]!, c[1]!]] } };
  },
  (s, st) => {
    const m = pick(s.view.ofKind('artMesh'), st.a);
    return m === undefined
      ? undefined
      : {
          name: 'mesh.deleteVertices',
          args: { target: m.uid, vertices: [st.b % (m.uv.length / 2)] },
        };
  },
  (s, st) => {
    const m = pick(s.view.ofKind('artMesh'), st.a);
    if (!m) return undefined;
    if (st.flag) return { name: 'mesh.retriangulate', args: { target: m.uid } };
    const t = (st.b % Math.max(1, m.triangles.length / 3)) * 3;
    return m.triangles.length === 0
      ? undefined
      : {
          name: 'mesh.flipEdge',
          args: { target: m.uid, edge: [m.triangles[t]!, m.triangles[t + 1]!] },
        };
  },
  (s, st) => {
    // New topology: the same vertices plus one, triangulated as a fan (may be invalid: fine).
    const m = pick(s.view.ofKind('artMesh'), st.a);
    if (!m) return undefined;
    const uv: [number, number][] = [];
    for (let i = 0; i < m.uv.length; i += 2) uv.push([m.uv[i]!, m.uv[i + 1]!]);
    uv.push([st.c, st.b % 50]);
    const tris: [number, number, number][] = [];
    for (let i = 1; i + 1 < uv.length; i++) tris.push([0, i, i + 1]);
    return { name: 'mesh.setTopology', args: { target: m.uid, uv, triangles: tris } };
  },
  () => 'undo',
  () => 'redo',
];

const steps = fc.array(
  fc.record({
    op: fc.nat(),
    a: fc.nat({ max: 1000 }),
    b: fc.nat({ max: 1000 }),
    c: fc.integer({ min: -40, max: 40 }),
    flag: fc.boolean(),
  }),
  { minLength: 1, maxLength: 40 },
);

function runSteps(s: Session, list: Step[]): void {
  for (const st of list) {
    const step = BUILDERS[st.op % BUILDERS.length]!(s, st);
    if (step === undefined) continue;
    try {
      if (step === 'undo') s.undo();
      else if (step === 'redo') s.redo();
      else if (Array.isArray(step)) s.runBatch(step.map((c) => c.name).join(' + '), step);
      else s.runBatch(step.name, [step]);
    } catch (e) {
      if (!(e instanceof MochiError)) throw e;
      if (e.code === 'E_INTERNAL' || e.code === 'E_INVARIANT') throw e;
    }
  }
}

describe('random command sequences', () => {
  it('keep every law', async () => {
    await fc.assert(
      fc.asyncProperty(steps, fc.boolean(), async (list, fromFixture) => {
        const base = fromFixture ? fixtureSession().doc : undefined;
        const s = base ? Session.open(base) : Session.create({ width: 512, height: 512 });
        const start = canonicalText(s.doc, { includeSeq: false });
        runSteps(s, list);
        expect(s.validate().violations).toEqual([]);
        const end = canonicalText(s.doc);

        expect(canonicalText(replay(JSON.parse(JSON.stringify(s.log)), base).doc)).toBe(end);

        const fs = new MemoryFileSystem();
        const assets = new MemoryAssetStore();
        assets.blobs.set(ASSET, new Uint8Array([137, 80, 78, 71]));
        await saveProject(fs, 'p', s.doc, assets);
        const loaded = await loadProject(fs, 'p');
        expect(canonicalText(loaded.doc)).toBe(end);
        const again = projectFiles(loaded.doc);
        for (const [path, text] of projectFiles(s.doc)) expect(again.get(path)).toBe(text);

        let n = 0;
        while (s.canUndo) {
          s.undo();
          n++;
        }
        expect(canonicalText(s.doc, { includeSeq: false })).toBe(start);
        for (let i = 0; i < n; i++) s.redo();
        expect(canonicalText(s.doc)).toBe(end);
      }),
      { numRuns: 150 },
    );
  }, 120_000);
});
