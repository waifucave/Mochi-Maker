/**
 * The palettes, each rendering from the editor's state; every change they
 * make is a command through `Editor.transact` or `Editor.runItems`.
 *
 * - «Parts», «Deformer»: the objects by part and by deformer, with show/hide and lock toggles.
 * - «Parameter»: the parameters as sliders, with the key buttons and the palette menu.
 * - «Inspector»: the selection's properties and its keyform at the pose.
 * - «Tool Details»: the active tool's options and the mesh-editing sub-tools.
 * - «Project», «Log», «Timeline», «Scene».
 * - Mochi Maker's own: History, Validation, Agents, Art, Preview, Draw Order.
 */
import {
  ALPHA_BLENDS,
  COLOR_BLENDS,
  isCompatibleBlend,
  type AlphaBlend,
  type AnyKeyform,
  type ArtMesh,
  type BlendMode,
  type ColorBlend,
  type DocObject,
  type DocReader,
  type Motion,
  type Parameter,
  type Part,
  type Rotation,
  type Uid,
  type Warp,
} from '@mochi-maker/core';
import { DeformerMapper } from '@mochi-maker/export';
import { round, type DocumentEvent, type Editor, type Message } from './editor.js';
import { fill, h } from './dom.js';
import type { Viewport } from './viewport.js';
import type { AgentSurface } from './agent.js';
import type { BridgeHost } from './host.js';
import type { LiveLink } from './livelink.js';
import type { Keymap } from './keymap.js';
import type { SettingsStore } from './settings.js';
import type { Tips } from './tips.js';
import { untidyKey } from './checks.js';
import { PoseSection } from './pose.js';

const OUTLINE_KINDS = new Set(['project', 'part', 'artMesh', 'warp', 'rotation']);
const POSE_KINDS = new Set(['project', 'parameter', 'parameterGroup']);
/** Whether a document change touches objects of these kinds (undo and redo included). */
const touches = (e: DocumentEvent, kinds: Set<string>) => e.changes.some((c) => kinds.has(c.kind));

export const label = (o: DocObject | undefined): string => {
  if (!o) return '?';
  if ('exportId' in o && o.exportId) return o.exportId;
  if ('name' in o && o.name) return String(o.name);
  return o.uid;
};

/** The terms users see, by kind. */
export const TERM: Record<string, string> = {
  artMesh: 'ArtMesh',
  part: 'Part',
  warp: 'Warp Deformer',
  rotation: 'Rotation Deformer',
  parameter: 'Parameter',
  glue: 'Glue',
  parameterGroup: 'Parameter group',
  layer: 'Layer',
  motion: 'Motion',
};

/** Shared services the palettes use (main.ts builds them). */
export interface PaletteContext {
  editor: Editor;
  viewport: Viewport;
  keymap: Keymap;
  settings: SettingsStore;
  tips: Tips;
  dialogs: {
    keys(param: Uid): void;
    createParameter(): void;
    createParameterGroup(): void;
    createDeformer(kind: 'warp' | 'rotation'): void;
    autoMesh(): void;
  };
  /** Deletes the selected objects at once (Delete in a palette); `ask` confirms first. */
  deleteSelection(ask: boolean): void;
  /** Adds keys at the ends (and the middle) of a parameter's range for the selection. */
  addKeys(param: Uid, count: 2 | 3): void;
}

/**
 * Renders a palette now if it is shown, or once it is shown next (the dock dispatches `shown`):
 * palettes in other tabs or hidden ones skip the work while the person edits.
 */
export function lazyRender(el: HTMLElement, render: () => void): () => void {
  let dirty = false;
  el.addEventListener('shown', () => {
    if (!dirty) return;
    dirty = false;
    render();
  });
  return () => {
    if (el.isConnected) {
      dirty = false;
      render();
    } else dirty = true;
  };
}

// ---------------------------------------------------------------- object trees

type ToggleKind = 'hide' | 'lock';
/** A drag across toggles sets them all to the first one's new value. */
let toggleDrag: { kind: ToggleKind; value: boolean } | null = null;
window.addEventListener('pointerup', () => (toggleDrag = null));

interface TreeRow {
  o: DocObject;
  depth: number;
  /** The row's parent in the tree (for "the same level"). */
  parent: Uid | null;
  extra?: string;
}

/** The rows of the Parts or Deformer palette, with selection, toggles, filters and dragging. */
abstract class TreePalette {
  readonly el: HTMLElement;
  protected readonly rowsEl = h('div.rows', { tabIndex: 0 });
  protected rows: TreeRow[] = [];
  private anchor: Uid | null = null;
  protected filterText = '';
  protected filterKinds = new Set(['part', 'artMesh', 'warp', 'rotation']);
  /** A lock against dragging rows (stray drags reorder or reparent). */
  protected dragLocked = false;

  constructor(
    protected readonly ctx: PaletteContext,
    cls: string,
  ) {
    this.el = h(`section.${cls}`);
    const e = ctx.editor;
    this.update = lazyRender(this.el, () => this.render());
    e.on('project', () => this.update());
    e.on('selection', () => this.markSelected());
    e.on('viewState', () => this.update());
    e.on('document', (ev) => touches(ev, OUTLINE_KINDS) && this.update());
    e.on('pose', () => this.onPose());
    this.rowsEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        ev.stopPropagation();
        ctx.deleteSelection(false);
      }
    });
  }

  protected readonly update: () => void;
  /** Shown below the rows (the Parts palette's pose groups). */
  protected footer: HTMLElement | null = null;
  protected onPose(): void {}
  protected abstract build(): TreeRow[];
  protected abstract title: string;

  private matches(o: DocObject): boolean {
    if (!this.filterKinds.has(o.kind)) return false;
    if (!this.filterText) return true;
    const t = this.filterText;
    return (
      label(o).toLowerCase().includes(t) ||
      ('name' in o && String(o.name).toLowerCase().includes(t))
    );
  }

  /** Marks the selected rows without building the list again. */
  private markSelected(): void {
    if (!this.el.isConnected) return this.update();
    const e = this.ctx.editor;
    for (const row of this.rowsEl.querySelectorAll<HTMLElement>(':scope > .row'))
      row.classList.toggle('selected', e.isSelected(row.dataset.uid!));
    const del = this.el.querySelector<HTMLButtonElement>(`[data-testid="${this.title}-delete"]`);
    if (del) del.disabled = e.selection.uids.length === 0;
  }

  focusFilter(): void {
    this.el.querySelector<HTMLInputElement>('input.filter')?.focus();
  }

  render(): void {
    const all = this.build();
    this.rows = all.filter((r) => this.matches(r.o));
    const hiddenByFilter = all.length - this.rows.length;
    const e = this.ctx.editor;
    // Rows whose content is unchanged keep their element (a commit rebuilds only what changed).
    const keep = new Map<Uid, { sig: string; el: HTMLElement }>();
    const rowEls: HTMLElement[] = this.rows.map((r) => {
      const sig = this.rowSig(r);
      const c = this.rowCache.get(r.o.uid);
      const el = c && c.sig === sig ? c.el : this.rowEl(r);
      keep.set(r.o.uid, { sig, el });
      return el;
    });
    this.rowCache = keep;
    if (all.length === 0) rowEls.push(h('div.empty', 'Empty. Open a project, or import art.'));
    const kinds = (['part', 'artMesh', 'warp', 'rotation'] as const).map((k) =>
      h(
        'button.kind-filter',
        {
          class: this.filterKinds.has(k) ? 'on' : '',
          title: `Show ${TERM[k]} rows`,
          dataset: { filterKind: k },
          on: {
            click: () => {
              if (this.filterKinds.has(k)) this.filterKinds.delete(k);
              else this.filterKinds.add(k);
              this.render();
            },
          },
        },
        KIND_ICON[k],
      ),
    );
    const top = this.rows.filter((r) => r.parent === null).map((r) => r.o.uid);
    const below = this.rows.map((r) => r.o.uid);
    fill(
      this.el,
      h(
        'div.palette-bar',
        h('input.filter', {
          placeholder: 'Filter by name or ID',
          value: this.filterText,
          on: {
            input: (ev) => {
              this.filterText = (ev.target as HTMLInputElement).value.toLowerCase();
              this.render();
              this.focusFilter();
            },
          },
        }),
        kinds,
      ),
      h(
        'div.palette-bar',
        h(
          'button',
          {
            title: 'Show all (Ctrl+click: also every level below)',
            dataset: { testid: `${this.title}-show-all` },
            on: {
              click: (ev) =>
                e.setHidden(
                  (ev as MouseEvent).ctrlKey || (ev as MouseEvent).metaKey ? below : top,
                  false,
                ),
            },
          },
          'Show all',
        ),
        h(
          'button',
          {
            title: 'Lock all (Ctrl+click: also every level below)',
            on: {
              click: (ev) =>
                e.setLocked(
                  (ev as MouseEvent).ctrlKey || (ev as MouseEvent).metaKey ? below : top,
                  true,
                ),
            },
          },
          'Lock all',
        ),
        h(
          'button',
          {
            title: 'Unlock all',
            on: { click: () => e.setLocked([...e.locked], false) },
          },
          'Unlock all',
        ),
        h(
          'label.toggle',
          { title: 'Lock the list against dragging' },
          h('input', {
            type: 'checkbox',
            checked: this.dragLocked,
            on: { change: (ev) => (this.dragLocked = (ev.target as HTMLInputElement).checked) },
          }),
          'Lock list',
        ),
        h(
          'button.danger',
          {
            title: 'Delete the selection (asks first; Delete in the list does not)',
            dataset: { testid: `${this.title}-delete` },
            disabled: e.selection.uids.length === 0,
            on: { click: () => this.ctx.deleteSelection(true) },
          },
          'Delete',
        ),
      ),
      hiddenByFilter > 0
        ? h(
            'div.hint.filter-note',
            { dataset: { testid: 'filter-note' } },
            `${hiddenByFilter} row${hiddenByFilter > 1 ? 's' : ''} hidden by the filters.`,
          )
        : null,
      this.rowsEl,
      this.footer,
    );
    const now = this.rowsEl.children;
    if (now.length !== rowEls.length || rowEls.some((el, i) => now[i] !== el))
      fill(this.rowsEl, rowEls);
  }

  private toggle(kind: ToggleKind, row: TreeRow): HTMLElement {
    const e = this.ctx.editor;
    const own = kind === 'hide' ? e.hidden.has(row.o.uid) : e.locked.has(row.o.uid);
    const effective = kind === 'hide' ? e.isHidden(row.o.uid) : e.isLocked(row.o.uid);
    const set = (uids: Uid[], value: boolean) =>
      kind === 'hide' ? e.setHidden(uids, value) : e.setLocked(uids, value);
    return h(
      `button.row-toggle.${kind}`,
      {
        class: `${own ? 'on' : ''} ${effective && !own ? 'inherited' : ''}`,
        title:
          kind === 'hide'
            ? 'Show or hide (drag across rows; Ctrl+click: every row at this level)'
            : 'Lock or unlock (drag across rows; Ctrl+click: every row at this level)',
        dataset: { toggle: kind },
        on: {
          pointerdown: (ev) => {
            ev.stopPropagation();
            const pe = ev as PointerEvent;
            const value = !own;
            if (pe.ctrlKey || pe.metaKey) {
              set(
                this.rows.filter((r) => r.parent === row.parent).map((r) => r.o.uid),
                value,
              );
              return;
            }
            toggleDrag = { kind, value };
            set([row.o.uid], value);
          },
          pointerenter: (ev) => {
            // Only while the button is still down: a re-render under a still pointer is not a drag.
            if (
              (ev as PointerEvent).buttons & 1 &&
              toggleDrag?.kind === kind &&
              own !== toggleDrag.value
            )
              set([row.o.uid], toggleDrag.value);
          },
          click: (ev) => ev.stopPropagation(),
        },
      },
      kind === 'hide' ? (effective ? '◌' : '◉') : effective ? '■' : '□',
    );
  }

  private rowCache = new Map<Uid, { sig: string; el: HTMLElement }>();

  /** What a row shows: when it is unchanged, its element is reused. */
  private rowSig(row: TreeRow): string {
    const e = this.ctx.editor;
    const u = row.o.uid;
    return [
      row.depth,
      row.parent,
      row.o.kind,
      label(row.o),
      row.extra ?? '',
      e.hidden.has(u),
      e.isHidden(u),
      e.locked.has(u),
      e.isLocked(u),
      e.isSelected(u),
      this.dragLocked,
    ].join('|');
  }

  private rowEl(row: TreeRow): HTMLElement {
    const e = this.ctx.editor;
    const o = row.o;
    const sel = e.isSelected(o.uid);
    const el = h(
      'div.row',
      {
        class: `${sel ? 'selected' : ''} ${e.isHidden(o.uid) ? 'dim' : ''}`,
        dataset: { uid: o.uid, kind: o.kind },
        style: `padding-left:${4 + row.depth * 14}px`,
        draggable: !this.dragLocked && this.canDrag(o),
        on: {
          click: (ev) => this.click(ev as MouseEvent, row),
          dragstart: (ev) => {
            (ev as DragEvent).dataTransfer?.setData('application/x-mochi-uid', o.uid);
          },
          dragover: (ev) => {
            if (this.canDrop(o)) ev.preventDefault();
          },
          drop: (ev) => {
            ev.preventDefault();
            const uid = (ev as DragEvent).dataTransfer?.getData('application/x-mochi-uid');
            if (uid && uid !== o.uid) this.dropOn(uid, o);
          },
        },
      },
      this.toggle('hide', row),
      this.toggle('lock', row),
      h('span.icon', KIND_ICON[o.kind] ?? '·'),
      h('span.name', label(o)),
      row.extra ? h('span.extra', row.extra) : null,
    );
    return el;
  }

  private click(ev: MouseEvent, row: TreeRow): void {
    const e = this.ctx.editor;
    const uid = row.o.uid;
    if (ev.altKey && row.o.kind === 'part') {
      // Alt+click on a part: everything in it.
      const inside = this.rows
        .filter((r) => r.o.kind === 'artMesh' && this.ctx.viewport.inPart(r.o.uid, uid))
        .map((r) => r.o.uid);
      e.selectMany([...inside, uid]);
    } else if (ev.shiftKey && this.anchor) {
      const ids = this.rows.map((r) => r.o.uid);
      const [a, b] = [ids.indexOf(this.anchor), ids.indexOf(uid)];
      if (a >= 0 && b >= 0) e.selectMany(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (ev.ctrlKey || ev.metaKey) {
      e.toggleSelected(uid);
      this.anchor = uid;
    } else {
      e.select(uid);
      this.anchor = uid;
    }
    this.rowsEl.focus();
  }

  protected canDrag(_o: DocObject): boolean {
    return false;
  }
  protected canDrop(_o: DocObject): boolean {
    return false;
  }
  protected dropOn(_uid: Uid, _onto: DocObject): void {}
}

const KIND_ICON: Record<string, string> = { part: '▤', artMesh: '◆', warp: '▦', rotation: '↻' };

/** «Parts»: the objects grouped by part, in the layer order, with their draw order at the pose. */
export class PartsPalette extends TreePalette {
  protected override title = 'parts';

  readonly pose: PoseSection;

  constructor(ctx: PaletteContext) {
    super(ctx, 'parts');
    this.pose = new PoseSection(ctx.editor, ctx.viewport);
    this.footer = this.pose.el;
    this.render();
  }

  protected override onPose(): void {
    this.update();
  }

  protected override build(): TreeRow[] {
    const v = this.ctx.editor.view;
    const rows: TreeRow[] = [];
    const poseGroup = new Map<Uid, number>();
    v.project().pose.groups.forEach((g, gi) => g.forEach((e) => poseGroup.set(e.part, gi + 1)));
    const walk = (uids: readonly Uid[], depth: number, parent: Uid | null) => {
      for (const uid of uids) {
        const o = v.get(uid);
        if (!o) continue;
        const group = o.kind === 'part' ? poseGroup.get(o.uid) : undefined;
        const order = drawOrderText(this.ctx.editor, o);
        rows.push({
          o,
          depth,
          parent,
          extra:
            [
              o.kind === 'part' && (o as Part).guide ? 'guide' : undefined,
              group ? `pose ${group}` : undefined,
              order,
            ]
              .filter((x) => x !== undefined)
              .join(' · ') || undefined,
        });
        if (o.kind === 'part') {
          walk((o as Part).children, depth + 1, o.uid);
          // A part's deformers are listed under it too.
          for (const d of v.ofKind(['warp', 'rotation']))
            if (d.part === o.uid) rows.push({ o: d, depth: depth + 1, parent: o.uid });
        }
      }
    };
    walk(v.project().root, 0, null);
    for (const d of v.ofKind(['warp', 'rotation']))
      if (d.part === null) rows.push({ o: d, depth: 0, parent: null });
    return rows;
  }

  protected override canDrag(o: DocObject): boolean {
    return o.kind === 'artMesh' || o.kind === 'part';
  }
  protected override canDrop(o: DocObject): boolean {
    return o.kind === 'part';
  }
  protected override dropOn(uid: Uid, onto: DocObject): void {
    this.ctx.editor.transact('Move to part', [
      { name: 'tree.move', args: { target: uid, parent: onto.uid } },
    ]);
    this.ctx.tips.tip(
      'row-order',
      'The order of rows does not decide what is in front: the draw order does. Row order only breaks ties.',
    );
  }
}

/** «Deformer»: the same objects by parent-child hierarchy; drag an object onto a deformer to reparent it. */
export class DeformerPalette extends TreePalette {
  protected override title = 'deformer';

  constructor(ctx: PaletteContext) {
    super(ctx, 'deformer');
    this.render();
  }

  protected override build(): TreeRow[] {
    const v = this.ctx.editor.view;
    const deformers = v.project().deformerOrder.map((u) => v.get(u)!) as (Warp | Rotation)[];
    const meshes = v.ofKind('artMesh');
    const rows: TreeRow[] = [];
    const walk = (parent: Uid | null, depth: number) => {
      for (const d of deformers)
        if (d.parent === parent) {
          rows.push({ o: d, depth, parent });
          walk(d.uid, depth + 1);
        }
      for (const m of meshes) if (m.deformer === parent) rows.push({ o: m, depth, parent });
    };
    walk(null, 0);
    return rows;
  }

  protected override canDrag(o: DocObject): boolean {
    return o.kind === 'artMesh' || o.kind === 'warp' || o.kind === 'rotation';
  }
  protected override canDrop(o: DocObject): boolean {
    return o.kind === 'warp' || o.kind === 'rotation';
  }
  protected override dropOn(uid: Uid, onto: DocObject): void {
    const o = this.ctx.editor.view.get(uid);
    if (!o) return;
    void this.ctx.editor.runItems(
      'Move into deformer',
      o.kind === 'artMesh'
        ? [{ name: 'mesh.reparent', args: { target: uid, deformer: onto.uid } }]
        : [{ name: 'deformer.reparent', args: { target: uid, parent: onto.uid } }],
    );
  }
}

function drawOrderText(editor: Editor, o: DocObject): string | undefined {
  if (o.kind !== 'artMesh' && o.kind !== 'part') return undefined;
  const at = editor.cellAtPose(o.uid);
  const kf = at.ok ? (o.rig.keyforms[at.index] as { drawOrder?: number }) : undefined;
  return kf?.drawOrder !== undefined ? `${round(kf.drawOrder)}` : undefined;
}

/** «Draw Order» (Mochi Maker's own): what Mochi2D evaluated, topmost first. */
export class DrawOrderPalette {
  readonly el = h('section.draw-order');

  constructor(
    private readonly editor: Editor,
    private readonly viewport: Viewport,
  ) {
    for (const ev of ['project', 'document', 'pose', 'selection'] as const)
      editor.on(ev, () => setTimeout(() => this.el.isConnected && this.render()));
    this.el.addEventListener('shown', () => this.render());
    this.render();
  }

  render(): void {
    const v = this.editor.view;
    const ev = this.viewport.evaluation().drawables;
    ev.sort((a, b) => b.renderOrder - a.renderOrder);
    const rows = ev
      .map((d) => {
        const o = v.get(d.uid);
        return o
          ? h(
              'div.row',
              {
                class: this.editor.isSelected(o.uid) ? 'selected' : '',
                dataset: { uid: o.uid },
                on: { click: () => this.editor.select(o.uid) },
              },
              h('span.icon', '◆'),
              h('span.name', label(o)),
              h('span.extra', `${d.drawOrder}${d.visible ? '' : ' · hidden'}`),
            )
          : null;
      })
      .filter(Boolean);
    fill(this.el, rows.length ? rows : h('div.empty', 'Nothing drawn yet.'));
  }
}

// ---------------------------------------------------------------- inspector

/** Keyform fields that the inspector edits, by kind, with the names users see. */
const KEYFORM_FIELDS: Record<string, [string, string][]> = {
  artMesh: [
    ['opacity', 'Opacity'],
    ['drawOrder', 'Draw order'],
  ],
  warp: [['opacity', 'Opacity']],
  rotation: [
    ['angle', 'Angle'],
    ['originX', 'Origin X'],
    ['originY', 'Origin Y'],
    ['scale', 'Scale'],
    ['opacity', 'Opacity'],
  ],
  part: [['drawOrder', 'Draw order']],
  glue: [['intensity', 'Strength']],
};
const COLOR_KINDS = new Set(['artMesh', 'warp', 'rotation']);

/** The names users see for the color functions of blend modes. */
const COLOR_BLEND_NAMES: Record<ColorBlend, string> = {
  normal: 'Normal',
  additive: 'Additive (every version)',
  multiplicative: 'Multiplicative (every version)',
  add: 'Add',
  addGlow: 'Add (glow)',
  darken: 'Darken',
  multiply: 'Multiply',
  colorBurn: 'Color burn',
  linearBurn: 'Linear burn',
  lighten: 'Lighten',
  screen: 'Screen',
  colorDodge: 'Color dodge',
  overlay: 'Overlay',
  softLight: 'Soft light',
  hardLight: 'Hard light',
  linearLight: 'Linear light',
  hue: 'Hue',
  color: 'Color',
};
const ALPHA_BLEND_NAMES: Record<AlphaBlend, string> = {
  over: 'Over',
  atop: 'Atop (inside what is below)',
  out: 'Out (cuts what is below)',
  conjoint: 'Conjoint',
  disjoint: 'Disjoint',
};

export class Inspector {
  readonly el = h('section.inspector');

  constructor(private readonly ctx: PaletteContext) {
    const editor = ctx.editor;
    for (const ev of ['project', 'document', 'selection', 'pose', 'viewState', 'mode'] as const)
      editor.on(ev, () => this.render());
    this.render();
  }

  private get editor(): Editor {
    return this.ctx.editor;
  }

  private run(label: string, name: string, args: unknown): void {
    this.editor.transact(label, [{ name, args }]);
  }

  /** A select of deformers (and "none"), for attaching in place through the reparent operations. */
  private deformerSelect(
    current: Uid | null,
    exclude: ReadonlySet<Uid>,
    commit: (to: Uid | null) => void,
    testid: string,
  ): HTMLSelectElement {
    const v = this.editor.view;
    const options = [
      h('option', { value: '', selected: current === null }, 'none (canvas)'),
      ...v
        .project()
        .deformerOrder.filter((u) => !exclude.has(u))
        .map((u) => h('option', { value: u, selected: u === current }, label(v.get(u)))),
    ];
    return h(
      'select',
      {
        dataset: { testid },
        on: {
          change: (e) => {
            const value = (e.target as HTMLSelectElement).value;
            commit(value === '' ? null : value);
          },
        },
      },
      options,
    );
  }

  render(): void {
    const v = this.editor.view;
    const uid = this.editor.selection.uid;
    const o = uid ? v.get(uid) : undefined;
    if (!o) {
      fill(this.el, h('div.empty', 'Select an ArtMesh, Part, Deformer or Parameter.'));
      return;
    }
    // Locking an object also locks its fields, unless the settings say otherwise. A glue's fields
    // are read-only too when glue authoring is off in this build.
    const glueOff = o.kind === 'glue' && !this.editor.features.glue;
    const locked =
      glueOff || (this.ctx.settings.value.lockLocksInspector && this.editor.isLocked(o.uid));
    const field = (name: string, input: Node) => h('label.field', h('span', name), input);
    const text = (value: string, commit: (s: string) => void, testid?: string) =>
      h('input', {
        value,
        disabled: locked,
        dataset: testid ? { testid } : {},
        on: { change: (e) => commit((e.target as HTMLInputElement).value) },
      });
    const num = (value: number, commit: (n: number) => void, testid: string, step = 0.01) =>
      h('input', {
        type: 'number',
        step: String(step),
        value: round(value, 4),
        disabled: locked,
        dataset: { testid },
        on: {
          change: (e) => {
            const n = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(n)) commit(n);
          },
        },
      });
    const check = (value: boolean, commit: (b: boolean) => void, testid: string) =>
      h('input', {
        type: 'checkbox',
        checked: value,
        disabled: locked,
        dataset: { testid },
        on: { change: (e) => commit((e.target as HTMLInputElement).checked) },
      });

    const many = this.editor.selection.uids.length;
    const parts: Node[] = [
      h(
        'div.kind',
        { dataset: { testid: 'inspector-kind' } },
        `${TERM[o.kind] ?? o.kind}${many > 1 ? ` · ${many} selected` : ''}`,
        h('span.uid', o.uid),
      ),
    ];
    if (locked)
      parts.push(h('div.hint', 'Locked: unlock it in the Parts or Deformer palette to edit.'));
    if ('name' in o && typeof o.name === 'string' && o.kind !== 'parameterGroup')
      parts.push(
        field(
          'Name',
          text(
            o.name,
            (s) => this.run('Rename', 'object.rename', { target: o.uid, name: s }),
            'name',
          ),
        ),
      );
    if ('exportId' in o)
      parts.push(
        field(
          'ID',
          text(
            o.exportId,
            (s) => {
              if (o.kind === 'parameter' && s.includes('@'))
                this.ctx.tips.warn(
                  'at-in-id',
                  `"${s}" contains "@": a parameter ID with "@" can block motion export in other tools.`,
                );
              this.run('Rename', 'object.rename', { target: o.uid, exportId: s });
            },
            'export-id',
          ),
        ),
      );

    if (o.kind === 'artMesh') {
      const m = o as ArtMesh;
      const meshes = v.ofKind('artMesh').filter((x) => x.uid !== m.uid);
      parts.push(
        h(
          'div.facts',
          `${m.uv.length / 2} vertices · ${m.triangles.length / 3} triangles`,
          h('br'),
          `Part ${m.part ? label(v.get(m.part)) : 'none'}`,
          m.layer ? ` · layer ${label(v.get(m.layer))}` : '',
        ),
        field(
          'Parent deformer',
          this.deformerSelect(
            m.deformer,
            new Set(),
            (to) =>
              void this.editor.runItems('Move into deformer', [
                { name: 'mesh.reparent', args: { target: m.uid, deformer: to } },
              ]),
            'mesh-deformer',
          ),
        ),
        field(
          'Mask',
          h(
            'select',
            {
              disabled: locked,
              dataset: { testid: 'mask' },
              title: 'The ArtMesh this one is drawn inside (clipping)',
              on: {
                change: (e) => {
                  const value = (e.target as HTMLSelectElement).value;
                  this.run('Set mask', 'mesh.setClip', {
                    target: m.uid,
                    masks: value ? [value] : [],
                    invert: m.clip?.invert ?? false,
                  });
                },
              },
            },
            h('option', { value: '' }, 'none'),
            ...(m.clip && m.clip.masks.length > 1
              ? [
                  h(
                    'option',
                    { value: m.clip.masks[0]!, selected: true },
                    `${m.clip.masks.length} masks`,
                  ),
                ]
              : []),
            meshes.map((x) =>
              h(
                'option',
                { value: x.uid, selected: m.clip?.masks.length === 1 && m.clip.masks[0] === x.uid },
                x.exportId,
              ),
            ),
          ),
        ),
        field(
          'Invert mask',
          check(
            m.clip?.invert ?? false,
            (b) =>
              this.run('Invert mask', 'mesh.setClip', {
                target: m.uid,
                masks: m.clip?.masks ?? [],
                invert: b,
              }),
            'mask-invert',
          ),
        ),
        field(
          'Enabled',
          check(
            m.enabled,
            (b) => this.run('Mesh enabled', 'mesh.update', { target: m.uid, enabled: b }),
            'enabled',
          ),
        ),
        field(
          'Double-sided (no culling)',
          check(
            m.doubleSided,
            (b) => this.run('Mesh sides', 'mesh.update', { target: m.uid, doubleSided: b }),
            'double-sided',
          ),
        ),
        ...this.blendFields(m.blend ?? { color: m.legacyBlend, alpha: 'over' }, locked, (blend) =>
          this.run('Blend mode', 'mesh.update', { target: m.uid, blend }),
        ),
        h(
          'div.buttons',
          h(
            'button',
            {
              title: 'Create a warp deformer around this ArtMesh (Modeling › Create Warp Deformer)',
              dataset: { testid: 'wrap-warp' },
              disabled: locked,
              on: { click: () => this.ctx.dialogs.createDeformer('warp') },
            },
            'Create Warp Deformer…',
          ),
          h(
            'button',
            {
              dataset: { testid: 'wrap-rotation' },
              disabled: locked,
              on: { click: () => this.ctx.dialogs.createDeformer('rotation') },
            },
            'Create Rotation Deformer…',
          ),
        ),
      );
    } else if (o.kind === 'part') {
      parts.push(
        h('div.facts', `Parent part ${label(o.parent ? v.get(o.parent) : undefined)}`),
        field(
          'Enabled',
          check(
            o.enabled,
            (b) => this.run('Part enabled', 'part.update', { target: o.uid, enabled: b }),
            'enabled',
          ),
        ),
        field(
          'Visible at start',
          check(
            o.visibleAtStart,
            (b) => this.run('Part visibility', 'part.update', { target: o.uid, visibleAtStart: b }),
            'visible',
          ),
        ),
        field(
          'Draw order group',
          check(
            o.sortingScope === 'own',
            (b) =>
              this.run('Part sorting', 'part.update', {
                target: o.uid,
                sortingScope: b ? 'own' : 'inherit',
              }),
            'own-scope',
          ),
        ),
        field(
          'Guide image',
          check(
            o.guide,
            (b) => this.run('Guide image', 'part.update', { target: o.uid, guide: b }),
            'guide',
          ),
        ),
        field(
          'Draw offscreen',
          check(
            !!o.offscreen,
            (b) => this.run('Draw offscreen', 'part.setOffscreen', { target: o.uid, offscreen: b }),
            'offscreen',
          ),
        ),
      );
      const off = o.offscreen;
      if (off) {
        const set = (args: Record<string, unknown>) =>
          this.run('Offscreen', 'part.setOffscreen', { target: o.uid, offscreen: true, ...args });
        parts.push(
          ...this.blendFields(off.blend, locked, (blend) => set({ blend })),
          field(
            'Offscreen mask',
            h(
              'select',
              {
                disabled: locked,
                dataset: { testid: 'offscreen-mask' },
                title: 'The ArtMesh the offscreen image is drawn inside (clipping)',
                on: {
                  change: (e) => {
                    const value = (e.target as HTMLSelectElement).value;
                    set({ masks: value ? [value] : [] });
                  },
                },
              },
              h('option', { value: '' }, 'none'),
              ...(off.clip && off.clip.masks.length > 1
                ? [
                    h(
                      'option',
                      { value: off.clip.masks[0]!, selected: true },
                      `${off.clip.masks.length} masks`,
                    ),
                  ]
                : []),
              v.ofKind('artMesh').map((x) =>
                h(
                  'option',
                  {
                    value: x.uid,
                    selected: off.clip?.masks.length === 1 && off.clip.masks[0] === x.uid,
                  },
                  x.exportId,
                ),
              ),
            ),
          ),
          field(
            'Invert offscreen mask',
            check(off.clip?.invert ?? false, (b) => set({ invert: b }), 'offscreen-mask-invert'),
          ),
          h(
            'div.facts',
            { dataset: { testid: 'offscreen-note' } },
            'Drawn offscreen: needs version 6. The opacity and tints are in the keyforms below.',
          ),
        );
      }
    } else if (o.kind === 'warp' || o.kind === 'rotation') {
      const d = o as Warp | Rotation;
      // The deformer and everything below it cannot be its parent.
      const below = new Set<Uid>([d.uid]);
      for (const u of v.project().deformerOrder) {
        const p = (v.get(u) as Warp | Rotation).parent;
        if (p !== null && below.has(p)) below.add(u);
      }
      const children = v.ofKind(['warp', 'rotation']).filter((c) => c.parent === d.uid).length;
      const meshes = v.ofKind('artMesh').filter((m) => m.deformer === d.uid).length;
      parts.push(
        h(
          'div.facts',
          d.kind === 'warp' ? `${d.rows} × ${d.cols} grid (${d.cellMode}) · ` : '',
          `${children} deformer(s), ${meshes} ArtMesh(es) inside`,
          h('br'),
          `Part ${d.part ? label(v.get(d.part)) : 'none'} · drag its handles on the canvas; hold Ctrl to leave the contents in place`,
        ),
        field(
          'Parent',
          this.deformerSelect(
            d.parent,
            below,
            (to) =>
              void this.editor.runItems('Move deformer', [
                { name: 'deformer.reparent', args: { target: d.uid, parent: to } },
              ]),
            'deformer-parent',
          ),
        ),
        field(
          'Enabled',
          check(
            o.enabled,
            (b) => this.run('Deformer enabled', 'deformer.update', { target: o.uid, enabled: b }),
            'enabled',
          ),
        ),
      );
      if (d.kind === 'rotation')
        parts.push(
          field(
            'Standard Angle',
            num(
              d.baseAngle,
              (n) => this.run('Standard Angle', 'deformer.update', { target: d.uid, baseAngle: n }),
              'base-angle',
              1,
            ),
          ),
        );
    } else if (o.kind === 'parameter') {
      const p = o as Parameter;
      parts.push(
        field(
          'Minimum',
          num(
            p.min,
            (n) => this.run('Parameter range', 'param.update', { target: p.uid, min: n }),
            'min',
          ),
        ),
        field(
          'Maximum',
          num(
            p.max,
            (n) => this.run('Parameter range', 'param.update', { target: p.uid, max: n }),
            'max',
          ),
        ),
        field(
          'Default',
          num(
            p.default,
            (n) => this.run('Parameter default', 'param.update', { target: p.uid, default: n }),
            'default',
          ),
        ),
        field(
          'Keys',
          text(
            p.keys.map((k) => round(k)).join(', '),
            (s) =>
              this.run('Parameter keys', 'param.setKeys', {
                target: p.uid,
                keys: s
                  .split(',')
                  .map((x) => Number(x.trim()))
                  .filter((x) => Number.isFinite(x)),
              }),
            'keys',
          ),
        ),
        h(
          'div.facts',
          `${p.type === 'blendShape' ? 'Blend Shape' : 'Normal'}${p.repeat ? ' · loops' : ''}`,
        ),
        this.standardGroups(p),
      );
    }

    if (glueOff)
      parts.push(
        h(
          'div.facts',
          { dataset: { testid: 'feature-off' } },
          'Glue is not available in this build.',
        ),
      );
    else if ('rig' in o && KEYFORM_FIELDS[o.kind]) parts.push(this.keyformSection(o, locked));
    fill(this.el, ...parts);
  }

  /**
   * A blend mode as two choices: the color function and the alpha mode. Normal, additive and
   * multiplicative work in every version; the others need version 6.
   */
  private blendFields(
    value: BlendMode,
    locked: boolean,
    commit: (b: BlendMode) => void,
  ): HTMLElement[] {
    const select = <T extends string>(
      options: readonly T[],
      names: Record<T, string>,
      current: T,
      pick: (x: T) => void,
      testid: string,
    ) =>
      h(
        'select',
        {
          disabled: locked,
          dataset: { testid },
          on: { change: (e) => pick((e.target as HTMLSelectElement).value as T) },
        },
        options.map((x) => h('option', { value: x, selected: x === current }, names[x])),
      );
    const advanced = !isCompatibleBlend(value);
    return [
      h(
        'label.field',
        h('span', 'Color blend'),
        select(
          COLOR_BLENDS,
          COLOR_BLEND_NAMES,
          value.color,
          (color) => commit({ ...value, color }),
          'blend-color',
        ),
      ),
      h(
        'label.field',
        h('span', 'Alpha blend'),
        select(
          ALPHA_BLENDS,
          ALPHA_BLEND_NAMES,
          value.alpha,
          (alpha) => commit({ ...value, alpha }),
          'blend-alpha',
        ),
      ),
      ...(advanced
        ? [
            h(
              'div.facts',
              { dataset: { testid: 'blend-note' } },
              'This blend mode needs version 6.',
            ),
          ]
        : []),
    ];
  }

  /**
   * The standard groups: apps blink the EyeBlink parameters and move the LipSync ones
   * with a sound's level. Two checks, each one undoable step (meta.setStandardGroups).
   */
  private standardGroups(p: Parameter): HTMLElement {
    const groups = this.editor.view.project().standardGroups;
    const check = (key: 'eyeBlink' | 'lipSync', label: string, title: string) =>
      h(
        'label.toggle',
        { title },
        h('input', {
          type: 'checkbox',
          checked: groups[key].includes(p.uid),
          dataset: { testid: `group-${key}` },
          on: {
            change: (e) => {
              const on = (e.target as HTMLInputElement).checked;
              const list = groups[key].filter((u) => u !== p.uid);
              this.run(`${label} group`, 'meta.setStandardGroups', {
                [key]: on ? [...list, p.uid] : list,
              });
            },
          },
        }),
        label,
      );
    return h(
      'div.field.groups',
      h('span', 'Groups'),
      h(
        'span.checks',
        check(
          'eyeBlink',
          'Eye blink',
          'Apps blink this parameter (the EyeBlink group): 1 open, 0 shut',
        ),
        check(
          'lipSync',
          'Lip sync',
          "Apps open this parameter with a sound's level (the LipSync group)",
        ),
      ),
    );
  }

  /** The canvas position of a rotation's origin in one keyform, by revision and cell. */
  private originCache = new Map<string, [number, number]>();

  /**
   * A rotation's origin in canvas pixels, at the keyform's pose (its keys, other parameters at
   * their defaults): the parent's space converted by Mochi2D's own mapping. Typing a value runs
   * keyform.moveInCanvas, which maps it back into the parent's space.
   */
  private originFields(
    r: Rotation,
    cell: Record<Uid, number>,
    index: number,
    locked: boolean,
  ): HTMLElement[] {
    const key = `${this.editor.session.revision}|${r.uid}|${JSON.stringify(cell)}`;
    let canvas = this.originCache.get(key);
    if (!canvas) {
      const kf = r.rig.keyforms[index]!;
      const local = [kf.originX, kf.originY];
      try {
        const c = new DeformerMapper(this.editor.view, cell).toCanvas(r.parent, local);
        canvas = [c[0]!, c[1]!];
      } catch {
        canvas = [NaN, NaN];
      }
      if (this.originCache.size > 64) this.originCache.clear();
      this.originCache.set(key, canvas);
    }
    const [cx, cy] = canvas;
    const move = (x: number, y: number) =>
      void this.editor.runItems('Move origin', [
        {
          name: 'keyform.moveInCanvas',
          args: { target: r.uid, cell, positions: [[x, y]] },
        },
      ]);
    return (
      [
        ['originX', 'Origin X (canvas)', cx, (n: number) => move(n, cy)],
        ['originY', 'Origin Y (canvas)', cy, (n: number) => move(cx, n)],
      ] as const
    ).map(([f, name, value, commit]) =>
      h(
        'label.field',
        {
          title:
            "Canvas pixels, at this keyform's pose; Mochi Maker converts to the parent deformer's space",
        },
        h('span', name),
        h(
          'span.field-input',
          h('input', {
            type: 'number',
            step: '0.01',
            value: Number.isFinite(value) ? round(value, 2) : '',
            disabled: locked || !Number.isFinite(value),
            dataset: { testid: `kf-${f}` },
            on: {
              change: (e) => {
                const n = Number((e.target as HTMLInputElement).value);
                if (Number.isFinite(n)) commit(n);
              },
            },
          }),
        ),
      ),
    );
  }

  /** The keyform at the current pose: its fields, or why it cannot be edited here. */
  private keyformSection(
    o: DocObject & {
      rig: { bindings: { parameter: Uid; keys: number[] }[]; keyforms: AnyKeyform[] };
    },
    locked: boolean,
  ): HTMLElement {
    const v = this.editor.view;
    const at = this.editor.cellAtPose(o.uid);
    const bindings = o.rig.bindings.map((b) =>
      h(
        'div.binding',
        `${label(v.get(b.parameter))}: ${b.keys.map((k) => round(k)).join(', ')}`,
        b.keys.length === 1
          ? h(
              'span.warn',
              { dataset: { testid: 'one-key' } },
              ' · one key only: the same shape at every value. Add a key at the other end.',
            )
          : null,
      ),
    );
    const section = h('div.section', h('h3', 'Keyform at this pose'), bindings);
    if (!at.ok) {
      const p = v.getAs(at.parameter, 'parameter');
      const nearest = at.keys.reduce((a, b) =>
        Math.abs(b - at.value) < Math.abs(a - at.value) ? b : a,
      );
      section.append(
        h('div.refusal', { dataset: { testid: 'keyform-refusal' } }, at.reason),
        h(
          'div.buttons',
          h(
            'button',
            { on: { click: () => this.editor.setPose(at.parameter, nearest) } },
            `Go to key ${round(nearest)}`,
          ),
          h(
            'button',
            {
              dataset: { testid: 'add-key-here' },
              disabled: locked,
              on: {
                click: () => {
                  const calls = [];
                  if (!p.keys.some((k) => Math.abs(k - at.value) < 1e-6))
                    calls.push({
                      name: 'param.setKeys',
                      args: { target: p.uid, keys: [...p.keys, at.value].sort((a, b) => a - b) },
                    });
                  calls.push({
                    name: 'rig.addKey',
                    args: { target: o.uid, parameter: p.uid, key: at.value },
                  });
                  if (this.editor.transact('Add key here', calls) && untidyKey(p, at.value))
                    this.ctx.tips.warn(
                      'untidy-key',
                      `The new key of ${p.exportId} is at ${round(at.value, 4)}, an untidy value. Double-click the parameter's name to type exact keys.`,
                    );
                },
              },
            },
            'Add a key here',
          ),
        ),
      );
      return section;
    }
    const kf = o.rig.keyforms[at.index] as unknown as Record<string, unknown>;
    section.append(
      h(
        'div.cell',
        { dataset: { testid: 'cell' } },
        cellText(v, at.cell),
        kf.authored ? ' · authored' : ' · filled',
      ),
    );
    const set = (values: Record<string, unknown>) =>
      this.editor.transact('Edit keyform', [
        { name: 'keyform.set', args: { target: o.uid, cell: at.cell, values } },
      ]);
    // A part drawn offscreen also keyforms its offscreen's opacity and tints.
    const offscreen = o.kind === 'part' && !!(o as Part).offscreen;
    const fields = offscreen
      ? [...KEYFORM_FIELDS.part!, ['opacity', 'Opacity'] as [string, string]]
      : KEYFORM_FIELDS[o.kind]!;
    for (const [f, name] of fields) {
      // A rotation's origin is shown and typed in canvas pixels, whatever its parent.
      if (o.kind === 'rotation' && (f === 'originX' || f === 'originY')) {
        if (f === 'originX')
          section.append(...this.originFields(o as Rotation, at.cell, at.index, locked));
        continue;
      }
      const input = h('input', {
        type: 'number',
        step: f === 'drawOrder' ? '1' : '0.01',
        value: round(Number(kf[f]), 4),
        disabled: locked,
        dataset: { testid: `kf-${f}` },
        on: {
          change: (e) => {
            const n = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(n)) set({ [f]: n });
          },
        },
      });
      // Draw order: drag inside the field to change it, or step by 10 or 100.
      const extra =
        f === 'drawOrder'
          ? h(
              'span.steps',
              [-100, -10, 10, 100].map((d) =>
                h(
                  'button.step',
                  {
                    disabled: locked,
                    dataset: { testid: `draw-order-${d}` },
                    on: {
                      click: () =>
                        set({ drawOrder: Math.max(0, Math.min(1000, Number(kf.drawOrder) + d)) }),
                    },
                  },
                  d > 0 ? `+${d}` : String(d),
                ),
              ),
            )
          : null;
      if (f === 'drawOrder')
        dragNumber(input, (n) => set({ drawOrder: Math.max(0, Math.min(1000, Math.round(n))) }));
      section.append(h('label.field', h('span', name), h('span.field-input', input, extra)));
    }
    if (COLOR_KINDS.has(o.kind) || offscreen)
      for (const [f, name] of [
        ['multiply', 'Multiply color'],
        ['screen', 'Screen color'],
      ] as const) {
        const rgb = kf[f] as [number, number, number];
        section.append(
          h(
            'label.field',
            h('span', name),
            h('input', {
              type: 'color',
              value: toHex(rgb),
              disabled: locked,
              dataset: { testid: `kf-${f}` },
              on: { change: (e) => set({ [f]: fromHex((e.target as HTMLInputElement).value) }) },
            }),
          ),
        );
      }
    return section;
  }
}

/** Dragging sideways inside a number field changes its value (one unit per pixel). */
function dragNumber(input: HTMLInputElement, commit: (n: number) => void): void {
  input.addEventListener('pointerdown', (e) => {
    if (input.disabled || e.button !== 0) return;
    const [x0, v0] = [e.clientX, Number(input.value)];
    let moved = false;
    const move = (m: PointerEvent) => {
      const d = m.clientX - x0;
      if (Math.abs(d) > 3) moved = true;
      if (moved) input.value = String(Math.round(v0 + d));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) commit(Number(input.value));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function cellText(v: DocReader, cell: Record<Uid, number>): string {
  const parts = Object.entries(cell).map(([p, k]) => `${label(v.get(p))} = ${round(k)}`);
  return parts.length ? parts.join(', ') : 'the only keyform';
}

const toHex = (rgb: [number, number, number]) =>
  '#' +
  rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const fromHex = (s: string): [number, number, number] => [
  parseInt(s.slice(1, 3), 16) / 255,
  parseInt(s.slice(3, 5), 16) / 255,
  parseInt(s.slice(5, 7), 16) / 255,
];

// ---------------------------------------------------------------- tool details

/** «Tool Details»: options and sub-tools of the active tool and of mesh editing. */
export class ToolDetails {
  readonly el = h('section.tool-details');

  constructor(
    private readonly ctx: PaletteContext,
    private readonly setTool: (t: Viewport['tool']) => void,
  ) {
    const e = ctx.editor;
    for (const ev of ['selection', 'mode', 'document', 'project', 'viewState'] as const)
      e.on(ev, () => this.render());
    // Tips about how the editor works show here, not over the canvas.
    e.on('message', (m) => {
      if (!m.code?.startsWith('tip:')) return;
      this.tip = { text: m.text, code: m.code };
      this.render();
    });
    this.render();
  }

  /** The latest tip, until it is closed. */
  private tip: { text: string; code: string } | null = null;

  /** The deform path's options: reach, finishing, deleting, and what the drag does now. */
  private pathDetails(): Node[] {
    const { editor: e, viewport: vp } = this.ctx;
    const drawing = vp.drawingPath;
    const shown = vp.visiblePaths();
    const selected = shown.find((p) => p.id === vp.selectedPath) ?? null;
    const targets = vp.pathTargets();
    return [
      h('h3', `Deform path · level ${vp.pathLevel()}`),
      h(
        'div.facts',
        { dataset: { testid: 'path-state' } },
        drawing
          ? `Drawing over ${drawing.targets.length} object(s): ${drawing.points.length} point(s). Click to add points; Enter, a double-click or a click on the last point finishes; Esc cancels.`
          : targets.length
            ? `${shown.length} path(s) over the selection. Click on the canvas to draw a new one, or drag a path's points.`
            : 'Select ArtMeshes or warp deformers, then draw a path over them.',
      ),
      h(
        'label.toggle',
        'Reach (px)',
        h('input.num', {
          type: 'number',
          min: '1',
          step: '5',
          value: String(selected?.reach ?? vp.pathReach),
          dataset: { testid: 'path-reach' },
          on: {
            change: (ev) => {
              const n = Math.max(1, Number((ev.target as HTMLInputElement).value) || 1);
              vp.setPathReach(selected?.id ?? null, n);
            },
          },
        }),
      ),
      h(
        'div.buttons',
        h(
          'button',
          {
            disabled: !drawing,
            dataset: { testid: 'path-finish' },
            on: { click: () => vp.finishPath() },
          },
          'Finish path',
        ),
        h(
          'button',
          {
            disabled: !selected,
            dataset: { testid: 'path-delete' },
            on: { click: () => selected && vp.deletePath(selected.id) },
          },
          'Delete path',
        ),
      ),
      h(
        'div.hint',
        e.level >= 2 && vp.recorder?.recordActive()
          ? 'Recording: dragging a path point poses the parameters that move these objects, and keys them at the playhead.'
          : 'Dragging a path point moves the points near the path with it, in this keyform. Paths are a helper: only the keyforms are saved.',
      ),
    ];
  }

  /** The brush's size, angle, hardness and roundness (B, C, V + drag), and the tool's own options. */
  private brushDetails(): Node[] {
    const { viewport: vp, keymap } = this.ctx;
    const b = vp.brush;
    const num = (
      label: string,
      testid: string,
      value: number,
      step: string,
      set: (n: number) => void,
    ) =>
      h(
        'label.toggle',
        label,
        h('input.num', {
          type: 'number',
          step,
          value: String(Math.round(value * 100) / 100),
          dataset: { testid },
          on: {
            change: (ev) => {
              const n = Number((ev.target as HTMLInputElement).value);
              if (Number.isFinite(n)) set(n);
              vp.drawOverlay();
            },
          },
        }),
      );
    const out: Node[] = [
      h('h3', 'Brush'),
      num('Size (radius, px)', 'brush-size', b.radius, '1', (n) => (b.radius = Math.max(2, n))),
      num('Angle (°)', 'brush-angle', b.angle, '5', (n) => (b.angle = n)),
      num(
        'Hardness (0–1)',
        'brush-hardness',
        b.hardness,
        '0.05',
        (n) => (b.hardness = Math.min(1, Math.max(0, n))),
      ),
      num(
        'Roundness (0–1)',
        'brush-roundness',
        b.roundness,
        '0.05',
        (n) => (b.roundness = Math.min(1, Math.max(0.05, n))),
      ),
      h(
        'div.hint',
        `${keymap.shortcut('tool.brush') || 'B'} + drag: size; ${keymap.shortcut('brush.angle') || 'C'} + drag: angle; ${keymap.shortcut('brush.hardness') || 'V'} + drag: hardness.`,
      ),
    ];
    if (vp.tool === 'brush')
      out.push(
        h(
          'div.hint',
          'Paint over vertices of the selected mesh to select them (Shift adds to the selection, Alt removes); with no mesh selected, paint over meshes.',
        ),
      );
    if (vp.tool === 'deform')
      out.push(
        h(
          'div.hint',
          'Drag over the selected mesh: the vertices under the brush move with the falloff, in the keyform at the pose (in mesh editing, every keyform). One undo per stroke. A double-click does not enter mesh editing with this tool.',
        ),
      );
    if (vp.tool === 'addBrush')
      out.push(
        h(
          'div.hint',
          'Mesh editing: paint inside the mesh to add vertices a brush radius apart; then connect them (Ctrl+R).',
        ),
      );
    if (vp.tool === 'stroke')
      out.push(
        h(
          'div.facts',
          { dataset: { testid: 'stroke-state' } },
          `${vp.strokes.length} stroke(s). Draw along thin lines over the selected mesh's layer; ${keymap.shortcut('mesh.confirmStrokes') || 'Shift+E'} makes the mesh, strips the brush's width wide.`,
        ),
        h(
          'div.buttons',
          h(
            'button.primary',
            {
              disabled: vp.strokes.length === 0,
              dataset: { testid: 'strokes-confirm' },
              on: { click: () => (vp.confirmStrokes(), this.render()) },
            },
            'Make mesh',
          ),
          h(
            'button',
            {
              disabled: vp.strokes.length === 0,
              on: { click: () => (vp.clearStrokes(), this.render()) },
            },
            'Clear strokes',
          ),
        ),
      );
    return out;
  }

  render(): void {
    const { editor: e, viewport: vp, keymap } = this.ctx;
    const mesh = e.selectedMesh();
    const sel = e.selection.vertices;
    const key = (id: string) => (keymap.shortcut(id) ? ` (${keymap.shortcut(id)})` : '');
    const toolName = {
      arrow: 'Arrow',
      lasso: 'Lasso',
      add: 'Add vertices',
      rotation: 'Rotation Deformer (drag)',
      path: 'Deform Path',
      brush: 'Brush Selection',
      deform: 'Deform Brush',
      addBrush: 'Add-Points Brush',
      stroke: 'Stroke Meshing (beta)',
    }[vp.tool];
    const parts: Node[] = [];
    if (this.tip)
      parts.push(
        h(
          'div.tip',
          { dataset: { testid: 'tip', code: this.tip.code } },
          h('span', this.tip.text),
          h(
            'button.close',
            {
              title: 'Close the tip',
              dataset: { testid: 'tip-close' },
              on: { click: () => ((this.tip = null), this.render()) },
            },
            '×',
          ),
        ),
      );
    parts.push(h('div.kind', `Tool: ${toolName} · Level edit ${e.level}`));
    if (vp.tool === 'path') parts.push(...this.pathDetails());
    if (vp.brushTool) parts.push(...this.brushDetails());
    if (e.meshEdit) {
      const run = (label: string, name: string, args: Record<string, unknown>) =>
        mesh && e.transact(label, [{ name, args: { target: mesh.uid, ...args } }]);
      parts.push(
        h('h3', 'Mesh Edit mode'),
        h(
          'div.buttons',
          h(
            'button',
            {
              class: vp.tool === 'arrow' ? 'on' : '',
              dataset: { testid: 'subtool-arrow' },
              on: { click: () => this.setTool('arrow') },
            },
            'Select and move',
          ),
          h(
            'button',
            {
              class: vp.tool === 'add' ? 'on' : '',
              dataset: { testid: 'tool-add' },
              title: 'Click inside the mesh to add a vertex; Alt+click deletes one',
              on: { click: () => this.setTool('add') },
            },
            'Add vertices',
          ),
          h(
            'button',
            {
              class: vp.tool === 'lasso' ? 'on' : '',
              on: { click: () => this.setTool('lasso') },
            },
            `Lasso${key('tool.lasso')}`,
          ),
        ),
        h(
          'div.facts',
          { dataset: { testid: 'vertex-selection' } },
          sel.length
            ? `${sel.length} selected: ${sel.slice(0, 12).join(', ')}${sel.length > 12 ? '…' : ''}`
            : 'No vertices selected.',
        ),
        h(
          'div.buttons',
          h(
            'button',
            {
              disabled: sel.length === 0,
              dataset: { testid: 'delete-vertices' },
              on: { click: () => run('Delete vertices', 'mesh.deleteVertices', { vertices: sel }) },
            },
            'Delete vertices',
          ),
          h(
            'button',
            {
              disabled: sel.length !== 2,
              dataset: { testid: 'flip-edge' },
              on: { click: () => run('Flip edge', 'mesh.flipEdge', { edge: sel }) },
            },
            'Flip edge',
          ),
          h(
            'button',
            {
              dataset: { testid: 'retriangulate' },
              on: { click: () => run('Retriangulate', 'mesh.retriangulate', {}) },
            },
            `Connect vertices${key('mesh.connect')}`,
          ),
          h(
            'button',
            { on: { click: () => this.ctx.dialogs.autoMesh() } },
            `Automatic mesh…${key('model.autoMesh')}`,
          ),
        ),
        h(
          'div.buttons',
          h(
            'button',
            {
              class: vp.tool === 'addBrush' ? 'on' : '',
              dataset: { testid: 'tool-addBrush' },
              title: 'Paint inside the mesh to add vertices a brush radius apart',
              on: { click: () => this.setTool('addBrush') },
            },
            'Add-points brush',
          ),
          h(
            'button',
            {
              dataset: { testid: 'mesh-subdivide' },
              title: 'Split every triangle into four (the mesh looks the same)',
              on: { click: () => keymap.run('mesh.subdivide') },
            },
            'Split into four',
          ),
          h(
            'button',
            {
              dataset: { testid: 'mesh-reset' },
              title:
                'Regenerate the mesh from its layer as the import made it (keyforms carry over)',
              on: { click: () => keymap.run('mesh.resetImported') },
            },
            'Reset to imported mesh',
          ),
        ),
        h(
          'div.buttons',
          h(
            'label.toggle',
            h('input', {
              type: 'checkbox',
              checked: vp.mirrorEdit,
              dataset: { testid: 'mesh-mirror' },
              on: {
                change: (ev) => {
                  vp.mirrorEdit = (ev.target as HTMLInputElement).checked;
                  vp.drawOverlay();
                },
              },
            }),
            ' Mirrored editing, axis at x =',
          ),
          h('input.num', {
            type: 'number',
            step: '1',
            value: String(vp.mirrorAxis ?? e.view.project().canvas.originX),
            title: 'Canvas pixels; the default is the canvas origin (the model’s center line)',
            dataset: { testid: 'mesh-mirror-axis' },
            on: {
              change: (ev) => {
                const n = Number((ev.target as HTMLInputElement).value);
                vp.mirrorAxis = Number.isFinite(n) ? n : null;
                vp.drawOverlay();
              },
            },
          }),
        ),
        h(
          'div.hint',
          'Drag vertices to move them over the image (every keyform follows). Run strands of vertices along thin lines, aim for even triangles, and enclose the whole image: nothing outside the mesh is drawn.',
        ),
        h(
          'div.buttons',
          h(
            'button.primary',
            {
              dataset: { testid: 'mesh-confirm' },
              on: { click: () => keymap.run('mesh.confirm') },
            },
            `Confirm${key('mesh.toggle')}`,
          ),
          h(
            'button',
            { dataset: { testid: 'mesh-cancel' }, on: { click: () => keymap.run('mesh.cancel') } },
            `Cancel${key('mesh.cancel')}`,
          ),
        ),
      );
    } else {
      parts.push(
        h(
          'div.hint',
          vp.tool === 'rotation'
            ? 'Drag on the canvas from the pivot in the rest direction: the drag sets the pivot and the Standard Angle, and the selection moves inside.'
            : e.level === 1
              ? 'Level 1: drag single points.'
              : e.level === 2
                ? 'Level 2: drag points, or the box around two or more selected points (corners scale, just outside a corner rotates; Shift keeps proportions, Alt scales about the center).'
                : 'Level 3: drag the box around the whole object.',
        ),
        h(
          'label.toggle',
          h('input', {
            type: 'checkbox',
            checked: vp.hideBox,
            dataset: { testid: 'hide-box' },
            on: {
              change: (ev) => {
                vp.hideBox = (ev.target as HTMLInputElement).checked;
                vp.drawOverlay();
              },
            },
          }),
          'Hide the transform box',
        ),
      );
      if (mesh)
        parts.push(
          h(
            'div.buttons',
            h(
              'button',
              {
                dataset: { testid: 'enter-mesh-edit' },
                on: { click: () => keymap.run('mesh.toggle') },
              },
              `Edit Mesh${key('mesh.toggle')}`,
            ),
          ),
          h(
            'div.facts',
            { dataset: { testid: 'vertex-selection' } },
            sel.length
              ? `${sel.length} selected: ${sel.slice(0, 12).join(', ')}${sel.length > 12 ? '…' : ''}`
              : 'No vertices selected.',
          ),
          h(
            'div.hint',
            'Drag vertices to shape this keyform. Arrow keys nudge (Shift: 10 px). Hold Shift to keep a single point on one axis.',
          ),
        );
      const sel0 = e.selection.uid ? e.view.get(e.selection.uid) : undefined;
      if (sel0?.kind === 'warp') {
        const shape = vp.netShape(sel0);
        const num = (value: number, max: number, testid: string, set: (n: number) => void) =>
          h('input.num', {
            type: 'number',
            min: '1',
            max: String(max),
            step: '1',
            value: String(value),
            dataset: { testid },
            on: {
              change: (ev) =>
                set(
                  Math.min(
                    max,
                    Math.max(1, Math.round(Number((ev.target as HTMLInputElement).value) || 1)),
                  ),
                ),
            },
          });
        parts.push(
          h('h3', 'Warp deformer'),
          h(
            'div.facts',
            `Grid ${sel0.cols} × ${sel0.rows} cells. ${
              e.level === 1
                ? 'Level 1: drag the grid points.'
                : e.level === 2
                  ? 'Level 2: drag the Bézier control points (round: corners, rings: handles) or the grid points.'
                  : 'Level 3: the box moves, scales and turns the whole grid.'
            }`,
          ),
          h(
            'label.toggle',
            'Bézier divisions',
            num(shape.bu, sel0.cols, 'bezier-cols', (bu) =>
              vp.setDivisions(sel0.uid, { ...shape, bu }),
            ),
            '×',
            num(shape.bv, sel0.rows, 'bezier-rows', (bv) =>
              vp.setDivisions(sel0.uid, { ...shape, bv }),
            ),
          ),
          h(
            'div.hint',
            'The control layer is a helper over the grid: moving a control point bends the grid smoothly and keeps its detail. Only the grid is saved and exported.',
          ),
        );
      }
    }
    fill(this.el, ...parts);
  }
}

// ---------------------------------------------------------------- parameters

/** «Parameter»: one slider per parameter, in groups, with the key buttons and the palette menu. */
export class ParameterPalette {
  readonly el = h('section.parameter');
  private filter = '';
  /** Shows only the parameters with keys on the selection. */
  keyedOnly = false;
  private readonly list = h('div.rows');

  constructor(private readonly ctx: PaletteContext) {
    const editor = ctx.editor;
    editor.on('project', () => this.render());
    editor.on('document', (e) => (touches(e, POSE_KINDS) || this.keyedOnly) && this.render());
    editor.on('selection', () => (this.keyedOnly ? this.render() : this.markSelected()));
    editor.on('pose', () => this.sync());
    editor.on('liveValues', () => this.sync());
    editor.on('mode', () => this.render());
    this.render();
  }

  private get editor(): Editor {
    return this.ctx.editor;
  }

  /** Parameters bound to any selected object. */
  private keyedOnSelection(): Set<Uid> {
    const out = new Set<Uid>();
    for (const u of this.editor.selection.uids) {
      const o = this.editor.view.get(u);
      if (o && 'rig' in o)
        for (const b of (o.rig as { bindings: { parameter: Uid }[] }).bindings)
          out.add(b.parameter);
    }
    return out;
  }

  render(): void {
    const v = this.editor.view;
    const project = v.project();
    const keyed = this.keyedOnly ? this.keyedOnSelection() : null;
    const groups = new Map<Uid | null, Parameter[]>();
    for (const uid of project.parameterOrder) {
      const p = v.getAs(uid, 'parameter');
      if (keyed && !keyed.has(uid)) continue;
      if (
        this.filter &&
        !p.exportId.toLowerCase().includes(this.filter) &&
        !p.name.toLowerCase().includes(this.filter)
      )
        continue;
      const list = groups.get(p.group) ?? [];
      list.push(p);
      groups.set(p.group, list);
    }
    const rows: Node[] = [];
    for (const [g, params] of groups) {
      if (g) rows.push(h('div.group', label(v.get(g))));
      for (const p of params) rows.push(this.slider(p));
    }
    if (rows.length === 0)
      rows.push(h('div.empty', this.filter || keyed ? 'No parameter matches.' : 'No parameters.'));
    fill(this.list, rows);
    const { canKey, keyTitle } = this.keyState();
    fill(
      this.el,
      h(
        'div.palette-bar',
        h(
          'button',
          {
            title: `Add two keys, at the ends of the range, ${keyTitle}`,
            disabled: !canKey,
            dataset: { testid: 'add-two-keys' },
            on: { click: () => this.addKeys(2) },
          },
          '+2 keys',
        ),
        h(
          'button',
          {
            title: `Add three keys, at the ends and the middle, ${keyTitle}`,
            disabled: !canKey,
            dataset: { testid: 'add-three-keys' },
            on: { click: () => this.addKeys(3) },
          },
          '+3 keys',
        ),
        h(
          'button',
          {
            title: 'Create a parameter',
            dataset: { testid: 'param-create' },
            on: { click: () => this.ctx.dialogs.createParameter() },
          },
          'New…',
        ),
        h(
          'button.menu-button',
          {
            title: 'Palette menu',
            dataset: { testid: 'param-menu' },
            on: { click: (e) => this.menu(e as MouseEvent) },
          },
          '⋯',
        ),
      ),
      h(
        'div.palette-bar',
        h('input.search', {
          placeholder: 'Find a parameter',
          value: this.filter,
          on: {
            input: (e) => {
              this.filter = (e.target as HTMLInputElement).value.toLowerCase();
              this.render();
              (this.el.querySelector('input.search') as HTMLInputElement).focus();
            },
          },
        }),
        h(
          'label.toggle',
          { title: 'Only the parameters with keys on the selection' },
          h('input', {
            type: 'checkbox',
            checked: this.keyedOnly,
            dataset: { testid: 'keyed-only' },
            on: {
              change: (e) => {
                this.keyedOnly = (e.target as HTMLInputElement).checked;
                this.render();
              },
            },
          }),
          'Keyed',
        ),
        h(
          'label.toggle',
          h('input', {
            type: 'checkbox',
            checked: this.editor.snapToKeys,
            dataset: { testid: 'snap' },
            on: {
              change: (e) => (this.editor.snapToKeys = (e.target as HTMLInputElement).checked),
            },
          }),
          'Snap',
        ),
      ),
      this.editor.lockDefault
        ? h(
            'div.hint.locked-default',
            { dataset: { testid: 'default-locked' } },
            'Default forms are locked.',
          )
        : null,
      this.list,
    );
  }

  /** The parameter last clicked, for the key buttons while objects are selected. */
  private lastParam: Uid | null = null;

  private menu(e: MouseEvent): void {
    const km = this.ctx.keymap;
    popupMenu(e, [
      {
        label: 'Reset Parameters',
        key: km.shortcut('model.resetParams'),
        run: () => km.run('model.resetParams'),
      },
      {
        label: 'Lock Default Forms',
        key: km.shortcut('model.lockDefault'),
        checked: this.editor.lockDefault,
        run: () => km.run('model.lockDefault'),
      },
      { label: 'New Parameter…', run: () => this.ctx.dialogs.createParameter() },
      {
        label: 'New Parameter Group…',
        testid: 'menu-new-param-group',
        run: () => this.ctx.dialogs.createParameterGroup(),
      },
    ]);
  }

  private slider(p: Parameter): HTMLElement {
    const value = this.editor.value(p.uid);
    const listId = `keys-${p.uid}`;
    const step = (p.max - p.min) / 1000 || 0.001;
    const range = h('input.range', {
      type: 'range',
      min: String(p.min),
      max: String(p.max),
      step: String(step),
      value: String(value),
      list: listId,
      on: {
        input: (e) => this.editor.setPose(p.uid, Number((e.target as HTMLInputElement).value)),
        // A right-click near a key snaps the slider to it.
        contextmenu: (e) => {
          e.preventDefault();
          const me = e as MouseEvent;
          const r = (e.target as HTMLElement).getBoundingClientRect();
          const at = p.min + ((me.clientX - r.left) / r.width) * (p.max - p.min);
          if (p.keys.length === 0) return;
          const near = p.keys.reduce((a, b) => (Math.abs(b - at) < Math.abs(a - at) ? b : a));
          this.editor.setPose(p.uid, near);
        },
      },
    });
    return h(
      'div.param',
      {
        class: this.editor.selection.uid === p.uid || this.lastParam === p.uid ? 'selected' : '',
        dataset: { param: p.exportId },
      },
      h(
        'button.pname',
        {
          title: `${p.name || p.exportId}: click to pick it for keys; double-click to edit its keys`,
          on: {
            click: () => {
              this.lastParam = p.uid;
              // With objects selected, the parameter is picked for the key buttons; otherwise selected.
              if (
                this.editor.selection.uids.some(
                  (u) => u !== p.uid && 'rig' in (this.editor.view.get(u) ?? {}),
                )
              )
                this.render();
              else this.editor.select(p.uid);
            },
            dblclick: () => this.ctx.dialogs.keys(p.uid),
          },
        },
        p.name || p.exportId,
      ),
      range,
      h(
        'datalist',
        { id: listId },
        p.keys.map((k) => h('option', { value: String(k) })),
      ),
      h('input.value', {
        type: 'number',
        step: String(step),
        value: round(value, p.decimals),
        on: {
          change: (e) => this.editor.setPose(p.uid, Number((e.target as HTMLInputElement).value)),
        },
      }),
      h(
        'span.onkey',
        { title: 'on a key' },
        p.keys.some((k) => Math.abs(k - value) < 1e-6) ? '◆' : '◇',
      ),
    );
  }

  /** The parameter the key buttons use, and whether they apply to the selection. */
  private keyState(): { param: Uid | null; canKey: boolean; keyTitle: string } {
    const v = this.editor.view;
    const sel = this.editor.selection.uid ? v.get(this.editor.selection.uid) : undefined;
    const param = sel?.kind === 'parameter' ? sel.uid : this.lastParam;
    const targets = this.editor.selection.uids.filter((u) => {
      const o = v.get(u);
      return o && 'rig' in o;
    });
    const canKey = param !== null && v.get(param) !== undefined && targets.length > 0;
    const keyTitle = canKey
      ? `for ${targets.length} object(s) on ${label(v.get(param!))}`
      : 'Select objects, then click a parameter’s name';
    return { param, canKey, keyTitle };
  }

  private addKeys(count: 2 | 3): void {
    const { param, canKey } = this.keyState();
    if (canKey && param) this.ctx.addKeys(param, count);
  }

  private markSelected(): void {
    const uid = this.editor.selection.uid;
    const o = uid ? this.editor.view.get(uid) : undefined;
    const id = o?.kind === 'parameter' ? o.exportId : null;
    for (const row of this.list.querySelectorAll<HTMLElement>('div.param'))
      row.classList.toggle('selected', row.dataset.param === id);
    // The key buttons follow the selection.
    const { canKey, keyTitle } = this.keyState();
    for (const [testid, what] of [
      ['add-two-keys', 'Add two keys, at the ends of the range,'],
      ['add-three-keys', 'Add three keys, at the ends and the middle,'],
    ] as const) {
      const b = this.el.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
      if (!b) continue;
      b.disabled = !canKey;
      b.title = `${what} ${keyTitle}`;
    }
  }

  /** Updates the values without rebuilding the list (so a dragged slider keeps its grip). */
  private sync(): void {
    const byId = new Map(this.editor.view.ofKind('parameter').map((p) => [p.exportId, p]));
    for (const row of this.list.querySelectorAll<HTMLElement>('div.param')) {
      const p = byId.get(row.dataset.param!);
      if (!p) continue;
      // During playback, the base value Mochi2D's motion gives (not the drawn one).
      const v = this.editor.live?.get(p.uid) ?? this.editor.value(p.uid);
      const range = row.querySelector<HTMLInputElement>('input.range')!;
      if (document.activeElement !== range) range.value = String(v);
      const num = row.querySelector<HTMLInputElement>('input.value')!;
      if (document.activeElement !== num) num.value = round(v, p.decimals);
      row.querySelector('.onkey')!.textContent = p.keys.some((k) => Math.abs(k - v) < 1e-6)
        ? '◆'
        : '◇';
    }
  }
}

// ---------------------------------------------------------------- menus

export interface MenuItem {
  label: string;
  key?: string;
  run?: () => void;
  checked?: boolean;
  disabled?: boolean;
  testid?: string;
}

/** A small pop-up menu at the pointer; it closes on the next press anywhere. */
export function popupMenu(e: MouseEvent, items: (MenuItem | null)[]): HTMLElement {
  document.querySelector('.ctx-menu')?.remove();
  const menu = h(
    'div.ctx-menu',
    { style: `left:${e.clientX}px;top:${e.clientY}px`, dataset: { testid: 'context-menu' } },
    items.map((it) =>
      it === null
        ? h('hr')
        : h(
            'button',
            {
              disabled: it.disabled ?? false,
              dataset: it.testid ? { testid: it.testid } : {},
              on: {
                click: () => {
                  menu.remove();
                  it.run?.();
                },
              },
            },
            h('span.check', it.checked ? '✓' : ''),
            h('span.label', it.label),
            h('span.key', it.key ?? ''),
          ),
    ),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight)
    menu.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  if (r.right > window.innerWidth)
    menu.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
  // A press outside closes it (a press on a menu title is left to the menu bar).
  const away = (ev: PointerEvent) => {
    const t = ev.target as HTMLElement;
    if (menu.isConnected && (menu.contains(t) || t.closest?.('.menu-title'))) return;
    menu.remove();
    window.removeEventListener('pointerdown', away, true);
  };
  setTimeout(() => window.addEventListener('pointerdown', away, true));
  return menu;
}

// ---------------------------------------------------------------- log

/** «Log»: what the editor did, with warning and error levels; it can be paused, copied and cleared. */
export class LogPalette {
  readonly el = h('section.log');
  readonly entries: (Message & { time: number })[] = [];
  private enabled = true;
  private large = false;

  constructor(editor: Editor) {
    const update = lazyRender(this.el, () => this.render());
    editor.on('message', (m) => {
      if (!this.enabled) return;
      this.entries.push({ ...m, time: Date.now() });
      if (this.entries.length > 1000) this.entries.shift();
      update();
    });
    editor.on('document', (e) => {
      if (!this.enabled) return;
      this.entries.push({ level: 'info', text: `${e.label} (${e.author})`, time: e.time });
      if (this.entries.length > 1000) this.entries.shift();
      update();
    });
    this.el.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.rows')) {
        this.large = !this.large;
        this.el.classList.toggle('large', this.large);
      }
    });
    this.render();
  }

  render(): void {
    const rows = this.entries
      .slice(-200)
      .reverse()
      .map((m) =>
        h(
          'div.row.problem',
          { class: m.level, dataset: { level: m.level, code: m.code ?? '' } },
          h('span.rev', new Date(m.time).toLocaleTimeString()),
          h('span.sev', m.level),
          h('span.name', { title: m.text }, m.text),
        ),
      );
    fill(
      this.el,
      h(
        'div.palette-bar',
        h(
          'label.toggle',
          h('input', {
            type: 'checkbox',
            checked: this.enabled,
            on: { change: (e) => (this.enabled = (e.target as HTMLInputElement).checked) },
          }),
          'Logging',
        ),
        h(
          'button',
          {
            on: {
              click: () =>
                void navigator.clipboard?.writeText(
                  this.entries
                    .map((m) => `${new Date(m.time).toISOString()} ${m.level} ${m.text}`)
                    .join('\n'),
                ),
            },
          },
          'Copy',
        ),
        h(
          'button',
          {
            on: {
              click: () => {
                this.entries.length = 0;
                this.render();
              },
            },
          },
          'Clear',
        ),
        h('span.hint', 'Double-click to enlarge'),
      ),
      h('div.rows', rows.length ? rows : h('div.empty', 'Nothing logged yet.')),
    );
  }
}

// ---------------------------------------------------------------- project

/** «Project»: the files the open model uses: the project file, the imported art and the assets. */
export class ProjectPalette {
  readonly el = h('section.project-files');

  constructor(private readonly editor: Editor) {
    const update = lazyRender(this.el, () => this.render());
    editor.on('project', update);
    editor.on('document', (e) => touches(e, new Set(['layer', 'sound', 'project'])) && update());
    this.render();
  }

  render(): void {
    const v = this.editor.view;
    const files = [...this.editor.fs.files.keys()]
      .filter((p) => p.startsWith(`${this.editor.dir}/`))
      .map((p) => p.slice(this.editor.dir.length + 1))
      .sort();
    const layers = v.ofKind('layer');
    const origin = v.project().importedFrom;
    fill(
      this.el,
      h(
        'div.row',
        h('span.icon', '▣'),
        h('span.name', `${this.editor.name}.mochi`),
        h('span.extra', 'model'),
      ),
      origin
        ? h(
            'div.origin',
            { dataset: { testid: 'project-origin' } },
            h('div.group', 'Imported from a .moc3'),
            h(
              'div.row',
              { style: 'padding-left:18px' },
              h('span.name', `version ${origin.mocVersion}, on ${origin.date.slice(0, 10)}`),
            ),
            origin.files.map((f) =>
              h(
                'div.row',
                { style: 'padding-left:18px' },
                h('span.icon', '·'),
                h('span.name.dim', f),
              ),
            ),
            h(
              'div.row.dim',
              { style: 'padding-left:18px' },
              'A reconstruction: names, source artwork and other editor data are not in a .moc3 file.',
            ),
          )
        : null,
      files.map((p) =>
        h('div.row', { style: 'padding-left:18px' }, h('span.icon', '·'), h('span.name', p)),
      ),
      h('div.group', `Layers (${layers.length})`),
      layers
        .slice(0, 200)
        .map((l) =>
          h(
            'div.row',
            { style: 'padding-left:18px' },
            h('span.icon', '▧'),
            h('span.name', label(l)),
          ),
        ),
    );
  }
}

// ---------------------------------------------------------------- our own: history, validation, agents, art, preview

export class HistoryPalette {
  readonly el = h('section.history');

  constructor(private readonly editor: Editor) {
    const update = lazyRender(this.el, () => this.render());
    editor.on('project', update);
    editor.on('document', update);
    this.render();
  }

  render(): void {
    const history = this.editor.session.history();
    const rows = history
      .map((e, i) =>
        h(
          'div.row.history',
          { dataset: { author: e.author } },
          h('span.rev', `${i + 1}`),
          h('span.name', e.label),
          h('span.author', { class: e.author === 'person' ? '' : 'agent' }, e.author),
        ),
      )
      .reverse();
    fill(this.el, h('div.rows', rows.length ? rows : h('div.empty', 'No changes yet.')));
  }
}

export class ValidationPalette {
  readonly el = h('section.validation');
  private validation: {
    violations: { uid: string; path: string; message: string }[];
    lint: { severity: string; rule: string; message: string; uid?: string }[];
  } | null = null;
  exportProblems: { severity: string; code: string; message: string; uid?: string }[] | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly agent: AgentSurface,
  ) {
    editor.on('project', () => {
      this.exportProblems = null;
      this.validation = null;
      this.render();
    });
    editor.on('document', () => {
      this.validation = null;
      // Validating takes time on large documents: only while the palette is shown.
      if (this.el.isConnected) this.render();
    });
    this.el.addEventListener('shown', () => this.render());
  }

  render(): void {
    this.validation ??= this.editor.session.validate();
    const items = [
      ...this.validation.violations.map((x) => ({
        severity: 'error',
        code: x.path,
        message: x.message,
        uid: x.uid,
      })),
      ...this.validation.lint.map((x) => ({
        severity: x.severity,
        code: x.rule,
        message: x.message,
        uid: x.uid,
      })),
      ...(this.exportProblems ?? []).map((x) => ({ ...x, code: `export: ${x.code}` })),
    ];
    fill(
      this.el,
      h(
        'div.palette-bar',
        h(
          'button',
          {
            dataset: { testid: 'export-check' },
            on: {
              click: async () => {
                try {
                  const r = await this.agent.export();
                  this.exportProblems = r.report.problems;
                  if (r.report.problems.length === 0)
                    this.editor.emit('message', {
                      level: 'info',
                      text: `The export check passed: version ${r.report.mocVersion}, ${r.files.length} files.`,
                    });
                } catch (e) {
                  const d = (e as { details?: { problems?: ValidationPalette['exportProblems'] } })
                    .details;
                  this.exportProblems = d?.problems ?? [
                    { severity: 'error', code: 'export', message: (e as Error).message },
                  ];
                }
                this.render();
              },
            },
          },
          'Run the export check',
        ),
      ),
      h(
        'div.rows',
        items.length
          ? items.map((x) =>
              h(
                'div.row.problem',
                {
                  class: x.severity,
                  on: {
                    click: () => x.uid && this.editor.view.get(x.uid) && this.editor.select(x.uid),
                  },
                },
                h('span.sev', x.severity),
                h('span.code', x.code),
                h('span.name', x.message),
              ),
            )
          : h('div.empty', 'No problems.'),
      ),
    );
  }
}

export class AgentsPalette {
  readonly el = h('section.agents');

  constructor(
    private readonly agent: AgentSurface,
    private readonly host: BridgeHost,
  ) {
    host.on('call', () => this.el.isConnected && this.render());
    setInterval(() => this.el.isConnected && this.render(), 1000);
    this.el.addEventListener('shown', () => this.render());
    this.render();
  }

  render(): void {
    const rows: Node[] = [];
    for (const c of this.host.calls.slice(-100).reverse())
      rows.push(
        h(
          'div.row',
          { dataset: { bridgeCall: c.name } },
          h('span.rev', new Date(c.time).toLocaleTimeString()),
          h('span.name', c.label && c.label !== c.name ? `${c.name}: ${c.label}` : c.name),
          h('span.author.agent', c.client),
          c.ok ? null : h('span.sev.error', { title: c.error ?? '' }, 'failed'),
        ),
      );
    const calls = this.agent.calls.slice(-100).reverse();
    for (const c of calls)
      rows.push(
        h(
          'div.row',
          h('span.rev', new Date(c.time).toLocaleTimeString()),
          h('span.name', c.method),
          h('span.author.agent', c.author),
          c.ok ? null : h('span.sev.error', 'failed'),
        ),
      );
    if (rows.length === 0)
      rows.push(
        h(
          'div.empty',
          'No agent has called window.mochi yet. Try window.mochi.describe() in the console.',
        ),
      );
    fill(this.el, h('div.rows', rows));
  }
}

export class ArtPalette {
  readonly el = h('section.art');

  constructor(
    private readonly editor: Editor,
    private readonly link: LiveLink,
    onReimport: () => void,
  ) {
    link.on('reimported', () => {
      onReimport();
      this.render();
    });
    const update = lazyRender(this.el, () => this.render());
    link.on('status', update);
    editor.on('project', update);
    this.render();
  }

  render(): void {
    const st = this.link.status;
    const r = st.last;
    const body: Node[] = [
      h(
        'div.facts',
        st.watching
          ? `Linked to ${st.file}: re-imported when it is saved (checked every half second).`
          : 'Not linked. File › Link Art (Chromium) watches the file; File › Re-import Art picks it once.',
        st.error ? h('span.sev.error', ` ${st.error}`) : null,
      ),
    ];
    if (!r) body.push(h('div.empty', 'No re-import yet.'));
    else {
      const v = this.editor.view;
      const name = (uid: string) => {
        const o = v.get(uid);
        return o && 'exportId' in o ? o.exportId : o && 'name' in o ? String(o.name) : uid;
      };
      const row = (cls: string, label: string, text: string, uid?: string) =>
        h(
          'div.row.problem',
          {
            class: cls,
            dataset: { reimport: label },
            on: { click: () => uid && v.get(uid) && this.editor.select(uid) },
          },
          h('span.sev', label),
          h('span.name', text),
        );
      body.push(
        h(
          'div.facts',
          `${r.path}: ${r.changed.length} changed, ${r.unchanged} unchanged, ${r.added.length} added, ${r.removed.length} removed.`,
        ),
      );
      for (const x of r.refit)
        body.push(
          row(
            'warning',
            're-fit',
            `${name(x.mesh)}: ${x.reasons.join(', ')} (art outside ${(x.uncovered * 100).toFixed(1)} %, over empty ${(x.overEmpty * 100).toFixed(1)} %)`,
            x.mesh,
          ),
        );
      for (const x of r.changed)
        body.push(
          row(
            'info',
            'changed',
            `${x.name}${x.boundsChanged ? ' (bounds changed)' : ''}${x.movedFrom ? ` (was ${x.movedFrom})` : ''}`,
          ),
        );
      for (const x of r.added)
        body.push(row('info', 'added', `${x.path}: a new layer, not meshed yet`, x.layer));
      for (const x of r.removed)
        body.push(
          row(
            'warning',
            'removed',
            `${x.name}: no longer in the file; kept with ${x.meshes.length} mesh(es)`,
            x.meshes[0] ?? x.layer,
          ),
        );
    }
    fill(this.el, h('div.rows', body));
  }
}

export class PreviewPalette {
  readonly el = h('section.preview');

  constructor(private readonly viewport: Viewport) {
    setInterval(() => this.el.isConnected && this.render(), 1000);
    this.el.addEventListener('shown', () => this.render());
    this.render();
  }

  render(): void {
    const b = this.viewport.builds.slice(-30).reverse();
    const drag = this.viewport.dragFrames;
    const rows: Node[] = [];
    if (drag.length)
      rows.push(
        h('div.facts', `Drag frames: median ${round(median(drag), 1)} ms over ${drag.length}.`),
      );
    for (const s of b)
      rows.push(
        h(
          'div.row',
          h('span.rev', `r${s.revision}${s.provisional ? '*' : ''}`),
          h(
            'span.name',
            `${round(s.total, 1)} ms: build ${round(s.timings.total, 1)} (atlas ${round(s.timings.atlas, 1)}${s.atlasReused ? ' reused' : ''}, lower ${round(s.timings.lower, 1)}, write ${round(s.timings.write, 1)}) + ${s.mode} ${round(s.load, 1)}`,
          ),
          h('span.author', `${s.drawables} drawables`),
        ),
      );
    if (b.length === 0) rows.push(h('div.empty', 'No preview builds yet.'));
    fill(this.el, h('div.rows', rows));
  }
}

export const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
