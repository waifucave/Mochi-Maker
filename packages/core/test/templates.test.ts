/** Animation templates and the recording solver. */
import { describe, expect, it } from 'vitest';
import {
  Session,
  curveKeys,
  fieldAt,
  solveField,
  templateMatch,
  type Rig,
  type RotationKeyform,
} from '../src/index.js';

const scene = () => {
  const s = Session.create({ width: 100, height: 100 });
  s.transact('setup', (tx) => {
    for (const id of ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouth'])
      tx.run('param.create', { exportId: id, min: 0, max: 1, default: 1 });
    tx.run('motion.create', { name: 'm', duration: 3, fps: 30 });
    tx.run('motion.create', { name: 'n', duration: 3, fps: 30 });
  });
  return s;
};
const L = { target: 'parameter' as const, object: '@param:ParamEyeLOpen' };
const R = { target: 'parameter' as const, object: '@param:ParamEyeROpen' };
const keysOn = (s: Session, motion: string, param: string) => {
  const m = s.view.ofKind('motion').find((x) => x.name === motion)!;
  const uid = s.view.ofKind('parameter').find((p) => p.exportId === param)!.uid;
  const c = m.curves.find((x) => x.object === uid);
  return c ? curveKeys(c.segments, c.auto).map((k) => [k.time, k.value]) : [];
};

describe('animation templates', () => {
  it('cuts a template from a range, and inserts it at a time by parameter ID', () => {
    const s = scene();
    s.transact('blink', (tx) => {
      for (const ref of [L, R])
        tx.run('motion.setKeys', {
          target: '@motion~m',
          curve: ref,
          keys: [
            { time: 0, value: 1 },
            { time: 1, value: 1 },
            { time: 1.1, value: 0 },
            { time: 1.3, value: 1 },
            { time: 2, value: 1 },
          ],
        });
    });
    const made = s.transact('template', (tx) =>
      tx.run('template.create', { name: 'Blink', motion: '@motion~m', from: 1, to: 1.3 }),
    ).results[0];
    expect(made).toEqual({ parameters: ['ParamEyeLOpen', 'ParamEyeROpen'], keys: 6 });
    const t = s.view.project().animationTemplates[0]!;
    expect(t.duration).toBeCloseTo(0.3, 9);
    expect(t.curves[0]!.keys.map((k) => [k.time, k.value])).toEqual([
      [0, 1],
      [expect.closeTo(0.1, 9), 0],
      [expect.closeTo(0.3, 9), 1],
    ]);
    // Insert into the other motion at 2 s: its own keys inside the span give way.
    s.transact('existing', (tx) =>
      tx.run('motion.setKeys', {
        target: '@motion~n',
        curve: L,
        keys: [
          { time: 0, value: 0.5 },
          { time: 2.1, value: 0.2 },
          { time: 3, value: 0.5 },
        ],
      }),
    );
    const applied = s.transact('apply', (tx) =>
      tx.run('template.apply', { name: 'Blink', target: '@motion~n', time: 2 }),
    ).results[0];
    expect(applied).toEqual({ parameters: ['ParamEyeLOpen', 'ParamEyeROpen'], unmatched: [] });
    expect(keysOn(s, 'n', 'ParamEyeLOpen')).toEqual([
      [0, 0.5],
      [2, 1],
      [expect.closeTo(2.1, 9), 0],
      [expect.closeTo(2.3, 9), 1],
      [3, 0.5],
    ]);
    expect(keysOn(s, 'n', 'ParamEyeROpen').length).toBe(3);
    s.undo();
    expect(keysOn(s, 'n', 'ParamEyeROpen')).toEqual([]);
  });

  it('reports unmatched parameters, and refuses a template with no match', () => {
    const s = scene();
    const template = {
      name: 'Wink',
      duration: 0.2,
      curves: [
        { id: 'ParamEyeLOpen', keys: [{ time: 0, value: 0, interp: 'linear' as const }] },
        { id: 'PARAM_EYE_R_OPEN', keys: [{ time: 0, value: 0, interp: 'linear' as const }] },
      ],
    };
    s.transact('add', (tx) => tx.run('template.add', { template }));
    expect(templateMatch(template, ['ParamEyeLOpen', 'ParamMouth'])).toEqual({
      matched: ['ParamEyeLOpen'],
      unmatched: ['PARAM_EYE_R_OPEN'],
    });
    const r = s.transact('apply', (tx) =>
      tx.run('template.apply', { name: 'Wink', target: '@motion~m', time: 1 }),
    ).results[0];
    expect(r).toEqual({ parameters: ['ParamEyeLOpen'], unmatched: ['PARAM_EYE_R_OPEN'] });
    s.transact('add', (tx) =>
      tx.run('template.add', {
        template: { ...template, name: 'Other', curves: [template.curves[1]!] },
      }),
    );
    expect(() =>
      s.transact('x', (tx) =>
        tx.run('template.apply', { name: 'Other', target: '@motion~m', time: 0 }),
      ),
    ).toThrow(/PARAM_EYE_R_OPEN/);
    // Names are unique; replace overwrites; rename and delete.
    expect(() => s.transact('x', (tx) => tx.run('template.add', { template }))).toThrow(
      /exists already/,
    );
    s.transact('replace', (tx) =>
      tx.run('template.add', { template: { ...template, duration: 1 }, replace: true }),
    );
    expect(s.view.project().animationTemplates[0]!.duration).toBe(1);
    expect(() =>
      s.transact('x', (tx) => tx.run('template.rename', { name: 'Wink', newName: 'Other' })),
    ).toThrow(/exists already/);
    s.transact('rename', (tx) => tx.run('template.rename', { name: 'Wink', newName: 'Wink L' }));
    s.transact('delete', (tx) => tx.run('template.delete', { name: 'Other' }));
    expect(s.view.project().animationTemplates.map((t) => t.name)).toEqual(['Wink L']);
    expect(() =>
      s.transact('x', (tx) =>
        tx.run('template.create', { name: 'Empty', motion: '@motion~n', from: 0, to: 1 }),
      ),
    ).toThrow(/no parameter keys/);
  });
});

describe('recording solver', () => {
  const kf = (angle: number): RotationKeyform =>
    ({
      authored: true,
      angle,
      originX: 0,
      originY: 0,
      scale: 1,
      reflectX: false,
      reflectY: false,
      opacity: 1,
      drawOrder: 500,
      multiplyColor: [1, 1, 1],
      screenColor: [0, 0, 0],
    }) as unknown as RotationKeyform;
  // Angle Z: −30 → −10°, 0 → 0°, 30 → 10°; Body 10 adds 10° (a 3 × 2 grid).
  const rig: Rig<RotationKeyform> = {
    bindings: [
      { parameter: 'param_z', keys: [-30, 0, 30] },
      { parameter: 'param_b', keys: [0, 10] },
    ],
    keyforms: [kf(-10), kf(0), kf(10), kf(0), kf(10), kf(20)],
  };
  const pose = (z: number, b: number) => (p: string) => (p === 'param_z' ? z : b);
  const range = (p: string) => (p === 'param_z' ? { min: -30, max: 30 } : { min: 0, max: 10 });

  it('blends keyforms multilinearly, held beyond the end keys', () => {
    expect(fieldAt(rig, 'angle', pose(15, 0))).toBeCloseTo(5, 9);
    expect(fieldAt(rig, 'angle', pose(15, 5))).toBeCloseTo(10, 9);
    expect(fieldAt(rig, 'angle', pose(99, 99))).toBeCloseTo(20, 9);
  });

  it('finds the value that turns the deformer to the dragged angle, changing least', () => {
    // 5° from the default pose: Angle Z 15 (a quarter of its range) beats Body 5 (half of its).
    expect(solveField(rig, 'angle', pose(0, 0), 5, range)).toEqual({
      parameter: 'param_z',
      value: expect.closeTo(15, 9),
    });
    // 15° with Angle Z at its end: only Body reaches it.
    expect(solveField(rig, 'angle', pose(30, 0), 15, range)).toEqual({
      parameter: 'param_b',
      value: expect.closeTo(5, 9),
    });
    // Out of reach: as near as the keys get.
    const r = solveField(rig, 'angle', pose(30, 10), 90, range)!;
    expect(fieldAt(rig, 'angle', (p) => (p === r.parameter ? r.value : pose(30, 10)(p)))).toBe(20);
    expect(solveField({ bindings: [], keyforms: [kf(3)] }, 'angle', pose(0, 0), 9, range)).toBe(
      null,
    );
  });
});

describe('deform paths in the project', () => {
  it('are saved, moved and deleted by commands, and give way when a target is deleted', () => {
    const s = Session.create({ width: 100, height: 100 });
    s.transact('setup', (tx) => {
      tx.run('part.create', { exportId: 'P' });
      for (const id of ['A', 'B'])
        tx.run('mesh.create', {
          exportId: id,
          part: '@part:P',
          uv: [
            [0, 0],
            [10, 0],
            [0, 10],
          ],
          triangles: [[0, 1, 2]],
        });
    });
    const id = s.transact('path', (tx) =>
      tx.run('deformPath.create', {
        targets: ['@mesh:A', '@mesh:B'],
        level: 3,
        points: [[0, 0]],
      }),
    ).results[0] as { id: number };
    expect(id).toEqual({ id: 1 });
    s.transact('move', (tx) =>
      tx.run('deformPath.update', {
        id: 1,
        points: [
          [5, 5],
          [9, 9],
        ],
      }),
    );
    expect(s.view.project().deformPaths[0]).toMatchObject({
      level: 3,
      reach: 60,
      points: [
        [5, 5],
        [9, 9],
      ],
    });
    // Deleting a target is never blocked by a path: the path drops it, then goes with the last.
    s.transact('del A', (tx) => tx.run('mesh.delete', { target: '@mesh:A' }));
    expect(s.view.project().deformPaths[0]!.targets).toHaveLength(1);
    s.transact('del B', (tx) => tx.run('mesh.delete', { target: '@mesh:B' }));
    expect(s.view.project().deformPaths).toEqual([]);
    s.undo();
    s.undo();
    expect(s.view.project().deformPaths[0]!.targets).toHaveLength(2);
    s.transact('delete', (tx) => tx.run('deformPath.delete', { id: 1 }));
    expect(s.view.project().deformPaths).toEqual([]);
    expect(() => s.transact('x', (tx) => tx.run('deformPath.delete', { id: 1 }))).toThrow(
      /no deform path 1/,
    );
  });
});
