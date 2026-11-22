/**
 * The bridge protocol (Mochi Studio's version 1) with a scripted host: transport checks, pairing,
 * host tokens, client tokens and scopes, command routing, events, limits and errors.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import {
  BridgeClient,
  BridgeCallError,
  BridgeServer,
  MAX_MESSAGE,
  type CommandInfo,
} from '@mochi-maker/bridge';

const servers: BridgeServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const s of servers.splice(0)) await s.close();
});

async function bridge(options: ConstructorParameters<typeof BridgeServer>[0] = {}) {
  const b = new BridgeServer({ port: 0, ...options });
  servers.push(b);
  await b.listen();
  return b;
}

type Msg = Record<string, unknown>;
/** A raw WebSocket with a message queue. */
async function socket(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  const queue: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return {
    ws,
    closed,
    send: (m: Msg) => ws.send(JSON.stringify(m)),
    next: () => new Promise<Msg>((r) => (queue.length ? r(queue.shift()!) : waiters.push(r))),
  };
}

const CATALOG: CommandInfo[] = [
  {
    name: 'status',
    summary: 'status',
    scope: 'read',
    undoable: false,
    readOnly: true,
    inputSchema: { type: 'object' },
  },
  {
    name: 'run',
    summary: 'run',
    scope: 'edit',
    undoable: true,
    readOnly: false,
    inputSchema: { type: 'object' },
  },
  {
    name: 'export',
    summary: 'export',
    scope: 'export',
    undoable: false,
    readOnly: true,
    inputSchema: { type: 'object' },
  },
];

/** A host that pairs and sends the catalog. */
async function host(b: BridgeServer, origin = 'http://localhost:5173') {
  const h = await socket(`ws://127.0.0.1:${b.port}/host`, { origin });
  h.send({ type: 'host_hello', protocol: 1, app: 'mochi-maker', version: '0.0.0' });
  expect((await h.next()).type).toBe('pair_required');
  h.send({ type: 'pair', code: b.pairingCode });
  const paired = await h.next();
  expect(paired.type).toBe('paired');
  const welcome = await h.next();
  expect(welcome).toMatchObject({ type: 'host_welcome', protocol: 1, bridge: { port: b.port } });
  h.send({ type: 'catalog', commands: CATALOG, events: ['revision'] });
  return { ...h, hostToken: paired.hostToken as string };
}

async function token(h: Awaited<ReturnType<typeof host>>, scopes: string[], name = 'agent') {
  h.send({ type: 'token_create', requestId: 'r1', name, scopes });
  let m = await h.next();
  while (m.type !== 'token_created') m = await h.next();
  return m as { token: string; info: { id: string; scopes: string[] } };
}

/** Answers the next command the host receives. */
async function answer(h: Awaited<ReturnType<typeof host>>, reply: (cmd: Msg) => Msg) {
  let m = await h.next();
  while (m.type !== 'command') m = await h.next();
  h.send({ type: 'result', id: m.id, ...reply(m) });
  return m;
}

describe('the bridge', () => {
  it('answers GET / and refuses foreign origins, hosts and paths', async () => {
    const b = await bridge();
    const info = await new Promise<Msg>((resolve) =>
      request({ host: '127.0.0.1', port: b.port, path: '/' }, (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => resolve(JSON.parse(s) as Msg));
      }).end(),
    );
    expect(info).toEqual({
      app: 'mochi-maker',
      version: '0.0.0',
      protocol: 1,
      studio: { connected: false },
      endpoints: { host: '/host', api: '/api' },
    });
    const url = `ws://127.0.0.1:${b.port}`;
    await expect(socket(`${url}/host`, { origin: 'https://evil.example' })).rejects.toThrow('403');
    await expect(socket(`${url}/host`)).rejects.toThrow('403'); // the host needs an origin
    await expect(socket(`${url}/api`, { origin: 'https://evil.example' })).rejects.toThrow('403');
    await expect(socket(`${url}/api`, { host: 'example.com' })).rejects.toThrow('403');
    await expect(socket(`${url}/other`)).rejects.toThrow('404');
    // Allowed: programs without an origin on /api, the editor's local origin on /host.
    await socket(`${url}/api`);
    await socket(`${url}/host`, { origin: 'http://127.0.0.1:4173' });
    const allowed = await bridge({ allowOrigins: ['app://mochi-maker'] });
    await socket(`ws://127.0.0.1:${allowed.port}/host`, { origin: 'app://mochi-maker' });
  });

  it('closes a connection that sends a message past MAX_MESSAGE, on hosts and clients', async () => {
    const b = await bridge();
    const url = `ws://127.0.0.1:${b.port}`;
    for (const [path, headers] of [
      ['/api', {}],
      ['/host', { origin: 'http://localhost:5173' }],
    ] as const) {
      const s = await socket(`${url}${path}`, headers);
      s.ws.send(Buffer.alloc(MAX_MESSAGE + 1, 0x20));
      expect(await s.closed).toBe(1009); // the WebSocket code for a message too big
    }
  });

  it('pairs a host once, then welcomes it by its token; a newer host replaces the older', async () => {
    const codes: string[] = [];
    const b = await bridge({ onPairingCode: (c) => codes.push(c) });
    expect(b.pairingCode).toMatch(/^\d{6}$/);
    const h1 = await host(b);
    expect(h1.hostToken).toMatch(/^mmh_/);
    expect(codes.length).toBe(2); // used codes are replaced
    expect(b.hostConnected).toBe(true);
    const h2 = await socket(`ws://127.0.0.1:${b.port}/host`, { origin: 'http://localhost' });
    h2.send({
      type: 'host_hello',
      protocol: 1,
      app: 'mochi-maker',
      version: '0',
      hostToken: h1.hostToken,
    });
    expect((await h2.next()).type).toBe('host_welcome');
    expect(await h1.closed).toBe(4000);
  });

  it('refuses wrong pairing codes, and makes a new code after five', async () => {
    const b = await bridge();
    const h = await socket(`ws://127.0.0.1:${b.port}/host`, { origin: 'http://localhost' });
    h.send({ type: 'host_hello', protocol: 1, app: 'mochi-maker', version: '0' });
    await h.next();
    const first = b.pairingCode;
    const wrong = first === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) {
      h.send({ type: 'pair', code: wrong });
      expect((await h.next()).type).toBe('pair_failed');
    }
    expect(b.pairingCode).not.toBe(first);
    // Without pairing, nothing else is accepted.
    h.send({ type: 'token_list', requestId: 'x' });
    expect(await h.next()).toMatchObject({ type: 'error', error: { code: 'unauthorized' } });
  });

  it('keeps only token hashes, in a file only its owner can read', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'state.json');
    const b = await bridge({ stateFile: file });
    const h = await host(b);
    const t = await token(h, ['edit'], 'writer');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(t.token);
    expect(text).not.toContain(h.hostToken);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A new bridge with the same state knows the host and the token.
    await b.close();
    servers.length = 0;
    const b2 = await bridge({ stateFile: file });
    const h2 = await socket(`ws://127.0.0.1:${b2.port}/host`, { origin: 'http://localhost' });
    h2.send({
      type: 'host_hello',
      protocol: 1,
      app: 'mochi-maker',
      version: '0',
      hostToken: h.hostToken,
    });
    expect((await h2.next()).type).toBe('host_welcome');
    const c = await BridgeClient.connect({
      url: `ws://127.0.0.1:${b2.port}`,
      token: t.token,
      name: 'w',
    });
    expect(c.welcome.scopes).toEqual(['read', 'edit']);
    c.close();
  });

  it('welcomes clients by token, routes commands, checks scopes, and forwards events', async () => {
    const b = await bridge();
    const h = await host(b);
    const reader = await token(h, ['read'], 'reader');
    expect(reader.info.scopes).toEqual(['read']);
    const c = await BridgeClient.connect({
      url: `ws://127.0.0.1:${b.port}`,
      token: reader.token,
      name: 'Reader',
    });
    expect(c.welcome).toMatchObject({
      name: 'Reader',
      scopes: ['read'],
      studio: { connected: true },
      events: ['revision'],
    });
    expect(c.welcome.commands.map((x) => x.name)).toEqual(['status', 'run', 'export']);
    // The host learns who is connected.
    let m = await h.next();
    while (m.type !== 'clients') m = await h.next();
    expect(m.clients).toMatchObject([{ name: 'Reader', scopes: ['read'] }]);

    const status = c.command('status', { verbose: true });
    const cmd = await answer(h, () => ({ ok: true, result: { revision: 3 } }));
    expect(cmd).toMatchObject({
      name: 'status',
      args: { verbose: true },
      client: { name: 'Reader', scopes: ['read'] },
    });
    expect(await status).toEqual({ revision: 3 });

    // Host errors pass through, with Mochi Maker's extra fields.
    const failing = c.command('status');
    await answer(h, () => ({
      ok: false,
      error: { code: 'invalid_arguments', message: 'bad', mochiCode: 'E_SCHEMA' },
    }));
    await expect(failing).rejects.toMatchObject({
      error: { code: 'invalid_arguments', mochiCode: 'E_SCHEMA' },
    });

    await expect(c.command('run', {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(c.command('nope', {})).rejects.toMatchObject({ code: 'unknown_command' });
    await expect(
      c.command('status', [] as unknown as Record<string, unknown>),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });

    // Events reach subscribers, by name or prefix.
    const seen: string[] = [];
    expect(await c.subscribe(['rev*'], (e) => seen.push(e.name))).toEqual(['rev*']);
    h.send({ type: 'event', name: 'revision', data: { revision: 4 } });
    h.send({ type: 'event', name: 'pose', data: {} });
    h.send({ type: 'event', name: 'revision', data: { revision: 5 } });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual(['revision', 'revision']);
    c.close();
  });

  it('refuses unknown tokens, missing hellos and other protocol versions', async () => {
    const b = await bridge();
    await expect(
      BridgeClient.connect({ url: `ws://127.0.0.1:${b.port}`, token: 'mmt_nope', name: 'x' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const s = await socket(`ws://127.0.0.1:${b.port}/api`);
    s.send({ type: 'command', id: 1, name: 'status' });
    expect(await s.next()).toMatchObject({ type: 'error', error: { code: 'unauthorized' } });
    expect(await s.closed).toBe(4401);
    const p = await socket(`ws://127.0.0.1:${b.port}/api`);
    p.send({ type: 'hello', protocol: 2, token: 'x', client: { name: 'x' } });
    expect(await p.next()).toMatchObject({ type: 'error', error: { code: 'protocol' } });
    const junk = await socket(`ws://127.0.0.1:${b.port}/api`);
    junk.ws.send('not json');
    expect(await junk.next()).toMatchObject({ type: 'error', error: { code: 'invalid_message' } });
  });

  it('closes a revoked token’s clients, and says when the editor is gone', async () => {
    const b = await bridge();
    const h = await host(b);
    const t = await token(h, ['export']);
    expect(t.info.scopes).toEqual(['read', 'edit', 'export']);
    const c = await BridgeClient.connect({
      url: `ws://127.0.0.1:${b.port}`,
      token: t.token,
      name: 'a',
    });
    const studio: boolean[] = [];
    c.onStudio((x) => studio.push(x));
    h.send({ type: 'token_list', requestId: 'l' });
    let m = await h.next();
    while (m.type !== 'tokens') m = await h.next();
    expect((m.tokens as { id: string; lastUsed: number | null }[])[0]).toMatchObject({
      id: t.info.id,
    });
    expect((m.tokens as { lastUsed: number | null }[])[0]!.lastUsed).not.toBeNull();

    // A pending command fails when the editor leaves.
    const pending = c.command('status');
    await new Promise((r) => setTimeout(r, 50));
    h.ws.close();
    await expect(pending).rejects.toMatchObject({ code: 'studio_not_connected' });
    await expect(c.command('status')).rejects.toMatchObject({ code: 'studio_not_connected' });
    expect(studio).toEqual([false]);

    // Revoking closes the client with 4401.
    const h2 = await socket(`ws://127.0.0.1:${b.port}/host`, { origin: 'http://localhost' });
    h2.send({
      type: 'host_hello',
      protocol: 1,
      app: 'mochi-maker',
      version: '0',
      hostToken: h.hostToken,
    });
    await h2.next();
    h2.send({ type: 'token_revoke', requestId: 'v', id: t.info.id });
    let r = await h2.next();
    while (r.type !== 'token_revoked') r = await h2.next();
    await new Promise((x) => setTimeout(x, 100));
    expect(c.connected).toBe(false);
    await expect(
      BridgeClient.connect({ url: `ws://127.0.0.1:${b.port}`, token: t.token, name: 'a' }),
    ).rejects.toBeInstanceOf(BridgeCallError);
  });

  it('limits a client to 30 commands a second, and times out silent editors', async () => {
    let clock = 1_000_000;
    const b = await bridge({ now: () => clock, commandTimeoutMs: 200 });
    const h = await host(b);
    const t = await token(h, ['read']);
    const c = await BridgeClient.connect({
      url: `ws://127.0.0.1:${b.port}`,
      token: t.token,
      name: 'a',
    });
    const calls = Array.from({ length: 31 }, () =>
      c.command('status').catch((e: BridgeCallError) => e.code),
    );
    const codes = await Promise.all(calls);
    expect(codes.filter((x) => x === 'rate_limited').length).toBe(1);
    expect(codes.filter((x) => x === 'timeout').length).toBe(30);
    // The host answers the 30 timed-out commands late; those answers are dropped.
    for (let i = 0; i < 30; i++) await answer(h, () => ({ ok: true, result: 'late' }));
    clock += 2000;
    const later = c.command('status');
    await answer(h, () => ({ ok: true, result: 1 }));
    expect(await later).toBe(1);
  });
});
