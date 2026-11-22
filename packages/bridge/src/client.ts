/**
 * A bridge client for Node (the MCP server in bridge mode, scripts, tests): hello with a token,
 * then commands and events.
 */
import { WebSocket } from 'ws';
import {
  DEFAULT_PORT,
  PROTOCOL,
  type BridgeError,
  type CommandInfo,
  type Scope,
} from './protocol.js';

export interface Welcome {
  name: string;
  scopes: Scope[];
  studio: { connected: boolean };
  commands: CommandInfo[];
  events: string[];
}

export interface BridgeEvent {
  name: string;
  data: unknown;
  time: number;
}

/** A failed command: the bridge's or the editor's error. */
export class BridgeCallError extends Error {
  constructor(readonly error: BridgeError) {
    super(error.message);
  }
  get code(): string {
    return this.error.code;
  }
}

export const DEFAULT_URL = `ws://127.0.0.1:${DEFAULT_PORT}`;

export class BridgeClient {
  welcome!: Welcome;
  connected = false;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Set<(e: BridgeEvent) => void>();
  private readonly studioListeners = new Set<(connected: boolean) => void>();
  private waiting: { resolve: (v: unknown) => void; types: string[] } | null = null;

  private constructor(private readonly ws: WebSocket) {}

  /** Connects to `url` (ws://127.0.0.1:47831 by default; /api is added). */
  static async connect(options: {
    url?: string;
    token: string;
    name: string;
  }): Promise<BridgeClient> {
    const base = (options.url ?? DEFAULT_URL).replace(/\/+$/, '').replace(/\/api$/, '');
    const ws = new WebSocket(`${base}/api`);
    const client = new BridgeClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) =>
        reject(
          new BridgeCallError({
            code: 'studio_not_connected',
            message: `No bridge at ${base}: ${e.message}. Start it with "mochi-maker bridge".`,
          }),
        ),
      );
    });
    // A broken connection is reported by its close (below); the error alone must not throw.
    ws.on('error', () => undefined);
    ws.on('message', (d) => client.onMessage(JSON.parse(d.toString()) as Record<string, unknown>));
    ws.on('close', (code, reason) => {
      client.connected = false;
      const err = new BridgeCallError({
        code: code === 4401 ? 'unauthorized' : 'studio_not_connected',
        message: `The bridge closed the connection (${code}${reason.length ? `: ${reason.toString()}` : ''}).`,
      });
      for (const p of client.pending.values()) p.reject(err);
      client.pending.clear();
      client.waiting?.resolve({ type: 'error', error: err.error });
    });
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        token: options.token,
        client: { name: options.name },
      }),
    );
    const m = (await client.next(['welcome', 'error'])) as Record<string, unknown>;
    if (m.type !== 'welcome') {
      ws.close();
      throw new BridgeCallError(m.error as BridgeError);
    }
    client.welcome = m as unknown as Welcome;
    client.connected = true;
    return client;
  }

  private next(types: string[]): Promise<unknown> {
    return new Promise((resolve) => (this.waiting = { resolve, types }));
  }

  private onMessage(m: Record<string, unknown>): void {
    if (this.waiting && this.waiting.types.includes(m.type as string)) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(m);
      return;
    }
    if (m.type === 'result') {
      const p = this.pending.get(String(m.id));
      if (!p) return;
      this.pending.delete(String(m.id));
      if (m.ok === true) p.resolve(m.result);
      else p.reject(new BridgeCallError(m.error as BridgeError));
    } else if (m.type === 'event') for (const l of this.listeners) l(m as unknown as BridgeEvent);
    else if (m.type === 'studio') {
      this.welcome.studio.connected = m.connected === true;
      for (const l of this.studioListeners) l(m.connected === true);
    }
  }

  /** Runs one command; rejects with a BridgeCallError. */
  command<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ type: 'command', id, name, args }));
    });
  }

  /** Subscribes to events (names, `*`, or prefixes ending in `*`). */
  async subscribe(events: string[], listener?: (e: BridgeEvent) => void): Promise<string[]> {
    if (listener) this.listeners.add(listener);
    this.ws.send(JSON.stringify({ type: 'subscribe', events }));
    const m = (await this.next(['subscribed'])) as { events: string[] };
    return m.events;
  }

  onEvent(listener: (e: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStudio(listener: (connected: boolean) => void): () => void {
    this.studioListeners.add(listener);
    return () => this.studioListeners.delete(listener);
  }

  close(): void {
    this.ws.close();
  }
}
