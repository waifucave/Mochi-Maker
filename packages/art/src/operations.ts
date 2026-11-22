/**
 * Image-based operations: art import and mesh generation. They read files and asset
 * pixels, then change the document only through ordinary commands, so the log replays without
 * them. Each returns a small preview image.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  LIMITS,
  MochiError,
  RefOf,
  defineOperation,
  readCapped,
  type Draft,
  type Kind,
  type OperationContext,
  type OperationDef,
  type Preview,
  type Tx,
} from '@mochi-maker/core';
import {
  MeshGenerationError,
  checkerboard,
  drawImage,
  fitScale,
  generateMesh,
  meshPreview,
  type Image,
  type MeshOptions as GenOptions,
} from '@mochi-maker/geometry';
import type { ImportedArt } from './art.js';
import { readPngFolderArt } from './folder.js';
import { readOraArt } from './ora.js';
import { soundImport } from './sound.js';
import { decodePng, encodePng, trimImage } from './png.js';
import { readPsdArt } from './psd.js';

const MeshOptionFields = {
  alphaThreshold: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 255,
      description: 'alpha at or above which a pixel counts (default 8)',
    }),
  ),
  margin: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 64,
      description: 'pixels the outline keeps outside the art (default 3)',
    }),
  ),
  tolerance: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 16,
      description: 'outline simplification, pixels (default 1.5)',
    }),
  ),
  spacing: Type.Optional(
    Type.Number({
      minimum: 2,
      description: 'distance between interior vertices, pixels (default: from the area)',
    }),
  ),
  boundarySpacing: Type.Optional(
    Type.Number({
      minimum: 1,
      description: 'maximum outline edge length, pixels (default: spacing)',
    }),
  ),
  minIslandArea: Type.Optional(
    Type.Number({
      minimum: 0,
      description: 'drop islands smaller than this, square pixels (default 16)',
    }),
  ),
  minHoleArea: Type.Optional(
    Type.Number({
      minimum: 0,
      description: 'fill holes smaller than this, square pixels (default 16)',
    }),
  ),
  seed: Type.Optional(Type.Integer({ description: 'seed for interior-vertex jitter (default 1)' })),
};
type MeshOptionArgs = {
  [K in keyof typeof MeshOptionFields]?: Static<(typeof MeshOptionFields)[K]>;
};

function meshOptions(a: MeshOptionArgs): GenOptions {
  const o: GenOptions = {};
  for (const k of Object.keys(MeshOptionFields) as (keyof MeshOptionArgs)[])
    if (a[k] !== undefined) (o as Record<string, number>)[k] = a[k]!;
  return o;
}

/**
 * The default interior spacing, in canvas pixels: the canvas's longer side / 64. Layer
 * pixels are canvas pixels, so it applies directly. Generation clamps it per island.
 */
export function canvasSpacing(d: Draft): number {
  const c = d.project().canvas;
  return Math.max(c.width, c.height) / 64;
}

function optionsFor(d: Draft, a: MeshOptionArgs): GenOptions {
  return { defaultSpacing: canvasSpacing(d), ...meshOptions(a) };
}

function preview(image: Image, description: string): Preview {
  return {
    mediaType: 'image/png',
    data: encodePng(image),
    width: image.width,
    height: image.height,
    description,
  };
}

/** A free export ID with a readable base; null when the name has no ASCII letters or digits. */
function exportIdFrom(d: Draft, kinds: Kind[], prefix: string, name: string): string | undefined {
  const clean = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/[A-Za-z0-9]/.test(clean)) return undefined;
  const base = `${prefix}_${clean}`.slice(0, 56);
  const taken = new Set(d.ofKind(kinds).map((o) => ('exportId' in o ? o.exportId : '')));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

async function layerImage(ctx: OperationContext, d: Draft, layerUid: string): Promise<Image> {
  const layer = d.getAs(layerUid, 'layer');
  if (!(await ctx.assets.has(layer.asset)))
    throw new MochiError(
      'E_ASSET_MISSING',
      `The image of layer "${layer.name}" (${layer.asset.slice(0, 12)}…) is not available.`,
    );
  return decodePng(await ctx.assets.get(layer.asset), `layer "${layer.name}"`);
}

function generate(image: Image, options: GenOptions, what: string) {
  try {
    return generateMesh(image.data, image.width, image.height, options);
  } catch (e) {
    if (e instanceof MeshGenerationError) {
      const fixes =
        e.reason === 'too-many-vertices'
          ? [
              {
                description: 'Use a larger spacing',
                replace: { path: 'args.spacing', value: Math.ceil((options.spacing ?? 8) * 2) },
              },
            ]
          : [];
      throw new MochiError(
        e.reason === 'empty' ? 'E_SHAPE' : 'E_TOPOLOGY',
        `${what}: ${e.message}`,
        { fixes },
      );
    }
    throw e;
  }
}

const pairs = (p: Float32Array): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < p.length; i += 2) out.push([p[i]!, p[i + 1]!]);
  return out;
};
const triples = (t: Uint32Array): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let i = 0; i < t.length; i += 3) out.push([t[i]!, t[i + 1]!, t[i + 2]!]);
  return out;
};

// ---------------------------------------------------------------- mesh.generate

export const meshGenerate = defineOperation({
  name: 'mesh.generate',
  summary: 'Generate an art mesh from a layer’s alpha outline.',
  doc: `Traces the layer's opaque pixels, simplifies the outline, places interior vertices on a jittered
grid and builds a constrained Delaunay triangulation. The mesh covers every pixel with alpha at or
above \`alphaThreshold\`, extended by \`margin\` pixels. Density: \`spacing\` (interior) and
\`boundarySpacing\` (outline). The mesh is created at the layer's canvas position, without a deformer.
Returns a wireframe preview. Use mesh.regenerate to rebuild an existing mesh.`,
  args: Type.Object({
    layer: RefOf(['layer']),
    part: Type.Optional(Type.Union([RefOf(['part']), Type.Null()])),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
    exportId: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    ...MeshOptionFields,
  }),
  result: Type.Object({
    uid: Type.String(),
    vertexCount: Type.Integer(),
    triangleCount: Type.Integer(),
  }),
  errors: ['E_ASSET_MISSING', 'E_SHAPE', 'E_TOPOLOGY', 'E_DUPLICATE_ID'],
  examples: [
    {
      description: 'A mesh for the face layer',
      args: { layer: '@layer~face', part: '@part:PartHead', spacing: 24 },
    },
  ],
  async run(ctx, tx, a) {
    const layer = tx.draft.getAs(a.layer, 'layer');
    const image = await layerImage(ctx, tx.draft, layer.uid);
    const m = generate(image, optionsFor(tx.draft, a), `layer "${layer.name}"`);
    const r = tx.run('mesh.create', {
      exportId: a.exportId ?? exportIdFrom(tx.draft, ['artMesh'], 'ArtMesh', layer.name),
      name: a.name ?? layer.name,
      part: a.part ?? null,
      index: a.index,
      layer: layer.uid,
      uv: pairs(m.points),
      triangles: triples(m.triangles),
    });
    return {
      result: {
        uid: r.uid,
        vertexCount: m.points.length / 2,
        triangleCount: m.triangles.length / 3,
      },
      previews: [
        preview(
          meshPreview(image, m.points, m.triangles),
          `Mesh for layer "${layer.name}": ${m.points.length / 2} vertices, ${m.triangles.length / 3} triangles.`,
        ),
      ],
    };
  },
});

// ---------------------------------------------------------------- mesh.regenerate

export const meshRegenerate = defineOperation({
  name: 'mesh.regenerate',
  summary: 'Rebuild an existing mesh from its layer, keeping its keyforms.',
  doc: `Generates a new mesh from the layer image (same options as mesh.generate) and applies it with
mesh.setTopology: every keyform carries over, new vertices follow the old deformation, and glue
pairs on vertices that move are dropped.`,
  args: Type.Object({ target: RefOf(['artMesh']), ...MeshOptionFields }),
  result: Type.Object({
    vertexCount: Type.Integer(),
    triangleCount: Type.Integer(),
    droppedGluePairs: Type.Integer(),
  }),
  errors: ['E_ASSET_MISSING', 'E_SHAPE', 'E_TOPOLOGY'],
  examples: [
    {
      description: 'Denser mesh for the face',
      args: { target: '@mesh:ArtMesh_Face', spacing: 12 },
    },
  ],
  async run(ctx, tx, a) {
    const mesh = tx.draft.getAs(a.target, 'artMesh');
    if (!mesh.layer)
      throw new MochiError(
        'E_SHAPE',
        `${tx.draft.describe(mesh.uid)} has no layer to generate from.`,
        {
          fixes: [
            {
              description: 'Assign a layer first',
              command: 'mesh.update',
              args: { target: mesh.uid, layer: '<layer>' },
            },
          ],
        },
      );
    const image = await layerImage(ctx, tx.draft, mesh.layer);
    const m = generate(image, optionsFor(tx.draft, a), tx.draft.describe(mesh.uid));
    const r = tx.run('mesh.setTopology', {
      target: mesh.uid,
      uv: pairs(m.points),
      triangles: triples(m.triangles),
    });
    return {
      result: r,
      previews: [
        preview(
          meshPreview(image, m.points, m.triangles),
          `New mesh for ${tx.draft.describe(mesh.uid)}: ${r.vertexCount} vertices.`,
        ),
      ],
    };
  },
});

// ---------------------------------------------------------------- art.import

export async function readArt(
  ctx: OperationContext,
  path: string,
  format?: string,
): Promise<ImportedArt> {
  const fs = ctx.fs;
  if (!fs)
    throw new MochiError(
      'E_ASSET_FORMAT',
      'Importing files needs file access, which this session does not have.',
    );
  if (!(await fs.exists(path)))
    throw new MochiError('E_NOT_FOUND', `${path} does not exist.`, { path: 'args.path' });
  const lower = path.toLowerCase();
  const kind =
    format ??
    (lower.endsWith('.psd') || lower.endsWith('.psb')
      ? 'psd'
      : lower.endsWith('.ora')
        ? 'ora'
        : lower.endsWith('.png')
          ? 'png'
          : (await fs.list(path)).length > 0
            ? 'folder'
            : undefined);
  if (kind === 'psd') return readPsdArt(await readCapped(fs, path, LIMITS.fileBytes), path);
  if (kind === 'ora') return readOraArt(await readCapped(fs, path, LIMITS.fileBytes), path);
  if (kind === 'folder') return readPngFolderArt(fs, path);
  if (kind === 'png') {
    const img = decodePng(await readCapped(fs, path, LIMITS.fileBytes), path);
    const t = trimImage(img);
    const name = path
      .split('/')
      .pop()!
      .replace(/\.png$/i, '');
    return {
      format: 'png',
      width: img.width,
      height: img.height,
      layers: t
        ? [
            {
              name,
              group: [],
              x: t.x,
              y: t.y,
              image: t.image,
              visible: true,
              opacity: 1,
              blendMode: 'normal',
              clipped: false,
              notes: [],
            },
          ]
        : [],
      notes: t ? [] : [`${path} is fully transparent.`],
    };
  }
  throw new MochiError(
    'E_ASSET_FORMAT',
    `Cannot tell the format of ${path}. Supported: .psd, .ora, .png, or a folder of PNGs.`,
    {
      path: 'args.path',
    },
  );
}

/** A composite of the visible layers (normal blending, layer opacity), for previews. */
export function compositeArt(art: ImportedArt, maxSize = 512): Image {
  const s = fitScale(art.width, art.height, maxSize);
  const out = checkerboard(
    Math.max(1, Math.round(art.width * s)),
    Math.max(1, Math.round(art.height * s)),
  );
  for (const l of art.layers)
    if (l.visible) drawImage(out, l.image, l.x * s, l.y * s, s, l.opacity);
  return out;
}

export const artImport = defineOperation({
  name: 'art.import',
  summary:
    'Import layered art (PSD, OpenRaster, a PNG folder or one PNG): layers, parts and meshes.',
  doc: `Reads the file, stores every layer's pixels (trimmed to their non-transparent area) in the asset
store, and in one transaction:
- creates a part for every layer group (nested), under \`parent\` if given; art without any
  group, imported without \`parent\`, gets one part named after the file, holding its layers;
- creates a layer object for every layer, recording visibility, opacity, blend mode, clipping and
  import notes;
- unless \`meshes\` is false, generates a mesh for every visible layer (hidden ones too with
  \`includeHidden\`), in its group's part and in layer order, with the mesh options;
- unless \`clipping\` is false, turns PSD clipping (a layer clipped to the one below) into a
  clipping mask between the meshes, and notes each one.

Without \`spacing\`, the interior spacing defaults to the canvas's longer side / 64 (canvas
pixels), clamped so an average island gets 30–600 interior vertices; the result lists the
spacing and vertex count of every mesh.

Blend modes other than normal, group opacity and masks are not applied; they are listed in the
layers' notes and the result's notes. \`setCanvas\` ('ifEmpty' by default) sets the canvas to the
art's size when the project has no layers yet. Returns a composite preview.`,
  args: Type.Object({
    path: Type.String({ description: 'a .psd, .ora or .png file, or a folder of PNGs' }),
    format: Type.Optional(
      Type.Union([
        Type.Literal('psd'),
        Type.Literal('ora'),
        Type.Literal('folder'),
        Type.Literal('png'),
      ]),
    ),
    parent: Type.Optional(Type.Union([RefOf(['part']), Type.Null()])),
    meshes: Type.Optional(Type.Boolean()),
    includeHidden: Type.Optional(Type.Boolean()),
    clipping: Type.Optional(
      Type.Boolean({ description: 'turn PSD clipping into clipping masks (default true)' }),
    ),
    setCanvas: Type.Optional(
      Type.Union([Type.Literal('ifEmpty'), Type.Literal('always'), Type.Literal('never')]),
    ),
    ...MeshOptionFields,
  }),
  result: Type.Object({
    parts: Type.Array(Type.String()),
    layers: Type.Array(Type.String()),
    meshes: Type.Array(Type.String()),
    meshStats: Type.Array(
      Type.Object({ mesh: Type.String(), vertices: Type.Integer(), spacing: Type.Number() }),
    ),
    notes: Type.Array(Type.String()),
  }),
  errors: ['E_NOT_FOUND', 'E_ASSET_FORMAT', 'E_TOPOLOGY'],
  examples: [
    { description: 'Import a PSD with default meshes', args: { path: 'art/character.psd' } },
    {
      description: 'Import a PNG folder without meshes',
      args: { path: 'art/layers', meshes: false },
    },
  ],
  async run(ctx, tx, a) {
    const art = await readArt(ctx, a.path, a.format);
    return importArt(ctx, tx, art, a.path, a);
  },
});

export interface ImportOptions extends MeshOptionArgs {
  parent?: string | null;
  meshes?: boolean;
  includeHidden?: boolean;
  clipping?: boolean;
  setCanvas?: 'ifEmpty' | 'always' | 'never';
}

/** Applies already-read art to the document (used by art.import, and by callers with bytes in hand). */
export async function importArt(
  ctx: OperationContext,
  tx: Tx,
  art: ImportedArt,
  source: string,
  a: ImportOptions,
) {
  const d = tx.draft;
  const notes = [...art.notes];
  const setCanvas = a.setCanvas ?? 'ifEmpty';
  if (setCanvas === 'always' || (setCanvas === 'ifEmpty' && d.ofKind('layer').length === 0))
    tx.run('project.setCanvas', {
      width: art.width,
      height: art.height,
      pixelsPerUnit: art.width,
      originX: art.width / 2,
      originY: art.height / 2,
    });

  const parts: string[] = [];
  // Art without layer groups gets one part holding its layers, named after the file,
  // so that the Parts palette has something to fold, hide and sort. Not with a given parent.
  let top = a.parent ?? null;
  if (a.parent === undefined && art.layers.length > 0 && art.layers.every((l) => !l.group.length)) {
    const name =
      source
        .split(/[\\/]/)
        .filter(Boolean)
        .pop()
        ?.replace(/\.(psd|ora|png)$/i, '') || 'Art';
    top = tx.run('part.create', {
      exportId: exportIdFrom(d, ['part'], 'Part', name),
      name,
      parent: null,
    }).uid;
    parts.push(top);
  }
  const partFor = new Map<string, string | null>([['', top]]);
  const ensurePart = (group: string[]): string | null => {
    const key = group.join('\u0000');
    const known = partFor.get(key);
    if (known !== undefined) return known;
    const parent = ensurePart(group.slice(0, -1));
    const name = group[group.length - 1]!;
    const { uid } = tx.run('part.create', {
      exportId: exportIdFrom(d, ['part'], 'Part', name),
      name,
      parent,
    });
    partFor.set(key, uid);
    parts.push(uid);
    return uid;
  };

  const layers: string[] = [];
  const meshes: string[] = [];
  const meshStats: { mesh: string; vertices: number; spacing: number }[] = [];
  // After the canvas is set, so the default spacing follows the art's canvas.
  const opts = optionsFor(d, a);
  // The base mesh that clipped layers clip to, per group.
  const clipBase = new Map<string, string | null>();
  for (const l of art.layers) {
    const part = ensurePart(l.group);
    const hash = await ctx.assets.put(encodePng(l.image));
    const layerNotes = [...l.notes];
    if (l.blendMode !== 'normal') layerNotes.push(`blend mode ${l.blendMode} is not applied`);
    const { uid: layer } = tx.run('layer.create', {
      name: l.name,
      asset: hash,
      x: l.x,
      y: l.y,
      width: l.image.width,
      height: l.image.height,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: l.blendMode,
      clipped: l.clipped,
      notes: layerNotes,
      source: `${source}#${[...l.group, l.name].join('/')}`,
    });
    layers.push(layer);
    for (const n of layerNotes) notes.push(`${[...l.group, l.name].join('/')}: ${n}`);

    const groupKey = l.group.join('\u0000');
    let mesh: string | null = null;
    if ((a.meshes ?? true) && (l.visible || a.includeHidden)) {
      try {
        const m = generateMesh(l.image.data, l.image.width, l.image.height, opts);
        mesh = tx.run('mesh.create', {
          exportId: exportIdFrom(d, ['artMesh'], 'ArtMesh', l.name),
          name: l.name,
          part,
          layer,
          uv: pairs(m.points),
          triangles: triples(m.triangles),
          opacity: l.opacity,
        }).uid;
        meshes.push(mesh);
        meshStats.push({ mesh, vertices: m.points.length / 2, spacing: m.stats.spacing });
      } catch (e) {
        if (!(e instanceof MeshGenerationError)) throw e;
        notes.push(`${[...l.group, l.name].join('/')}: no mesh (${e.message})`);
      }
    }
    const path = [...l.group, l.name].join('/');
    if (l.clipped && a.clipping === false)
      notes.push(`${path}: clipped in the source; not applied (clipping off)`);
    else if (l.clipped) {
      const base = clipBase.get(groupKey);
      if (mesh && base) {
        tx.run('mesh.setClip', { target: mesh, masks: [base] });
        notes.push(`${path}: clipped by ${d.describe(base)} (from the source's clipping)`);
      } else
        notes.push(
          `${[...l.group, l.name].join('/')}: clipping could not be applied (no mesh for it or its base layer)`,
        );
    } else clipBase.set(groupKey, mesh);
  }
  return {
    result: { parts, layers, meshes, meshStats, notes },
    previews: [
      preview(
        compositeArt(art),
        `Imported ${layers.length} layer(s), ${parts.length} part(s), ${meshes.length} mesh(es) from ${source}.`,
      ),
    ],
  };
}

// ---------------------------------------------------------------- re-import (design 6)

/** The `path#group/name` a layer was imported from, split. */
function sourceOf(source: string | null): { file: string; path: string } | null {
  if (!source) return null;
  const i = source.lastIndexOf('#');
  return i < 0 ? null : { file: source.slice(0, i), path: source.slice(i + 1) };
}

const ALPHA = 8;
const MISSING = 'missing from ';

/** Fraction of opaque pixels outside a mesh, and of the mesh's area over empty pixels. */
function coverage(image: Image, uv: ArrayLike<number>, triangles: ArrayLike<number>) {
  const { width: w, height: h, data } = image;
  const inside = new Uint8Array(w * h);
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
    const ax = uv[2 * a]!,
      ay = uv[2 * a + 1]!,
      bx = uv[2 * b]!,
      by = uv[2 * b + 1]!;
    const cx = uv[2 * c]!,
      cy = uv[2 * c + 1]!;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        if (l0 >= -1e-9 && l1 >= -1e-9 && 1 - l0 - l1 >= -1e-9) inside[y * w + x] = 1;
      }
  }
  let opaque = 0;
  let uncovered = 0;
  let area = 0;
  let empty = 0;
  for (let i = 0; i < w * h; i++) {
    const o = data[4 * i + 3]! >= ALPHA;
    if (o) opaque++;
    if (o && !inside[i]) uncovered++;
    if (inside[i]) {
      area++;
      if (!o) empty++;
    }
  }
  return { uncovered: opaque ? uncovered / opaque : 0, overEmpty: area ? empty / area : 0 };
}

/** Fraction of canvas pixels whose opacity (in or out) differs between two placed images. */
function shapeChange(
  a: { image: Image; x: number; y: number },
  b: { image: Image; x: number; y: number },
): number {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.image.width, b.x + b.image.width);
  const y1 = Math.max(a.y + a.image.height, b.y + b.image.height);
  const at = (p: { image: Image; x: number; y: number }, x: number, y: number) => {
    const u = x - p.x;
    const v = y - p.y;
    if (u < 0 || v < 0 || u >= p.image.width || v >= p.image.height) return false;
    return p.image.data[4 * (v * p.image.width + u) + 3]! >= ALPHA;
  };
  let union = 0;
  let diff = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = at(a, x, y);
      const q = at(b, x, y);
      if (p || q) union++;
      if (p !== q) diff++;
    }
  return union ? diff / union : 0;
}

/** When a mesh is flagged for re-fitting. */
export const REFIT = { uncovered: 0.002, overEmptyGrowth: 0.1, shapeChange: 0.01 };

const ReimportResult = Type.Object({
  path: Type.String(),
  unchanged: Type.Integer(),
  changed: Type.Array(
    Type.Object({
      layer: Type.String(),
      name: Type.String(),
      boundsChanged: Type.Boolean(),
      shapeChange: Type.Number(),
      movedFrom: Type.Optional(Type.String()),
    }),
  ),
  refit: Type.Array(
    Type.Object({
      mesh: Type.String(),
      layer: Type.String(),
      reasons: Type.Array(Type.String()),
      uncovered: Type.Number(),
      overEmpty: Type.Number(),
    }),
  ),
  added: Type.Array(
    Type.Object({ layer: Type.String(), name: Type.String(), path: Type.String() }),
  ),
  removed: Type.Array(
    Type.Object({ layer: Type.String(), name: Type.String(), meshes: Type.Array(Type.String()) }),
  ),
  notes: Type.Array(Type.String()),
});
export type ReimportResult = Static<typeof ReimportResult>;

export const artReimport = defineOperation({
  name: 'art.reimport',
  summary:
    'Re-import changed art: replace matching layers’ pixels, keep meshes in place, report what needs re-fitting.',
  doc: `Reads the file again and matches its layers to the project's layers by group path and name
(the source recorded at import), falling back to the name alone when a layer moved to another
group. For each match whose pixels or bounds changed, it runs layer.setImage: the layer points at
the new pixels; meshes keep their positions, and their texture coordinates follow the layer's new
top-left corner, so they keep showing the same canvas pixels.

The result reports:
- \`changed\`: layers whose pixels changed (with whether their bounds or their shape changed);
- \`refit\`: meshes that may need re-fitting (mesh.regenerate, or editing by hand), with the reason
  and the measured fractions: art outside the mesh, or the mesh's area over empty pixels;
- \`added\`: layers that are new in the file; they are created (unless \`addNew\` is false) but not
  meshed;
- \`removed\`: layers no longer in the file; they and their meshes are kept, and the layer gets a
  note;
- \`unchanged\`: the number of matched layers with the same pixels.

All in one undoable transaction. Run it as a dry run to see the report without changing anything.
Candidates are the layers imported from \`path\`; if none were, every layer imported from any file
is a candidate (the file moved or was renamed).`,
  args: Type.Object({
    path: Type.String({ description: 'the .psd, .ora or .png file, or the folder of PNGs' }),
    format: Type.Optional(
      Type.Union([
        Type.Literal('psd'),
        Type.Literal('ora'),
        Type.Literal('folder'),
        Type.Literal('png'),
      ]),
    ),
    addNew: Type.Optional(
      Type.Boolean({ description: 'create layers that are new in the file (default true)' }),
    ),
  }),
  result: ReimportResult,
  errors: ['E_NOT_FOUND', 'E_ASSET_FORMAT'],
  examples: [
    { description: 'Re-import the PSD after editing it', args: { path: 'art/character.psd' } },
  ],
  async run(ctx, tx, a) {
    const art = await readArt(ctx, a.path, a.format);
    const d = tx.draft;
    const notes = [...art.notes];
    const all = d
      .ofKind('layer')
      .map((l) => ({ layer: l, src: sourceOf(l.source) }))
      .filter(
        (x): x is { layer: (typeof x)['layer']; src: { file: string; path: string } } =>
          x.src !== null,
      );
    let candidates = all.filter((x) => x.src.file === a.path);
    if (candidates.length === 0 && all.length > 0) {
      candidates = all;
      notes.push(`No layer was imported from ${a.path}; matching against every imported layer.`);
    }
    const unmatched = new Set(candidates);
    const keyOf = (l: { group: string[]; name: string }) => [...l.group, l.name].join('/');
    const result = {
      path: a.path,
      unchanged: 0,
      changed: [] as ReimportResult['changed'],
      refit: [] as ReimportResult['refit'],
      added: [] as ReimportResult['added'],
      removed: [] as ReimportResult['removed'],
      notes,
    };
    const meshesOf = (layer: string) => d.ofKind('artMesh').filter((m) => m.layer === layer);

    for (const l of art.layers) {
      const key = keyOf(l);
      let match = [...unmatched].find((c) => c.src.path === key);
      let movedFrom: string | undefined;
      if (!match) {
        const byName = [...unmatched].filter((c) => c.src.path.split('/').pop() === l.name);
        if (byName.length === 1) {
          match = byName[0];
          movedFrom = match!.src.path;
        }
      }
      const source = `${a.path}#${key}`;
      if (!match) {
        if (a.addNew === false) {
          notes.push(`${key}: new in the file; not added (addNew is false)`);
          continue;
        }
        const asset = await ctx.assets.put(encodePng(l.image));
        const { uid } = tx.run('layer.create', {
          name: l.name,
          asset,
          x: l.x,
          y: l.y,
          width: l.image.width,
          height: l.image.height,
          visible: l.visible,
          opacity: l.opacity,
          blendMode: l.blendMode,
          clipped: l.clipped,
          notes: [...l.notes, 'new at re-import; not meshed yet'],
          source,
        });
        result.added.push({ layer: uid, name: l.name, path: key });
        continue;
      }
      unmatched.delete(match);
      const old = match.layer;
      const asset = await ctx.assets.put(encodePng(l.image));
      const boundsChanged =
        old.x !== l.x ||
        old.y !== l.y ||
        old.width !== l.image.width ||
        old.height !== l.image.height;
      const keptNotes = old.notes.filter((n) => !n.startsWith(MISSING));
      const props =
        old.visible !== l.visible ||
        old.opacity !== Math.fround(l.opacity) ||
        old.blendMode !== l.blendMode ||
        old.clipped !== l.clipped;
      if (asset === old.asset && !boundsChanged) {
        result.unchanged++;
        if (props || old.source !== source || keptNotes.length !== old.notes.length)
          tx.run('layer.setImage', {
            target: old.uid,
            asset,
            x: l.x,
            y: l.y,
            width: l.image.width,
            height: l.image.height,
            visible: l.visible,
            opacity: l.opacity,
            blendMode: l.blendMode,
            clipped: l.clipped,
            notes: keptNotes,
            source,
          });
        continue;
      }
      const before = await layerImage(ctx, d, old.uid);
      const change = shapeChange(
        { image: before, x: old.x, y: old.y },
        { image: l.image, x: l.x, y: l.y },
      );
      tx.run('layer.setImage', {
        target: old.uid,
        asset,
        x: l.x,
        y: l.y,
        width: l.image.width,
        height: l.image.height,
        visible: l.visible,
        opacity: l.opacity,
        blendMode: l.blendMode,
        clipped: l.clipped,
        notes: keptNotes,
        source,
      });
      result.changed.push({
        layer: old.uid,
        name: l.name,
        boundsChanged,
        shapeChange: Math.round(change * 1e4) / 1e4,
        ...(movedFrom ? { movedFrom } : {}),
      });
      if (movedFrom) notes.push(`${key}: matched by name (it was ${movedFrom})`);
      for (const mesh of meshesOf(old.uid)) {
        const m = d.getAs(mesh.uid, 'artMesh');
        const was = coverage(
          before,
          mesh.uv.map((v, i) => v + (i % 2 === 0 ? l.x - old.x : l.y - old.y)),
          mesh.triangles,
        );
        const now = coverage(l.image, m.uv, m.triangles);
        const reasons: string[] = [];
        if (now.uncovered > REFIT.uncovered) reasons.push('art outside the mesh');
        if (now.overEmpty - was.overEmpty > REFIT.overEmptyGrowth)
          reasons.push('mesh over empty pixels');
        if (change > REFIT.shapeChange && reasons.length === 0 && boundsChanged)
          reasons.push('bounds changed');
        if (reasons.length)
          result.refit.push({
            mesh: m.uid,
            layer: old.uid,
            reasons,
            uncovered: Math.round(now.uncovered * 1e4) / 1e4,
            overEmpty: Math.round(now.overEmpty * 1e4) / 1e4,
          });
      }
    }
    for (const c of unmatched) {
      const l = c.layer;
      const note = `${MISSING}${a.path} at re-import`;
      if (!l.notes.includes(note))
        tx.run('layer.update', {
          target: l.uid,
          notes: [...l.notes.filter((n) => !n.startsWith(MISSING)), note],
        });
      result.removed.push({
        layer: l.uid,
        name: l.name,
        meshes: meshesOf(l.uid).map((m) => m.uid),
      });
    }
    const summary = `Re-imported ${a.path}: ${result.changed.length} changed, ${result.unchanged} unchanged, ${result.added.length} added, ${result.removed.length} removed; ${result.refit.length} mesh(es) may need re-fitting.`;
    return { result, previews: [preview(compositeArt(art), summary)] };
  },
});

/** All image-based operations, for registries (CLI, MCP). */
export const ART_OPERATIONS: readonly OperationDef[] = [
  artImport,
  artReimport,
  meshGenerate,
  meshRegenerate,
  soundImport,
] as unknown as OperationDef[];
