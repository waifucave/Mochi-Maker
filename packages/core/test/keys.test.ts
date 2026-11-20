/** Motion keys: conversions, Auto smooth, key commands and motion lint. */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DocView,
  Session,
  curveKeys,
  keysToCurve,
  lint,
  sampleSegments,
  type Document,
  type MotionKey,
} from '../src/index.js';

const motionScene = () => {
  const s = Session.create({ width: 100, height: 100 });
  s.transact('setup', (tx) => {
    tx.run('param.create', { exportId: 'ParamA', min: -10, max: 10, default: 0, keys: [-10, 10] });
    tx.run('part.create', { exportId: 'PartA' });
    tx.run('motion.create', { name: 'm', duration: 2, fps: 30 });
  });
  return s;
};
const curve = (s: Session) => s.view.ofKind('motion')[0]!.curves[0]!;

describe('keys and segments', () => {
  it('round-trip, with every interpolation', () => {
    const keys: MotionKey[] = [
      { time: 0, value: 0, interp: 'linear' },
      { time: 0.5, value: 4, interp: 'auto' },
      { time: 1, value: -2, interp: 'step' },
      { time: 1.25, value: 1, interp: 'inverseStep' },
      { time: 1.5, value: 3, interp: 'bezier', handles: [1.6, 5, 1.9, 0] },
      { time: 2, value: 0, interp: 'linear' },
    ];
    const { segments, auto } = keysToCurve(keys);
    expect(auto).toEqual([1]);
    const codes: number[] = [];
    for (let i = 2; i < segments.length; i += segments[i] === 1 ? 7 : 3) codes.push(segments[i]!);
    expect(codes).toEqual([0, 1, 2, 3, 1]);
    expect(curveKeys(segments, auto)).toEqual(keys);
    // Without the Auto smooth list, an Auto smooth segment reads back as the Bézier it is.
    expect(curveKeys(segments)[1]!.interp).toBe('bezier');
  });

  it('Auto smooth passes through its keys and never overshoots them', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 30 }), fc.integer({ min: -50, max: 50 })), {
          minLength: 2,
          maxLength: 8,
        }),
        (steps) => {
          let t = 0;
          const keys: MotionKey[] = steps.map(([dt, v]) => ({
            time: (t += dt / 30),
            value: v,
            interp: 'auto',
          }));
          const { segments } = keysToCurve(keys);
          for (let i = 0; i + 1 < keys.length; i++) {
            const [a, b] = [keys[i]!, keys[i + 1]!];
            expect(sampleSegments(segments, a.time)).toBeCloseTo(a.value, 6);
            const [lo, hi] = [Math.min(a.value, b.value), Math.max(a.value, b.value)];
            for (let k = 1; k < 10; k++) {
              const v = sampleSegments(segments, a.time + ((b.time - a.time) * k) / 10);
              expect(v).toBeGreaterThanOrEqual(lo - 1e-6);
              expect(v).toBeLessThanOrEqual(hi + 1e-6);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('key commands', () => {
  it('insert, move, interpolate and delete keys; handles follow their keys', () => {
    const s = motionScene();
    const ref = { target: 'parameter' as const, object: '@param:ParamA' };
    s.transact('keys', (tx) => {
      tx.run('motion.insertKey', { target: '@motion~m', curve: ref, time: 0, value: 0 });
      tx.run('motion.insertKey', { target: '@motion~m', curve: ref, time: 1, value: 5 });
      tx.run('motion.insertKey', { target: '@motion~m', curve: ref, time: 2, value: 0 });
    });
    // New keys default to Auto smooth.
    expect(curve(s).auto).toEqual([0, 1]);
    s.transact('bezier', (tx) =>
      tx.run('motion.setInterpolation', {
        target: '@motion~m',
        curve: ref,
        times: [1],
        interp: 'bezier',
      }),
    );
    // Turned Bézier, the segment keeps the Auto smooth shape it had.
    const before = sampleSegments(curve(s).segments, 1.5);
    expect(curve(s).auto).toEqual([0]);
    const k1 = curveKeys(curve(s).segments, curve(s).auto)[1]!;
    expect(k1.interp).toBe('bezier');
    s.undo();
    expect(sampleSegments(curve(s).segments, 1.5)).toBeCloseTo(before, 9);
    s.redo();
    s.transact('move', (tx) =>
      tx.run('motion.moveKeys', { target: '@motion~m', curve: ref, times: [1], dt: 0.25, dv: 1 }),
    );
    const keys = curveKeys(curve(s).segments, curve(s).auto);
    expect(keys.map((k) => [k.time, k.value])).toEqual([
      [0, 0],
      [1.25, 6],
      [2, 0],
    ]);
    expect(keys[1]!.handles![0]).toBeCloseTo(k1.handles![0] + 0.25, 9);
    s.transact('step', (tx) =>
      tx.run('motion.setInterpolation', {
        target: '@motion~m',
        curve: ref,
        times: [0],
        interp: 'step',
      }),
    );
    expect(sampleSegments(curve(s).segments, 1)).toBe(0);
    s.transact('delete', (tx) =>
      tx.run('motion.deleteKeys', { target: '@motion~m', curve: ref, times: [0, 1.25, 2] }),
    );
    expect(s.view.ofKind('motion')[0]!.curves).toEqual([]);
    expect(() =>
      s.transact('bad', (tx) =>
        tx.run('motion.deleteKeys', { target: '@motion~m', curve: ref, times: [9] }),
      ),
    ).toThrow(/no key at 9/);
  });
});

describe('motion lint', () => {
  it('reports a missing target, keys out of order and fades longer than the motion', () => {
    const s = motionScene();
    s.transact('curve', (tx) => {
      tx.run('motion.setKeys', {
        target: '@motion~m',
        curve: { target: 'parameter', object: '@param:ParamA' },
        keys: [
          { time: 0, value: 0 },
          { time: 1, value: 1 },
        ],
        fadeIn: 3,
      });
      tx.run('motion.update', { target: '@motion~m', fadeOut: 2.5 });
    });
    const m = s.view.ofKind('motion')[0]!;
    const doc: Document = {
      seq: s.doc.seq,
      objects: {
        ...s.doc.objects,
        [m.uid]: {
          ...m,
          curves: [
            ...m.curves,
            { ...m.curves[0]!, object: 'param_9999' },
            {
              ...m.curves[0]!,
              target: 'partOpacity',
              object: s.view.ofKind('part')[0]!.uid,
              segments: [1, 0, 0, 0.5, 1],
            },
          ],
        },
      } as Document['objects'],
    };
    const rules = lint(new DocView(doc))
      .filter((l) => l.rule.startsWith('motion-'))
      .map((l) => `${l.rule} ${l.severity}`);
    expect(rules.sort()).toEqual(
      [
        'motion-fade-too-long warning',
        'motion-fade-too-long warning',
        'motion-fade-too-long warning',
        'motion-fade-too-long warning',
        'motion-keys-out-of-order error',
        'motion-missing-target error',
      ].sort(),
    );
  });
});
