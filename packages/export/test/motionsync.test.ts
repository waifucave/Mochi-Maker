/**
 * Motion sync in the export: golden 17's settings written by Mochi2D's writeMotionSync,
 * named in the model settings, read back the same; and Mochi2D's own analysis of a synthesized «a»
 * opening the mouth through the «Mouth» setting. Also a motion's own setting, beside its sound.
 */
import { describe, expect, it } from 'vitest';
import { lint } from '@mochi-maker/core';
import { readWavInfo } from '@mochi-maker/art';
import { exportModel } from '@mochi-maker/export';
import {
  MemoryFileSource,
  ModelRuntime,
  parseModelSettings,
  parseMotionSync,
  synthesizeVowel,
} from 'mochi2d/headless';
import { golden17 } from './golden.js';

/** Mono 16-bit PCM WAV bytes. */
function wav(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + 2 * samples.length);
  const v = new DataView(out.buffer);
  const tag = (o: number, t: string) =>
    [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + 2 * samples.length, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, 2 * samples.length, true);
  samples.forEach((x, i) =>
    v.setInt16(44 + 2 * i, Math.round(Math.max(-1, Math.min(1, x)) * 32767), true),
  );
  return out;
}

/** Golden 17 with a motion «talk» that starts an «a» and names a setting (or none). */
async function talking(motionSync: string | null, sound = true) {
  const g = await golden17();
  const rate = 16000;
  const bytes = wav(synthesizeVowel([750, 1250, 2600], 1.2, rate), rate);
  const info = readWavInfo(bytes);
  const asset = await g.assets.put(bytes);
  g.session.runBatch('talk', [
    {
      name: 'sound.create',
      args: { name: 'a', asset, sampleRate: info.sampleRate, channels: 1, frames: info.frames },
    },
    { name: 'motion.create', args: { name: 'talk', group: 'Talk', duration: 1.2, fps: 30 } },
    {
      name: 'motion.update',
      args: { target: '$1', ...(sound ? { sound: '$0' } : {}), motionSync },
    },
  ]);
  return g;
}

describe('motion sync in the export', () => {
  it('writes the settings, names the file in the model settings, and reads back the same', async () => {
    const g = await golden17();
    const r = await exportModel(g.session.doc, g.assets);
    expect(r.report.problems.filter((p) => p.severity === 'error')).toEqual([]);
    const settings = parseModelSettings(
      r.files.get('golden17.model3.json')!,
      'golden17.model3.json',
    );
    expect(JSON.stringify(settings)).toContain('golden17.motionsync3.json');
    const f = parseMotionSync(r.files.get('golden17.motionsync3.json')!, 'x', { lint: true });
    expect(f.warnings).toEqual([]);
    expect(f.settings.map((s) => [s.id, s.name, s.usable])).toEqual([
      ['MotionSync1', 'Mouth', true],
      ['MotionSync2', 'Soft', true],
    ]);
    const soft = f.settings[1]!;
    expect(soft.parameters.map((p) => [p.id, p.damper, p.smooth])).toEqual([
      ['ParamMouthOpenY', 0.05, 30],
      ['ParamMouthForm', 0, 60],
    ]);
    expect(soft.elements.map((e) => [e.id, e.enabled, e.scale])).toEqual([
      ['Silence', true, 1],
      ['A', true, 1.5],
      ['O', false, 1],
    ]);
    expect(soft.shapes).toEqual([
      [0, 0],
      [0.9, 0.2],
      [0.7, -0.8],
    ]);
    expect([soft.blendRatio, soft.smoothing, soft.sampleRate]).toEqual([1, 40, 60]);
  });

  it('opens the mouth for an «a» through Mochi2D’s analysis', async () => {
    const g = await golden17();
    const r = await exportModel(g.session.doc, g.assets);
    const rt = await ModelRuntime.load(
      new MemoryFileSource('g17', r.files),
      'golden17.model3.json',
    );
    expect(rt.motionSyncSettings.map((s) => s.name)).toEqual(['Mouth', 'Soft']);
    const rate = 16000;
    // An «a»: F1 750, F2 1250, F3 2600 Hz.
    const samples = synthesizeVowel([750, 1250, 2600], 1.2, rate);
    rt.startMotionSync({ sampleRate: rate, channels: [samples] }, { setting: 'Mouth' });
    let open = 0;
    for (let i = 0; i < 60; i++) {
      rt.update(1 / 60);
      open = Math.max(open, rt.getParameter('ParamMouthOpenY'));
    }
    expect(open).toBeGreaterThan(0.5);
  });

  it('writes each parameter’s smoothing, which Mochi2D applies only with fileSmoothing', async () => {
    // Smooth 100 holds the mouth where it started; Mochi2D applies the file's smoothing only
    // when asked (fileSmoothing, off by default since 0.20.0).
    const g = await golden17();
    const mouth = g.session.view.getAs(
      g.session.view.project().motionSyncOrder[0]!,
      'motionSyncSetting',
    );
    g.session.run('motionSync.updateSetting', {
      target: mouth.uid,
      parameters: mouth.parameters.map((p) => ({ ...p, smooth: 100 })),
    });
    const r = await exportModel(g.session.doc, g.assets);
    const f = parseMotionSync(r.files.get('golden17.motionsync3.json')!, 'x');
    expect(f.settings[0]!.parameters.map((p) => p.smooth)).toEqual([100, 100]);
    const rate = 16000;
    const samples = synthesizeVowel([750, 1250, 2600], 1.2, rate);
    const opening = async (fileSmoothing?: boolean) => {
      const rt = await ModelRuntime.load(
        new MemoryFileSource('g17', r.files),
        'golden17.model3.json',
        fileSmoothing === undefined ? undefined : { animation: { motionSync: { fileSmoothing } } },
      );
      rt.startMotionSync({ sampleRate: rate, channels: [samples] }, { setting: 'Mouth' });
      let open = 0;
      for (let i = 0; i < 60; i++) {
        rt.update(1 / 60);
        open = Math.max(open, rt.getParameter('ParamMouthOpenY'));
      }
      return open;
    };
    expect(await opening()).toBeGreaterThan(0.5);
    expect(await opening(false)).toBeGreaterThan(0.5);
    expect(await opening(true)).toBeLessThan(0.01);
  });

  it('names a motion’s setting beside its sound, and plays the sound through it', async () => {
    const g = await talking('@msync~Soft');
    const r = await exportModel(g.session.doc, g.assets);
    expect(r.report.problems.filter((p) => p.severity === 'error')).toEqual([]);
    const raw = JSON.parse(new TextDecoder().decode(r.files.get('golden17.model3.json')!));
    expect(raw.FileReferences.Motions.Talk).toEqual([
      { File: 'motions/talk.motion3.json', Sound: 'sounds/a.wav', MotionSync: 'Soft' },
    ]);
    const settings = parseModelSettings(r.files.get('golden17.model3.json')!, 'x');
    expect(settings.motions[0]!.entries[0]!.motionSync).toBe('Soft');
    // Mochi2D starts the motion with its sound, and the sound moves the mouth through «Soft».
    const rt = await ModelRuntime.load(
      new MemoryFileSource('g17', r.files),
      'golden17.model3.json',
    );
    expect(await rt.startMotion('Talk', 0)).not.toBe(false);
    let open = 0;
    let through = '';
    for (let i = 0; i < 60; i++) {
      rt.update(1 / 60);
      open = Math.max(open, rt.getParameter('ParamMouthOpenY'));
      through ||= rt.motionSync?.setting.name ?? '';
    }
    expect(through).toBe('Soft');
    expect(open).toBeGreaterThan(0.3);
  });

  it('leaves out a setting without a sound, with a lint warning', async () => {
    const g = await talking('@msync~Mouth', false);
    expect(lint(g.session.view).map((x) => x.rule)).toContain('motion-sync-without-sound');
    const r = await exportModel(g.session.doc, g.assets);
    expect(r.report.problems.filter((p) => p.severity === 'error')).toEqual([]);
    const raw = JSON.parse(new TextDecoder().decode(r.files.get('golden17.model3.json')!));
    expect(raw.FileReferences.Motions.Talk).toEqual([{ File: 'motions/talk.motion3.json' }]);
    expect(r.report.problems.map((p) => p.code)).toContain('motion-sync-without-sound');
  });
});
