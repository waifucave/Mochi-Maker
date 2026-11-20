/**
 * Golden projects (design 7.2) and the round trip (design 7.3): export, load in Mochi2D, evaluate,
 * compare with values computed by hand.
 *
 * Set UPDATE_GOLDEN=1 to rewrite the committed golden projects and expected export hashes after a
 * deliberate change; the diff then shows what changed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, saveProject, sha256Hex } from '@mochi-maker/core';
import { exportModel } from '@mochi-maker/export';
import { readMoc } from 'mochi2d/headless';
import { GOLDENS, golden1, golden14, golden15, golden2, golden3, type Golden } from './golden.js';
import { decodePng } from '@mochi-maker/art';
import { evaluate, expectVertices, out, type Drawable } from './probe.js';

const DIR = join(import.meta.dirname, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

async function filesOf(fs: MemoryFileSystem, root: string): Promise<Map<string, Uint8Array>> {
  const outMap = new Map<string, Uint8Array>();
  for (const [path, bytes] of fs.files)
    if (path.startsWith(root + '/')) outMap.set(path.slice(root.length + 1), bytes);
  return outMap;
}

describe.each(GOLDENS.map((g) => [g.name, g] as const))('%s', (_name, build) => {
  it('builds the committed project, and exports the expected files deterministically', async () => {
    const g: Golden = await build();
    const fs = new MemoryFileSystem();
    await saveProject(fs, 'p', g.session.doc, g.assets);
    const built = await filesOf(fs, 'p');
    const dir = join(DIR, `${g.name}.mochi`);
    if (UPDATE) {
      rmSync(dir, { recursive: true, force: true });
      for (const [path, bytes] of built) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), bytes);
      }
    }
    const committed = new Map<string, Uint8Array>();
    const walk = (d: string, prefix: string) => {
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`);
        else committed.set(`${prefix}${e.name}`, new Uint8Array(readFileSync(join(d, e.name))));
    };
    walk(dir, '');
    expect([...committed.keys()].sort()).toEqual([...built.keys()].sort());
    for (const [path, bytes] of built)
      expect(Buffer.from(committed.get(path)!).equals(Buffer.from(bytes)), path).toBe(true);

    const a = await exportModel(g.session.doc, g.assets);
    const b = await exportModel(g.session.doc, g.assets);
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    for (const [path, bytes] of a.files)
      expect(Buffer.from(b.files.get(path)!).equals(Buffer.from(bytes)), path).toBe(true);
    expect(a.report.problems.filter((p) => p.severity === 'error')).toEqual([]);

    const hashes: Record<string, string> = {};
    for (const [path, bytes] of a.files) hashes[path] = await sha256Hex(bytes);
    const expectedPath = join(DIR, `${g.name}.export.json`);
    if (UPDATE || !existsSync(expectedPath))
      writeFileSync(
        expectedPath,
        JSON.stringify({ mocVersion: a.report.mocVersion, files: hashes }, null, 2) + '\n',
      );
    const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as {
      mocVersion: number;
      files: Record<string, string>;
    };
    expect({ mocVersion: a.report.mocVersion, files: hashes }).toEqual(expected);
  });
});

describe('round trip: export → Mochi2D → evaluate', () => {
  it('golden 1: keyforms interpolate positions and opacity', async () => {
    const g = await golden1();
    const r = await exportModel(g.session.doc, g.assets);
    for (const a of [0, 0.25, 1]) {
      const d = evaluate(r, 'golden1', { ParamA: a }).get('ArtMesh_Square')!;
      const x0 = 50 + 40 * a;
      expectVertices(d.vertices, [
        ...out(x0, 50, 200, 150, 400),
        ...out(x0 + 100, 50, 200, 150, 400),
        ...out(x0 + 100, 150, 200, 150, 400),
        ...out(x0, 150, 200, 150, 400),
      ]);
      expect(d.opacity).toBeCloseTo(1 - 0.5 * a, 6);
      expect(d.visible).toBe(true);
    }
    const settings = JSON.parse(new TextDecoder().decode(r.files.get('golden1.model3.json')));
    expect(settings.HitAreas).toEqual([{ Id: 'ArtMesh_Square', Name: 'Body' }]);
    expect(settings.FileReferences.Textures).toEqual(['golden1.1024/texture_00.png']);
  });

  it('golden 2: a rotation inside a warp, with the pixel-unit scale', async () => {
    const g = await golden2();
    const r = await exportModel(g.session.doc, g.assets);
    for (const [angle, shift] of [
      [0, 0],
      [15, 0.5],
      [-30, 1],
      [30, 0],
    ] as const) {
      const d = evaluate(r, 'golden2', { ParamAngle: angle, ParamShift: shift }).get(
        'ArtMesh_Head',
      )!;
      // The rotation origin: the warp's (0.5, 0.25) in canvas pixels, shifted with the grid.
      const ox = 100 + 0.5 * 200 + 20 * shift;
      const oy = 50 + 0.25 * 200;
      const t = (angle * Math.PI) / 180;
      const corners = [
        [-20, -10],
        [20, -10],
        [20, 10],
        [-20, 10],
      ] as const;
      // Children of a top rotation are in pixels: world = origin + R(θ)·p, in canvas pixels.
      const expected = corners.flatMap(([px, py]) =>
        out(
          ox + Math.cos(t) * px - Math.sin(t) * py,
          oy + Math.sin(t) * px + Math.cos(t) * py,
          200,
          200,
          400,
        ),
      );
      expectVertices(d.vertices, expected);
    }
  });

  it('golden 3: sorting scopes, draw order, colors, glue, masks and an early-ending binding', async () => {
    const g = await golden3();
    const r = await exportModel(g.session.doc, g.assets);
    const order = (m: Map<string, Drawable>) =>
      [...m.values()].sort((a, b) => a.renderOrder - b.renderOrder).map((d) => d.id);

    const rest = evaluate(r, 'golden3', { ParamOrder: 0 });
    expect(order(rest)).toEqual(['Back_A', 'Back_B', 'Tinted', 'Blink', 'Front']);
    const flipped = evaluate(r, 'golden3', { ParamOrder: 1 });
    // Part_Front sorts at 300; the inactive Blink sorts at the group minimum (300) after it.
    expect(order(flipped)).toEqual(['Front', 'Blink', 'Back_A', 'Back_B', 'Tinted']);
    expect(flipped.get('Blink')!.visible).toBe(false);
    expect(evaluate(r, 'golden3', { ParamOrder: 0.5 }).get('Blink')!.visible).toBe(true);

    const tinted = rest.get('Tinted')!;
    expectVertices(tinted.multiplyColor, [0.5, 0.5, 1, 1], 1e-6);
    expectVertices(tinted.screenColor, [0.2, 0.5, 0, 1], 1e-6);
    // Inside a 1 × 1 warp over (110, 110)–(160, 160): uv (0.2, 0.2) is canvas (120, 120).
    expectVertices(tinted.vertices.slice(0, 2), out(120, 120, 100, 100, 200));

    // Glue: Back_A vertex 1 (60, 20) and Back_B vertex 0 (70, 20) meet at (65, 20).
    const meet = out(65, 20, 100, 100, 200);
    expectVertices(rest.get('Back_A')!.vertices.slice(2, 4), meet);
    expectVertices(rest.get('Back_B')!.vertices.slice(0, 2), meet);

    // Masks and flags as written.
    const { data, version } = readMoc(r.files.get('golden3.moc3')!);
    expect(version).toBe(5);
    const idx = (id: string) => data.artMeshes.ids.indexOf(id);
    const masksOf = (id: string) => {
      const i = idx(id);
      return Array.from(
        data.maskEntries.slice(
          data.artMeshes.firstMask[i]!,
          data.artMeshes.firstMask[i]! + data.artMeshes.maskCount[i]!,
        ),
      ).map((m) => data.artMeshes.ids[m]);
    };
    expect(masksOf('Back_B')).toEqual(['Back_A']);
    expect(masksOf('Front')).toEqual(['Back_A']);
    expect(data.artMeshes.flags[idx('Front')]! & 8).toBe(8);
    expect(data.artMeshes.flags[idx('Back_B')]! & 8).toBe(0);
  });
});

describe('round trip: a re-imported project (golden 14)', () => {
  it('draws the moved meshes where they were, with the new pixels in the atlas', async () => {
    const g = await golden14();
    const r = await exportModel(g.session.doc, g.assets);
    const view = g.session.view;
    const ids = new Map(view.ofKind('artMesh').map((m) => [view.getAs(m.layer!, 'layer').name, m]));
    // Every mesh keeps its imported positions (they are in canvas pixels, without deformers).
    const drawn = evaluate(r, 'golden14');
    for (const [name, mesh] of ids) {
      const d = drawn.get(mesh.exportId)!;
      const px = Array.from(mesh.rig.keyforms[0]!.positions);
      d.vertices.forEach((v, i) =>
        expect(i % 2 === 0 ? v * 200 + 100 : -v * 200 + 75, `${name} vertex ${i >> 1}`).toBeCloseTo(
          px[i]!,
          3,
        ),
      );
    }
    // Mouth is new and not meshed; 目 is gone from the file but its mesh is still drawn.
    expect(ids.has('Mouth')).toBe(false);
    expect(drawn.has(ids.get('目')!.exportId)).toBe(true);
    // The atlas holds Body's new color.
    const region = r.report.atlas.regions.find((x) => x.name === 'Body')!;
    const page = decodePng(r.files.get(r.report.atlas.pages[region.page]!.file)!, 'atlas');
    const at =
      4 *
      ((region.y + Math.floor(region.height / 2)) * page.width +
        region.x +
        Math.floor(region.width / 2));
    expect(Array.from(page.data.subarray(at, at + 4))).toEqual([60, 160, 90, 255]);
  });
});

describe('round trip: nested deformers, reparented in place (golden 15)', () => {
  const o = (x: number, y: number) => out(x, y, 200, 200, 400);
  const rot = (deg: number, [x, y]: readonly [number, number]) => {
    const t = (deg * Math.PI) / 180;
    return [Math.cos(t) * x - Math.sin(t) * y, Math.sin(t) * x + Math.cos(t) * y] as const;
  };
  // Rotation_Head at rest: the outer warp's (0.5, 0.3) → (200, 140), angle 10°, scale 1.2.
  const head = (deg: number, p: readonly [number, number]) => {
    const [x, y] = rot(deg, p);
    return [200 + 1.2 * x, 140 + 1.2 * y] as const;
  };

  it('keeps the reparented mesh and rotation where they were, and the canvas edit lands', async () => {
    const g = await golden15();
    const r = await exportModel(g.session.doc, g.assets);
    const d = evaluate(r, 'golden15');
    // ArtMesh_Badge, now in Warp_Face, is still the 30 × 30 square at (185, 300).
    expectVertices(
      d.get('ArtMesh_Badge')!.vertices,
      [
        [185, 300],
        [215, 300],
        [215, 330],
        [185, 330],
      ].flatMap(([x, y]) => o(x!, y!)),
    );
    // ArtMesh_Hat, its rotation now under Rotation_Head: still (200, 100) ± 1.5 × (20, 10).
    expectVertices(
      d.get('ArtMesh_Hat')!.vertices,
      [
        [170, 85],
        [230, 85],
        [230, 115],
        [170, 115],
      ].flatMap(([x, y]) => o(x!, y!)),
    );
    // ArtMesh_Face: Warp_Face's corners through the head's frame; vertex 2 moved (10, 5) on canvas.
    const corners = [
      [-60, -40],
      [60, -40],
      [60, 40],
      [-60, 40],
    ] as const;
    const face = corners.map((c) => head(10, c));
    expectVertices(
      d.get('ArtMesh_Face')!.vertices,
      face.flatMap(([x, y], i) => (i === 2 ? o(x + 10, y + 5) : o(x, y))),
    );
  });

  it('moves the reparented rotation with its new parent', async () => {
    const g = await golden15();
    const r = await exportModel(g.session.doc, g.assets);
    const d = evaluate(r, 'golden15', { ParamAngle: 30 });
    // The head turns 30° more (to 40°) about (200, 140); the hat turns with it, keeping its own
    // frame relative to the head.
    const hat = [
      [170, 85],
      [230, 85],
      [230, 115],
      [170, 115],
    ].map(([x, y]) => {
      const [dx, dy] = rot(30, [x! - 200, y! - 140]);
      return o(200 + dx, 140 + dy);
    });
    expectVertices(d.get('ArtMesh_Hat')!.vertices, hat.flat());
  });
});
