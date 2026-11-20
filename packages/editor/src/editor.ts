/**
 * The editor's state: the open session and its assets, the selection and the pose. Every change to
 * the document goes through the session's commands, so what a person does in the editor is what an
 * agent does through the agent API, and both land in the same history.
 *
 * Pose state (parameter values) belongs to the view, not the document (design 4.4).
 */
import {
  MemoryAssetStore,
  MemoryFileSystem,
  MochiError,
  NO_FEATURES,
  Session,
  f32,
  loadProject,
  runItems,
  saveProject,
  type AssetStore,
  type ArtMesh,
  type Binding,
  type CanvasInit,
  type Document,
  type DocReader,
  type RunItemsResult,
  type TransactionResult,
  type Uid,
  type Features,
} from '@mochi-maker/core';
import { OPERATIONS } from '@mochi-maker/export';

export interface Selection {
  /** The primary selected object (the last one picked). */
  uid: Uid | null;
  /** Every selected object, the primary one last. */
  uids: Uid[];
  /** Selected vertices of the primary object, when it is a mesh. */
  vertices: number[];
}

export interface Message {
  /** `warning`: a gentle warning at the point of action. */
  level: 'info' | 'warning' | 'error';
  text: string;
  code?: string;
}

/** Edit levels: 1 points only, 2 points and the box, 3 the box only. */
export type EditLevel = 1 | 2 | 3;

/** Mesh editing: the meshes edited, and the revision when it started (for Cancel). */
export interface MeshEdit {
  uids: Uid[];
  revision: number;
}

export interface DocumentEvent {
  revision: number;
  author: string;
  label: string;
  changes: { uid: Uid; kind: string; change: string }[];
  time: number;
}

type Events = {
  /** A new project (or none) is open. */
  project: void;
  /** The document changed: a transaction, an undo or a redo, from anyone. */
  document: DocumentEvent;
  selection: Selection;
  pose: void;
  /** The person moved a parameter (a slider or a handle), not motion playback. */
  poseEdit: { param: Uid; value: number };
  /** The values Mochi2D's playback gives the parameters changed (see `live`). */
  liveValues: void;
  message: Message;
  /** Who may commit now (the control lease). */
  control: Control;
  /** Mesh editing, the edit level or the lock of default forms changed. */
  mode: void;
  /** Objects were hidden, shown, locked or unlocked (view state, not the document). */
  viewState: void;
};

/**
 * The control lease (agent API design 5.3): the person always wins. While the person is editing
 * (a gesture in the viewport, and a short while after any of their own commits) or has paused
 * agents, agents' edits are refused with E_CONTROL_HELD; reads, renders and dry runs still work.
 */
export type Holder = 'free' | 'person' | 'paused';
export interface Control {
  holder: Holder;
  /** Milliseconds until a person's hold ends by itself (0 when free or paused). */
  retryAfter: number;
}
/** How long the person keeps the lease after a gesture or a commit. */
export const PERSON_HOLD_MS = 1500;

export class Emitter<E extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof E, Set<(e: never) => void>>();
  on<K extends keyof E>(type: K, fn: (e: E[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as (e: never) => void);
    return () => set!.delete(fn as (e: never) => void);
  }
  emit<K extends keyof E>(type: K, e: E[K]): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as (e: E[K]) => void)(e);
  }
}

/** Where a keyform edit at the current pose goes: a cell, or why there is none. */
export type CellAtPose =
  | { ok: true; cell: Record<Uid, number>; index: number }
  | { ok: false; reason: string; parameter: Uid; value: number; keys: number[] };

export class Editor extends Emitter<Events> {
  session: Session;
  assets: AssetStore;
  /** The project's files, in memory: what was opened, and what Save writes. */
  fs = new MemoryFileSystem();
  readonly dir = 'project';
  name = 'Untitled';
  selection: Selection = { uid: null, uids: [], vertices: [] };
  /** Mesh editing (Ctrl+E), or null. */
  meshEdit: MeshEdit | null = null;
  level: EditLevel = 2;
  /** «Lock Default Forms» (Ctrl+Shift+1): edits at the default form of a keyed object are refused. */
  lockDefault = false;
  /** Hidden and locked objects: the person's view, not the document (Ctrl+2 and Ctrl+3 families). */
  readonly hidden = new Set<Uid>();
  readonly locked = new Set<Uid>();
  /** Show the selection solo (S): the objects shown alone, or null. */
  solo: Uid[] | null = null;
  /** Canvas locks (Shift+A, Shift+D): drawables or deformers cannot be picked on the canvas. */
  canvasLock = { drawables: false, deformers: false };
  /** Physics settings left out of the preview while testing (the physics dialog's toggles). */
  readonly physicsMuted = new Set<Uid>();
  /** Called before a person's edit; returns a reason to refuse it (the default-form lock). */
  guard: (calls: { name: string; args: unknown }[]) => string | null = () => null;
  /** Parameter values by UID; parameters not listed are at their default. */
  pose = new Map<Uid, number>();
  snapToKeys = true;
  /** Document events, newest last (the activity panel). */
  readonly activity: DocumentEvent[] = [];
  /** The document at each revision this editor session has been at (for diffs). */
  readonly snapshots = new Map<number, Document>();
  private unsubscribe: () => void = () => {};

  /** Glue and blend-shape authoring (the settings' Features); off by default. */
  features: Features;

  constructor(features: Features = NO_FEATURES) {
    super();
    this.features = features;
    this.session = Session.create({ width: 1024, height: 1024 }, { features });
    this.assets = new MemoryAssetStore();
    this.snapshots.set(0, this.session.doc);
    this.attach();
  }

  /** Switches glue and blend-shape authoring on or off for this and later sessions. */
  setFeatures(features: Features): void {
    this.features = features;
    this.session.features = features;
    this.emit('mode', undefined);
  }

  get view(): DocReader {
    return this.session.view;
  }

  private attach(): void {
    this.unsubscribe();
    this.unsubscribe = this.session.onChange((e) => {
      const event: DocumentEvent = { ...e, time: Date.now() };
      this.snapshots.set(e.revision, this.session.doc);
      this.activity.push(event);
      if (this.activity.length > 500) this.activity.shift();
      // Drop a selection whose object is gone, and vertices past the end.
      const uids = this.selection.uids.filter((u) => this.view.get(u));
      const sel = this.selection.uid ? this.view.get(this.selection.uid) : undefined;
      if (this.selection.uid && !sel)
        this.selection = { uid: uids.at(-1) ?? null, uids, vertices: [] };
      else if (sel?.kind === 'artMesh') {
        const n = sel.uv.length / 2;
        this.selection = {
          uid: sel.uid,
          uids,
          vertices: this.selection.vertices.filter((v) => v < n),
        };
      } else this.selection = { ...this.selection, uids };
      for (const set of [this.hidden, this.locked])
        for (const u of [...set]) if (!this.view.get(u)) set.delete(u);
      if (this.meshEdit && !this.meshEdit.uids.every((u) => this.view.get(u))) {
        this.meshEdit = null;
        this.emit('mode', undefined);
      }
      for (const uid of [...this.pose.keys()]) if (!this.view.get(uid)) this.pose.delete(uid);
      if (e.author === 'person' && !e.label.startsWith('Undo ') && !e.label.startsWith('Redo ')) {
        this.holdUntil = Math.max(this.holdUntil, Date.now() + PERSON_HOLD_MS);
        this.controlChanged();
      }
      this.emit('document', event);
      this.emit('selection', this.selection);
    });
  }

  /** Opens a session (a new or loaded project). */
  openSession(session: Session, assets: AssetStore, name: string, fs?: MemoryFileSystem): void {
    this.session = session;
    this.assets = assets;
    this.name = name;
    this.fs = fs ?? new MemoryFileSystem();
    this.selection = { uid: null, uids: [], vertices: [] };
    this.meshEdit = null;
    this.hidden.clear();
    this.locked.clear();
    this.solo = null;
    this.pose.clear();
    this.activity.length = 0;
    this.snapshots.clear();
    this.snapshots.set(session.revision, session.doc);
    this.attach();
    this.emit('project', undefined);
    this.emit('selection', this.selection);
    this.emit('pose', undefined);
    this.emit('mode', undefined);
    this.emit('viewState', undefined);
  }

  newProject(canvas: CanvasInit = { width: 1024, height: 1024 }): void {
    this.openSession(
      Session.create(canvas, { features: this.features }),
      new MemoryAssetStore(),
      'Untitled',
    );
  }

  /**
   * Opens a project from its files (path → bytes), as read from a folder or a zip. The folder that
   * holds mochi-project.json is the project; anything around it is ignored.
   */
  async openFiles(files: Map<string, Uint8Array>, name?: string): Promise<void> {
    const manifest = [...files.keys()]
      .filter((p) => p === 'mochi-project.json' || p.endsWith('/mochi-project.json'))
      .sort((a, b) => a.split('/').length - b.split('/').length)[0];
    if (!manifest)
      throw new MochiError('E_PROJECT_FORMAT', 'These files hold no mochi-project.json.');
    const prefix = manifest.slice(0, -'mochi-project.json'.length);
    const fs = new MemoryFileSystem();
    for (const [p, bytes] of files)
      if (p.startsWith(prefix)) await fs.writeBytes(`${this.dir}/${p.slice(prefix.length)}`, bytes);
    const { doc, assets } = await loadProject(fs, this.dir);
    const projectName =
      name ?? (prefix.replace(/\/$/, '').split('/').pop() || 'project').replace(/\.mochi$/, '');
    this.openSession(Session.open(doc, { features: this.features }), assets, projectName, fs);
  }

  /** Writes the project into its in-memory folder and returns its files (path → bytes). */
  async saveFiles(): Promise<Map<string, Uint8Array>> {
    await saveProject(this.fs, this.dir, this.session.doc, this.assets);
    const out = new Map<string, Uint8Array>();
    for (const [p, bytes] of this.fs.files)
      if (p.startsWith(`${this.dir}/`)) out.set(p.slice(this.dir.length + 1), bytes);
    return out;
  }

  // ---------------------------------------------------------------- changes

  /** Reports an error from a command (or anything else) to the person. */
  report(e: unknown): void {
    const err = e instanceof MochiError ? e : undefined;
    const text = err
      ? `${err.command ? `${err.command}: ` : ''}${err.message}`
      : ((e as Error)?.message ?? String(e));
    this.emit('message', { level: 'error', text, code: err?.code });
  }

  /** One transaction by the person. Errors are reported and nothing is committed. */
  transact(
    label: string,
    calls: { name: string; args: unknown }[],
    author = 'person',
  ): TransactionResult | undefined {
    const refused = author === 'person' ? this.guard(calls) : null;
    if (refused) {
      this.emit('message', { level: 'error', text: refused, code: 'E_DEFAULT_LOCKED' });
      return undefined;
    }
    try {
      return this.session.transact(
        label,
        (tx) => {
          for (const c of calls) tx.run(c.name, c.args);
        },
        { author },
      );
    } catch (e) {
      this.report(e);
      return undefined;
    }
  }

  /** One transaction of commands and operations by the person. Errors are reported. */
  async runItems(
    label: string,
    calls: { name: string; args: unknown }[],
    author = 'person',
  ): Promise<RunItemsResult | undefined> {
    const refused = author === 'person' ? this.guard(calls) : null;
    if (refused) {
      this.emit('message', { level: 'error', text: refused, code: 'E_DEFAULT_LOCKED' });
      return undefined;
    }
    try {
      return await runItems(
        { session: this.session, assets: this.assets, fs: this.fs },
        label,
        calls,
        {
          author,
          operations: OPERATIONS,
        },
      );
    } catch (e) {
      this.report(e);
      return undefined;
    }
  }

  undo(): void {
    if (!this.session.canUndo) return;
    this.personGesture(false);
    try {
      this.session.undo();
    } catch (e) {
      this.report(e);
    }
  }

  redo(): void {
    if (!this.session.canRedo) return;
    this.personGesture(false);
    try {
      this.session.redo();
    } catch (e) {
      this.report(e);
    }
  }

  // ---------------------------------------------------------------- the control lease

  private gesture = false;
  private holdUntil = 0;
  private paused = false;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHolder: Holder = 'free';

  get control(): Control {
    if (this.paused) return { holder: 'paused', retryAfter: 0 };
    const left = this.holdUntil - Date.now();
    if (this.gesture) return { holder: 'person', retryAfter: PERSON_HOLD_MS };
    if (left > 0) return { holder: 'person', retryAfter: left };
    return { holder: 'free', retryAfter: 0 };
  }

  private controlChanged(): void {
    clearTimeout(this.holdTimer);
    const c = this.control;
    if (c.holder === 'person' && !this.gesture)
      this.holdTimer = setTimeout(() => this.controlChanged(), c.retryAfter + 5);
    if (c.holder !== this.lastHolder) {
      this.lastHolder = c.holder;
      this.emit('control', c);
    }
  }

  /** Whether the person is in the middle of an editing gesture (a drag). */
  get inGesture(): boolean {
    return this.gesture;
  }

  /** The person starts (true) or ends (false) an editing gesture. */
  personGesture(active: boolean): void {
    this.gesture = active;
    if (!active) this.holdUntil = Date.now() + PERSON_HOLD_MS;
    this.controlChanged();
  }

  /** Pauses agents (nobody but the person edits) or lets them work again. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.controlChanged();
  }

  /** Throws E_CONTROL_HELD when an agent may not commit now. */
  checkAgentEdit(): void {
    const c = this.control;
    if (c.holder === 'free') return;
    throw new MochiError(
      'E_CONTROL_HELD',
      c.holder === 'paused'
        ? 'The person has paused agents in the editor. Reads, renders and dry runs still work; edit again when they resume.'
        : `The person is editing in the editor. Retry in ${Math.ceil(c.retryAfter)} ms; reads, renders and dry runs still work.`,
      { details: { holder: c.holder, retryAfter: Math.ceil(c.retryAfter) } },
    );
  }

  // ---------------------------------------------------------------- selection and pose

  select(uid: Uid | null, vertices: number[] = []): void {
    this.selection = {
      uid,
      uids: uid ? [uid] : [],
      vertices: [...new Set(vertices)].sort((a, b) => a - b),
    };
    this.emit('selection', this.selection);
  }

  /** Selects several objects; the last one is the primary selection. */
  selectMany(uids: Uid[]): void {
    const list = [...new Set(uids)].filter((u) => this.view.get(u));
    this.selection = { uid: list.at(-1) ?? null, uids: list, vertices: [] };
    this.emit('selection', this.selection);
  }

  /** Adds an object to the selection, or takes it out (Shift+click, Ctrl+click in palettes). */
  toggleSelected(uid: Uid): void {
    const has = this.selection.uids.includes(uid);
    this.selectMany(
      has ? this.selection.uids.filter((u) => u !== uid) : [...this.selection.uids, uid],
    );
  }

  isSelected(uid: Uid): boolean {
    return this.selection.uids.includes(uid);
  }

  // ---------------------------------------------------------------- modes

  setLevel(level: EditLevel): void {
    this.level = level;
    this.emit('mode', undefined);
  }

  setLockDefault(on: boolean): void {
    this.lockDefault = on;
    this.emit('mode', undefined);
  }

  /** Enters mesh editing on the selected ArtMeshes (up to two, as for gluing). */
  enterMeshEdit(): boolean {
    const meshes = this.selection.uids.filter((u) => this.view.get(u)?.kind === 'artMesh');
    if (meshes.length === 0) {
      this.emit('message', { level: 'error', text: 'Select an ArtMesh to edit its mesh.' });
      return false;
    }
    const uids = meshes.slice(-2);
    this.meshEdit = { uids, revision: this.session.revision };
    if (!uids.includes(this.selection.uid ?? '')) this.select(uids.at(-1)!);
    this.emit('mode', undefined);
    return true;
  }

  /** Leaves mesh editing, keeping the changes. */
  confirmMeshEdit(): void {
    this.meshEdit = null;
    this.emit('mode', undefined);
  }

  /**
   * Leaves mesh editing and undoes the person's changes made in it. It stops at a change by
   * someone else (an agent), which it leaves in place, and says so.
   */
  cancelMeshEdit(): void {
    const m = this.meshEdit;
    this.meshEdit = null;
    if (m) {
      const history = this.session.history();
      let undone = 0;
      while (this.session.revision > m.revision && this.session.canUndo) {
        const last = history[history.length - 1 - undone];
        if (!last || last.author !== 'person') {
          this.emit('message', {
            level: 'warning',
            text: 'Mesh editing was cancelled up to a change by an agent, which stays.',
          });
          break;
        }
        this.session.undo();
        undone++;
      }
    }
    this.emit('mode', undefined);
  }

  // ---------------------------------------------------------------- hidden and locked objects

  /** An object and the parts above it (a part's state applies to everything in it). */
  private chain(uid: Uid): Uid[] {
    const out: Uid[] = [];
    let o = this.view.get(uid);
    const seen = new Set<Uid>();
    while (o && !seen.has(o.uid)) {
      seen.add(o.uid);
      out.push(o.uid);
      const p =
        o.kind === 'part'
          ? o.parent
          : 'part' in o && typeof o.part === 'string'
            ? (o.part as Uid)
            : null;
      o = p ? this.view.get(p) : undefined;
    }
    // Deformers above a mesh or deformer count too: hiding or locking a deformer covers its contents.
    let d = this.view.get(uid);
    while (d && (d.kind === 'artMesh' || d.kind === 'warp' || d.kind === 'rotation')) {
      const p = d.kind === 'artMesh' ? d.deformer : d.parent;
      if (!p || seen.has(p)) break;
      seen.add(p);
      out.push(p);
      d = this.view.get(p);
    }
    return out;
  }

  isHidden(uid: Uid): boolean {
    if (this.solo && !this.chain(uid).some((u) => this.solo!.includes(u))) return true;
    return this.chain(uid).some((u) => this.hidden.has(u));
  }

  isLocked(uid: Uid): boolean {
    return this.chain(uid).some((u) => this.locked.has(u));
  }

  setHidden(uids: Uid[], hidden: boolean): void {
    for (const u of uids) hidden ? this.hidden.add(u) : this.hidden.delete(u);
    this.emit('viewState', undefined);
  }

  setLocked(uids: Uid[], locked: boolean): void {
    for (const u of uids) locked ? this.locked.add(u) : this.locked.delete(u);
    this.emit('viewState', undefined);
  }

  setSolo(uids: Uid[] | null): void {
    this.solo = uids && uids.length ? uids : null;
    this.emit('viewState', undefined);
  }

  setCanvasLock(kind: 'drawables' | 'deformers', on: boolean): void {
    this.canvasLock[kind] = on;
    this.emit('viewState', undefined);
  }

  selectedMesh(): ArtMesh | undefined {
    const o = this.selection.uid ? this.view.get(this.selection.uid) : undefined;
    return o?.kind === 'artMesh' ? o : undefined;
  }

  value(param: Uid): number {
    const p = this.view.getAs(param, 'parameter');
    return this.pose.get(param) ?? p.default;
  }

  /**
   * While Mochi2D plays a motion: each parameter's base value in the model (`getParameterBase`,
   * before physics and the other effects), which the Parameter palette shows. Null otherwise.
   */
  live: Map<Uid, number> | null = null;

  setLive(values: Map<Uid, number> | null): void {
    this.live = values;
    this.emit('liveValues', undefined);
  }

  /** Sets a parameter's pose value: clamped to its range, and snapped to keys when that is on. */
  setPose(param: Uid, value: number): void {
    const p = this.view.getAs(param, 'parameter');
    let v = Math.min(p.max, Math.max(p.min, value));
    if (this.snapToKeys && p.keys.length > 0) {
      const near = p.keys.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
      const span = Math.max(p.max - p.min, 1e-6);
      if (Math.abs(near - v) <= span * 0.03) v = near;
    }
    this.pose.set(param, v);
    this.emit('pose', undefined);
    this.emit('poseEdit', { param, value: v });
  }

  /** Sets a parameter's pose value as given (clamped, never snapped): motion playback. */
  setPoseRaw(param: Uid, value: number): void {
    const p = this.view.getAs(param, 'parameter');
    this.pose.set(param, Math.min(p.max, Math.max(p.min, value)));
    this.emit('pose', undefined);
  }

  resetPose(): void {
    this.pose.clear();
    this.emit('pose', undefined);
  }

  /** The pose as export IDs → values, for the preview and the agent surface. */
  poseByExportId(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.view.ofKind('parameter')) out[p.exportId] = this.value(p.uid);
    return out;
  }

  /**
   * The keyform cell of an object at the current pose. Editing at a pose between keys is refused,
   * with a hint: move to a key, or add a key here (design 4.4).
   */
  cellAtPose(uid: Uid): CellAtPose {
    const o = this.view.get(uid);
    const bindings: Binding[] = o && 'rig' in o ? (o.rig as { bindings: Binding[] }).bindings : [];
    const cell: Record<Uid, number> = {};
    let index = 0;
    let stride = 1;
    for (const b of bindings) {
      const v = f32(this.value(b.parameter));
      const i = b.keys.findIndex((k) => Math.abs(k - v) <= 1e-6);
      if (i < 0) {
        const p = this.view.getAs(b.parameter, 'parameter');
        return {
          ok: false,
          reason: `${p.exportId} is at ${round(v)}, between its keys ${b.keys.map(round).join(', ')}. Move it to a key, or add a key here.`,
          parameter: b.parameter,
          value: v,
          keys: b.keys,
        };
      }
      cell[b.parameter] = b.keys[i]!;
      index += i * stride;
      stride *= b.keys.length;
    }
    return { ok: true, cell, index };
  }

  /** The document a person sees: the session's, unless a drag shows a provisional one. */
  get doc(): Document {
    return this.session.doc;
  }
}

export const round = (v: number, d = 3) => {
  const s = v.toFixed(d);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
