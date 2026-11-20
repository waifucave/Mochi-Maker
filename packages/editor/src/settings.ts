/**
 * The editor's environment settings (File › Environment Settings): the person's preferences,
 * including the choices where conventions differ, so each one can be changed. Kept in the browser's local storage; the
 * editor works the same without it.
 */
import { Emitter } from './editor.js';

export interface Settings {
  /** Selecting a view tab switches to the workspace that suits it. */
  autoSwitchWorkspace: boolean;
  /** A double-click on an ArtMesh enters mesh editing. */
  doubleClickMeshEdit: boolean;
  /** A right-click on an object opens a menu that begins with its parent deformers. */
  ancestorMenu: boolean;
  /** Locking an object in the Parts or Deformer palette also locks its Inspector fields. */
  lockLocksInspector: boolean;
  /** On macOS, what "Ctrl" in a shortcut means. */
  macCtrl: 'command' | 'control';
  /** The display menu's label. */
  displayMenuLabel: 'Show' | 'Display';
  /** The export submenu's label. */
  exportMenuLabel: 'Export For Runtime' | 'Export Embedded File';
  /** Which ArtMeshes the Ctrl+right-click list shows. */
  meshList: 'under-pointer' | 'all';
  /**
   * On the transform box, a press this many CSS pixels around a corner scales; a press
   * further out, up to twice this, rotates.
   */
  cornerReach: number;
  /** Shift+drag on a rotation deformer's handle turns in steps of this many degrees. */
  rotationStep: number;
  /** Home at startup, and whether it closes once a file is opened. */
  homeAtStartup: boolean;
  homeClosesOnOpen: boolean;
  /** Gentle warnings at the point of action (guide section 6). */
  tips: boolean;
  /** Glue authoring, off by default in this build (feature flag `glue`). */
  featureGlue: boolean;
  /** Blend-shape authoring, off by default in this build (feature flag `blendShapes`). */
  featureBlendShapes: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoSwitchWorkspace: true,
  doubleClickMeshEdit: true,
  ancestorMenu: true,
  lockLocksInspector: true,
  macCtrl: 'command',
  displayMenuLabel: 'Show',
  exportMenuLabel: 'Export For Runtime',
  meshList: 'under-pointer',
  cornerReach: 8,
  rotationStep: 45,
  homeAtStartup: true,
  homeClosesOnOpen: true,
  tips: true,
  featureGlue: false,
  featureBlendShapes: false,
};

/** Reads and writes JSON in local storage; every access may throw (private windows, previews). */
export const store = {
  get<T>(key: string): T | undefined {
    try {
      const s = localStorage.getItem(key);
      return s === null ? undefined : (JSON.parse(s) as T);
    } catch {
      return undefined;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* not kept */
    }
  },
};

const KEY = 'mochi-maker.settings';

export class SettingsStore extends Emitter<{ change: Settings }> {
  value: Settings;

  constructor() {
    super();
    this.value = { ...DEFAULT_SETTINGS, ...(store.get<Partial<Settings>>(KEY) ?? {}) };
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.value = { ...this.value, [key]: value };
    store.set(KEY, this.value);
    this.emit('change', this.value);
  }

  reset(): void {
    this.value = { ...DEFAULT_SETTINGS };
    store.set(KEY, this.value);
    this.emit('change', this.value);
  }
}

export const isMac = (): boolean =>
  /Mac|iPhone|iPad/.test(
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      navigator.platform ??
      '',
  );
