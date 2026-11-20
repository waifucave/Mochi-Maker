/**
 * Palettes, docking and workspaces (1.3 and 2.1).
 *
 * - Palettes dock in three regions around the View area: left and right (groups stacked top to
 *   bottom) and bottom (groups side by side). A group shows one palette at a time, with a tab for
 *   each.
 * - Dragging a palette's tab: dropped between two groups it becomes a new group there (a marker
 *   shows the place); dropped onto a group it joins it as a tab; dropped over the View area or
 *   outside the regions it floats. Dragging the empty strip next to a group's tabs moves the whole
 *   group. A floating window can be moved, resized, closed, and can take further palettes.
 * - Each workspace keeps its own layout, saved as it changes, with a reset to its initial layout.
 *   The presets are Modeling and Animation; custom workspaces start from the current layout.
 */
import { Emitter } from './editor.js';
import { fill, h } from './dom.js';
import { store } from './settings.js';

export type TabKind = 'modeling' | 'animation';

export interface Palette {
  id: string;
  title: string;
  el: HTMLElement;
}

export interface Group {
  tabs: string[];
  active: string;
  /** Share of the region's length (flex weight). */
  size: number;
}

export interface FloatingGroup extends Group {
  x: number;
  y: number;
  w: number;
  h: number;
}

type RegionName = 'left' | 'right' | 'bottom';
export interface Region {
  /** Width (left, right) or height (bottom), in CSS pixels. */
  size: number;
  groups: Group[];
}

export interface Layout {
  left: Region;
  right: Region;
  bottom: Region;
  floating: FloatingGroup[];
  /** Every palette hidden, to enlarge the canvas (Window › Hide All Palettes). */
  hideAll: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  builtIn: boolean;
  initial: Layout;
  current: Layout;
  /** The tab kinds that switch to this workspace when selected. */
  autoFor: TabKind[];
}

const g = (tabs: string[], size = 1): Group => ({ tabs, active: tabs[0]!, size });

/**
 * The preset layouts. UNKNOWN items 1 and 2 (default palette positions and which palettes each
 * workspace shows): only Parts at the upper left and Parameter on the left are documented; the
 * rest is our choice, and every placement can be changed and saved.
 */
export function presetLayout(kind: TabKind): Layout {
  if (kind === 'animation')
    return {
      left: { size: 260, groups: [g(['scene', 'parts']), g(['parameter', 'expression'], 1.4)] },
      right: { size: 300, groups: [g(['inspector'], 1.4), g(['template'])] },
      bottom: { size: 230, groups: [g(['timeline'], 2.2), g(['log', 'history', 'agents'])] },
      floating: [],
      hideAll: false,
    };
  return {
    left: { size: 260, groups: [g(['parts', 'deformer']), g(['parameter', 'expression'])] },
    right: { size: 310, groups: [g(['inspector'], 1.3), g(['toolDetails'], 0.7)] },
    bottom: {
      size: 180,
      groups: [
        g(['log', 'history', 'validation', 'agents', 'art', 'preview', 'drawOrder', 'project']),
      ],
    },
    floating: [],
    hideAll: false,
  };
}

const PRESETS = (): Workspace[] => [
  {
    id: 'modeling',
    name: 'Modeling',
    builtIn: true,
    initial: presetLayout('modeling'),
    current: presetLayout('modeling'),
    autoFor: ['modeling'],
  },
  {
    id: 'animation',
    name: 'Animation',
    builtIn: true,
    initial: presetLayout('animation'),
    current: presetLayout('animation'),
    autoFor: ['animation'],
  },
];

const KEY = 'mochi-maker.workspaces';
const clone = <T>(v: T): T => structuredClone(v);

type DropTarget =
  | { kind: 'tab'; region: RegionName | 'floating'; group: number }
  | { kind: 'insert'; region: RegionName; index: number }
  | { kind: 'float'; x: number; y: number };

interface Dragging {
  /** What moves: one palette, or a whole group. */
  tabs: string[];
  from: { region: RegionName | 'floating'; group: number };
  x0: number;
  y0: number;
  started: boolean;
  ghost: HTMLElement;
  target: DropTarget | null;
}

export class Dock extends Emitter<{ layout: void; workspace: Workspace }> {
  readonly palettes = new Map<string, Palette>();
  workspaces: Workspace[];
  activeId: string;
  readonly left = h('aside.dock.dock-left', { dataset: { region: 'left' } });
  readonly right = h('aside.dock.dock-right', { dataset: { region: 'right' } });
  readonly bottom = h('section.dock.dock-bottom', { dataset: { region: 'bottom' } });
  readonly floatLayer = h('div.float-layer');
  private readonly marker = h('div.drop-marker', { hidden: true });
  private drag: Dragging | null = null;
  /** A palette is being dragged: empty regions show as drop zones. */
  docking = false;
  /** Called when the layout's region sizes change, to update the window grid. */
  onResize: () => void = () => {};

  constructor(private readonly view: HTMLElement) {
    super();
    const saved = store.get<{ workspaces: Workspace[]; active: string }>(KEY);
    this.workspaces = saved?.workspaces?.length ? saved.workspaces : PRESETS();
    // Presets that a stored list lacks (a newer version's) are added back.
    for (const p of PRESETS())
      if (!this.workspaces.some((w) => w.id === p.id)) this.workspaces.push(p);
    this.activeId = this.workspaces.some((w) => w.id === saved?.active)
      ? saved!.active
      : 'modeling';
    document.body.append(this.marker);
    window.addEventListener('pointermove', (e) => this.dragMove(e));
    window.addEventListener('pointerup', (e) => this.dragEnd(e));
  }

  register(p: Palette): void {
    p.el.classList.add('palette');
    p.el.dataset.palette = p.id;
    this.palettes.set(p.id, p);
  }

  get workspace(): Workspace {
    return this.workspaces.find((w) => w.id === this.activeId)!;
  }

  get layout(): Layout {
    return this.workspace.current;
  }

  private save(): void {
    store.set(KEY, { workspaces: this.workspaces, active: this.activeId });
  }

  private changed(): void {
    this.save();
    this.render();
    this.emit('layout', undefined);
  }

  // ---------------------------------------------------------------- workspaces

  switchTo(id: string): void {
    if (id === this.activeId || !this.workspaces.some((w) => w.id === id)) return;
    this.activeId = id;
    this.changed();
    this.emit('workspace', this.workspace);
  }

  /** The workspace that a kind of tab switches to. */
  workspaceFor(kind: TabKind): Workspace | undefined {
    return this.workspaces.find((w) => w.autoFor.includes(kind));
  }

  resetLayout(): void {
    this.workspace.current = clone(this.workspace.initial);
    this.changed();
  }

  /** A new custom workspace from the current layout. */
  addWorkspace(name: string): Workspace {
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'workspace';
    while (this.workspaces.some((w) => w.id === id)) id += '-2';
    const w: Workspace = {
      id,
      name,
      builtIn: false,
      initial: clone(this.layout),
      current: clone(this.layout),
      autoFor: [],
    };
    this.workspaces.push(w);
    this.save();
    this.emit('layout', undefined);
    return w;
  }

  renameWorkspace(id: string, name: string): void {
    const w = this.workspaces.find((x) => x.id === id);
    if (w && name.trim()) w.name = name.trim();
    this.changed();
  }

  moveWorkspace(id: string, by: -1 | 1): void {
    const i = this.workspaces.findIndex((w) => w.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= this.workspaces.length) return;
    [this.workspaces[i], this.workspaces[j]] = [this.workspaces[j]!, this.workspaces[i]!];
    this.changed();
  }

  deleteWorkspace(id: string): void {
    const w = this.workspaces.find((x) => x.id === id);
    if (!w || w.builtIn) return;
    this.workspaces = this.workspaces.filter((x) => x !== w);
    if (this.activeId === id) this.activeId = 'modeling';
    this.changed();
    this.emit('workspace', this.workspace);
  }

  /** Sets which tab kinds switch to a workspace (each kind to one workspace). */
  setAutoFor(id: string, kind: TabKind, on: boolean): void {
    for (const w of this.workspaces) {
      w.autoFor = w.autoFor.filter((k) => k !== kind);
      if (on && w.id === id) w.autoFor.push(kind);
    }
    this.changed();
  }

  /** Makes the current arrangement the custom workspace's new initial layout. */
  saveAsInitial(): boolean {
    if (this.workspace.builtIn) return false;
    this.workspace.initial = clone(this.layout);
    this.save();
    return true;
  }

  // ---------------------------------------------------------------- showing and hiding

  /** Where a palette is in the current layout. */
  find(id: string): { region: RegionName | 'floating'; group: number } | null {
    const L = this.layout;
    for (const r of ['left', 'right', 'bottom'] as const) {
      const i = L[r].groups.findIndex((x) => x.tabs.includes(id));
      if (i >= 0) return { region: r, group: i };
    }
    const f = L.floating.findIndex((x) => x.tabs.includes(id));
    return f >= 0 ? { region: 'floating', group: f } : null;
  }

  isShown(id: string): boolean {
    return this.find(id) !== null && !this.layout.hideAll;
  }

  /** Shows a palette (where the workspace's initial layout has it, or floating) and brings it up. */
  show(id: string): void {
    const L = this.layout;
    L.hideAll = false;
    const at = this.find(id);
    if (at) {
      this.groupAt(at).active = id;
      this.changed();
      return;
    }
    const init = this.workspace.initial;
    for (const r of ['left', 'right', 'bottom'] as const) {
      const ig = init[r].groups.find((x) => x.tabs.includes(id));
      if (!ig) continue;
      // Join a group that shares a palette with the initial one, else a new group.
      const near = L[r].groups.find((x) => x.tabs.some((t) => ig.tabs.includes(t)));
      if (near) {
        near.tabs.push(id);
        near.active = id;
      } else L[r].groups.push(g([id]));
      this.changed();
      return;
    }
    L.floating.push({ ...g([id]), x: 160, y: 120, w: 340, h: 300 });
    this.changed();
  }

  hide(id: string): void {
    const at = this.find(id);
    if (!at) return;
    this.removeTabs([id], at);
    this.changed();
  }

  toggle(id: string): void {
    if (this.isShown(id)) this.hide(id);
    else this.show(id);
  }

  setHideAll(on: boolean): void {
    this.layout.hideAll = on;
    this.changed();
  }

  // ---------------------------------------------------------------- layout edits

  private groupAt(at: { region: RegionName | 'floating'; group: number }): Group {
    return at.region === 'floating'
      ? this.layout.floating[at.group]!
      : this.layout[at.region].groups[at.group]!;
  }

  private removeTabs(tabs: string[], at: { region: RegionName | 'floating'; group: number }): void {
    const grp = this.groupAt(at);
    grp.tabs = grp.tabs.filter((t) => !tabs.includes(t));
    if (!grp.tabs.includes(grp.active)) grp.active = grp.tabs[0] ?? '';
    if (grp.tabs.length === 0) {
      if (at.region === 'floating') this.layout.floating.splice(at.group, 1);
      else this.layout[at.region].groups.splice(at.group, 1);
    }
  }

  /** Moves palettes to a drop target (the drag's result; also used by tests). */
  move(tabs: string[], target: DropTarget): void {
    const L = this.layout;
    const sources = tabs.map((t) => this.find(t)).filter((x) => x !== null);
    // Remove from the sources, keeping track of the target's group when indices shift.
    let targetGroup: Group | null =
      target.kind === 'tab'
        ? target.region === 'floating'
          ? L.floating[target.group]!
          : L[target.region].groups[target.group]!
        : null;
    let insertBefore: Group | null =
      target.kind === 'insert' ? (L[target.region].groups[target.index] ?? null) : null;
    for (const s of sources) {
      const grp = this.groupAt(s!);
      if (grp === targetGroup) continue;
      this.removeTabs(tabs, s!);
    }
    if (target.kind === 'tab' && targetGroup) {
      for (const t of tabs) if (!targetGroup.tabs.includes(t)) targetGroup.tabs.push(t);
      targetGroup.active = tabs[0]!;
    } else if (target.kind === 'insert') {
      const groups = L[target.region].groups;
      if (insertBefore && !groups.includes(insertBefore)) insertBefore = null;
      const i = insertBefore ? groups.indexOf(insertBefore) : groups.length;
      groups.splice(Math.min(i, groups.length), 0, g(tabs));
    } else if (target.kind === 'float') {
      L.floating.push({ ...g(tabs), x: target.x, y: target.y, w: 340, h: 300 });
    }
    targetGroup = null;
    this.changed();
  }

  // ---------------------------------------------------------------- rendering

  render(): void {
    const L = this.layout;
    for (const r of ['left', 'right', 'bottom'] as const) {
      const el = this[r];
      const groups = L.hideAll ? [] : L[r].groups;
      fill(
        el,
        groups.flatMap((grp, i) => [
          i > 0 ? this.groupSplitter(r, i) : null,
          this.groupEl(grp, { region: r, group: i }),
        ]),
      );
      el.classList.toggle('empty', groups.length === 0);
    }
    fill(this.floatLayer, L.hideAll ? [] : L.floating.map((f, i) => this.floatingEl(f, i)));
    // Palettes not shown anywhere are detached (they keep their state).
    this.onResize();
  }

  /** Width or height of a region as shown (0 when empty or hidden). */
  regionSize(r: RegionName): number {
    const L = this.layout;
    if (L.hideAll || L[r].groups.length === 0) return this.docking && !L.hideAll ? 36 : 0;
    return L[r].size;
  }

  private groupEl(grp: Group, at: { region: RegionName | 'floating'; group: number }): HTMLElement {
    const active = this.palettes.get(grp.active);
    const strip = h('div.group-strip', {
      title: 'Drag to move the whole group',
      on: { pointerdown: (e) => this.dragStart(e as PointerEvent, grp.tabs, at) },
    });
    const tabs = h(
      'div.group-tabs',
      grp.tabs.map((t) =>
        h(
          'button.dock-tab',
          {
            class: t === grp.active ? 'on' : '',
            dataset: { tab: t },
            on: {
              click: () => {
                grp.active = t;
                this.changed();
              },
              pointerdown: (e) => this.dragStart(e as PointerEvent, [t], at),
              contextmenu: (e) => {
                e.preventDefault();
                this.tabMenu(e as MouseEvent, t);
              },
            },
          },
          this.palettes.get(t)?.title ?? t,
        ),
      ),
      strip,
    );
    const body = h('div.group-body', active ? active.el : null);
    // Palettes that skip work while hidden catch up when shown.
    if (active) queueMicrotask(() => active.el.dispatchEvent(new Event('shown')));
    return h(
      'div.dock-group',
      {
        dataset: { region: at.region, group: String(at.group) },
        style: at.region === 'floating' ? '' : `flex:${grp.size} 1 0`,
      },
      tabs,
      body,
    );
  }

  private floatingEl(f: FloatingGroup, i: number): HTMLElement {
    const el = this.groupEl(f, { region: 'floating', group: i });
    el.classList.add('floating');
    el.style.cssText = `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px`;
    const close = h(
      'button.float-close',
      {
        title: 'Close',
        on: {
          click: () => {
            this.layout.floating.splice(i, 1);
            this.changed();
          },
        },
      },
      '×',
    );
    el.querySelector('.group-tabs')!.append(close);
    // The empty strip moves the window; the window's corner resizes it.
    const strip = el.querySelector<HTMLElement>('.group-strip')!;
    strip.title = 'Drag to move this window';
    strip.replaceWith(strip.cloneNode());
    const newStrip = el.querySelector<HTMLElement>('.group-strip')!;
    newStrip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [x0, y0, fx, fy] = [e.clientX, e.clientY, f.x, f.y];
      const move = (m: PointerEvent) => {
        f.x = Math.max(0, fx + m.clientX - x0);
        f.y = Math.max(0, fy + m.clientY - y0);
        el.style.left = `${f.x}px`;
        el.style.top = `${f.y}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.save();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width && (Math.abs(r.width - f.w) > 1 || Math.abs(r.height - f.h) > 1)) {
        f.w = Math.round(r.width);
        f.h = Math.round(r.height);
        this.save();
      }
    }).observe(el);
    return el;
  }

  private groupSplitter(r: RegionName, i: number): HTMLElement {
    const el = h('div.group-splitter', { class: r === 'bottom' ? 'v' : 'h' });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const groups = this.layout[r].groups;
      const a = groups[i - 1]!;
      const b = groups[i]!;
      const elA = el.previousElementSibling as HTMLElement;
      const elB = el.nextElementSibling as HTMLElement;
      const len = (x: HTMLElement) =>
        r === 'bottom' ? x.getBoundingClientRect().width : x.getBoundingClientRect().height;
      const [la, lb, sa, sb] = [len(elA), len(elB), a.size, b.size];
      const p0 = r === 'bottom' ? e.clientX : e.clientY;
      const move = (m: PointerEvent) => {
        const d = (r === 'bottom' ? m.clientX : m.clientY) - p0;
        const na = Math.max(40, la + d);
        const nb = Math.max(40, la + lb - na);
        a.size = ((sa + sb) * na) / (na + nb);
        b.size = ((sa + sb) * nb) / (na + nb);
        elA.style.flex = `${a.size} 1 0`;
        elB.style.flex = `${b.size} 1 0`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.save();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return el;
  }

  /** A splitter between a region and the View area. */
  regionSplitter(r: RegionName): HTMLElement {
    const el = h('div.region-splitter', { class: r, dataset: { splitter: r } });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const reg = this.layout[r];
      const [x0, y0, s0] = [e.clientX, e.clientY, reg.size];
      const move = (m: PointerEvent) => {
        const d = r === 'left' ? m.clientX - x0 : r === 'right' ? x0 - m.clientX : y0 - m.clientY;
        reg.size = Math.max(120, Math.min(900, s0 + d));
        this.onResize();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.save();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return el;
  }

  private tabMenu(e: MouseEvent, id: string): void {
    document.querySelector('.ctx-menu.dock-menu')?.remove();
    const menu = h(
      'div.ctx-menu.dock-menu',
      { style: `left:${e.clientX}px;top:${e.clientY}px` },
      h(
        'button',
        {
          dataset: { testid: 'tab-close' },
          on: {
            click: () => {
              menu.remove();
              this.hide(id);
            },
          },
        },
        `Close ${this.palettes.get(id)?.title ?? id}`,
      ),
      h(
        'button',
        {
          on: {
            click: () => {
              menu.remove();
              const r = this.view.getBoundingClientRect();
              this.move([id], { kind: 'float', x: r.left + 40, y: r.top + 40 });
            },
          },
        },
        'Float',
      ),
    );
    document.body.append(menu);
    const away = (ev: PointerEvent) => {
      if (menu.contains(ev.target as Node)) return;
      menu.remove();
      window.removeEventListener('pointerdown', away, true);
    };
    setTimeout(() => window.addEventListener('pointerdown', away, true));
  }

  // ---------------------------------------------------------------- dragging palettes

  private dragStart(
    e: PointerEvent,
    tabs: string[],
    from: { region: RegionName | 'floating'; group: number },
  ): void {
    if (e.button !== 0) return;
    this.drag = {
      tabs,
      from,
      x0: e.clientX,
      y0: e.clientY,
      started: false,
      ghost: h('div.drag-ghost', tabs.map((t) => this.palettes.get(t)?.title ?? t).join(', ')),
      target: null,
    };
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
      d.started = true;
      document.body.append(d.ghost);
      document.body.classList.add('docking');
      this.docking = true;
      this.onResize();
    }
    d.ghost.style.left = `${e.clientX + 12}px`;
    d.ghost.style.top = `${e.clientY + 8}px`;
    d.target = this.targetAt(e.clientX, e.clientY);
    this.showMarker(d.target);
  }

  private dragEnd(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    d.ghost.remove();
    this.marker.hidden = true;
    document.body.classList.remove('docking');
    if (!d.started) return;
    this.docking = false;
    this.onResize();
    const t = d.target ?? this.targetAt(e.clientX, e.clientY);
    // Dropping a palette onto its own single-tab group changes nothing.
    if (t.kind === 'tab' && t.region === d.from.region && t.group === d.from.group) return;
    this.move(d.tabs, t);
  }

  /** The drop target under a point. */
  targetAt(x: number, y: number): DropTarget {
    const groups = [
      ...document.querySelectorAll<HTMLElement>('.dock .dock-group, .float-layer .dock-group'),
    ];
    for (const el of groups) {
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const region = el.dataset.region as RegionName | 'floating';
      const group = Number(el.dataset.group);
      if (region === 'floating') return { kind: 'tab', region, group };
      // Near the leading or trailing edge: a new group there; else join as a tab.
      const along = region === 'bottom' ? (x - r.left) / r.width : (y - r.top) / r.height;
      if (along < 0.22) return { kind: 'insert', region, index: group };
      if (along > 0.78) return { kind: 'insert', region, index: group + 1 };
      return { kind: 'tab', region, group };
    }
    for (const r of ['left', 'right', 'bottom'] as const) {
      const rect = this[r].getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
        return { kind: 'insert', region: r, index: this.layout[r].groups.length };
    }
    return { kind: 'float', x: Math.max(0, x - 40), y: Math.max(0, y - 12) };
  }

  private showMarker(t: DropTarget | null): void {
    const m = this.marker;
    m.hidden = !t;
    if (!t) return;
    let rect: DOMRect;
    m.className = `drop-marker ${t.kind}`;
    if (t.kind === 'float') {
      rect = new DOMRect(t.x, t.y, 340, 300);
    } else if (t.kind === 'tab') {
      const el = document.querySelector<HTMLElement>(
        `.dock-group[data-region="${t.region}"][data-group="${t.group}"]`,
      );
      if (!el) return void (m.hidden = true);
      rect = el.getBoundingClientRect();
    } else {
      const els = [...this[t.region].querySelectorAll<HTMLElement>(':scope > .dock-group')];
      const region = this[t.region].getBoundingClientRect();
      const before = els[t.index];
      const after = els[t.index - 1];
      const horizontal = t.region !== 'bottom';
      if (horizontal) {
        const y = before
          ? before.getBoundingClientRect().top
          : after
            ? after.getBoundingClientRect().bottom
            : region.top + region.height / 2;
        rect = new DOMRect(region.left, y - 2, region.width, 4);
      } else {
        const x = before
          ? before.getBoundingClientRect().left
          : after
            ? after.getBoundingClientRect().right
            : region.left + region.width / 2;
        rect = new DOMRect(x - 2, region.top, 4, region.height);
      }
    }
    Object.assign(m.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }
}
