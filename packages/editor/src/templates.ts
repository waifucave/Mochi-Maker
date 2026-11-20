/**
 * The Template palette: animation templates, named
 * runs of parameter keys kept in the project. New cuts one from the selected keys' range of frames
 * in the Timeline (or a range typed in); a template's button inserts it at the playhead, matching
 * parameters by export ID, after showing the ones this model lacks. Templates go to and come from
 * files, the browser's stand-in for the template folder: Export, and Import (Update).
 *
 * Every change is a `template.*` command, so it undoes and agents can do the same.
 */
import { templateMatch, type AnimationTemplate } from '@mochi-maker/core';
import { round, type Editor } from './editor.js';
import { fill, h } from './dom.js';
import { askText, dialog } from './dialogs.js';
import { lazyRender, popupMenu } from './panels.js';
import type { Playback, TimelinePalette } from './timeline.js';

/** The template file: one template, or several (Export all). */
export const TEMPLATE_FORMAT = 'mochi-maker-animation-template';
export interface TemplateFile {
  format: typeof TEMPLATE_FORMAT;
  version: 1;
  templates: AnimationTemplate[];
}

export function templateFile(templates: AnimationTemplate[]): TemplateFile {
  return { format: TEMPLATE_FORMAT, version: 1, templates };
}

/** The templates in a file's text; throws with a message a person can read. */
export function readTemplateFile(text: string): AnimationTemplate[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The file is not JSON.');
  }
  const f = json as Partial<TemplateFile>;
  if (f?.format !== TEMPLATE_FORMAT || !Array.isArray(f.templates))
    throw new Error('The file is not a Mochi Maker animation template file.');
  if (f.version !== 1) throw new Error(`Template files of version ${f.version} are not known.`);
  return f.templates;
}

export class TemplatePalette {
  readonly el = h('section.templates');
  private readonly update: () => void;
  private lastError = '';
  private readonly file = h('input', {
    type: 'file',
    accept: '.json',
    multiple: true,
    hidden: true,
    dataset: { testid: 'template-import-file' },
  });

  constructor(
    private readonly editor: Editor,
    private readonly playback: Playback,
    private readonly timeline: TimelinePalette,
  ) {
    this.update = lazyRender(this.el, () => this.render());
    editor.on('project', () => this.update());
    editor.on('document', (e) => {
      if (e.changes.some((c) => c.kind === 'project' || c.kind === 'parameter')) this.update();
    });
    playback.listeners.add(() => {
      if (this.el.dataset.motion !== (playback.motion ?? '')) this.update();
    });
    this.file.addEventListener('change', () => void this.importFiles());
    editor.on('message', (m) => {
      if (m.level === 'error') this.lastError = m.text;
    });
    this.render();
  }

  get templates(): AnimationTemplate[] {
    return this.editor.view.project().animationTemplates;
  }

  /** The parameter export IDs of the model. */
  private ids(): string[] {
    return this.editor.view.ofKind('parameter').map((p) => p.exportId);
  }

  render(): void {
    this.el.dataset.motion = this.playback.motion ?? '';
    const motion = this.playback.current;
    const ids = this.ids();
    fill(
      this.el,
      h(
        'div.palette-bar',
        h(
          'button',
          {
            title: 'A template from the keys in a range of frames',
            disabled: !motion,
            dataset: { testid: 'template-new' },
            on: { click: () => this.newDialog() },
          },
          'New…',
        ),
        h(
          'button',
          {
            title: 'Read template files (the browser’s template folder)',
            dataset: { testid: 'template-import' },
            on: { click: () => this.file.click() },
          },
          'Import…',
        ),
        h(
          'button',
          {
            title: 'Save every template to one file',
            disabled: this.templates.length === 0,
            dataset: { testid: 'template-export-all' },
            on: { click: () => this.download(this.templates, 'animation-templates') },
          },
          'Export all',
        ),
        this.file,
      ),
      this.templates.length === 0
        ? h(
            'div.empty',
            motion
              ? 'No templates. Select keys in the Timeline, then New.'
              : 'No templates. Pick a motion in the Scene palette, then New.',
          )
        : h(
            'div.template-list',
            this.templates.map((t) => {
              const { unmatched } = templateMatch(t, ids);
              const keys = t.curves.reduce((s, c) => s + c.keys.length, 0);
              return h(
                'div.template',
                h(
                  'button.template-button',
                  {
                    disabled: !motion,
                    title: `${t.curves.length} parameter(s), ${keys} key(s), ${round(t.duration, 3)} s: insert at the playhead`,
                    dataset: { template: t.name },
                    on: { click: () => this.insert(t) },
                  },
                  t.name,
                ),
                unmatched.length
                  ? h(
                      'span.warn-mark',
                      { title: `Not in this model: ${unmatched.join(', ')}` },
                      `${unmatched.length} unmatched`,
                    )
                  : null,
                h(
                  'button.menu-button',
                  {
                    title: 'Template menu',
                    dataset: { testid: `template-menu-${t.name}` },
                    on: { click: (e) => this.menu(e as MouseEvent, t) },
                  },
                  '⋯',
                ),
              );
            }),
          ),
    );
  }

  private menu(e: MouseEvent, t: AnimationTemplate): void {
    popupMenu(e, [
      { label: 'Rename…', testid: 'template-rename', run: () => void this.rename(t) },
      {
        label: 'Export…',
        testid: 'template-export',
        run: () => this.download([t], t.name),
      },
      null,
      {
        label: 'Delete',
        testid: 'template-delete',
        run: () =>
          void this.editor.transact(`Delete template “${t.name}”`, [
            { name: 'template.delete', args: { name: t.name } },
          ]),
      },
    ]);
  }

  /** Inserts a template at the playhead, first showing the parameters this model lacks. */
  insert(t: AnimationTemplate): void {
    const m = this.playback.current;
    if (!m) return;
    const { matched, unmatched } = templateMatch(t, this.ids());
    const time = this.playback.snap(this.playback.time);
    const run = () =>
      void this.editor.transact(`Insert template “${t.name}”`, [
        { name: 'template.apply', args: { name: t.name, target: m.uid, time } },
      ]);
    if (unmatched.length === 0) return run();
    const d = dialog(
      `Insert “${t.name}”`,
      [
        h(
          'div.facts',
          matched.length
            ? `These parameters of the template are not in this model, so their keys are left out:`
            : `None of the template's parameters is in this model, so nothing can be inserted:`,
        ),
        h(
          'ul.unmatched',
          { dataset: { testid: 'template-unmatched' } },
          unmatched.map((id) => h('li', id)),
        ),
        matched.length ? h('div.hint', `Inserted: ${matched.join(', ')}.`) : null,
        h(
          'div.hint',
          'Templates match parameters by ID; the standard parameter IDs make them work across models.',
        ),
        h(
          'div.buttons',
          matched.length
            ? h(
                'button.primary',
                {
                  dataset: { testid: 'template-insert-ok' },
                  on: {
                    click: () => {
                      d.close();
                      run();
                    },
                  },
                },
                'Insert the rest',
              )
            : null,
          h('button', { on: { click: () => d.close() } }, matched.length ? 'Cancel' : 'Close'),
        ),
      ],
      { testid: 'template-insert' },
    );
  }

  /** «New»: a name and the range, from the keys selected in the Timeline (or the whole motion). */
  newDialog(): void {
    const m = this.playback.current;
    if (!m) return;
    const times = this.timeline.selected.map((s) => s.time);
    const [from0, to0] = times.length ? [Math.min(...times), Math.max(...times)] : [0, m.duration];
    let n = this.templates.length + 1;
    while (this.templates.some((t) => t.name === `Template ${n}`)) n++;
    const name = h('input', { value: `Template ${n}`, dataset: { testid: 'template-name' } });
    const num = (v: number, testid: string) =>
      h('input', {
        type: 'number',
        min: '0',
        step: String(this.playback.frame),
        value: String(round(v, 4)),
        dataset: { testid },
      });
    const from = num(from0, 'template-from');
    const to = num(to0, 'template-to');
    const rows = this.timeline.rowList().filter((r) => this.timeline.rows.has(r.key));
    const params = rows.filter((r) => r.curve.target === 'parameter' && r.curve.object);
    const onlyRows = h('input', { type: 'checkbox', checked: params.length > 0 });
    const message = h('div.facts.error-text', { dataset: { testid: 'template-message' } });
    const d = dialog(
      'New Template',
      [
        h('label.field', h('span', 'Name'), name),
        h('label.field', h('span', 'From (s)'), from),
        h('label.field', h('span', 'To (s)'), to),
        params.length
          ? h(
              'label.toggle',
              onlyRows,
              `Only the selected rows (${params.map((r) => r.label).join(', ')})`,
            )
          : null,
        h(
          'div.hint',
          'The parameter keys in the range, with their interpolations. Part-opacity and model curves are not taken.',
        ),
        message,
        h(
          'div.buttons',
          h(
            'button.primary',
            {
              dataset: { testid: 'template-ok' },
              on: {
                click: () => {
                  const r = this.editor.transact(`New template “${name.value}”`, [
                    {
                      name: 'template.create',
                      args: {
                        name: name.value.trim(),
                        motion: m.uid,
                        from: Number(from.value),
                        to: Number(to.value),
                        ...(params.length && onlyRows.checked
                          ? { parameters: params.map((p) => p.curve.object!) }
                          : {}),
                      },
                    },
                  ]);
                  // A refusal (a taken name, no keys in the range) shows in the status bar too.
                  if (r) d.close();
                  else message.textContent = this.lastError;
                },
              },
            },
            'Create',
          ),
          h('button', { on: { click: () => d.close() } }, 'Cancel'),
        ),
      ],
      { testid: 'template-new-dialog' },
    );
    name.select();
  }

  private async rename(t: AnimationTemplate): Promise<void> {
    const next = await askText('Rename template', 'Template name', t.name);
    if (!next || next === t.name) return;
    this.editor.transact('Rename template', [
      { name: 'template.rename', args: { name: t.name, newName: next } },
    ]);
  }

  private download(templates: AnimationTemplate[], name: string): void {
    const blob = new Blob([JSON.stringify(templateFile(templates), null, 2)], {
      type: 'application/json',
    });
    const a = h('a', {
      href: URL.createObjectURL(blob),
      download: `${name.replace(/[\\/:*?"<>|]/g, '_')}.template.json`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  /** Imports template files; a template with a name already in the project replaces it. */
  async importFiles(files: Iterable<File> = this.file.files ?? []): Promise<void> {
    const list: AnimationTemplate[] = [];
    try {
      for (const f of files) list.push(...readTemplateFile(await f.text()));
    } catch (e) {
      this.editor.emit('message', { level: 'error', text: (e as Error).message });
      return;
    } finally {
      this.file.value = '';
    }
    if (!list.length) return;
    const replaced = list.filter((t) => this.templates.some((x) => x.name === t.name));
    const ok = this.editor.transact(
      'Import templates',
      list.map((t) => ({ name: 'template.add', args: { template: t, replace: true } })),
    );
    if (ok !== undefined)
      this.editor.emit('message', {
        level: 'info',
        text: `Imported ${list.length} template(s)${replaced.length ? `; replaced ${replaced.map((t) => t.name).join(', ')}` : ''}.`,
      });
  }
}
