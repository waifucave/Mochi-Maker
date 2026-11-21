/**
 * Writer rules: rules Mochi Maker's writer keeps beyond what `validateMoc`'s `official` level
 * tests, including a test of that level that can reject a valid file (position runs). They run on Mochi2D's model data, after lowering and before `validateMoc`, so they
 * hold whatever produced the data.
 *
 * - IDs: valid UTF-8 (no lone surrogates, no NUL), 1–63 bytes.
 * - Flag fields 0 or 1; the deformer and art-mesh display flags 1; decimal places 3.
 * - Triangle indices below the mesh's vertex count; index counts a multiple of 3.
 * - Keys strictly increasing in every key list (in float32), and below 32768 in magnitude; parameter
 *   min ≤ max.
 * - Draw-order groups: exactly the range of the draw-order keys their members can reach, blend
 *   shapes included, or the pair minimum 2147483647, maximum −2147483647 for a group
 *   without members.
 * - Version 5+: each keyform's color indices equal firstColor + (k − firstKeyform).
 * - Position runs (the form the `official` level tests): for object index i, start(keyform i) + L(object i)
 *   lies in [0, N]. `padPositionRuns` appends zero floats until it holds.
 */
import type { MocData } from 'mochi2d/headless';

export type RuleKind = 'parts' | 'deformers' | 'artMeshes' | 'parameters' | 'glues' | 'model';

export interface RuleViolation {
  code: string;
  kind: RuleKind;
  index?: number;
  message: string;
  /** What to do about it, in document terms. */
  fix: string;
}

export const ID_MAX_BYTES = 63;
export const DECIMALS = 3;
/** Keys must stay below this in magnitude. */
export const KEY_LIMIT = 32768;
export const EMPTY_GROUP_MIN = 2147483647;
export const EMPTY_GROUP_MAX = -2147483647;

const utf8 = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The longest prefix of `id` that fits `max` UTF-8 bytes, cut at a code point boundary. */
export function truncateId(id: string, max = ID_MAX_BYTES): string {
  let out = '';
  let bytes = 0;
  for (const ch of id) {
    const n = utf8.encode(ch).length;
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** Problems with one export ID, or undefined when it is fine. */
export function idProblem(id: string): { code: string; message: string; fix: string } | undefined {
  if (id.length === 0)
    return { code: 'id-empty', message: 'The export ID is empty.', fix: 'Give it an ID.' };
  if (LONE_SURROGATE.test(id) || id.includes('\0'))
    return {
      code: 'id-utf8',
      message: `The export ID ${JSON.stringify(id)} is not valid UTF-8 text (it has a lone surrogate or a NUL character).`,
      fix: 'Rename it (object.rename) to an ID without those characters.',
    };
  const bytes = utf8.encode(id).length;
  if (bytes > ID_MAX_BYTES)
    return {
      code: 'id-length',
      message: `The export ID "${id}" is ${bytes} bytes long in UTF-8; the file format allows at most ${ID_MAX_BYTES}.`,
      fix: `Rename it (object.rename) to at most ${ID_MAX_BYTES} bytes, for example "${truncateId(id)}".`,
    };
  return undefined;
}

const F = Math.fround;
const EPS = F(0.001);

/**
 * The draw order of an art mesh or a part, and its key in its draw-order group. D is the interpolated normal draw order (float32), B the float32 sum of the
 * blend-shape contributions, and `target` whether the object is the target of at least one
 * blend-shape keyform binding:
 * - n = trunc(f32(D + 0.001));
 * - a version-5 target: min(1000, max(0, trunc(f32(f32(n + B) + 0.001)))), even when B = 0. The
 *   cap is at 1000. B is added to n one contribution at a time when given as
 *   a list, as evaluation accumulates;
 * - any other object, and a version-4 target: n.
 */
export function drawOrderKey(D: number, B: number | readonly number[], target: boolean): number {
  const n = Math.trunc(F(F(D) + EPS));
  if (!target) return n;
  let sum = n;
  for (const c of typeof B === 'number' ? [B] : B) sum = F(sum + F(c));
  return Math.min(DRAW_ORDER_MAX, Math.max(0, Math.trunc(F(sum + EPS))));
}

/** The upper clamp of a version-5 target's draw order. */
export const DRAW_ORDER_MAX = 1000;

/**
 * The lowest and highest draw-order key an art mesh or part can reach: the normal draw orders' extremes, with every blend shape at its most
 * negative contribution at once for the lowest, and at its most positive for the highest. A blend
 * shape's contribution is w·s: s lies between its smallest and largest delta (the base key's is
 * 0), and w = the minimum of its constraint curves, each between its smallest and largest weight
 * (1 without constraints). Version 4 ignores draw-order blend shapes and clamps nothing, so its
 * range is the normal draw orders'.
 */
export function drawOrderReach(
  data: MocData,
  kind: 'artMeshes' | 'parts',
  index: number,
  version: number,
): { min: number; max: number } {
  const owner = kind === 'artMeshes' ? data.artMeshes : data.parts;
  const orders =
    kind === 'artMeshes' ? data.artMeshKeyforms.drawOrder : data.partKeyforms.drawOrder;
  let dLo = Infinity;
  let dHi = -Infinity;
  for (
    let k = owner.firstKeyform[index]!;
    k < owner.firstKeyform[index]! + owner.keyformCount[index]!;
    k++
  ) {
    dLo = Math.min(dLo, orders[k]!);
    dHi = Math.max(dHi, orders[k]!);
  }
  const targets = kind === 'artMeshes' ? data.artMeshBlendShapeTargets : data.partBlendShapeTargets;
  let target = false;
  const bLo: number[] = [];
  const bHi: number[] = [];
  const kb = data.blendShapeKeyformBindings;
  const pb = data.blendShapeParameterBindings;
  if (targets && kb && pb)
    for (let t = 0; t < targets.object.length; t++) {
      if (targets.object[t] !== index) continue;
      for (
        let j = targets.firstBinding[t]!;
        j < targets.firstBinding[t]! + targets.bindingCount[t]!;
        j++
      ) {
        target = true;
        const first = kb.firstKeyform[j]!;
        const base = orders[first + pb.baseKey[kb.parameterBinding[j]!]!]!;
        let sLo = Infinity;
        let sHi = -Infinity;
        for (let k = first; k < first + kb.keyformCount[j]!; k++) {
          const s = F(orders[k]! - base);
          sLo = Math.min(sLo, s);
          sHi = Math.max(sHi, s);
        }
        let wLo = 1;
        let wHi = 1;
        const ce = data.blendShapeConstraintEntries!;
        const cs = data.blendShapeConstraints!;
        const cv = data.blendShapeConstraintValues!;
        for (
          let e = kb.firstConstraintEntry[j]!;
          e < kb.firstConstraintEntry[j]! + kb.constraintEntryCount[j]!;
          e++
        ) {
          const c = ce[e]!;
          let cLo = Infinity;
          let cHi = -Infinity;
          for (let v = cs.firstValue[c]!; v < cs.firstValue[c]! + cs.valueCount[c]!; v++) {
            cLo = Math.min(cLo, cv.weight[v]!);
            cHi = Math.max(cHi, cv.weight[v]!);
          }
          if (e === kb.firstConstraintEntry[j]!) {
            wLo = cLo;
            wHi = cHi;
          } else {
            wLo = Math.min(wLo, cLo);
            wHi = Math.min(wHi, cHi);
          }
        }
        const products = [wLo * sLo, wLo * sHi, wHi * sLo, wHi * sHi];
        bLo.push(F(Math.min(...products)));
        bHi.push(F(Math.max(...products)));
      }
    }
  // Version 4 ignores draw-order blend shapes and clamps nothing.
  if (version >= 5)
    return { min: drawOrderKey(dLo, bLo, target), max: drawOrderKey(dHi, bHi, target) };
  return { min: drawOrderKey(dLo, 0, false), max: drawOrderKey(dHi, 0, false) };
}

/**
 * The range each draw-order group must have: the lowest and highest key its members can reach
 * (`drawOrderReach`), or the pair minimum 2147483647, maximum −2147483647 without members.
 */
export function expectedGroupRanges(data: MocData, version = 5): { min: number; max: number }[] {
  const g = data.drawOrderGroups;
  const o = data.drawOrderGroupObjects;
  const out: { min: number; max: number }[] = [];
  for (let gi = 0; gi < g.firstObject.length; gi++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = g.firstObject[gi]!; j < g.firstObject[gi]! + g.objectCount[gi]!; j++) {
      const r = drawOrderReach(data, o.kind[j] === 0 ? 'artMeshes' : 'parts', o.index[j]!, version);
      lo = Math.min(lo, r.min);
      hi = Math.max(hi, r.max);
    }
    out.push(
      Number.isFinite(lo) ? { min: lo, max: hi } : { min: EMPTY_GROUP_MIN, max: EMPTY_GROUP_MAX },
    );
  }
  return out;
}

/** Position runs that fail the `official` level's test: object index i, with its keyform-i start. */
export function positionRunFailures(
  data: MocData,
  n = data.keyformPositions.length,
): { kind: 'artMeshes' | 'warps'; index: number; end: number }[] {
  const out: { kind: 'artMeshes' | 'warps'; index: number; end: number }[] = [];
  const am = data.artMeshes;
  const amStarts = data.artMeshKeyforms.firstPosition;
  for (let i = 0; i < am.vertexCount.length && i < amStarts.length; i++) {
    const end = amStarts[i]! + 2 * am.vertexCount[i]!;
    if (end < 0 || end > n) out.push({ kind: 'artMeshes', index: i, end });
  }
  const w = data.warpDeformers;
  const wStarts = data.warpKeyforms.firstPosition;
  for (let i = 0; i < w.pointCount.length && i < wStarts.length; i++) {
    const end = wStarts[i]! + 2 * w.pointCount[i]!;
    if (end < 0 || end > n) out.push({ kind: 'warps', index: i, end });
  }
  return out;
}

/**
 * Appends zero floats to the position array until every run the `official` level tests ends inside
 * it. Returns the number of floats appended. Keyforms in object order, with
 * blend-shape keyforms last, never need any; this is the guarantee for other layouts.
 */
export function padPositionRuns(data: MocData): number {
  const fails = positionRunFailures(data);
  const need = Math.max(data.keyformPositions.length, ...fails.map((f) => f.end));
  const extra = need - data.keyformPositions.length;
  if (extra > 0) {
    const grown = new Float32Array(need);
    grown.set(data.keyformPositions);
    data.keyformPositions = grown;
  }
  return extra;
}

/** The deformer index of warp (kind 0) or rotation (kind 1) number `i`. */
function deformerOf(data: MocData, kind: 0 | 1, i: number): number | undefined {
  for (let d = 0; d < data.deformers.kind.length; d++)
    if (data.deformers.kind[d] === kind && data.deformers.kindIndex[d] === i) return d;
  return undefined;
}

function strictlyIncreasing(keys: Float32Array, first: number, count: number): boolean {
  for (let k = first + 1; k < first + count; k++) if (!(keys[k]! > keys[k - 1]!)) return false;
  return true;
}

/**
 * Checks every writer rule. `version` is the file version the data will be written as. `allow`
 * lets an imported model's own decimal places, hidden flags and draw-order group ranges through
 * (its file has them).
 */
export function checkWriterRules(
  data: MocData,
  version: number,
  allow: { decimals?: boolean; displayFlags?: boolean; groupRanges?: boolean } = {},
): RuleViolation[] {
  const out: RuleViolation[] = [];
  const add = (v: RuleViolation) => out.push(v);

  // IDs.
  const idLists: [RuleKind, string[]][] = [
    ['parts', data.parts.ids],
    ['deformers', data.deformers.ids],
    ['artMeshes', data.artMeshes.ids],
    ['parameters', data.parameters.ids],
    ['glues', data.glues.ids],
  ];
  for (const [kind, ids] of idLists)
    ids.forEach((id, index) => {
      const p = idProblem(id);
      if (p) add({ ...p, kind, index });
    });

  // Flags and decimal places.
  const flagFields: [RuleKind, string, Int32Array, boolean][] = [
    ['parts', 'initially visible', data.parts.initiallyVisible, false],
    ['parts', 'enabled', data.parts.enabled, false],
    ['deformers', 'visible', data.deformers.visible, true],
    ['deformers', 'enabled', data.deformers.enabled, false],
    ['artMeshes', 'visible', data.artMeshes.visible, true],
    ['artMeshes', 'enabled', data.artMeshes.enabled, false],
    ['parameters', 'repeat', data.parameters.repeat, false],
  ];
  for (const [kind, name, values, mustBeOne] of flagFields)
    values.forEach((v, index) => {
      if (v !== 0 && v !== 1)
        add({
          code: 'flag-value',
          kind,
          index,
          message: `The ${name} flag is ${v}; flag fields hold only 0 or 1.`,
          fix: 'Write 0 or 1.',
        });
      else if (mustBeOne && v !== 1 && !allow.displayFlags)
        add({
          code: 'display-flag',
          kind,
          index,
          message: `The ${name} display flag is ${v}; genuine files write 1.`,
          fix: 'Write 1.',
        });
    });
  data.parameters.decimals.forEach((d, index) => {
    if (d !== DECIMALS && !allow.decimals)
      add({
        code: 'decimals',
        kind: 'parameters',
        index,
        message: `Decimal places is ${d}; it sets the key-snapping and range tolerance 10^−d, and Mochi Maker evaluates with ${DECIMALS}.`,
        fix: `Write ${DECIMALS}.`,
      });
  });

  // Triangles.
  const am = data.artMeshes;
  for (let i = 0; i < am.vertexCount.length; i++) {
    const first = am.firstTriangleIndex[i]!;
    const count = am.triangleIndexCount[i]!;
    if (count % 3 !== 0)
      add({
        code: 'triangle-count',
        kind: 'artMeshes',
        index: i,
        message: `The mesh has ${count} triangle indices, which is not a multiple of 3.`,
        fix: 'Rebuild its triangles (mesh.retriangulate).',
      });
    for (let t = first; t < first + count; t++)
      if (data.triangleIndices[t]! >= am.vertexCount[i]!) {
        add({
          code: 'triangle-index',
          kind: 'artMeshes',
          index: i,
          message: `Triangle index ${data.triangleIndices[t]} is not below the mesh's vertex count ${am.vertexCount[i]}.`,
          fix: 'Rebuild its triangles (mesh.retriangulate).',
        });
        break;
      }
  }

  // Keys and ranges.
  const pb = data.parameterBindings;
  const p = data.parameters;
  for (let i = 0; i < p.ids.length; i++) {
    const min = p.min[i]!;
    const max = p.max[i]!;
    if (!(min <= max))
      add({
        code: 'parameter-range',
        kind: 'parameters',
        index: i,
        message: `The minimum ${min} is above the maximum ${max}.`,
        fix: 'Set a range with min ≤ max (param.update).',
      });
    for (let b = p.firstBinding[i]!; b < p.firstBinding[i]! + p.bindingCount[i]!; b++)
      if (!strictlyIncreasing(data.keys, pb.firstKey[b]!, pb.keyCount[b]!)) {
        add({
          code: 'keys-order',
          kind: 'parameters',
          index: i,
          message: `A binding's keys are not strictly increasing in 32-bit floats: ${Array.from(
            data.keys.subarray(pb.firstKey[b]!, pb.firstKey[b]! + pb.keyCount[b]!),
          ).join(', ')}.`,
          fix: 'Remove keys that are equal or too close together (rig.removeKey).',
        });
        break;
      }
    if (p.firstKey && p.keyCount && !strictlyIncreasing(data.keys, p.firstKey[i]!, p.keyCount[i]!))
      add({
        code: 'keys-order',
        kind: 'parameters',
        index: i,
        message: "The parameter's key list is not strictly increasing in 32-bit floats.",
        fix: 'Remove keys that are equal or too close together (param.setKeys).',
      });
  }

  // Key magnitude: the upper range test is strict, so with 3 decimal places
  // a last key of 32768 or more is itself out of range (f32(k + 0.001) = k).
  const big = (list: ArrayLike<number>) => Array.from(list).find((k) => Math.abs(k) >= KEY_LIMIT);
  const k = big(data.keys);
  if (k !== undefined)
    add({
      code: 'key-magnitude',
      kind: 'model',
      message: `Key ${k} is ${KEY_LIMIT} or more in magnitude; there the format's range test puts a last key out of range.`,
      fix: `Rescale the parameter so every key stays below ${KEY_LIMIT} in magnitude (param.update, param.setKeys).`,
    });

  // Draw-order group ranges.
  const g = data.drawOrderGroups;
  expectedGroupRanges(data, version).forEach((e, gi) => {
    if ((g.minDrawOrder[gi] !== e.min || g.maxDrawOrder[gi] !== e.max) && !allow.groupRanges)
      add({
        code: 'group-range',
        kind: 'model',
        index: gi,
        message: `Draw-order group ${gi} stores ${g.minDrawOrder[gi]}…${g.maxDrawOrder[gi]}, not the reachable range ${e.min}…${e.max}.`,
        fix: 'Write the exact range (a Mochi Maker bug; please report it).',
      });
  });

  // Version 5 color indices.
  if (version >= 5) {
    type Owner = { firstKeyform: Int32Array; keyformCount: Int32Array; firstColor?: Int32Array };
    type Kfs = { multiplyColor?: Int32Array; screenColor?: Int32Array };
    const objs: [-1 | 0 | 1, Owner, Kfs][] = [
      [-1, data.artMeshes, data.artMeshKeyforms],
      [0, data.warpDeformers, data.warpKeyforms],
      [1, data.rotationDeformers, data.rotationKeyforms],
    ];
    for (const [type, o, kf] of objs) {
      if (!o.firstColor || !kf.multiplyColor || !kf.screenColor) continue;
      for (let i = 0; i < o.firstKeyform.length; i++)
        for (let k = 0; k < o.keyformCount[i]!; k++) {
          const want = o.firstColor[i]! + k;
          const at = o.firstKeyform[i]! + k;
          if (kf.multiplyColor[at] !== want || kf.screenColor[at] !== want) {
            add({
              code: 'color-index',
              kind: type === -1 ? 'artMeshes' : 'deformers',
              index: type === -1 ? i : deformerOf(data, type, i),
              message: `Keyform ${at}'s color indices are not firstColor + ${k} = ${want}.`,
              fix: 'Write C + (k − F) (a Mochi Maker bug; please report it).',
            });
            break;
          }
        }
    }
  }

  // Position runs.
  for (const f of positionRunFailures(data))
    add({
      code: 'position-run',
      kind: f.kind === 'warps' ? 'deformers' : 'artMeshes',
      index: f.kind === 'warps' ? deformerOf(data, 0, f.index) : f.index,
      message: `Mochi2D's official validation level tests ${f.kind === 'warps' ? 'warp' : 'art'} keyform ${f.index} with object ${f.index}'s run length, and that run would end at ${f.end}, outside the position array of ${data.keyformPositions.length} floats.`,
      fix: 'Append zero floats to the position array (padPositionRuns).',
    });
  return out;
}
