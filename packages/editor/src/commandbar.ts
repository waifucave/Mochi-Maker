/**
 * The command bar (design 3.10): every command and operation by name, searchable, with its
 * documentation and typed arguments as JSON. What runs here is exactly what the agent API runs.
 */
import { runItems, type CommandDescription } from '@mochi-maker/core';
import { OPERATIONS } from '@mochi-maker/export';
import type { Editor } from './editor.js';
import type { AgentSurface } from './agent.js';
import { fill, h } from './dom.js';

export class CommandBar {
  readonly el = h('div.commandbar', { hidden: true, dataset: { testid: 'command-bar' } });
  private readonly input = h('input.cmd-search', {
    placeholder: 'Search commands: name, area or words from the docs',
    dataset: { testid: 'command-search' },
  });
  private readonly list = h('div.cmd-list');
  private readonly detail = h('div.cmd-detail');
  private current: CommandDescription | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly agent: AgentSurface,
  ) {
    const box = h(
      'div.cmd-box',
      { on: { click: (e) => e.stopPropagation() } },
      this.input,
      h('div.cmd-body', this.list, this.detail),
    );
    this.el.append(box);
    this.el.addEventListener('click', () => this.close());
    this.input.addEventListener('input', () => this.search());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      if (e.key === 'Enter')
        (this.list.querySelector('button') as HTMLButtonElement | null)?.click();
    });
  }

  open(name?: string): void {
    this.el.hidden = false;
    this.input.value = name ?? '';
    this.search();
    if (name) this.show(name);
    else this.input.focus();
  }

  close(): void {
    this.el.hidden = true;
  }

  private search(): void {
    const q = this.input.value.trim();
    const items = q ? this.agent.describe({ search: q }) : this.agent.describe();
    fill(
      this.list,
      (items as { name: string; summary: string }[]).slice(0, 60).map((c) =>
        h(
          'button.cmd-item',
          {
            class: this.current?.name === c.name ? 'on' : '',
            dataset: { command: c.name },
            on: { click: () => this.show(c.name) },
          },
          h('b', c.name),
          h('span', c.summary),
        ),
      ),
    );
  }

  private show(name: string): void {
    const d = this.agent.describe(name) as CommandDescription;
    this.current = d;
    const example = d.examples[0]?.args as Record<string, unknown> | undefined;
    const args: Record<string, unknown> = example ? structuredClone(example) : {};
    const sel = this.editor.selection.uid;
    const props = (d.args as { properties?: Record<string, unknown> }).properties ?? {};
    if (sel && 'target' in props) {
      args.target = sel;
      // Name the keyform at the current pose, when the command takes one.
      if ('cell' in props) {
        const at = this.editor.cellAtPose(sel);
        if (at.ok) args.cell = at.cell;
        else delete args.cell;
      }
    }
    if (sel && 'vertices' in props && this.editor.selection.vertices.length)
      args.vertices = this.editor.selection.vertices;
    const text = h('textarea.cmd-args', { spellcheck: false, dataset: { testid: 'command-args' } });
    text.value = JSON.stringify(args, null, 2);
    const out = h('pre.cmd-out', { dataset: { testid: 'command-output' } });
    const run = async (dryRun: boolean) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.value);
      } catch (e) {
        out.textContent = `The arguments are not valid JSON: ${(e as Error).message}`;
        out.className = 'cmd-out error';
        return;
      }
      try {
        const r = await runItems(
          { session: this.editor.session, assets: this.editor.assets, fs: this.editor.fs },
          d.name,
          [{ name: d.name, args: parsed }],
          { author: 'person', dryRun, operations: OPERATIONS },
        );
        out.className = 'cmd-out';
        out.textContent = JSON.stringify(
          {
            committed: r.committed,
            revision: r.revision,
            result: r.itemResults[0],
            changes: r.changes.length,
          },
          null,
          2,
        );
      } catch (e) {
        out.className = 'cmd-out error';
        out.textContent = JSON.stringify(this.agent.errorJson(e), null, 2);
      }
    };
    fill(
      this.detail,
      h('h3', d.name),
      h('div.cmd-summary', d.summary),
      h('div.cmd-doc', d.doc),
      d.errors.length
        ? h('div.cmd-errors', `Errors: ${d.errors.map((e) => e.code).join(', ')}`)
        : null,
      text,
      h(
        'div.buttons',
        h(
          'button.primary',
          { dataset: { testid: 'command-run' }, on: { click: () => void run(false) } },
          'Run',
        ),
        h('button', { on: { click: () => void run(true) } }, 'Dry run'),
        h('button', { on: { click: () => this.close() } }, 'Close'),
      ),
      out,
    );
    this.search();
  }
}
