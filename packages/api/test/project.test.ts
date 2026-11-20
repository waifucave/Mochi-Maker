/** The typed agent API (agent API design 2) over a project. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MochiError, canonicalText } from '@mochi-maker/core';
import { NodeFileSystem } from '@mochi-maker/core/node';
import { Project, errorJson, readHistory, replayHistory } from '@mochi-maker/api';
import { golden1, golden8, squareWav } from '../../export/test/golden.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function error(fn: () => unknown): MochiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof MochiError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

describe('transactions with the typed method layer', () => {
  it('runs typed methods, returns their results, and is atomic', () => {
    const p = Project.memory({ width: 400, height: 400 }, { author: 'agent:test' });
    const r = p.transact('Parameters', (tx) => {
      const a = tx.param.create({ exportId: 'ParamA', min: 0, max: 1, default: 0 });
      const part = tx.part.create({ exportId: 'PartBody', name: 'Body' });
      return [a.uid, part.uid];
    });
    expect(r.committed).toBe(true);
    expect(r.value).toEqual(['param_0001', 'part_0002']);
    expect(p.history()).toEqual([{ label: 'Parameters', author: 'agent:test' }]);
    const e = error(() =>
      p.transact('Bad', (tx) => {
        tx.param.create({ exportId: 'ParamB', min: 0, max: 1, default: 0 });
        tx.run('rig.addBinding', { target: '@part:PartBody', parameter: '@param:Nope' });
      }),
    );
    expect(e.at).toBe(1);
    expect(e.command).toBe('rig.addBinding');
    expect(p.query({ kind: 'parameter' }).total).toBe(1);
  });

  it('dry runs change nothing; expectRevision guards against concurrent edits', () => {
    const p = Project.memory();
    const before = canonicalText(p.session.doc);
    const dry = p.transact(
      'Try',
      (tx) => tx.param.create({ exportId: 'ParamA', min: 0, max: 1, default: 0 }),
      { dryRun: true },
    );
    expect(dry.committed).toBe(false);
    expect(dry.changes.map((c) => c.kind).sort()).toEqual(['parameter', 'project']);
    expect(canonicalText(p.session.doc)).toBe(before);
    p.transact('One', (tx) => tx.param.create({ min: 0, max: 1, default: 0 }));
    const stale = error(() =>
      p.transact('Two', (tx) => tx.param.create({ min: 0, max: 1, default: 0 }), {
        expectRevision: 0,
      }),
    );
    expect(stale.code).toBe('E_REVISION_MISMATCH');
  });
});

describe('self-description and errors', () => {
  it('describes commands and operations, and searches them', () => {
    const p = Project.memory();
    const all = p.describe() as { name: string; kind: string }[];
    expect(all.map((c) => c.name)).toEqual(
      expect.arrayContaining(['rig.addBinding', 'art.import']),
    );
    const one = p.describe('blendShape.add') as { args: unknown; errors: unknown[] };
    expect(JSON.stringify(one.args)).toContain('"parameter"');
    const found = p.describe({ search: 'blend shape' }) as { name: string }[];
    expect(found[0]!.name).toMatch(/^blendShape\./);
    expect(JSON.stringify(p.schema('artMesh'))).toContain('blendShapes');
  });

  it('lists every command and operation in the bridge’s CommandInfo shape, with scopes', () => {
    const info = Project.memory().commandInfo();
    expect(info.length).toBe((Project.memory().describe() as unknown[]).length);
    const add = info.find((c) => c.name === 'rig.addBinding')!;
    expect(add).toMatchObject({ scope: 'edit', undoable: true, readOnly: false });
    expect(Object.keys(add)).toEqual([
      'name',
      'summary',
      'details',
      'scope',
      'undoable',
      'readOnly',
      'inputSchema',
    ]);
    expect(JSON.stringify(add.inputSchema)).toContain('"target"');
    expect(info.find((c) => c.name === 'art.import')!.scope).toBe('edit');
    expect(info.find((c) => c.name === 'motion.reorder')).toMatchObject({
      scope: 'edit',
      undoable: true,
    });
    // Everything edits, except the copy, which only reads.
    expect(info.filter((c) => c.scope !== 'edit').map((c) => c.name)).toEqual(['clipboard.copy']);
    expect(info.find((c) => c.name === 'clipboard.copy')).toMatchObject({ scope: 'read' });
  });

  it('gives agent errors a bridge-style category, the stable code, and fixes', () => {
    const p = Project.memory();
    const unknown = errorJson(
      error(() => p.transact('x', (tx) => tx.run('nope.nothing' as never, {} as never))),
    );
    expect(unknown).toMatchObject({ category: 'unknown_command', code: 'E_UNKNOWN_COMMAND' });
    const bad = errorJson(
      error(() => p.transact('x', (tx) => tx.param.create({ min: 'a' } as never))),
    );
    expect(bad).toMatchObject({ category: 'invalid_arguments', code: 'E_SCHEMA', at: 0 });
    expect(bad.docs).toBe('mochi://docs/commands/param.create');
    p.transact('p', (tx) =>
      tx.param.create({ exportId: 'ParamA', min: -30, max: 30, default: 0, keys: [-30, 0, 30] }),
    );
    p.transact('m', (tx) => tx.part.create({ exportId: 'PartA' }));
    const keys = errorJson(
      error(() =>
        p.transact('x', (tx) =>
          tx.rig.addBinding({ target: '@part:PartA', parameter: '@param:ParamA', keys: [15] }),
        ),
      ),
    );
    expect(keys).toMatchObject({ category: 'failed', code: 'E_KEY_NOT_ON_PARAMETER' });
    expect(keys.fixes!.length).toBeGreaterThan(0);
  });
});

describe('diff, evaluate, export and save', () => {
  it('diffs revisions structurally, with mesh displacement', async () => {
    const g = await golden1();
    const p = Project.fromSession(g.session, g.assets);
    const r0 = p.revision;
    p.transact('Move', (tx) =>
      tx.mesh.moveVertices({ target: '@mesh:ArtMesh_Square', all: true, offset: [3, 4] }),
    );
    const d = p.diff(r0);
    expect(d.added).toEqual([]);
    expect(d.changed).toEqual([
      expect.objectContaining({
        kind: 'artMesh',
        fields: ['rig'],
        displacement: { max: 5, rms: 5 },
      }),
    ]);
    expect(error(() => p.diff(-5)).code).toBe('E_RANGE');
  });

  it('evaluates through Mochi2D, in canvas pixels', async () => {
    const g = await golden1();
    const p = Project.fromSession(g.session, g.assets);
    const e = await p.evaluate({ parameters: { ParamA: 1 }, vertices: true });
    const sq = e.drawables.find((d) => d.id === 'ArtMesh_Square')!;
    expect(sq.uid).toMatch(/^mesh_/);
    expect(sq.opacity).toBeCloseTo(0.5, 6);
    expect(sq.bounds.minX).toBeCloseTo(90, 3);
    expect(sq.bounds.maxX).toBeCloseTo(190, 3);
    expect(sq.bounds.minY).toBeCloseTo(50, 3);
    expect(sq.bounds.maxY).toBeCloseTo(150, 3);
    expect(sq.vertices!.length).toBe(8);
    const g8 = await golden8();
    const e8 = await Project.fromSession(g8.session, g8.assets).evaluate({
      parameters: { ParamBS: 1 },
    });
    expect(e8.drawables.find((d) => d.id === 'Face')!.drawOrder).toBe(520);
  });

  it('creates, saves, reopens and exports a project folder, with a replayable history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-api-'));
    dirs.push(dir);
    const path = join(dir, 'p.mochi');
    const p = await Project.create(path, { width: 300, height: 300 });
    p.transact('A', (tx) => tx.param.create({ exportId: 'ParamA', min: 0, max: 1, default: 0 }));
    expect(p.dirty).toBe(true);
    await p.save();
    expect(p.dirty).toBe(false);
    p.transact('B', (tx) => tx.part.create({ exportId: 'PartA' }));
    await p.save();
    const q = await Project.open(path);
    expect(canonicalText(q.session.doc)).toBe(canonicalText(p.session.doc));
    q.transact('C', (tx) => tx.part.create({ exportId: 'PartB' }));
    await q.save();
    const fs = new NodeFileSystem();
    const history = await readHistory(fs, join(path, '.mochi-cache/history.jsonl'));
    expect(canonicalText(replayHistory(history))).toBe(canonicalText(q.session.doc));

    const g = await golden1();
    const exp = Project.fromSession(g.session, g.assets);
    const out = join(dir, 'out');
    const r = await exp.export(out);
    expect(JSON.parse(await readFile(join(out, 'mochi-export.json'), 'utf8')).mocVersion).toBe(
      r.report.mocVersion,
    );
    await expect(Project.memory().save()).rejects.toMatchObject({ code: 'E_NO_PROJECT' });
  });

  it('imports a WAV as a sound, saves it as an asset, and exports it with its motion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-api-sound-'));
    dirs.push(dir);
    const wav = squareWav(0.25, 0.5);
    await writeFile(join(dir, 'hello.wav'), wav);
    const path = join(dir, 's.mochi');
    const p = await Project.create(path, { width: 100, height: 100 });
    const r = await p.run('Sound', [
      { name: 'sound.import', args: { path: join(dir, 'hello.wav') } },
      { name: 'motion.create', args: { name: 'greet', group: 'TapBody', duration: 0.5 } },
      { name: 'motion.update', args: { target: '$1', sound: '$0.uid' } },
    ]);
    expect(r.itemResults[0]).toMatchObject({
      sampleRate: 16000,
      channels: 1,
      frames: 8000,
      seconds: 0.5,
    });
    await p.save();
    const assets = await readdir(join(path, 'assets'));
    expect(assets.filter((f) => f.endsWith('.wav'))).toHaveLength(1);
    const q = await Project.open(path);
    expect(q.query({ kind: 'sound' }).items[0]).toMatchObject({ name: 'hello' });
    // The project has no meshes, so export needs one; check the reopened assets directly instead.
    const sound = q.session.view.ofKind('sound')[0]!;
    expect(Buffer.from(await q.assets.get(sound.asset)).equals(Buffer.from(wav))).toBe(true);
    const bad = join(dir, 'bad.wav');
    await writeFile(bad, new Uint8Array([1, 2, 3, 4]));
    await expect(q.run('x', [{ name: 'sound.import', args: { path: bad } }])).rejects.toMatchObject(
      {
        code: 'E_ASSET_FORMAT',
      },
    );
  });
});
