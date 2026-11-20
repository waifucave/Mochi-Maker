import { describe, expect, it } from 'vitest';
import { MemoryAssetStore, MochiError, type Session } from '@mochi-maker/core';
import { decodePng } from '@mochi-maker/art';
import { exportModel, curveCounts, safeFileName } from '@mochi-maker/export';
import { parseMotion, readMoc } from 'mochi2d/headless';
import { golden1, golden3 } from './golden.js';

const json = (bytes: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(bytes));

async function error(p: Promise<unknown>): Promise<MochiError> {
  try {
    await p;
  } catch (e) {
    return e as MochiError;
  }
  throw new Error('expected an error');
}

function addAnimation(s: Session): void {
  s.runBatch('animation', [
    { name: 'paramGroup.create', args: { exportId: 'GroupMain', name: 'Main' } },
    { name: 'param.update', args: { target: '@param:ParamA', group: '$0' } },
    {
      name: 'expression.create',
      args: {
        name: 'happy/sad',
        fadeIn: 0.3,
        entries: [{ parameter: '@param:ParamA', value: 1, blend: 'Overwrite' }],
      },
    },
    { name: 'expression.create', args: { name: 'happy_sad', entries: [] } },
    {
      name: 'motion.create',
      args: { name: 'idle', group: 'Idle', duration: 2, fps: 30, loop: true, fadeIn: 0.5 },
    },
    {
      name: 'motion.setCurve',
      args: {
        target: '$4',
        curve: { target: 'partOpacity', object: '@part:PartBody', segments: [0, 1, 0, 2, 0.5] },
      },
    },
    {
      name: 'motion.setCurve',
      args: {
        target: '$4',
        curve: {
          target: 'parameter',
          object: '@param:ParamA',
          segments: [0, 0, 1, 0.5, 0, 1, 1, 2, 1, 2, 2, 0],
        },
      },
    },
    {
      name: 'motion.setCurve',
      args: {
        target: '$4',
        curve: { target: 'model', model: 'Opacity', segments: [0, 1, 3, 2, 1] },
      },
    },
    { name: 'motion.setEvents', args: { target: '$4', events: [{ time: 1, value: 'ping' }] } },
    {
      name: 'physics.addSetting',
      args: {
        name: 'Sway',
        inputs: [{ parameter: '@param:ParamA', weight: 100, type: 'X' }],
        outputs: [{ parameter: '@param:ParamA', weight: 50, type: 'Angle', particle: 1, scale: 2 }],
        particles: [
          { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
          { x: 0, y: 3, mobility: 0.9, delay: 0.8, acceleration: 1.5, radius: 3 },
        ],
        normalization: {
          position: { min: -10, default: 0, max: 10 },
          angle: { min: -10, default: 0, max: 10 },
        },
      },
    },
    { name: 'physics.setFps', args: { fps: 60 } },
    { name: 'pose.setGroups', args: { fadeIn: 0.2, groups: [[{ part: '@part:PartBody' }]] } },
    {
      name: 'meta.setUserData',
      args: { entries: [{ target: '@mesh:ArtMesh_Square', value: 'tap me' }] },
    },
    { name: 'meta.setStandardGroups', args: { eyeBlink: ['@param:ParamA'] } },
  ]);
}

describe('export', () => {
  it('writes settings, display info, expressions, motions, physics, pose and user data that Mochi2D reads', async () => {
    const g = await golden1();
    addAnimation(g.session);
    const r = await exportModel(g.session.doc, g.assets);
    expect([...r.files.keys()]).toEqual([
      'expressions/happy_sad.exp3.json',
      'expressions/happy_sad_2.exp3.json',
      'golden1.1024/texture_00.png',
      'golden1.cdi3.json',
      'golden1.moc3',
      'golden1.model3.json',
      'golden1.physics3.json',
      'golden1.pose3.json',
      'golden1.userdata3.json',
      'motions/idle.motion3.json',
    ]);
    const settings = json(r.files.get('golden1.model3.json'));
    expect(settings.FileReferences).toMatchObject({
      Moc: 'golden1.moc3',
      Physics: 'golden1.physics3.json',
      Pose: 'golden1.pose3.json',
      UserData: 'golden1.userdata3.json',
      DisplayInfo: 'golden1.cdi3.json',
      Expressions: [
        { Name: 'happy/sad', File: 'expressions/happy_sad.exp3.json' },
        { Name: 'happy_sad', File: 'expressions/happy_sad_2.exp3.json' },
      ],
      Motions: { Idle: [{ File: 'motions/idle.motion3.json' }] },
    });
    expect(settings.Groups[0]).toEqual({ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamA'] });

    const motion = json(r.files.get('motions/idle.motion3.json'));
    expect(motion.Curves.map((c: { Target: string }) => c.Target)).toEqual([
      'Model',
      'Parameter',
      'PartOpacity',
    ]);
    expect(motion.Meta).toMatchObject({
      CurveCount: 3,
      TotalSegmentCount: 4,
      TotalPointCount: 9,
      UserDataCount: 1,
      FadeInTime: 0.5,
    });
    const parsed = parseMotion(r.files.get('motions/idle.motion3.json')!) as unknown as {
      curves?: unknown[];
    };
    expect(parsed).toBeTruthy();
    expect(curveCounts([0, 0, 1, 0.5, 0, 1, 1, 2, 1, 2, 2, 0])).toEqual({ segments: 2, points: 5 });

    expect(json(r.files.get('golden1.cdi3.json'))).toEqual({
      Version: 3,
      Parameters: [{ Id: 'ParamA', GroupId: 'GroupMain', Name: 'A' }],
      ParameterGroups: [{ Id: 'GroupMain', GroupId: '', Name: 'Main' }],
      Parts: [{ Id: 'PartBody', Name: 'Body' }],
    });
    expect(json(r.files.get('golden1.physics3.json')).Meta).toMatchObject({
      PhysicsSettingCount: 1,
      TotalInputCount: 1,
      TotalOutputCount: 1,
      VertexCount: 2,
      Fps: 60,
    });
    expect(json(r.files.get('golden1.userdata3.json')).UserData).toEqual([
      { Target: 'ArtMesh', Id: 'ArtMesh_Square', Value: 'tap me' },
    ]);
    expect(json(r.files.get('expressions/happy_sad.exp3.json'))).toEqual({
      Type: 'Live2D Expression',
      FadeInTime: 0.3,
      Parameters: [{ Id: 'ParamA', Value: 1, Blend: 'Overwrite' }],
    });
  });

  it('chooses the version: lowest that carries the model, never below the minimum', async () => {
    const g = await golden3(); // has colors
    expect((await exportModel(g.session.doc, g.assets)).report.mocVersion).toBe(5);
    g.session.run('project.setExportSettings', { mocVersion: 'auto', minimumVersion: 3 });
    const auto = await exportModel(g.session.doc, g.assets);
    expect(auto.report.mocVersion).toBe(4);
    expect(auto.report.versionReason).toMatch(/need version 4.*Tinted/);
    expect(readMoc(auto.files.get('golden3.moc3')!).version).toBe(4);
    const e = await error(exportModel(g.session.doc, g.assets, { mocVersion: 3 }));
    expect(e.code).toBe('E_EXPORT');
    expect((e.details!.problems as { code: string; uid: string }[]).map((p) => p.code)).toContain(
      'feature-needs-version',
    );
    const plain = await golden1();
    plain.session.run('project.setExportSettings', { mocVersion: 'auto', minimumVersion: 3 });
    expect((await exportModel(plain.session.doc, plain.assets)).report.mocVersion).toBe(3);
  });

  it('refuses documents with lint errors, missing images or layers too large for a page', async () => {
    const g = await golden1();
    g.session.run('mesh.update', { target: '@mesh:ArtMesh_Square', layer: null });
    const e = await error(exportModel(g.session.doc, g.assets));
    expect(e.code).toBe('E_EXPORT');
    expect(
      (e.details!.problems as { code: string }[]).some((p) => p.code === 'mesh-without-layer'),
    ).toBe(true);

    const g2 = await golden1();
    await expect(exportModel(g2.session.doc, new MemoryAssetStore())).rejects.toMatchObject({
      code: 'E_ASSET_MISSING',
    });

    const g3 = await golden1();
    g3.session.run('mesh.moveUv', {
      target: '@mesh:ArtMesh_Square',
      vertices: [2],
      offset: [1100, 0],
    });
    const big = await error(exportModel(g3.session.doc, g3.assets));
    expect(big.message).toMatch(/more than an atlas page of 1024/);
    expect(big.fixes[0]).toMatchObject({
      command: 'project.setExportSettings',
      args: { atlasSize: 2048 },
    });
  });

  it('packs several layers, splits pages when needed, and bleeds edge colors', async () => {
    const g = await golden3();
    const r = await exportModel(g.session.doc, g.assets);
    expect(r.report.atlas.pages).toEqual([
      { file: 'golden3.1024/texture_00.png', width: 256, height: 64 },
    ]); // five regions, 220 px wide in all
    expect(r.report.atlas.regions).toHaveLength(5);
    const page = decodePng(r.files.get('golden3.1024/texture_00.png')!);
    // The blue "front" swatch's region: its 1-pixel transparent border took the blue of its neighbor.
    const region = r.report.atlas.regions.find((x) => x.name === 'front')!;
    const px = (x: number, y: number) =>
      Array.from(page.data.slice(4 * (y * page.width + x), 4 * (y * page.width + x) + 4));
    const inner = px(region.x + 4 + 1, region.y + 4 + 1);
    const border = px(region.x + 4, region.y + 4);
    expect(inner).toEqual([0, 0, 255, 255]);
    expect(border).toEqual([0, 0, 255, 0]);
    // Regions do not overlap.
    const rs = r.report.atlas.regions;
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i]!;
        const b = rs[j]!;
        const overlap =
          a.page === b.page &&
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    const small = await exportModel(g.session.doc, g.assets, { atlasSize: 1024 });
    expect(small.report.atlas.pages.length).toBe(1);
  });

  it('reports ids, counts, files with hashes, and the load check', async () => {
    const g = await golden3();
    const r = await exportModel(g.session.doc, g.assets);
    expect(r.report.format).toBe('mochi-maker-export');
    expect(Object.values(r.report.ids.artMeshes)).toEqual([
      'Back_A',
      'Back_B',
      'Front',
      'Tinted',
      'Blink',
    ]);
    expect(r.report.counts).toMatchObject({
      artMeshes: 5,
      parts: 2,
      warpDeformers: 1,
      glues: 1,
      drawOrderGroups: 3,
    });
    expect(r.report.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(r.report.loadCheck).toEqual({ drawables: 5, visibleAtDefault: 5, warnings: [] });
    expect(safeFileName('a/b:c')).toBe('a_b_c');
  });
});
