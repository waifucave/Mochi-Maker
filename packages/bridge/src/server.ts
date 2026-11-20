/**
 * The bridge (agent API design 5): a WebSocket server on 127.0.0.1 between one host (the editor,
 * on /host) and agents (clients, on /api), speaking Mochi Studio's bridge protocol version 1.
 *
 * It is off by default: it runs only when the person starts it (`mochi-maker bridge`). The host
 * pairs once with the code the bridge shows, and then manages client tokens for the person. The
 * bridge checks each client's token and scopes, its rate and the command's existence, and forwards
 * commands to the host, which checks the scopes again and runs them.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  APP,
  BRIDGE_VERSION,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  COMMAND_TIMEOUT_MS,
  DEFAULT_PORT,
  HELLO_TIMEOUT_MS,
  MAX_COMMANDS_PER_SECOND,
  MAX_MESSAGE,
  MAX_SUBSCRIPTIONS,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_TRIES,
  PROTOCOL,
  matches,
  type BridgeError,
  type ClientInfo,
  type CommandInfo,
  type Scope,
  type TokenInfo,
} from './protocol.js';
import { PairingCode, TokenStore } from './tokens.js';

export interface BridgeOptions {
  /** Default 47831; 0 picks a free port. */
  port?: number;
  /** Where token hashes are kept across runs; in memory when omitted. */
  stateFile?: string;
  /** Origins allowed besides http(s)://localhost and 127.0.0.1 (any port). */
  allowOrigins?: string[];
  /** Called with every new pairing code, for the person to read. */
  onPairingCode?: (code: string) => void;
  /** Called on notable events (host connected, client connected…), for a log. */
  onLog?: (line: string) => void;
  now?: () => number;
  commandTimeoutMs?: number;
}

type Json = Record<string, unknown>;

interface Conn {
  ws: WebSocket;
  role: 'host' | 'api';
}
interface HostConn extends Conn {
  role: 'host';
  welcomed: boolean;
}
interface ClientConn extends Conn {
  role: 'api';
  info?: ClientInfo & { tokenId: string };
  subscriptions: string[];
  calls: number[];
  helloTimer?: ReturnType<typeof setTimeout>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostName(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(header.trim().toLowerCase());
  return m?.[1];
}

export class BridgeServer {
  readonly tokens: TokenStore;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly pairing: PairingCode;
  private readonly now: () => number;
  private host: HostConn | null = null;
  private catalog: { commands: CommandInfo[]; events: string[] } = { commands: [], events: [] };
  private readonly clients = new Set<ClientConn>();
  private readonly pending = new Map<
    string,
    { client: ClientConn; id: string | number; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;
  private nextClient = 1;
  private actualPort = 0;

  constructor(private readonly options: BridgeOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.tokens = new TokenStore(options.stateFile);
    this.pairing = new PairingCode(PAIRING_CODE_TTL_MS, PAIRING_MAX_TRIES, this.now, (code) =>
      options.onPairingCode?.(code),
    );
    this.http = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.info()));
      } else res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
    this.http.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
  }

  /** Starts listening on 127.0.0.1. Resolves with the port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.options.port ?? DEFAULT_PORT, '127.0.0.1', () => {
        this.actualPort = (this.http.address() as { port: number }).port;
        resolve(this.actualPort);
      });
    });
  }

  get port(): number {
    return this.actualPort;
  }

  /** The code the person enters in the editor to pair it. */
  get pairingCode(): string {
    return this.pairing.code;
  }

  get hostConnected(): boolean {
    return this.host !== null;
  }

  info(): Json {
    return {
      app: APP,
      version: BRIDGE_VERSION,
      protocol: PROTOCOL,
      studio: { connected: this.hostConnected },
      endpoints: { host: '/host', api: '/api' },
    };
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.ws.terminate();
    this.host?.ws.terminate();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.wss.close();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  private log(line: string): void {
    this.options.onLog?.(line);
  }

  // ---------------------------------------------------------------- connections

  private originAllowed(origin: string | undefined, required: boolean): boolean {
    if (origin === undefined) return !required;
    if (this.options.allowOrigins?.includes(origin)) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    const refuse = (status: number, why: string) => {
      this.log(`refused ${path}: ${why}`);
      socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\n\r\n`);
      socket.destroy();
    };
    if (path !== '/host' && path !== '/api') return refuse(404, 'unknown path');
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return refuse(403, 'not a loopback peer');
    if (!LOCAL_HOSTS.has(hostName(req.headers.host) ?? '')) return refuse(403, 'Host header');
    if (!this.originAllowed(req.headers.origin, path === '/host'))
      return refuse(403, `origin ${req.headers.origin ?? '(none)'}`);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (path === '/host') this.onHost({ ws, role: 'host', welcomed: false });
      else this.onClient({ ws, role: 'api', subscriptions: [], calls: [] });
    });
  }

  private send(c: Conn, msg: Json): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private parse(data: RawData): Json | null {
    try {
      const m = JSON.parse(data.toString()) as unknown;
      return typeof m === 'object' &&
        m !== null &&
        !Array.isArray(m) &&
        typeof (m as Json).type === 'string'
        ? (m as Json)
        : null;
    } catch {
      return null;
    }
  }

  private error(c: Conn, code: string, message: string): void {
    this.send(c, { type: 'error', error: { code, message } });
  }

  // ---------------------------------------------------------------- host

  private onHost(h: HostConn): void {
    h.ws.on('message', (data) => {
      const m = this.parse(data);
      if (!m) return this.error(h, 'invalid_message', 'Messages are JSON objects with a "type".');
      this.hostMessage(h, m);
    });
    h.ws.on('close', () => {
      if (this.host !== h) return;
      this.host = null;
      this.catalog = { commands: [], events: [] };
      this.log('host disconnected');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.reply(p.client, p.id, {
          code: 'studio_not_connected',
          message: 'The editor disconnected before answering.',
        });
        this.pending.delete(id);
      }
      for (const c of this.clients) if (c.info) this.send(c, { type: 'studio', connected: false });
    });
  }

  private welcomeHost(h: HostConn): void {
    if (this.host && this.host !== h)
      this.host.ws.close(CLOSE_REPLACED, 'Another editor connected.');
    this.host = h;
    h.welcomed = true;
    this.send(h, {
      type: 'host_welcome',
      protocol: PROTOCOL,
      bridge: { version: BRIDGE_VERSION, port: this.port },
    });
    this.sendClients();
    this.log('host connected');
  }

  private hostMessage(h: HostConn, m: Json): void {
    switch (m.type) {
      case 'host_hello':
        if (m.protocol !== PROTOCOL) {
          this.error(h, 'protocol', `This bridge speaks protocol ${PROTOCOL}.`);
          h.ws.close();
          return;
        }
        if (this.tokens.isHostToken(m.hostToken)) this.welcomeHost(h);
        else
          this.send(h, {
            type: 'pair_required',
            message:
              'Enter the six-digit pairing code that the bridge shows (mochi-maker bridge prints it).',
          });
        return;
      case 'pair': {
        const r = this.pairing.check(m.code);
        if (!r.ok) {
          this.send(h, { type: 'pair_failed', message: r.message });
          return;
        }
        this.send(h, { type: 'paired', hostToken: this.tokens.newHostToken() });
        this.welcomeHost(h);
        return;
      }
    }
    if (!h.welcomed || this.host !== h)
      return this.error(h, 'unauthorized', 'Say host_hello (and pair) first.');
    switch (m.type) {
      case 'catalog': {
        const commands = Array.isArray(m.commands) ? (m.commands as CommandInfo[]) : [];
        const events = Array.isArray(m.events) ? (m.events as string[]) : [];
        this.catalog = { commands, events };
        for (const c of this.clients) if (c.info) this.send(c, { type: 'studio', connected: true });
        this.log(`catalog: ${commands.length} commands, ${events.length} events`);
        return;
      }
      case 'result': {
        const p = this.pending.get(String(m.id));
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(String(m.id));
        this.send(
          p.client,
          m.ok === true
            ? { type: 'result', id: p.id, ok: true, result: m.result ?? null }
            : {
                type: 'result',
                id: p.id,
                ok: false,
                error: m.error ?? { code: 'failed', message: 'The editor reported a failure.' },
              },
        );
        return;
      }
      case 'event': {
        if (typeof m.name !== 'string') return;
        const msg = { type: 'event', name: m.name, data: m.data ?? null, time: this.now() };
        for (const c of this.clients)
          if (
            c.info?.scopes.includes('read') &&
            c.subscriptions.some((s) => matches(s, m.name as string))
          )
            this.send(c, msg);
        return;
      }
      case 'token_create': {
        const scopes = Array.isArray(m.scopes) ? (m.scopes as string[]) : ['read'];
        const { token, info } = this.tokens.create(String(m.name ?? 'agent'), scopes, this.now());
        this.send(h, { type: 'token_created', requestId: m.requestId, token, info });
        return;
      }
      case 'token_list':
        this.send(h, { type: 'tokens', requestId: m.requestId, tokens: this.tokens.list() });
        return;
      case 'token_revoke': {
        const id = String(m.id);
        this.tokens.revoke(id);
        for (const c of this.clients)
          if (c.info?.tokenId === id) c.ws.close(CLOSE_UNAUTHORIZED, 'The token was revoked.');
        this.send(h, { type: 'token_revoked', requestId: m.requestId, id });
        return;
      }
      default:
        this.error(h, 'invalid_message', `Unknown message type "${String(m.type)}".`);
    }
  }

  private sendClients(): void {
    if (!this.host) return;
    const clients: ClientInfo[] = [...this.clients]
      .filter((c) => c.info)
      .map((c) => ({
        id: c.info!.id,
        name: c.info!.name,
        scopes: c.info!.scopes,
        connectedAt: c.info!.connectedAt,
      }));
    this.send(this.host, { type: 'clients', clients });
  }

  // ---------------------------------------------------------------- clients

  private onClient(c: ClientConn): void {
    this.clients.add(c);
    c.helloTimer = setTimeout(() => {
      if (c.info) return;
      this.error(c, 'unauthorized', 'Say hello with a token within 5 seconds.');
      c.ws.close(CLOSE_UNAUTHORIZED, 'No hello.');
    }, HELLO_TIMEOUT_MS);
    c.ws.on('message', (data) => {
      const m = this.parse(data);
      if (!m) return this.error(c, 'invalid_message', 'Messages are JSON objects with a "type".');
      this.clientMessage(c, m);
    });
    c.ws.on('close', () => {
      clearTimeout(c.helloTimer);
      this.clients.delete(c);
      for (const [id, p] of this.pending)
        if (p.client === c) {
          clearTimeout(p.timer);
          this.pending.delete(id);
        }
      if (c.info) {
        this.log(`client "${c.info.name}" left`);
        this.sendClients();
      }
    });
  }

  private reply(c: ClientConn, id: string | number, error: BridgeError): void {
    this.send(c, { type: 'result', id, ok: false, error });
  }

  private clientMessage(c: ClientConn, m: Json): void {
    if (m.type === 'hello') {
      if (m.protocol !== PROTOCOL) {
        this.error(c, 'protocol', `This bridge speaks protocol ${PROTOCOL}.`);
        c.ws.close();
        return;
      }
      const token: TokenInfo | undefined = this.tokens.use(m.token, this.now());
      if (!token) {
        this.error(
          c,
          'unauthorized',
          'Unknown token. Ask the person for a token from the editor (Agent access).',
        );
        c.ws.close(CLOSE_UNAUTHORIZED, 'Unknown token.');
        return;
      }
      clearTimeout(c.helloTimer);
      const name = String((m.client as Json | undefined)?.name ?? token.name);
      c.info = {
        id: `client_${this.nextClient++}`,
        name,
        scopes: token.scopes,
        connectedAt: this.now(),
        tokenId: token.id,
      };
      this.send(c, {
        type: 'welcome',
        protocol: PROTOCOL,
        name,
        scopes: token.scopes,
        studio: { connected: this.hostConnected },
        commands: this.catalog.commands,
        events: this.catalog.events,
      });
      this.log(`client "${name}" connected (${token.scopes.join(', ')})`);
      this.sendClients();
      return;
    }
    if (!c.info) {
      this.error(c, 'unauthorized', 'Say hello with a token first.');
      c.ws.close(CLOSE_UNAUTHORIZED, 'No hello.');
      return;
    }
    switch (m.type) {
      case 'command':
        return this.command(c, m);
      case 'subscribe':
      case 'unsubscribe': {
        const names = Array.isArray(m.events)
          ? (m.events as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        if (m.type === 'subscribe') {
          c.subscriptions = [...new Set([...c.subscriptions, ...names])].slice(
            0,
            MAX_SUBSCRIPTIONS,
          );
          this.send(c, { type: 'subscribed', events: c.subscriptions });
        } else {
          c.subscriptions = c.subscriptions.filter((s) => !names.includes(s));
          this.send(c, { type: 'unsubscribed', events: c.subscriptions });
        }
        return;
      }
      default:
        this.error(c, 'invalid_message', `Unknown message type "${String(m.type)}".`);
    }
  }

  private command(c: ClientConn, m: Json): void {
    const id = m.id;
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof m.name !== 'string') {
      this.error(c, 'invalid_message', 'A command needs an "id" and a "name".');
      return;
    }
    const t = this.now();
    while (c.calls.length > 0 && c.calls[0]! <= t - 1000) c.calls.shift();
    if (c.calls.length >= MAX_COMMANDS_PER_SECOND)
      return this.reply(c, id, {
        code: 'rate_limited',
        message: `More than ${MAX_COMMANDS_PER_SECOND} commands in a second; slow down, or batch commands in one "run".`,
      });
    c.calls.push(t);
    if (!this.host)
      return this.reply(c, id, {
        code: 'studio_not_connected',
        message:
          'No editor is connected. Ask the person to open Mochi Maker and connect it in Agent access.',
      });
    const def = this.catalog.commands.find((x) => x.name === m.name);
    if (!def)
      return this.reply(c, id, {
        code: 'unknown_command',
        message: `No command "${m.name}". The welcome message lists the commands.`,
      });
    if (!c.info!.scopes.includes(def.scope as Scope))
      return this.reply(c, id, {
        code: 'forbidden',
        message: `"${def.name}" needs the "${def.scope}" scope; this token has ${c.info!.scopes.join(', ')}. Ask the person for a token with more scopes.`,
      });
    const args = m.args ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args))
      return this.reply(c, id, {
        code: 'invalid_arguments',
        message: 'The arguments must be a JSON object.',
      });
    const bridgeId = `b${this.nextId++}`;
    const timer = setTimeout(() => {
      if (!this.pending.delete(bridgeId)) return;
      this.reply(c, id, { code: 'timeout', message: 'The editor did not answer in time.' });
    }, this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
    this.pending.set(bridgeId, { client: c, id, timer });
    const { tokenId: _, ...client } = c.info!;
    this.send(this.host, {
      type: 'command',
      id: bridgeId,
      client: { id: client.id, name: client.name, scopes: client.scopes },
      name: def.name,
      args,
    });
  }
}

export { DEFAULT_PORT };
