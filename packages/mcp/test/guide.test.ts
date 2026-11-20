/**
 * The getting-started guide's second path (docs/guide/agent.md): an agent builds the same
 * model through the MCP server's tools, call for call as that page lists them. The export then
 * loads in Mochi2D, blinks, tilts and swings its hair.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MochiMcpServer } from '@mochi-maker/mcp';
import { MemoryFileSource, ModelRuntime } from 'mochi2d/headless';
import { IDLE_MOTION, examplePsd } from '../../editor/test/guide-art.js';

/** The sample model (samples/mochi): this guide's model, with an idle motion, as files. */
const SAMPLE = join(import.meta.dirname, '../../../samples/mochi');
const UPDATE = process.env.UPDATE_GUIDE === '1';

async function filesOf(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const f of await readdir(dir, { recursive: true, withFileTypes: true }))
    if (f.isFile()) {
      const path = join(f.parentPath, f.name);
      files.set(relative(dir, path).split('\\').join('/'), await readFile(path));
    }
  return files;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mochi-guide-'));
  await writeFile(join(root, 'mochi.psd'), examplePsd());
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the getting-started guide, by an agent', () => {
  it('builds, checks and exports the example model through the MCP tools', async () => {
    const server = new MochiMcpServer({ allowDirs: [root], author: 'agent:guide' });
    let id = 0;
    const tool = async (name: string, args: Json = {}) => {
      const r = (
        (await server.handle({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: { name, arguments: args },
        })) as Json
      ).result as Json;
      if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.structuredContent.error)}`);
      return r.structuredContent as Json;
    };
    const run = (label: string, commands: Json[]) => tool('mochi_run', { label, commands });

    // 1. A project, and the art.
    await tool('mochi_project', { action: 'new', path: join(root, 'Mochi.mochi') });
    const imported = await tool('mochi_import_art', { path: join(root, 'mochi.psd') });
    expect(imported.committed).toBe(true);
    const meshes = await tool('mochi_query', { kind: 'artMesh', fields: ['exportId'] });
    expect(meshes.items.map((m: Json) => m.exportId)).toEqual([
      'ArtMesh_Hair_back',
      'ArtMesh_Body',
      'ArtMesh_Face',
      'ArtMesh_Eye_R',
      'ArtMesh_Eye_L',
      'ArtMesh_Mouth',
      'ArtMesh_Hair_front',
    ]);

    // 2. Parameters and the standard groups.
    await run('Parameters', [
      {
        name: 'param.create',
        args: { exportId: 'ParamAngleZ', name: 'Angle Z', min: -30, max: 30, default: 0 },
      },
      {
        name: 'param.create',
        args: { exportId: 'ParamEyeLOpen', name: 'Eye L Open', min: 0, max: 1, default: 1 },
      },
      {
        name: 'param.create',
        args: { exportId: 'ParamEyeROpen', name: 'Eye R Open', min: 0, max: 1, default: 1 },
      },
      {
        name: 'param.create',
        args: { exportId: 'ParamMouthOpenY', name: 'Mouth Open', min: 0, max: 1, default: 0 },
      },
      {
        name: 'param.create',
        args: { exportId: 'ParamHairFront', name: 'Hair Front', min: -1, max: 1, default: 0 },
      },
      {
        name: 'meta.setStandardGroups',
        args: {
          eyeBlink: ['@param:ParamEyeLOpen', '@param:ParamEyeROpen'],
          lipSync: ['@param:ParamMouthOpenY'],
        },
      },
    ]);

    // 3. The head: a rotation deformer at the neck holding the head's meshes; ±10° on ParamAngleZ.
    // The hair: a rotation inside it, at the top of the head; ±8° on ParamHairFront. Origins of a
    // rotation inside a rotation are in pixels around the parent's origin.
    const head = ['Face', 'Eye_R', 'Eye_L', 'Mouth', 'Hair_front', 'Hair_back'];
    await run('Head and hair', [
      {
        name: 'deformer.createRotation',
        args: { exportId: 'Rotation_Head', origin: { x: 300, y: 450 } },
      },
      ...head.map((m) => ({
        name: 'mesh.reparent',
        args: { target: `@mesh:ArtMesh_${m}`, deformer: '@rot:Rotation_Head' },
      })),
      {
        name: 'rig.addBinding',
        args: { target: '@rot:Rotation_Head', parameter: '@param:ParamAngleZ', keys: [-30, 0, 30] },
      },
      {
        name: 'keyform.set',
        args: {
          target: '@rot:Rotation_Head',
          cell: { '@param:ParamAngleZ': -30 },
          values: { angle: -10 },
        },
      },
      {
        name: 'keyform.set',
        args: {
          target: '@rot:Rotation_Head',
          cell: { '@param:ParamAngleZ': 30 },
          values: { angle: 10 },
        },
      },
      {
        name: 'deformer.createRotation',
        args: {
          exportId: 'Rotation_HairFront',
          parent: '@rot:Rotation_Head',
          origin: { x: 0, y: -300 },
        },
      },
      {
        name: 'mesh.reparent',
        args: { target: '@mesh:ArtMesh_Hair_front', deformer: '@rot:Rotation_HairFront' },
      },
      {
        name: 'rig.addBinding',
        args: {
          target: '@rot:Rotation_HairFront',
          parameter: '@param:ParamHairFront',
          keys: [-1, 0, 1],
        },
      },
      {
        name: 'keyform.set',
        args: {
          target: '@rot:Rotation_HairFront',
          cell: { '@param:ParamHairFront': -1 },
          values: { angle: -8 },
        },
      },
      {
        name: 'keyform.set',
        args: {
          target: '@rot:Rotation_HairFront',
          cell: { '@param:ParamHairFront': 1 },
          values: { angle: 8 },
        },
      },
    ]);

    // 4. The eyes and the mouth: the agent reads each mesh's points, then moves the upper ones down
    // (eyes shut at 0) or the lower ones down (mouth open at 1). Positions in the mesh's own space,
    // pixels around the head's origin: y grows downward.
    const points = async (mesh: string) => {
      const q = await tool('mochi_query', { ref: `@mesh:${mesh}` });
      const pos = q.rig.keyforms[0].positions as [number, number][];
      const ys = pos.map((v) => v[1]);
      const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
      return { ys, y0, y1, mid: (y0 + y1) / 2 };
    };
    for (const [mesh, param] of [
      ['ArtMesh_Eye_L', 'ParamEyeLOpen'],
      ['ArtMesh_Eye_R', 'ParamEyeROpen'],
    ]) {
      const e = await points(mesh!);
      await run(`Blink ${mesh}`, [
        {
          name: 'rig.addBinding',
          args: { target: `@mesh:${mesh}`, parameter: `@param:${param}`, keys: [0, 1] },
        },
        {
          name: 'mesh.moveVertices',
          args: {
            target: `@mesh:${mesh}`,
            cell: { [`@param:${param}`]: 0 },
            vertices: e.ys.flatMap((y, i) => (y < e.mid ? [i] : [])),
            offset: [0, (e.y1 - e.y0) * 0.45],
          },
        },
      ]);
    }
    const m = await points('ArtMesh_Mouth');
    await run('Mouth', [
      {
        name: 'rig.addBinding',
        args: { target: '@mesh:ArtMesh_Mouth', parameter: '@param:ParamMouthOpenY', keys: [0, 1] },
      },
      {
        name: 'mesh.moveVertices',
        args: {
          target: '@mesh:ArtMesh_Mouth',
          cell: { '@param:ParamMouthOpenY': 1 },
          vertices: m.ys.flatMap((y, i) => (y > m.mid ? [i] : [])),
          offset: [0, (m.y1 - m.y0) * 1.2],
        },
      },
    ]);

    // 5. Physics: the head's tilt swings the front hair.
    await run('Hair physics', [
      {
        name: 'physics.addSetting',
        args: {
          name: 'Hair',
          inputs: [{ parameter: '@param:ParamAngleZ', weight: 100, type: 'Angle' }],
          outputs: [
            {
              parameter: '@param:ParamHairFront',
              weight: 100,
              type: 'Angle',
              particle: 1,
              scale: 1,
            },
          ],
          particles: [
            { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
            { x: 0, y: 10, mobility: 0.95, delay: 0.9, acceleration: 1.5, radius: 10 },
          ],
          normalization: {
            position: { min: -10, default: 0, max: 10 },
            angle: { min: -10, default: 0, max: 10 },
          },
        },
      },
    ]);

    // 6. Check, look, save and export.
    const checked = await tool('mochi_validate', { targetVersion: 'auto' });
    expect(checked.errors ?? []).toEqual([]);
    // The eye is flat when shut, the mouth taller when open (bounds in canvas pixels).
    const height = async (id: string, parameters: Json = {}) => {
      const e = await tool('mochi_evaluate', { parameters, ids: [id] });
      const b = e.drawables[0].bounds;
      return b.maxY - b.minY;
    };
    expect(await height('ArtMesh_Eye_L', { ParamEyeLOpen: 0 })).toBeLessThan(
      (await height('ArtMesh_Eye_L')) * 0.7,
    );
    expect(await height('ArtMesh_Mouth', { ParamMouthOpenY: 1 })).toBeGreaterThan(
      (await height('ArtMesh_Mouth')) * 1.5,
    );
    await tool('mochi_project', { action: 'save' });
    const out = join(root, 'export');
    const exported = await tool('mochi_export', { out });
    expect(exported.mocVersion).toBeGreaterThanOrEqual(3);

    // In Mochi2D: it loads, the eyes shut, and the hair swings after the head.
    const files = new Map<string, Uint8Array>();
    for (const f of await readdir(out, { recursive: true, withFileTypes: true }))
      if (f.isFile()) {
        const path = join(f.parentPath, f.name);
        files.set(relative(out, path).split('\\').join('/'), await readFile(path));
      }
    const stem = [...files.keys()].find((f) => f.endsWith('.model3.json'))!;
    const rt = await ModelRuntime.load(new MemoryFileSource('agent', files), stem);
    expect(rt.parameters.map((p) => p.id).sort()).toEqual(
      ['ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamHairFront', 'ParamMouthOpenY'].sort(),
    );
    rt.setParameter('ParamAngleZ', 30);
    let hair = 0;
    for (let i = 0; i < 60; i++) {
      rt.update(1 / 60);
      hair = Math.max(hair, Math.abs(rt.getParameter('ParamHairFront')));
    }
    expect(hair).toBeGreaterThan(0.05);

    // The sample model: the same project, with an idle motion, exported as «mochi». The committed
    // folder must be exactly this export (UPDATE_GUIDE=1 rewrites it).
    await run('Idle motion', IDLE_MOTION);
    await run('Sample', [{ name: 'project.setExportSettings', args: { fileStem: 'mochi' } }]);
    const sampleOut = join(root, 'sample');
    await tool('mochi_export', { out: sampleOut });
    const sample = await filesOf(sampleOut);
    sample.delete('mochi-export.json'); // the export report, not part of the model
    expect([...sample.keys()].sort()).toEqual([
      'mochi.4096/texture_00.png',
      'mochi.cdi3.json',
      'mochi.moc3',
      'mochi.model3.json',
      'mochi.physics3.json',
      'motions/idle.motion3.json',
    ]);
    const settings = JSON.parse(new TextDecoder().decode(sample.get('mochi.model3.json')!));
    expect(settings.Groups).toEqual([
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ]);
    expect(Object.keys(settings.FileReferences.Motions)).toEqual(['Idle']);
    // It exports with the default flags: no glue, no blend shapes.
    expect(exported.report?.counts?.glues ?? 0).toBe(0);
    const idle = await ModelRuntime.load(
      new MemoryFileSource('sample', sample),
      'mochi.model3.json',
    );
    expect(await idle.startMotion('Idle', 0)).not.toBe(false);
    let sway = 0;
    for (let i = 0; i < 60; i++) {
      idle.update(1 / 60);
      sway = Math.max(sway, Math.abs(idle.getParameter('ParamAngleZ')));
    }
    expect(sway).toBeGreaterThan(1);
    if (UPDATE) {
      await rm(SAMPLE, { recursive: true, force: true });
      for (const [path, bytes] of sample) {
        await mkdir(join(SAMPLE, path, '..'), { recursive: true });
        await writeFile(join(SAMPLE, path), bytes);
      }
    }
    const committed = await filesOf(SAMPLE);
    committed.delete('README.md');
    expect([...committed.keys()].sort()).toEqual([...sample.keys()].sort());
    for (const [path, bytes] of sample)
      expect(
        Buffer.from(committed.get(path)!).equals(Buffer.from(bytes)),
        `samples/mochi/${path}`,
      ).toBe(true);
  }, 120_000);
});
