/**
 * Model import keeps the file's order: models written with Mochi2D's writer whose
 * orders are deliberately not the ones Mochi Maker's exporter would write. The part, mesh and
 * deformer index orders are shuffled (children before parents included), each draw-order group's
 * entries are reordered (interleaving parts, so the tree cannot hold the order), the nested groups
 * are renumbered, and values are written that no canvas pixel value exports to exactly. Every mesh
 * shares one draw-order value and they overlap, so the stacking decides what is drawn on top.
 *
 * Import and an unedited export must give the same ID orders, the same groups with the same
 * entries in the same order, the same model data, and a bit-identical evaluation (render order
 * included) over seeded poses. Then edits behave: a moved mesh takes its new place in the
 * explicit stacking order, and a new mesh stacks after its neighbour in the tree.
 */
import { describe, expect, it } from 'vitest';
import { Session } from '@mochi-maker/core';
import { ModelInstance, loadMoc, readMoc, type MocData } from 'mochi2d/headless';
import { exportModel } from '../src/index.js';
import { QUAD, quadUv } from './golden.js';
import { orderModel, random, shuffledImport } from './ordermodel.js';

/** The fields of two model data whose values differ, as group.field. */
function changedFields(a: MocData, b: MocData): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (ArrayBuffer.isView(x) || Array.isArray(x)) {
      const ax = Array.from(x as ArrayLike<unknown>);
      const ay = Array.from((y ?? []) as ArrayLike<unknown>);
      if (JSON.stringify(ax) !== JSON.stringify(ay)) out.push(path);
    } else if (x && typeof x === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys((y ?? {}) as object)]))
        walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown> | undefined)?.[k],
          path ? `${path}.${k}` : k,
        );
    } else if (!Object.is(x, y)) out.push(path);
  };
  walk(a, b, '');
  return out;
}

const bytesOf = (a: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex');

/** The first difference in evaluation over seeded poses, or null. */
function evaluationDiff(a: Uint8Array, b: Uint8Array, poses = 200): string | null {
  const ia = new ModelInstance(loadMoc(a));
  const ib = new ModelInstance(loadMoc(b));
  const P = ia.model.parameters;
  const rnd = random(7);
  for (let pose = 0; pose < poses; pose++) {
    for (let p = 0; p < ia.parameterValues.length; p++) {
      const span = P.max[p]! - P.min[p]!;
      const v = pose === 0 ? P.defaults[p]! : P.min[p]! - span / 4 + rnd() * span * 1.5;
      ia.parameterValues[p] = ib.parameterValues[p] = v;
    }
    for (let p = 0; p < ia.partOpacities.length; p++)
      ia.partOpacities[p] = ib.partOpacities[p] = pose === 0 ? 1 : rnd();
    ia.evaluate();
    ib.evaluate();
    const snap = (i: ModelInstance) => [
      ...i.drawableVertices.map(bytesOf),
      bytesOf(i.drawableOpacity),
      bytesOf(i.drawableDrawOrder),
      bytesOf(i.drawableRenderOrder),
      bytesOf(i.drawableMultiply),
      bytesOf(i.drawableScreen),
      bytesOf(i.drawableVisible),
    ];
    const sa = snap(ia);
    const sb = snap(ib);
    for (let k = 0; k < sa.length; k++) if (sa[k] !== sb[k]) return `pose ${pose}, array ${k}`;
  }
  return null;
}

/** Pool offsets and pools: where values sit, not what they are. */
const LAYOUT =
  /^(artMeshes|parts|warpDeformers|rotationDeformers|glues)\.(firstKeyform|firstUv|firstTriangleIndex|firstMask|firstColor|firstInfo)$|^(artMeshKeyforms|warpKeyforms|rotationKeyforms)\.(firstPosition|multiplyColor|screenColor)$|^(keyformPositions|uvs|triangleIndices|maskEntries|multiplyColors\.[rgb]|screenColors\.[rgb]|partKeyforms\.drawOrder|artMeshKeyforms\.(opacity|drawOrder)|warpKeyforms\.opacity|rotationKeyforms\.\w+|glueKeyforms\.intensity|glueInfo\.\w+)$/;

/** Each mesh's own data by ID: texture, flags, UVs, triangles, masks (by ID), part and deformer. */
function meshContent(d: MocData): Record<string, string> {
  const A = d.artMeshes;
  const out: Record<string, string> = {};
  A.ids.forEach((id, i) => {
    const uv = Array.from(d.uvs.slice(A.firstUv[i]!, A.firstUv[i]! + 2 * A.vertexCount[i]!));
    const tri = Array.from(
      d.triangleIndices.slice(
        A.firstTriangleIndex[i]!,
        A.firstTriangleIndex[i]! + A.triangleIndexCount[i]!,
      ),
    );
    const masks = Array.from(
      d.maskEntries.slice(A.firstMask[i]!, A.firstMask[i]! + A.maskCount[i]!),
    ).map((k) => A.ids[k]);
    out[id] = JSON.stringify({
      texture: A.texture[i],
      flags: A.flags[i],
      visible: A.visible[i],
      part: A.part[i]! >= 0 ? d.parts.ids[A.part[i]!] : null,
      deformer: A.deformer[i]! >= 0 ? d.deformers.ids[A.deformer[i]!] : null,
      uv,
      tri,
      masks,
    });
  });
  return out;
}

/** Each group's entries as (kind, ID) and its nested group's index, for comparing. */
function groups(d: MocData): string[] {
  const O = d.drawOrderGroupObjects;
  const G = d.drawOrderGroups;
  return [...G.firstObject.keys()].map((g) => {
    const entries = Array.from({ length: G.objectCount[g]! }, (_, j) => {
      const o = G.firstObject[g]! + j;
      const id = O.kind[o] === 0 ? d.artMeshes.ids[O.index[o]!] : d.parts.ids[O.index[o]!];
      return `${O.kind[o]}:${id}:${O.nestedGroup[o]}`;
    });
    return `${G.minDrawOrder[g]}..${G.maxDrawOrder[g]} [${entries.join(' ')}]`;
  });
}

describe('model import keeps the file’s order', () => {
  for (const version of [3, 4, 5, 6] as const)
    for (const seed of [1, 2, 3])
      it(`a shuffled version ${version} model (seed ${seed}) exports again as the file was`, async () => {
        const m = await shuffledImport(version, seed);
        const again = await exportModel(m.document, m.assets);
        const back = readMoc(again.files.get('order.moc3')!).data;
        for (const k of ['parts', 'artMeshes', 'deformers', 'glues', 'parameters'] as const)
          expect(back[k].ids, k).toEqual(m.data[k].ids);
        expect(groups(back)).toEqual(groups(m.data));
        expect(evaluationDiff(m.bytes, again.files.get('order.moc3')!)).toBeNull();
        // What else differs is only where things sit in the shared pools (the exporter lays out
        // keyforms, positions and colors in object order): the same values per object.
        for (const f of changedFields(m.data, back)) expect(f, f).toMatch(LAYOUT);
        expect(meshContent(back)).toEqual(meshContent(m.data));
      });

  it('changes the render order when the stacking changes, so the test can see it', async () => {
    const m = await shuffledImport(5, 1);
    const plain = await orderModel();
    const ours = (await exportModel(plain.session.doc, plain.assets)).files.get('order.moc3')!;
    // The shuffled file and Mochi Maker's own export of the same model draw in different orders.
    expect(evaluationDiff(m.bytes, ours, 1)).not.toBeNull();
  });

  it('after a move in the tree, the explicit stacking order follows; a new mesh stacks after its neighbour', async () => {
    // The first seed whose top group interleaves members of different parts: the tree cannot hold
    // that, so the project keeps the order explicitly.
    let m = await shuffledImport(5, 1);
    for (let seed = 2; m.document.objects.project!.kind === 'project'; seed++) {
      const p = m.document.objects.project as { stacks: { scope: string | null }[] };
      if (p.stacks.some((x) => x.scope === null) || seed > 40) break;
      m = await shuffledImport(5, seed);
    }
    expect(m.report.inexact).toBeGreaterThan(0);
    const s = Session.open(m.document);
    expect(s.view.project().stacks.some((x) => x.scope === null)).toBe(true);
    // Move M09 to the top level's end: in the top group's stack it now stands after its new
    // predecessor in the tree.
    s.run('tree.move', { target: '@mesh:M09', parent: null });
    const m09 = s.view.ofKind('artMesh').find((x) => x.exportId === 'M09')!.uid;
    const root = s.view.project().root;
    const stack = s.view.project().stacks.find((x) => x.scope === null)!.entries;
    const prev = root[root.indexOf(m09) - 1]!;
    const before = s.view.get(prev)!;
    const lastMember =
      before.kind === 'artMesh' || (before.kind === 'part' && before.sortingScope === 'own')
        ? prev
        : null;
    if (lastMember) expect(stack.indexOf(m09)).toBe(stack.indexOf(lastMember) + 1);
    const moved = await exportModel(s.doc, m.assets);
    const data = readMoc(moved.files.get('order.moc3')!).data;
    const top = groups(data)[0]!;
    expect(top).toContain('0:M09:-1');
    // A new mesh at the top level stacks after its predecessor in the tree.
    s.run('mesh.create', {
      exportId: 'M11',
      layer: s.view.ofKind('layer')[0]!.uid,
      uv: quadUv(40, 40),
      triangles: QUAD,
      positions: [
        [0, 0],
        [50, 0],
        [50, 50],
        [0, 50],
      ],
    });
    const withNew = readMoc((await exportModel(s.doc, m.assets)).files.get('order.moc3')!).data;
    const entries = groups(withNew)[0]!;
    expect(entries.indexOf('0:M11:-1')).toBe(entries.indexOf('0:M09:-1') + '0:M09:-1 '.length);
  });
});
