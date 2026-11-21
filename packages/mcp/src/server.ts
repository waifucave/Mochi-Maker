/**
 * Mochi Maker's MCP server (agent API design 3): few, general tools plus discovery, over JSON-RPC
 * 2.0. Headless, it holds one project at a time; with `--bridge`, it works on the document open in
 * a running editor instead, through the live bridge (design 5).
 *
 * Not in this version: mochi_explain, which needs Mochi2D's evaluation introspection.
 *
 * Safety (design 6): commands only; file access only inside the allowed directories; at most
 * 10 000 commands per transaction and 30 tool calls per second. Errors carry Mochi Studio's bridge
 * categories next to Mochi Maker's codes.
 */
import {
  MochiError,
  errorCodes,
  objectSchema,
  type CommandScope,
  type Kind,
} from '@mochi-maker/core';
import {
  OBJECT_SCHEMAS,
  STANDARD_ID_NOTE,
  STANDARD_PARAMETERS,
  STANDARD_PARAMETER_GROUPS,
} from '@mochi-maker/core';
import { Project, errorJson, type ErrorJson, type RenderOptions } from '@mochi-maker/api';
import { BridgeBackend, ProjectBackend, type Backend, type MovieArgs } from './backend.js';
import { docText, docTopics } from './docs.js';
import { PathPolicy } from './paths.js';
import { PROMPTS } from './prompts.js';

export const SERVER_NAME = 'mochi-maker';
export const SERVER_VERSION = '0.0.0';
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const MAX_COMMANDS = 10_000;
export const MAX_CALLS_PER_SECOND = 30;
export const MAX_IMAGE = 1024;
export const MAX_FRAMES = 16;

const LEVEL: Record<CommandScope, number> = { read: 0, edit: 1, export: 2 };

export interface ServerOptions {
  /**
   * What the agent may do (design 6, item 3): 'read' looks only, 'edit' also changes the document
   * and saves the project, 'export' also writes model files. Default 'export'.
   */
  scope?: CommandScope;
  /** Directories the agent may read from and write to. */
  allowDirs: string[];
  /** A project to open at start. */
  project?: string;
  /** Author recorded on the agent's transactions (default 'agent:mcp'). */
  author?: string;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
  /**
   * Bridge mode: work on the editor's open document through the bridge (`mochi-maker bridge`),
   * with a token the person created in the editor's Agent access. The token's scopes limit the
   * session further.
   */
  bridge?: { url?: string; token: string; name?: string };
}

type Json = Record<string, unknown>;
interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Json;
}
type Notify = (method: string, params: Json) => void;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  readOnly: boolean;
  /** The scope a call needs; mochi_project's depends on the action. */
  scope: CommandScope | ((args: Json) => CommandScope);
  call: (args: Json) => Promise<unknown>;
}

const obj = (properties: Json, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string, extra: Json = {}): Json => ({
  type: 'string',
  description,
  ...extra,
});
const num = (description: string): Json => ({ type: 'number', description });
const bool = (description: string): Json => ({ type: 'boolean', description });

function need<T>(args: Json, key: string, type: string): T {
  const v = args[key];
  if (v === undefined || (type === 'array' ? !Array.isArray(v) : typeof v !== type))
    throw new MochiError('E_SCHEMA', `Argument "${key}" is required and must be a ${type}.`, {
      path: `args.${key}`,
    });
  return v as T;
}

const RENDER_FIELDS: Json = {
  parameters: {
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Pose: { ExportId: value }',
  },
  width: num('Image width in pixels (at most 1024; default 512)'),
  height: num('Image height in pixels (at most 1024; default 512)'),
  around: str('Frame one mesh: a reference such as @mesh:ArtMesh_Face'),
  margin: num('Margin around `around`, in canvas pixels (default 20)'),
  reference: bool('Mochi2D reference render (slow, for checks); default a fast preview'),
};

/** Render options from tool arguments, with sizes capped at 1024. */
function renderOptions(a: Json): RenderOptions {
  const cap = (v: unknown) =>
    v === undefined ? undefined : Math.max(16, Math.min(MAX_IMAGE, Math.round(v as number)));
  return {
    parameters: a.parameters as Record<string, number> | undefined,
    width: cap(a.width),
    height: cap(a.height),
    around: a.around as string | undefined,
    margin: a.margin as number | undefined,
    reference: a.reference === true,
  };
}

export class MochiMcpServer {
  private backend: Backend | null = null;
  private readonly paths: PathPolicy;
  private readonly author: string;
  private scope: CommandScope;
  private readonly now: () => number;
  private readonly calls: number[] = [];
  private readonly subscriptions = new Set<string>();
  private notify: Notify = () => {};
  private unsubscribeProject: (() => void) | undefined;
  readonly tools: ToolDef[];

  constructor(private readonly options: ServerOptions) {
    this.paths = new PathPolicy(options.allowDirs);
    this.author = options.author ?? 'agent:mcp';
    this.scope = options.scope ?? 'export';
    this.now = options.now ?? (() => Date.now());
    this.tools = this.defineTools();
  }

  /** Closes the open project's renderer, or the bridge connection. */
  async close(): Promise<void> {
    await this.backend?.close();
  }

  /** Where notifications go (the transport sets this). */
  onNotify(fn: Notify): void {
    this.notify = fn;
  }

  async start(): Promise<void> {
    const bridge = this.options.bridge;
    if (bridge) {
      const b = await BridgeBackend.connect({
        url: bridge.url,
        token: bridge.token,
        name: bridge.name ?? this.author.replace(/^agent:/, ''),
      });
      // The token's scopes limit what this session allows.
      const top = b.scopes.includes('export')
        ? 'export'
        : b.scopes.includes('edit')
          ? 'edit'
          : 'read';
      if (LEVEL[top] < LEVEL[this.scope]) this.scope = top;
      this.attach(b);
    } else if (this.options.project) await this.open(this.options.project);
  }

  /** 'bridge' when working on an editor's document through the bridge. */
  get mode(): 'project' | 'bridge' {
    return this.options.bridge ? 'bridge' : 'project';
  }

  private require(): Backend {
    if (!this.backend)
      throw new MochiError(
        this.mode === 'bridge' ? 'E_BRIDGE' : 'E_NO_PROJECT',
        this.mode === 'bridge'
          ? 'Not connected to the editor through the bridge.'
          : 'No project is open. Call mochi_project with action "open" (or "new") and a path first.',
      );
    return this.backend;
  }

  /** The project backend; in bridge mode, project files belong to the person in the editor. */
  private requireProject(): Project {
    const b = this.require();
    if (!(b instanceof ProjectBackend))
      throw new MochiError(
        'E_FORBIDDEN',
        'In bridge mode the editor holds the document: the person opens, creates and saves projects there.',
      );
    return b.project;
  }

  private attach(b: Backend): void {
    this.unsubscribeProject?.();
    void this.backend?.close();
    this.backend = b;
    this.unsubscribeProject = b.onChange(() => this.changed());
    this.changed();
  }

  private changed(): void {
    for (const uri of this.subscriptions) this.notify('notifications/resources/updated', { uri });
  }

  private async open(path: string): Promise<void> {
    const dir = this.paths.check(path, 'The project');
    this.attach(new ProjectBackend(await Project.open(dir, { author: this.author })));
  }

  private async status(): Promise<Json> {
    return this.backend ? this.backend.status() : { open: false };
  }

  // ------------------------------------------------------------------ tools
  private defineTools(): ToolDef[] {
    const tools: ToolDef[] = [
      {
        name: 'mochi_project',
        title: 'Project',
        description:
          'Open, create, save or close the project, or get its status (path, revision, counts, dirty flag). "importModel" opens a .moc3 model folder (model: the folder or its .model3.json) as a new project in path; the result has the import report and a notice in "notices". Paths must be inside the allowed directories.',
        inputSchema: obj(
          {
            action: str('What to do', {
              enum: ['new', 'open', 'importModel', 'save', 'close', 'status'],
            }),
            path: str('Project folder (new, open, importModel: the new project)'),
            model: str('A .moc3 model folder or its .model3.json (importModel)'),
            discard: bool('Close without saving (close)'),
            canvas: obj(
              {
                width: num('pixels'),
                height: num('pixels'),
                pixelsPerUnit: num('pixels per model unit (default: the longer side)'),
                originX: num('pixels from the left'),
                originY: num('pixels from the top'),
              },
              ['width', 'height'],
            ),
          },
          ['action'],
        ),
        readOnly: false,
        scope: (a) =>
          a.action === 'new' || a.action === 'save' || a.action === 'importModel' ? 'edit' : 'read',
        call: async (a) => {
          const action = need<string>(a, 'action', 'string');
          if (action === 'status') return this.status();
          if (this.mode === 'bridge')
            throw new MochiError(
              'E_FORBIDDEN',
              'In bridge mode the editor holds the document: the person opens, creates and saves projects there. Only "status" works here.',
            );
          if (action === 'open') await this.open(need<string>(a, 'path', 'string'));
          else if (action === 'new') {
            const dir = this.paths.check(need<string>(a, 'path', 'string'), 'The project');
            const canvas = (a.canvas as { width: number; height: number } | undefined) ?? {
              width: 2048,
              height: 2048,
            };
            this.attach(
              new ProjectBackend(await Project.create(dir, canvas, { author: this.author })),
            );
          } else if (action === 'importModel') {
            const dir = this.paths.check(need<string>(a, 'path', 'string'), 'The project');
            const model = this.paths.check(need<string>(a, 'model', 'string'), 'The model');
            const r = await Project.importModel(model, dir, { author: this.author });
            this.attach(new ProjectBackend(r.project));
            return { ...(await this.status()), report: r.report, notices: r.notices };
          } else if (action === 'save') await this.requireProject().save();
          else if (action === 'close') {
            const p = this.requireProject();
            if (p.dirty && a.discard !== true)
              throw new MochiError(
                'E_RANGE',
                'The project has unsaved changes. Save first (action "save").',
              );
            this.unsubscribeProject?.();
            await p.close();
            this.backend = null;
          } else
            throw new MochiError('E_SCHEMA', `Unknown action "${action}".`, {
              path: 'args.action',
            });
          return this.status();
        },
      },
      {
        name: 'mochi_describe',
        title: 'Describe',
        description:
          'Discover commands: no arguments lists every command and operation with a summary; "command" gives its JSON Schema, docs, examples and errors; "search" ranks matches; "kind" gives a document object schema; "errors": true lists error codes.',
        inputSchema: obj({
          command: str('A command name, e.g. rig.addBinding'),
          search: str('Words to search for'),
          kind: str('A document object kind, e.g. artMesh', {
            enum: Object.keys(OBJECT_SCHEMAS),
          }),
          errors: bool('List the error codes'),
        }),
        readOnly: true,
        scope: 'read',
        call: async (a) => {
          if (typeof a.kind === 'string') return objectSchema(a.kind as Kind);
          if (a.errors === true) return errorCodes();
          const p = this.backend ?? new ProjectBackend(Project.memory());
          if (typeof a.command === 'string') return p.describe(a.command);
          if (typeof a.search === 'string') return p.describe({ search: a.search });
          return p.describe();
        },
      },
      {
        name: 'mochi_query',
        title: 'Query',
        description:
          'Read the document. With "ref", one object in full. Otherwise a list: kind (or kinds), where (field equality), fields, offset and limit (default 100).',
        inputSchema: obj({
          ref: str('One object: a UID, @kind:ExportId or @kind~"Name"'),
          kind: {
            description: 'Kind or kinds',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          where: { type: 'object', description: 'Field equality filters' },
          fields: { type: 'array', items: { type: 'string' } },
          offset: num('Skip this many'),
          limit: num('At most this many (default 100)'),
        }),
        readOnly: true,
        scope: 'read',
        call: async (a) => {
          const p = this.require();
          if (typeof a.ref === 'string') return p.get(a.ref);
          return p.query({
            kind: a.kind as Kind | Kind[] | undefined,
            where: a.where as Json | undefined,
            fields: a.fields as string[] | undefined,
            offset: a.offset as number | undefined,
            limit: (a.limit as number | undefined) ?? 100,
          });
        },
      },
      {
        name: 'mochi_run',
        title: 'Run a transaction',
        description: `Run commands (and operations such as art.import) as one atomic transaction: { label, commands: [{ name, args }], dryRun?, expectRevision? }. Results come back in order; later commands can refer to earlier results as "$n" or "$n.field". dryRun applies, reports the changes and lint results, and discards. preview (the fields of mochi_render) adds a render of the result. At most ${MAX_COMMANDS} commands.`,
        inputSchema: obj(
          {
            label: str('What the transaction does, for the history'),
            commands: {
              type: 'array',
              items: obj({ name: str('Command name'), args: { type: 'object' } }, ['name']),
            },
            dryRun: bool('Report without committing'),
            expectRevision: num('Fail unless the document is at this revision'),
            preview: obj(RENDER_FIELDS),
          },
          ['label', 'commands'],
        ),
        readOnly: false,
        scope: 'edit',
        call: async (a) => {
          const p = this.require();
          const label = need<string>(a, 'label', 'string');
          const commands = need<{ name: string; args?: unknown }[]>(a, 'commands', 'array');
          if (commands.length > MAX_COMMANDS)
            throw new MochiError(
              'E_RANGE',
              `At most ${MAX_COMMANDS} commands per transaction; split the work.`,
              { path: 'args.commands' },
            );
          for (const c of commands)
            if (
              (c.name === 'art.import' ||
                c.name === 'art.reimport' ||
                c.name === 'sound.import' ||
                c.name === 'physics.import' ||
                c.name === 'modelTemplate.apply') &&
              typeof (c.args as Json | undefined)?.path === 'string'
            )
              this.paths.check((c.args as Json).path as string, 'The file');
          const data = await p.run(
            label,
            commands.map((c) => ({ name: c.name, args: c.args ?? {} })),
            {
              dryRun: a.dryRun === true,
              expectRevision: a.expectRevision as number | undefined,
            },
          );
          // A preview of the result (committed runs only: a dry run's document is discarded).
          if (!a.preview || data.committed !== true) return data;
          const img = await p.render(renderOptions(a.preview as Json));
          return new WithImages(data, [
            { label: `preview of revision ${img.revision}`, png: img.png },
          ]);
        },
      },
      ...(['undo', 'redo'] as const).map((op): ToolDef => ({
        name: `mochi_${op}`,
        title: op === 'undo' ? 'Undo' : 'Redo',
        description: `${op === 'undo' ? 'Undo' : 'Redo'} the last n transactions (default 1); reports what changed.`,
        inputSchema: obj({ steps: num('How many (default 1)') }),
        readOnly: false,
        scope: 'edit',
        call: async (a) => {
          const p = this.require();
          const steps = (a.steps as number | undefined) ?? 1;
          return op === 'undo' ? p.undo(steps) : p.redo(steps);
        },
      })),
      {
        name: 'mochi_history',
        title: 'History',
        description: 'The committed transactions, oldest first, with labels and authors.',
        inputSchema: obj({}),
        readOnly: true,
        scope: 'read',
        call: async () => this.require().history(),
      },
      {
        name: 'mochi_diff',
        title: 'Structural diff',
        description:
          'Objects added, removed and changed between two revisions this session has been at (to defaults to now), with changed fields and mesh and warp point displacement. With visual: true, also before and after renders at the same pose and view, a difference image (changed pixels red) and image metrics (RMS, changed fraction).',
        inputSchema: obj(
          {
            from: num('Earlier revision'),
            to: num('Later revision'),
            visual: bool('Add before, after and difference images'),
            ...RENDER_FIELDS,
          },
          ['from'],
        ),
        readOnly: true,
        scope: 'read',
        call: async (a) => {
          const p = this.require();
          const from = need<number>(a, 'from', 'number');
          const to = a.to as number | undefined;
          const diff = (await p.diff(from, to)) as Json;
          if (a.visual !== true) return diff;
          const v = await p.visualDiff(from, to, renderOptions(a));
          return new WithImages({ ...diff, metrics: v.metrics }, [
            { label: `before (revision ${from})`, png: v.before.png },
            { label: `after (revision ${v.to})`, png: v.after.png },
            { label: 'difference (changed pixels red)', png: v.diff },
          ]);
        },
      },
      {
        name: 'mochi_render',
        title: 'Render',
        description:
          'Render the model at a pose to a PNG with Mochi2D (headless Chromium). Fast preview by default; reference: true for a reference render. around frames one mesh. revision renders an earlier revision this session has been at. In bridge mode, a call without pose, size, framing or revision shows exactly what the person sees in the editor.',
        inputSchema: obj({
          ...RENDER_FIELDS,
          revision: num('A revision this session has been at'),
        }),
        readOnly: true,
        scope: 'read',
        call: async (a) => {
          const r = await this.require().render({
            ...renderOptions(a),
            revision: a.revision as number | undefined,
          });
          const { png, ...meta } = r;
          return new WithImages(meta, [
            {
              label: `revision ${r.revision}, pose ${JSON.stringify(r.parameters)}, ${r.reference ? 'reference' : 'fast'} render`,
              png,
            },
          ]);
        },
      },
      {
        name: 'mochi_sweep',
        title: 'Sweep a parameter',
        description: `Render a parameter at several values: one contact sheet (left to right, top to bottom), or up to ${MAX_FRAMES} separate frames. values, or steps evenly over its range (default 5). Other parameters stay at their defaults or at "parameters".`,
        inputSchema: obj(
          {
            parameter: str('The parameter, e.g. @param:ParamAngleX'),
            values: { type: 'array', items: { type: 'number' } },
            steps: num('Evenly spaced values over the range (default 5)'),
            as: str('sheet (default) or frames', { enum: ['sheet', 'frames'] }),
            columns: num('Contact-sheet columns (default up to 4)'),
            ...RENDER_FIELDS,
          },
          ['parameter'],
        ),
        readOnly: true,
        scope: 'read',
        call: async (a) => {
          const values = a.values as number[] | undefined;
          const steps = a.steps as number | undefined;
          if ((values?.length ?? steps ?? 5) > MAX_FRAMES)
            throw new MochiError('E_RANGE', `At most ${MAX_FRAMES} values per sweep.`, {
              path: values ? 'args.values' : 'args.steps',
            });
          const r = await this.require().sweep(need<string>(a, 'parameter', 'string'), {
            ...renderOptions(a),
            values,
            steps,
            as: a.as as 'sheet' | 'frames' | undefined,
            columns: a.columns as number | undefined,
          });
          const meta = { parameter: r.parameter, values: r.values, columns: r.columns };
          return r.sheet
            ? new WithImages(meta, [
                { label: `${r.parameter} at ${r.values.join(', ')}`, png: r.sheet },
              ])
            : new WithImages(
                meta,
                r.frames!.map((f, i) => ({ label: `${r.parameter} = ${r.values[i]}`, png: f.png })),
              );
        },
      },
      {
        name: 'mochi_evaluate',
        title: 'Evaluate a pose',
        description:
          'Numbers at a pose, evaluated by Mochi2D from the exported model: per drawable visibility, opacity, draw and render order, colors and bounds in canvas pixels; vertices on request. parameters: { ExportId: value }.',
        inputSchema: obj({
          parameters: { type: 'object', additionalProperties: { type: 'number' } },
          vertices: bool('Include vertices (canvas pixels)'),
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only these drawables (export IDs)',
          },
        }),
        readOnly: true,
        scope: 'read',
        call: async (a) => {
          const e = (await this.require().evaluate({
            parameters: a.parameters as Record<string, number> | undefined,
            vertices: a.vertices === true,
          })) as Json & { drawables: { id: string }[] };
          const ids = a.ids as string[] | undefined;
          return ids ? { ...e, drawables: e.drawables.filter((d) => ids.includes(d.id)) } : e;
        },
      },
      {
        name: 'mochi_validate',
        title: 'Validate',
        description:
          'Document invariants and lint results with fixes; with targetVersion (auto, 3, 4, 5 or 6), also the whole export, which names what a version cannot carry.',
        inputSchema: obj({
          targetVersion: { description: 'auto, 3, 4, 5 or 6', enum: ['auto', 3, 4, 5, 6] },
        }),
        readOnly: true,
        scope: 'read',
        call: async (a) => {
          return this.require().validate(a.targetVersion as 'auto' | 3 | 4 | 5 | 6 | undefined);
        },
      },
      {
        name: 'mochi_import_art',
        title: 'Import art',
        description:
          'Import a PSD, OpenRaster file, PNG or folder of PNGs from an allowed directory: layers, parts and generated meshes (operation art.import). Other options as in mochi_describe { command: "art.import" }.',
        inputSchema: obj(
          {
            path: str('The art file or folder'),
            options: { type: 'object', description: 'Other art.import arguments' },
            dryRun: bool('Report without committing'),
          },
          ['path'],
        ),
        readOnly: false,
        scope: 'edit',
        call: async (a) => {
          const p = this.require();
          const path = this.paths.check(need<string>(a, 'path', 'string'), 'The file');
          return p.importArt(path, (a.options as Json | undefined) ?? {}, a.dryRun === true);
        },
      },
      {
        name: 'mochi_reimport_art',
        title: 'Re-import changed art',
        description:
          'Re-import a PSD, OpenRaster file, PNG or PNG folder after it changed (operation art.reimport): layers matched by group path and name get the new pixels, meshes keep their positions (texture coordinates follow the layers), new layers are added without meshes, removed ones are kept and flagged. The result lists the meshes that may need re-fitting. One undoable transaction; dryRun only reports.',
        inputSchema: obj(
          {
            path: str('The art file or folder, inside an allowed directory'),
            addNew: bool('Create layers that are new in the file (default true)'),
            dryRun: bool('Report without committing'),
          },
          ['path'],
        ),
        readOnly: false,
        scope: 'edit',
        call: async (a) => {
          const p = this.require();
          const path = this.paths.check(need<string>(a, 'path', 'string'), 'The file');
          return p.reimportArt(
            path,
            a.addNew === undefined ? {} : { addNew: a.addNew },
            a.dryRun === true,
          );
        },
      },
      {
        name: 'mochi_export',
        title: 'Export',
        description:
          'Export the model for apps to a folder or .zip inside an allowed directory; returns the export report. mocVersion: auto, 3, 4, 5 or 6.',
        inputSchema: obj(
          {
            out: str('Output folder or .zip file'),
            mocVersion: { enum: ['auto', 3, 4, 5, 6] },
            atlasSize: { enum: [1024, 2048, 4096, 8192] },
            fileStem: str('Base name of the files'),
            force: bool('Write into a non-empty folder that holds no previous export'),
          },
          ['out'],
        ),
        readOnly: false,
        scope: 'export',
        call: async (a) => {
          const p = this.require();
          const out = this.paths.check(need<string>(a, 'out', 'string'), 'The export target');
          return p.export(out, {
            mocVersion: a.mocVersion as 'auto' | 3 | 4 | 5 | 6 | undefined,
            atlasSize: a.atlasSize as 1024 | 2048 | 4096 | 8192 | undefined,
            fileStem: a.fileStem as string | undefined,
            force: a.force === true,
          });
        },
      },
      {
        name: 'mochi_export_movie',
        title: 'Export images or video',
        description:
          "Render a motion as PNG frames (transparent), a WebM video (alpha when the background is transparent) or an MP4 (where the platform has an H.264 encoder) into a folder inside an allowed directory. Physics runs from the motion's start; range 'workArea' renders the motion's work area. Needs the editor (--bridge mode).",
        inputSchema: obj(
          {
            out: str('Output folder'),
            motion: str('The motion (reference or UID)'),
            format: { enum: ['png', 'webm', 'mp4'] },
            width: { type: 'number' },
            height: { type: 'number' },
            fps: { type: 'number' },
            background: { type: ['string', 'null'], description: 'CSS color; null: transparent' },
            range: { enum: ['scene', 'workArea'] },
          },
          ['out', 'motion'],
        ),
        readOnly: false,
        scope: 'export',
        call: async (a) => {
          const p = this.require();
          const out = this.paths.check(need<string>(a, 'out', 'string'), 'The output folder');
          const { out: _out, ...rest } = a as Record<string, unknown>;
          return p.exportMovie(out, rest as unknown as MovieArgs);
        },
      },
    ];
    return tools;
  }

  // ------------------------------------------------------------------ resources
  private resourceList(): Json[] {
    const list: Json[] = [
      {
        uri: 'mochi://project',
        name: 'project',
        title: 'Project summary',
        mimeType: 'application/json',
      },
      {
        uri: 'mochi://history',
        name: 'history',
        title: 'Transaction history',
        mimeType: 'application/json',
      },
      {
        uri: 'mochi://schema/document',
        name: 'document-schema',
        title: 'Document JSON Schema',
        mimeType: 'application/json',
      },
      {
        uri: 'mochi://schema/commands',
        name: 'command-catalog',
        title: 'Command catalog',
        mimeType: 'application/json',
      },
      {
        uri: 'mochi://standard/parameters',
        name: 'standard-parameters',
        title:
          'Standard parameter IDs with their ranges, sections, meanings and Eye blink / Lip sync groups',
        mimeType: 'application/json',
      },
      {
        uri: 'mochi://standard/parameter-groups',
        name: 'standard-parameter-groups',
        title: 'Standard parameter-group IDs',
        mimeType: 'application/json',
      },
    ];
    for (const t of docTopics())
      list.push({
        uri: `mochi://docs/${t.name}`,
        name: `docs-${t.name}`,
        title: t.title,
        mimeType: 'text/markdown',
      });
    return list;
  }

  private resourceTemplates(): Json[] {
    return [
      {
        uriTemplate: 'mochi://document/{kind}',
        name: 'objects',
        title: 'Objects of a kind (compact)',
        mimeType: 'application/json',
      },
      {
        uriTemplate: 'mochi://document/{kind}/{uid}',
        name: 'object',
        title: 'One object, in full',
        mimeType: 'application/json',
      },
      {
        uriTemplate: 'mochi://docs/commands/{name}',
        name: 'command-docs',
        title: 'One command: schema, docs, examples, errors',
        mimeType: 'application/json',
      },
    ];
  }

  private async readResource(uri: string): Promise<{ mimeType: string; text: string }> {
    const json = (v: unknown) => ({
      mimeType: 'application/json',
      text: JSON.stringify(v, null, 2),
    });
    if (uri === 'mochi://project') return json(await this.status());
    if (uri === 'mochi://history') return json((await this.require().history()).history);
    if (uri === 'mochi://schema/document')
      return json(
        Object.fromEntries(Object.keys(OBJECT_SCHEMAS).map((k) => [k, objectSchema(k as Kind)])),
      );
    if (uri === 'mochi://schema/commands') {
      const p = this.backend ?? new ProjectBackend(Project.memory());
      const all = (await p.describe()) as { name: string }[];
      return json(await Promise.all(all.map((c) => p.describe(c.name))));
    }
    // The standard IDs: param.create { exportId, name, min, default, max } from these.
    if (uri === 'mochi://standard/parameters')
      return json({ note: STANDARD_ID_NOTE, parameters: STANDARD_PARAMETERS });
    if (uri === 'mochi://standard/parameter-groups') return json(STANDARD_PARAMETER_GROUPS);
    if (uri.startsWith('mochi://docs/')) {
      const text = docText(uri.slice('mochi://docs/'.length));
      if (text !== undefined)
        return {
          mimeType: uri.startsWith('mochi://docs/commands/') ? 'application/json' : 'text/markdown',
          text,
        };
    }
    const m = /^mochi:\/\/document\/([A-Za-z]+)(?:\/([a-z]+_[0-9]+|project))?$/.exec(uri);
    if (m) {
      const p = this.require();
      if (m[2]) return json(await p.get(m[2]));
      if (!(m[1]! in OBJECT_SCHEMAS))
        throw new MochiError(
          'E_NOT_FOUND',
          `Unknown kind "${m[1]}" (kinds: ${Object.keys(OBJECT_SCHEMAS).join(', ')}).`,
        );
      return json(await p.query({ kind: m[1] as Kind, limit: 10_000 }));
    }
    throw new MochiError(
      'E_NOT_FOUND',
      `No resource ${uri}. resources/list and resources/templates/list name them.`,
    );
  }

  // ------------------------------------------------------------------ JSON-RPC
  /** Handles one JSON-RPC message; returns the response, or undefined for notifications. */
  async handle(message: unknown): Promise<Json | undefined> {
    const req = message as Request;
    if (typeof req !== 'object' || req === null || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } };
    }
    const isNotification = req.id === undefined;
    try {
      const result = await this.dispatch(req.method, req.params ?? {});
      return isNotification ? undefined : { jsonrpc: '2.0', id: req.id ?? null, result };
    } catch (e) {
      if (isNotification) return undefined;
      if (e instanceof RpcError)
        return {
          jsonrpc: '2.0',
          id: req.id ?? null,
          error: { code: e.code, message: e.message, data: e.data },
        };
      const err = errorJson(e);
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: { code: -32603, message: err.message, data: err },
      };
    }
  }

  private async dispatch(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion as string | undefined;
        return {
          protocolVersion:
            asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: true, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: { name: SERVER_NAME, title: 'Mochi Maker', version: SERVER_VERSION },
          instructions:
            'Mochi Maker edits models for Live2D Cubism-compatible apps through commands. Start with mochi://docs/getting-started, then mochi_project and mochi_describe. Changes go through mochi_run, which is atomic and undoable.',
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {};
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
            _meta: {
              'mochi-maker/scope':
                typeof t.scope === 'string' ? t.scope : 'read or edit, by action',
            },
          })),
        };
      case 'tools/call':
        return this.callTool(params.name as string, (params.arguments as Json | undefined) ?? {});
      case 'resources/list':
        return { resources: this.resourceList() };
      case 'resources/templates/list':
        return { resourceTemplates: this.resourceTemplates() };
      case 'resources/read': {
        const uri = params.uri as string;
        try {
          return { contents: [{ uri, ...(await this.readResource(uri)) }] };
        } catch (e) {
          throw new RpcError(-32002, errorJson(e).message, { uri, error: errorJson(e) });
        }
      }
      case 'resources/subscribe':
        this.subscriptions.add(params.uri as string);
        return {};
      case 'resources/unsubscribe':
        this.subscriptions.delete(params.uri as string);
        return {};
      case 'prompts/list':
        return {
          prompts: PROMPTS.map((p) => ({
            name: p.name,
            description: p.description,
            arguments: p.arguments,
          })),
        };
      case 'prompts/get': {
        const p = PROMPTS.find((x) => x.name === params.name);
        if (!p) throw new RpcError(-32602, `No prompt "${String(params.name)}".`);
        const args = (params.arguments as Record<string, string> | undefined) ?? {};
        const missing = p.arguments.filter((x) => x.required && !args[x.name]).map((x) => x.name);
        if (missing.length > 0)
          throw new RpcError(-32602, `Prompt ${p.name} needs: ${missing.join(', ')}.`);
        return {
          description: p.description,
          messages: [{ role: 'user', content: { type: 'text', text: p.text(args) } }],
        };
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private async callTool(name: string, args: Json): Promise<Json> {
    const tool = this.tools.find((t) => t.name === name);
    const fail = (error: ErrorJson): Json => ({
      content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }],
      structuredContent: { error },
      isError: true,
    });
    if (!tool)
      return fail({
        category: 'unknown_command',
        code: 'E_UNKNOWN_COMMAND',
        message: `No tool "${name}". Tools: ${this.tools.map((t) => t.name).join(', ')}.`,
      });
    const t = this.now();
    while (this.calls.length > 0 && this.calls[0]! <= t - 1000) this.calls.shift();
    if (this.calls.length >= MAX_CALLS_PER_SECOND)
      return fail({
        category: 'rate_limited',
        code: 'E_RATE_LIMITED',
        message: `More than ${MAX_CALLS_PER_SECOND} tool calls in a second; wait a moment, or batch commands in one mochi_run.`,
      });
    this.calls.push(t);
    const needs = typeof tool.scope === 'string' ? tool.scope : tool.scope(args);
    if (LEVEL[needs] > LEVEL[this.scope])
      return fail({
        category: 'forbidden',
        code: 'E_FORBIDDEN',
        message: `${name} needs the "${needs}" scope; this session allows "${this.scope}". Ask the person to restart the server with --scope ${needs}.`,
      });
    try {
      const out = await tool.call(args);
      const images = out instanceof WithImages ? out.images : [];
      const result = out instanceof WithImages ? out.data : out;
      const structured = (
        typeof result === 'object' && result !== null && !Array.isArray(result)
          ? result
          : { result }
      ) as Json;
      return {
        content: [
          { type: 'text', text: JSON.stringify(result ?? null, null, 2) },
          ...images.flatMap((i) => [
            { type: 'text', text: i.label },
            { type: 'image', data: Buffer.from(i.png).toString('base64'), mimeType: 'image/png' },
          ]),
        ],
        structuredContent: structured,
      };
    } catch (e) {
      return fail(errorJson(e));
    }
  }
}

/** A tool result with images, returned as MCP image content after the JSON text. */
class WithImages {
  constructor(
    readonly data: unknown,
    readonly images: { label: string; png: Uint8Array }[],
  ) {}
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
