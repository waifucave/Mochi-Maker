/**
 * The project folder format (design 3.8).
 *
 * Name.mochi/
 *   mochi-project.json     manifest: format, version, writer, UID counter, the project object
 *   parameters.json        parameters and parameter groups
 *   parts.json, layers.json, glues.json, physics.json
 *   meshes/<uid>.json, deformers/<uid>.json, expressions/<uid>.json, motions/<uid>.json
 *   assets/sha256-<hex>.png | .wav
 *
 * Collections are sorted by UID; order lives in the project object's lists. Text is deterministic
 * (json.ts), so saving an unchanged document rewrites nothing, and save → load → save is
 * byte-identical.
 */
import { decode, encode, type JsonTree } from './codec.js';
import { DocView, compareUids, type Document } from './document.js';
import { MochiError } from './errors.js';
import { Budget, LIMITS, isTooLarge, readCapped, tooLarge } from './limits.js';
import { FolderAssetStore, joinPath, type AssetStore, type FileSystem } from './fs.js';
import { checkInvariants } from './invariants.js';
import { parseJson, stringifyJson } from './json.js';
import { OBJECT_SCHEMAS, type DocObject } from './model.js';
import type { Kind } from './schema.js';

export const PROJECT_FORMAT = 'mochi-maker-project';
export const PROJECT_VERSION = 15;
export const WRITER = '@mochi-maker/core 0.0.0';
export const MANIFEST = 'mochi-project.json';

/** Files of one project version, as parsed JSON by relative path. Migrations edit it in place. */
export type ProjectBundle = Map<string, unknown>;

export interface Migration {
  /** Migrates a bundle of version `from` to `from + 1`. */
  from: number;
  migrate(bundle: ProjectBundle): void;
}

/** Migrations of the real format. */
export const MIGRATIONS: Migration[] = [
  {
    // Version 2: layers record the source layer's opacity, blend mode, clipping and
    // import notes.
    from: 1,
    migrate(bundle) {
      const file = bundle.get('layers.json') as { layers?: Record<string, unknown>[] } | undefined;
      for (const layer of file?.layers ?? []) {
        const source = layer.source;
        delete layer.source;
        layer.opacity ??= 1;
        layer.blendMode ??= 'normal';
        layer.clipped ??= false;
        layer.notes ??= [];
        layer.source = source ?? null;
      }
    },
  },
  {
    // Version 3 (M8): parts, meshes, warps and rotations hold blend shapes.
    from: 2,
    migrate(bundle) {
      const add = (o: Record<string, unknown>) => {
        if (['part', 'artMesh', 'warp', 'rotation'].includes(o.kind as string))
          o.blendShapes ??= [];
      };
      const parts = bundle.get('parts.json') as { parts?: Record<string, unknown>[] } | undefined;
      for (const p of parts?.parts ?? []) add(p);
      for (const [path, value] of bundle)
        if (path.startsWith('meshes/') || path.startsWith('deformers/'))
          add(value as Record<string, unknown>);
    },
  },
  {
    // Version 4: glues can be blend-shape targets.
    from: 3,
    migrate(bundle) {
      const glues = bundle.get('glues.json') as { glues?: Record<string, unknown>[] } | undefined;
      for (const g of glues?.glues ?? []) g.blendShapes ??= [];
    },
  },
  {
    // Version 5: WAV sounds, and motions that start one.
    from: 4,
    migrate(bundle) {
      const manifest = bundle.get(MANIFEST) as { project?: Record<string, unknown> } | undefined;
      if (manifest?.project) manifest.project.soundOrder ??= [];
      for (const [path, value] of bundle)
        if (path.startsWith('motions/')) (value as Record<string, unknown>).sound ??= null;
    },
  },
  {
    // Version 6 (M10): curves list their Auto smooth segments.
    from: 5,
    migrate(bundle) {
      for (const [path, value] of bundle)
        if (path.startsWith('motions/'))
          for (const c of (value as { curves?: Record<string, unknown>[] }).curves ?? [])
            c.auto ??= [];
    },
  },
  {
    // Version 7 (M10): the project holds animation templates.
    from: 6,
    migrate(bundle) {
      const manifest = bundle.get(MANIFEST) as { project?: Record<string, unknown> } | undefined;
      if (manifest?.project) manifest.project.animationTemplates ??= [];
    },
  },
  {
    // Version 8: the project keeps deform paths (editor-side, not exported).
    from: 7,
    migrate(bundle) {
      const manifest = bundle.get(MANIFEST) as { project?: Record<string, unknown> } | undefined;
      if (manifest?.project) manifest.project.deformPaths ??= [];
    },
  },
  {
    // Version 9: guide-image parts, and the export setting that includes them.
    from: 8,
    migrate(bundle) {
      const manifest = bundle.get(MANIFEST) as { project?: Record<string, unknown> } | undefined;
      const settings = manifest?.project?.exportSettings as Record<string, unknown> | undefined;
      if (settings) settings.includeGuideImages ??= false;
      const parts = bundle.get('parts.json') as { parts?: Record<string, unknown>[] } | undefined;
      for (const p of parts?.parts ?? []) p.guide ??= false;
    },
  },
  {
    // Version 10: motions keep a work area and markers (editor-side, not exported).
    from: 9,
    migrate(bundle) {
      for (const [path, value] of bundle)
        if (path.startsWith('motions/')) {
          const m = value as Record<string, unknown>;
          m.workArea ??= null;
          m.markers ??= [];
        }
    },
  },
  {
    // Version 11: motion-sync settings.
    from: 10,
    migrate(bundle) {
      const manifest = bundle.get(MANIFEST) as { project?: Record<string, unknown> } | undefined;
      if (manifest?.project) manifest.project.motionSyncOrder ??= [];
    },
  },
  {
    // Version 12: a motion can name the motion-sync setting its sound drives.
    from: 11,
    migrate(bundle) {
      for (const [path, value] of bundle)
        if (path.startsWith('motions/')) (value as Record<string, unknown>).motionSync ??= null;
    },
  },
  {
    // Version 13: model import. Layers can be texture pages kept as they are, and the project
    // notes where it was imported from.
    from: 12,
    migrate(bundle) {
      const manifest = bundle.get(MANIFEST) as { project?: Record<string, unknown> } | undefined;
      if (manifest?.project) manifest.project.importedFrom ??= null;
      const file = bundle.get('layers.json') as { layers?: Record<string, unknown>[] } | undefined;
      for (const layer of file?.layers ?? []) layer.texturePage ??= false;
    },
  },
  {
    // Version 14: explicit stacking orders, and what an import keeps of the file.
    from: 13,
    migrate(bundle) {
      const manifest = bundle.get(MANIFEST) as { project?: Record<string, unknown> } | undefined;
      if (!manifest?.project) return;
      manifest.project.stacks ??= [];
      const from = manifest.project.importedFrom as Record<string, unknown> | null | undefined;
      if (from) from.keep ??= null;
    },
  },
  {
    // Version 15 (version 6 models): parts can draw offscreen, with an opacity and tints in their
    // keyforms and blend shapes; art meshes can have a version 6 blend mode.
    from: 14,
    migrate(bundle) {
      const manifest = bundle.get(MANIFEST) as { project?: Record<string, unknown> } | undefined;
      const from = manifest?.project?.importedFrom as { keep?: Record<string, unknown> } | null;
      if (from?.keep) {
        from.keep.blendCodes ??= [];
        from.keep.offscreenFlags ??= [];
        from.keep.offscreens ??= [];
        from.keep.blendFlags ??= [];
      }
      const parts = bundle.get('parts.json') as { parts?: Record<string, unknown>[] } | undefined;
      for (const p of parts?.parts ?? []) {
        p.offscreen ??= null;
        const rig = p.rig as { keyforms?: Record<string, unknown>[] } | undefined;
        for (const k of rig?.keyforms ?? []) {
          k.opacity ??= 1;
          k.multiply ??= [1, 1, 1];
          k.screen ??= [0, 0, 0];
        }
        for (const b of (p.blendShapes as { deltas?: Record<string, unknown>[] }[]) ?? [])
          for (const k of b.deltas ?? []) {
            k.opacity ??= 0;
            k.multiply ??= [0, 0, 0];
            k.screen ??= [0, 0, 0];
          }
      }
      for (const [path, value] of bundle)
        if (path.startsWith('meshes/')) (value as Record<string, unknown>).blend ??= null;
    },
  },
];

const COLLECTION_FILES: Record<string, { key: string; kinds: Kind[] }> = {
  'parameters.json': { key: 'parameters', kinds: ['parameter', 'parameterGroup'] },
  'parts.json': { key: 'parts', kinds: ['part'] },
  'layers.json': { key: 'layers', kinds: ['layer'] },
  'glues.json': { key: 'glues', kinds: ['glue'] },
  'physics.json': { key: 'settings', kinds: ['physicsSetting'] },
  'motionsync.json': { key: 'settings', kinds: ['motionSyncSetting'] },
  'sounds.json': { key: 'sounds', kinds: ['sound'] },
};

const OBJECT_DIRS: Record<string, Kind[]> = {
  meshes: ['artMesh'],
  deformers: ['warp', 'rotation'],
  expressions: ['expression'],
  motions: ['motion'],
};

/** The text of every project file, by relative path (assets excluded). */
export function projectFiles(doc: Document): Map<string, string> {
  const files = new Map<string, string>();
  const objects = Object.values(doc.objects).sort((a, b) => compareUids(a.uid, b.uid));
  const enc = (o: DocObject) => encode(OBJECT_SCHEMAS[o.kind], o);
  files.set(
    MANIFEST,
    stringifyJson({
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      writer: WRITER,
      seq: doc.seq,
      project: enc(doc.objects.project!),
    }),
  );
  for (const [file, { key, kinds }] of Object.entries(COLLECTION_FILES))
    files.set(
      file,
      stringifyJson({ [key]: objects.filter((o) => kinds.includes(o.kind)).map(enc) } as JsonTree),
    );
  for (const [dir, kinds] of Object.entries(OBJECT_DIRS))
    for (const o of objects.filter((x) => kinds.includes(x.kind)))
      files.set(`${dir}/${o.uid}.json`, stringifyJson(enc(o)));
  return files;
}

export interface SaveReport {
  written: string[];
  removed: string[];
}

/**
 * Saves a document to a project folder. Unchanged files are not rewritten and stale object files
 * are removed. Every referenced asset must be in `assets`. Unreferenced assets are kept, because
 * undo can bring their layers back; removing them is a separate clean-up step.
 */
export async function saveProject(
  fs: FileSystem,
  dir: string,
  doc: Document,
  assets: AssetStore,
): Promise<SaveReport> {
  const report: SaveReport = { written: [], removed: [] };
  const files = projectFiles(doc);
  await fs.mkdir(dir);
  for (const [rel, text] of files) {
    const path = joinPath(dir, rel);
    if ((await fs.exists(path)) && (await fs.readText(path)) === text) continue;
    await fs.writeText(path, text);
    report.written.push(rel);
  }
  for (const sub of Object.keys(OBJECT_DIRS))
    for (const name of await fs.list(joinPath(dir, sub))) {
      const rel = `${sub}/${name}`;
      if (!files.has(rel) && name.endsWith('.json')) {
        await fs.remove(joinPath(dir, rel));
        report.removed.push(rel);
      }
    }
  // Assets: layer images as .png, sounds as .wav.
  const assetFiles = new Map<string, string>();
  for (const o of Object.values(doc.objects))
    if (o.kind === 'layer') assetFiles.set(o.asset, 'png');
    else if (o.kind === 'sound') assetFiles.set(o.asset, 'wav');
  for (const [h, ext] of [...assetFiles].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rel = `assets/sha256-${h}.${ext}`;
    const path = joinPath(dir, rel);
    if (await fs.exists(path)) continue;
    if (!(await assets.has(h)))
      throw new MochiError(
        'E_ASSET_MISSING',
        `Asset ${h} is referenced by the document but not available.`,
      );
    await fs.writeBytes(path, await assets.get(h));
    report.written.push(rel);
  }
  return report;
}

/** One JSON file within its cap; `budget` counts its bytes where they were not counted before. */
async function readJson(fs: FileSystem, path: string, budget?: Budget): Promise<unknown> {
  let text: string;
  try {
    const bytes = await readCapped(fs, path, LIMITS.projectFileBytes);
    budget?.take(bytes.length);
    text = new TextDecoder().decode(bytes);
  } catch (e) {
    if (isTooLarge(e)) throw e;
    if (e instanceof MochiError)
      throw new MochiError('E_PROJECT_FORMAT', `Missing project file: ${path}`);
    throw e;
  }
  try {
    return parseJson(text);
  } catch (e) {
    throw new MochiError('E_PROJECT_FORMAT', `${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * Reads every project file into a bundle, within the caps on a project folder (LIMITS: each JSON
 * file, all of them together, and the number of object files). The files are listed and their
 * sizes summed first, where the file system can tell them, so a folder over a cap is refused
 * before any of it is read.
 */
export async function readBundle(fs: FileSystem, dir: string): Promise<ProjectBundle> {
  const paths: [key: string, path: string][] = [[MANIFEST, joinPath(dir, MANIFEST)]];
  for (const file of Object.keys(COLLECTION_FILES)) {
    const path = joinPath(dir, file);
    if (await fs.exists(path)) paths.push([file, path]);
  }
  let objects = 0;
  for (const sub of Object.keys(OBJECT_DIRS))
    for (const name of await fs.list(joinPath(dir, sub)))
      if (name.endsWith('.json')) {
        if (++objects > LIMITS.projectFiles)
          throw tooLarge(`The project ${dir}`, objects, LIMITS.projectFiles, 'object files');
        paths.push([`${sub}/${name}`, joinPath(dir, sub, name)]);
      }
  const what = `The project ${dir}, all its files together,`;
  const sized = new Budget(LIMITS.projectBytes, what);
  if (fs.size)
    for (const [, path] of paths) {
      const n = await fs.size(path);
      if (n !== undefined) {
        if (n > LIMITS.projectFileBytes) throw tooLarge(path, n, LIMITS.projectFileBytes);
        sized.take(n);
      }
    }
  const unsized = fs.size ? undefined : new Budget(LIMITS.projectBytes, what);
  const bundle: ProjectBundle = new Map();
  for (const [key, path] of paths) bundle.set(key, await readJson(fs, path, unsized));
  return bundle;
}

export interface LoadOptions {
  migrations?: Migration[];
  currentVersion?: number;
}

/** Migrates a bundle to the current version and decodes it into a document. */
export function decodeBundle(bundle: ProjectBundle, options: LoadOptions = {}): Document {
  const migrations = options.migrations ?? MIGRATIONS;
  const current = options.currentVersion ?? PROJECT_VERSION;
  const manifest = bundle.get(MANIFEST) as Record<string, unknown> | undefined;
  if (!manifest || manifest.format !== PROJECT_FORMAT)
    throw new MochiError(
      'E_PROJECT_FORMAT',
      `${MANIFEST} is missing or is not a Mochi Maker project manifest.`,
    );
  let version = manifest.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new MochiError('E_PROJECT_FORMAT', `${MANIFEST} has no valid version.`);
  if (version > current)
    throw new MochiError(
      'E_PROJECT_TOO_NEW',
      `The project has format version ${version}; this version of Mochi Maker reads up to ${current}. Please update.`,
    );
  while (version < current) {
    const m = migrations.find((x) => x.from === version);
    if (!m)
      throw new MochiError('E_PROJECT_FORMAT', `No migration from project version ${version}.`);
    m.migrate(bundle);
    version++;
    (bundle.get(MANIFEST) as Record<string, unknown>).version = version;
  }

  const m = bundle.get(MANIFEST) as Record<string, unknown>;
  if (typeof m.seq !== 'number' || !Number.isInteger(m.seq) || m.seq < 1)
    throw new MochiError('E_PROJECT_FORMAT', `${MANIFEST}: seq must be a positive integer.`);
  const objects: Record<string, DocObject> = {};
  const add = (value: unknown, path: string, kinds: Kind[]) => {
    const kind = (value as { kind?: unknown } | null)?.kind;
    if (typeof kind !== 'string' || !kinds.includes(kind as Kind))
      throw new MochiError('E_PROJECT_FORMAT', `${path}: expected a ${kinds.join(' or ')}.`);
    let o: DocObject;
    try {
      o = decode<DocObject>(OBJECT_SCHEMAS[kind as Kind], value);
    } catch (e) {
      throw new MochiError('E_PROJECT_FORMAT', `${path}: ${(e as Error).message}`);
    }
    if (objects[o.uid])
      throw new MochiError('E_PROJECT_FORMAT', `${path}: the UID ${o.uid} is used twice.`);
    objects[o.uid] = o;
  };
  add(m.project, `${MANIFEST}.project`, ['project']);
  for (const [path, value] of bundle) {
    if (path === MANIFEST) continue;
    const coll = COLLECTION_FILES[path];
    if (coll) {
      const list = (value as Record<string, unknown> | null)?.[coll.key];
      if (!Array.isArray(list))
        throw new MochiError('E_PROJECT_FORMAT', `${path}: expected "${coll.key}" to be a list.`);
      list.forEach((v, i) => add(v, `${path}.${coll.key}[${i}]`, coll.kinds));
      continue;
    }
    const dir = path.split('/')[0]!;
    const kinds = OBJECT_DIRS[dir];
    if (!kinds) continue;
    add(value, path, kinds);
    const uid = (value as { uid: string }).uid;
    if (path !== `${dir}/${uid}.json`)
      throw new MochiError('E_PROJECT_FORMAT', `${path}: the file name must be ${uid}.json.`);
  }
  for (const uid of Object.keys(objects)) {
    const n = Number(uid.slice(uid.lastIndexOf('_') + 1));
    if (uid !== 'project' && n >= (m.seq as number))
      throw new MochiError(
        'E_PROJECT_FORMAT',
        `The UID ${uid} is not below the manifest's seq ${m.seq}.`,
      );
  }
  const doc: Document = { objects, seq: m.seq as number };
  const violations = checkInvariants(new DocView(doc));
  if (violations.length > 0)
    throw new MochiError(
      'E_PROJECT_FORMAT',
      `The project is inconsistent: ${violations[0]!.uid} ${violations[0]!.path}: ${violations[0]!.message}`,
      {
        details: { violations: violations.slice(0, 50) },
      },
    );
  return doc;
}

export async function loadProject(
  fs: FileSystem,
  dir: string,
  options: LoadOptions = {},
): Promise<{ doc: Document; assets: AssetStore }> {
  const doc = decodeBundle(await readBundle(fs, dir), options);
  return { doc, assets: new FolderAssetStore(fs, joinPath(dir, 'assets')) };
}
