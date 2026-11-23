/**
 * Export (design 4.3): document → runtime model folder, through Mochi2D's public model data.
 *
 * lint → version → atlas → lowering → validateMoc (official, strict) → writeMoc → JSON files →
 * load check in Mochi2D → export report. The same document, assets and options always give
 * byte-identical files.
 */
import {
  DocView,
  Draft,
  FEATURES,
  Tx,
  MochiError,
  featureOff,
  featuresFromEnv,
  lint,
  sha256Hex,
  type AssetStore,
  type Features,
  type Document,
  type DocReader,
  type Uid,
  VERSION,
} from '@mochi-maker/core';
import { decodePng, encodePng } from '@mochi-maker/art';
import type { Image } from '@mochi-maker/geometry';
import {
  MOCHI2D_VERSION,
  MocWriteError,
  loadMoc,
  parseDisplayInfo,
  parseExpression,
  parseModelSettings,
  parseMotionSync,
  parseMotion,
  parsePhysics,
  parsePose,
  parseUserData,
  readTextureHeader,
  decodeWav,
  scenarioResult,
  validateMoc,
  writeMoc,
  type MocDiagnostic,
  type MocVersion,
} from 'mochi2d/headless';
import { buildAtlas, type AtlasRegion } from './atlas.js';
import { BUILD_TEXTURES, FOREIGN_MODEL } from './caps.js';
import {
  displayInfo,
  expressionFile,
  jsonText,
  modelSettings,
  motionFile,
  motionSyncText,
  physicsFile,
  planFiles,
  type ModelFiles,
  poseFile,
  userDataFile,
} from './files.js';
import { lowerDocument, type LowerResult } from './lower.js';
import { checkWriterRules } from './rules.js';

export const EXPORT_REPORT_FORMAT = 'mochi-maker-export';

export interface ExportOptions {
  /** Overrides the project's setting. */
  mocVersion?: 'auto' | 3 | 4 | 5 | 6;
  atlasSize?: 1024 | 2048 | 4096 | 8192;
  fileStem?: string;
  /** Glue and blend shapes (default: MOCHI_MAKER_FEATURES, else off): with one off, a project that holds it is refused. */
  features?: Features;
}

export interface ExportProblem {
  severity: 'error' | 'warning';
  source:
    'lint' | 'version' | 'writer-rules' | 'validate-official' | 'validate-strict' | 'load-check';
  code: string;
  message: string;
  uid?: Uid;
  /** For writer-rule problems: what to change. */
  fix?: string;
}

export interface ExportReport {
  format: typeof EXPORT_REPORT_FORMAT;
  version: 1;
  producer: string;
  mocVersion: MocVersion;
  versionReason: string;
  files: { path: string; bytes: number; sha256: string }[];
  ids: Record<'parameters' | 'parts' | 'deformers' | 'artMeshes' | 'glues', Record<Uid, string>>;
  counts: Record<string, number>;
  atlas: {
    pages: { file: string; width: number; height: number }[];
    regions: (AtlasRegion & { name: string })[];
  };
  loadCheck: { drawables: number; visibleAtDefault: number; warnings: string[] };
  problems: ExportProblem[];
}

export interface ExportResult {
  /** Relative path → bytes, sorted by path. */
  files: Map<string, Uint8Array>;
  report: ExportReport;
}

/** Why a document needs a file version (design 2.2, roadmap M13). */
export interface VersionReason {
  uid: Uid;
  version: 4 | 5 | 6;
  feature: string;
  /** What to change to export at a lower version. */
  fix: string;
}

const DELTA_FIELDS: Record<string, string> = {
  opacity: 'opacity',
  drawOrder: 'draw order',
  multiply: 'multiply color',
  screen: 'screen color',
};

/**
 * The lowest file version that carries every feature the document uses, and why (design 2.2).
 * - Version 4: multiply and screen colors; blend shapes on meshes and warps that move
 *   positions or grid points only (§1c.4: version 4 ignores every other blend-shape value).
 * - Version 5: blend shapes on rotations, parts and glues, and blend shapes that change opacity,
 *   draw order or colors.
 * Each reason names the object and, for blend shapes, the parameter and the values, with a fix.
 * Most demanding reasons come first.
 */
export function requiredVersion(doc: DocReader): {
  version: 3 | 4 | 5 | 6;
  reasons: VersionReason[];
} {
  const reasons: VersionReason[] = [];
  for (const p of doc.ofKind('part'))
    if (p.offscreen)
      reasons.push({
        uid: p.uid,
        version: 6,
        feature: 'offscreen drawing (version 6)',
        fix: `Export at version 6, or stop drawing it offscreen (part.setOffscreen target ${p.uid}, offscreen false).`,
      });
  for (const m of doc.ofKind('artMesh'))
    if (m.blend)
      reasons.push({
        uid: m.uid,
        version: 6,
        feature: `the blend mode ${m.blend.color} ${m.blend.alpha} (version 6)`,
        fix: `Export at version 6, or use a blending every version has (mesh.update target ${m.uid}, blend null).`,
      });
  for (const o of doc.ofKind(['artMesh', 'warp', 'rotation'])) {
    const kfs = o.rig.keyforms as { multiply: number[]; screen: number[] }[];
    const colored = kfs.filter(
      (k) => k.multiply.some((c) => c !== 1) || k.screen.some((c) => c !== 0),
    ).length;
    if (colored)
      reasons.push({
        uid: o.uid,
        version: 4,
        feature: `multiply or screen colors in ${colored} of ${kfs.length} keyform(s) (version 4)`,
        fix: 'Export at version 4 or later, or set multiply (1, 1, 1) and screen (0, 0, 0) in every keyform (keyform.set with all: true).',
      });
  }
  for (const o of doc.ofKind(['artMesh', 'warp', 'rotation', 'part', 'glue']))
    for (const b of o.blendShapes) {
      const param = doc.get(b.parameter) as { exportId: string } | undefined;
      const name = param?.exportId ?? b.parameter;
      const remove = `remove the blend shape (blendShape.remove target ${o.uid}, parameter ${name})`;
      if (o.kind === 'rotation' || o.kind === 'part' || o.kind === 'glue') {
        reasons.push({
          uid: o.uid,
          version: 5,
          feature: `blend shapes on a ${o.kind}: ${name} (version 5)`,
          fix: `Export at version 5, or ${remove}.`,
        });
        continue;
      }
      const fields = Object.keys(DELTA_FIELDS).filter((f) =>
        b.deltas.some((d) => {
          const v = (d as unknown as Record<string, number | number[] | undefined>)[f];
          return Array.isArray(v) ? v.some((x) => x !== 0) : (v ?? 0) !== 0;
        }),
      );
      reasons.push(
        fields.length > 0
          ? {
              uid: o.uid,
              version: 5,
              feature: `blend shapes on opacity, draw order or colors: ${name} changes ${fields.map((f) => DELTA_FIELDS[f]).join(', ')} (version 5)`,
              fix: `Export at version 5, or set those deltas to 0 in ${name}'s blend shape (blendShape.set) so it moves ${o.kind === 'warp' ? 'grid points' : 'positions'} only.`,
            }
          : {
              uid: o.uid,
              version: 4,
              feature: `blend shapes on positions: ${name} (version 4)`,
              fix: `Export at version 4 or later, or ${remove}.`,
            },
      );
    }
  const version = reasons.reduce<3 | 4 | 5 | 6>((v, r) => (r.version > v ? r.version : v), 3);
  reasons.sort((a, b) => b.version - a.version);
  return { version, reasons };
}

function fail(message: string, problems: ExportProblem[]): never {
  throw new MochiError(
    'E_EXPORT',
    `${message} ${problems
      .filter((p) => p.severity === 'error')
      .slice(0, 3)
      .map((p) => p.message)
      .join(' ')}`.trim(),
    {
      details: { problems },
    },
  );
}

/** Maps a Mochi2D diagnostic back to the document object it is about, where possible. */
function describeDiagnostic(
  d: { kind: string; index?: number; message: string; code: string },
  lowered: LowerResult,
  doc: DocReader,
): { uid?: Uid; message: string } {
  const direct: Partial<Record<string, Uid[]>> = {
    parts: lowered.uids.parts,
    deformers: lowered.uids.deformers,
    artMeshes: lowered.uids.artMeshes,
    parameters: lowered.uids.parameters,
    glues: lowered.uids.glues,
  };
  const list = direct[d.kind];
  const uid = list && d.index !== undefined ? list[d.index] : undefined;
  return {
    uid,
    message: uid
      ? `${doc.describe(uid)}: ${d.message} [${d.code}]`
      : `${d.kind}${d.index !== undefined ? `[${d.index}]` : ''}: ${d.message} [${d.code}]`,
  };
}

/**
 * The document without its guide-image parts: each top guide part deleted with
 * everything in it, references removed as `part.delete` with cascade removes them.
 */
export function withoutGuideImages(document: Document): Document {
  const v = new DocView(document);
  const parts = v.ofKind('part');
  const isGuide = new Set(parts.filter((p) => p.guide).map((p) => p.uid));
  if (isGuide.size === 0) return document;
  const tops = parts.filter((p) => {
    if (!p.guide) return false;
    for (let u = p.parent; u; u = v.getAs(u, 'part').parent) if (isGuide.has(u)) return false;
    return true;
  });
  const tx = new Tx(new Draft(document));
  for (const p of tops) tx.run('part.delete', { target: p.uid, cascade: true });
  return tx.draft.finish().doc;
}

export async function exportModel(
  input: Document,
  assets: AssetStore,
  options: ExportOptions = {},
): Promise<ExportResult> {
  // Guide images stay out unless the export settings ask for them.
  const document = new DocView(input).project().exportSettings.includeGuideImages
    ? input
    : withoutGuideImages(input);
  const doc = new DocView(document);
  const settings = doc.project().exportSettings;
  const problems: ExportProblem[] = [];
  // A feature that is off in this build refuses the export of a project that holds it.
  const used = featuresUsed(doc);
  const features = options.features ?? featuresFromEnv();
  for (const f of FEATURES) if (used[f] && !features[f]) throw featureOff(f);

  // 1. Lint: errors block the export.
  for (const l of lint(doc))
    problems.push({
      severity: l.severity,
      source: 'lint',
      code: l.rule,
      message: l.message,
      uid: l.uid,
    });
  if (doc.ofKind('artMesh').length === 0)
    problems.push({
      severity: 'error',
      source: 'lint',
      code: 'no-meshes',
      message: 'The model has no art meshes.',
    });
  if (problems.some((p) => p.severity === 'error'))
    fail('The document cannot be exported:', problems);

  // 2. The file version.
  const need = requiredVersion(doc);
  const setting = options.mocVersion ?? settings.mocVersion;
  let version: MocVersion;
  let versionReason: string;
  if (setting === 'auto') {
    version = Math.max(settings.minimumVersion, need.version) as MocVersion;
    versionReason =
      version === settings.minimumVersion
        ? `auto: the project's minimum version ${settings.minimumVersion}`
        : `auto: ${need.reasons.length} object(s) need version ${need.version}, for example ${doc.describe(need.reasons[0]!.uid)} (${need.reasons[0]!.feature})`;
  } else {
    version = setting;
    versionReason = `set to version ${setting}`;
    if (setting < need.version) {
      for (const r of need.reasons.filter((x) => x.version > setting))
        problems.push({
          severity: 'error',
          source: 'version',
          code: 'feature-needs-version',
          uid: r.uid,
          message: `${doc.describe(r.uid)} uses ${r.feature}; version ${setting} cannot carry it. Fix: ${r.fix}`,
          fix: r.fix,
        });
      fail(`Version ${setting} cannot carry this model.`, problems);
    }
  }

  // 3. Atlas.
  const images = new Map<Uid, Image>();
  for (const m of doc.ofKind('artMesh')) {
    if (!m.layer || images.has(m.layer)) continue;
    const layer = doc.getAs(m.layer, 'layer');
    if (!(await assets.has(layer.asset)))
      throw new MochiError(
        'E_ASSET_MISSING',
        `The image of layer "${layer.name}" is not available, so its meshes cannot be textured.`,
      );
    images.set(layer.uid, decodePng(await assets.get(layer.asset), `layer "${layer.name}"`));
  }
  const pageSize = options.atlasSize ?? settings.atlasSize;
  const atlas = buildAtlas(doc, images, pageSize);

  // 4. Lowering, the writer rules, and validation at both levels.
  const lowered = lowerDocument(doc, { version, placement: atlas.placement });
  const kept = doc.project().importedFrom?.keep;
  for (const r of checkWriterRules(lowered.data, version, {
    decimals: (kept?.decimals.length ?? 0) > 0,
    displayFlags: (kept?.hidden.length ?? 0) > 0,
    groupRanges: (kept?.ranges.length ?? 0) > 0,
  })) {
    const { uid, message } = describeDiagnostic(r, lowered, doc);
    problems.push({
      severity: 'error',
      source: 'writer-rules',
      code: r.code,
      message: `${message} Fix: ${r.fix}`,
      fix: r.fix,
      uid,
    });
  }
  if (problems.some((p) => p.severity === 'error'))
    fail('The model breaks a rule of the file format:', problems);
  for (const level of ['official', 'strict'] as const) {
    const v = validateMoc(lowered.data, { version, level });
    for (const d of v.diagnostics) {
      if (
        level === 'strict' &&
        d.severity === 'error' &&
        problems.some((p) => p.source === 'validate-official' && p.code === d.code)
      )
        continue;
      const { uid, message } = describeDiagnostic(d, lowered, doc);
      if (level === 'official' && d.severity === 'warning') continue; // strict repeats warnings
      problems.push({
        severity: d.severity,
        source: level === 'official' ? 'validate-official' : 'validate-strict',
        code: d.code,
        message,
        uid,
      });
    }
  }
  if (problems.some((p) => p.severity === 'error'))
    fail(
      'The exported model would not pass validation (this is a Mochi Maker bug; please report it):',
      problems,
    );

  // 5. Write.
  let moc: Uint8Array;
  try {
    moc = writeMoc(lowered.data, { version });
  } catch (e) {
    if (e instanceof MocWriteError)
      fail(
        'Mochi2D refused to write the model (a Mochi Maker bug; please report it):',
        e.diagnostics.map((d) => ({
          severity: d.severity,
          source: 'validate-strict' as const,
          code: d.code,
          message: describeDiagnostic(d, lowered, doc).message,
        })),
      );
    throw e;
  }

  // 6. Files.
  const stem = options.fileStem ?? settings.fileStem;
  const plan = planFiles(doc, stem, atlas.pages.length, pageSize);
  const files = new Map<string, Uint8Array>();
  files.set(plan.moc, moc);
  // Texture pages kept as they are keep their PNG bytes; packed pages are encoded.
  for (const [i, p] of atlas.pages.entries()) {
    const kept = atlas.kept[i];
    files.set(
      plan.textures[i]!,
      kept ? await assets.get(doc.getAs(kept, 'layer').asset) : encodePng(p),
    );
  }
  await addRuntimeFiles(doc, plan, assets, files);
  const model3 = files.get(`${stem}.model3.json`)!;

  // 7. Load check: Mochi2D reads every file back, and evaluates the default pose.
  const check = (what: string, fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      problems.push({
        severity: 'error',
        source: 'load-check',
        code: 'load-failed',
        message: `${what}: ${(e as Error).message}`,
      });
    }
  };
  const bytesCheck = validateMoc(moc, { level: 'strict' });
  for (const d of bytesCheck.diagnostics.filter((x) => x.severity === 'error'))
    problems.push({
      severity: 'error',
      source: 'load-check',
      code: d.code,
      message: describeDiagnostic(d, lowered, doc).message,
    });
  check(plan.moc, () => loadMoc(moc));
  checkTextures(plan.textures, files, problems);
  check(`${stem}.model3.json`, () => parseModelSettings(model3, `${stem}.model3.json`));
  check(plan.displayInfo, () => parseDisplayInfo(files.get(plan.displayInfo)!, plan.displayInfo));
  if (plan.physics)
    check(plan.physics, () => parsePhysics(files.get(plan.physics!)!, plan.physics!));
  if (plan.motionSync)
    check(plan.motionSync, () => {
      // Read back with Mochi2D: no warnings, and every setting by its name.
      const f = parseMotionSync(files.get(plan.motionSync!)!, plan.motionSync!, { lint: true });
      if (f.warnings.length) throw new Error(f.warnings.join('; '));
      const names = doc
        .project()
        .motionSyncOrder.map((u) => doc.getAs(u, 'motionSyncSetting').name);
      if (f.settings.map((s) => s.name).join('\u0000') !== names.join('\u0000'))
        throw new Error('the settings did not read back as written');
      if (f.settings.some((s) => !s.usable))
        throw new Error('a setting names an analysis type Mochi2D does not run');
    });
  // A motion's MotionSync names a setting of the file, as Mochi2D reads both back.
  check(`${stem}.model3.json`, () => {
    const entries = parseModelSettings(model3, `${stem}.model3.json`).motions.flatMap(
      (g) => g.entries,
    );
    const named = entries.filter((e) => e.motionSync !== undefined);
    if (named.length === 0) return;
    if (!plan.motionSync)
      throw new Error('a motion names a motion-sync setting, but there is no file');
    const f = parseMotionSync(files.get(plan.motionSync)!, plan.motionSync);
    const names = new Set(f.settings.map((s) => s.name));
    for (const e of named) {
      if (!names.has(e.motionSync!))
        throw new Error(
          `${e.file} names motion-sync setting "${e.motionSync}", which the file does not have`,
        );
      if (!e.sound) throw new Error(`${e.file} names a motion-sync setting but no sound`);
    }
  });
  if (plan.pose) check(plan.pose, () => parsePose(files.get(plan.pose!)!, plan.pose!));
  if (plan.userData)
    check(plan.userData, () => parseUserData(files.get(plan.userData!)!, plan.userData!));
  for (const e of plan.expressions)
    check(e.file, () => parseExpression(files.get(e.file)!, e.file));
  for (const m of plan.motions) check(m.file, () => parseMotion(files.get(m.file)!, m.file));
  for (const snd of plan.sounds) check(snd.file, () => decodeWav(files.get(snd.file)!));
  const result = scenarioResult(
    { moc, settings: model3 },
    { format: 'mochi2d-scenario/0', id: 'default-pose' },
  ) as {
    error: { kind: string; message: string } | null;
    warnings: string[];
    drawables?: { visible: boolean; vertices: number[] }[];
  };
  if (result.error)
    problems.push({
      severity: 'error',
      source: 'load-check',
      code: result.error.kind,
      message: `Evaluating the default pose failed: ${result.error.message}`,
    });
  const drawables = result.drawables ?? [];
  if (drawables.some((d) => d.vertices.some((x) => !Number.isFinite(x))))
    problems.push({
      severity: 'error',
      source: 'load-check',
      code: 'non-finite',
      message: 'The default pose has vertices that are not finite numbers.',
    });
  for (const w of result.warnings)
    problems.push({
      severity: 'warning',
      source: 'load-check',
      code: 'runtime-warning',
      message: w,
    });
  if (problems.some((p) => p.severity === 'error' && p.source === 'load-check'))
    fail(
      'The exported files do not load cleanly in Mochi2D (a Mochi Maker bug; please report it):',
      problems,
    );

  // 8. Report.
  const sorted = new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const fileList: ExportReport['files'] = [];
  for (const [path, bytes] of sorted)
    fileList.push({ path, bytes: bytes.length, sha256: await sha256Hex(bytes) });
  const idMap = (uids: Uid[]) =>
    Object.fromEntries(uids.map((u) => [u, (doc.get(u) as { exportId: string }).exportId]));
  const report: ExportReport = {
    format: EXPORT_REPORT_FORMAT,
    version: 1,
    producer: `@mochi-maker/export ${VERSION} with mochi2d ${MOCHI2D_VERSION}`,
    mocVersion: version,
    versionReason,
    files: fileList,
    ids: {
      parameters: idMap(lowered.uids.parameters),
      parts: idMap(lowered.uids.parts),
      deformers: idMap(lowered.uids.deformers),
      artMeshes: idMap(lowered.uids.artMeshes),
      glues: idMap(lowered.uids.glues),
    },
    counts: {
      parameters: lowered.uids.parameters.length,
      parts: lowered.uids.parts.length,
      warpDeformers: lowered.data.warpDeformers.band.length,
      rotationDeformers: lowered.data.rotationDeformers.band.length,
      artMeshes: lowered.uids.artMeshes.length,
      glues: lowered.uids.glues.length,
      vertices: lowered.data.uvs.length / 2,
      triangles: lowered.data.triangleIndices.length / 3,
      parameterBindings: lowered.data.parameterBindings.keyCount.length,
      bands: lowered.data.bands.entryCount.length,
      drawOrderGroups: lowered.data.drawOrderGroups.entryCount.length,
      expressions: plan.expressions.length,
      motions: plan.motions.length,
      physicsSettings: doc.project().physicsOrder.length,
      motionSyncSettings: doc.project().motionSyncOrder.length,
      sounds: plan.sounds.length,
    },
    atlas: {
      pages: atlas.pages.map((p, i) => ({
        file: plan.textures[i]!,
        width: p.width,
        height: p.height,
      })),
      regions: atlas.regions.map((r) => ({ ...r, name: doc.getAs(r.layer, 'layer').name })),
    },
    loadCheck: {
      drawables: drawables.length,
      visibleAtDefault: drawables.filter((d) => d.visible).length,
      warnings: result.warnings,
    },
    problems,
  };
  return { files: sorted, report };
}

/**
 * Adds the settings, display-info, physics, pose, user-data, expression, motion and sound files of
 * a file plan to `files` (everything but the .moc3 and the textures).
 */
export async function addRuntimeFiles(
  doc: DocReader,
  plan: ModelFiles,
  assets: AssetStore,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const text = (s: string) => new TextEncoder().encode(s);
  files.set(`${plan.stem}.model3.json`, text(jsonText(modelSettings(doc, plan))));
  files.set(plan.displayInfo, text(jsonText(displayInfo(doc))));
  if (plan.physics) files.set(plan.physics, text(jsonText(physicsFile(doc))));
  if (plan.motionSync) files.set(plan.motionSync, text(motionSyncText(doc)));
  if (plan.pose) files.set(plan.pose, text(jsonText(poseFile(doc))));
  if (plan.userData) files.set(plan.userData, text(jsonText(userDataFile(doc))));
  for (const e of plan.expressions)
    files.set(e.file, text(jsonText(expressionFile(doc, doc.getAs(e.uid, 'expression')))));
  for (const m of plan.motions)
    files.set(m.file, text(jsonText(motionFile(doc, doc.getAs(m.uid, 'motion')))));
  for (const snd of plan.sounds) {
    const sound = doc.getAs(snd.uid, 'sound');
    if (!(await assets.has(sound.asset)))
      throw new MochiError(
        'E_ASSET_MISSING',
        `The WAV file of sound "${sound.name}" is not available, so its motions cannot start it.`,
      );
    files.set(snd.file, await assets.get(sound.asset));
  }
}

/** The report as deterministic JSON text. */
export function reportText(report: ExportReport): string {
  return jsonText(report as never);
}

/** Which feature-flagged parts a document holds: glues; blend shapes or blend-shape parameters. */
export function featuresUsed(doc: DocReader): Features {
  return {
    glue: doc.ofKind('glue').length > 0,
    blendShapes:
      doc.ofKind('parameter').some((p) => p.type === 'blendShape') ||
      doc
        .ofKind(['artMesh', 'warp', 'rotation', 'part', 'glue'])
        .some((o) => o.blendShapes.length > 0),
  };
}

/**
 * The export's textures as Mochi2D reads them: each one's header, against what a model Mochi
 * Maker builds may declare (BUILD_TEXTURES, within Mochi2D's defaults), so an export never holds a
 * texture Mochi2D then refuses. A model past the caps Mochi Maker's own import applies to models
 * from others (LIMITS) is exported with a warning: an app that loads models from others with
 * Mochi2D's suggested caps may refuse it.
 */
export function checkTextures(
  textures: readonly string[],
  files: ReadonlyMap<string, Uint8Array>,
  problems: ExportProblem[],
): void {
  let total = 0;
  let bytes = 0;
  let largest = 0;
  for (const path of textures) {
    const file = files.get(path)!;
    bytes += file.length;
    largest = Math.max(largest, file.length);
    let h;
    try {
      h = readTextureHeader(path, file);
    } catch (e) {
      problems.push({
        severity: 'error',
        source: 'load-check',
        code: 'texture-refused',
        message: `${path}: Mochi2D cannot read it (${(e as Error).message}).`,
      });
      continue;
    }
    total += h.width * h.height;
    if (
      h.width > BUILD_TEXTURES.maxSide ||
      h.height > BUILD_TEXTURES.maxSide ||
      h.width * h.height > BUILD_TEXTURES.maxPixels
    )
      problems.push({
        severity: 'error',
        source: 'load-check',
        code: 'texture-too-large',
        message: `${path} is ${h.width} × ${h.height} pixels, more than a texture Mochi2D loads by default.`,
      });
  }
  const fix = 'Use a smaller atlas size, fewer or smaller layers, or move art out of the model.';
  if (total > BUILD_TEXTURES.maxTotalPixels)
    problems.push({
      severity: 'error',
      source: 'load-check',
      code: 'textures-too-large',
      message: `The textures are too large together: ${total.toLocaleString('en-US')} pixels, more than the ${BUILD_TEXTURES.maxTotalPixels.toLocaleString('en-US')} Mochi2D loads by default. ${fix}`,
      fix,
    });
  else if (
    total > FOREIGN_MODEL.textures.maxTotalPixels ||
    largest > FOREIGN_MODEL.files.maxFileBytes ||
    bytes > FOREIGN_MODEL.files.maxTotalBytes
  )
    problems.push({
      severity: 'warning',
      source: 'load-check',
      code: 'textures-past-caps-for-others',
      message: `The textures are larger than apps that load models from others usually accept (${FOREIGN_MODEL.textures.maxTotalPixels.toLocaleString('en-US')} pixels together, ${FOREIGN_MODEL.files.maxFileBytes / 2 ** 20} MiB a file, ${FOREIGN_MODEL.files.maxTotalBytes / 2 ** 20} MiB in all); Mochi Maker's own model import is one. This model has ${total.toLocaleString('en-US')} pixels in ${textures.length} textures (${Math.round(bytes / 2 ** 20)} MiB).`,
    });
}
