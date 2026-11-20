/**
 * Mesh editing commands that change topology.
 *
 * Every command keeps the mesh valid in all its keyforms: new vertices are computed in each
 * keyform from the old vertices with the same barycentric weights they have in texture space, so
 * deformation carries over. Glue pairs follow their vertices, and pairs whose vertex disappears
 * are dropped (the result reports how many).
 */
import { Type } from '@sinclair/typebox';
import {
  TopologyError,
  TriangulationError,
  applyDerivations,
  derivePoints,
  flipEdge,
  insertPoint,
  removeVertices,
  retriangulate,
  strokeStrip,
  subdivide,
  type Derivation,
} from '@mochi-maker/geometry';
import { defineCommand } from '../command.js';
import type { Draft } from '../document.js';
import { MochiError } from '../errors.js';
import { f32 } from '../f32.js';
import type { ArtMesh, MeshKeyform } from '../model.js';
import { cellCoords } from '../rig.js';
import { RefOf } from '../schema.js';
import { f32Array } from './helpers.js';

const Points = (description: string) =>
  Type.Array(Type.Tuple([Type.Number(), Type.Number()]), { description });
const Triangles = () =>
  Type.Array(
    Type.Tuple([
      Type.Integer({ minimum: 0 }),
      Type.Integer({ minimum: 0 }),
      Type.Integer({ minimum: 0 }),
    ]),
  );
const Cell = () =>
  Type.Record(Type.String(), Type.Number(), {
    keyRefOf: ['parameter'],
    description: 'one key value per bound parameter',
  });

const MAX_VERTICES = 65535;

function topology<T>(fn: () => T, path?: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TopologyError || e instanceof TriangulationError)
      throw new MochiError('E_TOPOLOGY', e.message, path ? { path } : {});
    throw e;
  }
}

/**
 * Applies a per-vertex map to every point list of a mesh: keyform positions and blend-shape
 * position deltas. Maps built from derivations are linear, so a zero delta stays
 * zero.
 */
function mapMeshPoints(mesh: ArtMesh, fn: (p: Float32Array) => Float32Array): ArtMesh {
  return {
    ...mesh,
    rig: {
      bindings: mesh.rig.bindings,
      keyforms: mesh.rig.keyforms.map((k) => ({ ...k, positions: roundAll(fn(k.positions)) })),
    },
    blendShapes: mesh.blendShapes.map((b) => ({
      ...b,
      deltas: b.deltas.map((x) => ({ ...x, positions: roundAll(fn(x.positions)) })),
    })),
  };
}

/**
 * Writes the new topology into the mesh. `derive` describes every new vertex in terms of the old
 * ones; `vertexMap` maps old vertex indices to new ones for glue pairs (-1 = gone).
 */
function commitTopology(
  d: Draft,
  mesh: ArtMesh,
  uv: Float32Array,
  triangles: ArrayLike<number>,
  derive: Derivation[] | null,
  vertexMap: Int32Array | null,
): { vertexCount: number; triangleCount: number; droppedGluePairs: number } {
  const v = uv.length / 2;
  if (v > MAX_VERTICES)
    throw new MochiError('E_SHAPE', `A mesh can have at most ${MAX_VERTICES} vertices.`);
  for (let i = 0; i < triangles.length; i++)
    if (triangles[i]! >= v)
      throw new MochiError('E_SHAPE', `Triangle ${Math.floor(i / 3)} uses a vertex index ≥ ${v}.`, {
        path: 'args.triangles',
      });
  const mapped = derive ? mapMeshPoints(mesh, (p) => applyDerivations(p, derive)) : mesh;
  d.put({ ...mapped, uv: roundAll(uv), triangles: Uint16Array.from(triangles) });
  let dropped = 0;
  if (vertexMap) {
    for (const g of d.ofKind('glue')) {
      if (g.meshA !== mesh.uid && g.meshB !== mesh.uid) continue;
      const pairs: [number, number, number, number][] = [];
      for (const [va, wa, vb, wb] of g.pairs) {
        const na = g.meshA === mesh.uid ? (vertexMap[va] ?? -1) : va;
        const nb = g.meshB === mesh.uid ? (vertexMap[vb] ?? -1) : vb;
        if (na < 0 || nb < 0) dropped++;
        else pairs.push([na, wa, nb, wb]);
      }
      if (dropped > 0 || pairs.some((p, i) => p[0] !== g.pairs[i]![0] || p[2] !== g.pairs[i]![2]))
        d.put({ ...g, pairs });
    }
  }
  return { vertexCount: v, triangleCount: triangles.length / 3, droppedGluePairs: dropped };
}

function roundAll(a: Float32Array): Float32Array {
  // Float32Array already rounds; remove negative zeros so text stays canonical.
  for (let i = 0; i < a.length; i++) if (a[i] === 0) a[i] = 0;
  return a;
}

/** Old→new index map from derivations: a vertex survives where it is copied exactly. */
function survivorMap(oldCount: number, derive: Derivation[]): Int32Array {
  const map = new Int32Array(oldCount).fill(-1);
  derive.forEach((dv, i) => {
    if (dv.from.length === 1 && dv.weights[0] === 1 && map[dv.from[0]!] === -1)
      map[dv.from[0]!] = i;
  });
  return map;
}

const TopologyResult = Type.Object({
  vertexCount: Type.Integer(),
  triangleCount: Type.Integer(),
  droppedGluePairs: Type.Integer(),
});

export const meshSetTopology = defineCommand({
  name: 'mesh.setTopology',
  summary: 'Replace a mesh’s vertices (texture coordinates) and triangles, carrying keyforms over.',
  doc: `Sets new \`uv\` (layer pixels, one [x, y] per vertex) and \`triangles\`. In every keyform, a new
vertex at the same uv as an old one keeps that vertex's position exactly; any other new vertex gets
the position given by its barycentric coordinates in the old mesh (extrapolated from the nearest
triangle when outside it). Glue pairs follow vertices that keep their uv; other pairs are dropped.
Use mesh.regenerate to rebuild from the layer image.`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    uv: Points('texture coordinates, layer pixels'),
    triangles: Triangles(),
  }),
  result: TopologyResult,
  errors: ['E_SHAPE', 'E_TOPOLOGY'],
  examples: [
    {
      description: 'Replace a quad by a quad with a center vertex',
      args: {
        target: '@mesh:ArtMesh_Face',
        uv: [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
          [50, 50],
        ],
        triangles: [
          [0, 1, 4],
          [1, 2, 4],
          [2, 3, 4],
          [3, 0, 4],
        ],
      },
    },
  ],
  apply(d, a) {
    const mesh = d.getAs(a.target, 'artMesh');
    const uv = f32Array(a.uv.flat());
    const derive = topology(() => derivePoints(mesh.uv, mesh.triangles, uv));
    return commitTopology(
      d,
      mesh,
      uv,
      a.triangles.flat(),
      derive,
      survivorMap(mesh.uv.length / 2, derive),
    );
  },
});

export const meshSubdivide = defineCommand({
  name: 'mesh.subdivide',
  summary: 'Split every triangle of a mesh into four.',
  doc: `Adds a vertex at the middle of every edge (shared by the edge's triangles) and splits each triangle
into four. In every keyform and blend shape, a new vertex sits
halfway between its edge's ends, so the mesh looks the same. Existing vertex indices do not change;
glue pairs stay.`,
  args: Type.Object({ target: RefOf(['artMesh']) }),
  result: TopologyResult,
  errors: ['E_SHAPE'],
  examples: [{ description: 'Four times the triangles', args: { target: '@mesh:ArtMesh_Face' } }],
  apply(d, a) {
    const mesh = d.getAs(a.target, 'artMesh');
    const r = subdivide(mesh.uv, mesh.triangles);
    const n = mesh.uv.length / 2;
    const keep = new Int32Array(n).map((_, i) => i);
    return commitTopology(d, mesh, f32Array([...r.points]), r.triangles, r.derivations, keep);
  },
});

export const meshFromStrokes = defineCommand({
  name: 'mesh.fromStrokes',
  summary: 'Replace a mesh by strips along drawn strokes, keeping its keyforms.',
  doc: `Stroke-based meshing (confirmed with Shift+E in the editor). Each stroke is a
polyline in the mesh's texture space (layer pixels), resampled every \`spacing\` pixels (default
\`width\`) and widened to \`width\` across its path; the strips become the mesh's vertices and
triangles through mesh.setTopology, so every keyform carries over. For thin lines such as hair
strands and eyelashes.`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    strokes: Type.Array(Points('one stroke, in texture space (layer pixels)'), { minItems: 1 }),
    width: Type.Number({ exclusiveMinimum: 0, description: 'strip width, pixels' }),
    spacing: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  }),
  result: TopologyResult,
  errors: ['E_SHAPE', 'E_TOPOLOGY'],
  examples: [
    {
      description: 'A strand along a curve',
      args: {
        target: '@mesh:ArtMesh_Hair',
        strokes: [
          [
            [10, 10],
            [40, 60],
            [50, 120],
          ],
        ],
        width: 16,
      },
    },
  ],
  apply(d, a) {
    const m = strokeStrip(a.strokes as [number, number][][], a.width, a.spacing ?? a.width);
    if (m.triangles.length === 0)
      throw new MochiError(
        'E_SHAPE',
        'The strokes make no mesh: draw at least one longer stroke.',
        {
          path: 'args.strokes',
        },
      );
    const uv: [number, number][] = [];
    for (let i = 0; i < m.points.length; i += 2) uv.push([m.points[i]!, m.points[i + 1]!]);
    const triangles: [number, number, number][] = [];
    for (let i = 0; i < m.triangles.length; i += 3)
      triangles.push([m.triangles[i]!, m.triangles[i + 1]!, m.triangles[i + 2]!]);
    return meshSetTopology.apply(d, { target: a.target, uv, triangles });
  },
});

export const meshAddVertices = defineCommand({
  name: 'mesh.addVertices',
  summary: 'Add vertices inside a mesh, splitting the triangles they fall in.',
  doc: `Each point (layer pixels, texture space) must lie inside the mesh. A point inside a triangle splits
it into three; a point on an edge splits the triangles of that edge. In every keyform the new
vertex is placed by its barycentric weights, so the mesh looks the same. Existing vertex indices do
not change; the new vertices are appended.`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    points: Points('new vertices, in texture space (layer pixels)'),
  }),
  result: Type.Object({ vertices: Type.Array(Type.Integer()), triangleCount: Type.Integer() }),
  errors: ['E_TOPOLOGY', 'E_SHAPE'],
  examples: [
    {
      description: 'Add a vertex at the eye center',
      args: { target: '@mesh:ArtMesh_EyeL', points: [[20, 12]] },
    },
  ],
  apply(d, a) {
    let mesh = d.getAs(a.target, 'artMesh');
    let uv: Float32Array = mesh.uv;
    let tris: ArrayLike<number> = mesh.triangles;
    const added: number[] = [];
    a.points.forEach(([x, y], i) => {
      const r = topology(() => insertPoint(uv, tris, f32(x), f32(y)), `args.points[${i}]`);
      const n = uv.length / 2;
      mesh = mapMeshPoints(mesh, (p) => {
        const extra = applyDerivations(p, [r.derivation]);
        const out = new Float32Array(p.length + 2);
        out.set(p);
        out.set(extra, p.length);
        return out;
      });
      uv = r.points;
      tris = r.triangles;
      added.push(n);
    });
    const r = commitTopology(d, mesh, uv, tris, null, null);
    return { vertices: added, triangleCount: r.triangleCount };
  },
});

export const meshDeleteVertices = defineCommand({
  name: 'mesh.deleteVertices',
  summary: 'Delete vertices and their triangles, refilling the holes.',
  doc: `Removes the vertices and every triangle that uses them. The hole around an interior vertex is
refilled from its neighbors; at the boundary the hole is refilled only when that keeps the outline
simple. Later vertices move down in index; glue pairs follow, and pairs on deleted vertices are
dropped. The mesh must keep at least three vertices.`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    vertices: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
  }),
  result: TopologyResult,
  errors: ['E_SHAPE', 'E_TOPOLOGY'],
  examples: [
    {
      description: 'Delete two vertices',
      args: { target: '@mesh:ArtMesh_Face', vertices: [12, 13] },
    },
  ],
  apply(d, a) {
    const mesh = d.getAs(a.target, 'artMesh');
    const n = mesh.uv.length / 2;
    const bad = a.vertices.find((v) => v >= n);
    if (bad !== undefined)
      throw new MochiError('E_SHAPE', `The mesh has no vertex ${bad} (it has ${n}).`, {
        path: 'args.vertices',
      });
    const gone = new Set(a.vertices);
    if (n - gone.size < 3)
      throw new MochiError('E_SHAPE', 'A mesh needs at least three vertices.', {
        path: 'args.vertices',
      });
    const r = topology(() => removeVertices(mesh.uv, mesh.triangles, [...gone]));
    const derive: Derivation[] = [];
    r.map.forEach((nw, old) => {
      if (nw >= 0) derive[nw] = { from: [old], weights: [1] };
    });
    return commitTopology(d, mesh, r.points, r.triangles, derive, r.map);
  },
});

export const meshRetriangulate = defineCommand({
  name: 'mesh.retriangulate',
  summary: 'Recompute a mesh’s triangles over its current vertices, keeping its outline.',
  doc: 'A constrained Delaunay triangulation of the current vertices inside the current boundary. Vertices and keyforms are unchanged.',
  args: Type.Object({ target: RefOf(['artMesh']) }),
  result: TopologyResult,
  errors: ['E_TOPOLOGY'],
  examples: [{ description: 'Clean up triangles', args: { target: '@mesh:ArtMesh_Face' } }],
  apply(d, a) {
    const mesh = d.getAs(a.target, 'artMesh');
    const tris = topology(() => retriangulate(mesh.uv, mesh.triangles));
    return commitTopology(d, mesh, mesh.uv, tris, null, null);
  },
});

export const meshFlipEdge = defineCommand({
  name: 'mesh.flipEdge',
  summary: 'Flip the edge between two vertices to the other diagonal of its quad.',
  doc: 'The edge must be shared by two triangles that form a convex quad (in texture space).',
  args: Type.Object({
    target: RefOf(['artMesh']),
    edge: Type.Tuple([Type.Integer({ minimum: 0 }), Type.Integer({ minimum: 0 })]),
  }),
  result: TopologyResult,
  errors: ['E_TOPOLOGY'],
  examples: [
    { description: 'Flip edge 3–7', args: { target: '@mesh:ArtMesh_Face', edge: [3, 7] } },
  ],
  apply(d, a) {
    const mesh = d.getAs(a.target, 'artMesh');
    const tris = topology(
      () => flipEdge(mesh.uv, mesh.triangles, a.edge[0], a.edge[1]),
      'args.edge',
    );
    return commitTopology(d, mesh, mesh.uv, tris, null, null);
  },
});

export const meshMoveUv = defineCommand({
  name: 'mesh.moveUv',
  summary: 'Move texture coordinates of vertices (what part of the image they show).',
  doc: 'Moves uv only; positions in keyforms do not change. Omit `vertices` to move all of them.',
  args: Type.Object({
    target: RefOf(['artMesh']),
    vertices: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
    offset: Type.Tuple([Type.Number(), Type.Number()]),
  }),
  result: Type.Object({ moved: Type.Integer() }),
  errors: ['E_SHAPE'],
  examples: [
    {
      description: 'Shift the whole texture mapping',
      args: { target: '@mesh:ArtMesh_Face', offset: [2, 0] },
    },
  ],
  apply(d, a) {
    const mesh = d.getAs(a.target, 'artMesh');
    const list = selectVertices(mesh, a.vertices);
    const uv = Float32Array.from(mesh.uv);
    for (const v of list) {
      uv[2 * v] = uv[2 * v]! + a.offset[0];
      uv[2 * v + 1] = uv[2 * v + 1]! + a.offset[1];
    }
    d.put({ ...mesh, uv: roundAll(uv) });
    return { moved: list.length };
  },
});

export const meshMoveVertices = defineCommand({
  name: 'mesh.moveVertices',
  summary: 'Move vertices in one keyform (or every keyform) by an offset, in the mesh’s own space.',
  doc: `Offsets keyform positions of the listed vertices (all when omitted), in the parent deformer's
space. Name the keyform with \`cell\` ({parameter: key} for each binding), or use \`all: true\`. The
edited keyforms become authored.`,
  args: Type.Object({
    target: RefOf(['artMesh']),
    cell: Type.Optional(Cell()),
    all: Type.Optional(Type.Boolean()),
    vertices: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
    offset: Type.Tuple([Type.Number(), Type.Number()]),
  }),
  result: Type.Object({ moved: Type.Integer(), cells: Type.Integer() }),
  errors: ['E_SHAPE', 'E_BAD_CELL'],
  examples: [
    {
      description: 'Lower the eyelid when closed',
      args: {
        target: '@mesh:ArtMesh_EyeL',
        cell: { '@param:ParamEyeLOpen': 0 },
        vertices: [0, 1],
        offset: [0, 6],
      },
    },
  ],
  apply(d, a) {
    const mesh = d.getAs(a.target, 'artMesh');
    const list = selectVertices(mesh, a.vertices);
    let cells: number[];
    if (a.all) cells = mesh.rig.keyforms.map((_, i) => i);
    else {
      const c = a.cell ?? {};
      const coords = mesh.rig.bindings.map((b) => {
        const i = b.keys.indexOf(f32(c[b.parameter] ?? NaN));
        if (i < 0)
          throw new MochiError(
            'E_BAD_CELL',
            `The cell must give one of the keys of ${d.describe(b.parameter)} (${b.keys.join(', ')}).`,
            {
              path: `args.cell.${b.parameter}`,
            },
          );
        return i;
      });
      const extra = Object.keys(c).find((p) => !mesh.rig.bindings.some((b) => b.parameter === p));
      if (extra)
        throw new MochiError(
          'E_BAD_CELL',
          `${d.describe(mesh.uid)} is not bound to ${d.describe(extra)}.`,
          { path: `args.cell.${extra}` },
        );
      const n = mesh.rig.keyforms.length;
      cells = [...Array(n).keys()].filter((i) =>
        cellCoords(mesh.rig.bindings, i).every((x, j) => x === coords[j]),
      );
    }
    const keyforms = mesh.rig.keyforms.map((k, i) => {
      if (!cells.includes(i)) return k;
      const p = Float32Array.from(k.positions);
      for (const v of list) {
        p[2 * v] = p[2 * v]! + a.offset[0];
        p[2 * v + 1] = p[2 * v + 1]! + a.offset[1];
      }
      return { ...k, authored: true, positions: roundAll(p) };
    });
    d.put({ ...mesh, rig: { bindings: mesh.rig.bindings, keyforms } });
    return { moved: list.length, cells: cells.length };
  },
});

function selectVertices(mesh: ArtMesh, vertices: number[] | undefined): number[] {
  const n = mesh.uv.length / 2;
  if (vertices === undefined) return [...Array(n).keys()];
  const bad = vertices.find((v) => v >= n);
  if (bad !== undefined)
    throw new MochiError('E_SHAPE', `The mesh has no vertex ${bad} (it has ${n}).`, {
      path: 'args.vertices',
    });
  return [...new Set(vertices)];
}
