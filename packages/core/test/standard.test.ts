/** The standard parameter and group IDs. */
import { describe, expect, it } from 'vitest';
import {
  STANDARD_PARAMETERS,
  STANDARD_PARAMETER_GROUPS,
  STANDARD_SECTIONS,
  caseOnlyStandard,
  standardParameter,
  standardRange,
} from '@mochi-maker/core';

describe('standard parameters', () => {
  it('has the 40 IDs (27 core, 13 optional) in 8 sections, and 20 group IDs', () => {
    expect(STANDARD_PARAMETERS).toHaveLength(40);
    expect(STANDARD_PARAMETERS.filter((p) => p.optional)).toHaveLength(13);
    expect(new Set(STANDARD_PARAMETERS.map((p) => p.id)).size).toBe(40);
    expect(new Set(STANDARD_PARAMETERS.map((p) => p.section))).toEqual(new Set(STANDARD_SECTIONS));
    for (const p of STANDARD_PARAMETERS) {
      expect(p.id, p.id).toMatch(/^Param[A-Z][A-Za-z]+$/);
      expect(p.min <= p.default && p.default <= p.max, p.id).toBe(true);
    }
    expect(STANDARD_PARAMETER_GROUPS).toHaveLength(20);
    expect(new Set(STANDARD_PARAMETER_GROUPS.map((g) => g.id)).size).toBe(20);
  });

  it('gives the usual ranges and the Eye blink and Lip sync members', () => {
    expect(standardParameter('ParamAngleX')).toMatchObject({ min: -30, default: 0, max: 30 });
    expect(standardParameter('ParamEyeLOpen')).toMatchObject({ min: 0, default: 1, max: 1 });
    expect(standardParameter('ParamBodyAngleX')).toMatchObject({ min: -10, max: 10 });
    expect(standardParameter('ParamCheek')).toMatchObject({ default: 0 });
    expect(STANDARD_PARAMETERS.filter((p) => p.group === 'eyeBlink').map((p) => p.id)).toEqual([
      'ParamEyeLOpen',
      'ParamEyeROpen',
    ]);
    expect(STANDARD_PARAMETERS.filter((p) => p.group === 'lipSync').map((p) => p.id)).toEqual([
      'ParamMouthOpenY',
    ]);
    expect(standardParameter('ParamLegL')).toBeUndefined();
  });

  it('finds IDs that differ from a standard one only by letter case', () => {
    expect(caseOnlyStandard('ParamAnglex')).toBe('ParamAngleX');
    expect(caseOnlyStandard('parameyelopen')).toBe('ParamEyeLOpen');
    expect(caseOnlyStandard('paramgroupface')).toBe('ParamGroupFace');
    expect(caseOnlyStandard('ParamAngleX')).toBeUndefined();
    expect(caseOnlyStandard('ParamTail')).toBeUndefined();
  });

  it('accepts the documented range variants, each kind, and nothing past them', () => {
    // The standard ranges themselves.
    expect(standardRange('ParamAngleX', -30, 0, 30)).toBe('standard');
    expect(standardRange('ParamTail', -1, 0, 1)).toBeUndefined();
    // A larger head turn: ±45, for ParamAngleX only.
    expect(standardRange('ParamAngleX', -45, 0, 45)).toBe('variant');
    expect(standardRange('ParamAngleX', -60, 0, 60)).toBe('other');
    expect(standardRange('ParamAngleY', -45, 0, 45)).toBe('other');
    // Arms: ±10, ±50 or ±100.
    for (const x of [10, 50, 100]) expect(standardRange('ParamArmLA', -x, 0, x)).toBe('variant');
    expect(standardRange('ParamArmRB', -100, 0, 100)).toBe('variant');
    expect(standardRange('ParamArmLA', -40, 0, 40)).toBe('other');
    expect(standardRange('ParamArmLA', -50, 0, 100)).toBe('other');
    // Eye openness extended past 0 to 1 in steps of 0.1, default 1.
    expect(standardRange('ParamEyeLOpen', 0, 1, 1.5)).toBe('variant');
    expect(standardRange('ParamEyeROpen', 0, 1, 2)).toBe('variant');
    expect(standardRange('ParamEyeLOpen', -0.5, 1, 1)).toBe('variant');
    expect(standardRange('ParamEyeLOpen', -0.5, 1, 1.2)).toBe('variant');
    expect(standardRange('ParamEyeLOpen', 0, 1, 1.55)).toBe('other');
    expect(standardRange('ParamEyeLOpen', 0, 1, 3)).toBe('other');
    expect(standardRange('ParamEyeLOpen', 0, 0, 1.5)).toBe('other');
    expect(standardRange('ParamEyeLSmile', 0, 0, 1.5)).toBe('other');
    // Mouth openness: the same, default 0.
    expect(standardRange('ParamMouthOpenY', 0, 0, 1.5)).toBe('variant');
    expect(standardRange('ParamMouthOpenY', 0, 1, 1.5)).toBe('other');
    // The eyeball size's half ranges.
    expect(standardRange('ParamEyeBallForm', -1, 0, 0)).toBe('variant');
    expect(standardRange('ParamEyeBallForm', 0, 0, 1)).toBe('variant');
    expect(standardRange('ParamEyeBallForm', -0.5, 0, 0.5)).toBe('other');
    // A changed default is never a variant.
    expect(standardRange('ParamAngleX', -45, 10, 45)).toBe('other');
    // The variants are described for agents too.
    expect(standardParameter('ParamArmLA')!.variants).toMatch(/±100/);
    expect(standardParameter('ParamAngleY')!.variants).toBeUndefined();
  });
});
