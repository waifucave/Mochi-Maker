/**
 * Keyform grids (design 3.3).
 *
 * An object's rig is a list of bindings and the full grid of keyforms over their keys. Keyform
 * index = Σ iⱼ·Sⱼ with S₁ = 1 and Sⱼ₊₁ = Sⱼ·Kⱼ: the first binding varies fastest, as in the
 * runtime format. Every operation here is pure and keeps the grid complete.
 *
 * Structural edits preserve the rig's behavior where they can:
 * - adding a binding copies every keyform along the new axis, so nothing changes until someone
 *   edits a cell;
 * - adding a key between two keys interpolates the new cells, which is what evaluation would
 *   compute there anyway.
 */
import { f32, lerpF32 } from './f32.js';
import type { AnyKeyform, Binding, Rig, Uid } from './model.js';

export function gridSize(bindings: readonly Binding[]): number {
  return bindings.reduce((n, b) => n * b.keys.length, 1);
}

export function strides(bindings: readonly Binding[]): number[] {
  const out: number[] = [];
  let s = 1;
  for (const b of bindings) {
    out.push(s);
    s *= b.keys.length;
  }
  return out;
}

/** Key indices of a cell. */
export function cellCoords(bindings: readonly Binding[], index: number): number[] {
  return bindings.map((b) => {
    const i = index % b.keys.length;
    index = Math.floor(index / b.keys.length);
    return i;
  });
}

export function cellIndex(bindings: readonly Binding[], coords: readonly number[]): number {
  const s = strides(bindings);
  return coords.reduce((acc, c, j) => acc + c * (s[j] as number), 0);
}

/** A copy of a keyform, with the authored flag set as given. Typed arrays are shared (immutable). */
export function withAuthored<K extends AnyKeyform>(k: K, authored: boolean): K {
  return k.authored === authored ? k : { ...k, authored };
}

/**
 * Interpolates two keyforms of the same kind, field by field: numbers and arrays linearly in
 * float32, booleans step (the lower cell's value, as evaluation does for mirror flags, §1c.7).
 */
export function lerpKeyform<K extends AnyKeyform>(a: K, b: K, t: number): K {
  const out: Record<string, unknown> = {};
  for (const [key, va] of Object.entries(a)) {
    const vb = (b as Record<string, unknown>)[key];
    if (key === 'authored') out[key] = false;
    else if (typeof va === 'number') out[key] = lerpF32(va, vb as number, t);
    else if (va instanceof Float32Array) {
      const wb = vb as Float32Array;
      const r = new Float32Array(va.length);
      for (let i = 0; i < va.length; i++) r[i] = lerpF32(va[i] as number, wb[i] as number, t);
      out[key] = r;
    } else if (Array.isArray(va))
      out[key] = va.map((x: number, i) => lerpF32(x, (vb as number[])[i] as number, t));
    else out[key] = va;
  }
  return out as K;
}

/** The key index nearest to a value (lower index on ties). */
export function nearestKeyIndex(keys: readonly number[], value: number): number {
  let best = 0;
  for (let i = 1; i < keys.length; i++)
    if (Math.abs((keys[i] as number) - value) < Math.abs((keys[best] as number) - value)) best = i;
  return best;
}

/** Adds a binding at position `at` (default: last). Each new cell copies its old cell. */
export function addBinding<K extends AnyKeyform>(
  rig: Rig<K>,
  binding: Binding,
  keepAuthoredAt: number,
  at = rig.bindings.length,
): Rig<K> {
  const bindings = [...rig.bindings];
  bindings.splice(at, 0, binding);
  const keyforms: K[] = [];
  const n = gridSize(bindings);
  for (let i = 0; i < n; i++) {
    const coords = cellCoords(bindings, i);
    const k = coords[at] as number;
    const oldCoords = coords.filter((_, j) => j !== at);
    const old = rig.keyforms[cellIndex(rig.bindings, oldCoords)] as K;
    keyforms.push(withAuthored(old, old.authored && k === keepAuthoredAt));
  }
  return { bindings, keyforms };
}

/** Removes binding `b`, keeping the slice at key index `keep`. */
export function removeBinding<K extends AnyKeyform>(rig: Rig<K>, b: number, keep: number): Rig<K> {
  const bindings = rig.bindings.filter((_, j) => j !== b);
  const keyforms: K[] = [];
  const n = gridSize(bindings);
  for (let i = 0; i < n; i++) {
    const coords = cellCoords(bindings, i);
    coords.splice(b, 0, keep);
    keyforms.push(rig.keyforms[cellIndex(rig.bindings, coords)] as K);
  }
  return { bindings, keyforms };
}

/** Inserts a key into binding `b`. New cells are interpolated between neighbors, or copied at ends. */
export function addKey<K extends AnyKeyform>(rig: Rig<K>, b: number, key: number): Rig<K> {
  const old = rig.bindings[b] as Binding;
  const k = f32(key);
  const keys = [...old.keys, k].sort((x, y) => x - y);
  const p = keys.indexOf(k);
  const bindings = rig.bindings.map((x, j) => (j === b ? { ...x, keys } : x));
  const keyforms: K[] = [];
  const n = gridSize(bindings);
  for (let i = 0; i < n; i++) {
    const coords = cellCoords(bindings, i);
    const c = coords[b] as number;
    const at = (oc: number) => {
      const cc = [...coords];
      cc[b] = oc;
      return rig.keyforms[cellIndex(rig.bindings, cc)] as K;
    };
    if (c < p) keyforms.push(at(c));
    else if (c > p) keyforms.push(at(c - 1));
    else if (p === 0) keyforms.push(withAuthored(at(0), false));
    else if (p === keys.length - 1) keyforms.push(withAuthored(at(p - 1), false));
    else {
      const lo = old.keys[p - 1] as number;
      const hi = old.keys[p] as number;
      keyforms.push(lerpKeyform(at(p - 1), at(p), (k - lo) / (hi - lo)));
    }
  }
  return { bindings, keyforms };
}

/** Removes key index `keyIndex` from binding `b`. The binding must keep at least one key. */
export function removeKey<K extends AnyKeyform>(rig: Rig<K>, b: number, keyIndex: number): Rig<K> {
  const bindings = rig.bindings.map((x, j) =>
    j === b ? { ...x, keys: x.keys.filter((_, i) => i !== keyIndex) } : x,
  );
  const keyforms: K[] = [];
  const n = gridSize(bindings);
  for (let i = 0; i < n; i++) {
    const coords = cellCoords(bindings, i);
    if ((coords[b] as number) >= keyIndex) coords[b] = (coords[b] as number) + 1;
    keyforms.push(rig.keyforms[cellIndex(rig.bindings, coords)] as K);
  }
  return { bindings, keyforms };
}

/**
 * Recomputes every unauthored keyform from authored ones. Along each axis in turn, every line of
 * cells is filled by linear interpolation between the nearest known cells, or copied from the only
 * known neighbor. Cells with no known cell in reach stay as they are.
 */
export function fillMissing<K extends AnyKeyform>(rig: Rig<K>): Rig<K> {
  const n = rig.keyforms.length;
  const known = rig.keyforms.map((k) => k.authored);
  if (!known.some(Boolean)) return rig;
  const keyforms = [...rig.keyforms];
  const s = strides(rig.bindings);
  let anyFilled = false;
  let changed = true;
  while (changed) {
    changed = false;
    rig.bindings.forEach((binding, axis) => {
      const stride = s[axis] as number;
      const len = binding.keys.length;
      for (let start = 0; start < n; start++) {
        if (cellCoords(rig.bindings, start)[axis] !== 0) continue;
        const line = Array.from({ length: len }, (_, i) => start + i * stride);
        const knownAt = line.map((idx) => known[idx] as boolean);
        if (!knownAt.some(Boolean) || knownAt.every(Boolean)) continue;
        line.forEach((idx, i) => {
          if (known[idx]) return;
          let lo = -1;
          for (let j = i - 1; j >= 0; j--)
            if (knownAt[j]) {
              lo = j;
              break;
            }
          let hi = -1;
          for (let j = i + 1; j < len; j++)
            if (knownAt[j]) {
              hi = j;
              break;
            }
          const kl = lo >= 0 ? (keyforms[line[lo] as number] as K) : undefined;
          const kh = hi >= 0 ? (keyforms[line[hi] as number] as K) : undefined;
          let v: K;
          if (kl && kh) {
            const a = binding.keys[lo] as number;
            const b = binding.keys[hi] as number;
            v = lerpKeyform(kl, kh, ((binding.keys[i] as number) - a) / (b - a));
          } else v = withAuthored((kl ?? kh) as K, false);
          keyforms[idx] = v;
          known[idx] = true;
          changed = true;
          anyFilled = true;
        });
      }
    });
  }
  return anyFilled ? { bindings: rig.bindings, keyforms } : rig;
}

/** Index of the binding for a parameter, or -1. */
export function bindingIndex(rig: Rig, parameter: Uid): number {
  return rig.bindings.findIndex((b) => b.parameter === parameter);
}
