/**
 * Scrubbing with physics: snapshots while baking, restore the nearest, step to the
 * playhead; the result equals a straight run from the start, bit for bit. With
 * MOCHI_MAKER_BENCH=1, the scrub latency on the synthetic project (design target size) with
 * physics added.
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { MemoryFileSource, ModelRuntime } from 'mochi2d/headless';
import { exportModel } from '@mochi-maker/export';
import type { Session } from '@mochi-maker/core';
import { PhysicsScrubber } from '../src/scrub.js';
import { golden11 } from '../../export/test/golden.js';
import { syntheticProject } from '../../export/test/synthetic.js';

const EFFECTS = ['eyeBlink', 'breath', 'look', 'idle', 'lipSync', 'pose', 'expressions'] as const;

async function runtime(session: Session, assets: Parameters<typeof exportModel>[1]) {
  const r = await exportModel(session.doc, assets);
  const make = async () => {
    const rt = await ModelRuntime.load(MemoryFileSource.fromFiles(r.files), undefined, {
      holdPhysicsInZeroSteps: true,
    });
    for (const e of EFFECTS) if (rt.effectAvailable(e)) rt.setEffect(e, false);
    rt.setEffect('physics', true);
    return rt;
  };
  return make;
}

/** ParamIn swings back and forth: a motion's curve, sampled per frame. */
const swing = (frame: number) => ({ ParamIn: 10 * Math.sin(frame / 7) });

describe('scrubbing with physics', () => {
  it('shows any frame as a straight run from the start would, bit for bit', async () => {
    const g = await golden11();
    const make = await runtime(g.session, g.assets);
    const bake = await make();
    const shown = await make();
    const scrub = new PhysicsScrubber(bake, swing, 1 / 30, 10);
    const straight = async (frame: number) => {
      const rt = await make();
      for (let f = 0; f <= frame; f++) {
        rt.setParameter('ParamIn', swing(f).ParamIn);
        rt.update(1 / 30);
      }
      rt.update(0);
      return rt.getParameter('ParamOut');
    };
    // Out of order, back and forth, on snapshots and between them.
    for (const frame of [57, 3, 40, 0, 99, 10, 11, 58]) {
      scrub.show(shown, frame);
      expect(scrub.lastSteps).toBeLessThan(10);
      const want = await straight(frame);
      expect(shown.getParameter('ParamOut'), `frame ${frame}`).toBe(want);
    }
    expect(Math.abs(shown.getParameter('ParamOut'))).toBeGreaterThan(0.01);
    expect(scrub.snapshotCount).toBe(1 + 10);
  }, 60_000);

  it.runIf(process.env.MOCHI_MAKER_BENCH === '1')(
    'measures the scrub latency on the synthetic project',
    async () => {
      const { session, assets } = await syntheticProject();
      const params = session.view
        .project()
        .parameterOrder.map((u) => session.view.getAs(u, 'parameter').exportId);
      // 24 pendulums of three particles, each read from one parameter and writing two.
      session.transact('physics', (tx) => {
        for (let k = 0; k < 24; k++)
          tx.run('physics.addSetting', {
            name: `Hair ${k}`,
            inputs: [{ parameter: `@param:${params[k]}`, weight: 100, type: 'X' }],
            outputs: [
              {
                parameter: `@param:${params[100 + 2 * k]}`,
                weight: 100,
                type: 'Angle',
                particle: 1,
                scale: 1,
              },
              {
                parameter: `@param:${params[101 + 2 * k]}`,
                weight: 100,
                type: 'Angle',
                particle: 2,
                scale: 1,
              },
            ],
            particles: [
              { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
              { x: 0, y: 10, mobility: 0.95, delay: 0.9, acceleration: 1.5, radius: 10 },
              { x: 0, y: 20, mobility: 0.9, delay: 0.8, acceleration: 1.5, radius: 10 },
            ],
            normalization: {
              position: { min: -10, default: 0, max: 10 },
              angle: { min: -10, default: 0, max: 10 },
            },
          });
      });
      const make = await runtime(session, assets);
      const [bake, shown] = [await make(), await make()];
      // 50 parameters keyed by the motion, 10 s at 30 fps.
      const values = (f: number) =>
        Object.fromEntries(params.slice(0, 50).map((id, i) => [id, Math.sin(f / (5 + i))]));
      const scrub = new PhysicsScrubber(bake, values, 1 / 30, 10);
      const t0 = performance.now();
      scrub.bakeTo(300);
      const bakeMs = performance.now() - t0;
      const lat: number[] = [];
      for (let k = 0; k < 60; k++) {
        const frame = (k * 137) % 300;
        const t = performance.now();
        scrub.show(shown, frame);
        lat.push(performance.now() - t);
      }
      lat.sort((a, b) => a - b);
      const out = {
        frames: 300,
        bakeMsPerFrame: bakeMs / 301,
        scrubMedianMs: lat[30],
        scrubWorstMs: lat.at(-1),
        snapshots: scrub.snapshotCount,
      };
      writeFileSync(process.env.MOCHI_MAKER_BENCH_OUT ?? '/dev/null', JSON.stringify(out));
      expect(out.scrubWorstMs).toBeLessThan(1000);
    },
    300_000,
  );
});
