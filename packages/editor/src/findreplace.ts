/**
 * «Find and Replace» (Ctrl+F): the export IDs and names of parameters, parts, deformers
 * and art meshes, by plain text or a pattern. The preview lists every change and every problem as
 * the person types (`planReplace`); «Replace All» runs `objects.replaceText`, one undoable step.
 * A row in the preview selects its object.
 */
import { DocView, planReplace, type ReplaceArgs, type ReplaceKind } from '@mochi-maker/core';
import { dialog, type Dialog } from './dialogs.js';
import { h, fill } from './dom.js';
import type { Editor } from './editor.js';

const GROUPS: { label: string; kinds: ReplaceKind[]; testid: string }[] = [
  { label: 'Parameters', kinds: ['parameter'], testid: 'fr-parameters' },
  { label: 'Parts', kinds: ['part'], testid: 'fr-parts' },
  { label: 'Deformers', kinds: ['warp', 'rotation'], testid: 'fr-deformers' },
  { label: 'Art meshes', kinds: ['artMesh'], testid: 'fr-meshes' },
];

const KIND_LABEL: Record<ReplaceKind, string> = {
  parameter: 'Parameter',
  part: 'Part',
  warp: 'Warp',
  rotation: 'Rotation',
  artMesh: 'ArtMesh',
};

export function findReplaceDialog(editor: Editor, initial = ''): Dialog {
  const input = (testid: string, value = '') =>
    h('input', { type: 'text', value, dataset: { testid } }) as HTMLInputElement;
  const check = (testid: string, checked: boolean) =>
    h('input', { type: 'checkbox', checked, dataset: { testid } }) as HTMLInputElement;
  const find = input('fr-find', initial);
  const replace = input('fr-replace');
  const pattern = check('fr-pattern', false);
  const ignoreCase = check('fr-ignore-case', false);
  const ids = check('fr-ids', true);
  const names = check('fr-names', true);
  const groups = GROUPS.map((g) => ({ ...g, box: check(g.testid, true) }));
  const preview = h('div.rows.fr-preview', { dataset: { testid: 'fr-preview' } });
  const summary = h('div.facts', { dataset: { testid: 'fr-summary' } });
  const args = (): ReplaceArgs | null => {
    const fields = [...(ids.checked ? ['exportId'] : []), ...(names.checked ? ['name'] : [])];
    const kinds = groups.filter((g) => g.box.checked).flatMap((g) => g.kinds);
    if (!find.value || fields.length === 0 || kinds.length === 0) return null;
    return {
      find: find.value,
      replace: replace.value,
      pattern: pattern.checked,
      ignoreCase: ignoreCase.checked,
      fields: fields as ReplaceArgs['fields'],
      kinds,
    };
  };
  let ok = false;
  const refresh = () => {
    ok = false;
    const a = args();
    if (!a) {
      fill(preview);
      summary.textContent = find.value ? 'Choose where to look.' : 'Type what to find.';
      apply.disabled = true;
      return;
    }
    try {
      const v = new DocView(editor.doc);
      const { changes, problems } = planReplace(v, a);
      const bad = new Map(problems.map((p) => [`${p.uid}.${p.field}`, p]));
      fill(
        preview,
        changes.map((c) => {
          const p = bad.get(`${c.uid}.${c.field}`);
          return h(
            'div.row',
            {
              class: p ? 'problem' : '',
              title: p?.message ?? 'Click to select it',
              dataset: { change: `${c.field}:${c.from}` },
              on: { click: () => editor.select(c.uid) },
            },
            h('span.extra', `${KIND_LABEL[c.kind]} · ${c.field === 'exportId' ? 'ID' : 'name'}`),
            h('span.name', `${c.from} → ${c.to}`),
          );
        }),
      );
      ok = changes.length > 0 && problems.length === 0;
      summary.textContent =
        changes.length === 0
          ? 'Nothing matches.'
          : problems.length
            ? `${changes.length} change(s); ${problems.length} problem(s) to fix first: ${problems[0]!.message}`
            : `${changes.length} change(s). References follow (they are by UID): bindings, masks, physics, pose, expressions, motions and display info.`;
    } catch (e) {
      fill(preview);
      summary.textContent = (e as Error).message;
    }
    apply.disabled = !ok;
  };
  const apply = h(
    'button.primary',
    {
      disabled: true,
      dataset: { testid: 'fr-apply' },
      on: {
        click: () => {
          const a = args();
          if (!a || !ok) return;
          const r = editor.transact(`Replace "${a.find}" with "${a.replace}"`, [
            { name: 'objects.replaceText', args: a },
          ]);
          const n = (r?.results[0] as { changes?: unknown[] } | undefined)?.changes?.length ?? 0;
          if (r) editor.emit('message', { level: 'info', text: `Replaced: ${n} change(s).` });
          refresh();
        },
      },
    },
    'Replace All',
  ) as HTMLButtonElement;
  for (const el of [find, replace]) el.addEventListener('input', refresh);
  for (const el of [pattern, ignoreCase, ids, names, ...groups.map((g) => g.box)])
    el.addEventListener('change', refresh);
  const d = dialog(
    'Find and Replace',
    [
      h('label.field', h('span', 'Find'), find),
      h('label.field', h('span', 'Replace with'), replace),
      h(
        'div.checks',
        h('label', pattern, ' Pattern (regular expression; $1 in the replacement)'),
        h('label', ignoreCase, ' Ignore case'),
      ),
      h('div.checks', h('label', ids, ' IDs'), h('label', names, ' Names')),
      h(
        'div.checks',
        groups.map((g) => h('label', g.box, ` ${g.label}`)),
      ),
      summary,
      preview,
      h('div.buttons', apply, h('button', { on: { click: () => d.close() } }, 'Close')),
    ],
    { testid: 'find-replace', wide: true },
  );
  refresh();
  find.focus();
  find.select();
  return d;
}
