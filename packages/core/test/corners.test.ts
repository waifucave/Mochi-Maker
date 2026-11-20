/** The four-corner forms: the diagonal cells of two parameters from their edges. */
import { describe, expect, it } from 'vitest';
import { Session } from '../src/index.js';

const scene = () => {
  const s = Session.create({ width: 200, height: 200 });
  s.transact('setup', (tx) => {
    tx.run('param.create', { exportId: 'ParamX', min: -1, max: 1, default: 0, keys: [-1, 0, 1] });
    tx.run('param.create', { exportId: 'ParamY', min: 0, max: 1, default: 0, keys: [0, 1] });
    tx.run('param.create', { exportId: 'ParamZ', min: 0, max: 1, default: 0.5, keys: [0, 1] });
    tx.run('part.create', { exportId: 'P' });
    tx.run('deformer.createRotation', {
      exportId: 'R',
      part: '@part:P',
      origin: { x: 100, y: 100 },
    });
    tx.run('rig.addBinding', { target: '@rot:R', parameter: '@param:ParamX' });
    tx.run('rig.addBinding', { target: '@rot:R', parameter: '@param:ParamY' });
    // The edges: X turns it ±20° and moves it 10 px; Y scales it and fades it.
    for (const x of [-1, 1])
      tx.run('keyform.set', {
        target: '@rot:R',
        cell: { '@param:ParamX': x, '@param:ParamY': 0 },
        values: { angle: 20 * x, originX: 100 + 10 * x },
      });
    tx.run('keyform.set', {
      target: '@rot:R',
      cell: { '@param:ParamX': 0, '@param:ParamY': 1 },
      values: { scale: 1.5, opacity: 0.4 },
    });
    // A corner set by hand, to be replaced.
    tx.run('keyform.set', {
      target: '@rot:R',
      cell: { '@param:ParamX': 1, '@param:ParamY': 1 },
      values: { angle: 99 },
    });
  });
  return s;
};
const form = (s: Session, x: number, y: number) => {
  const r = s.view.ofKind('rotation')[0]!;
  return r.rig.keyforms[x + 1 + 3 * y]!;
};

describe('four-corner forms', () => {
  it('adds each edge’s change to the rest form', () => {
    const s = scene();
    const r = s.transact('corners', (tx) => tx.run('keyform.fillCorners', { targets: ['@rot:R'] }))
      .results[0];
    expect(r).toEqual({ objects: 1, cells: 2, skipped: [] });
    for (const x of [-1, 1]) {
      const k = form(s, x, 1);
      expect(k.angle).toBeCloseTo(20 * x, 5);
      expect(k.originX).toBeCloseTo(100 + 10 * x, 4);
      expect(k.scale).toBeCloseTo(1.5, 6);
      expect(k.opacity).toBeCloseTo(0.4, 6);
      expect(k.authored).toBe(true);
    }
    // The edges stay as they were.
    expect(form(s, 1, 0).angle).toBe(20);
    expect(form(s, 0, 1).scale).toBe(1.5);
    s.undo();
    expect(form(s, 1, 1).angle).toBe(99);
  });

  it('skips objects without the two bindings, and needs each default to be a key', () => {
    const s = scene();
    const r = s.transact('corners', (tx) =>
      tx.run('keyform.fillCorners', {
        targets: ['@rot:R'],
        parameters: ['@param:ParamX', '@param:ParamZ'],
      }),
    ).results[0];
    expect(r).toMatchObject({ objects: 0, skipped: [expect.any(String)] });
    s.transact('bind Z', (tx) =>
      tx.run('rig.addBinding', { target: '@rot:R', parameter: '@param:ParamZ' }),
    );
    expect(() =>
      s.transact('x', (tx) =>
        tx.run('keyform.fillCorners', {
          targets: ['@rot:R'],
          parameters: ['@param:ParamX', '@param:ParamZ'],
        }),
      ),
    ).toThrow(/default \(0.5\) is not one of its keys/);
    // With three bindings and no pair named, the object is skipped.
    const r3 = s.transact('corners', (tx) => tx.run('keyform.fillCorners', { targets: ['@rot:R'] }))
      .results[0];
    expect(r3).toMatchObject({ objects: 0 });
    // Naming X and Y runs for every key of Z: 2 corners × 2 keys.
    const r4 = s.transact('corners', (tx) =>
      tx.run('keyform.fillCorners', {
        targets: ['@rot:R'],
        parameters: ['@param:ParamX', '@param:ParamY'],
      }),
    ).results[0];
    expect(r4).toMatchObject({ objects: 1, cells: 4 });
  });
});
