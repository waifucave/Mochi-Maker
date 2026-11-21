import { describe, expect, it } from 'vitest';
import { rig, type PartKeyform, type Rig } from '@mochi-maker/core';

const kf = (drawOrder: number, authored = true): PartKeyform => ({
  authored,
  drawOrder,
  opacity: 1,
  multiply: [1, 1, 1],
  screen: [0, 0, 0],
});
const orders = (r: Rig<PartKeyform>) => r.keyforms.map((k) => k.drawOrder);

describe('keyform grids', () => {
  const base: Rig<PartKeyform> = { bindings: [], keyforms: [kf(500)] };

  it('lays out cells with the first binding varying fastest', () => {
    const bindings = [
      { parameter: 'a', keys: [0, 1] },
      { parameter: 'b', keys: [0, 1, 2] },
    ];
    expect(rig.cellCoords(bindings, 0)).toEqual([0, 0]);
    expect(rig.cellCoords(bindings, 1)).toEqual([1, 0]);
    expect(rig.cellCoords(bindings, 2)).toEqual([0, 1]);
    expect(rig.cellIndex(bindings, [1, 2])).toBe(5);
  });

  it('adding a binding copies every cell and keeps "authored" only at the given key', () => {
    const r = rig.addBinding(base, { parameter: 'a', keys: [-1, 0, 1] }, 1);
    expect(orders(r)).toEqual([500, 500, 500]);
    expect(r.keyforms.map((k) => k.authored)).toEqual([false, true, false]);
    const r2 = rig.addBinding(r, { parameter: 'b', keys: [0, 1] }, 0, 0);
    expect(r2.bindings.map((b) => b.parameter)).toEqual(['b', 'a']);
    expect(r2.keyforms).toHaveLength(6);
    expect(r2.keyforms.map((k) => k.authored)).toEqual([false, false, true, false, false, false]);
  });

  it('adding a key between two keys interpolates; at the ends it copies', () => {
    let r: Rig<PartKeyform> = {
      bindings: [{ parameter: 'a', keys: [0, 10] }],
      keyforms: [kf(100), kf(200)],
    };
    r = rig.addKey(r, 0, 2.5);
    expect(orders(r)).toEqual([100, 125, 200]);
    expect(r.keyforms[1]!.authored).toBe(false);
    r = rig.addKey(r, 0, 20);
    expect(orders(r)).toEqual([100, 125, 200, 200]);
    r = rig.addKey(r, 0, -5);
    expect(orders(r)).toEqual([100, 100, 125, 200, 200]);
  });

  it('removing a key or a binding keeps the right slice', () => {
    const r: Rig<PartKeyform> = {
      bindings: [
        { parameter: 'a', keys: [0, 1] },
        { parameter: 'b', keys: [0, 1] },
      ],
      keyforms: [kf(1), kf(2), kf(3), kf(4)],
    };
    expect(orders(rig.removeKey(r, 0, 0))).toEqual([2, 4]);
    expect(orders(rig.removeBinding(r, 1, 1))).toEqual([3, 4]);
    expect(orders(rig.removeBinding(r, 0, 0))).toEqual([1, 3]);
  });

  it('fills unauthored cells from authored ones along each axis', () => {
    const r: Rig<PartKeyform> = {
      bindings: [
        { parameter: 'a', keys: [0, 1, 2] },
        { parameter: 'b', keys: [0, 1] },
      ],
      keyforms: [kf(0), kf(999, false), kf(20), kf(999, false), kf(999, false), kf(999, false)],
    };
    const f = rig.fillMissing(r);
    expect(orders(f)).toEqual([0, 10, 20, 0, 10, 20]);
    expect(f.keyforms.map((k) => k.authored)).toEqual([true, false, true, false, false, false]);
  });

  it('interpolates float32 arrays and keeps booleans of the lower cell', () => {
    const a = { authored: true, positions: Float32Array.from([0, 0]), mirrorX: true } as never;
    const b = { authored: true, positions: Float32Array.from([10, 20]), mirrorX: false } as never;
    const m = rig.lerpKeyform(a, b, 0.5) as unknown as {
      positions: Float32Array;
      mirrorX: boolean;
      authored: boolean;
    };
    expect([...m.positions]).toEqual([5, 10]);
    expect(m.mirrorX).toBe(true);
    expect(m.authored).toBe(false);
  });
});
