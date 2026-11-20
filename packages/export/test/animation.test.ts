/**
 * M9, headless: golden 11's expressions, pose and physics, exported and run in Mochi2D's animation
 * scenarios (§3w), compared with values computed by hand from the rules of §3:
 * - expressions (3m): one entry's value is (O + A)·M written with weight S = E(t / fade-in); a newer
 *   entry with fade-in 0 replaces it at once, and an overwrite does not cross-fade;
 * - pose (3o): the visible entry fades in by Δ/F per frame; the others are capped by 1 − o, raised
 *   to 1 − 0.15/(1 − o) while (1 − a)(1 − o) > 0.15; links copy their entry;
 * - physics (3n): checked by behavior: the pendulum swings away from rest and settles, the output
 *   is marked physics-driven, and runs are deterministic.
 */
import { describe, expect, it } from 'vitest';
import { exportModel, type ExportResult } from '@mochi-maker/export';
import {
  MemoryFileSource,
  ModelRuntime,
  loadMoc,
  parseExpression,
  parsePhysics,
  parsePose,
  parseModelSettings,
  runAnimationScenarioReport,
  type ScenarioCommand,
} from 'mochi2d/headless';
import { golden11 } from './golden.js';

const E = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));
const OFF = { eyeBlink: false, breath: false, look: false, idle: false, lipSync: false };

let exported: Promise<ExportResult> | undefined;
const result = () => (exported ??= golden11().then((g) => exportModel(g.session.doc, g.assets)));

async function scenario(
  steps: number[],
  commands: { frame: number; command: ScenarioCommand }[] = [],
  effects: Record<string, boolean> = {},
) {
  const r = await result();
  const report = runAnimationScenarioReport({
    model: loadMoc(r.files.get('golden11.moc3')!),
    settings: parseModelSettings(r.files.get('golden11.model3.json')!, 'golden11.model3.json'),
    files: r.files,
    steps,
    commands,
    effects: { ...OFF, ...effects },
  });
  expect(report.warnings).toEqual([]);
  const ids = ['ParamA', 'ParamB', 'ParamC', 'ParamIn', 'ParamOut', 'PartArmA', 'PartArmB'];
  const parts = ['PartArmA', 'PartArmB', 'PartArmLink'];
  return report.frames.map((f) => ({
    p: Object.fromEntries(ids.map((id, i) => [id, f.parameters[i]!])) as Record<string, number>,
    o: Object.fromEntries(parts.map((id, i) => [id, f.partOpacities[i]!])) as Record<
      string,
      number
    >,
  }));
}

describe('golden 11: the files', () => {
  it('writes expressions, pose and physics, referenced from the settings, and Mochi2D reads them', async () => {
    const r = await result();
    const settings = JSON.parse(new TextDecoder().decode(r.files.get('golden11.model3.json')));
    expect(settings.FileReferences).toMatchObject({
      Physics: 'golden11.physics3.json',
      Pose: 'golden11.pose3.json',
      Expressions: [
        { Name: 'smile', File: 'expressions/smile.exp3.json' },
        { Name: 'frown', File: 'expressions/frown.exp3.json' },
      ],
    });
    const smile = JSON.parse(new TextDecoder().decode(r.files.get('expressions/smile.exp3.json')));
    expect(smile).toEqual({
      Type: 'Live2D Expression',
      FadeInTime: 0.5,
      FadeOutTime: 0.5,
      Parameters: [
        { Id: 'ParamA', Value: 4, Blend: 'Add' },
        { Id: 'ParamB', Value: 1.5, Blend: 'Multiply' },
        { Id: 'ParamC', Value: 7, Blend: 'Overwrite' },
      ],
    });
    const pose = JSON.parse(new TextDecoder().decode(r.files.get('golden11.pose3.json')));
    expect(pose).toEqual({
      Type: 'Live2D Pose',
      FadeInTime: 0.5,
      Groups: [
        [
          { Id: 'PartArmA', Link: ['PartArmLink'] },
          { Id: 'PartArmB', Link: [] },
        ],
      ],
    });
    const physics = JSON.parse(new TextDecoder().decode(r.files.get('golden11.physics3.json')));
    expect(physics.Meta).toMatchObject({
      PhysicsSettingCount: 1,
      TotalInputCount: 1,
      TotalOutputCount: 1,
      VertexCount: 2,
    });
    expect(physics.PhysicsSettings[0].Output[0]).toMatchObject({
      Destination: { Target: 'Parameter', Id: 'ParamOut' },
      VertexIndex: 1,
      Type: 'Angle',
    });
    expect(() =>
      parseExpression(r.files.get('expressions/smile.exp3.json')!, 'smile'),
    ).not.toThrow();
    expect(() => parsePose(r.files.get('golden11.pose3.json')!, 'pose')).not.toThrow();
    expect(() => parsePhysics(r.files.get('golden11.physics3.json')!, 'physics')).not.toThrow();
  });
});

describe('golden 11 in Mochi2D animation scenarios', () => {
  it('expressions fade in, blend by Add, Multiply and Overwrite, and give way to a newer one', async () => {
    const dt = 0.1;
    const frames = await scenario(Array(12).fill(dt), [
      { frame: 0, command: { kind: 'startExpression', name: 'smile' } },
      { frame: 8, command: { kind: 'startExpression', name: 'frown' } },
    ]);
    frames.forEach(({ p }, n) => {
      if (n < 8) {
        // One entry: S = E(n·Δ / 0.5); defaults A = 0, B = 1, C = 0.
        const S = E((n * dt) / 0.5);
        expect(p.ParamA, `frame ${n}`).toBeCloseTo(4 * S, 5);
        expect(p.ParamB, `frame ${n}`).toBeCloseTo(1 + 0.5 * S, 5);
        expect(p.ParamC, `frame ${n}`).toBeCloseTo(7 * S, 5);
      } else {
        // frown (fade-in 0) has weight 1 at once: A = −2, M = 1, and O is the current value.
        expect([p.ParamA, p.ParamB, p.ParamC]).toEqual([-2, 1, 0]);
      }
    });
  });

  it('the pose fades the visible entry in, caps the others, and links follow', async () => {
    const dt = 0.1;
    const frames = await scenario(Array(8).fill(dt));
    // Frame 0 sets up: the first entry is shown.
    expect(frames[0]!.o).toEqual({ PartArmA: 1, PartArmB: 0, PartArmLink: 1 });
    let a = 1;
    let b = 0;
    for (let n = 1; n < frames.length; n++) {
      // PartArmB's value is 1 (its parameter's default), PartArmA's 0: B is the visible entry.
      b = Math.min(1, b + dt / 0.5);
      let cap = 1 - b;
      if ((1 - cap) * (1 - b) > 0.15) cap = 1 - 0.15 / (1 - b);
      a = Math.min(a, cap);
      const o = frames[n]!.o;
      expect(o.PartArmB, `frame ${n}`).toBeCloseTo(b, 5);
      expect(o.PartArmA, `frame ${n}`).toBeCloseTo(a, 5);
      expect(o.PartArmLink).toBe(o.PartArmA);
    }
    expect(frames.slice(1, 6).map((f) => Number(f.o.PartArmA!.toFixed(4)))).toEqual([
      0.8125, 0.75, 0.625, 0.25, 0,
    ]);
  });

  it('physics swings the output away from rest and settles, deterministically', async () => {
    const steps = Array(240).fill(1 / 60);
    const frames = await scenario(steps);
    const run = async () => (await scenario(steps)).map((f) => f.p.ParamOut!);
    const out = frames.map((f) => f.p.ParamOut!);
    expect(await run()).toEqual(out);
    const peak = Math.max(...out.slice(0, 60).map(Math.abs));
    expect(peak).toBeGreaterThan(0.05);
    const tail = Math.max(...out.slice(200).map(Math.abs));
    expect(tail).toBeLessThan(peak / 10);
    // ParamIn is the input only; physics never writes it.
    expect(new Set(frames.map((f) => f.p.ParamIn))).toEqual(new Set([5]));
    const r = await result();
    const model = await ModelRuntime.load(
      new MemoryFileSource('g', r.files),
      'golden11.model3.json',
    );
    expect([...model.physicsDriven.keys()]).toContain('ParamOut');
  });

  it('switches off: without physics the output keeps its default', async () => {
    const out = (await scenario(Array(30).fill(1 / 60), [], { physics: false })).map(
      (f) => f.p.ParamOut!,
    );
    expect(new Set(out)).toEqual(new Set([0]));
  });
});
