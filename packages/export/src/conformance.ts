/**
 * The conformance pack (roadmap M12, design 7.5): for each project and each target version, the
 * exported model folder, scenario files in Mochi2D's catalog formats (`mochi2d-scenario/0` static
 * poses and `mochi2d-anim-scenario/0` animations), Mochi2D's results for them, a coverage table of
 * the writer's paths, and a manifest with every file's SHA-256. Another implementation can run the same
 * scenarios through its own runtime and compare, as a black box.
 *
 * Static poses exercise every parameter and binding: the default pose, each key of each parameter,
 * the midpoints between neighbouring keys, values below and above the range, every cell of each
 * object bound to two or more parameters (and each cell's centre), part opacities at one half, and
 * random poses from a fixed seed. Renders: the default pose, and the first few random poses
 * (`render.random.<seed>.<i>`). Animations run where the project has them: each motion, each
 * expression, physics (with wind), and the pose, at 30 frames a second.
 */
import { DocView, sha256Hex, type AssetStore, type Document, VERSION } from '@mochi-maker/core';
import { MOCHI2D_VERSION, formatResultJson, readMoc, scenarioResult } from 'mochi2d/headless';
import { exportModel, type ExportResult } from './export.js';

export const PACK_FORMAT = 'mochi-maker-conformance-pack';
export const STATIC_FORMAT = 'mochi2d-scenario/0';
export const ANIM_FORMAT = 'mochi2d-anim-scenario/0';

export interface PackProject {
  /** The folder name in the pack (the project's name). */
  name: string;
  doc: Document;
  assets: AssetStore;
}

export interface PackOptions {
  versions?: readonly (3 | 4 | 5 | 6)[];
  /** Seed of the random poses (default 1). */
  seed?: number;
  /** Random poses per project and version (default 8). */
  randomPoses?: number;
  /** How many of the random poses also get a render scenario (default 3, at most `randomPoses`). */
  renderPoses?: number;
  /** The `producer` written into the manifest. */
  producer?: string;
}

export interface PackEntry {
  project: string;
  version: 3 | 4 | 5 | 6;
  /** Exported, or why not (a feature the version cannot carry, or an export error). */
  status: 'exported' | 'skipped';
  reason?: string;
  /** The settings file, relative to the pack root (scenarios name it as their `model`). */
  model?: string;
  scenarios: { id: string; kind: 'static' | 'animation'; file: string; result: string }[];
  /**
   * The render scenario (the default pose with a `render` block), and once `renderPack` ran, its
   * PNG and `.render.json`.
   */
  render?: PackRender;
  /** The render scenarios at random poses, rendered like `render`. */
  renders?: PackRender[];
  /** Mochi2D errors in its own results (should be none). */
  errors: string[];
  /** The writer paths this entry exercises (see COVERAGE). */
  covers: string[];
}

export interface PackRender {
  id: string;
  png?: string;
  json?: string;
  error?: string;
}

export interface PackManifest {
  format: typeof PACK_FORMAT;
  version: 1;
  producer: string;
  mochi2d: string;
  seed: number;
  entries: PackEntry[];
  /** Writer path → entries ("project v5") that exercise it. */
  coverage: Record<string, string[]>;
  files: { path: string; bytes: number; sha256: string }[];
}

export interface Pack {
  files: Map<string, Uint8Array>;
  manifest: PackManifest;
}

type Data = Record<string, Record<string, ArrayLike<number>> | ArrayLike<number>>;
const count = (d: Data, section: string): number => {
  const s = d[section];
  if (!s) return 0;
  if ('length' in s && typeof s.length === 'number') return s.length;
  const first = Object.values(s as Record<string, ArrayLike<number>>)[0];
  return first?.length ?? 0;
};
const field = (d: Data, section: string, f: string): ArrayLike<number> =>
  ((d[section] as Record<string, ArrayLike<number>> | undefined)?.[f] ?? []) as ArrayLike<number>;
const some = (a: ArrayLike<number>, p: (x: number) => boolean) => Array.from(a).some(p);

/**
 * The writer's paths and how to tell that an export exercises one: from the `.moc3`'s sections
 * (read back with Mochi2D's `readMoc`) and the other files.
 */
export const COVERAGE: { path: string; test: (d: Data, files: string[], v: number) => boolean }[] =
  [
    { path: 'moc: parts', test: (d) => count(d, 'parts') > 0 },
    {
      path: 'moc: part tree (nested parts)',
      test: (d) => some(field(d, 'parts', 'parent'), (x) => x >= 0),
    },
    { path: 'moc: art meshes', test: (d) => count(d, 'artMeshes') > 0 },
    { path: 'moc: masks', test: (d) => count(d, 'maskEntries') > 0 },
    {
      path: 'moc: additive blending',
      test: (d) => some(field(d, 'artMeshes', 'flags'), (x) => (x & 1) !== 0),
    },
    {
      path: 'moc: multiplicative blending',
      test: (d) => some(field(d, 'artMeshes', 'flags'), (x) => (x & 2) !== 0),
    },
    {
      path: 'moc: single-sided meshes',
      test: (d) => some(field(d, 'artMeshes', 'flags'), (x) => (x & 4) === 0),
    },
    {
      path: 'moc: inverted masks',
      test: (d) => some(field(d, 'artMeshes', 'flags'), (x) => (x & 8) !== 0),
    },
    { path: 'moc: warp deformers', test: (d) => count(d, 'warpDeformers') > 0 },
    { path: 'moc: rotation deformers', test: (d) => count(d, 'rotationDeformers') > 0 },
    {
      path: 'moc: nested deformers',
      test: (d) => some(field(d, 'deformers', 'parent'), (x) => x >= 0),
    },
    {
      path: 'moc: rotation mirror flags',
      test: (d) =>
        some(field(d, 'rotationKeyforms', 'mirrorX'), (x) => x !== 0) ||
        some(field(d, 'rotationKeyforms', 'mirrorY'), (x) => x !== 0),
    },
    { path: 'moc: glues', test: (d) => count(d, 'glues') > 0 },
    { path: 'moc: keyform bindings', test: (d) => count(d, 'parameterBindings') > 0 },
    {
      path: 'moc: objects bound to two or more parameters',
      test: (d) => some(field(d, 'bands', 'entryCount'), (x) => x >= 2),
    },
    {
      path: 'moc: repeating parameters',
      test: (d) => some(field(d, 'parameters', 'repeat'), (x) => x !== 0),
    },
    { path: 'moc: nested draw-order groups', test: (d) => count(d, 'drawOrderGroups') > 1 },
    {
      path: 'moc v4: multiply and screen colors',
      test: (d, _f, v) =>
        v >= 4 &&
        (some(field(d, 'multiplyColors', 'r'), (x) => x !== 1) ||
          some(field(d, 'screenColors', 'r'), (x) => x !== 0)),
    },
    { path: 'moc v4: parameter key lists', test: (_d, _f, v) => v >= 4 },
    {
      path: 'moc v4: blend-shape parameters',
      test: (d, _f, v) => v >= 4 && some(field(d, 'parameters', 'type'), (x) => x === 1),
    },
    {
      path: 'moc v4: art mesh blend shapes',
      test: (d, _f, v) => v >= 4 && count(d, 'artMeshBlendShapeTargets') > 0,
    },
    {
      path: 'moc v4: warp blend shapes',
      test: (d, _f, v) => v >= 4 && count(d, 'warpBlendShapeTargets') > 0,
    },
    {
      path: 'moc v4: blend-shape constraints',
      test: (d, _f, v) => v >= 4 && count(d, 'blendShapeConstraints') > 0,
    },
    {
      path: 'moc v5: keyform color indices',
      test: (d, _f, v) => v >= 5 && count(d, 'artMeshKeyforms') > 0,
    },
    {
      path: 'moc v5: part blend shapes',
      test: (d, _f, v) => v >= 5 && count(d, 'partBlendShapeTargets') > 0,
    },
    {
      path: 'moc v5: rotation blend shapes',
      test: (d, _f, v) => v >= 5 && count(d, 'rotationBlendShapeTargets') > 0,
    },
    {
      path: 'moc v5: glue blend shapes',
      test: (d, _f, v) => v >= 5 && count(d, 'glueBlendShapeTargets') > 0,
    },
    { path: 'moc v6: offscreens', test: (d, _f, v) => v >= 6 && count(d, 'offscreens') > 0 },
    {
      path: 'moc v6: offscreen masks',
      test: (d, _f, v) => v >= 6 && some(field(d, 'offscreens', 'maskCount'), (x) => x > 0),
    },
    {
      path: 'moc v6: offscreen blend shapes',
      test: (d, _f, v) => v >= 6 && count(d, 'offscreenBlendShapeTargets') > 0,
    },
    {
      path: 'moc v6: art-mesh blend modes',
      test: (d, _f, v) =>
        v >= 6 && some(field(d, 'artMeshes', 'blendMode'), (x) => (x & 255) > 2 || x > 255),
    },
    {
      path: 'moc v6: offscreen blend modes',
      test: (d, _f, v) => v >= 6 && some(field(d, 'offscreens', 'blendMode'), (x) => x !== 0),
    },
    { path: 'file: model settings', test: (_d, f) => f.some((x) => x.endsWith('.model3.json')) },
    { path: 'file: display info', test: (_d, f) => f.some((x) => x.endsWith('.cdi3.json')) },
    { path: 'file: textures', test: (_d, f) => f.some((x) => x.endsWith('.png')) },
    { path: 'file: user data', test: (_d, f) => f.some((x) => x.endsWith('.userdata3.json')) },
    { path: 'file: physics', test: (_d, f) => f.some((x) => x.endsWith('.physics3.json')) },
    {
      path: 'file: motion sync',
      test: (_d, f) => f.some((x) => x.endsWith('.motionsync3.json')),
    },
    { path: 'file: pose', test: (_d, f) => f.some((x) => x.endsWith('.pose3.json')) },
    { path: 'file: expressions', test: (_d, f) => f.some((x) => x.endsWith('.exp3.json')) },
    { path: 'file: motions', test: (_d, f) => f.some((x) => x.endsWith('.motion3.json')) },
    { path: 'file: sounds', test: (_d, f) => f.some((x) => x.endsWith('.wav')) },
  ];

/** A small, fixed pseudo-random generator (mulberry32), so a seed gives the same poses anywhere. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

interface Pose {
  label: string;
  parameters: Record<string, number>;
  partOpacities: Record<string, number>;
}

/** The static poses of a project (see the module comment). */
export function staticPoses(document: Document, seed: number, randomPoses: number): Pose[] {
  const v = new DocView(document);
  const params = v.project().parameterOrder.map((u) => v.getAs(u, 'parameter'));
  const poses: Pose[] = [{ label: 'default', parameters: {}, partOpacities: {} }];
  const one = (label: string, id: string, value: number) =>
    poses.push({ label, parameters: { [id]: round6(value) }, partOpacities: {} });
  for (const p of params) {
    const keys = [...new Set([...p.keys].sort((a, b) => a - b))];
    keys.forEach((k, i) => one(`key.${p.exportId}.${i}`, p.exportId, k));
    for (let i = 0; i + 1 < keys.length; i++)
      one(`mid.${p.exportId}.${i}`, p.exportId, (keys[i]! + keys[i + 1]!) / 2);
    const span = Math.max(p.max - p.min, 1);
    one(`low.${p.exportId}`, p.exportId, p.min - span / 2);
    one(`high.${p.exportId}`, p.exportId, p.max + span / 2);
  }
  // Every cell (and cell centre) of objects bound to two or more parameters.
  const seen = new Set<string>();
  for (const o of v.all()) {
    const rig = (o as { rig?: { bindings: { parameter: string; keys: number[] }[] } }).rig;
    if (!rig || rig.bindings.length < 2) continue;
    const name = 'exportId' in o ? (o as { exportId: string }).exportId : o.uid;
    const axes = rig.bindings.map((b) => ({
      id: v.getAs(b.parameter, 'parameter').exportId,
      keys: b.keys,
    }));
    const cells: number[][] = [[]];
    for (const a of axes) {
      const next: number[][] = [];
      for (const c of cells) for (let i = 0; i < a.keys.length; i++) next.push([...c, i]);
      cells.splice(0, cells.length, ...next);
    }
    cells.slice(0, 64).forEach((c, n) => {
      const at = Object.fromEntries(axes.map((a, j) => [a.id, a.keys[c[j]!]!]));
      const key = JSON.stringify(at);
      if (!seen.has(key)) {
        seen.add(key);
        poses.push({ label: `cell.${name}.${n}`, parameters: at, partOpacities: {} });
      }
      if (axes.every((a, j) => c[j]! + 1 < a.keys.length))
        poses.push({
          label: `centre.${name}.${n}`,
          parameters: Object.fromEntries(
            axes.map((a, j) => [a.id, round6((a.keys[c[j]!]! + a.keys[c[j]! + 1]!) / 2)]),
          ),
          partOpacities: {},
        });
    });
  }
  const parts = v.ofKind('part');
  if (parts.length)
    poses.push({
      label: 'parts.half',
      parameters: {},
      partOpacities: Object.fromEntries(parts.map((p) => [p.exportId, 0.5])),
    });
  const rnd = seeded(seed);
  for (let i = 0; i < randomPoses; i++)
    poses.push({
      label: `random.${seed}.${i}`,
      parameters: Object.fromEntries(
        params.map((p) => {
          const span = p.max - p.min;
          return [p.exportId, round6(p.min - span / 4 + rnd() * span * 1.5)];
        }),
      ),
      partOpacities: Object.fromEntries(parts.map((p) => [p.exportId, round6(rnd())])),
    });
  return poses;
}

interface Anim {
  label: string;
  body: Record<string, unknown>;
}

/** The animations of a project and its export: motions, expressions, physics, pose. */
function animations(
  document: Document,
  settings: Record<string, unknown>,
  files: string[],
): Anim[] {
  const v = new DocView(document);
  const has = (ext: string) => files.some((f) => f.endsWith(ext));
  const physics = has('.physics3.json');
  const pose = has('.pose3.json');
  const effects = (on: Partial<Record<string, boolean>>) => ({
    idle: false,
    blink: false,
    breath: false,
    look: false,
    lipsync: false,
    expressions: false,
    physics,
    pose,
    ...on,
  });
  const record = { parameters: 'all', parts: 'all', every: 1 };
  const out: Anim[] = [];
  const refs = (settings.FileReferences ?? {}) as {
    Motions?: Record<string, { File: string }[]>;
    Expressions?: { Name: string; File: string }[];
  };
  for (const [group, list] of Object.entries(refs.Motions ?? {}))
    list.forEach((_, index) => {
      const m = v.ofKind('motion').filter((x) => x.group === group)[index];
      const frames = Math.min(150, Math.ceil(((m?.duration ?? 2) + 0.5) * 30));
      out.push({
        label: `motion.${group}.${index}`,
        body: {
          dt: 1 / 30,
          frames,
          effects: effects({ lipsync: has('.wav') }),
          commands: [{ frame: 0, do: 'motion', group, index, priority: 2 }],
          record,
        },
      });
    });
  for (const e of refs.Expressions ?? [])
    out.push({
      label: `expression.${e.Name}`,
      body: {
        dt: 1 / 30,
        frames: 45,
        effects: effects({ expressions: true }),
        commands: [{ frame: 0, do: 'expression', name: e.Name }],
        record,
      },
    });
  if (physics)
    out.push({
      label: 'physics.wind',
      body: {
        dt: 1 / 30,
        frames: 60,
        effects: effects({}),
        options: { wind: [0.5, 0], gravity: [0.2, -1] },
        record,
      },
    });
  if (pose) {
    const groups = v.project().pose.groups;
    const parts = groups.flatMap((g) => g.map((x) => v.getAs(x.part, 'part').exportId));
    if (parts.length) {
      const [a, b] = [groups[0]![0]!, groups[0]![1] ?? groups[0]![0]!];
      const ida = v.getAs(a.part, 'part').exportId;
      const idb = v.getAs(b.part, 'part').exportId;
      out.push({
        label: 'pose.switch',
        body: {
          dt: 1 / 30,
          frames: 45,
          effects: effects({}),
          commands: [
            { frame: 0, do: 'partOpacity', id: ida, value: 1 },
            { frame: 0, do: 'partOpacity', id: idb, value: 0 },
            { frame: 15, do: 'partOpacity', id: ida, value: 0 },
            { frame: 15, do: 'partOpacity', id: idb, value: 1 },
          ],
          record,
        },
      });
    }
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

async function fileList(files: Map<string, Uint8Array>): Promise<PackManifest['files']> {
  const list: PackManifest['files'] = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    list.push({ path, bytes: bytes.length, sha256: await sha256Hex(bytes) });
  return list;
}

/** The size of the render scenarios: square, the canvas fitted in (the render block's default). */
export const RENDER_SIZE = { width: 512, height: 512 } as const;

/**
 * Renders a model's files at a pose (the default pose when `pose` is left out or empty), as the
 * reference render of Mochi2D's `NodeRenderer`.
 */
export interface PackRenderer {
  readonly producer: string;
  render(
    files: ReadonlyMap<string, Uint8Array>,
    settings: string,
    size: { width: number; height: number },
    pose?: { parameters: Record<string, number>; partOpacities: Record<string, number> },
  ): Promise<{
    png: Uint8Array;
    width: number;
    height: number;
    pixelsPerUnit: number;
    center: [number, number];
    /** The WebGL renderer string (SwiftShader for reference renders). */
    renderer: string;
    /** A reference render: the configuration whose masks `REFERENCE_MASKS` describes. */
    reference: boolean;
    notes: string[];
  }>;
}

export const RENDER_FORMAT = 'mochi2d-render/0';
/** The masks of a reference render (Mochi2D's render tool). */
export const REFERENCE_MASKS = {
  mode: 'per-drawable',
  size: 4096,
  offscreenSize: 256,
  meshes: 'all',
} as const;

/**
 * Adds the renders: for each render scenario of each export (the default pose and the random
 * poses), at the scenario's pose, `renders/<id>.png` (premultiplied alpha) and
 * `renders/<id>.render.json` in the shape Mochi2D's render tool writes (`mochi2d-render/0`):
 * `format`, `scenario`, `producer`, `error`, `png`, `alpha`, `width`, `height`, `renderer`,
 * `pixelsPerUnit`, `center`, `masks` (for reference renders) and `notes`. Left out: `stats`
 * (informational; `NodeRenderer` does not report it) and `milliseconds` (it would make the pack
 * differ from run to run).
 */
export async function renderPack(pack: Pack, renderer: PackRenderer): Promise<Pack> {
  for (const e of pack.manifest.entries) {
    if (e.status !== 'exported' || !e.render || !e.model) continue;
    const base = e.model.slice(0, e.model.indexOf('/model/'));
    const prefix = `${base}/model/`;
    const files = new Map(
      [...pack.files]
        .filter(([p]) => p.startsWith(prefix))
        .map(([p, b]) => [p.slice(prefix.length), b]),
    );
    e.render = await renderOne(pack, renderer, base, files, e.model.slice(prefix.length), e.render);
    if (e.renders)
      for (let i = 0; i < e.renders.length; i++)
        e.renders[i] = await renderOne(
          pack,
          renderer,
          base,
          files,
          e.model.slice(prefix.length),
          e.renders[i]!,
        );
  }
  pack.manifest.files = await fileList(pack.files);
  return pack;
}

/** One render scenario: its PNG and `.render.json` into the pack, at the scenario's own pose. */
async function renderOne(
  pack: Pack,
  renderer: PackRenderer,
  base: string,
  files: Map<string, Uint8Array>,
  settings: string,
  r: PackRender,
): Promise<PackRender> {
  const id = r.id;
  const scenario = pack.files.get(`${base}/scenarios/${id}.json`);
  const pose = scenario
    ? (JSON.parse(new TextDecoder().decode(scenario)) as {
        parameters?: Record<string, number>;
        partOpacities?: Record<string, number>;
      })
    : {};
  const json = `${base}/renders/${id}.render.json`;
  const out: Record<string, unknown> = {
    format: RENDER_FORMAT,
    scenario: id,
    producer: renderer.producer,
  };
  let result: PackRender;
  try {
    const img = await renderer.render(files, settings, RENDER_SIZE, {
      parameters: pose.parameters ?? {},
      partOpacities: pose.partOpacities ?? {},
    });
    const png = `${base}/renders/${id}.png`;
    pack.files.set(png, img.png);
    Object.assign(out, {
      error: null,
      png: `${id}.png`,
      alpha: 'premultiplied',
      width: img.width,
      height: img.height,
      renderer: img.renderer,
      pixelsPerUnit: img.pixelsPerUnit,
      center: img.center,
      ...(img.reference ? { masks: REFERENCE_MASKS } : {}),
      notes: img.notes,
    });
    result = { id, png, json };
  } catch (err) {
    const kind = (err as Error).name || 'Error';
    Object.assign(out, { error: { kind, message: (err as Error).message }, png: null });
    result = { id, json, error: `${kind}: ${(err as Error).message}` };
  }
  pack.files.set(json, text(JSON.stringify(out, null, 2) + '\n'));
  return result;
}

/** Builds the pack in memory: file paths (relative to the pack root) to bytes, and the manifest. */
export async function conformancePack(
  projects: PackProject[],
  options: PackOptions = {},
): Promise<Pack> {
  const versions = options.versions ?? [3, 4, 5, 6];
  const seed = options.seed ?? 1;
  const randomPoses = options.randomPoses ?? 8;
  const renderPoses = Math.min(options.renderPoses ?? 3, randomPoses);
  const producer = options.producer ?? `@mochi-maker/export ${VERSION}`;
  const files = new Map<string, Uint8Array>();
  const entries: PackEntry[] = [];
  for (const project of projects) {
    for (const version of versions) {
      const base = `${safe(project.name)}/v${version}`;
      const entry: PackEntry = {
        project: project.name,
        version,
        status: 'skipped',
        scenarios: [],
        errors: [],
        covers: [],
      };
      entries.push(entry);
      let r: ExportResult;
      try {
        r = await exportModel(project.doc, project.assets, { mocVersion: version });
      } catch (e) {
        entry.reason = (e as Error).message;
        continue;
      }
      entry.status = 'exported';
      const names = [...r.files.keys()];
      for (const [path, bytes] of r.files) files.set(`${base}/model/${path}`, bytes);
      const settingsPath = names.find((n) => n.endsWith('.model3.json'))!;
      entry.model = `${base}/model/${settingsPath}`;
      const dir = settingsPath.includes('/')
        ? settingsPath.slice(0, settingsPath.lastIndexOf('/') + 1)
        : '';
      const mocPath = names.find((n) => n.endsWith('.moc3'))!;
      const mocBytes = r.files.get(mocPath)!;
      const model = {
        moc: mocBytes,
        settings: r.files.get(settingsPath)!,
        read: (p: string) => r.files.get(dir + p),
      };
      const { data } = readMoc(mocBytes);
      entry.covers = COVERAGE.filter((c) => c.test(data as unknown as Data, names, version)).map(
        (c) => c.path,
      );
      const write = (
        id: string,
        kind: 'static' | 'animation',
        scenario: Record<string, unknown>,
      ) => {
        const file = `${base}/scenarios/${id}.json`;
        const result = `${base}/results/${id}.result.json`;
        files.set(file, text(JSON.stringify(scenario, null, 2) + '\n'));
        const res = scenarioResult(model, scenario, { producer: `mochi2d@${MOCHI2D_VERSION}` });
        if (res.error) entry.errors.push(`${id}: ${res.error.kind}: ${res.error.message}`);
        files.set(
          result,
          text(formatResultJson(res, '  ', kind === 'animation' ? 'double' : 'float32') + '\n'),
        );
        entry.scenarios.push({ id, kind, file, result });
      };
      const id = (label: string) => safe(`${project.name}.v${version}.${label}`);
      // The render scenario: the default pose, rendered at RENDER_SIZE, fitting the canvas.
      write(id('render.default'), 'static', {
        format: STATIC_FORMAT,
        id: id('render.default'),
        model: entry.model,
        parameters: {},
        partOpacities: {},
        render: { ...RENDER_SIZE },
      });
      entry.render = { id: id('render.default') };
      const poses = staticPoses(project.doc, seed, randomPoses);
      // Render scenarios at the first random poses, so renders cover more than the default pose.
      entry.renders = [];
      for (const pose of poses.filter((p) => p.label.startsWith('random.')).slice(0, renderPoses)) {
        const rid = id(`render.${pose.label}`);
        write(rid, 'static', {
          format: STATIC_FORMAT,
          id: rid,
          model: entry.model,
          parameters: pose.parameters,
          partOpacities: pose.partOpacities,
          render: { ...RENDER_SIZE },
        });
        entry.renders.push({ id: rid });
      }
      for (const pose of poses)
        write(id(pose.label), 'static', {
          format: STATIC_FORMAT,
          id: id(pose.label),
          model: entry.model,
          parameters: pose.parameters,
          partOpacities: pose.partOpacities,
        });
      const settings = JSON.parse(new TextDecoder().decode(r.files.get(settingsPath)!));
      for (const a of animations(project.doc, settings, names))
        write(id(a.label), 'animation', {
          format: ANIM_FORMAT,
          id: id(a.label),
          model: entry.model,
          random: [],
          ...a.body,
        });
    }
  }
  const coverage: Record<string, string[]> = {};
  for (const c of COVERAGE)
    coverage[c.path] = entries
      .filter((e) => e.covers.includes(c.path))
      .map((e) => `${e.project} v${e.version}`);
  const list = await fileList(files);
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    version: 1,
    producer,
    mochi2d: MOCHI2D_VERSION,
    seed,
    entries,
    coverage,
    files: list,
  };
  return { files, manifest };
}

/** The first feature an export refusal names ("mesh_0012 (Tinted) uses …"), or its first sentence. */
function blocker(reason: string): string {
  const m = /(\S+ \([^)]*\) uses [^;]+)/.exec(reason);
  return m ? `${reason.split('. ')[0]}: ${m[1]}` : reason.split('. ')[0]!;
}

/** The pack's README: what is in it, how to run it through another runtime, and how to compare. */
export function packReadme(m: PackManifest): string {
  const exported = m.entries.filter((e) => e.status === 'exported');
  const renders =
    exported.filter((e) => e.render?.png).length +
    exported.reduce((s, e) => s + (e.renders ?? []).filter((r) => r.png).length, 0);
  const poseRenders = exported[0]?.renders?.length ?? 0;
  const skipped = m.entries.filter((e) => e.status === 'skipped');
  const n = (k: 'static' | 'animation') =>
    exported.reduce((s, e) => s + e.scenarios.filter((x) => x.kind === k).length, 0);
  const lines = [
    '# Mochi Maker conformance pack',
    '',
    `Written by ${m.producer}, with results from Mochi2D ${m.mochi2d}; random poses from seed ${m.seed}.`,
    '',
    `${exported.length} exports (${m.entries.length - skipped.length} of ${m.entries.length} project × version pairs), ${n('static')} static and ${n('animation')} animation scenarios.`,
    '',
    '## Layout',
    '',
    '```',
    '<project>/v<3|4|5|6>/model/      the exported model folder (.moc3, model3.json, textures, …)',
    '<project>/v<3|4|5|6>/scenarios/  <id>.json: mochi2d-scenario/0 and mochi2d-anim-scenario/0',
    "<project>/v<3|4|5|6>/results/    <id>.result.json: Mochi2D's results for them",
    "<project>/v<3|4|5|6>/renders/    <id>.png and <id>.render.json: Mochi2D's renders of the render.* scenarios",
    "manifest.json                    every entry, its scenarios, the coverage, every file's SHA-256",
    '```',
    '',
    "Each scenario's `model` is its settings file relative to this folder: use this folder as the",
    'models root. Scenario IDs are unique across the pack, so results pair by ID.',
    '',
    '## Scenarios',
    '',
    '- Static (`mochi2d-scenario/0`): `default`; `key.<P>.<i>` each key of each parameter;',
    '  `mid.<P>.<i>` midpoints between neighbouring keys; `low.<P>` and `high.<P>` half a range',
    '  below and above; `cell.<O>.<n>` every cell of an object bound to two or more parameters and',
    "  `centre.<O>.<n>` each cell's centre; `parts.half` all part opacities 0.5; `random.<seed>.<i>`",
    '  every parameter (a quarter range beyond each end) and part opacity at random.',
    '- Animation (`mochi2d-anim-scenario/0`, 30 frames a second, no random numbers; eye blink,',
    '  breath, look and idle off; physics and pose on where the model has them):',
    '  `motion.<group>.<i>` each motion; `expression.<name>` each expression; `physics.wind` wind',
    '  (0.5, 0) and gravity (0.2, −1); `pose.switch` part opacities switching the first pose group.',
    '',
    '## Comparing results',
    '',
    '1. Reference results can come from any set in the same result formats (`mochi2d-result/0`,',
    '   `mochi2d-anim-result/0`): one `<id>.result.json` per scenario under `*/v*/scenarios/`, with',
    '   this folder as the models root, in one folder, for example `reference/`.',
    "2. Mochi2D's judge (in the Mochi2D repository) pairs them with this pack's results by ID and",
    '   applies the tolerances of §4l:',
    '',
    '   ```',
    '   npm run judge -- reference/ <this folder>',
    '   ```',
    '',
    '   It reads every `*.result.json` below both folders and exits 0 when every scenario passes.',
    '',
    ...(renders
      ? [
          `## Renders`,
          '',
          `Each export has render scenarios: \`render.default\`, the default pose, and ${poseRenders} at random poses, \`render.random.<seed>.<i>\`, at the same parameter values and part opacities as the static \`random.<seed>.<i>\`. Each has a \`render\` block of ${RENDER_SIZE.width} × ${RENDER_SIZE.height}, the canvas fitted in. \`<project>/v<N>/renders/\` holds Mochi2D's reference render of each (Mochi2D's \`NodeRenderer\`: headless Chromium, SwiftShader): \`<id>.png\` with premultiplied alpha, and \`<id>.render.json\`. ${renders} renders in all.`,
          '',
          "The `.render.json` files have the shape of Mochi2D's render tool (`mochi2d-render/0`): `format`, `scenario`, `producer`, `error`, `png`, `alpha`, `width`, `height`, `renderer`, `pixelsPerUnit`, `center`, `masks` and `notes`. They leave out `stats`, which is informational, and `milliseconds`.",
        ]
      : [
          'Each export has render scenarios (`render.default`, and `render.random.<seed>.<i>` at random poses), but this pack holds no renders of them.',
        ]),
    '',
    '## Exports not made',
    '',
    ...(skipped.length
      ? skipped.map((e) => `- ${e.project} v${e.version}: ${blocker(e.reason ?? '')}.`)
      : ['None.']),
    '',
    "## Coverage of the writer's paths",
    '',
    '| Path | Exports |',
    '|---|---|',
    ...Object.entries(m.coverage).map(
      ([path, list]) => `| ${path} | ${list.length ? list.join(', ') : '**none**'} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
