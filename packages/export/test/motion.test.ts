/**
 * M10, motions, headless: golden 12 exported and run in Mochi2D's animation scenarios, compared
 * with values computed from the rules of §3: curve evaluation (3k), playback (3l), the model opacity
 * (3u), events, looping (3l.5), idle playback (3l.7), and a pose driven by part-opacity curves
 * (3l.3 step g, 3o).
 */
import { describe, expect, it } from 'vitest';
import { exportModel, type ExportResult } from '@mochi-maker/export';
import { keysToCurve, sampleSegments, type MotionKey } from '@mochi-maker/core';
import {
  loadMoc,
  parseModelSettings,
  parseMotion,
  runAnimationScenarioReport,
  type ScenarioCommand,
} from 'mochi2d/headless';
import { golden12, golden13, squareWav } from './golden.js';

const E = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));
const IDS = ['P_Linear', 'P_Step', 'P_Bez', 'P_Fade', 'P_Loop', 'P_BezR'];

let exported: Promise<ExportResult> | undefined;
const result = () => (exported ??= golden12().then((g) => exportModel(g.session.doc, g.assets)));

async function run(
  steps: number[],
  commands: { frame: number; command: ScenarioCommand }[],
  options: { idle?: boolean; random?: number[] } = {},
) {
  const r = await result();
  const report = runAnimationScenarioReport({
    model: loadMoc(r.files.get('golden12.moc3')!),
    settings: parseModelSettings(r.files.get('golden12.model3.json')!, 'golden12.model3.json'),
    files: r.files,
    steps,
    commands,
    random: options.random,
    effects: {
      eyeBlink: false,
      breath: false,
      look: false,
      lipSync: false,
      physics: false,
      idle: options.idle ?? false,
    },
    record: { freeValues: ['Part_Open', 'Part_Closed'] },
  });
  expect(report.warnings).toEqual([]);
  return {
    report,
    frames: report.frames.map((f) => ({
      p: Object.fromEntries(IDS.map((id, i) => [id, f.parameters[i]!])) as Record<string, number>,
      opacity: Array.from(f.partOpacities),
      free: f.freeValues,
      model: f.modelOpacity,
      events: f.events,
    })),
  };
}

/** Linear interpolation through points, held at the ends. */
function linear(points: [number, number][], t: number): number {
  for (let i = 1; i < points.length; i++)
    if (t < points[i]![0]) {
      const [t0, v0] = points[i - 1]!;
      const [t1, v1] = points[i]!;
      return v0 + ((v1 - v0) * Math.max(0, t - t0)) / (t1 - t0);
    }
  return points[points.length - 1]![1];
}

/** The Bézier value by repeated linear interpolation (3k.1). */
function bezierValue(v: [number, number, number, number], s: number): number {
  const l = (a: number, b: number) => a + (b - a) * s;
  const [q1, q2, q3] = [l(v[0], v[1]), l(v[1], v[2]), l(v[2], v[3])];
  return l(l(q1, q2), l(q2, q3));
}

/** Solved mode (3k.3) for a monotonic time polynomial: the root of t(s) = τ, by bisection. */
function solve(t: [number, number, number, number], tau: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bezierValue(t, mid) < tau) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe('golden 12: motion files', () => {
  it('writes the curves in Model, Parameter, PartOpacity order, with exact counts', async () => {
    const r = await result();
    const settings = JSON.parse(new TextDecoder().decode(r.files.get('golden12.model3.json')));
    expect(settings.FileReferences.Motions).toEqual({
      TapBody: [{ File: 'motions/curves.motion3.json' }],
      TapHead: [{ File: 'motions/close.motion3.json' }],
      Idle: [{ File: 'motions/loop.motion3.json' }],
    });
    const curves = JSON.parse(new TextDecoder().decode(r.files.get('motions/curves.motion3.json')));
    expect(curves.Meta).toMatchObject({
      Duration: 2,
      Fps: 8,
      Loop: false,
      AreBeziersRestricted: false,
      CurveCount: 5,
      TotalSegmentCount: 1 + 2 + 2 + 2 + 1,
      TotalPointCount: 2 + 3 + 3 + 5 + 2,
      UserDataCount: 2,
      TotalUserDataSize: 8,
      FadeInTime: 0,
      FadeOutTime: 0,
    });
    expect(curves.Curves.map((c: { Target: string; Id: string }) => `${c.Target}:${c.Id}`)).toEqual(
      [
        'Model:Opacity',
        'Parameter:P_Linear',
        'Parameter:P_Step',
        'Parameter:P_Bez',
        'Parameter:P_Fade',
      ],
    );
    expect(curves.Curves[4].FadeInTime).toBe(1);
    expect(curves.UserData).toEqual([
      { Time: 0.5, Value: 'half' },
      { Time: 1.5, Value: 'late' },
    ]);
    const loop = JSON.parse(new TextDecoder().decode(r.files.get('motions/loop.motion3.json')));
    expect(loop.Meta).toMatchObject({ Loop: true, AreBeziersRestricted: true, Fps: 8 });
    for (const f of ['curves', 'close', 'loop'])
      expect(() => parseMotion(r.files.get(`motions/${f}.motion3.json`)!, f)).not.toThrow();
  });
});

describe('Auto smooth', () => {
  it('exports as the Bézier it is stored as, with right counts, and Mochi2D plays it so', async () => {
    const g = await golden12();
    const keys: MotionKey[] = [
      { time: 0, value: 0, interp: 'auto' },
      { time: 0.75, value: 60, interp: 'auto' },
      { time: 1.25, value: 20, interp: 'linear' },
      { time: 2, value: -40, interp: 'linear' },
    ];
    g.session.transact('auto', (tx) =>
      tx.run('motion.setKeys', {
        target: '@motion~curves',
        curve: { target: 'parameter', object: '@param:P_Linear' },
        keys,
      }),
    );
    const r = await exportModel(g.session.doc, g.assets);
    const file = r.files.get('motions/curves.motion3.json')!;
    const json = JSON.parse(new TextDecoder().decode(file));
    const lin = json.Curves.find((c: { Id: string }) => c.Id === 'P_Linear');
    const { segments } = keysToCurve(keys);
    expect(lin.Segments).toEqual(segments);
    // Two Bézier segments (Auto smooth) and one linear: 3 segments, 1 + 3 + 3 + 1 points.
    expect(segments.filter((_, i) => i === 2 || i === 9 || i === 16)).toEqual([1, 1, 0]);
    expect(json.Meta).toMatchObject({
      TotalSegmentCount: 1 + 2 + 2 + 3 + 1,
      TotalPointCount: 2 + 3 + 5 + 8 + 2,
    });
    expect(() => parseMotion(file, 'curves')).not.toThrow();
    const report = runAnimationScenarioReport({
      model: loadMoc(r.files.get('golden12.moc3')!),
      settings: parseModelSettings(r.files.get('golden12.model3.json')!, 'golden12.model3.json'),
      files: r.files,
      steps: Array(20).fill(0.125),
      commands: [
        { frame: 0, command: { kind: 'startMotion', group: 'TapBody', index: 0, priority: 2 } },
      ],
      effects: {
        eyeBlink: false,
        breath: false,
        look: false,
        lipSync: false,
        physics: false,
        idle: false,
      },
    });
    report.frames.forEach((f, j) => {
      const tau = Math.min(j * 0.125, 2);
      expect(f.parameters[0], `P_Linear at ${tau}`).toBeCloseTo(sampleSegments(segments, tau), 4);
      // Never above the peak key, nor below the valley one.
      expect(f.parameters[0]!).toBeLessThanOrEqual(60 + 1e-6);
    });
  });
});

describe('golden 12 in Mochi2D animation scenarios', () => {
  it('evaluates linear, stepped, inverse-stepped and Bézier curves, fades, opacity and events', async () => {
    const dt = 0.125;
    const { frames } = await run(Array(20).fill(dt), [
      { frame: 0, command: { kind: 'startMotion', group: 'TapBody', index: 0, priority: 2 } },
    ]);
    let fade = 0;
    frames.forEach((f, j) => {
      // The local clock starts at the end of the first frame that processes the motion (3l.3 a),
      // so frame j shows τ = jΔ; the motion ends at τ = 2 and its values persist (3l.6).
      const tau = Math.min(j * dt, 2);
      expect(f.p.P_Linear, `P_Linear at ${tau}`).toBeCloseTo(
        linear(
          [
            [0, 0],
            [1, 20],
            [2, -10],
          ],
          tau,
        ),
        4,
      );
      // Stepped (0,0)→(0.5,5) gives 0 before 0.5; inverse stepped (0.5,5)→(1.5,8) gives 8 from 0.5.
      expect(f.p.P_Step, `P_Step at ${tau}`).toBe(tau < 0.5 ? 0 : 8);
      const bez = tau < 1 ? bezierValue([0, 10, 30, 40], solve([0, 0.25, 0.75, 1], tau)) : 40;
      expect(f.p.P_Bez, `P_Bez at ${tau}`).toBeCloseTo(bez, 4);
      // P_Fade's own 1 s fade-in: each frame closes E(jΔ) of the remaining distance to 50.
      if (j * dt <= 2) fade = fade + (50 - fade) * E(j * dt);
      expect(f.p.P_Fade, `P_Fade at ${tau}`).toBeCloseTo(fade, 3);
      expect(f.model).toBeCloseTo(1 - 0.25 * tau, 6);
      // Events fire when τ passes their time: T_prev − s < t ≤ T − s.
      expect(f.events).toEqual(j === 4 ? ['half'] : j === 12 ? ['late'] : []);
    });
  });

  it('drives the pose through part-opacity curves, as genuine models do', async () => {
    const { frames } = await run(Array(12).fill(0.125), [
      { frame: 0, command: { kind: 'startMotion', group: 'TapHead', index: 0, priority: 2 } },
    ]);
    frames.forEach((f, j) => {
      const switched = j * 0.125 >= 1;
      // The curves write the values named by the part IDs (free values); the pose (fade 0) shows
      // the first entry whose value exceeds 0.001.
      expect(f.free).toEqual({ Part_Open: switched ? 0 : 1, Part_Closed: switched ? 1 : 0 });
      expect(f.opacity, `frame ${j}`).toEqual(switched ? [0, 1] : [1, 0]);
    });
  });

  it('loops with the end interval and the strict wrap test (3l.5)', async () => {
    const dt = 0.0625;
    const L = 1 + 1 / 8;
    const { frames } = await run(Array(48).fill(dt), [
      {
        frame: 0,
        command: { kind: 'startMotion', group: 'Idle', index: 0, priority: 2, loop: true },
      },
    ]);
    let T = 0;
    let s = 0;
    let wraps = 0;
    let previous = -1;
    frames.forEach((f, j) => {
      T += dt;
      if (j === 0) s = T;
      let tau = Math.max(0, T - s);
      while (tau > L) tau -= L;
      if (tau < previous) wraps++;
      previous = tau;
      let loop: number;
      let bez: number;
      if (tau < 1) {
        loop = 10 * tau;
        bez = bezierValue([0, 30, -10, 10], tau); // restricted mode: s = τ/1
      } else if (tau < L) {
        // The end interval joins (1, 10) to (L, first value 0) linearly (3k.2).
        loop = bez = 10 - (10 * (tau - 1)) / (L - 1);
      } else loop = bez = 10; // τ = L exactly: the last value, for that one frame
      expect(f.p.P_Loop, `P_Loop frame ${j}, τ ${tau}`).toBeCloseTo(loop, 4);
      expect(f.p.P_BezR, `P_BezR frame ${j}, τ ${tau}`).toBeCloseTo(bez, 4);
      if (T - s >= L) s = T - tau; // restart (3l.3 h)
    });
    // Three seconds at a loop length of 1.125 s: two wraps.
    expect(wraps).toBe(2);
  });

  it('plays the Idle group when the queue is empty (3l.7)', async () => {
    const { frames, report } = await run(Array(5).fill(0.125), [], { idle: true, random: [0, 0] });
    expect(report.starts[0]).toMatchObject({ frame: 0, idle: 0, started: true });
    // Started at frame 0, first processed at frame 1 (τ = 0), then τ advances by Δ.
    expect(frames.map((f) => f.p.P_Loop)).toEqual([0, 0, 1.25, 2.5, 3.75]);
  });
});

describe('golden 13: a motion with a sound', () => {
  it('exports the WAV, references it from the motion entry, and lip sync follows it', async () => {
    const g = await golden13();
    const r = await exportModel(g.session.doc, g.assets);
    const settings = JSON.parse(new TextDecoder().decode(r.files.get('golden13.model3.json')));
    expect(settings.FileReferences.Motions).toEqual({
      TapBody: [{ File: 'motions/talk.motion3.json', Sound: 'sounds/voice.wav' }],
    });
    expect(
      Buffer.from(r.files.get('sounds/voice.wav')!).equals(Buffer.from(squareWav(0.5, 1))),
    ).toBe(true);
    expect(r.report.counts.sounds).toBe(1);

    const report = runAnimationScenarioReport({
      model: loadMoc(r.files.get('golden13.moc3')!),
      settings: parseModelSettings(r.files.get('golden13.model3.json')!, 'golden13.model3.json'),
      files: r.files,
      steps: Array(20).fill(1 / 30),
      commands: [
        { frame: 0, command: { kind: 'startMotion', group: 'TapBody', index: 0, priority: 2 } },
      ],
      effects: {
        eyeBlink: false,
        breath: false,
        look: false,
        idle: false,
        physics: false,
        lipSync: true,
      },
    });
    expect(report.warnings).toEqual([]);
    const mouth = report.frames.map((f) => f.parameters[0]!);
    // The sound's RMS is 0.5: once the analysis window is full, the mouth opens by 0.5 (3s.2).
    for (const v of mouth.slice(5)) expect(v).toBeCloseTo(0.5, 2);
    expect(report.frames.slice(5).every((f) => f.lipSync !== null)).toBe(true);
  });
});
