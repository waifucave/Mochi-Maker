/**
 * Feature flags: glue and blend-shape authoring are off unless switched on. With a flag off, the
 * commands that create or edit them refuse with E_FEATURE_OFF, `describe` says they are not
 * available, a document that holds them still opens and everything else in it works, and removing
 * them stays possible. (The other tests run with both flags on.)
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_FEATURES,
  DocView,
  MochiError,
  NO_FEATURES,
  Session,
  checkInvariants,
  describeCommand,
  listCommands,
  parseFeatures,
} from '@mochi-maker/core';
import { fixtureSession } from './fixture.js';

const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return { code: (e as MochiError).code, message: (e as MochiError).message };
  }
  throw new Error('expected a refusal');
};

describe('feature flags', () => {
  it('reads the flags from a list or the environment, and defaults to off', () => {
    expect(parseFeatures('glue, blendShapes')).toEqual(ALL_FEATURES);
    expect(parseFeatures('all')).toEqual(ALL_FEATURES);
    expect(parseFeatures('glue')).toEqual({ glue: true, blendShapes: false });
    expect(parseFeatures('')).toEqual(NO_FEATURES);
    expect(parseFeatures(undefined)).toEqual(NO_FEATURES);
    // The test environment switches both on (vitest.config.ts); a session can still say otherwise.
    expect(Session.create().features).toEqual(ALL_FEATURES);
    expect(Session.create(undefined, { features: NO_FEATURES }).features).toEqual(NO_FEATURES);
  });

  it('glue off: creating or editing glue is refused; the rest works, and glue can be deleted', () => {
    const s = fixtureSession();
    s.features = { glue: false, blendShapes: true };
    const r = refusal(() =>
      s.run('glue.create', {
        meshA: '@mesh:ArtMesh_Face',
        meshB: '@mesh:ArtMesh_Neck',
        pairs: [[0, 0.5, 3, 0.5]],
      } as never),
    );
    expect(r).toEqual({ code: 'E_FEATURE_OFF', message: 'Glue is not available in this build.' });
    expect(
      refusal(() => s.run('glue.setPairs', { target: '@glue:Glue_Neck', pairs: [] } as never)).code,
    ).toBe('E_FEATURE_OFF');
    // Editing a glue through a general command (its keyform, its name) is refused as well.
    expect(
      refusal(() =>
        s.run('keyform.set', {
          target: '@glue:Glue_Neck',
          all: true,
          values: { intensity: 0.5 },
        } as never),
      ).code,
    ).toBe('E_FEATURE_OFF');
    expect(
      refusal(() => s.run('object.rename', { target: '@glue:Glue_Neck', name: 'x' } as never)).code,
    ).toBe('E_FEATURE_OFF');
    // Everything else in the document works.
    s.run('object.rename', { target: '@mesh:ArtMesh_Face', name: 'Face 2' } as never);
    expect(
      new DocView(s.doc).getAs(
        new DocView(s.doc).resolve('@mesh:ArtMesh_Face', ['artMesh']),
        'artMesh',
      ).name,
    ).toBe('Face 2');
    // describe says so.
    expect(describeCommand('glue.create', [], s.features)).toMatchObject({
      available: false,
      summary: expect.stringMatching(/^Not available in this build\. /),
    });
    expect(describeCommand('glue.create', [], s.features).errors.map((e) => e.code)).toContain(
      'E_FEATURE_OFF',
    );
    expect(listCommands([], s.features).find((c) => c.name === 'glue.setPairs')!.available).toBe(
      false,
    );
    expect(describeCommand('glue.create', [], ALL_FEATURES).available).toBeUndefined();
    // Deleting the glue stays possible.
    s.run('glue.delete', { target: '@glue:Glue_Neck' } as never);
    expect(new DocView(s.doc).ofKind('glue')).toHaveLength(0);
    expect(checkInvariants(new DocView(s.doc))).toEqual([]);
  });

  it('blend shapes off: adding or editing them is refused; the rest works, and removing works', () => {
    const s = fixtureSession();
    s.runBatch('smile', [
      {
        name: 'param.create',
        args: { exportId: 'ParamSmile', type: 'blendShape', min: 0, max: 1, default: 0 },
      },
      {
        name: 'blendShape.add',
        args: { target: '@mesh:ArtMesh_Face', parameter: '@param:ParamSmile' },
      },
    ]);
    s.features = { glue: true, blendShapes: false };
    const off = { code: 'E_FEATURE_OFF', message: 'Blend shapes are not available in this build.' };
    expect(
      refusal(() =>
        s.run('blendShape.add', {
          target: '@mesh:ArtMesh_Neck',
          parameter: '@param:ParamSmile',
        } as never),
      ),
    ).toEqual(off);
    expect(
      refusal(() =>
        s.run('param.create', {
          exportId: 'ParamWink',
          type: 'blendShape',
          min: 0,
          max: 1,
          default: 0,
        } as never),
      ),
    ).toEqual(off);
    expect(
      refusal(() =>
        s.run('param.update', { target: '@param:ParamAngleX', type: 'blendShape' } as never),
      ),
    ).toEqual(off);
    // A normal parameter, and everything else, still work.
    s.run('param.create', { exportId: 'ParamWink', min: 0, max: 1, default: 0 } as never);
    expect(describeCommand('blendShape.add', [], s.features).available).toBe(false);
    // Removing the blend shape stays possible.
    s.run('blendShape.remove', {
      target: '@mesh:ArtMesh_Face',
      parameter: '@param:ParamSmile',
    } as never);
    expect(checkInvariants(new DocView(s.doc))).toEqual([]);
  });
});
