/**
 * Where the MCP server's tools act: a project held by the server (headless), or the document open
 * in a running editor, reached through the live bridge (`mochi-maker mcp --bridge`, agent API
 * design 3 and 5). The tools are the same either way; in bridge mode the editor runs every
 * command, its history records the agent as author, and renders show the editor's view.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import {
  LIMITS,
  MochiError,
  errorCodes,
  objectSchema,
  tooLarge,
  type CommandCall,
  type Kind,
  type QueryOptions,
} from '@mochi-maker/core';
import { NodeFileSystem } from '@mochi-maker/core/node';
import { decodePng, encodePng } from '@mochi-maker/art';
import {
  Project,
  contactSheet,
  difference,
  writeExport,
  type RenderOptions,
  type RenderResult,
} from '@mochi-maker/api';
import type { ExportOptions, ExportProblem, ExportReport } from '@mochi-maker/export';
import { BridgeCallError, BridgeClient, MAX_MESSAGE, type BridgeEvent } from '@mochi-maker/bridge';

type Json = Record<string, unknown>;

export interface RunOptions {
  dryRun?: boolean;
  expectRevision?: number;
}

export interface SweepArgs extends RenderOptions {
  values?: number[];
  steps?: number;
  as?: 'sheet' | 'frames';
  columns?: number;
}

export interface SweepResult {
  parameter: string;
  values: number[];
  columns?: number;
  sheet?: Uint8Array;
  frames?: RenderResult[];
}

export interface ExportArgs {
  mocVersion?: 'auto' | 3 | 4 | 5 | 6;
  atlasSize?: 1024 | 2048 | 4096 | 8192;
  fileStem?: string;
  force?: boolean;
}

/** `mochi_export_movie`'s settings (see the editor's movie.ts). */
export interface MovieArgs {
  motion: string;
  format?: 'png' | 'webm' | 'mp4';
  width?: number;
  height?: number;
  fps?: number;
  background?: string | null;
  range?: 'scene' | 'workArea';
}

/** What the tools need. Paths given here were already checked against the allowed directories. */
export interface Backend {
  readonly mode: 'project' | 'bridge';
  status(): Promise<Json>;
  describe(what?: string | { search: string }): Promise<unknown>;
  get(ref: string): Promise<unknown>;
  query(q: QueryOptions): Promise<unknown>;
  run(label: string, commands: CommandCall[], options: RunOptions): Promise<Json>;
  undo(steps: number): Promise<Json>;
  redo(steps: number): Promise<Json>;
  history(): Promise<Json>;
  diff(from: number, to?: number): Promise<unknown>;
  render(options: RenderOptions): Promise<RenderResult>;
  sweep(parameter: string, options: SweepArgs): Promise<SweepResult>;
  visualDiff(
    from: number,
    to: number | undefined,
    options: RenderOptions,
  ): Promise<{
    before: RenderResult;
    after: RenderResult;
    diff: Uint8Array;
    metrics: unknown;
    to: number;
  }>;
  evaluate(options: { parameters?: Record<string, number>; vertices?: boolean }): Promise<Json>;
  validate(targetVersion?: 'auto' | 3 | 4 | 5 | 6): Promise<Json>;
  importArt(path: string, options: Json, dryRun: boolean): Promise<Json>;
  reimportArt(path: string, options: Json, dryRun: boolean): Promise<Json>;
  export(out: string, options: ExportArgs): Promise<ExportReport>;
  /** A motion as PNG frames or a video, written into the folder `out` (the editor renders it). */
  exportMovie(out: string, options: MovieArgs): Promise<Json>;
  /** Calls `fn` when the document changes (any author). */
  onChange(fn: () => void): () => void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- a project held by the server

export class ProjectBackend implements Backend {
  readonly mode = 'project';
  constructor(readonly project: Project) {}

  async status(): Promise<Json> {
    const p = this.project;
    const project = p.session.view.project();
    const counts: Record<string, number> = {};
    for (const o of p.session.view.all()) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
    delete counts.project;
    return {
      open: true,
      path: p.dir,
      revision: p.revision,
      dirty: p.dirty,
      canvas: project.canvas,
      exportSettings: project.exportSettings,
      counts,
    };
  }
  async describe(what?: string | { search: string }) {
    if (what === undefined) return this.project.describe();
    if (typeof what === 'string') return this.project.describe(what);
    return this.project.describe(what);
  }
  async get(ref: string) {
    return this.project.get(ref);
  }
  async query(q: QueryOptions) {
    return this.project.query(q);
  }
  async run(label: string, commands: CommandCall[], options: RunOptions) {
    const p = this.project;
    const from = p.revision;
    const r = await p.run(label, commands, options);
    const { previews, ...rest } = r;
    return {
      ...rest,
      previews: previews.map((v) => v.description),
      diff: r.committed ? p.diff(from) : undefined,
    };
  }
  private step(op: 'undo' | 'redo', steps: number) {
    const p = this.project;
    const from = p.revision;
    for (let i = 0; i < steps; i++) op === 'undo' ? p.undo() : p.redo();
    return { revision: p.revision, diff: p.diff(from) };
  }
  async undo(steps: number) {
    return this.step('undo', steps);
  }
  async redo(steps: number) {
    return this.step('redo', steps);
  }
  async history() {
    return { revision: this.project.revision, history: this.project.history() };
  }
  async diff(from: number, to?: number) {
    return this.project.diff(from, to ?? this.project.revision);
  }
  render(options: RenderOptions) {
    return this.project.render(options);
  }
  sweep(parameter: string, options: SweepArgs) {
    return this.project.sweep(parameter, options);
  }
  async visualDiff(from: number, to: number | undefined, options: RenderOptions) {
    const t = to ?? this.project.revision;
    return { ...(await this.project.visualDiff(from, t, options)), to: t };
  }
  async evaluate(options: { parameters?: Record<string, number>; vertices?: boolean }) {
    return (await this.project.evaluate(options)) as unknown as Json;
  }
  async validate(targetVersion?: 'auto' | 3 | 4 | 5 | 6) {
    const p = this.project;
    const v = p.validate();
    if (targetVersion === undefined) return v as unknown as Json;
    try {
      const r = await p.exportResult({ mocVersion: targetVersion });
      return {
        ...v,
        export: {
          ok: true,
          mocVersion: r.report.mocVersion,
          versionReason: r.report.versionReason,
          problems: r.report.problems.filter((x) => x.source !== 'lint'),
        },
      };
    } catch (e) {
      if (!(e instanceof MochiError) || e.code !== 'E_EXPORT') throw e;
      const problems = (e.details?.problems as ExportProblem[] | undefined) ?? [];
      return { ...v, export: { ok: false, problems: problems.filter((x) => x.source !== 'lint') } };
    }
  }
  async importArt(path: string, options: Json, dryRun: boolean) {
    const r = await this.project.importArt(path, options, { dryRun });
    const { previews, ...rest } = r;
    return { ...rest, previews: previews.map((v) => v.description) };
  }
  async reimportArt(path: string, options: Json, dryRun: boolean) {
    const r = await this.project.reimportArt(path, options, { dryRun });
    const { previews, ...rest } = r;
    return { ...rest, previews: previews.map((v) => v.description) };
  }
  async export(out: string, options: ExportArgs) {
    return (await this.project.export(out, options)).report;
  }
  async exportMovie(): Promise<Json> {
    throw new MochiError(
      'E_RENDER_UNAVAILABLE',
      'Images and video are rendered by the editor: run mochi-maker mcp --bridge with the editor open.',
    );
  }
  onChange(fn: () => void) {
    return this.project.session.onChange(() => fn());
  }
  close() {
    return this.project.close();
  }
}

// ---------------------------------------------------------------- the editor, through the bridge

const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** Bridge errors as Mochi Maker errors, so the tools report them in the usual shape. */
function rethrow(e: unknown): never {
  if (e instanceof BridgeCallError) {
    const err = e.error;
    const code =
      typeof err.mochiCode === 'string'
        ? err.mochiCode
        : ((
            {
              unauthorized: 'E_BRIDGE',
              studio_not_connected: 'E_BRIDGE',
              forbidden: 'E_FORBIDDEN',
              rate_limited: 'E_RATE_LIMITED',
              unknown_command: 'E_UNKNOWN_COMMAND',
              invalid_arguments: 'E_SCHEMA',
              timeout: 'E_BRIDGE',
            } as Record<string, string>
          )[err.code] ?? 'E_INTERNAL');
    throw new MochiError(code as never, err.message, {
      path: err.path as string | undefined,
      details: err.details as Json | undefined,
      fixes: err.fixes as never,
    });
  }
  throw e;
}

export class BridgeBackend implements Backend {
  readonly mode = 'bridge';
  private constructor(readonly client: BridgeClient) {}

  /** Connects to the bridge as a client with a token the person created in the editor. */
  static async connect(options: {
    url?: string;
    token: string;
    name: string;
  }): Promise<BridgeBackend> {
    try {
      const client = await BridgeClient.connect(options);
      await client.subscribe(['revision', 'project']);
      return new BridgeBackend(client);
    } catch (e) {
      rethrow(e);
    }
  }

  get scopes() {
    return this.client.welcome.scopes;
  }

  private async call<T = Json>(name: string, args: Json = {}): Promise<T> {
    try {
      return await this.client.command<T>(name, args);
    } catch (e) {
      rethrow(e);
    }
  }

  async status(): Promise<Json> {
    return { mode: 'bridge', ...(await this.call<Json>('status')) };
  }
  describe(what?: string | { search: string }) {
    if (what === undefined) return this.call<unknown>('describe');
    if (typeof what === 'string') return this.call<unknown>('describe', { command: what });
    return this.call<unknown>('describe', { search: what.search });
  }
  get(ref: string) {
    return this.call<unknown>('query', { ref });
  }
  query(q: QueryOptions) {
    return this.call<unknown>('query', q as Json);
  }
  run(label: string, commands: CommandCall[], options: RunOptions) {
    return this.call('run', { label, commands, ...options });
  }
  undo(steps: number) {
    return this.call('undo', { steps });
  }
  redo(steps: number) {
    return this.call('redo', { steps });
  }
  history() {
    return this.call('history');
  }
  diff(from: number, to?: number) {
    return this.call<unknown>('diff', to === undefined ? { from } : { from, to });
  }

  /**
   * Without a pose, size, framing or revision, the render is exactly what the person sees in the
   * editor; otherwise the editor renders off-screen.
   */
  async render(o: RenderOptions): Promise<RenderResult> {
    const posed =
      o.parameters !== undefined ||
      o.width !== undefined ||
      o.height !== undefined ||
      o.around !== undefined ||
      o.view !== undefined ||
      o.revision !== undefined;
    const r = await this.call<Json>('render', {
      source: posed ? 'pose' : 'editor',
      ...(o as Json),
      reference: undefined,
    });
    const png = fromBase64(r.png as string);
    const img = decodePng(png, 'render');
    return {
      png,
      width: img.width,
      height: img.height,
      revision: r.revision as number,
      parameters: (r.parameters as Record<string, number>) ?? {},
      reference: false,
      pixelsPerUnit: r.pixelsPerUnit as number,
      center: (r.center as [number, number] | undefined) ?? [0, 0],
      notes: [
        ...((r.notes as string[] | undefined) ?? []),
        ...(o.reference
          ? [
              'reference renders are not available through the bridge; this is the editor’s renderer',
            ]
          : []),
      ],
    };
  }

  /** The view that frames `around` at a pose: one probe render, whose view the others reuse. */
  private async framing(o: RenderOptions & { width: number; height: number }) {
    if (o.view || !o.around) return o.view;
    const probe = await this.render({ ...o, revision: o.revision });
    return { x: probe.center[0], y: probe.center[1], pixelsPerUnit: probe.pixelsPerUnit };
  }

  async sweep(parameter: string, o: SweepArgs): Promise<SweepResult> {
    const p = (await this.get(
      parameter.startsWith('@') || parameter.startsWith('param_')
        ? parameter
        : `@param:${parameter}`,
    )) as {
      exportId: string;
      min: number;
      max: number;
    };
    const steps = Math.max(2, o.steps ?? 5);
    const values =
      o.values ??
      Array.from({ length: steps }, (_, i) => p.min + ((p.max - p.min) * i) / (steps - 1));
    const size = { width: o.width ?? 256, height: o.height ?? 256 };
    const base = o.parameters ?? {};
    const view = await this.framing({ ...o, ...size, parameters: base });
    const frames: RenderResult[] = [];
    for (const v of values)
      frames.push(await this.render({ ...size, view, parameters: { ...base, [p.exportId]: v } }));
    if (o.as === 'frames') return { parameter: p.exportId, values, frames };
    const columns = o.columns ?? Math.min(values.length, 4);
    const sheet = contactSheet(
      frames.map((f) => decodePng(f.png, 'render')),
      columns,
    );
    return { parameter: p.exportId, values, sheet: encodePng(sheet), columns };
  }

  async visualDiff(from: number, to: number | undefined, o: RenderOptions) {
    const t = to ?? ((await this.status()).revision as number);
    const width = o.width ?? 512;
    const height = o.height ?? 512;
    const parameters = o.parameters ?? {};
    const view = await this.framing({ ...o, width, height, parameters, revision: t });
    const shared = { width, height, parameters, view };
    const before = await this.render({ ...shared, revision: from });
    const after = await this.render({ ...shared, revision: t });
    const d = difference(decodePng(before.png, 'before'), decodePng(after.png, 'after'));
    return { before, after, diff: encodePng(d.image), metrics: d.metrics, to: t };
  }

  evaluate(options: { parameters?: Record<string, number>; vertices?: boolean }) {
    return this.call('evaluate', options as Json);
  }
  validate(targetVersion?: 'auto' | 3 | 4 | 5 | 6) {
    return this.call('validate', targetVersion === undefined ? {} : { targetVersion });
  }

  /**
   * Reads the art here (inside the allowed directories), as base64 files under its base name.
   * The files are counted and their sizes summed before any is read: the art caps apply (as for
   * art read directly), and the files must fit in one bridge message.
   */
  private async artFiles(path: string): Promise<{ files: Record<string, string>; name: string }> {
    const files: Record<string, string> = {};
    const name = basename(path);
    const found: [string, string][] = [];
    if ((await stat(path)).isDirectory()) {
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir)) {
          const p = join(dir, entry);
          if ((await stat(p)).isDirectory()) await walk(p);
          else {
            found.push([`${name}/${relative(path, p).split('\\').join('/')}`, p]);
            if (found.length > LIMITS.layers + 2)
              throw tooLarge(path, found.length, LIMITS.layers + 2, 'files');
          }
        }
      };
      await walk(path);
    } else found.push([name, path]);
    // Base64 takes 4 bytes for 3, and the message has some JSON around the files.
    const room = Math.floor(((MAX_MESSAGE - 64 * 1024) * 3) / 4);
    let total = 0;
    for (const [, p] of found) {
      const n = (await stat(p)).size;
      if (n > LIMITS.fileBytes) throw tooLarge(p, n, LIMITS.fileBytes);
      total += n;
    }
    if (total > room) {
      const e = tooLarge(`${path}, sent through the bridge,`, total, room);
      e.message += ' Import it in the editor, or use the MCP server without the bridge.';
      throw e;
    }
    for (const [key, p] of found) files[key] = (await readFile(p)).toString('base64');
    return { files, name };
  }

  /** Sends the art's bytes to the editor, which imports them. */
  async importArt(path: string, options: Json, dryRun: boolean) {
    const { files, name } = await this.artFiles(path);
    return this.call('import_art', { files, path: name, options, dryRun });
  }

  /** Sends the changed art's bytes to the editor, which re-imports them. */
  async reimportArt(path: string, options: Json, dryRun: boolean) {
    const { files, name } = await this.artFiles(path);
    return this.call('reimport_art', { files, path: name, options, dryRun });
  }

  /** The editor exports; the files are written here, inside the allowed directories. */
  async export(out: string, options: ExportArgs) {
    const { force, ...rest } = options;
    const r = await this.call<{ report: ExportReport; files: Record<string, string> }>(
      'export',
      rest as Json,
    );
    const files = new Map(Object.entries(r.files).map(([p, b]) => [p, fromBase64(b)] as const));
    await writeExport(new NodeFileSystem(), out, { files, report: r.report }, { force });
    return r.report;
  }

  /** The editor renders the frames or the video; the files are written here, into `out`. */
  async exportMovie(out: string, options: MovieArgs) {
    const { files, ...r } = await this.call<
      { files: Record<string, string> } & Record<string, Json>
    >('export_movie', options as unknown as Json);
    const fs = new NodeFileSystem();
    const names = Object.keys(files);
    for (const name of names) await fs.writeBytes(join(out, name), fromBase64(files[name]!));
    return { ...r, out, files: names } as Json;
  }

  onChange(fn: () => void) {
    return this.client.onEvent((e: BridgeEvent) => {
      if (e.name === 'revision' || e.name === 'project') fn();
    });
  }

  async close() {
    this.client.close();
  }
}

export { errorCodes, objectSchema, type Kind, type ExportOptions };
