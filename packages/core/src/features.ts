/**
 * Feature flags. Glue and blend-shape authoring are not available in this build unless switched on:
 * by a session's options (the API's `features`), by the editor's settings, or by the environment
 * variable MOCHI_MAKER_FEATURES ("glue,blendShapes", or "all"). With a flag off:
 *
 * - commands that create or edit glue (or blend shapes) refuse with E_FEATURE_OFF;
 * - `describe` marks them as not available;
 * - the export refuses a project that holds them, with the same message;
 * - a project that holds them still opens, and everything else in it works. Deleting a glue or
 *   removing a blend shape stays possible, so that such a project can be made exportable.
 */
import { MochiError } from './errors.js';
import type { Draft } from './document.js';

export type Feature = 'glue' | 'blendShapes';
export type Features = Readonly<Record<Feature, boolean>>;

export const FEATURES: readonly Feature[] = ['glue', 'blendShapes'];
export const NO_FEATURES: Features = { glue: false, blendShapes: false };
export const ALL_FEATURES: Features = { glue: true, blendShapes: true };

const OFF_MESSAGE: Record<Feature, string> = {
  glue: 'Glue is not available in this build.',
  blendShapes: 'Blend shapes are not available in this build.',
};

/** Features from a list such as "glue,blendShapes" or "all"; unknown names are ignored. */
export function parseFeatures(list: string | undefined | null): Features {
  const names = (list ?? '')
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (names.includes('all')) return ALL_FEATURES;
  return { glue: names.includes('glue'), blendShapes: names.includes('blendShapes') };
}

/** The features of the environment variable MOCHI_MAKER_FEATURES (none outside Node). */
export function featuresFromEnv(): Features {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return parseFeatures(env?.MOCHI_MAKER_FEATURES);
}

/** The refusal for a feature that is off. */
export function featureOff(feature: Feature): MochiError {
  return new MochiError('E_FEATURE_OFF', OFF_MESSAGE[feature], {
    details: { feature },
  });
}

/** Commands that stay available with their feature off: they only take objects away. */
const REMOVALS = new Set(['glue.delete', 'blendShape.remove']);

/** The feature a command needs whatever its arguments, for `describe`. */
export function commandFeature(name: string): Feature | null {
  if (REMOVALS.has(name)) return null;
  if (name.startsWith('glue.')) return 'glue';
  if (name.startsWith('blendShape.')) return 'blendShapes';
  return null;
}

/**
 * The feature a call needs, given its resolved arguments: the command's own, a blend-shape
 * parameter (param.create or param.update with type 'blendShape'), or any edit whose target is a
 * glue (its keyforms, bindings, name).
 */
export function callFeature(name: string, args: unknown, draft: Draft): Feature | null {
  const own = commandFeature(name);
  if (own) return own;
  if (REMOVALS.has(name)) return null;
  const a = (args ?? {}) as Record<string, unknown>;
  if ((name === 'param.create' || name === 'param.update') && a.type === 'blendShape')
    return 'blendShapes';
  const target = typeof a.target === 'string' ? draft.get(a.target) : undefined;
  if (target?.kind === 'glue') return 'glue';
  return null;
}
