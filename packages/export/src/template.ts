/**
 * Model templates (a familiar workflow for moving a finished rig onto new art). A
 * template is a finished project's rig, to put on new art: its parts, deformer structure and
 * parameters with their keyforms, and optionally its physics, with a name, a description, an author
 * and a thumbnail. The file is Mochi Maker's own: a zip (`.mochitemplate`) holding `template.json`,
 * `thumbnail.png` and the template project's files under `project/`.
 *
 * Applying a template to target art meshes (`modelTemplate.apply`, one transaction):
 *
 * 1. **Layout.** Template canvas pixels map to the target's by a scale and an offset (default: the
 *    template's art fitted onto the targets' art, centered).
 * 2. **Matching** (`matchTemplate`): equal names first (export ID or display name, ignoring case,
 *    `ArtMesh_` and punctuation), then by position and shape (the art's laid-out bounding boxes:
 *    center distance, size ratios and overlap), greedily, cheapest first. Pairs can be corrected.
 * 3. **Parameters** the matched template meshes and their deformers use are merged into the
 *    target's parameters of the same export ID (their keys added), or added as new ones.
 * 4. **Deformers**: the template meshes' deformer chains are created, with every keyform; points at
 *    the top level are laid out like the art, points inside a rotation are scaled, points inside a
 *    warp stay (they are relative to it).
 * 5. **Meshes**: each target mesh is moved into its template mesh's deformer, keeping its place
 *    (mesh.reparent), and takes the template mesh's bindings. Each keyform's shape is the target's
 *    rest shape plus the template mesh's change from its rest form, carried over by barycentric
 *    weights in the template mesh (or vertex by vertex, when the target is re-divided like the
 *    template mesh). Opacity and colors come along; draw order, masks, culling and blending as the
 *    options say.
 * 6. **Physics** settings whose parameters all came along are merged by name, or added.
 *
 * Not carried: blend shapes and glue (not available in this build), parts (the target keeps its
 * own part tree), motions. Label colors are not carried either: Mochi Maker has none.
 */
import { Type, type Static } from '@sinclair/typebox';
import { unzipSync, zipSync } from 'fflate';
import {
  DocView,
  MemoryAssetStore,
  MemoryFileSystem,
  MochiError,
  defineOperation,
  loadProject,
  rig as grid,
  saveProject,
  type ArtMesh,
  type AssetStore,
  type DocObject,
  type DocReader,
  type Document,
  type OperationContext,
  type PhysicsSetting,
  type Rotation,
  type Tx,
  type Uid,
  type Warp,
} from '@mochi-maker/core';
import { meshReparent } from './reparent.js';

export const TEMPLATE_FORMAT = 'mochi-maker-template';
export const TEMPLATE_EXTENSION = '.mochitemplate';

export interface TemplateMeta {
  format: typeof TEMPLATE_FORMAT;
  version: 1;
  name: string;
  description: string;
  author: string;
  created: string;
  includes: { physics: boolean; motionSync?: boolean };
  counts: {
    meshes: number;
    deformers: number;
    parameters: number;
    physics: number;
    motionSync?: number;
  };
}

export interface LoadedTemplate {
  meta: TemplateMeta;
  doc: Document;
  assets: MemoryAssetStore;
  thumbnail: Uint8Array | null;
}

/** The template's files (path → bytes): `template.json`, `thumbnail.png`, `project/…`. */
export async function exportTemplate(
  doc: Document,
  assets: AssetStore,
  o: {
    name: string;
    description?: string;
    author?: string;
    thumbnail?: Uint8Array | null;
    physics?: boolean;
    /** Include the motion-sync settings (default true). */
    motionSync?: boolean;
    created?: string;
  },
): Promise<Map<string, Uint8Array>> {
  const physics = o.physics ?? true;
  const motionSync = o.motionSync ?? true;
  let d = doc;
  if (!physics || !motionSync) {
    const objects: Record<Uid, DocObject> = {};
    for (const [u, x] of Object.entries(doc.objects))
      if (
        !(x.kind === 'physicsSetting' && !physics) &&
        !(x.kind === 'motionSyncSetting' && !motionSync)
      )
        objects[u] = x;
    const p = objects.project as DocObject & { physicsOrder: Uid[]; motionSyncOrder: Uid[] };
    objects.project = {
      ...p,
      physicsOrder: physics ? p.physicsOrder : [],
      motionSyncOrder: motionSync ? p.motionSyncOrder : [],
    } as DocObject;
    d = { ...doc, objects };
  }
  const v = new DocView(d);
  const fs = new MemoryFileSystem();
  await saveProject(fs, 'project', d, assets);
  const files = new Map<string, Uint8Array>();
  for (const [p, b] of fs.files) if (p.startsWith('project/')) files.set(p, b);
  const meta: TemplateMeta = {
    format: TEMPLATE_FORMAT,
    version: 1,
    name: o.name,
    description: o.description ?? '',
    author: o.author ?? '',
    created: o.created ?? new Date().toISOString(),
    includes: { physics, motionSync },
    counts: {
      meshes: v.ofKind('artMesh').length,
      deformers: v.ofKind(['warp', 'rotation']).length,
      parameters: v.ofKind('parameter').length,
      physics: v.ofKind('physicsSetting').length,
      motionSync: v.ofKind('motionSyncSetting').length,
    },
  };
  files.set('template.json', new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n'));
  if (o.thumbnail) files.set('thumbnail.png', o.thumbnail);
  return files;
}

/** The template as one zip file. */
export function templateZip(files: Map<string, Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(files), { level: 6 });
}

/** Reads a template from its files, or from its zip's bytes. */
export async function readTemplate(
  input: Map<string, Uint8Array> | Uint8Array,
): Promise<LoadedTemplate> {
  let files: Map<string, Uint8Array>;
  if (input instanceof Uint8Array) {
    try {
      files = new Map(Object.entries(unzipSync(input)));
    } catch {
      throw new MochiError('E_ASSET_FORMAT', 'This is not a template file (not a zip).');
    }
  } else files = input;
  // A zip may hold the files inside one folder.
  const metaPath = [...files.keys()]
    .filter((p) => p === 'template.json' || p.endsWith('/template.json'))
    .sort((a, b) => a.length - b.length)[0];
  if (!metaPath) throw new MochiError('E_ASSET_FORMAT', 'This template has no template.json.');
  const prefix = metaPath.slice(0, -'template.json'.length);
  const meta = JSON.parse(new TextDecoder().decode(files.get(metaPath)!)) as TemplateMeta;
  if (meta.format !== TEMPLATE_FORMAT)
    throw new MochiError('E_ASSET_FORMAT', `Not a Mochi Maker template (format ${meta.format}).`);
  const fs = new MemoryFileSystem();
  for (const [p, b] of files)
    if (p.startsWith(`${prefix}project/`)) await fs.writeBytes(p.slice(prefix.length), b);
  const { doc, assets } = await loadProject(fs, 'project');
  const store = new MemoryAssetStore();
  if (assets instanceof MemoryAssetStore) for (const [h, b] of assets.blobs) store.blobs.set(h, b);
  else
    for (const l of new DocView(doc).ofKind('layer'))
      if (await assets.has(l.asset)) store.blobs.set(l.asset, await assets.get(l.asset));
  return { meta, doc, assets: store, thumbnail: files.get(`${prefix}thumbnail.png`) ?? null };
}

// ---------------------------------------------------------------- layout and matching

export interface Layout {
  /** Template canvas pixels × scale + (x, y) = target canvas pixels. */
  scale: number;
  x: number;
  y: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A mesh's art on its canvas at rest: its texture coordinates placed by its layer. */
export function artRect(v: DocReader, m: ArtMesh): Rect | null {
  const layer = m.layer ? v.get(m.layer) : undefined;
  const ox = layer?.kind === 'layer' ? layer.x : 0;
  const oy = layer?.kind === 'layer' ? layer.y : 0;
  if (m.uv.length < 2) return null;
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let i = 0; i < m.uv.length; i += 2) {
    r.x0 = Math.min(r.x0, m.uv[i]! + ox);
    r.x1 = Math.max(r.x1, m.uv[i]! + ox);
    r.y0 = Math.min(r.y0, m.uv[i + 1]! + oy);
    r.y1 = Math.max(r.y1, m.uv[i + 1]! + oy);
  }
  return r;
}

const union = (rs: (Rect | null)[]): Rect | null =>
  rs.reduce<Rect | null>(
    (a, r) =>
      !r
        ? a
        : !a
          ? { ...r }
          : {
              x0: Math.min(a.x0, r.x0),
              y0: Math.min(a.y0, r.y0),
              x1: Math.max(a.x1, r.x1),
              y1: Math.max(a.y1, r.y1),
            },
    null,
  );

const place = (r: Rect, l: Layout): Rect => ({
  x0: r.x0 * l.scale + l.x,
  y0: r.y0 * l.scale + l.y,
  x1: r.x1 * l.scale + l.x,
  y1: r.y1 * l.scale + l.y,
});

/** The template's art fitted onto the targets' art (the smaller ratio of the sizes), centered. */
export function defaultLayout(t: DocReader, d: DocReader, targets: readonly Uid[]): Layout {
  const a = union(t.ofKind('artMesh').map((m) => artRect(t, m)));
  const b = union(targets.map((u) => artRect(d, d.getAs(u, 'artMesh'))));
  if (!a || !b) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(
    (b.x1 - b.x0) / Math.max(a.x1 - a.x0, 1e-6),
    (b.y1 - b.y0) / Math.max(a.y1 - a.y0, 1e-6),
  );
  return {
    scale,
    x: (b.x0 + b.x1) / 2 - ((a.x0 + a.x1) / 2) * scale,
    y: (b.y0 + b.y1) / 2 - ((a.y0 + a.y1) / 2) * scale,
  };
}

/** A name for matching: lower case, without an ArtMesh prefix or punctuation. */
export const matchName = (s: string) =>
  s
    .toLowerCase()
    .replace(/^artmesh_?/, '')
    .replace(/[^a-z0-9]+/g, '');

export interface TemplatePair {
  /** The target mesh. */
  target: Uid;
  /** The template mesh (its UID in the template). */
  template: Uid;
  by: 'name' | 'shape' | 'hand';
  /** The shape cost (0 for a perfect overlap). */
  cost: number;
}

/** Shape cost of two laid-out rectangles: center distance, size ratios and overlap. */
export function shapeCost(a: Rect, b: Rect): number {
  const [wa, ha, wb, hb] = [a.x1 - a.x0, a.y1 - a.y0, b.x1 - b.x0, b.y1 - b.y0];
  const diag = Math.max(Math.hypot(wa, ha), Math.hypot(wb, hb), 1e-6);
  const dc = Math.hypot((a.x0 + a.x1 - b.x0 - b.x1) / 2, (a.y0 + a.y1 - b.y0 - b.y1) / 2) / diag;
  const ratio =
    Math.abs(Math.log(Math.max(wa, 1e-6) / Math.max(wb, 1e-6))) +
    Math.abs(Math.log(Math.max(ha, 1e-6) / Math.max(hb, 1e-6)));
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const iou = inter / Math.max(wa * ha + wb * hb - inter, 1e-9);
  return dc + 0.5 * ratio + (1 - iou);
}

/** Pairs worse than this are left unmatched. */
export const MATCH_LIMIT = 1.5;

/** Automatic matching (see the module comment); `fixed` pairs come first and are kept. */
export function matchTemplate(
  t: DocReader,
  d: DocReader,
  targets: readonly Uid[],
  layout: Layout,
  fixed: readonly { target: Uid; template: Uid | null }[] = [],
): { pairs: TemplatePair[]; unmatched: Uid[] } {
  const pairs: TemplatePair[] = [];
  const usedT = new Set<Uid>();
  const doneD = new Set<Uid>();
  for (const f of fixed) {
    doneD.add(f.target);
    if (f.template) {
      usedT.add(f.template);
      pairs.push({ target: f.target, template: f.template, by: 'hand', cost: 0 });
    }
  }
  const tm = t.ofKind('artMesh');
  const names = (m: ArtMesh) => [matchName(m.exportId), matchName(m.name)].filter(Boolean);
  for (const u of targets) {
    if (doneD.has(u)) continue;
    const m = d.getAs(u, 'artMesh');
    const want = new Set(names(m));
    const hit = tm.find((x) => !usedT.has(x.uid) && names(x).some((n) => want.has(n)));
    if (hit) {
      usedT.add(hit.uid);
      doneD.add(u);
      pairs.push({ target: u, template: hit.uid, by: 'name', cost: 0 });
    }
  }
  const cands: { target: Uid; template: Uid; cost: number }[] = [];
  for (const u of targets) {
    if (doneD.has(u)) continue;
    const a = artRect(d, d.getAs(u, 'artMesh'));
    if (!a) continue;
    for (const x of tm) {
      if (usedT.has(x.uid)) continue;
      const b = artRect(t, x);
      if (b) cands.push({ target: u, template: x.uid, cost: shapeCost(a, place(b, layout)) });
    }
  }
  cands.sort((p, q) => p.cost - q.cost);
  for (const c of cands) {
    if (c.cost > MATCH_LIMIT || doneD.has(c.target) || usedT.has(c.template)) continue;
    doneD.add(c.target);
    usedT.add(c.template);
    pairs.push({ ...c, by: 'shape' });
  }
  const paired = new Set(pairs.map((p) => p.target));
  return { pairs, unmatched: targets.filter((u) => !paired.has(u)) };
}

// ---------------------------------------------------------------- applying

const Options = Type.Object({
  drawOrder: Type.Optional(
    Type.Union([Type.Literal('template'), Type.Literal('keep')], {
      description:
        "'template' (default): the template meshes' draw order keyforms; 'keep': the targets'",
    }),
  ),
  redivide: Type.Optional(
    Type.Boolean({
      description: 're-divide each target mesh like its template mesh (default false)',
    }),
  ),
  masksCullingBlend: Type.Optional(
    Type.Boolean({
      description: 'bring the template meshes’ masks, culling and blending (default true)',
    }),
  ),
  parameters: Type.Optional(
    Type.Union([Type.Literal('merge'), Type.Literal('add')], {
      description: "a parameter ID the target has: 'merge' (default) uses it, 'add' adds a new one",
    }),
  ),
  motionSync: Type.Optional(
    Type.Union([Type.Literal('merge'), Type.Literal('add'), Type.Literal('none')], {
      description:
        "a motion-sync setting of the same name: 'merge' (default) replaces it, 'add' adds another",
    }),
  ),
  parts: Type.Optional(
    Type.Boolean({
      description:
        "bring the template's part structure and move the targets into it (default true); false keeps the target's part tree",
    }),
  ),
  physics: Type.Optional(
    Type.Union([Type.Literal('merge'), Type.Literal('add'), Type.Literal('none')], {
      description:
        "a physics setting of the same name: 'merge' (default) replaces it, 'add' adds another",
    }),
  ),
});
export type TemplateOptions = Static<typeof Options>;

export const TemplateApplyArgs = Type.Object({
  path: Type.Optional(Type.String({ description: 'a .mochitemplate file' })),
  files: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: 'the template’s files, base64' }),
  ),
  targets: Type.Optional(Type.Array(Type.String(), { description: 'art meshes (default: all)' })),
  layout: Type.Optional(
    Type.Object({
      scale: Type.Number({ exclusiveMinimum: 0 }),
      x: Type.Number(),
      y: Type.Number(),
    }),
  ),
  pairs: Type.Optional(
    Type.Array(
      Type.Object({
        target: Type.String(),
        template: Type.Union([
          Type.String({ description: 'a template mesh export ID' }),
          Type.Null(),
        ]),
      }),
      { description: 'corrections: a pair by hand, or null to leave a target out' },
    ),
  ),
  options: Type.Optional(Options),
});
export type TemplateApplyArgs = Static<typeof TemplateApplyArgs>;

const PairOut = Type.Object({
  target: Type.String(),
  template: Type.String({ description: 'the template mesh export ID' }),
  by: Type.String(),
  cost: Type.Number(),
});

export const TemplateApplyResult = Type.Object({
  template: Type.String(),
  layout: Type.Object({ scale: Type.Number(), x: Type.Number(), y: Type.Number() }),
  pairs: Type.Array(PairOut),
  unmatched: Type.Array(Type.String()),
  parameters: Type.Object({ merged: Type.Array(Type.String()), added: Type.Array(Type.String()) }),
  deformers: Type.Array(Type.String()),
  parts: Type.Object({
    merged: Type.Array(Type.String()),
    added: Type.Array(Type.String()),
    removed: Type.Array(Type.String(), {
      description: 'the target’s parts that applying emptied, and so removed',
    }),
  }),
  parameterIds: Type.Record(Type.String(), Type.String(), {
    description: 'template parameter export ID → the target’s (for retargeting motions)',
  }),
  physics: Type.Object({ replaced: Type.Array(Type.String()), added: Type.Array(Type.String()) }),
  motionSync: Type.Object({
    replaced: Type.Array(Type.String()),
    added: Type.Array(Type.String()),
  }),
  notes: Type.Array(Type.String()),
});
export type TemplateApplyResult = Static<typeof TemplateApplyResult>;

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function loadArg(ctx: OperationContext, a: TemplateApplyArgs): Promise<LoadedTemplate> {
  if (a.files) return readTemplate(new Map(Object.entries(a.files).map(([p, s]) => [p, b64(s)])));
  if (!a.path)
    throw new MochiError('E_SCHEMA', 'Give the template as `path` or its files as `files`.', {
      path: 'args',
    });
  if (!ctx.fs)
    throw new MochiError(
      'E_ASSET_FORMAT',
      'Reading a template needs file access, which this session does not have.',
    );
  return readTemplate(await ctx.fs.readBytes(a.path));
}

type Space = 'canvas' | 'unit' | 'rot';

/** The space a parent gives its children's points. */
const spaceOf = (v: DocReader, parent: Uid | null): Space =>
  !parent ? 'canvas' : v.get(parent)?.kind === 'warp' ? 'unit' : 'rot';

const toTarget = (s: Space, l: Layout, x: number, y: number): [number, number] =>
  s === 'canvas'
    ? [x * l.scale + l.x, y * l.scale + l.y]
    : s === 'rot'
      ? [x * l.scale, y * l.scale]
      : [x, y];
const toTemplate = (s: Space, l: Layout, x: number, y: number): [number, number] =>
  s === 'canvas'
    ? [(x - l.x) / l.scale, (y - l.y) / l.scale]
    : s === 'rot'
      ? [x / l.scale, y / l.scale]
      : [x, y];
const deltaScale = (s: Space, l: Layout) => (s === 'unit' ? 1 : l.scale);

/** The index of the keyform at every bound parameter's default (the rest form). */
function restIndex(v: DocReader, bindings: readonly { parameter: Uid; keys: number[] }[]): number {
  const coords = bindings.map((b) =>
    grid.nearestKeyIndex(b.keys, v.getAs(b.parameter, 'parameter').default),
  );
  return bindings.length ? grid.cellIndex(bindings as never, coords) : 0;
}

/** Barycentric weights of a point in the nearest triangle of a mesh (clamped to it). */
function locate(
  pts: ArrayLike<number>,
  tris: ArrayLike<number>,
  p: [number, number],
): { v: [number, number, number]; w: [number, number, number] } | null {
  let best: { v: [number, number, number]; w: [number, number, number]; m: number } | null = null;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const [ax, ay, bx, by, cx, cy] = [
      pts[2 * a]!,
      pts[2 * a + 1]!,
      pts[2 * b]!,
      pts[2 * b + 1]!,
      pts[2 * c]!,
      pts[2 * c + 1]!,
    ];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const w0 = ((by - cy) * (p[0] - cx) + (cx - bx) * (p[1] - cy)) / det;
    const w1 = ((cy - ay) * (p[0] - cx) + (ax - cx) * (p[1] - cy)) / det;
    const w = [w0, w1, 1 - w0 - w1] as [number, number, number];
    const m = Math.min(...w);
    if (!best || m > best.m) best = { v: [a, b, c], w, m };
  }
  if (!best) return null;
  // Outside the mesh: the nearest triangle's weights, clamped, so shapes are not extrapolated.
  const c = best.w.map((x) => Math.max(0, x));
  const s = c[0]! + c[1]! + c[2]! || 1;
  return { v: best.v, w: [c[0]! / s, c[1]! / s, c[2]! / s] };
}

function freeId(v: DocReader, kinds: string[], base: string): string {
  const taken = new Set(
    v.ofKind(kinds as never).map((o) => (o as unknown as { exportId: string }).exportId),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++)
    if (!taken.has(`${base}_${i}`.slice(0, 63))) return `${base}_${i}`.slice(0, 63);
}

/** Applies a loaded template (see the module comment) inside a transaction. */
export async function applyTemplate(
  ctx: OperationContext,
  tx: Tx,
  tpl: LoadedTemplate,
  a: Omit<TemplateApplyArgs, 'path' | 'files'>,
): Promise<TemplateApplyResult> {
  const T = new DocView(tpl.doc);
  const D = () => tx.draft;
  const o = {
    drawOrder: a.options?.drawOrder ?? 'template',
    redivide: a.options?.redivide ?? false,
    masksCullingBlend: a.options?.masksCullingBlend ?? true,
    parameters: a.options?.parameters ?? 'merge',
    physics: a.options?.physics ?? 'merge',
    motionSync: a.options?.motionSync ?? 'merge',
    parts: a.options?.parts ?? true,
  };
  const notes: string[] = [];
  const targets = (
    a.targets ??
    D()
      .ofKind('artMesh')
      .map((m) => m.uid)
  ).map((r, i) => D().resolve(r, ['artMesh'], `args.targets.${i}`));
  const layout = a.layout ?? defaultLayout(T, D(), targets);
  const tByExport = new Map(T.ofKind('artMesh').map((m) => [m.exportId, m.uid]));
  const fixed = (a.pairs ?? []).map((p, i) => {
    const target = D().resolve(p.target, ['artMesh'], `args.pairs.${i}.target`);
    if (p.template === null) return { target, template: null };
    const tu = tByExport.get(p.template);
    if (!tu)
      throw new MochiError('E_NOT_FOUND', `The template has no art mesh "${p.template}".`, {
        path: `args.pairs.${i}.template`,
      });
    return { target, template: tu };
  });
  const { pairs, unmatched } = matchTemplate(T, D(), targets, layout, fixed);
  const tToD = new Map(pairs.map((p) => [p.template, p.target]));

  // Parameters: those the matched meshes and their deformer chains are bound to.
  const deformersNeeded: Uid[] = [];
  const needParams = new Set<Uid>();
  const chain = (u: Uid | null) => {
    for (let x = u; x;) {
      const dfm = T.getAs(x, ['warp', 'rotation']);
      if (!deformersNeeded.includes(x)) deformersNeeded.push(x);
      for (const b of dfm.rig.bindings) needParams.add(b.parameter);
      x = dfm.parent;
    }
  };
  for (const p of pairs) {
    const m = T.getAs(p.template, 'artMesh');
    for (const b of m.rig.bindings) needParams.add(b.parameter);
    chain(m.deformer);
  }
  // The parts the matched meshes and deformers sit in, up to the root, and their bindings.
  const needParts = new Set<Uid>();
  if (o.parts) {
    const up = (u: Uid | null) => {
      for (let x = u; x; x = T.getAs(x, 'part').parent) needParts.add(x);
    };
    for (const p of pairs) up(T.getAs(p.template, 'artMesh').part);
    for (const u of deformersNeeded) up(T.getAs(u, ['warp', 'rotation']).part);
    for (const u of needParts)
      for (const b of T.getAs(u, 'part').rig.bindings) needParams.add(b.parameter);
  }
  // Motion sync brings the parameters it drives.
  if (o.motionSync !== 'none')
    for (const su of T.project().motionSyncOrder)
      for (const x of T.getAs(su, 'motionSyncSetting').parameters) needParams.add(x.parameter);
  // Physics brings the parameters it reads and writes.
  if (o.physics !== 'none')
    for (const su of T.project().physicsOrder) {
      const s = T.getAs(su, 'physicsSetting');
      for (const x of [...s.inputs, ...s.outputs]) needParams.add(x.parameter);
    }
  const paramMap = new Map<Uid, Uid>();
  const merged: string[] = [];
  const added: string[] = [];
  for (const pu of T.project().parameterOrder) {
    if (!needParams.has(pu)) continue;
    const tp = T.getAs(pu, 'parameter');
    const usedKeys = new Set<number>();
    for (const x of [...T.ofKind('artMesh'), ...T.ofKind(['warp', 'rotation'])])
      for (const b of (x as { rig: { bindings: { parameter: Uid; keys: number[] }[] } }).rig
        .bindings)
        if (b.parameter === pu) for (const k of b.keys) usedKeys.add(k);
    const same = D()
      .ofKind('parameter')
      .find((p) => p.exportId === tp.exportId);
    if (same && o.parameters === 'merge') {
      const min = Math.min(same.min, ...usedKeys);
      const max = Math.max(same.max, ...usedKeys);
      if (min < same.min || max > same.max) tx.run('param.update', { target: same.uid, min, max });
      const keys = [...new Set([...same.keys, ...usedKeys])].sort((x, y) => x - y);
      if (keys.length !== same.keys.length) tx.run('param.setKeys', { target: same.uid, keys });
      paramMap.set(pu, same.uid);
      merged.push(same.exportId);
    } else {
      const exportId = freeId(D(), ['parameter', 'parameterGroup'], tp.exportId);
      const r = tx.run('param.create', {
        exportId,
        name: tp.name,
        min: tp.min,
        max: tp.max,
        default: tp.default,
        keys: [...new Set([...tp.keys, ...usedKeys])].sort((x, y) => x - y),
        repeat: tp.repeat,
        decimals: tp.decimals,
      }) as { uid: Uid };
      paramMap.set(pu, r.uid);
      added.push(exportId);
    }
  }
  const cellOf = (bindings: readonly { parameter: Uid; keys: number[] }[], i: number) => {
    const c = grid.cellCoords(bindings as never, i);
    return Object.fromEntries(bindings.map((b, j) => [paramMap.get(b.parameter)!, b.keys[c[j]!]!]));
  };
  const bindAll = (target: Uid, bindings: readonly { parameter: Uid; keys: number[] }[]) => {
    for (const b of bindings)
      tx.run('rig.addBinding', { target, parameter: paramMap.get(b.parameter)!, keys: b.keys });
  };

  // The target's parts as they were, to tell which ones applying empties.
  const tpl0Parts = D().ofKind('part');
  // Parts: the template's part structure, top-down in its tree order. A part whose
  // export ID the target has is reused.
  const partMap = new Map<Uid, Uid>();
  const partsOut = { merged: [] as string[], added: [] as string[], removed: [] as string[] };
  if (o.parts) {
    const walk = (list: readonly Uid[], parent: Uid | null) => {
      for (const u of list) {
        const x = T.get(u);
        if (x?.kind !== 'part' || !needParts.has(u)) continue;
        const same = D()
          .ofKind('part')
          .find((q) => q.exportId === x.exportId);
        let nu: Uid;
        if (same) {
          nu = same.uid;
          partsOut.merged.push(same.exportId);
        } else {
          const k0 = x.rig.keyforms[restIndex(T, x.rig.bindings)]!;
          nu = (
            tx.run('part.create', {
              exportId: freeId(D(), ['part'], x.exportId),
              name: x.name,
              parent,
              sortingScope: x.sortingScope,
              visibleAtStart: x.visibleAtStart,
              drawOrder: k0.drawOrder,
            }) as { uid: Uid }
          ).uid;
          partsOut.added.push(D().getAs(nu, 'part').exportId);
          bindAll(nu, x.rig.bindings);
          if (x.rig.bindings.length)
            x.rig.keyforms.forEach((k, i) =>
              tx.run('keyform.set', {
                target: nu,
                cell: cellOf(x.rig.bindings, i),
                values: { drawOrder: k.drawOrder },
              }),
            );
        }
        partMap.set(u, nu);
        walk(x.children, nu);
      }
    };
    walk(T.project().root, null);
  }

  // Deformers, parents first.
  const depth = (u: Uid): number => {
    const p = T.getAs(u, ['warp', 'rotation']).parent;
    return p ? 1 + depth(p) : 0;
  };
  const order = T.project().deformerOrder.filter((u) => deformersNeeded.includes(u));
  order.sort((x, y) => depth(x) - depth(y));
  const dfmMap = new Map<Uid, Uid>();
  const partFor = (tu: Uid): Uid | null => {
    for (const p of pairs) {
      for (
        let x = T.getAs(p.template, 'artMesh').deformer;
        x;
        x = T.getAs(x, ['warp', 'rotation']).parent
      )
        if (x === tu) return D().getAs(p.target, 'artMesh').part;
    }
    return null;
  };
  for (const tu of order) {
    const t = T.getAs(tu, ['warp', 'rotation']);
    const space = spaceOf(T, t.parent);
    const parent = t.parent ? dfmMap.get(t.parent)! : null;
    const common = {
      exportId: freeId(D(), ['warp', 'rotation'], t.exportId),
      name: t.name,
      parent,
      part: o.parts ? (t.part ? (partMap.get(t.part) ?? null) : null) : partFor(tu),
    };
    let uid: Uid;
    if (t.kind === 'warp') {
      uid = (
        tx.run('deformer.createWarp', {
          ...common,
          rows: t.rows,
          cols: t.cols,
          cellMode: t.cellMode,
          ...(space === 'rot' ? { rect: { x: 0, y: 0, width: 1, height: 1 } } : {}),
        }) as { uid: Uid }
      ).uid;
      bindAll(uid, t.rig.bindings);
      t.rig.keyforms.forEach((k, i) => {
        const g: [number, number][] = [];
        for (let j = 0; j < k.grid.length; j += 2)
          g.push(toTarget(space, layout, k.grid[j]!, k.grid[j + 1]!));
        tx.run('keyform.set', {
          target: uid,
          ...(t.rig.bindings.length ? { cell: cellOf(t.rig.bindings, i) } : {}),
          values: { grid: g, opacity: k.opacity, multiply: [...k.multiply], screen: [...k.screen] },
        });
      });
    } else {
      const r = t as Rotation;
      const k0 = r.rig.keyforms[restIndex(T, r.rig.bindings)]!;
      const [ox, oy] = toTarget(space, layout, k0.originX, k0.originY);
      uid = (
        tx.run('deformer.createRotation', {
          ...common,
          origin: { x: ox, y: oy },
          baseAngle: r.baseAngle,
        }) as { uid: Uid }
      ).uid;
      bindAll(uid, r.rig.bindings);
      r.rig.keyforms.forEach((k, i) => {
        const [x, y] = toTarget(space, layout, k.originX, k.originY);
        tx.run('keyform.set', {
          target: uid,
          ...(r.rig.bindings.length ? { cell: cellOf(r.rig.bindings, i) } : {}),
          values: {
            angle: k.angle,
            originX: x,
            originY: y,
            scale: k.scale,
            mirrorX: k.mirrorX,
            mirrorY: k.mirrorY,
            opacity: k.opacity,
            multiply: [...k.multiply],
            screen: [...k.screen],
          },
        });
      });
    }
    dfmMap.set(tu, uid);
  }

  // Meshes.
  for (const p of pairs) {
    const tm = T.getAs(p.template, 'artMesh');
    let dm = D().getAs(p.target, 'artMesh');
    if (dm.rig.bindings.length) {
      notes.push(`${D().describe(dm.uid)} already has bindings; it was left as it is.`);
      continue;
    }
    if (o.redivide) {
      const tl = tm.layer ? T.get(tm.layer) : undefined;
      const dl = dm.layer ? D().get(dm.layer) : undefined;
      const [tx0, ty0] = tl?.kind === 'layer' ? [tl.x, tl.y] : [0, 0];
      const [dx0, dy0] = dl?.kind === 'layer' ? [dl.x, dl.y] : [0, 0];
      const uv: [number, number][] = [];
      for (let i = 0; i < tm.uv.length; i += 2)
        uv.push([
          (tm.uv[i]! + tx0) * layout.scale + layout.x - dx0,
          (tm.uv[i + 1]! + ty0) * layout.scale + layout.y - dy0,
        ]);
      const tris: [number, number, number][] = [];
      for (let i = 0; i < tm.triangles.length; i += 3)
        tris.push([tm.triangles[i]!, tm.triangles[i + 1]!, tm.triangles[i + 2]!]);
      tx.run('mesh.setTopology', { target: dm.uid, uv, triangles: tris });
    }
    const dfm = tm.deformer ? dfmMap.get(tm.deformer)! : null;
    if (dfm !== dm.deformer) await meshReparent.run(ctx, tx, { target: dm.uid, deformer: dfm });
    dm = D().getAs(p.target, 'artMesh');
    const space = spaceOf(T, tm.deformer);
    const rest = dm.rig.keyforms[0]!.positions;
    const tRest = tm.rig.keyforms[restIndex(T, tm.rig.bindings)]!.positions;
    const same = o.redivide && rest.length === tRest.length;
    const at = same
      ? null
      : Array.from({ length: rest.length / 2 }, (_, i) =>
          locate(tRest, tm.triangles, toTemplate(space, layout, rest[2 * i]!, rest[2 * i + 1]!)),
        );
    const ds = deltaScale(space, layout);
    bindAll(dm.uid, tm.rig.bindings);
    tm.rig.keyforms.forEach((k, i) => {
      const positions: [number, number][] = [];
      for (let v = 0; v < rest.length / 2; v++) {
        let [dx, dy] = [0, 0];
        if (same) {
          dx = k.positions[2 * v]! - tRest[2 * v]!;
          dy = k.positions[2 * v + 1]! - tRest[2 * v + 1]!;
        } else {
          const l = at![v];
          if (l)
            for (let j = 0; j < 3; j++) {
              const q = l.v[j]!;
              dx += l.w[j]! * (k.positions[2 * q]! - tRest[2 * q]!);
              dy += l.w[j]! * (k.positions[2 * q + 1]! - tRest[2 * q + 1]!);
            }
        }
        positions.push([rest[2 * v]! + dx * ds, rest[2 * v + 1]! + dy * ds]);
      }
      tx.run('keyform.set', {
        target: dm.uid,
        ...(tm.rig.bindings.length ? { cell: cellOf(tm.rig.bindings, i) } : {}),
        values: {
          positions,
          opacity: k.opacity,
          multiply: [...k.multiply],
          screen: [...k.screen],
          ...(o.drawOrder === 'template' ? { drawOrder: k.drawOrder } : {}),
        },
      });
    });
    if (o.masksCullingBlend) {
      tx.run('mesh.update', {
        target: dm.uid,
        doubleSided: tm.doubleSided,
        legacyBlend: tm.legacyBlend,
      });
      if (tm.clip) {
        const masks = tm.clip.masks.map((u) => tToD.get(u)).filter((u): u is Uid => !!u);
        if (masks.length < tm.clip.masks.length)
          notes.push(`${D().describe(dm.uid)}: masks without a matched target were left out.`);
        if (masks.length) tx.run('mesh.setClip', { target: dm.uid, masks, invert: tm.clip.invert });
      }
    }
    if (tm.blendShapes.length)
      notes.push(`${tm.exportId}'s blend shapes were not carried (not available in this build).`);
  }

  // The targets go into the template's parts, in the template's order.
  if (o.parts) {
    const place = (list: readonly Uid[], parent: Uid | null) => {
      for (const u of list) {
        const x = T.get(u);
        if (x?.kind === 'artMesh' && tToD.has(u))
          tx.run('tree.move', { target: tToD.get(u)!, parent });
        else if (x?.kind === 'part' && partMap.has(u)) place(x.children, partMap.get(u)!);
      }
    };
    place(T.project().root, null);
    // The target's parts were not empty before; those applying emptied go, up the tree.
    const hadChildren = new Set(tpl0Parts.filter((x) => x.children.length > 0).map((x) => x.uid));
    for (let changed = true; changed;) {
      changed = false;
      for (const x of D().ofKind('part'))
        if (
          x.children.length === 0 &&
          hadChildren.has(x.uid) &&
          ![...partMap.values()].includes(x.uid) &&
          !D()
            .ofKind(['warp', 'rotation'])
            .some((w) => w.part === x.uid)
        ) {
          partsOut.removed.push(x.exportId);
          tx.run('part.delete', { target: x.uid });
          changed = true;
        }
    }
  }

  // Motion-sync settings: merged by name, or added.
  const motionSync = { replaced: [] as string[], added: [] as string[] };
  if (o.motionSync !== 'none')
    for (const su of T.project().motionSyncOrder) {
      const s = T.getAs(su, 'motionSyncSetting');
      if (!s.parameters.every((x) => paramMap.has(x.parameter))) {
        notes.push(
          `Motion sync "${s.name}" drives parameters that did not come along; it was left out.`,
        );
        continue;
      }
      const fields = {
        useCase: s.useCase,
        analysisType: s.analysisType,
        sampleRate: s.sampleRate,
        smoothing: s.smoothing,
        blendRatio: s.blendRatio,
        parameters: s.parameters.map((x) => ({
          parameter: paramMap.get(x.parameter)!,
          damper: x.damper,
          smooth: x.smooth,
        })),
        elements: s.elements.map((e) => ({ ...e })),
        shapes: s.shapes.map((r) => [...r]),
      };
      const same = D()
        .ofKind('motionSyncSetting')
        .find((x) => x.name === s.name);
      if (same && o.motionSync === 'merge') {
        tx.run('motionSync.updateSetting', { target: same.uid, ...fields });
        motionSync.replaced.push(s.name);
      } else {
        const names = new Set(
          D()
            .ofKind('motionSyncSetting')
            .map((x) => x.name),
        );
        let name = s.name;
        for (let i = 2; names.has(name); i++) name = `${s.name} ${i}`;
        tx.run('motionSync.addSetting', { name, ...fields });
        motionSync.added.push(name);
      }
    }

  // Physics.
  const physics = { replaced: [] as string[], added: [] as string[] };
  if (o.physics !== 'none')
    for (const su of T.project().physicsOrder) {
      const s = T.getAs(su, 'physicsSetting') as PhysicsSetting;
      const io = [...s.inputs, ...s.outputs];
      if (!io.every((x) => paramMap.has(x.parameter))) {
        if (io.some((x) => paramMap.has(x.parameter)))
          notes.push(
            `Physics "${s.name}" names parameters that did not come along; it was left out.`,
          );
        continue;
      }
      const map = <X extends { parameter: Uid }>(x: X) => ({
        ...x,
        parameter: paramMap.get(x.parameter)!,
      });
      const fields = {
        inputs: s.inputs.map(map),
        outputs: s.outputs.map(map),
        particles: s.particles,
        normalization: s.normalization,
      };
      const same = D()
        .ofKind('physicsSetting')
        .find((x) => x.name === s.name);
      if (same && o.physics === 'merge') {
        tx.run('physics.updateSetting', { target: same.uid, name: s.name, ...fields });
        physics.replaced.push(s.name);
      } else {
        const names = new Set(
          D()
            .ofKind('physicsSetting')
            .map((x) => x.name),
        );
        let name = s.name;
        for (let i = 2; names.has(name); i++) name = `${s.name} ${i}`;
        tx.run('physics.addSetting', { name, ...fields });
        physics.added.push(name);
      }
    }
  return {
    template: tpl.meta.name,
    layout,
    pairs: pairs.map((p) => ({
      target: p.target,
      template: T.getAs(p.template, 'artMesh').exportId,
      by: p.by,
      cost: Math.round(p.cost * 1000) / 1000,
    })),
    unmatched,
    parameters: { merged, added },
    deformers: [...dfmMap.values()],
    parts: partsOut,
    parameterIds: Object.fromEntries(
      [...paramMap].map(([t, d]) => [
        T.getAs(t, 'parameter').exportId,
        D().getAs(d, 'parameter').exportId,
      ]),
    ),
    physics,
    motionSync,
    notes,
  };
}

export const templateApply = defineOperation({
  name: 'modelTemplate.apply',
  summary: 'Apply a model template to art meshes: its deformers, parameters, keyforms and physics.',
  doc: `Reads a template (\`path\` to a .mochitemplate file, or its \`files\` as base64), lays it over the
target art (\`layout\`; default: fitted), matches the template's art meshes to the targets (\`targets\`,
default all) by name, then by position and shape (\`pairs\` corrects or leaves out targets), and in
one transaction creates the matched meshes' deformers and parameters and gives each target the
template mesh's bindings and keyforms, carried over to its own vertices. \`options\`: drawOrder
'template' | 'keep', redivide, masksCullingBlend, parameters 'merge' | 'add', physics 'merge' | 'add'
| 'none'. Targets that already have bindings are left as they are. With dryRun, only the report
(the pairs and what would be added).`,
  args: TemplateApplyArgs,
  result: TemplateApplyResult,
  errors: ['E_ASSET_FORMAT', 'E_SCHEMA', 'E_NOT_FOUND', 'E_RANGE'],
  examples: [
    {
      description: 'A template from a file, on every art mesh',
      args: { path: 'templates/chibi.mochitemplate' },
    },
  ],
  async run(ctx, tx, a) {
    const tpl = await loadArg(ctx, a);
    return { result: await applyTemplate(ctx, tx, tpl, a) };
  },
});

/**
 * A template motion for the target (the preview): each parameter curve's ID becomes the
 * target's (`parameterIds`, from the apply result); curves of parameters that did not come along
 * are left out, and listed.
 */
export function retargetMotion(
  motion: { Curves: { Target: string; Id: string }[]; Meta?: Record<string, unknown> } & Record<
    string,
    unknown
  >,
  parameterIds: Record<string, string>,
): { motion: typeof motion; kept: number; dropped: string[] } {
  const dropped: string[] = [];
  const curves = motion.Curves.filter((c) => {
    if (c.Target !== 'Parameter' || c.Id in parameterIds) return true;
    dropped.push(c.Id);
    return false;
  }).map((c) => (c.Target === 'Parameter' ? { ...c, Id: parameterIds[c.Id]! } : c));
  const segs = (c: { Segments?: number[] }) => {
    const s = c.Segments ?? [];
    let n = 0;
    let p = 1;
    for (let i = 2; i < s.length;) {
      const k = s[i] === 1 ? 3 : 1;
      n++;
      p += k;
      i += 1 + 2 * k;
    }
    return [n, p] as const;
  };
  const meta = { ...(motion.Meta ?? {}) };
  if (dropped.length) {
    meta.CurveCount = curves.length;
    meta.TotalSegmentCount = curves.reduce((a, c) => a + segs(c as { Segments?: number[] })[0], 0);
    meta.TotalPointCount = curves.reduce((a, c) => a + segs(c as { Segments?: number[] })[1], 0);
  }
  return { motion: { ...motion, Meta: meta, Curves: curves }, kept: curves.length, dropped };
}
