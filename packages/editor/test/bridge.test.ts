/**
 * The live bridge end to end (item 6): a real bridge in the test process, the editor in
 * headless Chromium as its host, a WebSocket client, and the MCP server in bridge mode. Skipped
 * where Chromium is missing, except in CI's render job (MOCHI_MAKER_REQUIRE_RENDER=1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient, BridgeServer, type BridgeEvent } from '@mochi-maker/bridge';
import { MochiMcpServer } from '@mochi-maker/mcp';
import { decodePng, encodePng } from '@mochi-maker/art';
import { buildEditor, launch, openGolden, serve, type Browser, type Page } from './harness.js';

const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';
const available = await launch().then(async (b) => {
  await b?.close();
  return b !== null;
});

let browser: Browser | null = null;
let server: Server | undefined;
let bridge: BridgeServer;
let url = '';
let page: Page;
let bridgeUrl = '';

beforeAll(async () => {
  if (!available) {
    if (required)
      throw new Error('Chromium is required (MOCHI_MAKER_REQUIRE_RENDER=1) but missing.');
    return;
  }
  browser = await launch();
  const s = await serve(await buildEditor());
  server = s.server;
  url = s.url;
  bridge = new BridgeServer({ port: 0 });
  bridgeUrl = `ws://127.0.0.1:${await bridge.listen()}`;
  page = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${url}?nohome`);
  await page.waitForFunction(() => window.mochi !== undefined);
  await openGolden(page, 'golden-1-keyforms');
  await page.evaluate(() => window.mochi.settled());
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  await bridge?.close();
});

/** expect.poll with room for CI's software-rendered pages. */
const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 15_000 });
const settled = () => page.evaluate(() => window.mochi.settled());
const history = () => page.evaluate(() => window.mochi.history());

/** Opens Agent access (closing it first if a step left it open). */
async function openAccess(): Promise<void> {
  await closeAccess();
  await page.getByTestId('access-open').click();
  await poll(() => page.getByTestId('agent-access').isVisible()).toBe(true);
}

async function closeAccess(): Promise<void> {
  await page.evaluate(() => window.mochiEditor.access.close());
  await poll(() => page.getByTestId('agent-access').isVisible()).toBe(false);
}

async function createToken(name: string, scope: 'read' | 'edit' | 'export'): Promise<string> {
  await openAccess();
  await page.getByTestId('token-name').fill(name);
  await page.getByTestId('token-scope').selectOption(scope);
  await page.getByTestId('token-create').click();
  await poll(() => page.getByTestId('agent-access').innerText()).toContain(`Token for ${name}`);
  const token = await page.getByTestId('token-value').inputValue();
  await closeAccess();
  return token;
}

describe.skipIf(!required && !available)('the live bridge', () => {
  it('pairs the editor as the host, off until the person connects', async () => {
    expect(bridge.hostConnected).toBe(false);
    await openAccess();
    await poll(() => page.getByTestId('bridge-state').textContent()).toContain('Not connected');
    await page.getByTestId('bridge-url').fill(bridgeUrl);
    await page.getByTestId('bridge-connect').click();
    await page.getByTestId('pairing-code').fill(bridge.pairingCode);
    await page.getByTestId('pair').click();
    await poll(() => page.getByTestId('bridge-state').textContent()).toContain('Connected');
    expect(bridge.hostConnected).toBe(true);
    await closeAccess();
  }, 60_000);

  it('runs a client’s commands in the editor, attributed to it; the person sees and undoes them', async () => {
    const token = await createToken('tester', 'edit');
    const c = await BridgeClient.connect({ url: bridgeUrl, token, name: 'tester' });
    expect(c.welcome.scopes).toEqual(['read', 'edit']);
    const names = c.welcome.commands.map((x) => x.name);
    for (const n of ['status', 'run', 'render', 'evaluate', 'param.create', 'mesh.moveVertices'])
      expect(names).toContain(n);
    expect(names).not.toContain('art.import'); // file paths do not cross the bridge
    expect(c.welcome.commands.find((x) => x.name === 'export')!.scope).toBe('export');
    // The person sees who is connected.
    await poll(() => page.getByTestId('agent-band').textContent()).toContain('tester (read, edit)');

    const events: BridgeEvent[] = [];
    await c.subscribe(['revision', 'control'], (e) => events.push(e));
    const before = await c.command<{ revision: number }>('status');
    const r = await c.command<{ committed: boolean; revision: number; results: { uid: string }[] }>(
      'run',
      {
        label: 'Agent adds a parameter',
        commands: [
          {
            name: 'param.create',
            args: { exportId: 'ParamAgent', min: 0, max: 1, default: 0, keys: [0, 1] },
          },
        ],
      },
    );
    expect(r.committed).toBe(true);
    expect(r.revision).toBe(before.revision + 1);
    await settled();
    expect((await history()).at(-1)).toEqual({
      label: 'Agent adds a parameter',
      author: 'agent:tester',
    });
    expect(await page.locator('[data-param="ParamAgent"]').count()).toBe(1);
    await poll(() => events.find((e) => e.name === 'revision')?.data).toMatchObject({
      author: 'agent:tester',
      label: 'Agent adds a parameter',
    });
    // One command as its own transaction.
    await c.command('param.update', { target: '@param:ParamAgent', default: 1 });
    expect((await history()).at(-1)!.label).toBe('param.update');

    // Scopes: an edit token cannot export; the bridge refuses before the editor sees it.
    await expect(c.command('export', {})).rejects.toMatchObject({ code: 'forbidden' });
    // Command errors come back in the protocol's shape, with Mochi Maker's code.
    await expect(c.command('param.delete', { target: '@param:Nope' })).rejects.toMatchObject({
      error: { code: 'invalid_arguments', mochiCode: 'E_NOT_FOUND' },
    });
    await expect(
      c.command('run', {
        label: 'x',
        commands: [{ name: 'art.import', args: { path: '/etc/passwd' } }],
      }),
    ).rejects.toMatchObject({ error: { mochiCode: 'E_FORBIDDEN' } });

    // The person undoes the agent's changes.
    await page.getByTestId('undo').click();
    await page.getByTestId('undo').click();
    await settled();
    expect(await page.locator('[data-param="ParamAgent"]').count()).toBe(0);
    // The agents panel lists the calls.
    await page.locator('[data-tab="agents"]').click();
    await poll(() => page.locator('[data-bridge-call="run"]').count()).toBeGreaterThan(0);
    c.close();
  }, 60_000);

  it('keeps an agent’s transaction from colliding with a person’s drag (the control lease)', async () => {
    const token = await createToken('lease', 'edit');
    const c = await BridgeClient.connect({ url: bridgeUrl, token, name: 'lease' });
    const add = (exportId: string) =>
      c.command('run', {
        label: `add ${exportId}`,
        commands: [
          { name: 'param.create', args: { exportId, min: 0, max: 1, default: 0, keys: [0, 1] } },
        ],
      });
    // The person presses in the viewport (a gesture): agents' edits wait, reads work. (Pressed in
    // the middle: the agents' band covers the top of the viewport.)
    const box = (await page.getByTestId('overlay').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(add('ParamDuring')).rejects.toMatchObject({
      error: { code: 'control_held', mochiCode: 'E_CONTROL_HELD', details: { holder: 'person' } },
    });
    expect(await c.command<{ control: { holder: string } }>('status')).toMatchObject({
      control: { holder: 'person' },
    });
    // A dry run still works.
    await expect(
      c.command('run', {
        label: 'try',
        dryRun: true,
        commands: [
          { name: 'param.create', args: { exportId: 'ParamDry', min: 0, max: 1, keys: [0, 1] } },
        ],
      }),
    ).resolves.toMatchObject({ committed: false });
    await page.mouse.up();
    // Shortly after the gesture (1.5 s), the agent may edit again.
    await new Promise((r) => setTimeout(r, 1700));
    await expect(add('ParamAfter')).resolves.toMatchObject({ committed: true });

    // Pause agents from the band; resume.
    await page.getByTestId('pause-agents').click();
    await expect(add('ParamPaused')).rejects.toMatchObject({
      error: { code: 'control_held', details: { holder: 'paused' } },
    });
    await poll(() => page.getByTestId('band-lease').textContent()).toContain('paused');
    await page.getByTestId('pause-agents').click();
    await new Promise((r) => setTimeout(r, 1700)); // the click on the band counts as a person's action only for edits
    await expect(add('ParamResumed')).resolves.toMatchObject({ committed: true });
    c.close();
  }, 60_000);

  it('renders what the person sees, and poses off-screen without moving their view', async () => {
    const token = await createToken('viewer', 'read');
    const c = await BridgeClient.connect({ url: bridgeUrl, token, name: 'viewer' });
    const t0 = await page.evaluate(() => window.mochiEditor.viewport.view.viewTransform);
    const seen = await c.command<{ png: string; source: string }>('render', { source: 'editor' });
    const img = decodePng(new Uint8Array(Buffer.from(seen.png, 'base64')), 'seen');
    const canvas = await page.evaluate(() => {
      const c = window.mochiEditor.viewport.canvas;
      return [c.width, c.height];
    });
    expect([img.width, img.height]).toEqual(canvas);
    const posed = await c.command<{
      png: string;
      width: number;
      pixelsPerUnit: number;
      center: number[];
    }>('render', {
      parameters: { ParamA: 1 },
      width: 200,
      height: 120,
      around: '@mesh:ArtMesh_Square',
    });
    const p = decodePng(new Uint8Array(Buffer.from(posed.png, 'base64')), 'posed');
    expect([p.width, p.height]).toEqual([200, 120]);
    // The center pixel is the mesh (framed), and the person's view did not move.
    const mid = 4 * (60 * 200 + 100);
    expect(p.data[mid + 3]).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.mochiEditor.viewport.view.viewTransform)).toEqual(t0);
    const e = await c.command<{ drawables: { opacity: number }[] }>('evaluate', {
      parameters: { ParamA: 1 },
    });
    expect(e.drawables[0]!.opacity).toBeCloseTo(0.5, 5);
    await expect(c.command('run', { label: 'x', commands: [] })).rejects.toMatchObject({
      code: 'forbidden',
    });
    c.close();
  }, 60_000);

  it('runs the MCP server in bridge mode against the open editor', async () => {
    const token = await createToken('mcp', 'export');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-bridge-'));
    const mcp = new MochiMcpServer({
      allowDirs: [dir],
      author: 'agent:mcp',
      bridge: { url: bridgeUrl, token, name: 'mcp' },
    });
    await mcp.start();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await mcp.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }))!.result as {
        content: { type: string; text?: string; data?: string }[];
        structuredContent: Record<string, unknown>;
        isError?: boolean;
      };
      return r;
    };
    const status = await call('mochi_project', { action: 'status' });
    expect(status.structuredContent).toMatchObject({ mode: 'bridge', name: 'golden-1-keyforms' });
    expect(
      (await call('mochi_project', { action: 'open', path: dir })).structuredContent,
    ).toMatchObject({ error: { code: 'E_FORBIDDEN' } });

    const run = await call('mochi_run', {
      label: 'MCP fades the square',
      commands: [
        {
          name: 'keyform.set',
          args: {
            target: '@mesh:ArtMesh_Square',
            cell: { '@param:ParamA': 0 },
            values: { opacity: 0.75 },
          },
        },
      ],
      preview: { width: 128, height: 128 },
    });
    expect(run.isError).toBeUndefined();
    expect(run.structuredContent).toMatchObject({ committed: true });
    expect(run.content.some((x) => x.type === 'image')).toBe(true);
    await settled();
    expect((await history()).at(-1)).toEqual({
      label: 'MCP fades the square',
      author: 'agent:mcp',
    });
    const rev = run.structuredContent.revision as number;

    // A render without a pose is what the person sees.
    const seen = await call('mochi_render');
    expect(seen.content.filter((x) => x.type === 'image').length).toBe(1);
    expect(seen.structuredContent.notes).toContain(
      'what the person sees: their pose, zoom and pan',
    );
    const sweep = await call('mochi_sweep', {
      parameter: '@param:ParamA',
      steps: 3,
      width: 64,
      height: 64,
    });
    expect(sweep.structuredContent).toMatchObject({ values: [0, 0.5, 1], columns: 3 });
    const diff = await call('mochi_diff', { from: rev - 1, visual: true, width: 96, height: 96 });
    expect(diff.content.filter((x) => x.type === 'image').length).toBe(3);
    expect((diff.structuredContent.metrics as { changed: number }).changed).toBeGreaterThan(0);
    const ev = await call('mochi_evaluate', { parameters: { ParamA: 0 } });
    expect((ev.structuredContent.drawables as { opacity: number }[])[0]!.opacity).toBeCloseTo(
      0.75,
      5,
    );

    // Files stay on the agent's side, inside the allowed directories.
    const out = join(dir, 'export');
    const report = await call('mochi_export', { out });
    expect(report.isError).toBeUndefined();
    expect(existsSync(join(out, 'golden1.moc3'))).toBe(true);
    expect((await call('mochi_export', { out: '/tmp/elsewhere' })).structuredContent).toMatchObject(
      { error: { code: 'E_FORBIDDEN' } },
    );
    // Images of a motion, rendered by the editor and written here.
    await call('mochi_run', {
      label: 'A motion',
      commands: [{ name: 'motion.create', args: { name: 'wave', duration: 1, fps: 5 } }],
    });
    const frames = join(dir, 'frames');
    const movie = await call('mochi_export_movie', {
      out: frames,
      motion: '@motion~wave',
      width: 32,
      height: 32,
    });
    expect(movie.isError, JSON.stringify(movie.structuredContent)).toBeUndefined();
    expect(movie.structuredContent).toMatchObject({ format: 'png', frames: 6, width: 32 });
    expect(existsSync(join(frames, 'wave_0005.png'))).toBe(true);
    expect(
      (await call('mochi_export_movie', { out: '/tmp/elsewhere', motion: '@motion~wave' }))
        .structuredContent,
    ).toMatchObject({ error: { code: 'E_FORBIDDEN' } });
    const art = join(dir, 'badge.png');
    const px = new Uint8Array(16 * 16 * 4).fill(255);
    writeFileSync(art, encodePng({ width: 16, height: 16, data: px }));
    const imported = await call('mochi_import_art', { path: art, options: { setCanvas: 'never' } });
    expect(imported.isError, JSON.stringify(imported.structuredContent)).toBeUndefined();
    await settled();
    expect((await history()).at(-1)).toMatchObject({ author: 'agent:mcp' });
    expect(await page.evaluate(() => window.mochi.query({ kind: 'layer' }).total)).toBeGreaterThan(
      1,
    );
    // The art changes: re-import it through the bridge (the editor matches what it imported).
    const grown = new Uint8Array(24 * 16 * 4).fill(200);
    writeFileSync(art, encodePng({ width: 24, height: 16, data: grown }));
    const re = await call('mochi_reimport_art', { path: art });
    expect(re.isError, JSON.stringify(re.structuredContent)).toBeUndefined();
    const reimported = (re.structuredContent.itemResults as { changed: { name: string }[] }[])[0]!;
    expect(reimported.changed.map((c) => c.name)).toEqual(['badge']);
    await settled();
    expect((await history()).at(-1)).toEqual({ label: 'Re-import badge.png', author: 'agent:mcp' });

    // Resources follow the editor's revisions.
    const notes: string[] = [];
    mcp.onNotify((method, params) => notes.push(`${method} ${String(params.uri)}`));
    await mcp.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/subscribe',
      params: { uri: 'mochi://project' },
    });
    await page.getByTestId('undo').click();
    await poll(() => notes).toContain('notifications/resources/updated mochi://project');
    await mcp.close();

    // A read token narrows the MCP session.
    const readToken = await createToken('mcp-read', 'read');
    const ro = new MochiMcpServer({
      allowDirs: [dir],
      bridge: { url: bridgeUrl, token: readToken },
    });
    await ro.start();
    const refused = (await ro.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'mochi_run', arguments: { label: 'x', commands: [] } },
    }))!.result as { structuredContent: { error: { category: string } } };
    expect(refused.structuredContent.error.category).toBe('forbidden');
    await ro.close();
  }, 120_000);

  it('disconnects a revoked token’s agent', async () => {
    const token = await createToken('doomed', 'read');
    const c = await BridgeClient.connect({ url: bridgeUrl, token, name: 'doomed' });
    await openAccess();
    await page.getByTestId('revoke-doomed').click();
    await poll(() => c.connected).toBe(false);
    await closeAccess();
    // And the person can disconnect the editor: agents then get studio_not_connected.
    const t2 = await createToken('after', 'read');
    const c2 = await BridgeClient.connect({ url: bridgeUrl, token: t2, name: 'after' });
    await openAccess();
    await page.getByTestId('bridge-disconnect').click();
    await expect(c2.command('status')).rejects.toMatchObject({ code: 'studio_not_connected' });
    c2.close();
  }, 60_000);
});
