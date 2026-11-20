/**
 * A project for agents and scripts (agent API design 2): a headless session with its assets and
 * folder, plus transactions with the typed method layer, self-description, queries, validation,
 * history, structural diffs, numeric evaluation through Mochi2D, import, export and saving.
 *
 * Rendering, sweeps, visual diffs and `explain` need Mochi2D's headless rendering and evaluation
 * introspection, and come with its next release.
 */
import {
  MemoryAssetStore,
  MochiError,
  Session,
  describeCommand,
  errorCodes,
  listCommands,
  loadProject,
  objectSchema,
  runItems,
  saveProject,
  searchCommands,
  MANIFEST,
  type AssetStore,
  type CanvasInit,
  type Features,
  type CommandCall,
  type CommandDescription,
  type CommandScope,
  type CommandSummary,
  type Document,
  type FileSystem,
  type Kind,
  type QueryOptions,
  type QueryResult,
  type RunItemsResult,
  type SaveReport,
  type TransactionOptions,
  type TransactionResult,
} from '@mochi-maker/core';
import { NodeFileSystem } from '@mochi-maker/core/node';
import {
  OPERATIONS,
  exportModel,
  type ExportOptions,
  type ExportResult,
} from '@mochi-maker/export';
import { MemoryFileSource, scenarioResult } from 'mochi2d/headless';
import { NodeRenderer } from 'mochi2d/node';
import { decodePng, encodePng } from '@mochi-maker/art';
import { contactSheet, difference, type DiffMetrics } from './images.js';
import { exportModel as exportDocument } from '@mochi-maker/export';
import { diffDocuments, type DocumentDiff } from './diff.js';
import { appendHistory, historyPath } from './history.js';
import { txApi, type TxApi } from './methods.js';
import { writeExport } from './write.js';

export interface ProjectOptions {
  /** Default author of transactions: 'person', 'agent:<name>' or 'script:<path>'. */
  author?: string;
  fs?: FileSystem;
  /**
   * Glue and blend-shape authoring, and exporting projects that hold them (default:
   * MOCHI_MAKER_FEATURES, else off).
   */
  features?: Features;
}

/** A command as Mochi Studio's bridge protocol describes it. */
export interface CommandInfo {
  name: string;
  summary: string;
  details?: string;
  scope: CommandScope;
  undoable: boolean;
  readOnly: boolean;
  inputSchema: unknown;
}

export interface RenderOptions {
  /** Parameter values by export ID; others stay at their defaults. */
  parameters?: Record<string, number>;
  /** Image size in pixels (default 512 × 512). */
  width?: number;
  height?: number;
  /** Frame one object (a reference): its bounds at this pose, plus `margin` canvas pixels. */
  around?: string;
  margin?: number;
  /** An explicit view: the model-space point at the image center, and image pixels per unit. */
  view?: { x: number; y: number; pixelsPerUnit: number };
  /** Straight-alpha RGBA background, 0–1 (default transparent). */
  background?: [number, number, number, number];
  /** A reference render (slow, for checks). Default: a fast preview with downscaled textures. */
  reference?: boolean;
  /** Render a revision this project has been at (default: now). */
  revision?: number;
}

export interface RenderResult {
  png: Uint8Array;
  width: number;
  height: number;
  revision: number;
  parameters: Record<string, number>;
  reference: boolean;
  /** Image pixels per model unit and the model-space point at the image center. */
  pixelsPerUnit: number;
  center: [number, number];
  notes: string[];
}

export interface SweepOptions extends Omit<RenderOptions, 'revision'> {
  /** The values to show; default `steps` values evenly over the parameter's range. */
  values?: number[];
  steps?: number;
  /** 'sheet' (default): one contact sheet; 'frames': one image per value. */
  as?: 'sheet' | 'frames';
  columns?: number;
}

export interface VisualDiff {
  before: RenderResult;
  after: RenderResult;
  /** Unchanged pixels gray, changed pixels red. */
  diff: Uint8Array;
  metrics: DiffMetrics;
}

export interface EvaluateOptions {
  /** Parameter values by export ID; others stay at their defaults. */
  parameters?: Record<string, number>;
  /** Include every drawable's vertices (canvas pixels). */
  vertices?: boolean;
}

export interface DrawableState {
  id: string;
  uid: string | undefined;
  visible: boolean;
  opacity: number;
  drawOrder: number;
  renderOrder: number;
  multiplyColor: number[];
  screenColor: number[];
  /** Canvas pixels, y down. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  vertices?: number[];
}

export interface Evaluation {
  revision: number;
  mocVersion: number;
  parameters: Record<string, number>;
  drawables: DrawableState[];
}

export class Project {
  private readonly snapshots = new Map<number, Document>();
  private savedLog: number;
  private savedRevision: number;
  private exported: { revision: number; result: ExportResult } | undefined;

  private constructor(
    readonly session: Session,
    readonly assets: AssetStore,
    /** The project folder, or null for a project held only in memory. */
    readonly dir: string | null,
    private readonly fs: FileSystem,
    private readonly author: string,
    savedLog: number,
  ) {
    this.savedLog = savedLog;
    this.savedRevision = session.revision;
    this.snapshots.set(session.revision, session.doc);
    session.onChange(({ revision }) => this.snapshots.set(revision, session.doc));
  }

  /** A new project in memory only (it cannot be saved). */
  static memory(canvas?: CanvasInit, options: ProjectOptions = {}): Project {
    return new Project(
      Session.create(canvas, { features: options.features }),
      new MemoryAssetStore(),
      null,
      options.fs ?? new NodeFileSystem(),
      options.author ?? 'person',
      0,
    );
  }

  /** Wraps an existing session and its assets (no folder). */
  static fromSession(session: Session, assets: AssetStore, options: ProjectOptions = {}): Project {
    return new Project(
      session,
      assets,
      null,
      options.fs ?? new NodeFileSystem(),
      options.author ?? 'person',
      session.log.length,
    );
  }

  /** Creates a project folder (which must not hold a project) and returns it open. */
  static async create(dir: string, canvas?: CanvasInit, options: ProjectOptions = {}) {
    const fs = options.fs ?? new NodeFileSystem();
    if (await fs.exists(`${dir}/${MANIFEST}`))
      throw new MochiError('E_PROJECT_FORMAT', `${dir} already contains a project.`);
    const p = new Project(
      Session.create(canvas, { features: options.features }),
      new MemoryAssetStore(),
      dir,
      fs,
      options.author ?? 'person',
      0,
    );
    await p.save();
    return p;
  }

  static async open(dir: string, options: ProjectOptions = {}): Promise<Project> {
    const fs = options.fs ?? new NodeFileSystem();
    const { doc, assets } = await loadProject(fs, dir);
    return new Project(
      Session.open(doc, { features: options.features }),
      assets,
      dir,
      fs,
      options.author ?? 'person',
      0,
    );
  }

  get revision(): number {
    return this.session.revision;
  }

  /** True when there are changes since the last save (or since opening). */
  get dirty(): boolean {
    return this.session.revision !== this.savedRevision;
  }

  /**
   * Runs a transaction through the typed method layer. Atomic: if any command fails, nothing is
   * committed and the error names the command and its index. Returns the body's value as `value`.
   */
  transact<T>(
    label: string,
    build: (tx: TxApi) => T,
    options: TransactionOptions = {},
  ): TransactionResult & { value: T } {
    let value!: T;
    const r = this.session.transact(
      label,
      (tx) => {
        value = build(txApi(tx));
      },
      { author: this.author, ...options },
    );
    return { ...r, value };
  }

  /** Runs commands and operations given as data (`{ name, args }`), as one transaction. */
  run(
    label: string,
    items: CommandCall[],
    options: TransactionOptions = {},
  ): Promise<RunItemsResult> {
    return runItems({ session: this.session, assets: this.assets, fs: this.fs }, label, items, {
      author: this.author,
      ...options,
      operations: OPERATIONS,
    });
  }

  /** The catalog; one command's full description; or a search. */
  describe(): CommandSummary[];
  describe(name: string): CommandDescription;
  describe(query: { search: string }): CommandSummary[];
  describe(what?: string | { search: string }): CommandSummary[] | CommandDescription {
    const f = this.session.features;
    if (what === undefined) return listCommands(OPERATIONS, f);
    if (typeof what === 'string') return describeCommand(what, OPERATIONS, f);
    return searchCommands(what.search, OPERATIONS, f);
  }

  /**
   * The catalog in Mochi Studio's bridge shape (`CommandInfo`): every command
   * and operation with its scope, undo behavior and argument schema. M11's bridge sends it as is.
   */
  commandInfo(): CommandInfo[] {
    return this.describe().map((c) => {
      const d = this.describe(c.name);
      return {
        name: d.name,
        summary: d.summary,
        details: d.doc,
        scope: d.scope,
        undoable: d.undoable,
        readOnly: d.readOnly,
        inputSchema: d.args,
      };
    });
  }

  /** The JSON Schema of a document object kind. */
  schema(kind: Kind): unknown {
    return objectSchema(kind);
  }

  errorCodes(): { code: string; meaning: string }[] {
    return errorCodes();
  }

  query(q: QueryOptions = {}): QueryResult {
    return this.session.query(q);
  }

  get(ref: string): Record<string, unknown> {
    return this.session.get(ref);
  }

  validate(): ReturnType<Session['validate']> {
    return this.session.validate();
  }

  history(): { label: string; author: string }[] {
    return this.session.history();
  }

  undo(): TransactionResult {
    return this.session.undo();
  }

  redo(): TransactionResult {
    return this.session.redo();
  }

  /** Structural diff between two revisions this project has been at (`to` defaults to now). */
  diff(from: number, to: number = this.revision): DocumentDiff {
    const a = this.snapshots.get(from);
    const b = this.snapshots.get(to);
    if (!a || !b)
      throw new MochiError(
        'E_RANGE',
        `Revision ${!a ? from : to} is not available; this project has been at revisions ${[...this.snapshots.keys()].join(', ')}.`,
        { path: !a ? 'from' : 'to' },
      );
    return diffDocuments(a, b);
  }

  /** Exports in memory (cached per revision). Throws E_EXPORT with the problems when it cannot. */
  async exportResult(options: ExportOptions = {}): Promise<ExportResult> {
    const plain = Object.keys(options).length === 0;
    if (plain && this.exported?.revision === this.revision) return this.exported.result;
    const result = await exportModel(this.session.doc, this.assets, {
      features: this.session.features,
      ...options,
    });
    if (plain) this.exported = { revision: this.revision, result };
    return result;
  }

  /** Exports and writes the model folder or zip. */
  async export(
    out: string,
    options: ExportOptions & { force?: boolean } = {},
  ): Promise<ExportResult> {
    const { force, ...rest } = options;
    const r = await this.exportResult(rest);
    await writeExport(this.fs, out, r, { force });
    return r;
  }

  /**
   * Numbers at a pose, evaluated by Mochi2D from the exported model: per drawable visibility,
   * opacity, draw and render order, colors and bounds, in canvas pixels.
   */
  async evaluate(options: EvaluateOptions = {}, exported?: ExportResult): Promise<Evaluation> {
    const r = exported ?? (await this.exportResult());
    const stem = this.session.view.project().exportSettings.fileStem;
    const parameters = options.parameters ?? {};
    const res = scenarioResult(
      { moc: r.files.get(`${stem}.moc3`)!, settings: r.files.get(`${stem}.model3.json`)! },
      { format: 'mochi2d-scenario/0', id: 'evaluate', parameters },
    ) as {
      error: { kind: string; message: string } | null;
      drawables: (Omit<DrawableState, 'uid' | 'bounds'> & { vertices: number[] })[];
    };
    if (res.error)
      throw new MochiError(
        'E_INTERNAL',
        `Mochi2D could not evaluate the model: ${res.error.message}`,
      );
    const { pixelsPerUnit: ppu, originX, originY } = this.session.view.project().canvas;
    const uidOf = new Map(Object.entries(r.report.ids.artMeshes).map(([uid, id]) => [id, uid]));
    return {
      revision: this.revision,
      mocVersion: r.report.mocVersion,
      parameters,
      drawables: res.drawables.map((d) => {
        const px: number[] = [];
        for (let i = 0; i < d.vertices.length; i += 2)
          px.push(d.vertices[i]! * ppu + originX, -d.vertices[i + 1]! * ppu + originY);
        const xs = px.filter((_, i) => i % 2 === 0);
        const ys = px.filter((_, i) => i % 2 === 1);
        const out: DrawableState = {
          id: d.id,
          uid: uidOf.get(d.id),
          visible: d.visible,
          opacity: d.opacity,
          drawOrder: d.drawOrder,
          renderOrder: d.renderOrder,
          multiplyColor: d.multiplyColor,
          screenColor: d.screenColor,
          bounds: {
            minX: Math.min(...xs),
            minY: Math.min(...ys),
            maxX: Math.max(...xs),
            maxY: Math.max(...ys),
          },
        };
        if (options.vertices) out.vertices = px;
        return out;
      }),
    };
  }

  // ---------------------------------------------------------------- rendering
  private renderer: Promise<NodeRenderer> | undefined;
  private readonly sources = new Map<number, { result: ExportResult; source: MemoryFileSource }>();

  private async openRenderer(): Promise<NodeRenderer> {
    this.renderer ??= NodeRenderer.open().catch((e: unknown) => {
      this.renderer = undefined;
      throw new MochiError(
        'E_RENDER_UNAVAILABLE',
        `Rendering needs headless Chromium through Playwright: ${(e as Error).message} Install it with "npm install -g playwright" and "npx playwright install chromium".`,
      );
    });
    return this.renderer;
  }

  /** The export of a revision, and a file source over it (a few kept for the renderer's cache). */
  private async exportAt(
    revision: number,
  ): Promise<{ result: ExportResult; source: MemoryFileSource }> {
    const cached = this.sources.get(revision);
    if (cached) return cached;
    const doc = this.snapshots.get(revision);
    if (!doc)
      throw new MochiError(
        'E_RANGE',
        `Revision ${revision} is not available; this project has been at revisions ${[...this.snapshots.keys()].join(', ')}.`,
        { path: 'revision' },
      );
    const result =
      revision === this.revision
        ? await this.exportResult()
        : await exportDocument(doc, this.assets);
    const entry = { result, source: MemoryFileSource.fromFiles(result.files) };
    this.sources.set(revision, entry);
    if (this.sources.size > 4) {
      const [oldest, old] = this.sources.entries().next().value!;
      this.sources.delete(oldest);
      if (this.renderer) (await this.renderer).forget(old.source);
    }
    return entry;
  }

  /** The view that frames an object at a pose: its bounds plus a margin, in canvas pixels. */
  private async frame(
    around: string,
    margin: number,
    width: number,
    height: number,
    parameters: Record<string, number>,
    exported: ExportResult,
  ): Promise<{ x: number; y: number; pixelsPerUnit: number }> {
    const target = this.session.view.resolve(around, ['artMesh'], 'around');
    const e = await this.evaluate({ parameters }, exported);
    const d = e.drawables.find((x) => x.uid === target);
    if (!d)
      throw new MochiError(
        'E_WRONG_KIND',
        `${this.session.view.describe(target)} is not a drawn mesh.`,
        {
          path: 'around',
        },
      );
    const { pixelsPerUnit: ppu, originX, originY } = this.session.view.project().canvas;
    const b = d.bounds;
    const w = b.maxX - b.minX + 2 * margin;
    const h = b.maxY - b.minY + 2 * margin;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    return {
      x: (cx - originX) / ppu,
      y: -(cy - originY) / ppu,
      pixelsPerUnit: Math.min(width / Math.max(w, 1), height / Math.max(h, 1)) * ppu,
    };
  }

  /**
   * Renders the model at a pose to PNG with Mochi2D's renderer (headless Chromium). Fast previews by
   * default; `reference: true` for Mochi2D's reference render.
   */
  async render(options: RenderOptions = {}): Promise<RenderResult> {
    const revision = options.revision ?? this.revision;
    const width = options.width ?? 512;
    const height = options.height ?? 512;
    const parameters = options.parameters ?? {};
    const { result, source } = await this.exportAt(revision);
    const view =
      options.view ??
      (options.around
        ? await this.frame(options.around, options.margin ?? 20, width, height, parameters, result)
        : undefined);
    const renderer = await this.openRenderer();
    const stem = this.session.view.project().exportSettings.fileStem;
    const img = await renderer.render(
      { source, settings: `${stem}.model3.json` },
      {
        width,
        height,
        parameters,
        background: options.background,
        view,
        fast: options.reference ? false : true,
      },
    );
    return {
      png: img.png,
      width: img.width,
      height: img.height,
      revision,
      parameters,
      reference: img.reference,
      pixelsPerUnit: img.pixelsPerUnit,
      center: img.center,
      notes: img.notes,
    };
  }

  /** A parameter swept over values: one contact sheet, or one image per value. */
  async sweep(
    parameter: string,
    options: SweepOptions = {},
  ): Promise<{
    parameter: string;
    values: number[];
    sheet?: Uint8Array;
    columns?: number;
    frames?: RenderResult[];
  }> {
    const p = this.session.view.getAs(
      this.session.view.resolve(parameter, ['parameter'], 'parameter'),
      'parameter',
    );
    const steps = Math.max(2, options.steps ?? 5);
    const values =
      options.values ??
      Array.from({ length: steps }, (_, i) => p.min + ((p.max - p.min) * i) / (steps - 1));
    const size = { width: options.width ?? 256, height: options.height ?? 256 };
    const base = options.parameters ?? {};
    // One view for every value, framed at the parameter's default when `around` is given.
    const view =
      options.view ??
      (options.around
        ? await this.frame(
            options.around,
            options.margin ?? 20,
            size.width,
            size.height,
            base,
            await this.exportResult(),
          )
        : undefined);
    const frames: RenderResult[] = [];
    for (const v of values)
      frames.push(
        await this.render({
          ...options,
          ...size,
          view,
          around: undefined,
          parameters: { ...base, [p.exportId]: v },
        }),
      );
    if (options.as === 'frames') return { parameter: p.exportId, values, frames };
    const columns = options.columns ?? Math.min(values.length, 4);
    const sheet = contactSheet(
      frames.map((f) => decodePng(f.png, 'render')),
      columns,
    );
    return { parameter: p.exportId, values, sheet: encodePng(sheet), columns };
  }

  /** Before and after renders of two revisions at the same pose and view, and their difference. */
  async visualDiff(
    from: number,
    to: number = this.revision,
    options: Omit<RenderOptions, 'revision'> = {},
  ): Promise<VisualDiff> {
    const width = options.width ?? 512;
    const height = options.height ?? 512;
    const view =
      options.view ??
      (options.around
        ? await this.frame(
            options.around,
            options.margin ?? 20,
            width,
            height,
            options.parameters ?? {},
            (await this.exportAt(to)).result,
          )
        : undefined);
    const shared = { ...options, width, height, view, around: undefined };
    const before = await this.render({ ...shared, revision: from });
    const after = await this.render({ ...shared, revision: to });
    const d = difference(decodePng(before.png, 'before'), decodePng(after.png, 'after'));
    return { before, after, diff: encodePng(d.image), metrics: d.metrics };
  }

  /** Closes the renderer, if one was opened. */
  async close(): Promise<void> {
    const r = this.renderer;
    this.renderer = undefined;
    if (r) await (await r).close().catch(() => {});
  }

  /**
   * Re-imports changed art (operation `art.reimport`): matching layers get the new pixels, meshes
   * keep their positions, and the result reports what may need re-fitting. A dry run only reports.
   */
  reimportArt(path: string, args: Record<string, unknown> = {}, options: TransactionOptions = {}) {
    return this.run(
      `Re-import ${path}`,
      [{ name: 'art.reimport', args: { ...args, path } }],
      options,
    );
  }

  /** Imports a PSD, ORA, PNG or folder of PNGs (operation `art.import`). */
  importArt(path: string, args: Record<string, unknown> = {}, options: TransactionOptions = {}) {
    return this.run(`Import ${path}`, [{ name: 'art.import', args: { ...args, path } }], options);
  }

  /**
   * Imports a `.physics3.json` (operation `physics.import`): settings added, or replaced by name;
   * inputs and outputs matched by parameter ID, the unmatched ones reported.
   */
  importPhysics(path: string, options: TransactionOptions = {}) {
    return this.run(`Import ${path}`, [{ name: 'physics.import', args: { path } }], options);
  }

  /** Saves the project folder and appends the new history entries. */
  async save(): Promise<SaveReport> {
    if (this.dir === null)
      throw new MochiError(
        'E_NO_PROJECT',
        'This project is in memory only; create it in a folder with Project.create(dir) to save it.',
      );
    const report = await saveProject(this.fs, this.dir, this.session.doc, this.assets);
    // A new project's history starts with its init entry; later saves append what is new (the
    // first save after opening appends the segment with its base entry).
    const log = this.session.log;
    const path = historyPath(this.dir);
    if (log[0]?.op === 'init' && this.savedLog === 0)
      await this.fs.writeText(path, log.map((e) => JSON.stringify(e)).join('\n') + '\n');
    else await appendHistory(this.fs, path, log.slice(this.savedLog));
    this.savedLog = log.length;
    this.savedRevision = this.revision;
    return report;
  }
}
