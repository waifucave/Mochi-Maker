/**
 * The lowering cache: lowers a document by reusing the previous lowering, when only values
 * changed.
 *
 * Documents are immutable and share every unchanged object, so the objects that changed since the
 * last lowering are those whose identity differs. When each of them is a part, ArtMesh, deformer or
 * glue whose structure is the same (the same parents, bindings, keyform counts, topology and IDs,
 * and no blend shapes), the result has the same layout as the previous one: the cache copies the
 * previous model data and writes only those objects' keyform values (positions, opacities, draw
 * orders, colors, angles, origins, scales, intensities), their texture coordinates and the draw-order
 * group ranges. Anything else (other kinds, the project, parameters, a new atlas, another version)
 * takes the full `lowerDocument`. Either way the result equals `lowerDocument`'s bit for bit; a test
 * checks it.
 */
import {
  DocView,
  type DocObject,
  type Document,
  type Rotation,
  type Uid,
  type Warp,
} from '@mochi-maker/core';
import type { MocData } from 'mochi2d/headless';
import { lowerDocument, setGroupRanges, type LowerOptions, type LowerResult } from './lower.js';

/** Kinds that do not reach the model data (layers reach it through the atlas placement). */
const OUTSIDE_DATA = new Set([
  'parameterGroup',
  'layer',
  'expression',
  'motion',
  'physicsSetting',
  'sound',
]);

export interface LowerStats {
  /** `full`: lowered from scratch; `values`: the previous lowering with values rewritten. */
  mode: 'full' | 'values';
  /** Objects whose values were rewritten (values mode). */
  rewritten: number;
}

/**
 * The structure of an object as far as the model data's layout goes: everything but the values
 * the cache rewrites. Null when the object is never rewritten in place (blend shapes).
 */
function structure(o: DocObject): string | null {
  const rig = (r: { bindings: unknown[]; keyforms: unknown[] }) => [
    JSON.stringify(r.bindings),
    r.keyforms.length,
  ];
  switch (o.kind) {
    case 'artMesh':
      if (o.blendShapes.length) return null;
      return JSON.stringify([
        o.exportId,
        o.part,
        o.deformer,
        o.layer,
        o.uv.length,
        Array.from(o.triangles).join(','),
        o.doubleSided,
        o.enabled,
        o.legacyBlend,
        o.blend,
        o.clip,
        rig(o.rig),
      ]);
    case 'warp':
      if (o.blendShapes.length) return null;
      return JSON.stringify([
        o.exportId,
        o.part,
        o.parent,
        o.rows,
        o.cols,
        o.cellMode,
        o.enabled,
        rig(o.rig),
      ]);
    case 'rotation':
      if (o.blendShapes.length) return null;
      return JSON.stringify([o.exportId, o.part, o.parent, o.enabled, rig(o.rig)]);
    case 'part':
      if (o.blendShapes.length) return null;
      return JSON.stringify([
        o.exportId,
        o.parent,
        o.children,
        o.visibleAtStart,
        o.enabled,
        o.sortingScope,
        o.offscreen,
        rig(o.rig),
      ]);
    case 'glue':
      if (o.blendShapes.length) return null;
      return JSON.stringify([
        o.exportId,
        o.meshA,
        o.meshB,
        o.pairs.map((p) => [p[0], p[2]]),
        rig(o.rig),
      ]);
    default:
      return null;
  }
}

/** A copy of model data whose typed arrays are new (the caller may write into them). */
function copyData(d: MocData): MocData {
  const copy = (v: unknown): unknown => {
    if (ArrayBuffer.isView(v)) return (v as unknown as { slice(): unknown }).slice();
    if (Array.isArray(v)) return v.slice();
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = copy(x);
      return out;
    }
    return v;
  };
  return copy(d) as MocData;
}

export class LoweringCache {
  private last: {
    objects: Document['objects'];
    options: LowerOptions;
    result: LowerResult;
    index: Map<Uid, number>;
  } | null = null;
  stats: LowerStats = { mode: 'full', rewritten: 0 };

  /** Forgets the previous lowering. */
  clear(): void {
    this.last = null;
  }

  lower(document: Document, options: LowerOptions): LowerResult {
    const result = this.tryValues(document, options) ?? this.full(document, options);
    return result;
  }

  private full(document: Document, options: LowerOptions): LowerResult {
    const result = lowerDocument(new DocView(document), options);
    const index = new Map<Uid, number>();
    for (const list of Object.values(result.uids)) list.forEach((u, i) => index.set(u, i));
    // The cache keeps its own copy: callers may patch the data they get.
    this.last = {
      objects: document.objects,
      options,
      result: { data: copyData(result.data), uids: result.uids, groupScopes: result.groupScopes },
      index,
    };
    this.stats = { mode: 'full', rewritten: 0 };
    return result;
  }

  private tryValues(document: Document, options: LowerOptions): LowerResult | null {
    const last = this.last;
    if (
      !last ||
      last.options.version !== options.version ||
      last.options.placement !== options.placement
    )
      return null;
    const prev = last.objects;
    const next = document.objects;
    const changed: DocObject[] = [];
    let count = 0;
    for (const uid in next) {
      count++;
      const o = next[uid]!;
      const p = prev[uid];
      if (o === p) continue;
      if (!p || p.kind !== o.kind) return null;
      if (OUTSIDE_DATA.has(o.kind)) continue;
      const s = structure(o);
      if (s === null || s !== structure(p)) return null;
      changed.push(o);
    }
    if (count !== Object.keys(prev).length) return null; // something was removed
    const doc = new DocView(document);
    const data = copyData(last.result.data);
    const { pixelsPerUnit: ppu, originX, originY } = doc.project().canvas;
    const v = options.version;
    const setColors = (first: number, kfs: readonly { multiply: number[]; screen: number[] }[]) => {
      if (v < 4 || !data.multiplyColors || !data.screenColors) return;
      kfs.forEach((k, i) => {
        data.multiplyColors!.r[first + i] = k.multiply[0]!;
        data.multiplyColors!.g[first + i] = k.multiply[1]!;
        data.multiplyColors!.b[first + i] = k.multiply[2]!;
        data.screenColors!.r[first + i] = k.screen[0]!;
        data.screenColors!.g[first + i] = k.screen[1]!;
        data.screenColors!.b[first + i] = k.screen[2]!;
      });
    };
    const setPositions = (at: number, pts: ArrayLike<number>, top: boolean) => {
      const out = data.keyformPositions;
      if (top)
        for (let i = 0; i < pts.length; i += 2) {
          out[at + i] = (pts[i]! - originX) / ppu;
          out[at + i + 1] = (pts[i + 1]! - originY) / ppu;
        }
      else for (let i = 0; i < pts.length; i++) out[at + i] = pts[i]!;
    };
    const hasRotationAbove = (d: Warp | Rotation): boolean => {
      let p = d.parent;
      while (p !== null) {
        const o = doc.get(p) as Warp | Rotation;
        if (o.kind === 'rotation') return true;
        p = o.parent;
      }
      return false;
    };
    let drawOrders = false;
    for (const o of changed) {
      const i = last.index.get(o.uid);
      if (i === undefined) return null;
      if (o.kind === 'artMesh') {
        const first = data.artMeshes.firstKeyform[i]!;
        o.rig.keyforms.forEach((k, j) => {
          data.artMeshKeyforms.opacity[first + j] = k.opacity;
          data.artMeshKeyforms.drawOrder[first + j] = k.drawOrder;
          setPositions(
            data.artMeshKeyforms.firstPosition[first + j]!,
            k.positions,
            o.deformer === null,
          );
        });
        if (data.artMeshes.firstColor) setColors(data.artMeshes.firstColor[i]!, o.rig.keyforms);
        const place = o.layer ? options.placement.get(o.layer) : undefined;
        const at = data.artMeshes.firstUv[i]!;
        for (let k = 0; k < o.uv.length; k += 2) {
          data.uvs[at + k] = place ? (o.uv[k]! + place.offsetX) / place.pageWidth : 0;
          data.uvs[at + k + 1] = place ? (o.uv[k + 1]! + place.offsetY) / place.pageHeight : 0;
        }
        drawOrders = true;
      } else if (o.kind === 'warp') {
        const wi = data.deformers.kindIndex[i]!;
        const first = data.warpDeformers.firstKeyform[wi]!;
        o.rig.keyforms.forEach((k, j) => {
          data.warpKeyforms.opacity[first + j] = k.opacity;
          setPositions(data.warpKeyforms.firstPosition[first + j]!, k.grid, o.parent === null);
        });
        if (data.warpDeformers.firstColor)
          setColors(data.warpDeformers.firstColor[wi]!, o.rig.keyforms);
      } else if (o.kind === 'rotation') {
        const ri = data.deformers.kindIndex[i]!;
        const first = data.rotationDeformers.firstKeyform[ri]!;
        data.rotationDeformers.baseAngle[ri] = o.baseAngle;
        const factor = hasRotationAbove(o) ? 1 : 1 / ppu;
        const top = o.parent === null;
        const RK = data.rotationKeyforms;
        o.rig.keyforms.forEach((k, j) => {
          RK.opacity[first + j] = k.opacity;
          RK.angle[first + j] = k.angle;
          RK.originX[first + j] = top ? (k.originX - originX) / ppu : k.originX;
          RK.originY[first + j] = top ? (k.originY - originY) / ppu : k.originY;
          RK.scale[first + j] = k.scale * factor;
          RK.mirrorX[first + j] = k.mirrorX ? 1 : 0;
          RK.mirrorY[first + j] = k.mirrorY ? 1 : 0;
        });
        if (data.rotationDeformers.firstColor)
          setColors(data.rotationDeformers.firstColor[ri]!, o.rig.keyforms);
      } else if (o.kind === 'part') {
        const first = data.parts.firstKeyform[i]!;
        o.rig.keyforms.forEach((k, j) => (data.partKeyforms.drawOrder[first + j] = k.drawOrder));
        // An offscreen's keyforms are its part's: opacity, and colors from consecutive entries.
        const OK = data.offscreenKeyforms;
        const okf = data.partKeyforms.offscreenKeyform?.[first];
        if (o.offscreen && OK && okf !== undefined && okf >= 0) {
          o.rig.keyforms.forEach((k, j) => (OK.opacity[okf + j] = k.opacity));
          setColors(OK.multiplyColor[okf]!, o.rig.keyforms);
        }
        drawOrders = true;
      } else if (o.kind === 'glue') {
        const first = data.glues.firstKeyform[i]!;
        o.rig.keyforms.forEach((k, j) => (data.glueKeyforms.intensity[first + j] = k.intensity));
        const at = data.glues.firstInfo[i]!;
        o.pairs.forEach(([, wa, , wb], j) => {
          data.glueInfo.weight[at + 2 * j] = wa;
          data.glueInfo.weight[at + 2 * j + 1] = wb;
        });
      } else return null;
    }
    if (drawOrders) {
      setGroupRanges(data, v, doc.project().importedFrom?.keep, last.result.groupScopes);
    }
    this.last = {
      objects: next,
      options,
      result: { data, uids: last.result.uids, groupScopes: last.result.groupScopes },
      index: last.index,
    };
    this.stats = { mode: 'values', rewritten: changed.length };
    return { data: copyData(data), uids: last.result.uids, groupScopes: last.result.groupScopes };
  }
}
