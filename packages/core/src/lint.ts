/**
 * Lint rules (design 4.2, validation tier 3): problems worth knowing about that do not make the
 * document inconsistent. They are checked on request and before export.
 */
import type { DocReader } from './document.js';
import type { Fix } from './errors.js';
import type { ShapeTarget, Uid } from './model.js';

export interface LintResult {
  rule: string;
  severity: 'warning' | 'error';
  uid: Uid;
  message: string;
  fixes?: Fix[];
}

export function lint(doc: DocReader): LintResult[] {
  const out: LintResult[] = [];
  const bound = new Set<Uid>();
  for (const o of doc.ofKind(['part', 'artMesh', 'warp', 'rotation', 'glue'])) {
    for (const b of o.rig.bindings) bound.add(b.parameter);
    const filled = o.rig.keyforms.filter((k) => !k.authored).length;
    if (filled > 0)
      out.push({
        rule: 'unauthored-keyforms',
        severity: 'warning',
        uid: o.uid,
        message: `${doc.describe(o.uid)} has ${filled} filled keyform(s) that nobody has edited.`,
        fixes: [
          {
            description: 'Recompute them from the authored ones',
            command: 'rig.fillMissing',
            args: { target: o.uid },
          },
        ],
      });
  }
  const used = new Set<Uid>(bound);
  for (const o of doc.ofKind(['part', 'artMesh', 'warp', 'rotation', 'glue']))
    for (const b of o.blendShapes) {
      used.add(b.parameter);
      for (const c of b.constraints) used.add(c.parameter);
    }
  for (const e of doc.ofKind('expression')) for (const x of e.entries) used.add(x.parameter);
  for (const m of doc.ofKind('motion')) for (const c of m.curves) if (c.object) used.add(c.object);
  for (const s of doc.ofKind('physicsSetting')) {
    for (const x of s.inputs) used.add(x.parameter);
    for (const x of s.outputs) used.add(x.parameter);
  }
  const p = doc.project();
  for (const u of [...p.standardGroups.eyeBlink, ...p.standardGroups.lipSync]) used.add(u);
  for (const param of doc.ofKind('parameter'))
    if (!used.has(param.uid))
      out.push({
        rule: 'unused-parameter',
        severity: 'warning',
        uid: param.uid,
        message: `${doc.describe(param.uid)} drives nothing.`,
      });

  // Blend-shape targets: version 5 clamps a target's own value once, after its blend
  // shapes. Warn when a target's reach leaves a clamp range, so that the clamp
  // never changes a result; version 4 clamps nothing, which then also agrees.
  for (const o of doc.ofKind(['artMesh', 'warp', 'rotation', 'part', 'glue'])) {
    if (o.blendShapes.length === 0) continue;
    for (const c of CLAMPS[o.kind]) {
      const [lo, hi] = reach(o, c.get);
      if (lo < c.min || hi > c.max)
        out.push({
          rule: 'target-clamp-range',
          severity: 'warning',
          uid: o.uid,
          message: `${doc.describe(o.uid)}: with its blend shapes at their extremes, its ${c.name} reaches ${lo}…${hi}; version 5 clamps a blend-shape target's ${c.name} to ${c.min}…${c.max}. Keep it in range.`,
        });
    }
    if (o.kind === 'rotation') {
      const [, hi] = reach(o, (v) => v.scale as number);
      if (hi > SCALE_USUAL && hi <= SCALE_MAX)
        out.push({
          rule: 'rotation-scale-unusual',
          severity: 'warning',
          uid: o.uid,
          message: `${doc.describe(o.uid)}: with its blend shapes at their extremes, its scale reaches ${hi}, more than ${SCALE_USUAL}. That is allowed, but unusual for a rig.`,
        });
    }
  }

  // Blend shapes.
  for (const o of doc.ofKind(['part', 'artMesh', 'warp', 'rotation', 'glue'])) {
    for (const b of o.blendShapes)
      for (const c of b.constraints)
        if (c.points.some(([, w]) => w < 0))
          out.push({
            rule: 'negative-constraint-weight',
            severity: 'warning',
            uid: o.uid,
            message: `${doc.describe(o.uid)}: a constraint over ${doc.describe(c.parameter)} has a negative weight, which reverses the blend shape on ${doc.describe(b.parameter)}. Genuine files use weights within 0…1.`,
          });
  }

  for (const m of doc.ofKind('artMesh')) {
    if (m.triangles.length === 0)
      out.push({
        rule: 'mesh-without-triangles',
        severity: 'error',
        uid: m.uid,
        message: `${doc.describe(m.uid)} has no triangles.`,
      });
    if (m.layer === null)
      out.push({
        rule: 'mesh-without-layer',
        severity: 'error',
        uid: m.uid,
        message: `${doc.describe(m.uid)} has no image layer.`,
      });
    if (m.part === null)
      out.push({
        rule: 'mesh-at-top-level',
        severity: 'warning',
        uid: m.uid,
        message: `${doc.describe(m.uid)} is not inside a part.`,
      });
  }
  for (const part of doc.ofKind('part'))
    if (part.children.length === 0)
      out.push({
        rule: 'empty-part',
        severity: 'warning',
        uid: part.uid,
        message: `${doc.describe(part.uid)} is empty.`,
      });
  for (const param of doc.ofKind('parameter'))
    if (param.type === 'normal' && !param.keys.includes(param.default) && bound.has(param.uid))
      out.push({
        rule: 'default-not-a-key',
        severity: 'warning',
        uid: param.uid,
        message: `The default of ${doc.describe(param.uid)} is not one of its keys.`,
      });
  // Physics: settings that cannot work are errors and block the
  // export; outputs that several settings share past 100 %, or that drive nothing, are warnings.
  const outWeights = new Map<Uid, { total: number; settings: string[] }>();
  for (const s of doc.ofKind('physicsSetting')) {
    const name = doc.describe(s.uid);
    if (s.inputs.length === 0 || s.outputs.length === 0)
      out.push({
        rule: 'physics-incomplete',
        severity: 'error',
        uid: s.uid,
        message: `${name} has ${s.inputs.length === 0 ? 'no inputs' : 'no outputs'}: it cannot move anything.`,
      });
    if (s.particles.length < 2)
      out.push({
        rule: 'physics-incomplete',
        severity: 'error',
        uid: s.uid,
        message: `${name} has ${s.particles.length} particle(s): a pendulum needs at least two.`,
      });
    for (const [what, r] of [
      ['position', s.normalization.position],
      ['angle', s.normalization.angle],
    ] as const)
      if (!(r.min < r.max) || r.default < r.min || r.default > r.max)
        out.push({
          rule: 'physics-normalization',
          severity: 'error',
          uid: s.uid,
          message: `${name}'s ${what} normalization must have minimum < maximum and the default between them (it is ${r.min}, ${r.default}, ${r.max}).`,
        });
    for (const o of s.outputs) {
      const w = outWeights.get(o.parameter) ?? { total: 0, settings: [] };
      w.total += o.weight;
      w.settings.push(name);
      outWeights.set(o.parameter, w);
      if (!bound.has(o.parameter))
        out.push({
          rule: 'physics-output-unbound',
          severity: 'warning',
          uid: s.uid,
          message: `${name} writes ${doc.describe(o.parameter)}, which moves nothing yet: key the parameter first, physics only drives parameters that already have motion.`,
        });
    }
  }
  for (const [param, w] of outWeights)
    if (w.settings.length > 1 && w.total > 100)
      out.push({
        rule: 'physics-output-overlap',
        severity: 'warning',
        uid: param,
        message: `${doc.describe(param)} is written by ${w.settings.length} physics settings with weights adding up to ${w.total} %: more than 100 % makes it jerky.`,
      });
  // Expressions and pose.
  for (const e of doc.ofKind('expression')) {
    const seen = new Set<Uid>();
    e.entries.forEach((x, i) => {
      if (doc.get(x.parameter)?.kind !== 'parameter')
        out.push({
          rule: 'expression-missing-parameter',
          severity: 'error',
          uid: e.uid,
          message: `${doc.describe(e.uid)}'s entry ${i} names ${x.parameter}, which is not a parameter of this model.`,
          fixes: [
            {
              description: 'Write the entries again without it',
              command: 'expression.update',
              args: { target: e.uid, entries: '<entries without it>' },
            },
          ],
        });
      else if (seen.has(x.parameter))
        out.push({
          rule: 'expression-duplicate-parameter',
          severity: 'warning',
          uid: e.uid,
          message: `${doc.describe(e.uid)} names ${doc.describe(x.parameter)} twice; only one entry takes effect.`,
        });
      seen.add(x.parameter);
    });
  }
  const pose = doc.project().pose;
  const groupsOf = new Map<Uid, number[]>();
  pose.groups.forEach((g, gi) => {
    if (g.length < 2)
      out.push({
        rule: 'pose-small-group',
        severity: 'warning',
        uid: g[0]?.part ?? 'project',
        message: `Pose group ${gi + 1} has ${g.length} part${g.length === 1 ? '' : 's'}: a pose switches between at least two.`,
      });
    for (const e of g) groupsOf.set(e.part, [...(groupsOf.get(e.part) ?? []), gi + 1]);
  });
  for (const [part, groups] of groupsOf)
    if (groups.length > 1)
      out.push({
        rule: 'pose-part-in-two-groups',
        severity: 'error',
        uid: part,
        message: `${doc.describe(part)} is in pose groups ${groups.join(' and ')}: a part belongs to one group at most.`,
      });
  // Motions.
  for (const m of doc.ofKind('motion')) {
    const name = doc.describe(m.uid);
    m.curves.forEach((c, i) => {
      const what = c.target === 'model' ? `model ${c.model}` : `${c.target} ${c.object}`;
      if (c.target !== 'model') {
        const o = c.object ? doc.get(c.object) : undefined;
        const kind = c.target === 'parameter' ? 'parameter' : 'part';
        if (o?.kind !== kind)
          out.push({
            rule: 'motion-missing-target',
            severity: 'error',
            uid: m.uid,
            message: `${name}'s curve ${i} (${what}) names a ${kind} this model does not have.`,
          });
      }
      const times: number[] = [c.segments[0]!];
      for (let k = 2; k < c.segments.length; k += c.segments[k] === 1 ? 7 : 3)
        times.push(c.segments[k + (c.segments[k] === 1 ? 5 : 1)]!);
      if (times.some((t, k) => k > 0 && t < times[k - 1]!))
        out.push({
          rule: 'motion-keys-out-of-order',
          severity: 'error',
          uid: m.uid,
          message: `${name}'s curve ${i} (${what}) has keys out of time order.`,
        });
      for (const [f, v] of [
        ['fade-in', c.fadeIn],
        ['fade-out', c.fadeOut],
      ] as const)
        if (v !== null && v > m.duration)
          out.push({
            rule: 'motion-fade-too-long',
            severity: 'warning',
            uid: m.uid,
            message: `${name}'s curve ${i} (${what}) has a ${f} of ${v} s, longer than the motion (${m.duration} s).`,
          });
    });
    for (const [f, v] of [
      ['fade-in', m.fadeIn],
      ['fade-out', m.fadeOut],
    ] as const)
      if (v !== null && v > m.duration)
        out.push({
          rule: 'motion-fade-too-long',
          severity: 'warning',
          uid: m.uid,
          message: `${name} has a ${f} of ${v} s, longer than the motion itself (${m.duration} s).`,
        });
    // A motion-sync setting moves the mouth by the motion's sound: without one, it is
    // left out of the export.
    if (m.motionSync && !m.sound)
      out.push({
        rule: 'motion-sync-without-sound',
        severity: 'warning',
        uid: m.uid,
        message: `${name} names a motion-sync setting but starts no sound, so the export leaves the setting out: give the motion a sound.`,
        fixes: [
          {
            description: 'Stop naming the setting',
            command: 'motion.update',
            args: { target: m.uid, motionSync: null },
          },
        ],
      });
  }
  return out;
}

type Values = Record<string, number | number[]>;
type Getter = (v: Values) => number;
interface Clamp {
  name: string;
  min: number;
  max: number;
  get: Getter;
}

const unit = (name: string, get: Getter): Clamp => ({ name, min: 0, max: 1, get });
const channels = (field: 'multiply' | 'screen'): Clamp[] =>
  ['red', 'green', 'blue'].map((c, i) =>
    unit(`${field} color (${c})`, (v) => (v[field] as number[] | undefined)?.[i] ?? 0),
  );
/** Where version 5 clamps a blend-shape target's own values. */
const SCALE_MAX = 100;
const SCALE_USUAL = 10;
const colorClamps = [...channels('multiply'), ...channels('screen')];
const CLAMPS: Record<'artMesh' | 'warp' | 'rotation' | 'part' | 'glue', Clamp[]> = {
  artMesh: [
    unit('opacity', (v) => v.opacity as number),
    ...colorClamps,
    { name: 'draw order', min: 0, max: 1000, get: (v) => v.drawOrder as number },
  ],
  warp: [unit('opacity', (v) => v.opacity as number), ...colorClamps],
  rotation: [
    unit('opacity', (v) => v.opacity as number),
    ...colorClamps,
    { name: 'scale', min: Math.fround(1e-4), max: SCALE_MAX, get: (v) => v.scale as number },
    { name: 'angle', min: -3600, max: 3600, get: (v) => v.angle as number },
  ],
  part: [{ name: 'draw order', min: 0, max: 1000, get: (v) => v.drawOrder as number }],
  glue: [unit('intensity', (v) => v.intensity as number)],
};

/**
 * The lowest and highest value a target's field can reach: its keyforms' extremes, plus every
 * blend shape at its most negative and most positive contribution (delta extremes times weight
 * extremes, with w = min(1, constraints)).
 */
function reach(o: ShapeTarget, get: Getter): [number, number] {
  const values = (o.rig.keyforms as unknown as Values[]).map(get);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  for (const b of o.blendShapes) {
    const deltas = (b.deltas as unknown as Values[]).map((d) => get(d) ?? 0);
    const dLo = Math.min(0, ...deltas);
    const dHi = Math.max(0, ...deltas);
    let wLo = 1;
    let wHi = 1;
    for (const c of b.constraints) {
      const ws = c.points.map(([, w]) => w);
      wLo = Math.min(wLo, ...ws);
      wHi = Math.min(wHi, Math.max(...ws));
    }
    const p = [wLo * dLo, wLo * dHi, wHi * dLo, wHi * dHi];
    lo += Math.min(...p);
    hi += Math.max(...p);
  }
  return [lo, hi];
}
