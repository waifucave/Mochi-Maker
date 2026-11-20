/**
 * Keyboard shortcuts: every editor action has an ID, a category,
 * a label and default keys, and the person can rebind any of them, with several keys per action,
 * import and export. Only the person's changes are stored, so new default keys of a later version
 * take effect without a reset.
 *
 * Keys are written as `Ctrl+Alt+Shift+<key>`. Letters are physical keys (`KeyA` → `A`), the digits
 * above the letters are `0`–`9`, and keypad keys keep their names (`Numpad1`): they count as
 * different keys. On macOS, `Ctrl` means Command unless the settings say Control; the
 * other modifier then shows as `Control`.
 */
import { Emitter } from './editor.js';
import { isMac, store, type SettingsStore } from './settings.js';

export type Category = 'Menus' | 'Tools' | 'View area' | 'Palettes';

export interface Action {
  id: string;
  category: Category;
  label: string;
  /** Default keys. */
  keys?: string[];
  run: () => void;
  /** Whether the action applies now; a key bound to several actions runs the first that does. */
  enabled?: () => boolean;
  /**
   * Where the action applies, such as mesh editing. A key may serve one action in a context and
   * another elsewhere without counting as a duplicate.
   */
  context?: string;
  /** A checkable action (menus show a mark). */
  checked?: () => boolean;
  /** Runs even while the focus is in a text field. */
  inInputs?: boolean;
  /**
   * A key held while dragging (Space to pan, R to rotate). It is bound like any other action;
   * `run` is called for a tap without a drag.
   */
  hold?: boolean;
}

export interface KeyFile {
  format: 'mochi-maker-shortcuts';
  version: 1;
  bindings: Record<string, string[]>;
}

const KEY = 'mochi-maker.shortcuts';
const MODS = ['Ctrl', 'Control', 'Alt', 'Shift'] as const;

/** The base key of a keyboard event, in binding form. */
export function baseKey(e: Pick<KeyboardEvent, 'code' | 'key'>): string {
  const c = e.code ?? '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (c.startsWith('Numpad')) return c;
  if (c === 'Space' || e.key === ' ') return 'Space';
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key;
}

/** Normalizes a binding's text: modifiers in a fixed order, known spellings. */
export function normalizeKey(s: string): string {
  const parts = s
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const mods = new Set<string>();
  let base = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'cmd' || l === 'command' || l === 'mod' || l === '⌘')
      mods.add('Ctrl');
    else if (l === 'control' || l === '⌃') mods.add('Control');
    else if (l === 'alt' || l === 'option' || l === '⌥') mods.add('Alt');
    else if (l === 'shift' || l === '⇧') mods.add('Shift');
    else
      base = p.length === 1 ? p.toUpperCase() : p === 'Esc' ? 'Escape' : p === 'Del' ? 'Delete' : p;
  }
  return [...MODS.filter((m) => mods.has(m)), base].join('+');
}

export class Keymap extends Emitter<{ change: void }> {
  readonly actions = new Map<string, Action>();
  /** The person's changes: action ID → its keys (replacing the defaults). */
  private overrides: Record<string, string[]>;
  /** Forces the macOS behavior (tests). */
  mac: boolean = isMac();
  private readonly held = new Set<string>();
  private holdUsed = new Set<string>();

  constructor(private readonly settings: SettingsStore) {
    super();
    this.overrides = store.get<Record<string, string[]>>(KEY) ?? {};
  }

  register(actions: Action[]): void {
    for (const a of actions) this.actions.set(a.id, a);
    this.emit('change', undefined);
  }

  get(id: string): Action | undefined {
    return this.actions.get(id);
  }

  run(id: string): void {
    const a = this.actions.get(id);
    if (a && (a.enabled?.() ?? true)) a.run();
  }

  defaults(id: string): string[] {
    return (this.actions.get(id)?.keys ?? []).map(normalizeKey);
  }

  keysOf(id: string): string[] {
    return this.overrides[id] ?? this.defaults(id);
  }

  setKeys(id: string, keys: string[]): void {
    const norm = [...new Set(keys.map(normalizeKey).filter((k) => k && !k.endsWith('+')))];
    const d = this.defaults(id);
    if (norm.length === d.length && norm.every((k, i) => k === d[i])) delete this.overrides[id];
    else this.overrides[id] = norm;
    this.save();
  }

  /** The person's changes, for restoring a dialog's starting state. */
  snapshot(): Record<string, string[]> {
    return structuredClone(this.overrides);
  }

  restore(s: Record<string, string[]>): void {
    this.overrides = structuredClone(s);
    this.save();
  }

  resetAll(): void {
    this.overrides = {};
    this.save();
  }

  private save(): void {
    store.set(KEY, this.overrides);
    this.emit('change', undefined);
  }

  /** Keys bound to more than one action of the same context: key → action IDs. */
  conflicts(): Map<string, string[]> {
    const by = new Map<string, string[]>();
    for (const a of this.actions.values())
      for (const k of this.keysOf(a.id)) {
        const slot = `${a.context ?? ''}\u0000${k}`;
        by.set(slot, [...(by.get(slot) ?? []), a.id]);
      }
    const out = new Map<string, string[]>();
    for (const [slot, ids] of by)
      if (ids.length > 1) {
        const k = slot.split('\u0000')[1]!;
        out.set(k, [...(out.get(k) ?? []), ...ids]);
      }
    return out;
  }

  exportFile(): KeyFile {
    const bindings: Record<string, string[]> = {};
    for (const id of [...this.actions.keys()].sort()) bindings[id] = this.keysOf(id);
    return { format: 'mochi-maker-shortcuts', version: 1, bindings };
  }

  /** Applies a file from `exportFile` (any platform). Returns the number of actions it set. */
  importFile(file: unknown): number {
    const f = file as Partial<KeyFile>;
    if (f?.format !== 'mochi-maker-shortcuts' || typeof f.bindings !== 'object' || !f.bindings)
      throw new Error('This is not a Mochi Maker shortcut file.');
    let n = 0;
    for (const [id, keys] of Object.entries(f.bindings))
      if (this.actions.has(id) && Array.isArray(keys)) {
        this.setKeys(
          id,
          keys.filter((k): k is string => typeof k === 'string'),
        );
        n++;
      }
    return n;
  }

  /** A keyboard event in binding form, or null for a lone modifier. */
  eventKey(e: KeyboardEvent): string | null {
    if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return null;
    const cmdIsCtrl = !this.mac || this.settings.value.macCtrl === 'command';
    const ctrl = this.mac ? (cmdIsCtrl ? e.metaKey : e.ctrlKey) : e.ctrlKey || e.metaKey;
    const control = this.mac && cmdIsCtrl && e.ctrlKey;
    const mods = [ctrl && 'Ctrl', control && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'];
    return [...mods.filter(Boolean), baseKey(e)].join('+');
  }

  /** A binding as the person reads it on this platform. */
  label(key: string): string {
    if (!this.mac) return key;
    const cmd = this.settings.value.macCtrl === 'command';
    return key
      .split('+')
      .map((p) =>
        p === 'Ctrl'
          ? cmd
            ? '⌘'
            : '⌃'
          : p === 'Control'
            ? '⌃'
            : p === 'Alt'
              ? '⌥'
              : p === 'Shift'
                ? '⇧'
                : p,
      )
      .join(cmd ? '' : '+');
  }

  /** The first key of an action, as shown in menus and tooltips. */
  shortcut(id: string): string {
    const k = this.keysOf(id)[0];
    return k ? this.label(k) : '';
  }

  // ---------------------------------------------------------------- dispatch

  /** Handles a keydown: runs the first enabled action bound to it. True when one ran. */
  keydown(e: KeyboardEvent): boolean {
    const key = this.eventKey(e);
    if (!key) return false;
    const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select') != null;
    // Exact matches first; then holds with Shift added (Space+Shift+drag pans along one axis).
    const loose = key.replace('Shift+', '');
    const candidates = [
      ...[...this.actions.values()].filter((a) => this.keysOf(a.id).includes(key)),
      ...[...this.actions.values()].filter(
        (a) => a.hold && loose !== key && this.keysOf(a.id).includes(loose),
      ),
    ];
    for (const a of candidates) {
      if (typing && !a.inInputs) continue;
      if (!(a.enabled?.() ?? true)) continue;
      e.preventDefault();
      if (a.hold) {
        if (!this.held.has(a.id)) {
          this.held.add(a.id);
          this.holdUsed.delete(a.id);
        }
        return true;
      }
      if (!e.repeat || a.category === 'Tools' || a.id.startsWith('anim.')) a.run();
      return true;
    }
    return false;
  }

  /** Handles a keyup: ends holds, and runs a hold action that was tapped without a drag. */
  keyup(e: KeyboardEvent): void {
    const base = baseKey(e);
    for (const id of [...this.held]) {
      const bound = this.keysOf(id).some((k) => k.split('+').pop() === base);
      if (!bound) continue;
      this.held.delete(id);
      if (!this.holdUsed.has(id)) this.actions.get(id)?.run();
    }
  }

  /** Whether a hold action's key is down. */
  isHeld(id: string): boolean {
    return this.held.has(id);
  }

  /** Marks a held key as used for a drag, so releasing it is not a tap. */
  useHold(id: string): void {
    this.holdUsed.add(id);
  }

  /** Forgets held keys (the window lost focus). */
  releaseAll(): void {
    this.held.clear();
  }
}
