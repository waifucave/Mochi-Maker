/**
 * A synthetic model for the import's order tests (modelorder.test.ts): parts in and out of their
 * own sorting scopes, deformers, a glue and a mask, ten overlapping meshes at one draw-order value;
 * and the same model written with Mochi2D's writer in orders that Mochi Maker's exporter would not
 * write (see `shuffle`).
 */
import { MemoryAssetStore, Session, type CommandCall } from '@mochi-maker/core';
import { readMoc, writeMoc, type MocData } from 'mochi2d/headless';
import { exportModel, importModel } from '../src/index.js';
import { QUAD, layer, quadUv, swatch } from './golden.js';

const DATE = '2026-11-21T00:00:00.000Z';

/** mulberry32. */
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A random order of `parent`'s elements with every parent before its children (new → old). */
function shuffledTree(parent: ArrayLike<number>, rnd: () => number): number[] {
  const out: number[] = [];
  const placed = new Set<number>();
  const place = (i: number) => {
    if (placed.has(i)) return;
    if (parent[i]! >= 0) place(parent[i]!);
    placed.add(i);
    out.push(i);
  };
  for (const i of shuffled(parent.length, rnd)) place(i);
  return out;
}
function shuffled(n: number, rnd: () => number): number[] {
  const p = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  return p;
}

/** A model with parts in and out of their own scopes, deformers, a glue and a mask. */
export async function orderModel() {
  const session = Session.create({
    width: 400,
    height: 400,
    pixelsPerUnit: 400,
    originX: 200,
    originY: 200,
  });
  const assets = new MemoryAssetStore();
  const quad = (x: number, y: number, s = 120): [number, number][] => [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
  ];
  const mesh = (id: string, part: string | null, at: [number, number][], deformer?: string) => ({
    name: 'mesh.create',
    args: {
      exportId: id,
      ...(part ? { part } : {}),
      ...(deformer ? { deformer } : {}),
      layer: '$6',
      uv: quadUv(40, 40),
      triangles: QUAD,
      positions: at,
    },
  });
  const calls: CommandCall[] = [
    { name: 'project.setExportSettings', args: { fileStem: 'order', atlasSize: 1024 } }, // $0
    {
      name: 'param.create',
      args: { exportId: 'ParamX', min: -1, max: 1, default: 0, keys: [-1, 0, 1] },
    }, // $1
    { name: 'part.create', args: { exportId: 'PartA' } }, // $2
    { name: 'part.create', args: { exportId: 'PartB', sortingScope: 'own' } }, // $3
    { name: 'part.create', args: { exportId: 'PartC', parent: '$3', sortingScope: 'own' } }, // $4
    { name: 'part.create', args: { exportId: 'PartD', parent: '$2' } }, // $5
    await layer(assets, 'tex', swatch(40, 40, [200, 120, 80]), 0, 0), // $6
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_A',
        part: '$2',
        rows: 2,
        cols: 2,
        rect: { x: 40, y: 40, width: 320, height: 320 },
      },
    }, // $7
    {
      name: 'deformer.createRotation',
      args: { exportId: 'Rot_A', part: '$2', parent: '$7', origin: { x: 0.5, y: 0.5 } },
    }, // $8
    {
      name: 'deformer.createWarp',
      args: {
        exportId: 'Warp_B',
        part: '$3',
        rows: 1,
        cols: 1,
        rect: { x: 100, y: 100, width: 200, height: 200 },
      },
    }, // $9
    mesh('M01', '$2', quad(50, 50)), // $10
    mesh('M02', '$2', quad(-50, -50, 100), '$8'), // $11
    mesh('M03', '$5', quad(110, 80)), // $12
    mesh('M04', '$3', quad(150, 120)), // $13
    mesh(
      'M05',
      '$3',
      [
        [0.1, 0.1],
        [0.7, 0.1],
        [0.7, 0.7],
        [0.1, 0.7],
      ],
      '$9',
    ), // $14
    mesh('M06', '$4', quad(90, 170)), // $15
    mesh('M07', '$4', quad(170, 60)), // $16
    mesh('M08', null, quad(60, 200)), // $17
    mesh('M09', null, quad(200, 200)), // $18
    mesh('M10', '$2', quad(130, 140)), // $19
    { name: 'rig.addBinding', args: { target: '$8', parameter: '$1', keys: [-1, 0, 1] } },
    {
      name: 'keyform.set',
      args: { target: '$8', cell: { '@param:ParamX': -1 }, values: { angle: -20 } },
    },
    {
      name: 'keyform.set',
      args: { target: '$8', cell: { '@param:ParamX': 1 }, values: { angle: 20 } },
    },
    { name: 'rig.addBinding', args: { target: '$10', parameter: '$1', keys: [0, 1] } },
    {
      name: 'keyform.set',
      args: { target: '$10', cell: { '@param:ParamX': 1 }, values: { positions: quad(80, 60) } },
    },
    {
      name: 'glue.create',
      args: { exportId: 'Glue_1', meshA: '$10', meshB: '$19', pairs: [[0, 0.5, 0, 0.5]] },
    },
    { name: 'mesh.setClip', args: { target: '$13', masks: ['$14'] } },
  ];
  session.runBatch('order model', calls);
  return { session, assets };
}

/** Reorders the elements of a group of model data (every per-element array) by `perm` (new → old). */
function permuteGroup(group: Record<string, unknown>, perm: number[]): void {
  const n = perm.length;
  for (const [k, v] of Object.entries(group)) {
    if (Array.isArray(v) && v.length === n) group[k] = perm.map((i) => v[i]);
    else if (ArrayBuffer.isView(v) && (v as unknown as ArrayLike<number>).length === n) {
      const a = v as unknown as {
        length: number;
        constructor: new (n: number) => Record<number, number>;
      } & Record<number, number>;
      const out = new a.constructor(n);
      perm.forEach((old, i) => (out[i] = a[old]!));
      group[k] = out;
    }
  }
}
const remap = (arr: Int32Array | undefined, inv: number[], when?: (i: number) => boolean) => {
  if (!arr) return;
  for (let i = 0; i < arr.length; i++)
    if (arr[i]! >= 0 && (!when || when(i))) arr[i] = inv[arr[i]!]!;
};
const inverse = (perm: number[]) => {
  const inv: number[] = [];
  perm.forEach((old, i) => (inv[old] = i));
  return inv;
};

/** The model data with its orders shuffled and values no pixel exports to exactly (see above). */
export function shuffle(data: MocData, seed: number): MocData {
  const rnd = random(seed);
  const d = structuredClone(data);
  const O = d.drawOrderGroupObjects;
  // Parts.
  const pp = shuffledTree(d.parts.parent, rnd);
  const pi = inverse(pp);
  permuteGroup(d.parts as unknown as Record<string, unknown>, pp);
  remap(d.parts.parent, pi);
  remap(d.deformers.part, pi);
  remap(d.artMeshes.part, pi);
  remap(O.index, pi, (i) => O.kind[i] === 1);
  // Meshes.
  const mp = shuffled(d.artMeshes.ids.length, rnd);
  const mi = inverse(mp);
  permuteGroup(d.artMeshes as unknown as Record<string, unknown>, mp);
  remap(d.maskEntries, mi);
  remap(d.glues.artMeshA, mi);
  remap(d.glues.artMeshB, mi);
  remap(O.index, mi, (i) => O.kind[i] === 0);
  // Deformers.
  const dp = shuffledTree(d.deformers.parent, rnd);
  const di = inverse(dp);
  permuteGroup(d.deformers as unknown as Record<string, unknown>, dp);
  remap(d.deformers.parent, di);
  remap(d.artMeshes.deformer, di);
  // Every group's entries in another order (still a valid group: the same entries).
  const G = d.drawOrderGroups;
  for (let g = 0; g < G.firstObject.length; g++) {
    const first = G.firstObject[g]!;
    const order = shuffled(G.objectCount[g]!, rnd);
    for (const key of ['kind', 'index', 'nestedGroup'] as const) {
      const old = O[key].slice(first, first + order.length);
      order.forEach((o, j) => (O[key][first + j] = old[o]!));
    }
  }
  // The nested groups renumbered (the top group stays first).
  const gp = [0, ...shuffled(G.firstObject.length - 1, rnd).map((x) => x + 1)];
  permuteGroup(G as unknown as Record<string, unknown>, gp);
  remap(O.nestedGroup, inverse(gp));
  // Values the exporter would write otherwise: decimal places, a hidden mesh, canvas flags and
  // mesh flag bits the document has no place for.
  d.parameters.decimals[0] = 2;
  d.artMeshes.visible[1] = 0;
  d.canvas.flags = 1;
  d.artMeshes.flags[2] = d.artMeshes.flags[2]! | 16;
  // Draw-order group ranges wider than the reachable ones (evaluation reads them).
  for (let g = 0; g < G.firstObject.length; g++) {
    d.drawOrderGroups.minDrawOrder[g] =
      d.drawOrderGroups.minDrawOrder[g]! - Math.floor(rnd() * 300);
    d.drawOrderGroups.maxDrawOrder[g] =
      d.drawOrderGroups.maxDrawOrder[g]! + Math.floor(rnd() * 300);
  }
  // Top-level values that no canvas pixel value exports to exactly.
  const F = new Float32Array(1);
  const I = new Int32Array(F.buffer);
  for (let k = 0; k < d.keyformPositions.length; k += 7) {
    F[0] = d.keyformPositions[k]!;
    I[0]! += 1;
    d.keyformPositions[k] = F[0]!;
  }
  return d;
}

/** Writes the shuffled model at `version` and imports it. */
export async function shuffledImport(version: 3 | 4 | 5 | 6, seed: number) {
  const m = await orderModel();
  const first = await exportModel(m.session.doc, m.assets, { mocVersion: version });
  const original = readMoc(first.files.get('order.moc3')!).data;
  const data = shuffle(original, seed);
  const bytes = writeMoc(data, { version });
  const files = new Map(first.files);
  files.set('order.moc3', bytes);
  const assets = new MemoryAssetStore();
  const r = await importModel(files, 'order.model3.json', assets, { date: DATE });
  return { data, bytes, files, assets, ...r };
}
