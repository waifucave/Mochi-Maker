/**
 * Float32 helpers.
 *
 * Keyform values, keys and parameter ranges are stored as float32 values, because
 * evaluation is in float32 (design 3.3). Every command rounds such values when it writes them, so what
 * the document holds is exactly what gets exported.
 */

/** Rounds to float32. Negative zero becomes zero, so text and equality stay canonical. */
export function f32(x: number): number {
  const r = Math.fround(x);
  return r === 0 ? 0 : r;
}

/** Linear interpolation, rounded to float32. */
export function lerpF32(a: number, b: number, t: number): number {
  return f32(a + t * (b - a));
}

/**
 * The shortest decimal text that reads back as the same float32 value. `x` must already be a
 * float32 value. Integers are written without a fraction.
 */
export function formatF32(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`not a finite number: ${x}`);
  if (x === 0) return '0';
  if (Number.isInteger(x)) return String(x);
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(x.toPrecision(p));
    if (Math.fround(candidate) === x) return String(candidate);
  }
  return String(x);
}

/** Text for a double value: the shortest text that reads back as the same double. */
export function formatF64(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`not a finite number: ${x}`);
  return x === 0 ? '0' : String(x);
}

/** True when the two float32 arrays have identical contents. */
export function sameF32(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
