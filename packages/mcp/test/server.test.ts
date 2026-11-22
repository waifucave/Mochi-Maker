/** The MCP server (agent API design 3): tools, safety, errors, resources, prompts, stdio. */
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MochiMcpServer, MAX_CALLS_PER_SECOND, serveStdio } from '@mochi-maker/mcp';
import { syntheticPsd } from '../../art/test/synthetic.js';

let root: string;
let outside: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mochi-mcp-'));
  outside = await mkdtemp(join(tmpdir(), 'mochi-mcp-outside-'));
  await cp(
    join(import.meta.dirname, '../../export/test/golden/golden-1-keyforms.mochi'),
    join(root, 'g1.mochi'),
    { recursive: true },
  );
  await writeFile(join(root, 'art.psd'), syntheticPsd());
  await writeFile(join(outside, 'art.psd'), syntheticPsd());
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function client(options: { now?: () => number; scope?: 'read' | 'edit' | 'export' } = {}) {
  const server = new MochiMcpServer({ allowDirs: [root], author: 'agent:test', ...options });
  const notes: Json[] = [];
  server.onNotify((method, params) => notes.push({ method, params }));
  let id = 0;
  const rpc = async (method: string, params: Json = {}) =>
    (await server.handle({ jsonrpc: '2.0', id: ++id, method, params })) as Json;
  const tool = async (name: string, args: Json = {}) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result as Json;
    return {
      error: r.isError ? r.structuredContent.error : undefined,
      data: r.structuredContent,
      raw: r,
    };
  };
  return { server, rpc, tool, notes };
}

describe('MCP server', () => {
  it('initializes and lists the tools that need neither rendering nor introspection', async () => {
    const { rpc } = client();
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
      .result;
    expect(init.protocolVersion).toBe('2025-06-18');
    expect(init.capabilities.resources.subscribe).toBe(true);
    expect(init.serverInfo.name).toBe('mochi-maker');
    const old = (await rpc('initialize', { protocolVersion: '1999-01-01' })).result;
    expect(old.protocolVersion).toBe('2025-06-18');
    const tools = (await rpc('tools/list')).result.tools as Json[];
    expect(tools.map((t) => t.name)).toEqual([
      'mochi_project',
      'mochi_describe',
      'mochi_query',
      'mochi_run',
      'mochi_undo',
      'mochi_redo',
      'mochi_history',
      'mochi_diff',
      'mochi_render',
      'mochi_sweep',
      'mochi_evaluate',
      'mochi_validate',
      'mochi_import_art',
      'mochi_reimport_art',
      'mochi_export',
      'mochi_export_movie',
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
    expect((await rpc('nope/method')).error.code).toBe(-32601);
  });

  it('creates a project, runs, dry-runs, undoes, diffs, imports art, saves and exports', async () => {
    const { tool } = client();
    expect((await tool('mochi_query', { kind: 'parameter' })).error).toMatchObject({
      category: 'no_project',
      code: 'E_NO_PROJECT',
    });
    const path = join(root, 'new.mochi');
    const created = await tool('mochi_project', {
      action: 'new',
      path,
      canvas: { width: 512, height: 512 },
    });
    expect(created.data).toMatchObject({ open: true, revision: 0, dirty: false });

    const run = await tool('mochi_run', {
      label: 'Params',
      commands: [
        { name: 'param.create', args: { exportId: 'ParamA', min: 0, max: 1, default: 0 } },
        { name: 'part.create', args: { exportId: 'PartA' } },
      ],
    });
    expect(run.data).toMatchObject({ committed: true, revision: 1 });
    expect(run.data.diff.added.map((x: Json) => x.kind).sort()).toEqual(['parameter', 'part']);

    const dry = await tool('mochi_run', {
      label: 'Try',
      dryRun: true,
      commands: [{ name: 'part.create', args: { exportId: 'PartB' } }],
    });
    expect(dry.data.committed).toBe(false);
    expect((await tool('mochi_query', { kind: 'part' })).data.total).toBe(1);

    const stale = await tool('mochi_run', {
      label: 'Stale',
      expectRevision: 0,
      commands: [{ name: 'part.create', args: {} }],
    });
    expect(stale.error).toMatchObject({ category: 'failed', code: 'E_REVISION_MISMATCH' });

    const bad = await tool('mochi_run', {
      label: 'Bad',
      commands: [
        {
          name: 'rig.addBinding',
          args: { target: '@part:PartA', parameter: '@param:ParamA', keys: [0.5] },
        },
      ],
    });
    expect(bad.error).toMatchObject({
      code: 'E_KEY_NOT_ON_PARAMETER',
      command: 'rig.addBinding',
      at: 0,
    });
    expect(bad.error.fixes.length).toBeGreaterThan(0);

    const imported = await tool('mochi_import_art', { path: join(root, 'art.psd') });
    expect(imported.error).toBeUndefined();
    expect(imported.data.committed).toBe(true);
    const undo = await tool('mochi_undo');
    expect(undo.data.diff.removed.length).toBeGreaterThan(0);
    await tool('mochi_redo');
    expect((await tool('mochi_history')).data.history.map((h: Json) => h.author)).toEqual([
      'agent:test',
      'agent:test',
    ]);
    expect((await tool('mochi_diff', { from: 0 })).data.added.length).toBeGreaterThan(2);

    const motion = await tool('mochi_run', {
      label: 'Wave',
      commands: [
        { name: 'motion.create', args: { name: 'wave', group: 'TapBody', duration: 1, fps: 30 } },
        {
          name: 'motion.setCurve',
          args: {
            target: '$0',
            curve: {
              target: 'parameter',
              object: '@param:ParamA',
              segments: [0, 0, 1, 0.25, 1, 0.75, 1, 1, 0],
            },
          },
        },
        { name: 'motion.reorder', args: { target: '$0', index: 0 } },
      ],
    });
    expect(motion.error).toBeUndefined();
    const validate = await tool('mochi_validate', { targetVersion: 'auto' });
    expect(validate.data.violations).toEqual([]);
    expect(validate.data.export).toMatchObject({ ok: true, mocVersion: 5 });
    const saved = await tool('mochi_project', { action: 'save' });
    expect(saved.data.dirty).toBe(false);
    const out = join(root, 'export');
    const exp = await tool('mochi_export', { out });
    expect(exp.data.mocVersion).toBe(5);
    expect(exp.data.files.map((f: Json) => f.path)).toContain('motions/wave.motion3.json');
    expect(
      JSON.parse(await readFile(join(out, 'mochi-export.json'), 'utf8')).files.length,
    ).toBeGreaterThan(2);
  });

  it('authors expressions and the pose with commands, and validates and exports them', async () => {
    const { tool } = client();
    await tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') });
    const described = await tool('mochi_describe', { search: 'expression' });
    expect(JSON.stringify(described.data)).toContain('expression.create');
    const run = await tool('mochi_run', {
      label: 'Expressions and pose',
      commands: [
        { name: 'part.create', args: { exportId: 'PartX' } },
        { name: 'part.create', args: { exportId: 'PartY' } },
        {
          name: 'expression.create',
          args: {
            name: 'wide',
            entries: [{ parameter: '@param:ParamA', value: 1, blend: 'Overwrite' }],
          },
        },
        {
          name: 'pose.setGroups',
          args: { fadeIn: 0.3, groups: [[{ part: '@part:PartX' }, { part: '@part:PartY' }]] },
        },
      ],
    });
    expect(run.data).toMatchObject({ committed: true });
    const v = await tool('mochi_validate', { targetVersion: 'auto' });
    expect(JSON.stringify(v.data)).not.toContain('pose-small-group');
    const out = join(root, 'g1-out');
    const exp = await tool('mochi_export', { out });
    expect(exp.error).toBeUndefined();
    const files = await import('node:fs/promises').then((f) => f.readdir(out, { recursive: true }));
    expect(files.some((f) => String(f).endsWith('wide.exp3.json'))).toBe(true);
    expect(files.some((f) => String(f).endsWith('.pose3.json'))).toBe(true);
  });

  it('edits motion keys with commands: insert, move, interpolate, delete', async () => {
    const { tool } = client();
    await tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') });
    const described = await tool('mochi_describe', { search: 'motion.insertKey' });
    expect(JSON.stringify(described.data)).toContain('motion.insertKey');
    const curve = { target: 'parameter', object: '@param:ParamA' };
    const run = await tool('mochi_run', {
      label: 'Keys',
      commands: [
        { name: 'motion.create', args: { name: 'nod', duration: 2, fps: 30 } },
        { name: 'motion.insertKey', args: { target: '$0', curve, time: 0, value: 0 } },
        { name: 'motion.insertKey', args: { target: '$0', curve, time: 1, value: 1 } },
        { name: 'motion.insertKey', args: { target: '$0', curve, time: 2, value: 0 } },
        { name: 'motion.moveKeys', args: { target: '$0', curve, times: [1], dt: 0.5 } },
        {
          name: 'motion.setInterpolation',
          args: { target: '$0', curve, times: [1.5], interp: 'step' },
        },
        { name: 'motion.deleteKeys', args: { target: '$0', curve, times: [2] } },
      ],
    });
    expect(run.error).toBeUndefined();
    expect(run.data).toMatchObject({ committed: true });
    const m = await tool('mochi_query', { ref: '@motion~nod' });
    expect(m.data.curves[0]).toMatchObject({
      segments: [0, 0, 1, 0.5, 0, 1, 1, 1.5, 1],
      auto: [0],
    });
    const bad = await tool('mochi_run', {
      label: 'x',
      commands: [{ name: 'motion.deleteKeys', args: { target: '@motion~nod', curve, times: [9] } }],
    });
    expect(bad.error.code).toBe('E_RANGE');
  });

  it('makes and applies animation templates with commands', async () => {
    const { tool } = client();
    await tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') });
    const described = await tool('mochi_describe', { search: 'template' });
    for (const n of ['template.create', 'template.apply', 'template.add', 'template.delete'])
      expect(JSON.stringify(described.data)).toContain(n);
    const curve = { target: 'parameter', object: '@param:ParamA' };
    const run = await tool('mochi_run', {
      label: 'Templates',
      commands: [
        { name: 'motion.create', args: { name: 'a', duration: 2, fps: 30 } },
        { name: 'motion.create', args: { name: 'b', duration: 2, fps: 30 } },
        {
          name: 'motion.setKeys',
          args: {
            target: '$0',
            curve,
            keys: [
              { time: 0.5, value: 0 },
              { time: 0.75, value: 1 },
              { time: 1, value: 0 },
            ],
          },
        },
        { name: 'template.create', args: { name: 'Pulse', motion: '$0', from: 0.5, to: 1 } },
        { name: 'template.apply', args: { name: 'Pulse', target: '$1', time: 1.5 } },
      ],
    });
    expect(run.error).toBeUndefined();
    expect(run.data.results.at(-1)).toEqual({ parameters: ['ParamA'], unmatched: [] });
    const b = await tool('mochi_query', { ref: '@motion~b' });
    expect(
      b.data.curves[0].segments.filter((_: number, i: number) => i === 0 || i === 3 || i === 6),
    ).toEqual([1.5, 1.75, 2]);
    const project = await tool('mochi_query', { ref: 'project' });
    expect(project.data.animationTemplates.map((t: Json) => t.name)).toEqual(['Pulse']);
    const missing = await tool('mochi_run', {
      label: 'x',
      commands: [{ name: 'template.apply', args: { name: 'Nope', target: '@motion~b', time: 0 } }],
    });
    expect(missing.error.code).toBe('E_NOT_FOUND');
  });

  it('imports a physics file, and copies and pastes objects', async () => {
    const { tool } = client();
    await tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') });
    const physics = {
      Version: 3,
      Meta: {
        PhysicsSettingCount: 1,
        TotalInputCount: 1,
        TotalOutputCount: 2,
        VertexCount: 2,
        EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
        PhysicsDictionary: [{ Id: 'PhysicsSetting1', Name: 'Sway' }],
      },
      PhysicsSettings: [
        {
          Id: 'PhysicsSetting1',
          Input: [
            {
              Source: { Target: 'Parameter', Id: 'ParamA' },
              Weight: 100,
              Type: 'X',
              Reflect: false,
            },
          ],
          Output: [
            {
              Destination: { Target: 'Parameter', Id: 'ParamA' },
              VertexIndex: 1,
              Scale: 1,
              Weight: 100,
              Type: 'Angle',
              Reflect: false,
            },
            {
              Destination: { Target: 'Parameter', Id: 'ParamHair' },
              VertexIndex: 1,
              Scale: 1,
              Weight: 100,
              Type: 'Angle',
              Reflect: false,
            },
          ],
          Vertices: [
            { Position: { X: 0, Y: 0 }, Mobility: 1, Delay: 1, Acceleration: 1, Radius: 0 },
            { Position: { X: 0, Y: 10 }, Mobility: 0.9, Delay: 0.9, Acceleration: 1, Radius: 10 },
          ],
          Normalization: {
            Position: { Minimum: -10, Default: 0, Maximum: 10 },
            Angle: { Minimum: -10, Default: 0, Maximum: 10 },
          },
        },
      ],
    };
    const imp = await tool('mochi_run', {
      label: 'Physics',
      commands: [{ name: 'physics.import', args: { text: JSON.stringify(physics) } }],
    });
    expect(imp.error).toBeUndefined();
    expect(imp.data.itemResults[0]).toMatchObject({
      added: ['Sway'],
      unmatched: [{ setting: 'Sway', kind: 'output', parameter: 'ParamHair' }],
    });
    const copy = await tool('mochi_run', {
      label: 'Copy',
      dryRun: true,
      commands: [{ name: 'clipboard.copy', args: { targets: ['@mesh:ArtMesh_Square'] } }],
    });
    const fragment = copy.data.itemResults[0].fragment;
    const paste = await tool('mochi_run', {
      label: 'Paste',
      commands: [{ name: 'clipboard.paste', args: { fragment } }],
    });
    expect(paste.error).toBeUndefined();
    expect(paste.data.itemResults[0]).toMatchObject({ created: 1, unbound: [] });
  });

  it('evaluates a pose through Mochi2D', async () => {
    const { tool } = client();
    await tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') });
    const e = await tool('mochi_evaluate', { parameters: { ParamA: 1 }, ids: ['ArtMesh_Square'] });
    expect(e.data.drawables).toHaveLength(1);
    expect(e.data.drawables[0].opacity).toBeCloseTo(0.5, 6);
    expect(e.data.drawables[0].bounds.minX).toBeCloseTo(90, 3);
  });

  it('refuses paths outside the allowed directories, also through symbolic links', async () => {
    const { tool } = client();
    await tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') });
    expect(
      (await tool('mochi_import_art', { path: join(outside, 'art.psd') })).error,
    ).toMatchObject({
      category: 'forbidden',
      code: 'E_FORBIDDEN',
    });
    await symlink(outside, join(root, 'link'));
    expect((await tool('mochi_export', { out: join(root, 'link', 'x') })).error.category).toBe(
      'forbidden',
    );
    expect(
      (
        await tool('mochi_run', {
          label: 'x',
          commands: [{ name: 'art.import', args: { path: join(outside, 'art.psd') } }],
        })
      ).error.category,
    ).toBe('forbidden');
    expect(
      (
        await tool('mochi_run', {
          label: 'x',
          commands: [{ name: 'sound.import', args: { path: join(outside, 'art.psd') } }],
        })
      ).error.category,
    ).toBe('forbidden');
    expect((await tool('mochi_project', { action: 'open', path: outside })).error.category).toBe(
      'forbidden',
    );
  });

  it('reports unknown tools, bad arguments and too many calls in the bridge style', async () => {
    let t = 0;
    const { tool } = client({ now: () => t });
    expect((await tool('mochi_paint')).error).toMatchObject({ category: 'unknown_command' });
    expect((await tool('mochi_project', {})).error).toMatchObject({
      category: 'invalid_arguments',
      code: 'E_SCHEMA',
    });
    for (let i = 0; i < MAX_CALLS_PER_SECOND - 1; i++)
      await tool('mochi_describe', { errors: true });
    expect((await tool('mochi_describe', { errors: true })).error).toMatchObject({
      category: 'rate_limited',
    });
    t = 1500;
    expect((await tool('mochi_describe', { errors: true })).error).toBeUndefined();
  });

  it('enforces the session scope: read looks only, edit changes, export writes model files', async () => {
    const read = client({ scope: 'read' });
    const tools = (await read.rpc('tools/list')).result.tools as Json[];
    expect(tools.find((t) => t.name === 'mochi_export')!._meta['mochi-maker/scope']).toBe('export');
    expect(tools.find((t) => t.name === 'mochi_query')!._meta['mochi-maker/scope']).toBe('read');
    expect(
      (await read.tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') })).error,
    ).toBeUndefined();
    expect((await read.tool('mochi_query', { kind: 'parameter' })).data.total).toBe(1);
    const denied = await read.tool('mochi_run', {
      label: 'x',
      commands: [{ name: 'part.create', args: {} }],
    });
    expect(denied.error).toMatchObject({ category: 'forbidden', code: 'E_FORBIDDEN' });
    expect(denied.error.message).toContain('--scope edit');
    expect((await read.tool('mochi_project', { action: 'save' })).error.category).toBe('forbidden');
    const editOnly = client({ scope: 'edit' });
    await editOnly.tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') });
    expect(
      (
        await editOnly.tool('mochi_run', {
          label: 'x',
          commands: [{ name: 'part.create', args: {} }],
        })
      ).error,
    ).toBeUndefined();
    expect(
      (await editOnly.tool('mochi_export', { out: join(root, 'scoped') })).error.category,
    ).toBe('forbidden');
  });

  it('serves resources, announces changes to subscribers, and offers prompts', async () => {
    const { rpc, tool, notes } = client();
    const list = (await rpc('resources/list')).result.resources as Json[];
    expect(list.map((r) => r.uri)).toEqual(
      expect.arrayContaining([
        'mochi://project',
        'mochi://docs/getting-started',
        'mochi://docs/errors',
      ]),
    );
    const templates = (await rpc('resources/templates/list')).result.resourceTemplates as Json[];
    expect(templates.map((r) => r.uriTemplate)).toContain('mochi://document/{kind}/{uid}');
    const doc = (await rpc('resources/read', { uri: 'mochi://docs/commands/blendShape.add' }))
      .result;
    expect(JSON.parse(doc.contents[0].text).name).toBe('blendShape.add');
    const errors = (await rpc('resources/read', { uri: 'mochi://docs/errors' })).result.contents[0]
      .text;
    expect(errors).toContain('E_FORBIDDEN');
    expect((await rpc('resources/read', { uri: 'mochi://nothing' })).error.code).toBe(-32002);
    // The standard IDs.
    const listed = (await rpc('resources/list')).result.resources.map((r: Json) => r.uri);
    expect(listed).toEqual(
      expect.arrayContaining(['mochi://standard/parameters', 'mochi://standard/parameter-groups']),
    );
    const std = JSON.parse(
      (await rpc('resources/read', { uri: 'mochi://standard/parameters' })).result.contents[0].text,
    );
    expect(std.parameters).toHaveLength(40);
    expect(std.parameters.find((p: Json) => p.id === 'ParamMouthOpenY')).toMatchObject({
      min: 0,
      default: 0,
      max: 1,
      group: 'lipSync',
    });
    expect(std.note).toMatch(/Auto-Setup/);
    const groups = JSON.parse(
      (await rpc('resources/read', { uri: 'mochi://standard/parameter-groups' })).result.contents[0]
        .text,
    );
    expect(groups.map((g: Json) => g.id)).toContain('ParamGroupOverall');

    await tool('mochi_project', { action: 'open', path: join(root, 'g1.mochi') });
    const mesh = JSON.parse(
      (await rpc('resources/read', { uri: 'mochi://document/artMesh' })).result.contents[0].text,
    );
    expect(mesh.items[0].exportId).toBe('ArtMesh_Square');
    await rpc('resources/subscribe', { uri: 'mochi://project' });
    notes.length = 0;
    await tool('mochi_run', { label: 'x', commands: [{ name: 'part.create', args: {} }] });
    expect(notes).toEqual([
      { method: 'notifications/resources/updated', params: { uri: 'mochi://project' } },
    ]);

    const prompts = (await rpc('prompts/list')).result.prompts as Json[];
    expect(prompts.map((p) => p.name)).toEqual([
      'rig_blink',
      'head_angle_x',
      'review_rig',
      'make_motion',
      'export_model',
    ]);
    const blink = (await rpc('prompts/get', { name: 'rig_blink', arguments: { eye: '@mesh:Eye' } }))
      .result;
    expect(blink.messages[0].content.text).toContain('meta.setStandardGroups');
    expect((await rpc('prompts/get', { name: 'rig_blink', arguments: {} })).error.code).toBe(
      -32602,
    );
  });

  it('speaks newline-delimited JSON-RPC over stdio, in order', async () => {
    const server = new MochiMcpServer({ allowDirs: [root] });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => (text += String(c)));
    const done = serveStdio(server, input, output);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write('not json\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    input.end();
    await done;
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // Replies follow the input, the error for the line that is not JSON included.
    expect(lines.map((l) => l.id)).toEqual([1, null, 2]);
    expect(lines[1].error.code).toBe(-32700);
    expect(lines[2].result.tools.length).toBe(16);
  });
});
