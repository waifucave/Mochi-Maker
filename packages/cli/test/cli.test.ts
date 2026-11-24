import { VERSION } from '@mochi-maker/core';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';
import { decodePng } from '@mochi-maker/art';
import { reimportPsd, syntheticPsd } from '../../art/test/synthetic.js';

/**
 * The limit for the tests here that export models through the command line and load them in
 * Mochi2D, or import art with previews: the longest took 1.0 s on two busy cores.
 */
const WORK = 30_000;

let dir: string;

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const o = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((s) => ((stdout += String(s)), true));
  const e = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((s) => ((stderr += String(s)), true));
  try {
    const code = await main(args);
    return { code, stdout, stderr };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

const RIG = [
  {
    name: 'param.create',
    args: { exportId: 'ParamAngleX', min: -30, max: 30, keys: [-30, 0, 30] },
  },
  { name: 'part.create', args: { exportId: 'PartHead' } },
  {
    name: 'mesh.create',
    args: {
      exportId: 'ArtMesh_Face',
      part: '$1',
      uv: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      triangles: [[0, 1, 2]],
    },
  },
  { name: 'rig.addBinding', args: { target: '$2', parameter: '$0' } },
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mochi-cli-'));
  await writeFile(join(dir, 'rig.jsonl'), RIG.map((c) => JSON.stringify(c)).join('\n'));
  await writeFile(
    join(dir, 'bad.json'),
    JSON.stringify([{ name: 'param.create', args: { min: 1, max: 0 } }]),
  );
  await writeFile(
    join(dir, 'script.mjs'),
    `export default (session, { author }) => {
       session.transact('from a script', (tx) => {
         const { uid } = tx.run('param.create', { exportId: 'ParamEyeLOpen', min: 0, max: 1, default: 1 });
         tx.run('meta.setStandardGroups', { eyeBlink: [uid] });
       }, { author });
     };`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('mochi-maker', () => {
  it('creates, runs, queries, validates and replays', async () => {
    const p = join(dir, 'a.mochi');
    expect((await cli('new', p, '--canvas', '1000x2000', '--ppu', '1000')).code).toBe(0);
    expect((await cli('new', p)).code).toBe(1);

    const run = await cli('run', p, join(dir, 'rig.jsonl'), '--json', '--label', 'rig');
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      committed: true,
      results: [
        { uid: 'param_0001' },
        { uid: 'part_0002' },
        { uid: 'mesh_0003' },
        { keyformCount: 3 },
      ],
    });

    const q = await cli('query', p, 'artMesh', '--json', '--fields', 'exportId,triangles');
    expect(JSON.parse(q.stdout)).toEqual({
      total: 1,
      items: [
        { uid: 'mesh_0003', kind: 'artMesh', exportId: 'ArtMesh_Face', triangles: [[0, 1, 2]] },
      ],
    });
    const w = await cli('query', p, '--where', 'exportId=PartHead', '--json');
    expect(JSON.parse(w.stdout).items.map((x: { uid: string }) => x.uid)).toEqual(['part_0002']);
    const g = await cli('get', p, '@param:ParamAngleX');
    expect(JSON.parse(g.stdout).keys).toEqual([-30, 0, 30]);

    expect((await cli('run', p, join(dir, 'script.mjs'))).code).toBe(0);
    const v = await cli('validate', p, '--json');
    expect(v.code).toBe(1); // the mesh has no layer: an export blocker
    expect(JSON.parse(v.stdout).violations).toEqual([]);

    const h = await cli('history', p, '--json');
    const ops = JSON.parse(h.stdout).map(
      (e: { op: string; author?: string }) => `${e.op}${e.author ? ' ' + e.author : ''}`,
    );
    expect(ops).toEqual([
      'init',
      'base',
      `tx script:${join(dir, 'rig.jsonl')}`,
      'base',
      `tx script:${join(dir, 'script.mjs')}`,
    ]);

    const out = join(dir, 'b.mochi');
    expect((await cli('replay', join(p, '.mochi-cache/history.jsonl'), '--out', out)).code).toBe(0);
    for (const f of [
      'mochi-project.json',
      'parameters.json',
      'parts.json',
      'meshes/mesh_0003.json',
    ])
      expect(await readFile(join(out, f), 'utf8')).toBe(await readFile(join(p, f), 'utf8'));
  });

  it('dry runs change nothing on disk', async () => {
    const p = join(dir, 'c.mochi');
    await cli('new', p);
    const before = await readdir(p);
    const r = await cli('run', p, join(dir, 'rig.jsonl'), '--dry-run', '--json');
    expect(JSON.parse(r.stdout).committed).toBe(false);
    expect(await readdir(p)).toEqual(before);
    expect(JSON.parse((await cli('query', p, '--json')).stdout).total).toBe(1); // only the project
  });

  it('reports structured errors and exit codes', async () => {
    const p = join(dir, 'd.mochi');
    await cli('new', p);
    const r = await cli('run', p, join(dir, 'bad.json'), '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toMatchObject({
      code: 'E_RANGE',
      command: 'param.create',
      at: 0,
    });
    expect((await cli('frobnicate')).code).toBe(2);
    expect(await cli('--version')).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    expect((await cli('--help')).code).toBe(0);
    expect((await cli()).code).toBe(2);
    expect((await cli('run', p)).code).toBe(2);
    expect((await cli('query', join(dir, 'missing.mochi'))).code).toBe(1);
  });

  it('detects edits made outside the history when replaying', async () => {
    const p = join(dir, 'e.mochi');
    await cli('new', p);
    await cli('run', p, join(dir, 'rig.jsonl'));
    // Edit a file by hand, then record another transaction.
    const meshPath = join(p, 'meshes/mesh_0003.json');
    await writeFile(
      meshPath,
      (await readFile(meshPath, 'utf8')).replace('"name": "ArtMesh_Face"', '"name": "Edited"'),
    );
    await cli('run', p, join(dir, 'script.mjs'));
    const r = await cli(
      'replay',
      join(p, '.mochi-cache/history.jsonl'),
      '--out',
      join(dir, 'f.mochi'),
      '--json',
    );
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error.code).toBe('E_REPLAY_DIVERGED');
  });

  it('describes commands', async () => {
    const r = await cli('describe', 'rig.addBinding', '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({
      name: 'rig.addBinding',
      errors: expect.arrayContaining([{ code: 'E_ALREADY_BOUND', meaning: expect.any(String) }]),
    });
    expect((await cli('describe', 'nope.nope')).code).toBe(1);
    expect((await cli('describe')).stdout).toContain('keyform.set');
  });

  it('re-imports changed art and reports what to re-fit', { timeout: WORK }, async () => {
    const p = join(dir, 'reimport.mochi');
    await cli('new', p);
    const art = join(dir, 'character.psd');
    await writeFile(art, reimportPsd(1));
    expect((await cli('import', p, art)).code).toBe(0);
    await writeFile(art, reimportPsd(2));
    const dry = await cli('reimport', p, art, '--dry-run', '--json');
    expect(JSON.parse(dry.stdout).committed).toBe(false);
    const r = await cli('reimport', p, art);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Re-imported .*: 3 changed, 0 unchanged, 1 added, 1 removed\./);
    expect(r.stdout).toMatch(/re-fit: .*Face.*: art outside the mesh/);
    expect(r.stdout).toMatch(/added: Head\/Mouth/);
    expect(r.stdout).toMatch(/removed: 目/);
    const again = await cli('reimport', p, art);
    expect(again.stdout).toMatch(/0 changed, 4 unchanged, 0 added, 1 removed/);
  });

  it(
    'imports art with previews, and runs operations from command files',
    { timeout: WORK },
    async () => {
      const p = join(dir, 'art.mochi');
      await cli('new', p);
      await writeFile(join(dir, 'char.psd'), syntheticPsd());
      const dry = await cli('import', p, join(dir, 'char.psd'), '--dry-run', '--json');
      expect(JSON.parse(dry.stdout).committed).toBe(false);
      const r = await cli(
        'import',
        p,
        join(dir, 'char.psd'),
        '--spacing',
        '12',
        '--preview',
        join(dir, 'import.png'),
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Imported 6 layer\(s\), 1 part\(s\), 5 mesh\(es\)/);
      expect(r.stdout).toMatch(/note: Head\/Eye: blend mode multiply is not applied/);
      expect(decodePng(new Uint8Array(await readFile(join(dir, 'import.png')))).width).toBe(200);
      expect((await readdir(join(p, 'assets'))).length).toBe(6);
      expect((await readdir(join(p, 'meshes'))).length).toBe(5);

      await writeFile(
        join(dir, 'regen.jsonl'),
        JSON.stringify({
          name: 'mesh.regenerate',
          args: { target: '@mesh:ArtMesh_Face', spacing: 8 },
        }),
      );
      const rg = await cli(
        'run',
        p,
        join(dir, 'regen.jsonl'),
        '--preview',
        join(dir, 'previews'),
        '--json',
      );
      expect(rg.code).toBe(0);
      expect(JSON.parse(rg.stdout).previews[0]).toMatch(/New mesh for/);
      expect(await readdir(join(dir, 'previews'))).toEqual(['preview-1.png']);
      // The project reloads cleanly and the history replays without the PSD.
      expect((await cli('validate', p, '--json')).stdout).toContain('"violations": []');
      const out = join(dir, 'art-replayed.mochi');
      expect((await cli('replay', join(p, '.mochi-cache/history.jsonl'), '--out', out)).code).toBe(
        0,
      );
      expect(await readFile(join(out, 'parts.json'), 'utf8')).toBe(
        await readFile(join(p, 'parts.json'), 'utf8'),
      );

      const d = await cli('describe', '--json');
      expect(JSON.parse(d.stdout)).toEqual(
        expect.arrayContaining([
          { name: 'art.import', kind: 'operation', summary: expect.any(String) },
        ]),
      );
    },
  );

  it('exports a model template and applies it', async () => {
    const golden = (n: string) =>
      join(import.meta.dirname, '../../export/test/golden', `${n}.mochi`);
    const file = join(dir, 'nested.mochitemplate');
    const e = await cli(
      'export-template',
      golden('golden-15-nested-deformers'),
      '--out',
      file,
      '--name',
      'Nested',
      '--author',
      'tests',
    );
    expect(e.stderr).toBe('');
    expect(e.stdout).toMatch(/Wrote .*: Nested, 4 meshes, 5 deformers, 2 parameters/);
    const r = await cli(
      'apply-template',
      golden('golden-2-deformers'),
      file,
      '--dry-run',
      '--json',
    );
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout);
    expect(res.template).toBe('Nested');
    expect(Array.isArray(res.pairs)).toBe(true);
  });

  it('writes a conformance pack whose scenarios Mochi2D runs from disk to the same results', async () => {
    const golden = (n: string) =>
      join(import.meta.dirname, '../../export/test/golden', `${n}.mochi`);
    const out = join(dir, 'pack');
    const r = await cli(
      'conformance-pack',
      golden('golden-1-keyforms'),
      golden('golden-11-animation'),
      '--out',
      out,
      '--random',
      '2',
    );
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Wrote .*: 8 export\(s\)/);
    // Renders where Chromium runs (each export's render.default, and render poses capped by
    // --random 2: 8 × 3), else a note.
    expect(r.stdout).toMatch(/24 render\(s\)|no renders:/);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('mochi-maker-conformance-pack');
    expect(await readFile(join(out, 'README.md'), 'utf8')).toMatch(/npm run judge/);
    // Run one static and one animation scenario again from the files on disk.
    const { resultModelFromDisk, scenarioResult, formatResultJson } = await import('mochi2d/node');
    const entry = manifest.entries.find(
      (e: { project: string; version: number }) =>
        e.project === 'golden-11-animation' && e.version === 3,
    );
    const model = await resultModelFromDisk(join(out, entry.model));
    for (const kind of ['static', 'animation']) {
      const s = entry.scenarios.find((x: { kind: string }) => x.kind === kind);
      const scenario = JSON.parse(await readFile(join(out, s.file), 'utf8'));
      const again = formatResultJson(
        scenarioResult(model, scenario),
        '  ',
        kind === 'animation' ? 'double' : 'float32',
      );
      expect(again + '\n').toBe(await readFile(join(out, s.result), 'utf8'));
    }
    // A non-empty folder is refused without --force.
    expect((await cli('conformance-pack', golden('golden-1-keyforms'), '--out', out)).code).toBe(2);
    expect(
      (
        await cli(
          'conformance-pack',
          golden('golden-1-keyforms'),
          '--out',
          out,
          '--force',
          '--versions',
          '7',
        )
      ).code,
    ).toBe(2);
  }, 60_000);

  it('exports a model folder or zip that Mochi2D loads from disk', { timeout: WORK }, async () => {
    const p = join(dir, 'exp.mochi');
    await cli('new', p);
    await writeFile(join(dir, 'exp.psd'), syntheticPsd());
    expect((await cli('import', p, join(dir, 'exp.psd'))).code).toBe(0);
    const v = await cli('validate', p, '--export', '--json');
    expect(JSON.parse(v.stdout).export).toMatchObject({ ok: true, mocVersion: 5 });

    const outDir = join(dir, 'exported');
    const r = await cli('export', p, '--out', outDir, '--stem', 'char');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Exported version 5/);
    const files = (await readdir(outDir)).sort();
    expect(files).toEqual([
      'char.4096',
      'char.cdi3.json',
      'char.moc3',
      'char.model3.json',
      'mochi-export.json',
    ]);
    const { loadModelFromDisk } = await import('mochi2d/node');
    const model = await loadModelFromDisk(join(outDir, 'char.model3.json'));
    model.update(1 / 60);
    expect(model.instance.drawableVertices.length).toBe(5);

    // Exporting again over the previous export works; a foreign non-empty folder is refused.
    expect((await cli('export', p, '--out', outDir, '--stem', 'char')).code).toBe(0);
    await writeFile(join(dir, 'other.txt'), 'x');
    const foreign = join(dir, 'foreign');
    await import('node:fs/promises').then((m) => m.mkdir(foreign));
    await writeFile(join(foreign, 'keep.txt'), 'x');
    expect((await cli('export', p, '--out', foreign)).code).toBe(2);

    // Zips are deterministic.
    expect((await cli('export', p, '--out', join(dir, 'a.zip'))).code).toBe(0);
    expect((await cli('export', p, '--out', join(dir, 'b.zip'))).code).toBe(0);
    expect(
      Buffer.compare(await readFile(join(dir, 'a.zip')), await readFile(join(dir, 'b.zip'))),
    ).toBe(0);
    expect((await cli('export', p, '--out', join(dir, 'c.zip'), '--moc-version', '9')).code).toBe(
      2,
    );

    // Compatibility targets (M13): an explicit version 3, and auto above the project's minimum.
    const v3 = await cli('export', p, '--out', join(dir, 'v3.zip'), '--moc-version', '3');
    expect(v3.code).toBe(0);
    expect(v3.stdout).toMatch(/Exported version 3/);
    await writeFile(
      join(dir, 'min3.jsonl'),
      JSON.stringify({ name: 'project.setExportSettings', args: { minimumVersion: 3 } }) + '\n',
    );
    expect((await cli('run', p, join(dir, 'min3.jsonl'))).code).toBe(0);
    const auto = await cli('validate', p, '--target-version', 'auto', '--json');
    expect(JSON.parse(auto.stdout).export).toMatchObject({ ok: true, mocVersion: 3 });
    // A color makes version 3 impossible: validate names the mesh and the fix.
    await writeFile(
      join(dir, 'tint.jsonl'),
      JSON.stringify({
        name: 'keyform.set',
        args: { target: await firstMesh(p), all: true, values: { multiply: [1, 0.5, 1] } },
      }) + '\n',
    );
    expect((await cli('run', p, join(dir, 'tint.jsonl'))).code).toBe(0);
    const refused = await cli('validate', p, '--target-version', '3');
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toMatch(
      /version 3 cannot carry it\. Fix: Export at version 4/,
    );
    const auto4 = await cli('validate', p, '--target-version', 'auto', '--json');
    expect(JSON.parse(auto4.stdout).export).toMatchObject({ ok: true, mocVersion: 4 });
  });
});

/** The UID of the project's first mesh, from `query`. */
async function firstMesh(p: string): Promise<string> {
  const q = await cli('query', p, 'artMesh', '--fields', 'uid', '--limit', '1', '--json');
  const rows = JSON.parse(q.stdout) as { items?: { uid: string }[] } | { uid: string }[];
  const list = Array.isArray(rows) ? rows : (rows.items ?? []);
  return list[0]!.uid;
}
