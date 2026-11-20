/**
 * The editor-side agent surface, `window.mochi` (agent API design 2.1): the agent API's
 * transactions, typed method layer, self-description, queries, history and diffs, bound to the
 * session the editor shows. A person watches the commands land: they go into the same history,
 * labeled with their author, and the preview rebuilds as for the person's own edits.
 *
 * The live bridge (M11) will connect outside agents to this same surface.
 */
import {
  MochiError,
  describeCommand,
  errorCodes,
  listCommands,
  objectSchema,
  runItems,
  searchCommands,
  type CommandCall,
  type CommandDescription,
  type CommandSummary,
  type Kind,
  type QueryOptions,
  type TransactionOptions,
  type Uid,
} from '@mochi-maker/core';
import { OPERATIONS, exportModel } from '@mochi-maker/export';
import { movieSettings, type MovieResult, type MovieSettings } from './movie.js';
import { diffDocuments, errorJson, txApi, type TxApi } from '@mochi-maker/api/browser';
import type { Editor } from './editor.js';
import type { Viewport } from './viewport.js';

export interface AgentOptions extends TransactionOptions {
  /** Defaults to 'agent:window.mochi'. */
  author?: string;
  /** Not listed in the agents panel's window.mochi calls (the bridge host lists its own). */
  quiet?: boolean;
}

export class AgentSurface {
  /** The author of calls without one. */
  defaultAuthor = 'agent:window.mochi';
  /** Calls made through this surface, newest last (the activity panel's agent indicator). */
  readonly calls: { time: number; method: string; author: string; ok: boolean }[] = [];

  constructor(
    private readonly editor: Editor,
    private readonly viewport: Viewport,
  ) {}

  private note<T>(method: string, author: string, fn: () => T): T {
    let ok = false;
    try {
      const r = fn();
      ok = true;
      return r;
    } finally {
      this.calls.push({ time: Date.now(), method, author, ok });
      if (this.calls.length > 500) this.calls.shift();
      this.editor.emit('message', {
        level: ok ? 'info' : 'error',
        text: `${author}: ${method}${ok ? '' : ' failed'}`,
      });
    }
  }

  /** Agents' edits wait for the person (the control lease); the person's own never do. */
  private guard(author: string): void {
    if (author !== 'person') this.editor.checkAgentEdit();
  }

  get revision(): number {
    return this.editor.session.revision;
  }

  /** One atomic transaction: `tx.<area>.<verb>(args)` or `tx.run(name, args)`. */
  transact<T>(label: string, body: (tx: TxApi) => T, options: AgentOptions = {}) {
    const author = options.author ?? this.defaultAuthor;
    return this.note(`transact "${label}"`, author, () => {
      if (!options.dryRun) this.guard(author);
      let value: T | undefined;
      const r = this.editor.session.transact(
        label,
        (tx) => {
          value = body(txApi(tx));
        },
        { ...options, author },
      );
      return { ...r, value: value as T };
    });
  }

  /** Commands and operations given as data (`$n` refers to item n's result), as one transaction. */
  async run(label: string, items: CommandCall[], options: AgentOptions = {}) {
    const author = options.author ?? this.defaultAuthor;
    const started = Date.now();
    try {
      if (!options.dryRun) this.guard(author);
      const { quiet, ...rest } = options;
      const r = await runItems(
        { session: this.editor.session, assets: this.editor.assets, fs: this.editor.fs },
        label,
        items,
        { ...rest, author, operations: OPERATIONS },
      );
      if (!quiet) this.calls.push({ time: started, method: `run "${label}"`, author, ok: true });
      return r;
    } catch (e) {
      if (!options.quiet)
        this.calls.push({ time: started, method: `run "${label}"`, author, ok: false });
      throw e;
    }
  }

  undo(steps = 1) {
    return this.note(`undo ${steps}`, this.defaultAuthor, () => {
      this.guard(this.defaultAuthor);
      for (let i = 0; i < steps; i++) this.editor.session.undo();
      return { revision: this.revision };
    });
  }

  redo(steps = 1) {
    return this.note(`redo ${steps}`, this.defaultAuthor, () => {
      this.guard(this.defaultAuthor);
      for (let i = 0; i < steps; i++) this.editor.session.redo();
      return { revision: this.revision };
    });
  }

  describe(): CommandSummary[];
  describe(name: string): CommandDescription;
  describe(query: { search: string }): CommandSummary[];
  describe(what?: string | { search: string }): CommandSummary[] | CommandDescription {
    const f = this.editor.session.features;
    if (what === undefined) return listCommands(OPERATIONS, f);
    if (typeof what === 'string') return describeCommand(what, OPERATIONS, f);
    return searchCommands(what.search, OPERATIONS, f);
  }

  schema(kind: Kind) {
    return objectSchema(kind);
  }

  errorCodes() {
    return errorCodes();
  }

  query(q: QueryOptions = {}) {
    return this.editor.session.query(q);
  }

  get(ref: string) {
    return this.editor.session.get(ref);
  }

  validate() {
    return this.editor.session.validate();
  }

  history() {
    return this.editor.session.history();
  }

  /** A structural diff between the document now and one this editor has shown since it opened. */
  diff(from: number, to: number = this.revision) {
    const a = this.editor.snapshots.get(from);
    const b = this.editor.snapshots.get(to);
    if (!a || !b)
      throw new MochiError(
        'E_RANGE',
        `Revision ${!a ? from : to} is not available in this editor session.`,
      );
    return diffDocuments(a, b);
  }

  /** Set by main: renders a motion as images or video (`exportMovie`). */
  movie: ((s: MovieSettings) => Promise<MovieResult>) | null = null;

  /**
   * A motion as PNG frames or a WebM or MP4 video (see `movie.ts`): the files by name, and what
   * was made. Only `motion` is needed; the rest defaults (PNG, the canvas size, the motion's fps,
   * transparent, the whole scene).
   */
  async exportMovie(settings: Partial<MovieSettings> & { motion: string }) {
    if (!this.movie) throw new MochiError('E_RENDER_UNAVAILABLE', 'No renderer is attached.');
    return this.movie(movieSettings(this.editor, settings));
  }

  /** The full export, with its report and problems (nothing is written). */
  async export() {
    const r = await exportModel(this.editor.doc, this.editor.assets, {
      features: this.editor.features,
    });
    return { report: r.report, files: [...r.files.keys()] };
  }

  // ---------------------------------------------------------------- the editor's view

  /** The pose by export ID. */
  pose(): Record<string, number> {
    return this.editor.poseByExportId();
  }

  /** Sets parameter values (export IDs or references) in the editor's pose. */
  setPose(values: Record<string, number>): Record<string, number> {
    for (const [ref, v] of Object.entries(values)) {
      const uid = this.editor.view.resolve(
        ref.startsWith('@') || ref.startsWith('param_') ? ref : `@param:${ref}`,
        ['parameter'],
      );
      this.editor.setPose(uid, v);
    }
    return this.pose();
  }

  select(ref: string | null, vertices: number[] = []): { uid: Uid | null; vertices: number[] } {
    const uid =
      ref === null
        ? null
        : this.editor.view.resolve(ref, [
            'artMesh',
            'part',
            'warp',
            'rotation',
            'parameter',
            'glue',
          ]);
    this.editor.select(uid, vertices);
    return this.editor.selection;
  }

  selection() {
    return this.editor.selection;
  }

  /** Waits until the preview shows the current revision. */
  async settled(): Promise<{ revision: number }> {
    await this.viewport.idle();
    return { revision: this.revision };
  }

  /** The viewport as a PNG data URL (Mochi2D's view, without overlays). */
  async screenshot(): Promise<string> {
    await this.viewport.idle();
    const blob = await this.viewport.view.screenshot();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  }

  /** Mochi2D's evaluated drawables in the editor's view, in canvas pixels. */
  evaluate() {
    return this.viewport.evaluation();
  }

  /** Preview build timings (milliseconds), newest last. */
  stats() {
    return { builds: this.viewport.builds.slice(), dragFrames: this.viewport.dragFrames.slice() };
  }

  /** Error output in the agent API's shape, for callers that catch. */
  errorJson(e: unknown) {
    return errorJson(e);
  }
}
