/** Expression and pose lint rules. */
import { describe, expect, it } from 'vitest';
import { DocView, Session, lint, type Document } from '../src/index.js';

function scene() {
  const s = Session.create({ width: 100, height: 100 });
  s.transact('setup', (tx) => {
    tx.run('param.create', { exportId: 'ParamA', min: 0, max: 1, default: 0, keys: [0, 1] });
    tx.run('part.create', { exportId: 'PartA' });
    tx.run('part.create', { exportId: 'PartB' });
    tx.run('part.create', { exportId: 'PartC' });
    tx.run('expression.create', {
      name: 'smile',
      entries: [{ parameter: '@param:ParamA', value: 1, blend: 'Add' }],
    });
  });
  return s;
}
const rules = (doc: Document) =>
  lint(new DocView(doc))
    .filter((l) => l.rule.startsWith('expression-') || l.rule.startsWith('pose-'))
    .map((l) => [l.rule, l.severity]);

describe('expression and pose lint', () => {
  it('reports a missing parameter, a duplicate entry, small groups and a part in two groups', () => {
    const s = scene();
    expect(rules(s.doc)).toEqual([]);
    const v = s.view;
    const e = v.ofKind('expression')[0]!;
    const [a, b, c] = v.ofKind('part').map((p) => p.uid);
    const project = v.project();
    // Documents the commands never make (they refuse them), as a file edited by hand might be.
    const doc: Document = {
      seq: s.doc.seq,
      objects: {
        ...s.doc.objects,
        [e.uid]: {
          ...e,
          entries: [
            ...e.entries,
            { parameter: 'param_9999', value: 1, blend: 'Add' },
            { ...e.entries[0]! },
          ],
        },
        project: {
          ...project,
          pose: {
            fadeIn: null,
            groups: [
              [
                { part: a!, links: [] },
                { part: b!, links: [] },
              ],
              [
                { part: b!, links: [] },
                { part: c!, links: [] },
              ],
              [{ part: c!, links: [] }],
            ],
          },
        },
      } as Document['objects'],
    };
    expect(rules(doc).sort()).toEqual(
      [
        ['expression-duplicate-parameter', 'warning'],
        ['expression-missing-parameter', 'error'],
        ['pose-part-in-two-groups', 'error'],
        ['pose-part-in-two-groups', 'error'],
        ['pose-small-group', 'warning'],
      ].sort(),
    );
  });
});
