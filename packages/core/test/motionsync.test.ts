/**
 * Motion-sync settings: defaults, shapes that follow parameters and elements, unique
 * names, shape checks, and a deleted parameter taking its column along.
 */
import { describe, expect, it } from 'vitest';
import { DocView, checkInvariants } from '@mochi-maker/core';
import { fixtureSession } from './fixture.js';

const setting = (s: ReturnType<typeof fixtureSession>, name = 'Mouth') => {
  const v = new DocView(s.doc);
  return v.getAs(v.resolve(`@msync~${name}`, ['motionSyncSetting']), 'motionSyncSetting');
};

describe('motion-sync settings', () => {
  it('starts with Silence and the five vowels, the usual values, and zeros for other parameters', () => {
    const s = fixtureSession();
    s.runBatch('add', [
      {
        name: 'motionSync.addSetting',
        args: { name: 'Mouth', parameters: [{ parameter: '@param:ParamAngleX' }] },
      },
    ]);
    const m = setting(s);
    expect(m.elements.map((e) => e.id)).toEqual(['Silence', 'A', 'I', 'U', 'E', 'O']);
    expect(m.shapes).toEqual([[0], [0], [0], [0], [0], [0]]);
    expect(m).toMatchObject({
      useCase: 'Mouth',
      analysisType: 'CRI',
      sampleRate: 30,
      blendRatio: 0,
    });
    expect(checkInvariants(new DocView(s.doc))).toEqual([]);
  });

  it('starts the usual mouth parameters at typical vowel shapes', () => {
    const s = fixtureSession();
    s.runBatch('add', [
      {
        name: 'param.create',
        args: { exportId: 'ParamMouthOpenY', name: 'Mouth open', min: 0, max: 1, default: 0 },
      },
      {
        name: 'param.create',
        args: { exportId: 'ParamMouthForm', name: 'Mouth form', min: -0.5, max: 0.5, default: 0 },
      },
      {
        name: 'motionSync.addSetting',
        args: {
          name: 'Mouth',
          parameters: [
            { parameter: '@param:ParamMouthOpenY' },
            { parameter: '@param:ParamMouthForm' },
            { parameter: '@param:ParamAngleX' },
          ],
        },
      },
    ]);
    // Silence, A, I, U, E, O: open and form typical (form within its range of ±0.5), others 0.
    expect(setting(s).shapes).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0.3, 0.5, 0],
      [0.4, -0.5, 0],
      [0.6, 0.5, 0],
      [0.8, -0.5, 0],
    ]);
    // Kept values stay when the parameters and elements change.
    s.runBatch('more', [
      {
        name: 'motionSync.updateSetting',
        args: {
          target: '@msync~Mouth',
          parameters: [{ parameter: '@param:ParamMouthOpenY' }],
          elements: [{ id: 'A' }, { id: 'U' }],
        },
      },
    ]);
    expect(setting(s).shapes).toEqual([[1], [0.4]]);
    expect(checkInvariants(new DocView(s.doc))).toEqual([]);
  });

  it('keeps shape values by element and parameter when they change', () => {
    const s = fixtureSession();
    s.runBatch('add', [
      {
        name: 'motionSync.addSetting',
        args: {
          name: 'Mouth',
          parameters: [{ parameter: '@param:ParamAngleX' }],
          elements: [{ id: 'Silence' }, { id: 'A' }],
          shapes: [[0.1], [0.9]],
        },
      },
      {
        name: 'motionSync.updateSetting',
        args: {
          target: '@msync~Mouth',
          elements: [{ id: 'A' }, { id: 'O' }],
          parameters: [{ parameter: '@param:ParamEyeLOpen' }, { parameter: '@param:ParamAngleX' }],
        },
      },
    ]);
    expect(setting(s).shapes).toEqual([
      [0, 0.9],
      [0, 0],
    ]);
  });

  it('refuses a duplicate name, a mismatched shape and a doubled element', () => {
    const s = fixtureSession();
    s.runBatch('add', [{ name: 'motionSync.addSetting', args: { name: 'Mouth' } }]);
    expect(() =>
      s.runBatch('dup', [{ name: 'motionSync.addSetting', args: { name: 'Mouth' } }]),
    ).toThrow(/already named/);
    expect(() =>
      s.runBatch('shape', [
        { name: 'motionSync.updateSetting', args: { target: '@msync~Mouth', shapes: [[1]] } },
      ]),
    ).toThrow(/6 row/);
    expect(() =>
      s.runBatch('el', [
        {
          name: 'motionSync.updateSetting',
          args: { target: '@msync~Mouth', elements: [{ id: 'A' }, { id: 'A' }] },
        },
      ]),
    ).toThrow(/named twice/);
  });

  it('drops a deleted parameter and its column', () => {
    const s = fixtureSession();
    s.runBatch('add', [
      {
        name: 'motionSync.addSetting',
        args: {
          name: 'Mouth',
          parameters: [{ parameter: '@param:ParamAngleX' }, { parameter: '@param:ParamEyeLOpen' }],
          elements: [{ id: 'A' }],
          shapes: [[0.3, 0.7]],
        },
      },
      { name: 'param.delete', args: { target: '@param:ParamAngleX', cascade: true } },
    ]);
    const m = setting(s);
    expect(m.parameters).toHaveLength(1);
    expect(m.shapes).toEqual([[0.7]]);
    expect(checkInvariants(new DocView(s.doc))).toEqual([]);
  });

  it('lets a motion name a setting, and clears it when the setting goes', () => {
    const s = fixtureSession();
    s.runBatch('add', [
      {
        name: 'motionSync.addSetting',
        args: { name: 'Mouth', parameters: [{ parameter: '@param:ParamAngleX' }] },
      },
      { name: 'motion.update', args: { target: '@motion~idle', motionSync: '@msync~Mouth' } },
    ]);
    const motion = () => {
      const v = new DocView(s.doc);
      return v.getAs(v.resolve('@motion~idle', ['motion']), 'motion');
    };
    expect(motion().motionSync).toBe(setting(s).uid);
    // Renaming keeps the reference: it is by UID.
    s.runBatch('rename', [
      { name: 'motionSync.updateSetting', args: { target: '@msync~Mouth', name: 'Talk' } },
    ]);
    expect(motion().motionSync).toBe(setting(s, 'Talk').uid);
    s.runBatch('remove', [{ name: 'motionSync.removeSetting', args: { target: '@msync~Talk' } }]);
    expect(motion().motionSync).toBeNull();
    expect(checkInvariants(new DocView(s.doc))).toEqual([]);
  });
});
