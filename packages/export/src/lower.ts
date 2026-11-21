/**
 * Lowering: from a Mochi Maker document to Mochi2D's model data (design 4.3, step 2).
 *
 * Pure and deterministic. Object order:
 * - parts: depth-first through the part tree (parents first);
 * - deformers: the project's deformer order (parents first);
 * - meshes: depth-first through the part tree, in children order, so ties in draw order keep the
 *   document's back-to-front order;
 * - parameters and glues: their project order.
 * - keyforms: in object order, each object's keyforms contiguous, so the `official` level's
 *   position-run test always passes. Blend-shape keyforms (M8) go last.
 *
 * Spaces (design 3.5): the document stores top-level objects in canvas pixels (y down). The file
 * stores them in model units: x = (px − originX)/ppu, y = (py − originY)/ppu. Objects inside a
 * deformer are stored in that deformer's space unchanged. A rotation whose chain has no rotation
 * above it gets its scale multiplied by 1/ppu, because its children are stored in pixel units.
 */
import type {
  AnyDelta,
  ArtMesh,
  BlendShape,
  MeshDelta,
  GlueDelta,
  PartDelta,
  RotationDelta,
  WarpDelta,
  DocReader,
  Glue,
  ImportKeep,
  MeshKeyform,
  Parameter,
  Part,
  Riggable,
  Rotation,
  RotationKeyform,
  Uid,
  Warp,
  WarpKeyform,
} from '@mochi-maker/core';
import type { MocData, MocVersion } from 'mochi2d/headless';
import { blendCode, stackOrder } from '@mochi-maker/core';
import { DECIMALS, expectedGroupRanges, padPositionRuns } from './rules.js';

/** Where a mesh's texture comes from: atlas page and the map from layer pixels to page pixels. */
export interface TexturePlacement {
  page: number;
  pageWidth: number;
  pageHeight: number;
  /** page pixel = layer pixel + offset */
  offsetX: number;
  offsetY: number;
}

export interface LowerOptions {
  version: MocVersion;
  /** Texture placement per layer UID. */
  placement: ReadonlyMap<Uid, TexturePlacement>;
}

export interface LowerResult {
  data: MocData;
  /** The document UID of each object, by group and index, for mapping diagnostics back. */
  uids: {
    parts: Uid[];
    deformers: Uid[];
    artMeshes: Uid[];
    parameters: Uid[];
    glues: Uid[];
  };
  /** Each draw-order group's own-scope part (null for the top), by group index. */
  groupScopes: (Uid | null)[];
}

/**
 * Sets each draw-order group's range: the reachable one, or an imported file's own while the
 * group is the file's (same index and scope) and its reachable range is the one the file's data
 * gave. Evaluation reads the range, so an unedited export must write the file's.
 */
export function setGroupRanges(
  data: MocData,
  version: number,
  keep: ImportKeep | null | undefined,
  scopes: readonly (Uid | null)[],
): void {
  const ranges = expectedGroupRanges(data, version);
  for (const [g, min, max, emin, emax] of keep?.ranges ?? []) {
    const r = ranges[g];
    if (r && r.min === emin && r.max === emax && scopes[g] === (keep!.groups[g] ?? null))
      ranges[g] = { min, max };
  }
  data.drawOrderGroups.minDrawOrder = i32(ranges.map((r) => r.min));
  data.drawOrderGroups.maxDrawOrder = i32(ranges.map((r) => r.max));
}

const i32 = (a: number[]) => Int32Array.from(a);
const f32a = (a: number[]) => Float32Array.from(a);

export function lowerDocument(doc: DocReader, options: LowerOptions): LowerResult {
  const v = options.version;
  const project = doc.project();
  const { pixelsPerUnit: ppu, originX, originY } = project.canvas;

  // ---------------------------------------------------------------- object order
  const parts: Part[] = [];
  const meshes: ArtMesh[] = [];
  const walk = (list: Uid[]) => {
    for (const uid of list) {
      const o = doc.get(uid);
      if (o?.kind === 'part') {
        parts.push(o);
        walk(o.children);
      } else if (o?.kind === 'artMesh') meshes.push(o);
    }
  };
  walk(project.root);
  // An imported model keeps its file's index orders (and values; see `exact`).
  const keep = project.importedFrom?.keep ?? null;
  const inOrder = <T extends { uid: Uid }>(list: T[], order: string[] | undefined): T[] => {
    if (!order || order.length === 0) return list;
    const pos = new Map(order.map((u, i) => [u, i]));
    const known = list.filter((o) => pos.has(o.uid));
    known.sort((a, b) => pos.get(a.uid)! - pos.get(b.uid)!);
    return [...known, ...list.filter((o) => !pos.has(o.uid))];
  };
  parts.splice(0, parts.length, ...inOrder(parts, keep?.parts));
  meshes.splice(0, meshes.length, ...inOrder(meshes, keep?.artMeshes));
  const deformers = inOrder(
    project.deformerOrder.map((u) => doc.get(u) as Warp | Rotation),
    keep?.deformers,
  );
  const fileValues = new Map((keep?.values ?? []).map(([path, d, f]) => [path, [d, f] as const]));
  /** The file's value at `path` while the document still holds what the import made of it. */
  const exact = (path: string, doc: number, computed: number): number => {
    if (fileValues.size === 0) return computed;
    const o = fileValues.get(path);
    return o && o[0] === doc ? o[1] : computed;
  };
  const hidden = new Set(keep?.hidden ?? []);
  const decimalsOf = new Map(keep?.decimals ?? []);
  const extraFlags = new Map(keep?.meshFlags ?? []);
  // Version 6 codes and flags as an imported file has them (see ImportKeep).
  const keptBlend = new Map((keep?.blendCodes ?? []).map(([u, d, f]) => [u, [d, f] as const]));
  /** The file's code while the document's is the one the import gave it. */
  const codeOf = (uid: Uid, computed: number) => {
    const k = keptBlend.get(uid);
    return k && k[0] === computed ? k[1] : computed;
  };
  const keptOffscreenFlags = new Map(keep?.offscreenFlags ?? []);
  const keptBlendFlags = new Map((keep?.blendFlags ?? []).map(([u, d, f]) => [u, [d, f] as const]));
  const parameters = project.parameterOrder.map((u) => doc.get(u) as Parameter);
  const glues = project.glueOrder.map((u) => doc.get(u) as Glue);
  const index = (list: { uid: Uid }[]) => new Map(list.map((o, i) => [o.uid, i]));
  const partIdx = index(parts);
  const meshIdx = index(meshes);
  const defIdx = index(deformers);

  // ---------------------------------------------------------------- bindings and bands
  // Distinct key sets per parameter, in first-use order; owned contiguously, parameter by parameter.
  const riggables: Riggable[] = [...parts, ...deformers, ...meshes, ...glues];
  const keySets = new Map<Uid, Map<string, number[]>>();
  for (const o of riggables)
    for (const b of o.rig.bindings) {
      const m = keySets.get(b.parameter) ?? new Map<string, number[]>();
      m.set(b.keys.join(','), b.keys);
      keySets.set(b.parameter, m);
    }
  const keys: number[] = [];
  const pbFirstKey: number[] = [];
  const pbKeyCount: number[] = [];
  const bindingOf = new Map<string, number>(); // `${param}|${keys}` → parameter binding index
  const paramFirstBinding: number[] = [];
  const paramBindingCount: number[] = [];
  for (const p of parameters) {
    paramFirstBinding.push(pbFirstKey.length);
    const sets = keySets.get(p.uid) ?? new Map<string, number[]>();
    for (const [k, list] of sets) {
      bindingOf.set(`${p.uid}|${k}`, pbFirstKey.length);
      pbFirstKey.push(keys.length);
      pbKeyCount.push(list.length);
      keys.push(...list);
    }
    paramBindingCount.push(sets.size);
  }

  // Blend-shape parameter bindings: one per distinct (parameter, keys, base), owned
  // contiguously, parameter by parameter, after the normal bindings' keys in the key pool.
  const shapeTargets: (Part | ArtMesh | Warp | Rotation | Glue)[] = [
    ...parts,
    ...deformers,
    ...meshes,
    ...glues,
  ];
  const shapeKey = (b: BlendShape) => `${b.keys.join(',')}|${b.base}`;
  const shapeSets = new Map<Uid, Map<string, BlendShape>>();
  for (const o of shapeTargets)
    for (const b of o.blendShapes) {
      const m = shapeSets.get(b.parameter) ?? new Map<string, BlendShape>();
      if (!m.has(shapeKey(b))) m.set(shapeKey(b), b);
      shapeSets.set(b.parameter, m);
    }
  const BPB = { firstKey: [] as number[], keyCount: [] as number[], baseKey: [] as number[] };
  const shapeBindingOf = new Map<string, number>(); // `${param}|${keys}|${base}` → index
  const paramFirstShape: number[] = [];
  const paramShapeCount: number[] = [];
  for (const p of parameters) {
    paramFirstShape.push(BPB.firstKey.length);
    const sets = shapeSets.get(p.uid) ?? new Map<string, BlendShape>();
    for (const [k, b] of sets) {
      shapeBindingOf.set(`${p.uid}|${k}`, BPB.firstKey.length);
      BPB.firstKey.push(keys.length);
      BPB.keyCount.push(b.keys.length);
      BPB.baseKey.push(b.keys.indexOf(b.base));
      keys.push(...b.keys);
    }
    paramShapeCount.push(sets.size);
  }
  const bandOf = new Map<string, number>([['', 0]]);
  const bandFirst: number[] = [0];
  const bandCount: number[] = [0];
  const bindingIndices: number[] = [];
  const band = (o: Riggable): number => {
    const list = o.rig.bindings.map((b) => bindingOf.get(`${b.parameter}|${b.keys.join(',')}`)!);
    const key = list.join(',');
    let bi = bandOf.get(key);
    if (bi === undefined) {
      bi = bandFirst.length;
      bandOf.set(key, bi);
      bandFirst.push(bindingIndices.length);
      bandCount.push(list.length);
      bindingIndices.push(...list);
    }
    return bi;
  };

  // ---------------------------------------------------------------- colors (v4+)
  const mulR: number[] = [];
  const mulG: number[] = [];
  const mulB: number[] = [];
  const scrR: number[] = [];
  const scrG: number[] = [];
  const scrB: number[] = [];
  const addColors = (kfs: { multiply: number[]; screen: number[] }[]): number => {
    const first = mulR.length;
    for (const k of kfs) {
      mulR.push(k.multiply[0]!);
      mulG.push(k.multiply[1]!);
      mulB.push(k.multiply[2]!);
      scrR.push(k.screen[0]!);
      scrG.push(k.screen[1]!);
      scrB.push(k.screen[2]!);
    }
    return first;
  };

  // ---------------------------------------------------------------- spaces
  const hasRotationAbove = (d: Warp | Rotation): boolean => {
    let p = d.parent;
    while (p !== null) {
      const o = doc.get(p) as Warp | Rotation;
      if (o.kind === 'rotation') return true;
      p = o.parent;
    }
    return false;
  };
  /** Canvas pixels → model units; `path` names the values for `exact`. */
  const toModel = (pts: Float32Array, path: string): number[] => {
    const out: number[] = [];
    for (let i = 0; i < pts.length; i += 2)
      out.push(
        exact(`${path}/${i}`, pts[i]!, (pts[i]! - originX) / ppu),
        exact(`${path}/${i + 1}`, pts[i + 1]!, (pts[i + 1]! - originY) / ppu),
      );
    return out;
  };
  const positions: number[] = [];

  // ---------------------------------------------------------------- parts
  const partKf = { drawOrder: [] as number[], offscreenKeyform: [] as number[] };
  // Version 6: parts drawn offscreen, in part order. Such a part's normal keyforms are its
  // offscreen's normal keyforms, which come first in the offscreen keyforms; blend-shape ones follow.
  const v6 = v >= 6;
  const offParts = v6
    ? inOrder(
        parts.filter((p) => p.offscreen),
        keep?.offscreens,
      )
    : [];
  const offIdx = new Map(offParts.map((p, i) => [p.uid, i]));
  let offscreenKeyforms = 0;
  const P = {
    band: [] as number[],
    firstKeyform: [] as number[],
    keyformCount: [] as number[],
    visible: [] as number[],
    enabled: [] as number[],
    parent: [] as number[],
  };
  for (const p of parts) {
    P.band.push(band(p));
    P.firstKeyform.push(partKf.drawOrder.length);
    P.keyformCount.push(p.rig.keyforms.length);
    P.visible.push(p.visibleAtStart ? 1 : 0);
    P.enabled.push(p.enabled ? 1 : 0);
    P.parent.push(p.parent === null ? -1 : partIdx.get(p.parent)!);
    const off = offIdx.has(p.uid);
    for (const k of p.rig.keyforms) {
      partKf.drawOrder.push(k.drawOrder);
      partKf.offscreenKeyform.push(off ? offscreenKeyforms++ : -1);
    }
  }

  // ---------------------------------------------------------------- deformers
  const D = {
    band: [] as number[],
    enabled: [] as number[],
    part: [] as number[],
    parent: [] as number[],
    kind: [] as number[],
    kindIndex: [] as number[],
  };
  const W = {
    band: [] as number[],
    firstKeyform: [] as number[],
    keyformCount: [] as number[],
    pointCount: [] as number[],
    rows: [] as number[],
    columns: [] as number[],
    bilinear: [] as number[],
    firstColor: [] as number[],
  };
  const R = {
    band: [] as number[],
    firstKeyform: [] as number[],
    keyformCount: [] as number[],
    baseAngle: [] as number[],
    firstColor: [] as number[],
  };
  const WK = { opacity: [] as number[], firstPosition: [] as number[], color: [] as number[] };
  const RK = {
    opacity: [] as number[],
    angle: [] as number[],
    originX: [] as number[],
    originY: [] as number[],
    scale: [] as number[],
    mirrorX: [] as number[],
    mirrorY: [] as number[],
    color: [] as number[],
  };
  for (const d of deformers) {
    const b = band(d);
    D.band.push(b);
    D.enabled.push(d.enabled ? 1 : 0);
    D.part.push(d.part === null ? -1 : partIdx.get(d.part)!);
    D.parent.push(d.parent === null ? -1 : defIdx.get(d.parent)!);
    if (d.kind === 'warp') {
      D.kind.push(0);
      D.kindIndex.push(W.band.length);
      W.band.push(b);
      W.firstKeyform.push(WK.opacity.length);
      W.keyformCount.push(d.rig.keyforms.length);
      W.pointCount.push((d.rows + 1) * (d.cols + 1));
      W.rows.push(d.rows);
      W.columns.push(d.cols);
      W.bilinear.push(d.cellMode === 'bilinear' ? 1 : 0);
      const first = addColors(d.rig.keyforms as WarpKeyform[]);
      W.firstColor.push(first);
      d.rig.keyforms.forEach((k, i) => {
        WK.opacity.push(k.opacity);
        WK.firstPosition.push(positions.length);
        positions.push(
          ...(d.parent === null ? toModel(k.grid, `${d.uid}/kf${i}`) : Array.from(k.grid)),
        );
        WK.color.push(first + i);
      });
    } else {
      D.kind.push(1);
      D.kindIndex.push(R.band.length);
      R.band.push(b);
      R.firstKeyform.push(RK.opacity.length);
      R.keyformCount.push(d.rig.keyforms.length);
      R.baseAngle.push(d.baseAngle);
      const first = addColors(d.rig.keyforms as RotationKeyform[]);
      R.firstColor.push(first);
      const factor = hasRotationAbove(d) ? 1 : 1 / ppu;
      d.rig.keyforms.forEach((k, i) => {
        RK.opacity.push(k.opacity);
        RK.angle.push(k.angle);
        const [ox, oy] =
          d.parent === null
            ? [
                exact(`${d.uid}/kf${i}/ox`, k.originX, (k.originX - originX) / ppu),
                exact(`${d.uid}/kf${i}/oy`, k.originY, (k.originY - originY) / ppu),
              ]
            : [k.originX, k.originY];
        RK.originX.push(ox!);
        RK.originY.push(oy!);
        RK.scale.push(exact(`${d.uid}/kf${i}/s`, k.scale, k.scale * factor));
        RK.mirrorX.push(k.mirrorX ? 1 : 0);
        RK.mirrorY.push(k.mirrorY ? 1 : 0);
        RK.color.push(first + i);
      });
    }
  }

  // ---------------------------------------------------------------- art meshes
  const M = {
    band: [] as number[],
    firstKeyform: [] as number[],
    keyformCount: [] as number[],
    enabled: [] as number[],
    part: [] as number[],
    deformer: [] as number[],
    texture: [] as number[],
    flags: [] as number[],
    vertexCount: [] as number[],
    firstUv: [] as number[],
    firstTriangleIndex: [] as number[],
    triangleIndexCount: [] as number[],
    firstMask: [] as number[],
    maskCount: [] as number[],
    firstColor: [] as number[],
    blendMode: [] as number[],
  };
  const MK = {
    opacity: [] as number[],
    drawOrder: [] as number[],
    firstPosition: [] as number[],
    color: [] as number[],
  };
  const uvs: number[] = [];
  const tris: number[] = [];
  const masks: number[] = [];
  for (const m of meshes) {
    M.band.push(band(m));
    M.firstKeyform.push(MK.opacity.length);
    M.keyformCount.push(m.rig.keyforms.length);
    M.enabled.push(m.enabled ? 1 : 0);
    M.part.push(m.part === null ? -1 : partIdx.get(m.part)!);
    M.deformer.push(m.deformer === null ? -1 : defIdx.get(m.deformer)!);
    const place = m.layer ? options.placement.get(m.layer) : undefined;
    M.texture.push(place?.page ?? 0);
    const legacyCode =
      m.legacyBlend === 'additive' ? 1 : m.legacyBlend === 'multiplicative' ? 2 : 0;
    // Flag bits 0–1: the legacy blending, or a version 6 file's own while it is unedited.
    const kept = keptBlendFlags.get(m.uid);
    let flags = kept && kept[0] === legacyCode ? kept[1] : legacyCode;
    if (m.doubleSided) flags |= 4;
    if (m.clip?.invert) flags |= 8;
    M.flags.push(flags | (extraFlags.get(m.uid) ?? 0));
    M.blendMode.push(codeOf(m.uid, m.blend ? blendCode(m.blend) : legacyCode));
    M.vertexCount.push(m.uv.length / 2);
    M.firstUv.push(uvs.length);
    for (let i = 0; i < m.uv.length; i += 2) {
      if (place)
        uvs.push(
          exact(`${m.uid}/uv/${i}`, m.uv[i]!, (m.uv[i]! + place.offsetX) / place.pageWidth),
          exact(
            `${m.uid}/uv/${i + 1}`,
            m.uv[i + 1]!,
            (m.uv[i + 1]! + place.offsetY) / place.pageHeight,
          ),
        );
      else uvs.push(0, 0);
    }
    M.firstTriangleIndex.push(tris.length);
    M.triangleIndexCount.push(m.triangles.length);
    tris.push(...m.triangles);
    M.firstMask.push(masks.length);
    const list = m.clip?.masks ?? [];
    M.maskCount.push(list.length);
    for (const u of list) masks.push(meshIdx.get(u)!);
    const first = addColors(m.rig.keyforms as MeshKeyform[]);
    M.firstColor.push(first);
    m.rig.keyforms.forEach((k, i) => {
      MK.opacity.push(k.opacity);
      MK.drawOrder.push(k.drawOrder);
      MK.firstPosition.push(positions.length);
      positions.push(
        ...(m.deformer === null
          ? toModel(k.positions, `${m.uid}/kf${i}`)
          : Array.from(k.positions)),
      );
      MK.color.push(first + i);
    });
  }

  // ---------------------------------------------------------------- offscreens (version 6)
  const OF = {
    part: [] as number[],
    flags: [] as number[],
    blendMode: [] as number[],
    firstMask: [] as number[],
    maskCount: [] as number[],
  };
  const OK = { opacity: [] as number[], color: [] as number[] };
  for (const p of offParts) {
    const o = p.offscreen!;
    OF.part.push(partIdx.get(p.uid)!);
    // Bit 2 as files usually have it (not read for offscreens), bit 3 the inverted mask.
    OF.flags.push((o.clip?.invert ? 8 : 0) | (keptOffscreenFlags.get(p.uid) ?? 4));
    OF.blendMode.push(codeOf(p.uid, blendCode(o.blend)));
    OF.firstMask.push(masks.length);
    const list = o.clip?.masks ?? [];
    OF.maskCount.push(list.length);
    for (const u of list) masks.push(meshIdx.get(u)!);
    // Both colors of keyform j come from entry first + j.
    const first = addColors(p.rig.keyforms);
    p.rig.keyforms.forEach((k, j) => {
      OK.opacity.push(k.opacity);
      OK.color.push(first + j);
    });
  }

  // ---------------------------------------------------------------- draw-order groups
  const G = {
    firstObject: [] as number[],
    objectCount: [] as number[],
    entryCount: [] as number[],
    max: [] as number[],
    min: [] as number[],
  };
  const O = { kind: [] as number[], index: [] as number[], nested: [] as number[] };
  // Each group's members in stacking order (stacking.ts): the tree's, or the project's explicit
  // one. Groups are numbered in pre-order, or in the imported file's order; their objects are laid
  // out nested groups first.
  interface GroupNode {
    scope: Uid | null;
    objs: { kind: number; index: number; nested: GroupNode | null }[];
    entries: number;
    g: number;
  }
  const buildNode = (scope: Uid | null): GroupNode => {
    const node: GroupNode = { scope, objs: [], entries: 0, g: -1 };
    for (const uid of stackOrder(doc, scope)) {
      const o = doc.get(uid);
      if (o?.kind === 'artMesh') {
        node.objs.push({ kind: 0, index: meshIdx.get(uid)!, nested: null });
        node.entries += 1;
      } else if (o?.kind === 'part') {
        const nested = buildNode(uid);
        node.objs.push({ kind: 1, index: partIdx.get(uid)!, nested });
        // A part's offscreen is one more entry of the group it is drawn in.
        node.entries += nested.entries + (offIdx.has(uid) ? 1 : 0);
      }
    }
    return node;
  };
  const rootGroup = buildNode(null);
  const nodes: GroupNode[] = [];
  const preorder = (n: GroupNode) => {
    nodes.push(n);
    for (const o of n.objs) if (o.nested) preorder(o.nested);
  };
  preorder(rootGroup);
  const keptGroups = new Map((keep?.groups ?? []).map((sc, i) => [sc ?? '', i]));
  const numbered = keptGroups.size
    ? [
        ...nodes
          .filter((n) => keptGroups.has(n.scope ?? ''))
          .sort((a, b) => keptGroups.get(a.scope ?? '')! - keptGroups.get(b.scope ?? '')!),
        ...nodes.filter((n) => !keptGroups.has(n.scope ?? '')),
      ]
    : nodes;
  numbered.forEach((n, i) => {
    n.g = i;
    G.firstObject.push(0);
    G.objectCount.push(0);
    G.entryCount.push(0);
    G.max.push(0);
    G.min.push(0);
  });
  const emit = (n: GroupNode) => {
    for (const o of n.objs) if (o.nested) emit(o.nested);
    G.firstObject[n.g] = O.kind.length;
    G.objectCount[n.g] = n.objs.length;
    G.entryCount[n.g] = n.entries;
    // The range is filled in after assembly, from the data (expectedGroupRanges).
    for (const o of n.objs) {
      O.kind.push(o.kind);
      O.index.push(o.index);
      O.nested.push(o.nested ? o.nested.g : -1);
    }
  };
  emit(rootGroup);

  // ---------------------------------------------------------------- glues
  const GL = {
    band: [] as number[],
    firstKeyform: [] as number[],
    keyformCount: [] as number[],
    a: [] as number[],
    b: [] as number[],
    firstInfo: [] as number[],
    infoCount: [] as number[],
  };
  const info = { weight: [] as number[], vertex: [] as number[] };
  const intensity: number[] = [];
  for (const g of glues) {
    GL.band.push(band(g));
    GL.firstKeyform.push(intensity.length);
    GL.keyformCount.push(g.rig.keyforms.length);
    for (const k of g.rig.keyforms) intensity.push(k.intensity);
    GL.a.push(meshIdx.get(g.meshA)!);
    GL.b.push(meshIdx.get(g.meshB)!);
    GL.firstInfo.push(info.weight.length);
    GL.infoCount.push(2 * g.pairs.length);
    // Each pair is stored as (vertex of A, weight of A), then (vertex of B, weight of B).
    for (const [va, wa, vb, wb] of g.pairs) {
      info.vertex.push(va, vb);
      info.weight.push(wa, wb);
    }
  }
  // ---------------------------------------------------------------- blend shapes
  // Difference-based interpolation (design 3.7). Each blend shape
  // becomes a keyform binding with one keyform per key, holding its deltas (the base key's is all
  // zero). Blend-shape keyforms follow every normal keyform of their kind, and
  // their positions follow every normal position, so the position-run check holds.
  // From version 5 each of them gets its own color entries, which hold color deltas.
  const KB = {
    parameterBinding: [] as number[],
    firstKeyform: [] as number[],
    keyformCount: [] as number[],
    firstConstraintEntry: [] as number[],
    constraintEntryCount: [] as number[],
  };
  const constraintEntries: number[] = [];
  const CS = { parameter: [] as number[], firstValue: [] as number[], valueCount: [] as number[] };
  const CV = { key: [] as number[], weight: [] as number[] };
  const paramIdx = index(parameters);
  type Targets = { object: number[]; firstBinding: number[]; bindingCount: number[] };
  const targets = (): Targets => ({ object: [], firstBinding: [], bindingCount: [] });
  const T = {
    warp: targets(),
    artMesh: targets(),
    part: targets(),
    rotation: targets(),
    glue: targets(),
    offscreen: targets(),
  };
  /** Adds an object's blend shapes; `push` stores one delta keyform and returns its keyform index. */
  const addShapes = <D extends AnyDelta>(
    t: Targets,
    object: number,
    shapes: BlendShape<D>[],
    push: (d: D, color: number, path: string) => number,
    colors: boolean,
    uid: Uid,
  ) => {
    if (shapes.length === 0) return;
    t.object.push(object);
    t.firstBinding.push(KB.parameterBinding.length);
    t.bindingCount.push(shapes.length);
    for (const [bi, b] of shapes.entries()) {
      KB.parameterBinding.push(shapeBindingOf.get(`${b.parameter}|${shapeKey(b)}`)!);
      KB.keyformCount.push(b.keys.length);
      KB.firstConstraintEntry.push(constraintEntries.length);
      KB.constraintEntryCount.push(b.constraints.length);
      for (const c of b.constraints) {
        constraintEntries.push(CS.parameter.length);
        CS.parameter.push(paramIdx.get(c.parameter)!);
        CS.firstValue.push(CV.key.length);
        CS.valueCount.push(c.points.length);
        for (const [k, w] of c.points) {
          CV.key.push(k);
          CV.weight.push(w);
        }
      }
      const first =
        colors && v >= 5
          ? addColors(b.deltas as unknown as { multiply: number[]; screen: number[] }[])
          : 0;
      let firstKf = -1;
      b.deltas.forEach((d, k) => {
        const at = push(d, first + k, `${uid}/bs${bi}/${k}`);
        if (k === 0) firstKf = at;
      });
      KB.firstKeyform.push(firstKf);
    }
  };
  // Offsets convert with the scale only: a top-level offset of p pixels is p/ppu model units.
  const scaled = (pts: Float32Array, top: boolean, path: string) =>
    top ? Array.from(pts, (x, i) => exact(`${path}/${i}`, x, x / ppu)) : Array.from(pts);
  for (const d of deformers) {
    const ki = D.kindIndex[defIdx.get(d.uid)!]!;
    if (d.kind === 'warp')
      addShapes(
        T.warp,
        ki,
        d.blendShapes as BlendShape<WarpDelta>[],
        (x, color, path) => {
          WK.opacity.push(x.opacity);
          WK.firstPosition.push(positions.length);
          positions.push(...scaled(x.grid, d.parent === null, path));
          WK.color.push(color);
          return WK.opacity.length - 1;
        },
        true,
        d.uid,
      );
  }
  meshes.forEach((m, mi) =>
    addShapes(
      T.artMesh,
      mi,
      m.blendShapes as BlendShape<MeshDelta>[],
      (x, color, path) => {
        MK.opacity.push(x.opacity);
        MK.drawOrder.push(x.drawOrder);
        MK.firstPosition.push(positions.length);
        positions.push(...scaled(x.positions, m.deformer === null, path));
        MK.color.push(color);
        return MK.opacity.length - 1;
      },
      true,
      m.uid,
    ),
  );
  parts.forEach((p, pi) =>
    addShapes(
      T.part,
      pi,
      p.blendShapes as BlendShape<PartDelta>[],
      (x) => {
        partKf.drawOrder.push(x.drawOrder);
        partKf.offscreenKeyform.push(-1);
        return partKf.drawOrder.length - 1;
      },
      false,
      p.uid,
    ),
  );
  // An offscreen's blend shapes: those of its part that change its opacity or colors.
  const offDelta = (x: PartDelta) =>
    x.opacity !== 0 || x.multiply.some((c) => c !== 0) || x.screen.some((c) => c !== 0);
  offParts.forEach((p, oi) =>
    addShapes(
      T.offscreen,
      oi,
      (p.blendShapes as BlendShape<PartDelta>[]).filter((b) => b.deltas.some(offDelta)),
      (x, color) => {
        OK.opacity.push(x.opacity);
        OK.color.push(color);
        return OK.opacity.length - 1;
      },
      true,
      p.uid,
    ),
  );
  for (const d of deformers) {
    if (d.kind !== 'rotation') continue;
    const ki = D.kindIndex[defIdx.get(d.uid)!]!;
    const factor = hasRotationAbove(d) ? 1 : 1 / ppu;
    const top = d.parent === null;
    addShapes(
      T.rotation,
      ki,
      d.blendShapes as BlendShape<RotationDelta>[],
      (x, color, path) => {
        RK.opacity.push(x.opacity);
        RK.angle.push(x.angle);
        RK.originX.push(top ? exact(`${path}/ox`, x.originX, x.originX / ppu) : x.originX);
        RK.originY.push(top ? exact(`${path}/oy`, x.originY, x.originY / ppu) : x.originY);
        RK.scale.push(exact(`${path}/s`, x.scale, x.scale * factor));
        RK.mirrorX.push(exact(`${path}/mx`, 0, 0));
        RK.mirrorY.push(exact(`${path}/my`, 0, 0));
        RK.color.push(color);
        return RK.opacity.length - 1;
      },
      true,
      d.uid,
    );
  }

  // Glue blend shapes change the intensity; version 5 only.
  glues.forEach((g, gi) =>
    addShapes(
      T.glue,
      gi,
      g.blendShapes as BlendShape<GlueDelta>[],
      (x) => {
        intensity.push(x.intensity);
        return intensity.length - 1;
      },
      false,
      g.uid,
    ),
  );

  // ---------------------------------------------------------------- assemble
  const data: MocData = {
    canvas: {
      pixelsPerUnit: Math.fround(ppu),
      originX: Math.fround(originX),
      originY: Math.fround(originY),
      width: Math.fround(project.canvas.width),
      height: Math.fround(project.canvas.height),
      flags: keep?.canvasFlags ?? 0,
    },
    parts: {
      ids: parts.map((p) => p.exportId),
      band: i32(P.band),
      firstKeyform: i32(P.firstKeyform),
      keyformCount: i32(P.keyformCount),
      initiallyVisible: i32(P.visible),
      enabled: i32(P.enabled),
      parent: i32(P.parent),
    },
    deformers: {
      ids: deformers.map((d) => d.exportId),
      band: i32(D.band),
      visible: i32(deformers.map((d) => (hidden.has(d.uid) ? 0 : 1))),
      enabled: i32(D.enabled),
      part: i32(D.part),
      parent: i32(D.parent),
      kind: i32(D.kind),
      kindIndex: i32(D.kindIndex),
    },
    warpDeformers: {
      band: i32(W.band),
      firstKeyform: i32(W.firstKeyform),
      keyformCount: i32(W.keyformCount),
      pointCount: i32(W.pointCount),
      rows: i32(W.rows),
      columns: i32(W.columns),
    },
    rotationDeformers: {
      band: i32(R.band),
      firstKeyform: i32(R.firstKeyform),
      keyformCount: i32(R.keyformCount),
      baseAngle: f32a(R.baseAngle),
    },
    artMeshes: {
      ids: meshes.map((m) => m.exportId),
      band: i32(M.band),
      firstKeyform: i32(M.firstKeyform),
      keyformCount: i32(M.keyformCount),
      visible: i32(meshes.map((m) => (hidden.has(m.uid) ? 0 : 1))),
      enabled: i32(M.enabled),
      part: i32(M.part),
      deformer: i32(M.deformer),
      texture: i32(M.texture),
      flags: Uint8Array.from(M.flags),
      vertexCount: i32(M.vertexCount),
      firstUv: i32(M.firstUv),
      firstTriangleIndex: i32(M.firstTriangleIndex),
      triangleIndexCount: i32(M.triangleIndexCount),
      firstMask: i32(M.firstMask),
      maskCount: i32(M.maskCount),
    },
    parameters: {
      ids: parameters.map((p) => p.exportId),
      max: f32a(parameters.map((p) => p.max)),
      min: f32a(parameters.map((p) => p.min)),
      defaultValue: f32a(parameters.map((p) => p.default)),
      repeat: i32(parameters.map((p) => (p.repeat ? 1 : 0))),
      // Not display-only: it sets the key-snapping and range tolerance. The document's
      // `decimals` is the editor's display precision; the file always gets 3.
      decimals: i32(parameters.map((p) => decimalsOf.get(p.uid) ?? DECIMALS)),
      firstBinding: i32(paramFirstBinding),
      bindingCount: i32(paramBindingCount),
    },
    partKeyforms: { drawOrder: f32a(partKf.drawOrder) },
    warpKeyforms: { opacity: f32a(WK.opacity), firstPosition: i32(WK.firstPosition) },
    rotationKeyforms: {
      opacity: f32a(RK.opacity),
      angle: f32a(RK.angle),
      originX: f32a(RK.originX),
      originY: f32a(RK.originY),
      scale: f32a(RK.scale),
      mirrorX: i32(RK.mirrorX),
      mirrorY: i32(RK.mirrorY),
    },
    artMeshKeyforms: {
      opacity: f32a(MK.opacity),
      drawOrder: f32a(MK.drawOrder),
      firstPosition: i32(MK.firstPosition),
    },
    keyformPositions: f32a(positions),
    bindingIndices: i32(bindingIndices),
    bands: { firstEntry: i32(bandFirst), entryCount: i32(bandCount) },
    parameterBindings: { firstKey: i32(pbFirstKey), keyCount: i32(pbKeyCount) },
    keys: f32a(keys),
    uvs: f32a(uvs),
    triangleIndices: Uint16Array.from(tris),
    maskEntries: i32(masks),
    drawOrderGroups: {
      firstObject: i32(G.firstObject),
      objectCount: i32(G.objectCount),
      entryCount: i32(G.entryCount),
      maxDrawOrder: i32(G.max),
      minDrawOrder: i32(G.min),
    },
    drawOrderGroupObjects: { kind: i32(O.kind), index: i32(O.index), nestedGroup: i32(O.nested) },
    glues: {
      ids: glues.map((g) => g.exportId),
      band: i32(GL.band),
      firstKeyform: i32(GL.firstKeyform),
      keyformCount: i32(GL.keyformCount),
      artMeshA: i32(GL.a),
      artMeshB: i32(GL.b),
      firstInfo: i32(GL.firstInfo),
      infoCount: i32(GL.infoCount),
    },
    glueInfo: { weight: f32a(info.weight), vertex: Uint16Array.from(info.vertex) },
    glueKeyforms: { intensity: f32a(intensity) },
  };

  if (v >= 2) data.warpDeformers.bilinear = i32(W.bilinear);
  if (v >= 4) {
    data.warpDeformers.firstColor = i32(W.firstColor);
    data.rotationDeformers.firstColor = i32(R.firstColor);
    data.artMeshes.firstColor = i32(M.firstColor);
    // Each parameter's own key list follows the binding keys in the shared key pool.
    const firstKey: number[] = [];
    const keyCount: number[] = [];
    const pool = Array.from(data.keys);
    for (const p of parameters) {
      firstKey.push(pool.length);
      keyCount.push(p.keys.length);
      pool.push(...p.keys);
    }
    data.keys = f32a(pool);
    data.parameters.firstKey = i32(firstKey);
    data.parameters.keyCount = i32(keyCount);
    data.parameters.type = i32(parameters.map((p) => (p.type === 'blendShape' ? 1 : 0)));
    data.parameters.firstBlendShapeBinding = i32(paramFirstShape);
    data.parameters.blendShapeBindingCount = i32(paramShapeCount);
    data.multiplyColors = { r: f32a(mulR), g: f32a(mulG), b: f32a(mulB) };
    data.screenColors = { r: f32a(scrR), g: f32a(scrG), b: f32a(scrB) };
    const targetsOf = (t: Targets) => ({
      object: i32(t.object),
      firstBinding: i32(t.firstBinding),
      bindingCount: i32(t.bindingCount),
    });
    data.blendShapeParameterBindings = {
      firstKey: i32(BPB.firstKey),
      keyCount: i32(BPB.keyCount),
      baseKey: i32(BPB.baseKey),
    };
    data.blendShapeKeyformBindings = {
      parameterBinding: i32(KB.parameterBinding),
      firstKeyform: i32(KB.firstKeyform),
      keyformCount: i32(KB.keyformCount),
      firstConstraintEntry: i32(KB.firstConstraintEntry),
      constraintEntryCount: i32(KB.constraintEntryCount),
    };
    data.warpBlendShapeTargets = targetsOf(T.warp);
    data.artMeshBlendShapeTargets = targetsOf(T.artMesh);
    data.blendShapeConstraintEntries = i32(constraintEntries);
    data.blendShapeConstraints = {
      parameter: i32(CS.parameter),
      firstValue: i32(CS.firstValue),
      valueCount: i32(CS.valueCount),
    };
    data.blendShapeConstraintValues = { key: f32a(CV.key), weight: f32a(CV.weight) };
    if (v >= 5) {
      data.warpKeyforms.multiplyColor = i32(WK.color);
      data.warpKeyforms.screenColor = i32(WK.color);
      data.rotationKeyforms.multiplyColor = i32(RK.color);
      data.rotationKeyforms.screenColor = i32(RK.color);
      data.artMeshKeyforms.multiplyColor = i32(MK.color);
      data.artMeshKeyforms.screenColor = i32(MK.color);
      data.partBlendShapeTargets = targetsOf(T.part);
      data.rotationBlendShapeTargets = targetsOf(T.rotation);
      data.glueBlendShapeTargets = targetsOf(T.glue);
    }
    if (v6) {
      data.parts.offscreen = i32(parts.map((p) => offIdx.get(p.uid) ?? -1));
      data.artMeshes.blendMode = i32(M.blendMode);
      data.partKeyforms.offscreenKeyform = i32(partKf.offscreenKeyform);
      data.offscreens = {
        part: i32(OF.part),
        flags: Uint8Array.from(OF.flags),
        blendMode: i32(OF.blendMode),
        firstMask: i32(OF.firstMask),
        maskCount: i32(OF.maskCount),
      };
      data.offscreenKeyforms = {
        opacity: f32a(OK.opacity),
        multiplyColor: i32(OK.color),
        screenColor: i32(OK.color),
      };
      data.offscreenBlendShapeTargets = targetsOf(T.offscreen);
    }
  }
  // Group ranges: every draw-order key the members can reach, blend shapes included.
  const groupScopes = numbered.map((n) => n.scope ?? null);
  setGroupRanges(data, v, keep, groupScopes);
  // Keyforms are in object order, so this never appends anything; it is the guarantee.
  padPositionRuns(data);
  return {
    data,
    uids: {
      parts: parts.map((p) => p.uid),
      deformers: deformers.map((d) => d.uid),
      artMeshes: meshes.map((m) => m.uid),
      parameters: parameters.map((p) => p.uid),
      glues: glues.map((g) => g.uid),
    },
    groupScopes,
  };
}
