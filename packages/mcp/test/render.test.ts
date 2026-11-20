/**
 * MCP rendering tools: images as MCP image content. Needs headless Chromium; skipped where it is
 * missing, except in CI's render job (MOCHI_MAKER_REQUIRE_RENDER=1).
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '@mochi-maker/art';
import { MochiMcpServer } from '@mochi-maker/mcp';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let root: string;
let server: MochiMcpServer;
let id = 0;
const tool = async (name: string, args: Json = {}) =>
  (
    (await server.handle({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name, arguments: args },
    })) as Json
  ).result as Json;
const images = (r: Json) =>
  (r.content as Json[])
    .filter((c) => c.type === 'image')
    .map((c) => decodePng(Buffer.from(c.data, 'base64'), 'image'));

let canRender = false;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mochi-mcp-render-'));
  await cp(
    join(import.meta.dirname, '../../export/test/golden/golden-1-keyforms.mochi'),
    join(root, 'g1.mochi'),
    {
      recursive: true,
    },
  );
  server = new MochiMcpServer({ allowDirs: [root] });
  await tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') });
  const probe = await tool('mochi_render', { width: 16, height: 16 });
  canRender = !probe.isError;
  if (!canRender) expect(probe.structuredContent.error.code).toBe('E_RENDER_UNAVAILABLE');
});
afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});
const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';

describe('MCP rendering', () => {
  it('renders, sweeps, diffs visually and previews runs', async ({ skip }) => {
    if (!canRender && !required) skip();
    expect(canRender, 'rendering needs Playwright and Chromium').toBe(true);
    const r = await tool('mochi_render', { width: 120, height: 90, parameters: { ParamA: 1 } });
    expect(r.isError).toBeUndefined();
    expect(images(r).map((i) => [i.width, i.height])).toEqual([[120, 90]]);
    expect(r.structuredContent).toMatchObject({
      revision: 0,
      reference: false,
      parameters: { ParamA: 1 },
    });
    // Sizes are capped at 1024.
    const big = await tool('mochi_render', { width: 5000, height: 20 });
    expect(images(big)[0]!.width).toBe(1024);

    const sheet = await tool('mochi_sweep', {
      parameter: '@param:ParamA',
      steps: 4,
      width: 32,
      height: 32,
    });
    expect(sheet.structuredContent.values).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(images(sheet)).toHaveLength(1);
    const frames = await tool('mochi_sweep', {
      parameter: '@param:ParamA',
      values: [0, 1],
      as: 'frames',
      width: 32,
      height: 32,
    });
    expect(images(frames)).toHaveLength(2);
    expect(
      (await tool('mochi_sweep', { parameter: '@param:ParamA', steps: 40 })).structuredContent.error
        .code,
    ).toBe('E_RANGE');

    const run = await tool('mochi_run', {
      label: 'Move',
      commands: [
        {
          name: 'mesh.moveVertices',
          args: { target: '@mesh:ArtMesh_Square', all: true, offset: [40, 0] },
        },
      ],
      preview: { width: 80, height: 60 },
    });
    expect(run.structuredContent.committed).toBe(true);
    expect(images(run)).toHaveLength(1);
    const diff = await tool('mochi_diff', { from: 0, visual: true, width: 80, height: 60 });
    expect(diff.structuredContent.changed).toHaveLength(1);
    expect(diff.structuredContent.metrics.changed).toBeGreaterThan(0.01);
    expect(images(diff)).toHaveLength(3);
  });
});
