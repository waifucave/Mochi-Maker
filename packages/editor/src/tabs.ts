/**
 * The View area's tabs: one per view of the open model. Each tab keeps its
 * own parameter values and display position, and has a kind (a Modeling View or an Animation
 * View) that picks its workspace when selected. Tabs can be duplicated, closed, reordered by
 * dragging, and stepped through; all can be put at the same display position.
 */
import type { Uid } from '@mochi-maker/core';
import { Emitter, type Editor } from './editor.js';
import { fill, h } from './dom.js';
import type { Dock, TabKind } from './dock.js';
import type { Viewport } from './viewport.js';
import type { SettingsStore } from './settings.js';
import { popupMenu } from './panels.js';

export interface ViewTab {
  id: number;
  kind: TabKind;
  pose: Map<Uid, number>;
  view: { zoom: number; x: number; y: number; rotation: number } | null;
  flipped: boolean;
}

export class ViewTabs extends Emitter<{ switch: ViewTab }> {
  readonly el = h('div.view-tabs', { dataset: { testid: 'view-tabs' } });
  tabs: ViewTab[] = [];
  current!: ViewTab;
  private next = 1;
  private dragging: ViewTab | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly viewport: Viewport,
    private readonly dock: Dock,
    private readonly settings: SettingsStore,
  ) {
    super();
    this.reset();
    editor.on('project', () => this.reset());
  }

  private make(kind: TabKind): ViewTab {
    return { id: this.next++, kind, pose: new Map(), view: null, flipped: false };
  }

  /** One Modeling View, for a newly opened project. */
  reset(): void {
    this.tabs = [this.make('modeling')];
    this.current = this.tabs[0]!;
    this.render();
  }

  private title(t: ViewTab): string {
    const n = this.tabs.filter((x) => x.kind === t.kind).indexOf(t);
    const kind = t.kind === 'modeling' ? 'Modeling View' : 'Animation View';
    return `${this.editor.name} · ${kind}${n > 0 ? ` ${n + 1}` : ''}`;
  }

  /** Saves the shown state into the current tab. */
  private keep(): void {
    this.current.pose = new Map(this.editor.pose);
    this.current.view = this.viewport.view.model
      ? { ...this.viewport.view.viewTransform }
      : this.current.view;
    this.current.flipped = this.viewport.flipped;
  }

  select(t: ViewTab): void {
    if (t === this.current) return;
    this.keep();
    this.apply(t);
  }

  /** Shows a tab's state (without saving the one shown). */
  private apply(t: ViewTab): void {
    this.current = t;
    this.editor.pose.clear();
    for (const [k, v] of t.pose) if (this.editor.view.get(k)) this.editor.pose.set(k, v);
    this.editor.emit('pose', undefined);
    if (t.view && this.viewport.view.model) this.viewport.view.setView(t.view);
    this.viewport.setFlipped(t.flipped);
    if (this.settings.value.autoSwitchWorkspace) {
      const w = this.dock.workspaceFor(t.kind);
      if (w) this.dock.switchTo(w.id);
    }
    this.render();
    this.emit('switch', t);
  }

  add(kind: TabKind): ViewTab {
    this.keep();
    const t = this.make(kind);
    t.pose = new Map(this.editor.pose);
    t.view = this.current.view;
    this.tabs.push(t);
    this.select(t);
    return t;
  }

  duplicate(t: ViewTab = this.current): void {
    this.keep();
    const c: ViewTab = {
      id: this.next++,
      kind: t.kind,
      pose: new Map(t.pose),
      view: t.view ? { ...t.view } : null,
      flipped: t.flipped,
    };
    this.tabs.splice(this.tabs.indexOf(t) + 1, 0, c);
    this.select(c);
  }

  /** Closes a tab. The last one stays: the View area always shows the model. */
  close(t: ViewTab = this.current): void {
    if (this.tabs.length === 1) {
      this.editor.emit('message', { level: 'info', text: 'The last view stays open.' });
      return;
    }
    const i = this.tabs.indexOf(t);
    this.tabs.splice(i, 1);
    if (t === this.current) this.apply(this.tabs[Math.min(i, this.tabs.length - 1)]!);
    this.render();
  }

  closeOthers(t: ViewTab = this.current): void {
    this.select(t);
    this.tabs = [t];
    this.render();
  }

  /** Closes every tab but leaves one Modeling View at the current state. */
  closeAll(): void {
    this.keep();
    const t = {
      ...this.make('modeling'),
      pose: new Map(this.editor.pose),
      view: this.current.view,
    };
    this.tabs = [t];
    this.apply(t);
  }

  step(by: -1 | 1): void {
    const i = this.tabs.indexOf(this.current);
    this.select(this.tabs[(i + by + this.tabs.length) % this.tabs.length]!);
  }

  /** Puts every view at the current one's display position. */
  sameDisplayPosition(): void {
    this.keep();
    for (const t of this.tabs) t.view = this.current.view ? { ...this.current.view } : null;
  }

  render(): void {
    fill(
      this.el,
      this.tabs.map((t) =>
        h(
          'div.view-tab',
          {
            class: t === this.current ? 'on' : '',
            draggable: true,
            dataset: { viewTab: String(t.id), kind: t.kind },
            on: {
              click: () => this.select(t),
              dragstart: () => (this.dragging = t),
              dragover: (e) => e.preventDefault(),
              drop: (e) => {
                e.preventDefault();
                const d = this.dragging;
                this.dragging = null;
                if (!d || d === t) return;
                this.tabs.splice(this.tabs.indexOf(d), 1);
                this.tabs.splice(this.tabs.indexOf(t), 0, d);
                this.render();
              },
              contextmenu: (e) => {
                e.preventDefault();
                popupMenu(e as MouseEvent, [
                  { label: 'Duplicate', run: () => this.duplicate(t) },
                  { label: 'Close', run: () => this.close(t) },
                  { label: 'Close Others', run: () => this.closeOthers(t) },
                  { label: 'Close All', run: () => this.closeAll() },
                ]);
              },
            },
          },
          h('span.tab-icon', t.kind === 'modeling' ? '◆' : '▶'),
          h('span', this.title(t)),
          h(
            'button.tab-close',
            {
              title: 'Close',
              on: {
                click: (e) => {
                  e.stopPropagation();
                  this.close(t);
                },
              },
            },
            '×',
          ),
        ),
      ),
    );
  }
}
