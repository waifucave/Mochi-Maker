/**
 * Pose groups in the Parts palette: groups of parts that show one at a time, each part
 * with the parts linked to it, a fade-in time, and a preview with Mochi2D's pose. Every change is a
 * `pose.setGroups` command, which replaces the groups as a whole; it is exported as `.pose3.json`.
 */
import type { Uid } from '@mochi-maker/core';
import type { Editor } from './editor.js';
import { fill, h } from './dom.js';
import type { Viewport } from './viewport.js';

type Group = { part: Uid; links: Uid[] }[];

export class PoseSection {
  readonly el = h('div.pose-groups', { dataset: { testid: 'pose-groups' } });
  /** The part shown in each group while previewing (by group index). */
  private shown = new Map<number, Uid>();
  open = true;

  constructor(
    private readonly editor: Editor,
    private readonly viewport: Viewport,
  ) {
    editor.on('project', () => {
      this.shown.clear();
      this.viewport.setPosePreview(null);
      this.render();
    });
    editor.on('document', (e) => {
      if (e.changes.some((c) => c.kind === 'project' || c.kind === 'part')) {
        if (this.previewing) this.applyPreview();
        this.render();
      }
    });
    editor.on('selection', () => this.render());
    this.render();
  }

  get groups(): Group[] {
    return structuredClone(this.editor.view.project().pose.groups) as Group[];
  }

  get previewing(): boolean {
    return this.viewport.posePreview !== null;
  }

  /** Writes the groups (and the fade-in) as one command. */
  write(groups: Group[], label: string, fadeIn = this.editor.view.project().pose.fadeIn): boolean {
    const r = this.editor.transact(label, [
      { name: 'pose.setGroups', args: { fadeIn, groups: groups.filter((g) => g.length > 0) } },
    ]);
    return r !== undefined;
  }

  private selectedParts(): Uid[] {
    return this.editor.selection.uids.filter((u) => this.editor.view.get(u)?.kind === 'part');
  }

  /** A new group from the selected parts (parts already in a group move to the new one). */
  newGroup(): void {
    const parts = this.selectedParts();
    if (parts.length === 0)
      return void this.editor.emit('message', {
        level: 'error',
        text: 'Select parts in the Parts palette first.',
      });
    const groups = this.groups.map((g) => g.filter((e) => !parts.includes(e.part)));
    groups.push(parts.map((part) => ({ part, links: [] })));
    this.write(groups, 'New pose group');
  }

  addToGroup(gi: number): void {
    const parts = this.selectedParts();
    const groups = this.groups.map((g, i) =>
      i === gi ? g : g.filter((e) => !parts.includes(e.part)),
    );
    for (const part of parts)
      if (!groups[gi]!.some((e) => e.part === part)) groups[gi]!.push({ part, links: [] });
    this.write(groups, 'Add to pose group');
  }

  /** Previewing: Mochi2D's pose runs, and the chosen part of each group is the one shown. */
  setPreview(on: boolean): void {
    if (on) this.applyPreview();
    else this.viewport.setPosePreview(null);
    this.render();
  }

  private applyPreview(): void {
    const v = this.editor.view;
    const opacities = new Map<string, number>();
    this.groups.forEach((g, gi) => {
      const chosen =
        this.shown.get(gi) ??
        g.find((e) => v.getAs(e.part, 'part').visibleAtStart)?.part ??
        g[0]?.part;
      for (const e of g) {
        const p = v.get(e.part);
        if (p?.kind === 'part') opacities.set(p.exportId, e.part === chosen ? 1 : 0);
      }
    });
    this.viewport.setPosePreview(opacities);
  }

  show(gi: number, part: Uid): void {
    this.shown.set(gi, part);
    if (this.previewing) this.applyPreview();
    this.render();
  }

  render(): void {
    const v = this.editor.view;
    const groups = this.groups;
    const fade = v.project().pose.fadeIn;
    const label = (u: Uid) => {
      const o = v.get(u);
      return o && 'exportId' in o ? o.exportId : u;
    };
    const parts = v.ofKind('part');
    const sel = this.selectedParts();
    fill(
      this.el,
      h(
        'div.pose-head',
        h(
          'button.step',
          {
            title: this.open ? 'Fold' : 'Unfold',
            on: { click: () => ((this.open = !this.open), this.render()) },
          },
          this.open ? '▾' : '▸',
        ),
        h('b', 'Pose'),
        h('span.extra', `${groups.length} group${groups.length === 1 ? '' : 's'}`),
      ),
      this.open
        ? [
            h(
              'div.palette-bar',
              h(
                'button',
                {
                  disabled: sel.length === 0,
                  dataset: { testid: 'pose-new-group' },
                  title: 'A group of the selected parts: they show one at a time',
                  on: { click: () => this.newGroup() },
                },
                'New group from selection',
              ),
              h(
                'label.toggle',
                h('input', {
                  type: 'checkbox',
                  checked: this.previewing,
                  dataset: { testid: 'pose-preview' },
                  on: { change: (e) => this.setPreview((e.target as HTMLInputElement).checked) },
                }),
                'Preview',
              ),
              h(
                'label.toggle',
                { title: 'Fade-in time in seconds (empty: the default)' },
                'Fade',
                h('input.num', {
                  type: 'number',
                  min: '0',
                  step: '0.1',
                  placeholder: 'default',
                  value: fade === null ? '' : String(fade),
                  on: {
                    change: (e) => {
                      const s = (e.target as HTMLInputElement).value;
                      this.write(this.groups, 'Pose fade', s === '' ? null : Number(s));
                    },
                  },
                }),
              ),
            ),
            groups.length === 0
              ? h(
                  'div.hint',
                  'Select two or more parts (such as arm variants), then New group: the pose shows one of them at a time.',
                )
              : null,
            groups.map((g, gi) =>
              h(
                'div.pose-group',
                { dataset: { poseGroup: String(gi + 1) } },
                h(
                  'div.pose-group-head',
                  h('span', `Group ${gi + 1}`),
                  g.length < 2 ? h('span.warn', ' · needs two parts or more') : null,
                  h(
                    'button.step',
                    {
                      disabled: sel.length === 0,
                      title: 'Add the selected parts',
                      on: { click: () => this.addToGroup(gi) },
                    },
                    '+ selection',
                  ),
                  h(
                    'button.step',
                    {
                      title: 'Remove the group',
                      on: {
                        click: () =>
                          this.write(
                            groups.filter((_, i) => i !== gi),
                            'Remove pose group',
                          ),
                      },
                    },
                    '×',
                  ),
                ),
                g.map((e, ei) =>
                  h(
                    'div.pose-entry',
                    h('input', {
                      type: 'radio',
                      name: `pose-${gi}`,
                      title: 'Show this one in the preview',
                      checked:
                        (this.shown.get(gi) ??
                          g.find((x) => v.getAs(x.part, 'part').visibleAtStart)?.part ??
                          g[0]?.part) === e.part,
                      dataset: { testid: `pose-show-${label(e.part)}` },
                      on: { change: () => this.show(gi, e.part) },
                    }),
                    h(
                      'span.name',
                      { on: { click: () => this.editor.select(e.part) } },
                      label(e.part),
                    ),
                    h(
                      'select',
                      {
                        multiple: true,
                        size: 1,
                        title: 'Linked parts: they show and hide with this one',
                        dataset: { testid: `pose-links-${label(e.part)}` },
                        on: {
                          change: (ev) => {
                            const links = [...(ev.target as HTMLSelectElement).selectedOptions].map(
                              (o) => o.value,
                            );
                            const next = this.groups;
                            next[gi]![ei]!.links = links;
                            this.write(next, 'Pose links');
                          },
                        },
                      },
                      parts
                        .filter((p) => p.uid !== e.part)
                        .map((p) =>
                          h(
                            'option',
                            { value: p.uid, selected: e.links.includes(p.uid) },
                            p.exportId,
                          ),
                        ),
                    ),
                    e.links.length ? h('span.extra', `+${e.links.length} linked`) : null,
                    h(
                      'button.step',
                      {
                        title: 'Take it out of the group',
                        on: {
                          click: () => {
                            const next = this.groups;
                            next[gi]!.splice(ei, 1);
                            this.write(next, 'Remove from pose group');
                          },
                        },
                      },
                      '×',
                    ),
                  ),
                ),
              ),
            ),
          ]
        : null,
    );
  }
}
