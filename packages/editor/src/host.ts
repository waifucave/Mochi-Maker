/**
 * The editor as the bridge's host (agent API design 5; Mochi Studio's bridge protocol, version 1):
 * it pairs with `mochi-maker bridge`, sends its command catalog, runs the commands agents send
 * through the same command layer as the person's edits, and sends events.
 *
 * Off by default: the editor connects only when the person clicks Connect in Agent access.
 */
import {
  DocView,
  MochiError,
  documentHash,
  errorCodes,
  objectSchema,
  type CommandCall,
  type Kind,
  type QueryOptions,
} from '@mochi-maker/core';
import { diffDocuments, errorJson } from '@mochi-maker/api/browser';
import { exportModel, type ExportOptions } from '@mochi-maker/export';
import { Emitter, type Editor } from './editor.js';
import type { AgentSurface } from './agent.js';
import type { Offscreen, OffscreenOptions } from './offscreen.js';
import type { Viewport } from './viewport.js';
import { saveSnapshotAsGuide } from './guides.js';
import { movieSettings, renderMovie, type MovieSettings } from './movie.js';

export const PROTOCOL = 1;
export const DEFAULT_BRIDGE = 'ws://127.0.0.1:47831';
const HOST_TOKEN_KEY = 'mochi-maker.hostToken';

type Scope = 'read' | 'edit' | 'export';
type Json = Record<string, unknown>;

export interface CommandInfo {
  name: string;
  summary: string;
  details?: string;
  scope: Scope;
  undoable: boolean;
  readOnly: boolean;
  inputSchema: unknown;
}
export interface ClientInfo {
  id: string;
  name: string;
  scopes: Scope[];
  connectedAt: number;
}
export interface TokenInfo {
  id: string;
  name: string;
  scopes: Scope[];
  created: number;
  lastUsed: number | null;
}
export type HostState = 'off' | 'connecting' | 'pairing' | 'connected';

/** One line of the agents panel: a command an agent ran. */
export interface AgentCall {
  time: number;
  client: string;
  name: string;
  label?: string;
  ok: boolean;
  error?: string;
}

export const EVENTS = ['revision', 'control', 'presence', 'project'];

/** Operations that read files from a path; through the bridge, `import_art` carries the bytes. */
const PATH_OPERATIONS = new Set(['art.import', 'art.reimport', 'sound.import']);
/** Operations that take a path or the file itself: through the bridge, only the file itself. */
const PATH_ARGS = new Set(['physics.import', 'modelTemplate.apply']);

const obj = (properties: Json, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true,
});
const RENDER_FIELDS: Json = {
  parameters: { type: 'object', additionalProperties: { type: 'number' } },
  width: { type: 'number' },
  height: { type: 'number' },
  around: { type: 'string' },
  margin: { type: 'number' },
  view: obj({ x: { type: 'number' }, y: { type: 'number' }, pixelsPerUnit: { type: 'number' } }),
  background: { type: 'array', items: { type: 'number' } },
  revision: { type: 'number' },
};

/** The bridge's error for a thrown value: the protocol's code, plus Mochi Maker's own fields. */
export function bridgeError(e: unknown): Json {
  const j = errorJson(e);
  const code =
    j.code === 'E_CONTROL_HELD'
      ? 'control_held'
      : j.category === 'no_project'
        ? 'no_model'
        : j.category;
  const out: Json = { code, message: j.message, mochiCode: j.code };
  for (const k of ['command', 'at', 'path', 'details', 'fixes'] as const)
    if (j[k] !== undefined) out[k] = j[k];
  return out;
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

type HostEvents = {
  state: HostState;
  clients: ClientInfo[];
  tokens: TokenInfo[];
  call: AgentCall;
  error: string;
};

export class BridgeHost extends Emitter<HostEvents> {
  state: HostState = 'off';
  url = DEFAULT_BRIDGE;
  clients: ClientInfo[] = [];
  tokens: TokenInfo[] = [];
  readonly calls: AgentCall[] = [];
  /** The label of the command an agent is running now, for the indicator. */
  current: { client: string; label: string } | null = null;
  /** The first revision an agent changed in this connection (for "undo agent changes"). */
  private ws: WebSocket | null = null;
  private requests = new Map<string, (m: Json) => void>();
  private nextRequest = 1;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly editor: Editor,
    private readonly agent: AgentSurface,
    private readonly viewport: Viewport,
    private readonly offscreen: Offscreen,
  ) {
    super();
    editor.on('document', (e) =>
      this.event('revision', {
        revision: e.revision,
        author: e.author,
        label: e.label,
        changes: e.changes.length,
        kinds: [...new Set(e.changes.map((c) => c.kind))],
      }),
    );
    editor.on('control', (c) => this.event('control', c));
    editor.on('project', () =>
      this.event('project', { name: editor.name, revision: editor.session.revision }),
    );
    const presence = () => {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = setTimeout(() => this.event('presence', this.presence()), 100);
    };
    editor.on('selection', presence);
    editor.on('pose', presence);
  }

  // ---------------------------------------------------------------- connection

  private storedToken(): string | null {
    try {
      return localStorage.getItem(`${HOST_TOKEN_KEY}:${this.url}`);
    } catch {
      return null;
    }
  }

  private storeToken(token: string | null): void {
    try {
      if (token) localStorage.setItem(`${HOST_TOKEN_KEY}:${this.url}`, token);
      else localStorage.removeItem(`${HOST_TOKEN_KEY}:${this.url}`);
    } catch {
      /* private window: the person pairs again next time */
    }
  }

  private setState(s: HostState): void {
    this.state = s;
    this.emit('state', s);
  }

  /** Connects to the bridge as its host. Resolves when connected or when pairing is needed. */
  connect(url = this.url): Promise<HostState> {
    this.disconnect();
    this.url = url.replace(/\/+$/, '').replace(/\/host$/, '');
    this.setState('connecting');
    return new Promise((resolve) => {
      let settled = false;
      const done = (s: HostState) => {
        if (!settled) resolve(s);
        settled = true;
      };
      const ws = new WebSocket(`${this.url}/host`);
      this.ws = ws;
      ws.onopen = () => {
        const hello: Json = {
          type: 'host_hello',
          protocol: PROTOCOL,
          app: 'mochi-maker',
          version: '0.0.0',
        };
        const token = this.storedToken();
        if (token) hello.hostToken = token;
        this.send(hello);
      };
      ws.onerror = () => {
        this.emit('error', `No bridge at ${this.url}. Start it with "mochi-maker bridge".`);
      };
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.clients = [];
        this.emit('clients', []);
        this.setState('off');
        if (e.code === 4000)
          this.emit('error', 'Another editor connected to the bridge and replaced this one.');
        done('off');
      };
      ws.onmessage = (ev) => {
        let m: Json;
        try {
          m = JSON.parse(String(ev.data)) as Json;
        } catch {
          return;
        }
        if (m.type === 'pair_required') {
          this.storeToken(null);
          this.setState('pairing');
          done('pairing');
        } else if (m.type === 'paired') this.storeToken(m.hostToken as string);
        else if (m.type === 'pair_failed') this.emit('error', String(m.message));
        else if (m.type === 'host_welcome') {
          this.send({ type: 'catalog', commands: this.catalog(), events: EVENTS });
          this.setState('connected');
          void this.listTokens();
          done('connected');
        } else this.onMessage(m);
      };
    });
  }

  /** Sends the pairing code the bridge shows. */
  pair(code: string): void {
    this.send({ type: 'pair', code: code.trim() });
  }

  disconnect(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    if (this.state !== 'off') {
      this.clients = [];
      this.emit('clients', []);
      this.setState('off');
    }
  }

  private send(m: Json): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private event(name: string, data: unknown): void {
    if (this.state === 'connected') this.send({ type: 'event', name, data });
  }

  private request(m: Json, reply: string): Promise<Json> {
    const requestId = `r${this.nextRequest++}`;
    return new Promise((resolve) => {
      this.requests.set(`${reply}:${requestId}`, resolve);
      this.send({ ...m, requestId });
    });
  }

  // ---------------------------------------------------------------- tokens

  async createToken(name: string, scope: Scope): Promise<{ token: string; info: TokenInfo }> {
    const m = await this.request({ type: 'token_create', name, scopes: [scope] }, 'token_created');
    await this.listTokens();
    return { token: m.token as string, info: m.info as TokenInfo };
  }

  async listTokens(): Promise<TokenInfo[]> {
    const m = await this.request({ type: 'token_list' }, 'tokens');
    this.tokens = m.tokens as TokenInfo[];
    this.emit('tokens', this.tokens);
    return this.tokens;
  }

  async revokeToken(id: string): Promise<void> {
    await this.request({ type: 'token_revoke', id }, 'token_revoked');
    await this.listTokens();
  }

  // ---------------------------------------------------------------- messages

  private onMessage(m: Json): void {
    const key = `${String(m.type)}:${String(m.requestId)}`;
    const waiter = this.requests.get(key);
    if (waiter) {
      this.requests.delete(key);
      waiter(m);
      return;
    }
    if (m.type === 'clients') {
      this.clients = m.clients as ClientInfo[];
      this.emit('clients', this.clients);
    } else if (m.type === 'command') void this.command(m);
    else if (m.type === 'error')
      this.emit('error', String((m.error as Json | undefined)?.message ?? 'Bridge error.'));
  }

  private async command(m: Json): Promise<void> {
    const client = m.client as { id: string; name: string; scopes: Scope[] };
    const name = String(m.name);
    const args = (m.args ?? {}) as Json;
    const author = `agent:${client.name.replace(/[^\w.@-]+/g, '-').slice(0, 64) || 'agent'}`;
    const label = typeof args.label === 'string' ? args.label : name;
    this.current = { client: client.name, label };
    this.emit('call', { time: Date.now(), client: client.name, name, label, ok: true });
    try {
      const def = this.catalog().find((c) => c.name === name);
      if (!def) throw new MochiError('E_UNKNOWN_COMMAND', `No command "${name}".`);
      // The host checks the scope too (the protocol asks both sides to).
      if (!client.scopes.includes(def.scope))
        throw new MochiError(
          'E_FORBIDDEN',
          `"${name}" needs the "${def.scope}" scope; this agent has ${client.scopes.join(', ')}.`,
        );
      const result = await this.runCommand(name, args, author, client.scopes);
      this.send({ type: 'result', id: m.id, ok: true, result: result ?? null });
      this.log({ time: Date.now(), client: client.name, name, label, ok: true });
    } catch (e) {
      const error = bridgeError(e);
      this.send({ type: 'result', id: m.id, ok: false, error });
      this.log({
        time: Date.now(),
        client: client.name,
        name,
        label,
        ok: false,
        error: String(error.message),
      });
    } finally {
      this.current = null;
    }
  }

  private log(c: AgentCall): void {
    this.current = null;
    this.calls.push(c);
    if (this.calls.length > 500) this.calls.shift();
    this.emit('call', c);
  }

  // ---------------------------------------------------------------- the catalog

  /** Every command the bridge offers: the API methods, then the document commands and operations. */
  catalog(): CommandInfo[] {
    const api: CommandInfo[] = [
      {
        name: 'status',
        summary:
          'The open project: name, revision, counts, canvas, export settings, undo state and the control lease.',
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({}),
      },
      {
        name: 'describe',
        summary:
          'Discover commands: all, one ("command"), a search ("search"), an object schema ("kind"), or the error codes ("errors": true).',
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({
          command: { type: 'string' },
          search: { type: 'string' },
          kind: { type: 'string' },
          errors: { type: 'boolean' },
        }),
      },
      {
        name: 'query',
        summary:
          'Read the document: one object ("ref"), or a list by kind, where, fields, offset and limit.',
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({
          ref: { type: 'string' },
          kind: {},
          where: { type: 'object' },
          fields: { type: 'array' },
          offset: { type: 'number' },
          limit: { type: 'number' },
        }),
      },
      {
        name: 'run',
        summary:
          'Run commands and operations as one atomic transaction, attributed to the agent: { label, commands: [{ name, args }], dryRun?, expectRevision? }. Results, the new revision and a structural diff.',
        scope: 'edit',
        undoable: true,
        readOnly: false,
        inputSchema: obj(
          {
            label: { type: 'string' },
            commands: { type: 'array' },
            dryRun: { type: 'boolean' },
            expectRevision: { type: 'number' },
          },
          ['label', 'commands'],
        ),
      },
      {
        name: 'undo',
        summary: 'Undo n transactions (any author).',
        scope: 'edit',
        undoable: false,
        readOnly: false,
        inputSchema: obj({ steps: { type: 'number' } }),
      },
      {
        name: 'redo',
        summary: 'Redo n transactions.',
        scope: 'edit',
        undoable: false,
        readOnly: false,
        inputSchema: obj({ steps: { type: 'number' } }),
      },
      {
        name: 'history',
        summary: 'The committed transactions with labels and authors.',
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({}),
      },
      {
        name: 'diff',
        summary: 'Structural diff between revisions this editor session has been at.',
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({ from: { type: 'number' }, to: { type: 'number' } }, ['from']),
      },
      {
        name: 'validate',
        summary: 'Invariants and lint; with targetVersion, also the export check.',
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({ targetVersion: {} }),
      },
      {
        name: 'evaluate',
        summary: "Mochi2D's evaluation at a pose (canvas pixels), off the person's screen.",
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({
          parameters: RENDER_FIELDS.parameters as Json,
          vertices: { type: 'boolean' },
          revision: { type: 'number' },
        }),
      },
      {
        name: 'render',
        summary:
          "A PNG (base64): source 'editor' is exactly what the person sees; otherwise a pose, size, framing or revision rendered off-screen.",
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({ source: { enum: ['editor', 'pose'] }, ...RENDER_FIELDS }),
      },
      {
        name: 'presence',
        summary: 'What the person is looking at: selection, pose and the control lease.',
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({}),
      },
      {
        name: 'snapshot',
        summary:
          "The view's snapshot (view state): take it, show it, hide it, clear it, or read its status. With png: true, its image as base64.",
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({
          action: { type: 'string', enum: ['take', 'show', 'hide', 'clear', 'status'] },
          png: { type: 'boolean' },
        }),
      },
      {
        name: 'snapshot_guide',
        summary:
          'Save the snapshot as a guide image: a part kept as a visual reference (exported only when the export settings include guide images).',
        scope: 'edit',
        undoable: true,
        readOnly: false,
        inputSchema: obj({}),
      },
      {
        name: 'focus',
        summary:
          'Show the person what the agent is working on: outlines these objects in the agent color.',
        scope: 'read',
        undoable: false,
        readOnly: true,
        inputSchema: obj({ refs: { type: 'array', items: { type: 'string' } } }),
      },
      {
        name: 'import_art',
        summary:
          'Import art the agent sends (base64 files: one PSD, ORA or PNG, or a folder of PNGs) with art.import.',
        scope: 'edit',
        undoable: true,
        readOnly: false,
        inputSchema: obj(
          {
            files: { type: 'object' },
            path: { type: 'string' },
            options: { type: 'object' },
            dryRun: { type: 'boolean' },
          },
          ['files', 'path'],
        ),
      },
      {
        name: 'reimport_art',
        summary:
          'Re-import changed art the agent sends (base64 files, as for import_art) with art.reimport: new pixels for matching layers, meshes kept in place, a report of what needs re-fitting.',
        scope: 'edit',
        undoable: true,
        readOnly: false,
        inputSchema: obj(
          {
            files: { type: 'object' },
            path: { type: 'string' },
            options: { type: 'object' },
            dryRun: { type: 'boolean' },
          },
          ['files', 'path'],
        ),
      },
      {
        name: 'export',
        summary:
          'The export: its report and files (base64). The agent side writes them; the editor writes nothing.',
        scope: 'export',
        undoable: false,
        readOnly: true,
        inputSchema: obj({ mocVersion: {}, atlasSize: {}, fileStem: { type: 'string' } }),
      },
      {
        name: 'export_movie',
        summary:
          "A motion as an image sequence (PNG frames with transparency) or a video (WebM, with alpha when the background is transparent; MP4 where the platform encodes H.264), rendered off the person's screen with physics from the motion's start. Files as base64; the editor writes nothing.",
        scope: 'export',
        undoable: false,
        readOnly: true,
        inputSchema: obj(
          {
            motion: { type: 'string' },
            format: { enum: ['png', 'webm', 'mp4'] },
            width: { type: 'number' },
            height: { type: 'number' },
            fps: { type: 'number' },
            background: { type: ['string', 'null'] },
            range: { enum: ['scene', 'workArea'] },
          },
          ['motion'],
        ),
      },
    ];
    const commands = this.agent
      .describe()
      .filter((c) => !PATH_OPERATIONS.has(c.name))
      .map((c) => {
        const d = this.agent.describe(c.name);
        return {
          name: d.name,
          summary: d.summary,
          details: d.doc,
          scope: d.scope,
          undoable: d.undoable,
          readOnly: d.readOnly,
          inputSchema: d.args,
        } as CommandInfo;
      });
    return [...api, ...commands];
  }

  // ---------------------------------------------------------------- running commands

  presence() {
    return {
      selection: this.editor.selection,
      pose: this.editor.poseByExportId(),
      control: this.editor.control,
      revision: this.editor.session.revision,
    };
  }

  private snapshot(revision: unknown) {
    if (revision === undefined) return this.editor.doc;
    const doc = this.editor.snapshots.get(revision as number);
    if (!doc)
      throw new MochiError(
        'E_RANGE',
        `Revision ${String(revision)} is not available in this editor session.`,
        { path: 'args.revision' },
      );
    return doc;
  }

  private async runCommand(
    name: string,
    a: Json,
    author: string,
    scopes: Scope[],
  ): Promise<unknown> {
    const editor = this.editor;
    const session = editor.session;
    switch (name) {
      case 'status': {
        const v = session.view;
        const counts: Record<string, number> = {};
        for (const o of v.all()) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
        delete counts.project;
        return {
          open: true,
          name: editor.name,
          revision: session.revision,
          documentHash: documentHash(session.doc),
          canUndo: session.canUndo,
          canRedo: session.canRedo,
          canvas: v.project().canvas,
          exportSettings: v.project().exportSettings,
          counts,
          control: editor.control,
        };
      }
      case 'describe':
        if (typeof a.command === 'string') return this.agent.describe(a.command);
        if (typeof a.search === 'string') return this.agent.describe({ search: a.search });
        if (typeof a.kind === 'string') return objectSchema(a.kind as Kind);
        if (a.errors === true) return errorCodes();
        return this.agent.describe();
      case 'query':
        if (typeof a.ref === 'string') return session.get(a.ref);
        return session.query({
          ...(a as QueryOptions),
          limit: (a.limit as number | undefined) ?? 100,
        });
      case 'history':
        return { revision: session.revision, history: session.history() };
      case 'diff':
        return this.agent.diff(a.from as number, (a.to as number | undefined) ?? session.revision);
      case 'presence':
        return this.presence();
      case 'snapshot': {
        const vp = this.viewport;
        const action = (a.action as string | undefined) ?? 'status';
        if (action === 'take' && !(await vp.takeSnapshot()))
          throw new MochiError('E_RANGE', 'There is no model shown to take a snapshot of.');
        if (action === 'show') vp.setSnapshotShown(true);
        if (action === 'hide') vp.setSnapshotShown(false);
        if (action === 'clear') vp.clearSnapshot();
        const s = vp.snapshot;
        return {
          taken: s !== null,
          shown: s !== null && vp.snapshotShown,
          ...(s ? { width: s.width, height: s.height, canvasQuad: vp.snapshotCanvasQuad() } : {}),
          ...(s && a.png ? { png: b64(s.png) } : {}),
        };
      }
      case 'snapshot_guide': {
        editor.checkAgentEdit();
        if (!this.viewport.snapshot)
          throw new MochiError('E_RANGE', 'Take a snapshot first (snapshot with action "take").');
        const r = await saveSnapshotAsGuide(editor, this.viewport, author);
        if (!r) throw new MochiError('E_RANGE', 'The guide image could not be made.');
        return r;
      }
      case 'focus': {
        const refs = Array.isArray(a.refs) ? (a.refs as string[]) : [];
        const uids = refs.map((r) =>
          session.view.resolve(
            r,
            ['artMesh', 'part', 'warp', 'rotation', 'parameter', 'glue'],
            'refs',
          ),
        );
        this.viewport.setFocus(uids);
        return { focus: uids };
      }
      case 'validate': {
        const v = session.validate();
        if (a.targetVersion === undefined) return v;
        try {
          const r = await exportModel(session.doc, editor.assets, {
            features: session.features,
            mocVersion: a.targetVersion as ExportOptions['mocVersion'],
          });
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
          const problems = (e.details?.problems as { source: string }[] | undefined) ?? [];
          return {
            ...v,
            export: { ok: false, problems: problems.filter((x) => x.source !== 'lint') },
          };
        }
      }
      case 'evaluate': {
        const doc = this.snapshot(a.revision);
        const parameters = (a.parameters as Record<string, number> | undefined) ?? {};
        const e = await this.offscreen.evaluate(doc, parameters, a.vertices === true);
        return {
          revision: (a.revision as number | undefined) ?? session.revision,
          mocVersion: e.version,
          parameters,
          drawables: e.drawables,
        };
      }
      case 'render': {
        const revision = (a.revision as number | undefined) ?? session.revision;
        if (a.source === 'editor') {
          await this.viewport.idle();
          const blob = await this.viewport.view.screenshot();
          const png = new Uint8Array(await blob.arrayBuffer());
          const t = this.viewport.view.viewTransform;
          return {
            png: b64(png),
            source: 'editor',
            revision: session.revision,
            parameters: editor.poseByExportId(),
            pixelsPerUnit: t.pixelsPerUnit,
            notes: ['what the person sees: their pose, zoom and pan'],
          };
        }
        const doc = this.snapshot(a.revision);
        const r = await this.offscreen.render(doc, a as OffscreenOptions);
        return {
          png: b64(r.png),
          source: 'pose',
          width: r.width,
          height: r.height,
          revision,
          parameters: (a.parameters as Json | undefined) ?? {},
          reference: false,
          pixelsPerUnit: r.pixelsPerUnit,
          center: r.center,
          notes: ["the editor's view (Mochi2D's browser renderer), off the person's screen"],
        };
      }
      case 'export': {
        const r = await exportModel(session.doc, editor.assets, {
          features: session.features,
          mocVersion: a.mocVersion as ExportOptions['mocVersion'],
          atlasSize: a.atlasSize as ExportOptions['atlasSize'],
          fileStem: a.fileStem as string | undefined,
        });
        return {
          report: r.report,
          files: Object.fromEntries([...r.files].map(([p, bytes]) => [p, b64(bytes)])),
        };
      }
      case 'export_movie': {
        const r = await renderMovie(
          editor,
          this.offscreen,
          movieSettings(editor, a as Partial<MovieSettings> & { motion: string }),
        );
        return {
          format: r.format,
          frames: r.frames,
          first: r.first,
          width: r.width,
          height: r.height,
          fps: r.fps,
          alpha: r.alpha,
          codec: r.codec,
          files: Object.fromEntries([...r.files].map(([p, bytes]) => [p, b64(bytes)])),
        };
      }
      case 'undo':
      case 'redo': {
        editor.checkAgentEdit();
        const from = session.revision;
        const steps = (a.steps as number | undefined) ?? 1;
        for (let i = 0; i < steps; i++) name === 'undo' ? session.undo() : session.redo();
        return {
          revision: session.revision,
          diff: diffDocuments(editor.snapshots.get(from)!, session.doc),
        };
      }
      case 'import_art':
      case 'reimport_art': {
        // A stable place per file name, so a later re-import matches what was imported.
        const files = (a.files ?? {}) as Record<string, string>;
        for (const [p, data] of Object.entries(files)) {
          if (p.includes('..') || p.startsWith('/'))
            throw new MochiError('E_FORBIDDEN', `Bad file name "${p}".`);
          await editor.fs.writeBytes(`agent-art/${p}`, unb64(data));
        }
        const path = `agent-art/${String(a.path)}`;
        const op = name === 'import_art' ? 'art.import' : 'art.reimport';
        return this.run(
          `${name === 'import_art' ? 'Import' : 'Re-import'} ${String(a.path)}`,
          [{ name: op, args: { ...((a.options as Json | undefined) ?? {}), path } }],
          author,
          a.dryRun === true,
          undefined,
          scopes,
          true,
        );
      }
      case 'run': {
        const commands = Array.isArray(a.commands) ? (a.commands as CommandCall[]) : [];
        if (typeof a.label !== 'string' || !Array.isArray(a.commands))
          throw new MochiError('E_SCHEMA', 'run needs a "label" and a "commands" list.', {
            path: 'args',
          });
        return this.run(
          a.label,
          commands,
          author,
          a.dryRun === true,
          a.expectRevision as number | undefined,
          scopes,
        );
      }
      default:
        // A single document command or operation, as its own transaction.
        return this.run(name, [{ name, args: a }], author, false, undefined, scopes);
    }
  }

  private async run(
    label: string,
    commands: CommandCall[],
    author: string,
    dryRun: boolean,
    expectRevision: number | undefined,
    scopes: Scope[],
    /** import_art: the editor wrote the files itself, so art.import may read them. */
    internal = false,
  ) {
    if (commands.length > 10_000)
      throw new MochiError('E_RANGE', 'At most 10 000 commands per transaction; split the work.', {
        path: 'args.commands',
      });
    for (const [i, c] of commands.entries()) {
      if (PATH_ARGS.has(c.name) && (c.args as Json | undefined)?.path !== undefined && !internal)
        throw new MochiError(
          'E_FORBIDDEN',
          `${c.name} through the bridge takes the file's contents (\`text\` or \`files\`), not a path the editor cannot reach.`,
          { path: `args.commands.${i}.args.path` },
        );
      if (PATH_OPERATIONS.has(c.name) && !internal)
        throw new MochiError(
          'E_FORBIDDEN',
          `${c.name} reads a file path, which the editor cannot reach through the bridge; send the file with import_art.`,
          { path: `args.commands.${i}` },
        );
      const d = this.agent.describe().find((x) => x.name === c.name);
      const scope = d ? this.agent.describe(c.name).scope : 'edit';
      if (!scopes.includes(scope))
        throw new MochiError('E_FORBIDDEN', `${c.name} needs the "${scope}" scope.`, {
          path: `args.commands.${i}`,
        });
    }
    const from = this.editor.session.revision;
    const r = await this.agent.run(
      label,
      commands.map((c) => ({ name: c.name, args: c.args ?? {} })),
      { author, dryRun, expectRevision, quiet: true },
    );
    const { previews, ...rest } = r;
    return {
      ...rest,
      previews: previews.map((p) => p.description),
      diff: r.committed
        ? diffDocuments(
            this.editor.snapshots.get(from) ?? new DocView(this.editor.doc).doc,
            this.editor.doc,
          )
        : undefined,
    };
  }
}
