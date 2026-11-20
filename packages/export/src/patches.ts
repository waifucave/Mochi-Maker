/**
 * Value patches for the editor's preview (Mochi2D 0.6.0, `model.patch`): when an edit changes only
 * values that Mochi2D can patch in place, the preview patches the shown model instead of loading
 * it again.
 *
 * `dataPatches(shown, next)` compares the model data of two lowerings. If everything outside the
 * patchable arrays is equal (the structure did not change), it returns the patches that turn
 * `shown` into `next`, which Mochi2D evaluates exactly like a rebuild. Otherwise it returns null,
 * and the editor replaces the model's data instead (`model.replace`).
 */
import { PATCHABLE_FIELDS, type MocData, type ValuePatch } from 'mochi2d/headless';

type Group = keyof typeof PATCHABLE_FIELDS;
/** Changed elements closer than this are sent as one patch. */
const MERGE_GAP = 8;

const isArrayLike = (v: unknown): v is ArrayLike<number> & { length: number } =>
  ArrayBuffer.isView(v) || Array.isArray(v);

function patchable(path: string[]): { group: Group; field?: string } | null {
  const [group, field] = path;
  if (!group || !(group in PATCHABLE_FIELDS)) return null;
  const fields = PATCHABLE_FIELDS[group as Group] as readonly string[];
  if (fields.length === 0) return field === undefined ? { group: group as Group } : null;
  return field !== undefined && fields.includes(field) ? { group: group as Group, field } : null;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isArrayLike(a) && isArrayLike(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys)
      if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    return true;
  }
  return false;
}

/** The patches that turn `shown` into `next`, or null when the structure differs. */
export function dataPatches(shown: MocData, next: MocData): ValuePatch[] | null {
  const patches: ValuePatch[] = [];
  const walk = (a: unknown, b: unknown, path: string[]): boolean => {
    if (isArrayLike(a) || isArrayLike(b)) {
      const target = patchable(path);
      if (!target || !isArrayLike(a) || !isArrayLike(b)) return same(a, b);
      if (a.length !== b.length) return false;
      let start = -1;
      let last = -1;
      const flush = () => {
        if (start < 0) return;
        patches.push({
          ...target,
          start,
          values: Array.prototype.slice.call(b, start, last + 1) as number[],
        });
        start = -1;
      };
      for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        if (start >= 0 && i - last > MERGE_GAP) flush();
        if (start < 0) start = i;
        last = i;
      }
      flush();
      return true;
    }
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys)
        if (
          !walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k])
        )
          return false;
      return true;
    }
    return same(a, b);
  };
  return walk(shown, next, []) ? patches : null;
}

/** Writes patches into model data (to keep a copy in step with the shown model). */
export function applyDataPatches(data: MocData, patches: readonly ValuePatch[]): void {
  for (const p of patches) {
    const group = (data as unknown as Record<string, unknown>)[p.group];
    const array = (p.field === undefined ? group : (group as Record<string, unknown>)[p.field]) as {
      [i: number]: number;
    };
    for (let i = 0; i < p.values.length; i++) array[p.start + i] = p.values[i]!;
  }
}
