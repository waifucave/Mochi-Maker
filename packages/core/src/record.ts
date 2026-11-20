/**
 * Recording from the viewport (M10): dragging a rotation deformer in the animation view
 * keys the parameters that turn it. These helpers evaluate a keyform field at a pose, as the
 * runtime blends keyforms (linearly between the keys of each binding, held beyond the end keys),
 * and find the parameter value that gives a field a wanted value.
 */
import type { Binding, Rig, RotationKeyform, Uid } from './model.js';
import { strides } from './rig.js';

type Field = 'angle' | 'scale' | 'originX' | 'originY';
type Values = (parameter: Uid) => number;

/** Where a value falls on a binding's keys: the lower key index and the weight of the next one. */
function locate(b: Binding, v: number): [number, number] {
  const k = b.keys;
  if (k.length === 1 || v <= k[0]!) return [0, 0];
  if (v >= k[k.length - 1]!) return [k.length - 1, 0];
  let i = 0;
  while (v > k[i + 1]!) i++;
  return [i, (v - k[i]!) / (k[i + 1]! - k[i]! || 1)];
}

/** A numeric keyform field at parameter values: the multilinear blend of the cell's corners. */
export function fieldAt(rig: Rig<RotationKeyform>, field: Field, values: Values): number {
  const bs = rig.bindings;
  if (bs.length === 0) return rig.keyforms[0]![field];
  const s = strides(bs);
  const at = bs.map((b) => locate(b, values(b.parameter)));
  let sum = 0;
  for (let corner = 0; corner < 1 << bs.length; corner++) {
    let w = 1;
    let index = 0;
    for (let j = 0; j < bs.length; j++) {
      const [i, t] = at[j]!;
      const up = (corner >> j) & 1;
      if (up && t === 0) {
        w = 0;
        break;
      }
      w *= up ? t : 1 - t;
      index += (i + up) * s[j]!;
    }
    if (w > 0) sum += w * rig.keyforms[index]![field];
  }
  return sum;
}

/**
 * The parameter value that brings a field closest to a target, changing one bound parameter and
 * holding the others. Along one binding the field is piecewise linear between its keys, so the
 * solution is exact. Among the bindings, the one that reaches the target (or comes nearest) wins;
 * ties go to the smallest change, measured in each parameter's range. Null without bindings.
 */
export function solveField(
  rig: Rig<RotationKeyform>,
  field: Field,
  values: Values,
  target: number,
  range: (parameter: Uid) => { min: number; max: number },
): { parameter: Uid; value: number } | null {
  let best: { parameter: Uid; value: number; miss: number; change: number } | null = null;
  for (const b of rig.bindings) {
    const now = values(b.parameter);
    const f = (v: number) => fieldAt(rig, field, (p) => (p === b.parameter ? v : values(p)));
    const r = range(b.parameter);
    const span = Math.max(r.max - r.min, 1e-9);
    const keys = b.keys.filter((k) => k >= r.min - 1e-9 && k <= r.max + 1e-9);
    const options: number[] = [];
    // Exact solutions between neighbouring keys.
    for (let i = 0; i + 1 < keys.length; i++) {
      const [ka, kb] = [keys[i]!, keys[i + 1]!];
      const [fa, fb] = [f(ka), f(kb)];
      if (fa === fb) continue;
      const u = (target - fa) / (fb - fa);
      if (u >= 0 && u <= 1) options.push(ka + u * (kb - ka));
    }
    // Otherwise the nearest the keys get.
    if (options.length === 0) options.push(...keys);
    for (const v of options) {
      const miss = Math.abs(f(v) - target);
      const change = Math.abs(v - now) / span;
      const better =
        !best ||
        miss < best.miss - 1e-9 ||
        (Math.abs(miss - best.miss) <= 1e-9 && change < best.change);
      if (better) best = { parameter: b.parameter, value: v, miss, change };
    }
  }
  return best && { parameter: best.parameter, value: best.value };
}
