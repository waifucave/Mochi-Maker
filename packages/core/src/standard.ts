/**
 * The standard parameter and parameter-group IDs: the usual parameter IDs of models made with
 * Live2D Cubism, with their usual ranges. Mochi Maker offers them so that motions, face tracking
 * and apps' automatic setup (VTube Studio's Auto-Setup among them) work with a model made here.
 *
 * Conventions: for eyes and mouth 0 is closed and 1 normally open; «right» is the screen's right
 * as the viewer sees it; positive X turns or moves toward screen right, positive Y goes up.
 */

export type StandardSection =
  'Head' | 'Eyes' | 'Eyeballs' | 'Brows' | 'Mouth and cheeks' | 'Body' | 'Arms and hands' | 'Hair';

export interface StandardParameter {
  id: string;
  name: string;
  min: number;
  default: number;
  max: number;
  section: StandardSection;
  /** Usually added only when the model needs it. */
  optional: boolean;
  meaning: string;
  /** The standard group apps drive it through, when it is the usual member of one. */
  group?: 'eyeBlink' | 'lipSync';
  /** Other ranges that are also usual for it, in words. */
  variants?: string;
}

const p = (
  section: StandardSection,
  id: string,
  name: string,
  [min, def, max]: [number, number, number],
  meaning: string,
  extra: { optional?: boolean; group?: 'eyeBlink' | 'lipSync' } = {},
): StandardParameter => ({
  id,
  name,
  min,
  default: def,
  max,
  section,
  optional: extra.optional ?? false,
  meaning,
  ...(extra.group ? { group: extra.group } : {}),
});
const OPT = { optional: true };

const BASE: readonly StandardParameter[] = [
  p(
    'Head',
    'ParamAngleX',
    'Angle X',
    [-30, 0, 30],
    'Head turn; positive faces screen right. ±45 for larger turns.',
  ),
  p('Head', 'ParamAngleY', 'Angle Y', [-30, 0, 30], 'Head tilt up and down; positive looks up.'),
  p(
    'Head',
    'ParamAngleZ',
    'Angle Z',
    [-30, 0, 30],
    'Head roll; positive leans toward screen right.',
  ),
  p(
    'Eyes',
    'ParamEyeLOpen',
    'Left eye open',
    [0, 1, 1],
    'Left eye openness: 0 closed, 1 normally open; the range may extend past 0 to 1.',
    { group: 'eyeBlink' },
  ),
  p('Eyes', 'ParamEyeLSmile', 'Left eye smile', [0, 0, 1], "The left eye's smiling shape."),
  p('Eyes', 'ParamEyeROpen', 'Right eye open', [0, 1, 1], 'Right eye openness, as the left.', {
    group: 'eyeBlink',
  }),
  p('Eyes', 'ParamEyeRSmile', 'Right eye smile', [0, 0, 1], "The right eye's smiling shape."),
  p(
    'Eyeballs',
    'ParamEyeBallX',
    'Eyeball X',
    [-1, 0, 1],
    'Gaze left and right; positive looks toward screen right.',
  ),
  p('Eyeballs', 'ParamEyeBallY', 'Eyeball Y', [-1, 0, 1], 'Gaze up and down; positive looks up.'),
  p(
    'Eyeballs',
    'ParamEyeBallForm',
    'Eyeball size',
    [-1, 0, 1],
    'Pupil or iris size: −1 smaller, 0 normal, 1 larger.',
    OPT,
  ),
  p('Brows', 'ParamBrowLY', 'Left brow up/down', [-1, 0, 1], 'Raises the left brow when positive.'),
  p(
    'Brows',
    'ParamBrowRY',
    'Right brow up/down',
    [-1, 0, 1],
    'Raises the right brow when positive.',
  ),
  p(
    'Brows',
    'ParamBrowLX',
    'Left brow left/right',
    [-1, 0, 1],
    'Horizontal position; negative draws the brows toward the middle.',
  ),
  p(
    'Brows',
    'ParamBrowRX',
    'Right brow left/right',
    [-1, 0, 1],
    'As the left; negative draws toward the middle.',
  ),
  p(
    'Brows',
    'ParamBrowLAngle',
    'Left brow angle',
    [-1, 0, 1],
    'Tilt; negative gives an angry slant.',
  ),
  p('Brows', 'ParamBrowRAngle', 'Right brow angle', [-1, 0, 1], 'Tilt, as the left.'),
  p('Brows', 'ParamBrowLForm', 'Left brow shape', [-1, 0, 1], 'Shape; negative looks angry.'),
  p('Brows', 'ParamBrowRForm', 'Right brow shape', [-1, 0, 1], 'Shape, as the left.'),
  p(
    'Mouth and cheeks',
    'ParamMouthForm',
    'Mouth shape',
    [-1, 0, 1],
    'Positive smiles, negative frowns.',
  ),
  p(
    'Mouth and cheeks',
    'ParamMouthOpenY',
    'Mouth open',
    [0, 0, 1],
    'Mouth openness: 0 closed; the maximum may go to about 1.5. The usual lip-sync target.',
    { group: 'lipSync' },
  ),
  p(
    'Mouth and cheeks',
    'ParamCheek',
    'Cheek',
    [0, 0, 1],
    'Blush; positive blushes. The default is up to the model; 0 here.',
  ),
  p('Body', 'ParamBodyAngleX', 'Body X', [-10, 0, 10], 'Body turn; positive toward screen right.'),
  p('Body', 'ParamBodyAngleY', 'Body Y', [-10, 0, 10], 'Body up and down; positive upward.'),
  p('Body', 'ParamBodyAngleZ', 'Body Z', [-10, 0, 10], 'Body lean; positive toward screen right.'),
  p('Body', 'ParamBreath', 'Breath', [0, 0, 1], 'Breathing; positive is breathing in.'),
  p(
    'Body',
    'ParamShoulderY',
    'Shoulders',
    [-10, 0, 10],
    'Shrug; positive raises the shoulders.',
    OPT,
  ),
  p(
    'Body',
    'ParamBustX',
    'Bust sway X',
    [-1, 0, 1],
    'Chest sway, usually physics-driven; positive toward screen right.',
    OPT,
  ),
  p(
    'Body',
    'ParamBustY',
    'Bust sway Y',
    [-1, 0, 1],
    'Chest sway up and down; positive upward.',
    OPT,
  ),
  p(
    'Body',
    'ParamBaseX',
    'Whole-model X',
    [-10, 0, 10],
    'Moves the whole figure; positive toward screen right.',
    OPT,
  ),
  p(
    'Body',
    'ParamBaseY',
    'Whole-model Y',
    [-10, 0, 10],
    'Moves the whole figure; positive upward.',
    OPT,
  ),
  p(
    'Arms and hands',
    'ParamArmLA',
    'Left arm A',
    [-30, 0, 30],
    'First left-arm movement; positive spreads the arm. Wider or narrower ranges suit some motions.',
    OPT,
  ),
  p(
    'Arms and hands',
    'ParamArmRA',
    'Right arm A',
    [-30, 0, 30],
    'First right-arm movement, as the left.',
    OPT,
  ),
  p(
    'Arms and hands',
    'ParamArmLB',
    'Left arm B',
    [-30, 0, 30],
    'Second left-arm movement (another pose set); positive spreads.',
    OPT,
  ),
  p(
    'Arms and hands',
    'ParamArmRB',
    'Right arm B',
    [-30, 0, 30],
    'Second right-arm movement, as the left.',
    OPT,
  ),
  p('Arms and hands', 'ParamHandL', 'Left hand', [-10, 0, 10], 'Left hand deformation.', OPT),
  p('Arms and hands', 'ParamHandR', 'Right hand', [-10, 0, 10], 'Right hand deformation.', OPT),
  p(
    'Hair',
    'ParamHairFront',
    'Front hair sway',
    [-1, 0, 1],
    'Usually driven by physics; positive toward screen right.',
  ),
  p(
    'Hair',
    'ParamHairSide',
    'Side hair sway',
    [-1, 0, 1],
    'Usually driven by physics; positive toward screen right.',
  ),
  p(
    'Hair',
    'ParamHairBack',
    'Back hair sway',
    [-1, 0, 1],
    'Usually driven by physics; positive toward screen right.',
  ),
  p(
    'Hair',
    'ParamHairFluffy',
    'Hair fluff',
    [-1, 0, 1],
    'Hair spreading outward, on top of the sway; positive spreads.',
    OPT,
  ),
];

/**
 * The ranges that are also usual besides the standard one: ±45 for a larger head turn; 10, 50 or 100 for the arms; eye and mouth openness
 * extended past 0 to 1 in steps of 0.1 (examples: a maximum of 1.5 or 2, a minimum of −0.5; read
 * here as a minimum from −1 to 0 and a maximum from 1 to 2); the eyeball size's half ranges. The
 * default stays the standard one in each.
 */
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const tenths = (v: number) => near(v * 10, Math.round(v * 10));
const symmetric =
  (spans: number[]) =>
  (min: number, def: number, max: number): boolean =>
    near(def, 0) && spans.some((x) => near(min, -x) && near(max, x));
const openness =
  (def: number) =>
  (min: number, d: number, max: number): boolean =>
    near(d, def) && min <= 0 && min >= -1 && max >= 1 && max <= 2 && tenths(min) && tenths(max);
const VARIANTS: Record<
  string,
  { text: string; ok: (min: number, def: number, max: number) => boolean }
> = {
  ParamAngleX: { text: '±45 for larger turns', ok: symmetric([45]) },
  ...Object.fromEntries(
    ['ParamArmLA', 'ParamArmRA', 'ParamArmLB', 'ParamArmRB'].map((id) => [
      id,
      { text: '±10, ±50 or ±100 to suit the motion', ok: symmetric([10, 50, 100]) },
    ]),
  ),
  ...Object.fromEntries(
    ['ParamEyeLOpen', 'ParamEyeROpen'].map((id) => [
      id,
      {
        text: 'extended past 0 to 1 in steps of 0.1 (a maximum up to 2, a minimum down to −1), default 1',
        ok: openness(1),
      },
    ]),
  ),
  ParamMouthOpenY: {
    text: 'extended past 0 to 1 in steps of 0.1 (a maximum of about 1.5, up to 2; a minimum down to −1), default 0',
    ok: openness(0),
  },
  ParamEyeBallForm: {
    text: '−1 to 0 for a model that only shrinks, 0 to 1 for one that only enlarges',
    ok: (min, def, max) =>
      near(def, 0) && ((near(min, -1) && near(max, 0)) || (near(min, 0) && near(max, 1))),
  },
};

/** The 40 standard parameters, in their usual order: 27 core, 13 optional. */
export const STANDARD_PARAMETERS: readonly StandardParameter[] = BASE.map((x) =>
  VARIANTS[x.id] ? { ...x, variants: VARIANTS[x.id]!.text } : x,
);

/**
 * How a range stands against a standard parameter's: 'standard' (its own), 'variant' (one the
 * is also usual), 'other' (neither: apps may not recognize it), or undefined
 * for an ID that is not standard.
 */
export function standardRange(
  id: string,
  min: number,
  def: number,
  max: number,
): 'standard' | 'variant' | 'other' | undefined {
  const sp = byId.get(id);
  if (!sp) return undefined;
  if (near(min, sp.min) && near(def, sp.default) && near(max, sp.max)) return 'standard';
  return VARIANTS[id]?.ok(min, def, max) ? 'variant' : 'other';
}

/** The sections of the list, in order. */
export const STANDARD_SECTIONS: readonly StandardSection[] = [
  'Head',
  'Eyes',
  'Eyeballs',
  'Brows',
  'Mouth and cheeks',
  'Body',
  'Arms and hands',
  'Hair',
];

/** The standard parameter-group IDs (the parameter palette's folders). */
export const STANDARD_PARAMETER_GROUPS: readonly { id: string; name: string }[] = [
  { id: 'ParamGroupFace', name: 'Face' },
  { id: 'ParamGroupHead', name: 'Head' },
  { id: 'ParamGroupEyes', name: 'Eyes' },
  { id: 'ParamGroupEyeballs', name: 'Eyeballs' },
  { id: 'ParamGroupBrows', name: 'Brows' },
  { id: 'ParamGroupMouth', name: 'Mouth' },
  { id: 'ParamGroupBody', name: 'Body' },
  { id: 'ParamGroupHands', name: 'Hands' },
  { id: 'ParamGroupHandL', name: 'Left hand' },
  { id: 'ParamGroupHandR', name: 'Right hand' },
  { id: 'ParamGroupArms', name: 'Arms' },
  { id: 'ParamGroupArmL', name: 'Left arm' },
  { id: 'ParamGroupArmR', name: 'Right arm' },
  { id: 'ParamGroupLegs', name: 'Legs' },
  { id: 'ParamGroupLegL', name: 'Left leg' },
  { id: 'ParamGroupLegR', name: 'Right leg' },
  { id: 'ParamGroupSway', name: 'Sway' },
  { id: 'ParamGroupExpression', name: 'Expression' },
  { id: 'ParamGroupHair', name: 'Hair' },
  { id: 'ParamGroupOverall', name: 'Whole model' },
];

/** What changing a standard ID or range costs. */
export const STANDARD_ID_NOTE =
  "Mochi Maker offers the usual IDs and ranges so that a model works with apps' automatic setup, such as VTube Studio's Auto-Setup: with another ID or range, the model is set up by hand there.";

const byId = new Map(STANDARD_PARAMETERS.map((x) => [x.id, x]));
const byLower = new Map(
  [...STANDARD_PARAMETERS, ...STANDARD_PARAMETER_GROUPS].map((x) => [x.id.toLowerCase(), x.id]),
);

/** The standard parameter with exactly this ID, if any. */
export function standardParameter(id: string): StandardParameter | undefined {
  return byId.get(id);
}

/**
 * The standard parameter or group ID that `id` matches only up to letter case (ParamAnglex for
 * ParamAngleX), or undefined: an exact match or no match at all. Such near-duplicates are likely
 * typing mistakes.
 */
export function caseOnlyStandard(id: string): string | undefined {
  const s = byLower.get(id.toLowerCase());
  return s !== undefined && s !== id ? s : undefined;
}
