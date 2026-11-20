/** Physics lint rules: what blocks the export and what warns. */
import { describe, expect, it } from 'vitest';
import { Session, lint } from '../src/index.js';

const particles = [
  { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
  { x: 0, y: 10, mobility: 0.95, delay: 0.9, acceleration: 1.5, radius: 10 },
];
const normalization = {
  position: { min: -10, default: 0, max: 10 },
  angle: { min: -10, default: 0, max: 10 },
};

function scene() {
  const s = Session.create({ width: 100, height: 100 });
  s.transact('setup', (tx) => {
    tx.run('param.create', { exportId: 'ParamIn', min: -10, max: 10, default: 0, keys: [-10, 10] });
    tx.run('param.create', {
      exportId: 'ParamOut',
      min: -10,
      max: 10,
      default: 0,
      keys: [-10, 10],
    });
  });
  return s;
}
const rules = (s: Session) => lint(s.view).filter((l) => l.rule.startsWith('physics-'));

describe('physics lint', () => {
  it('errors for settings that cannot work, warns for unbound and overlapping outputs', () => {
    const s = scene();
    s.transact('a', (tx) =>
      tx.run('physics.addSetting', {
        name: 'Empty',
        inputs: [],
        outputs: [],
        particles: particles.slice(0, 1),
        normalization: { ...normalization, angle: { min: 1, default: 0, max: 1 } },
      }),
    );
    const r = rules(s);
    expect(
      r
        .filter((l) => l.severity === 'error')
        .map((l) => l.rule)
        .sort(),
    ).toEqual(['physics-incomplete', 'physics-incomplete', 'physics-normalization']);
    const io = {
      inputs: [{ parameter: '@param:ParamIn', weight: 100, type: 'X' as const }],
      outputs: [
        { parameter: '@param:ParamOut', weight: 80, type: 'Angle' as const, particle: 1, scale: 1 },
      ],
      particles,
      normalization,
    };
    const t = scene();
    t.transact('b', (tx) => {
      tx.run('physics.addSetting', { name: 'A', ...io });
      tx.run('physics.addSetting', { name: 'B', ...io });
    });
    const w = rules(t);
    expect(w.every((l) => l.severity === 'warning')).toBe(true);
    // ParamOut moves nothing yet, and two settings write it with 160 % in all.
    expect(w.map((l) => l.rule).sort()).toEqual([
      'physics-output-overlap',
      'physics-output-unbound',
      'physics-output-unbound',
    ]);
    expect(w.find((l) => l.rule === 'physics-output-overlap')!.message).toContain('160 %');
  });
});
