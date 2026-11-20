/**
 * The Expression palette (next to Parameter): the model's expressions, each a list of
 * parameter values with a blend, recorded from the current pose, previewed on the shown model by
 * Mochi2D, and exported as `.exp3.json`. Every change is an `expression.*` command.
 *
 * Blends: Set (the file's Overwrite) replaces the value, Add adds to it, Multiply scales it.
 */
import type { Expression, Parameter, Uid } from '@mochi-maker/core';
import { round, type Editor } from './editor.js';
import { fill, h } from './dom.js';
import type { Viewport } from './viewport.js';
import { lazyRender } from './panels.js';

export type Blend = Expression['entries'][number]['blend'];
export const BLEND_LABEL: Record<Blend, string> = {
  Overwrite: 'Set',
  Add: 'Add',
  Multiply: 'Multiply',
};

/**
 * An entry that reproduces a parameter's pose value from its default with a blend, or null when
 * none can (multiplying a default of 0).
 */
export function recordValue(p: Parameter, pose: number, blend: Blend): number | null {
  if (blend === 'Overwrite') return pose;
  if (blend === 'Add') return pose - p.default;
  return p.default === 0 ? null : pose / p.default;
}

export class ExpressionPalette {
  readonly el = h('section.expressions');
  private current: Uid | null = null;
  /** The blend new recordings use. */
  blend: Blend = 'Add';
  private readonly update: () => void;

  constructor(
    private readonly editor: Editor,
    private readonly viewport: Viewport,
  ) {
    this.update = lazyRender(this.el, () => this.render());
    editor.on('project', () => {
      this.current = null;
      this.viewport.setPreviewExpression(null);
      this.update();
    });
    editor.on('document', (e) => {
      if (
        e.changes.some(
          (c) => c.kind === 'expression' || c.kind === 'parameter' || c.kind === 'project',
        )
      )
        this.update();
    });
    this.render();
  }

  private get list(): Expression[] {
    const v = this.editor.view;
    return v.project().expressionOrder.map((u) => v.getAs(u, 'expression'));
  }

  /** The pose's parameters away from their defaults, as entries with the chosen blend. */
  recordEntries(blend = this.blend): { entries: Expression['entries']; skipped: string[] } {
    const entries: Expression['entries'] = [];
    const skipped: string[] = [];
    for (const p of this.editor.view.ofKind('parameter')) {
      const v = this.editor.value(p.uid);
      if (Math.abs(v - p.default) < 1e-9) continue;
      const value = recordValue(p, v, blend);
      if (value === null) skipped.push(p.exportId);
      else entries.push({ parameter: p.uid, value: Math.round(value * 1e6) / 1e6, blend });
    }
    return { entries, skipped };
  }

  /** A new expression from the pose. */
  create(name?: string): Uid | null {
    const { entries, skipped } = this.recordEntries();
    if (entries.length === 0)
      this.editor.emit('message', {
        level: 'warning',
        text: 'The pose is at the defaults: the new expression is empty. Move the parameters, then Record.',
      });
    const used = new Set(this.list.map((e) => e.name));
    let n = this.list.length + 1;
    let id = name ?? `Expression${n}`;
    while (used.has(id)) id = `Expression${++n}`;
    const r = this.editor.transact('New expression', [
      { name: 'expression.create', args: { name: id, entries } },
    ]);
    this.skippedNote(skipped);
    const uid = (r?.results[0] as { uid?: Uid } | undefined)?.uid ?? null;
    if (uid) this.select(uid);
    return uid;
  }

  /** Replaces the selected expression's entries with the pose. */
  record(): void {
    const e = this.selected();
    if (!e) return;
    const { entries, skipped } = this.recordEntries();
    this.editor.transact('Record expression', [
      { name: 'expression.update', args: { target: e.uid, entries } },
    ]);
    this.skippedNote(skipped);
  }

  private skippedNote(skipped: string[]): void {
    if (skipped.length)
      this.editor.emit('message', {
        level: 'warning',
        text: `Left out ${skipped.join(', ')}: their default is 0, so no factor reaches the pose. Use Set or Add for them.`,
      });
  }

  selected(): Expression | undefined {
    return this.list.find((e) => e.uid === this.current);
  }

  select(uid: Uid | null): void {
    this.current = uid;
    if (this.viewport.previewExpression !== null) this.preview(true);
    this.render();
  }

  /** Previews the selected expression on the shown model (Mochi2D applies it with its fades). */
  preview(on: boolean): void {
    const e = this.selected();
    this.viewport.setPreviewExpression(on && e ? e.name : null);
    this.render();
  }

  private set(
    e: Expression,
    change: (entries: Expression['entries']) => void,
    label = 'Edit expression',
  ): void {
    const entries = structuredClone(e.entries);
    change(entries);
    this.editor.transact(label, [{ name: 'expression.update', args: { target: e.uid, entries } }]);
  }

  render(): void {
    const list = this.list;
    if (this.current && !list.some((e) => e.uid === this.current)) this.current = null;
    const e = this.selected();
    const v = this.editor.view;
    const params = v.project().parameterOrder.map((u) => v.getAs(u, 'parameter'));
    const blendSelect = (value: Blend, change: (b: Blend) => void, testid?: string) =>
      h(
        'select',
        {
          dataset: testid ? { testid } : {},
          on: { change: (ev) => change((ev.target as HTMLSelectElement).value as Blend) },
        },
        (['Overwrite', 'Add', 'Multiply'] as const).map((b) =>
          h('option', { value: b, selected: b === value }, BLEND_LABEL[b]),
        ),
      );
    fill(
      this.el,
      h(
        'div.palette-bar',
        h(
          'button',
          {
            title: 'A new expression from the parameters away from their defaults',
            dataset: { testid: 'expression-new' },
            on: { click: () => this.create() },
          },
          'New from pose',
        ),
        h(
          'button',
          {
            disabled: !e,
            title: 'Replace the entries with the pose',
            dataset: { testid: 'expression-record' },
            on: { click: () => this.record() },
          },
          'Record',
        ),
        h(
          'label.toggle',
          { title: 'How recorded values combine' },
          'as',
          blendSelect(this.blend, (b) => (this.blend = b), 'expression-blend'),
        ),
        h(
          'label.toggle',
          h('input', {
            type: 'checkbox',
            checked: this.viewport.previewExpression !== null,
            disabled: !e,
            dataset: { testid: 'expression-preview' },
            on: { change: (ev) => this.preview((ev.target as HTMLInputElement).checked) },
          }),
          'Preview',
        ),
        h(
          'button.danger',
          {
            disabled: !e,
            on: {
              click: () => {
                if (!e) return;
                if (this.viewport.previewExpression === e.name)
                  this.viewport.setPreviewExpression(null);
                this.editor.transact('Delete expression', [
                  { name: 'expression.delete', args: { target: e.uid } },
                ]);
              },
            },
          },
          'Delete',
        ),
      ),
      h(
        'div.rows',
        list.length
          ? list.map((x) =>
              h(
                'div.row',
                {
                  class: x.uid === this.current ? 'selected' : '',
                  dataset: { expression: x.name },
                  on: { click: () => this.select(x.uid) },
                },
                h('span.icon', '☺'),
                h('span.name', x.name),
                h('span.extra', `${x.entries.length} value${x.entries.length === 1 ? '' : 's'}`),
              ),
            )
          : h('div.empty', 'No expressions. Pose the model, then New from pose.'),
      ),
      e ? this.detail(e, params, blendSelect) : null,
    );
  }

  private detail(
    e: Expression,
    params: Parameter[],
    blendSelect: (value: Blend, change: (b: Blend) => void, testid?: string) => HTMLElement,
  ): HTMLElement {
    const name = h('input', { value: e.name, dataset: { testid: 'expression-name' } });
    name.addEventListener('change', () =>
      this.editor.transact('Rename expression', [
        { name: 'expression.update', args: { target: e.uid, name: name.value } },
      ]),
    );
    const fade = (key: 'fadeIn' | 'fadeOut') =>
      h('input.num', {
        type: 'number',
        min: '0',
        step: '0.1',
        placeholder: 'default',
        value: e[key] === null ? '' : String(e[key]),
        on: {
          change: (ev) => {
            const s = (ev.target as HTMLInputElement).value;
            this.editor.transact('Expression fade', [
              {
                name: 'expression.update',
                args: { target: e.uid, [key]: s === '' ? null : Number(s) },
              },
            ]);
          },
        },
      });
    return h(
      'div.section',
      h('label.field', h('span', 'Name'), name),
      h(
        'label.field',
        h('span', 'Fade in / out (s)'),
        h('span.field-input', fade('fadeIn'), fade('fadeOut')),
      ),
      h(
        'table.physics-table',
        h(
          'tr',
          ['Parameter', 'Value', 'Blend', ''].map((t) => h('th', t)),
        ),
        e.entries.map((x, i) =>
          h(
            'tr',
            { dataset: { entry: String(i) } },
            h(
              'td',
              h(
                'select',
                {
                  on: {
                    change: (ev) =>
                      this.set(
                        e,
                        (en) => (en[i]!.parameter = (ev.target as HTMLSelectElement).value),
                      ),
                  },
                },
                params.map((p) =>
                  h('option', { value: p.uid, selected: p.uid === x.parameter }, p.exportId),
                ),
              ),
            ),
            h(
              'td',
              h('input.num', {
                type: 'number',
                step: 'any',
                value: String(round(x.value, 6)),
                dataset: { testid: `entry-value-${i}` },
                on: {
                  change: (ev) => {
                    const n = Number((ev.target as HTMLInputElement).value);
                    if (Number.isFinite(n)) this.set(e, (en) => (en[i]!.value = n));
                  },
                },
              }),
            ),
            h(
              'td',
              blendSelect(
                x.blend,
                (b) => this.set(e, (en) => (en[i]!.blend = b)),
                `entry-blend-${i}`,
              ),
            ),
            h(
              'td',
              h(
                'button.step',
                { title: 'Remove', on: { click: () => this.set(e, (en) => en.splice(i, 1)) } },
                '×',
              ),
            ),
          ),
        ),
      ),
      h(
        'button',
        {
          disabled: params.length === 0,
          on: {
            click: () =>
              this.set(
                e,
                (en) =>
                  en.push({
                    parameter:
                      params.find((p) => !en.some((x) => x.parameter === p.uid))?.uid ??
                      params[0]!.uid,
                    value: 0,
                    blend: this.blend,
                  }),
                'Add expression entry',
              ),
          },
        },
        '+ Value',
      ),
      h(
        'div.hint',
        'Set replaces a parameter’s value, Add adds to it, Multiply scales it. Exported as an .exp3.json file listed in the model settings.',
      ),
    );
  }
}
