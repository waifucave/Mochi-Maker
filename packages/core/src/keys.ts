/**
 * Motion keys (M10): a curve as a list of keys, each with the interpolation of the segment
 * that follows it, and the conversion to and from the motion file's segment encoding that the
 * document stores.
 *
 * Interpolations, in the familiar order: `linear`, `auto` (Auto smooth), `step`, `inverseStep` and
 * `bezier`. The motion file has no Auto smooth segment, so the document stores it as a Bézier
 * segment with handles computed from the keys (`autoHandles`), and marks the segment's index in the
 * curve's `auto` list. Editing keys recomputes those handles, so an Auto smooth segment always
 * follows its keys; the export writes it as the Bézier it is.
 *
 * Auto smooth handles: each key gets a slope. An end key, or a key that is a peak or a valley (its
 * value not strictly between its neighbours'), gets slope 0, so the curve eases out and in there.
 * Any other key gets the slope from its previous to its next key. Each segment then limits the two
 * slopes as monotone cubic interpolation does (Fritsch–Carlson), so it never overshoots its keys.
 * A segment's handles sit a third of the way along it in time, on those slopes.
 */
import { MochiError } from './errors.js';
import type { AnimationTemplate, Motion } from './model.js';

export type Interpolation = 'linear' | 'auto' | 'step' | 'inverseStep' | 'bezier';
export const INTERPOLATIONS: readonly Interpolation[] = [
  'linear',
  'auto',
  'step',
  'inverseStep',
  'bezier',
];

export interface MotionKey {
  time: number;
  value: number;
  /** The interpolation of the segment after this key (ignored on the last key). */
  interp: Interpolation;
  /** Bézier handles of the segment after this key: [t1, v1, t2, v2] (bezier only). */
  handles?: [number, number, number, number];
}

/** A curve's keys, from its segments and its list of Auto smooth segment indices. */
export function curveKeys(segments: readonly number[], auto: readonly number[] = []): MotionKey[] {
  const keys: MotionKey[] = [{ time: segments[0]!, value: segments[1]!, interp: 'linear' }];
  const autos = new Set(auto);
  let i = 2;
  let s = 0;
  while (i < segments.length) {
    const code = segments[i]!;
    const prev = keys[keys.length - 1]!;
    if (code === 1) {
      const [t1, v1, t2, v2, t3, v3] = segments.slice(i + 1, i + 7) as number[];
      if (autos.has(s)) prev.interp = 'auto';
      else {
        prev.interp = 'bezier';
        prev.handles = [t1!, v1!, t2!, v2!];
      }
      keys.push({ time: t3!, value: v3!, interp: 'linear' });
      i += 7;
    } else {
      prev.interp = code === 0 ? 'linear' : code === 2 ? 'step' : 'inverseStep';
      keys.push({ time: segments[i + 1]!, value: segments[i + 2]!, interp: 'linear' });
      i += 3;
    }
    s++;
  }
  return keys;
}

/** The slope of each key for Auto smooth handles. */
function autoSlopes(keys: readonly MotionKey[]): number[] {
  return keys.map((k, i) => {
    const a = keys[i - 1];
    const b = keys[i + 1];
    if (!a || !b || b.time === a.time) return 0;
    const between = (k.value - a.value) * (b.value - k.value) > 0;
    return between ? (b.value - a.value) / (b.time - a.time) : 0;
  });
}

/**
 * The Bézier handles Auto smooth gives the segment from key i to key i + 1: the keys' slopes,
 * limited for this segment so the curve stays between the two keys' values (Fritsch–Carlson).
 */
export function autoHandles(
  keys: readonly MotionKey[],
  i: number,
): [number, number, number, number] {
  return segmentHandles(keys, autoSlopes(keys), i);
}

function segmentHandles(
  keys: readonly MotionKey[],
  slopes: readonly number[],
  i: number,
): [number, number, number, number] {
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const h = b.time - a.time;
  const delta = h > 0 ? (b.value - a.value) / h : 0;
  let [m0, m1] = [slopes[i]!, slopes[i + 1]!];
  if (delta === 0) [m0, m1] = [0, 0];
  else {
    const [al, be] = [m0 / delta, m1 / delta];
    if (al < 0) m0 = 0;
    if (be < 0) m1 = 0;
    const r = Math.hypot(Math.max(al, 0), Math.max(be, 0));
    if (r > 3) {
      m0 = (3 / r) * Math.max(al, 0) * delta;
      m1 = (3 / r) * Math.max(be, 0) * delta;
    }
  }
  const d = h / 3;
  return [a.time + d, a.value + m0 * d, b.time - d, b.value - m1 * d];
}

/** Segments and Auto smooth indices of a key list, sorted by time. */
export function keysToCurve(input: readonly MotionKey[]): { segments: number[]; auto: number[] } {
  const keys = [...input].sort((a, b) => a.time - b.time);
  if (keys.length === 0) throw new Error('A curve needs at least one key.');
  const slopes = autoSlopes(keys);
  const segments: number[] = [keys[0]!.time, keys[0]!.value];
  const auto: number[] = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    switch (a.interp) {
      case 'auto': {
        auto.push(i);
        segments.push(1, ...segmentHandles(keys, slopes, i), b.time, b.value);
        break;
      }
      case 'bezier': {
        const d = (b.time - a.time) / 3;
        const [t1, v1, t2, v2] = a.handles ?? [a.time + d, a.value, b.time - d, b.value];
        // Handles stay inside the segment in time, so the curve never goes back.
        const clamp = (t: number) => Math.min(b.time, Math.max(a.time, t));
        segments.push(1, clamp(t1), v1, clamp(t2), v2, b.time, b.value);
        break;
      }
      case 'step':
        segments.push(2, b.time, b.value);
        break;
      case 'inverseStep':
        segments.push(3, b.time, b.value);
        break;
      default:
        segments.push(0, b.time, b.value);
    }
  }
  return { segments, auto };
}

/** A curve's value at a time: linear, Bézier (solved for time), stepped and inverse stepped. */
export function sampleSegments(segments: readonly number[], t: number): number {
  let [x0, y0] = [segments[0]!, segments[1]!];
  if (t <= x0) return y0;
  let i = 2;
  while (i < segments.length) {
    const code = segments[i]!;
    if (code === 1) {
      const [x1, y1, x2, y2, x3, y3] = segments.slice(i + 1, i + 7) as number[];
      if (t <= x3!) {
        let [lo, hi] = [0, 1];
        const bx = (s: number) =>
          (1 - s) ** 3 * x0 + 3 * (1 - s) ** 2 * s * x1! + 3 * (1 - s) * s * s * x2! + s ** 3 * x3!;
        for (let k = 0; k < 40; k++) {
          const mid = (lo + hi) / 2;
          if (bx(mid) < t) lo = mid;
          else hi = mid;
        }
        const s = (lo + hi) / 2;
        return (
          (1 - s) ** 3 * y0 + 3 * (1 - s) ** 2 * s * y1! + 3 * (1 - s) * s * s * y2! + s ** 3 * y3!
        );
      }
      [x0, y0] = [x3!, y3!];
      i += 7;
    } else {
      const [x1, y1] = [segments[i + 1]!, segments[i + 2]!];
      if (t <= x1) {
        if (code === 0) return y0 + ((y1 - y0) * (t - x0)) / (x1 - x0 || 1);
        return code === 2 ? y0 : y1;
      }
      [x0, y0] = [x1, y1];
      i += 3;
    }
  }
  return y0;
}

/** Checks that Auto smooth indices name Bézier segments; returns them sorted and unique. */
export function checkAuto(
  segments: readonly number[],
  auto: readonly number[],
  path: string,
): number[] {
  const codes: number[] = [];
  for (let i = 2; i < segments.length; i += segments[i] === 1 ? 7 : 3) codes.push(segments[i]!);
  for (const a of auto)
    if (codes[a] !== 1)
      throw new MochiError(
        'E_SCHEMA',
        `Segment ${a} is not a Bézier segment, so it cannot be Auto smooth.`,
        { path },
      );
  return [...new Set(auto)].sort((x, y) => x - y);
}

/**
 * Which of an animation template's parameters a model has, by export ID, and which it lacks: what
 * the Template palette shows before inserting.
 */
export function templateMatch(
  template: AnimationTemplate,
  exportIds: Iterable<string>,
): { matched: string[]; unmatched: string[] } {
  const ids = new Set(exportIds);
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const c of template.curves) (ids.has(c.id) ? matched : unmatched).push(c.id);
  return { matched, unmatched };
}

/**
 * The part of a motion between two times, as a motion of its own that starts at 0 (the
 * work area's playback). Each curve is sampled at the motion's frames from `start` to `end` and
 * joined with linear segments, so it shows the same values frame by frame; events in the range move
 * with it, and its sound is dropped (it would start at the wrong place).
 */
export function clipMotion(m: Motion, start: number, end: number): Motion {
  const s = Math.max(0, Math.min(start, m.duration));
  const e = Math.max(s, Math.min(end, m.duration));
  const fps = m.fps || 30;
  const times: number[] = [];
  for (let f = Math.ceil(s * fps - 1e-9); f / fps < e - 1e-9; f++) times.push(f / fps);
  if (times[0] === undefined || times[0] > s + 1e-9) times.unshift(s);
  times.push(e);
  const curves = m.curves.map((c) => {
    const segments: number[] = [];
    times.forEach((t, i) => {
      if (i > 0) segments.push(0);
      segments.push(t - s, sampleSegments(c.segments, t));
    });
    return { ...c, segments, auto: [] };
  });
  return {
    ...m,
    duration: e - s,
    curves,
    events: m.events
      .filter((x) => x.time >= s && x.time <= e)
      .map((x) => ({ ...x, time: x.time - s })),
    markers: [],
    workArea: null,
    sound: null,
    motionSync: null,
  };
}
