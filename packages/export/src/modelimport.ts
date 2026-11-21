/**
 * Model import (roadmap M16): a `.moc3` model folder opened as an editable project.
 *
 * The inverse of the lowering (`lower.ts`) and of the runtime files (`files.ts`). Mochi2D's
 * `readMoc` gives the model data; each group becomes the document's objects:
 *
 * - **Parts** keep their file order, parents and keyforms. A part's children (parts and meshes)
 *   are ordered so that walking the tree gives the file's part order and mesh order back: a child
 *   part goes before the first mesh of its subtree. Parts that are objects of a nested draw-order
 *   group get their own sorting scope.
 * - **Deformers, meshes, glues and parameters** keep their file order, bindings, keyforms and
 *   blend shapes. Bindings and keys come from the bands and parameter bindings; a parameter's key
 *   list (version 4 and later) from its own keys, or else the union of its bindings' keys.
 * - **Spaces.** The file stores top-level objects in model units; the document stores them in
 *   canvas pixels. Each value is turned back into the float32 pixel value that the exporter turns
 *   into exactly the stored one (`invertF32`), so a re-export gives the same numbers. Where no such
 *   value exists (a file not written by Mochi Maker), the nearest one is used and the import
 *   report counts it.
 * - **Textures.** Each texture page becomes one layer the size of the page, marked as a texture
 *   page: the export writes it back as its own page, unpacked, with its PNG bytes unchanged. Mesh
 *   UVs are the page's pixels. Painting new art onto such a model works as usual: other layers are
 *   packed onto pages after the kept ones.
 * - **Names.** A `.moc3` holds IDs, not editor names. The display-info file names parameters,
 *   parameter groups and parts; everything else is named by its ID.
 *
 * The runtime files (settings, display info, expressions, motions, sounds, physics, pose, user data
 * and motion sync) are read with Mochi2D's parsers, which check them, and their values are taken
 * from the JSON as written. The project notes where it came from (`importedFrom`). Glue and blend
 * shapes are imported as they are; the feature flags only decide whether the project exports.
 *
 * Accepted: a folder's files and the path of its `.model3.json`. `.moc3` versions 3 to 5; version 6
 * is refused, as are versions 1 and 2.
 */
import {
  DocView,
  Draft,
  MochiError,
  checkInvariants,
  emptyDocument,
  f32,
  type AssetStore,
  type BlendShape,
  type Document,
  type DocObject,
  type Features,
  type ImportKeep,
  type Uid,
  scopeOf,
  stackMembers,
  ALPHA_BLENDS,
  COLOR_BLENDS,
  blendCode,
  isCompatibleBlend,
  type BlendMode,
  type PartDelta,
} from '@mochi-maker/core';
import { decodePng, readWavInfo } from '@mochi-maker/art';
import {
  parseDisplayInfo,
  parseExpression,
  parseModelSettings,
  parseMotion,
  parseMotionSync,
  parsePhysics,
  parsePose,
  parseUserData,
  readMoc,
  validateMoc,
  type MocData,
  type MocVersion,
} from 'mochi2d/headless';
import { expectedGroupRanges } from './rules.js';

/** The notice shown once in the editor, printed by the CLI and returned by the API and MCP. */
export const MODEL_IMPORT_NOTICE =
  "You are opening a finished model for editing. Do this only with models you made or have permission to edit. The model's terms of use still apply.";

export const IMPORT_REPORT_FORMAT = 'mochi-maker-import';

export interface ImportModelOptions {
  /** When it was imported (ISO 8601), recorded in the project; the caller's clock. */
  date: string;
  /** Glue and blend shapes: only used for the report's line about exporting. */
  features?: Features;
  /**
   * Model data to import instead of the `.moc3` file's contents, as `readMoc` gives it: for data
   * read or made elsewhere (version 6 data, which Mochi2D cannot write yet, for example). The
   * settings' `.moc3` is still read for nothing else and need not be in `files`.
   */
  mocData?: { data: MocData; version: number };
}

export interface ImportReport {
  format: typeof IMPORT_REPORT_FORMAT;
  version: 1;
  source: { settings: string; moc: string; mocVersion: number; files: string[] };
  /** What became part of the project, by kind. */
  reconstructed: Record<string, number>;
  /** What a model folder does not hold, so the project does not either. */
  notInFile: string[];
  /** What was left out, and why. */
  skipped: { what: string; why: string }[];
  /** Values with no exact float32 inverse (only in files not written by Mochi Maker). */
  inexact: number;
  /** Which of glue and blend shapes the model uses, and what that means for export. */
  features: { glue: boolean; blendShapes: boolean; lines: string[] };
  /** Mochi2D's reader's remarks on the `.moc3`. */
  readerDiagnostics: string[];
}

export interface ImportedModel {
  document: Document;
  report: ImportReport;
  notices: string[];
}

// ---------------------------------------------------------------- float32 inverses

const F = new Float32Array(1);
const I = new Int32Array(F.buffer);
/** float32 values as ordered integers: consecutive values differ by one. */
const ordered = (x: number): number => {
  F[0] = x;
  const b = I[0]!;
  return b >= 0 ? b : -(b & 0x7fffffff);
};
const fromOrdered = (o: number): number => {
  I[0] = o >= 0 ? o : -o | 0x80000000;
  return F[0]!;
};

/**
 * The float32 x for which `forward(x)` (monotone non-decreasing) is exactly `target`, searched
 * around `guess`; `exact` false when there is none (the nearest is returned).
 */
export function invertF32(
  target: number,
  guess: number,
  forward: (x: number) => number,
): { value: number; exact: boolean } {
  const g = f32(guess);
  if (!Number.isFinite(target) || !Number.isFinite(g)) return { value: g, exact: false };
  if (forward(g) === target) return { value: g, exact: true };
  // Binary search for the first x with forward(x) ≥ target, within 2^22 steps of the guess.
  let lo = ordered(g) - (1 << 22);
  let hi = ordered(g) + (1 << 22);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (forward(fromOrdered(mid)) >= target) hi = mid;
    else lo = mid + 1;
  }
  const x = fromOrdered(lo);
  if (forward(x) === target) return { value: x, exact: true };
  return { value: g, exact: false };
}

// ---------------------------------------------------------------- paths

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
function joinPath(dir: string, rel: string): string {
  const parts = (dir ? `${dir}/${rel}` : rel).split('/');
  const out: string[] = [];
  for (const s of parts) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (out.length === 0)
        throw new MochiError('E_MODEL_IMPORT', `${rel} points outside the model folder.`);
      out.pop();
    } else out.push(s);
  }
  return out.join('/');
}
const stemOf = (file: string, ext: string) => {
  const b = baseOf(file);
  return b.toLowerCase().endsWith(ext) ? b.slice(0, b.length - ext.length) : b;
};

type Json = Record<string, unknown>;
const decoder = new TextDecoder();
const jsonOf = (bytes: Uint8Array): Json => JSON.parse(decoder.decode(bytes).replace(/^﻿/, ''));
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * A curve's segments in the file's encoding (the document's): the first point, then per segment
 * its kind and the points after its first (three for a Bézier, one otherwise).
 */
type MotionCurve = ReturnType<typeof parseMotion>['curves'][number];
/** Mochi2D's segment kind of a Bézier (its `BEZIER`). */
const BEZIER = 1;

function segmentsOf(c: MotionCurve): number[] {
  const P = c.points;
  const out = [P[0]!, P[1]!];
  c.kinds.forEach((kind, s) => {
    out.push(kind);
    const n = kind === BEZIER ? 3 : 1;
    for (let k = 1; k <= n; k++)
      out.push(P[2 * (c.starts[s]! + k)]!, P[2 * (c.starts[s]! + k) + 1]!);
  });
  return out;
}

// ---------------------------------------------------------------- the import

export async function importModel(
  files: ReadonlyMap<string, Uint8Array>,
  settingsPath: string,
  assets: AssetStore,
  options: ImportModelOptions,
): Promise<ImportedModel> {
  const skipped: ImportReport['skipped'] = [];
  const read: string[] = [];
  const dir = dirOf(settingsPath);
  const file = (rel: string, what: string): Uint8Array => {
    const path = joinPath(dir, rel);
    const bytes = files.get(path);
    if (!bytes)
      throw new MochiError('E_MODEL_IMPORT', `The ${what} ${rel} is not in the model folder.`);
    if (!read.includes(path)) read.push(path);
    return bytes;
  };
  const optional = (rel: string | undefined, what: string): Uint8Array | null => {
    if (!rel) return null;
    try {
      return file(rel, what);
    } catch (e) {
      skipped.push({ what: `${what} ${rel}`, why: (e as Error).message });
      return null;
    }
  };
  const parse = <T>(what: string, fn: () => T): T | null => {
    try {
      return fn();
    } catch (e) {
      skipped.push({ what, why: `Mochi2D could not read it: ${(e as Error).message}` });
      return null;
    }
  };

  // ---------------------------------------------------------------- settings and .moc3
  const settingsBytes = files.get(settingsPath);
  if (!settingsBytes)
    throw new MochiError('E_MODEL_IMPORT', `${settingsPath} is not in the model folder.`);
  read.push(settingsPath);
  let settings;
  try {
    settings = parseModelSettings(settingsBytes, settingsPath);
  } catch (e) {
    throw new MochiError('E_MODEL_IMPORT', `${settingsPath}: ${(e as Error).message}`);
  }
  const raw = settings.raw as Json;
  let moc: { data: MocData; version: number; diagnostics?: { code: string; message: string }[] };
  if (options.mocData) moc = options.mocData;
  else {
    const mocBytes = file(settings.moc, '.moc3 file');
    try {
      moc = readMoc(mocBytes);
    } catch (e) {
      throw new MochiError('E_MODEL_IMPORT', `${settings.moc}: ${(e as Error).message}`);
    }
  }
  const version = moc.version;
  if (version < 3 || version > 6)
    throw new MochiError(
      'E_MODEL_IMPORT',
      `${settings.moc} is a version ${version} .moc3; versions 3 to 6 can be imported.`,
    );
  // readMoc reads what it can; the file must also be one that loads (Mochi2D's strict check).
  const check = validateMoc(moc.data, { version: version as MocVersion, level: 'strict' });
  const errors = check.diagnostics.filter((x) => x.severity === 'error');
  if (errors.length > 0)
    throw new MochiError(
      'E_MODEL_IMPORT',
      `${settings.moc} does not load: ${errors
        .slice(0, 3)
        .map((x) => x.message)
        .join('; ')}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ''}`,
    );
  if (!options.mocData) {
    const bytesCheck = validateMoc(file(settings.moc, '.moc3 file'), { level: 'strict' });
    const bad = bytesCheck.diagnostics.find((x) => x.severity === 'error');
    if (bad)
      throw new MochiError('E_MODEL_IMPORT', `${settings.moc} does not load: ${bad.message}`);
  }
  const data: MocData = moc.data;
  const stem = stemOf(settingsPath, '.model3.json');

  const display = parse('the display-info file', () => {
    const bytes = optional(settings.displayInfo, 'display-info file');
    return bytes ? parseDisplayInfo(bytes, settings.displayInfo) : null;
  });

  // ---------------------------------------------------------------- the document
  const base = emptyDocument({
    width: data.canvas.width,
    height: data.canvas.height,
    pixelsPerUnit: data.canvas.pixelsPerUnit,
    originX: data.canvas.originX,
    originY: data.canvas.originY,
  });
  const d = new Draft(base);
  const canvas = d.project().canvas;
  const ppu = canvas.pixelsPerUnit;
  const ox = canvas.originX;
  const oy = canvas.originY;
  // What the file has that the document otherwise derives: kept, so that an unedited export
  // writes it again (lower.ts reads it).
  const keep: ImportKeep = {
    parts: [],
    artMeshes: [],
    deformers: [],
    groups: [],
    values: [],
    decimals: [],
    hidden: [],
    meshFlags: [],
    canvasFlags: data.canvas.flags,
    blendCodes: [],
    offscreenFlags: [],
    offscreens: [],
    blendFlags: [],
    ranges: [],
  };
  let inexact = 0;
  /**
   * The document value for a file value: the float32 that exports to it exactly. Where there is
   * none, the nearest, and the file's value is kept under `path` (lower.ts's names).
   */
  const inv = (path: string, target: number, guess: number, forward: (x: number) => number) => {
    const r = invertF32(target, guess, forward);
    if (!r.exact) {
      inexact++;
      keep.values.push([path, r.value, target]);
    }
    return r.value;
  };
  /** Model units → canvas pixels, for top-level positions (x and y alternate). */
  const toPixels = (src: ArrayLike<number>, start: number, count: number, path: string) => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const t = src[start + i]!;
      const o = i % 2 === 0 ? ox : oy;
      out[i] = inv(`${path}/${i}`, t, t * ppu + o, (px) => f32((px - o) / ppu));
    }
    return out;
  };
  /** Model units → pixels for offsets (blend-shape deltas): the scale only. */
  const toPixelOffsets = (src: ArrayLike<number>, start: number, count: number, path: string) => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const t = src[start + i]!;
      out[i] = inv(`${path}/${i}`, t, t * ppu, (px) => f32(px / ppu));
    }
    return out;
  };
  const slice = (src: ArrayLike<number>, start: number, count: number) =>
    Float32Array.from({ length: count }, (_, i) => src[start + i]!);

  // ---------------------------------------------------------------- parameters
  const P = data.parameters;
  const paramCount = P.ids.length;
  const paramUid: Uid[] = [];
  // Groups first, from the display info.
  const groupUid = new Map<string, Uid>();
  const groups = display?.parameterGroups ?? [];
  for (const g of groups) {
    if (groupUid.has(g.id) || !/^[A-Za-z0-9_]{1,63}$/.test(g.id)) {
      skipped.push({ what: `parameter group ${g.id}`, why: 'a duplicate or invalid ID' });
      continue;
    }
    groupUid.set(g.id, d.allocate('parameterGroup'));
  }
  for (const g of groups) {
    const uid = groupUid.get(g.id);
    if (!uid || d.get(uid)) continue;
    d.put({
      kind: 'parameterGroup',
      uid,
      exportId: g.id,
      name: g.name || g.id,
      parent: (g.groupId && groupUid.get(g.groupId)) || null,
    });
  }
  const paramInfo = new Map((display?.parameters ?? []).map((p) => [p.id, p]));
  // Each parameter's normal bindings: [keys], and its blend-shape bindings: [keys, base].
  const bindingParam: number[] = []; // parameter binding index → parameter index
  const blendBindingParam: number[] = [];
  for (let p = 0; p < paramCount; p++) {
    for (let b = 0; b < P.bindingCount[p]!; b++) bindingParam[P.firstBinding[p]! + b] = p;
    if (P.firstBlendShapeBinding && P.blendShapeBindingCount)
      for (let b = 0; b < P.blendShapeBindingCount[p]!; b++)
        blendBindingParam[P.firstBlendShapeBinding[p]! + b] = p;
  }
  const bindingKeys = (b: number) =>
    Array.from(
      { length: data.parameterBindings.keyCount[b]! },
      (_, i) => data.keys[data.parameterBindings.firstKey[b]! + i]!,
    );
  const BPB = data.blendShapeParameterBindings;
  const blendKeys = (b: number) =>
    Array.from({ length: BPB!.keyCount[b]! }, (_, i) => data.keys[BPB!.firstKey[b]! + i]!);
  for (let p = 0; p < paramCount; p++) {
    const id = P.ids[p]!;
    const uid = d.allocate('parameter');
    paramUid.push(uid);
    let keys: number[];
    if (P.firstKey && P.keyCount)
      keys = Array.from({ length: P.keyCount[p]! }, (_, i) => data.keys[P.firstKey![p]! + i]!);
    else {
      const set = new Set<number>();
      for (let b = 0; b < P.bindingCount[p]!; b++)
        for (const k of bindingKeys(P.firstBinding[p]! + b)) set.add(k);
      keys = [...set].sort((a, b) => a - b);
    }
    const info = paramInfo.get(id);
    const decimals = P.decimals[p]!;
    if (decimals !== 3) keep.decimals.push([uid, decimals]);
    d.put({
      kind: 'parameter',
      uid,
      exportId: id,
      name: info?.name || id,
      group: (info?.groupId && groupUid.get(info.groupId)) || null,
      min: P.min[p]!,
      max: P.max[p]!,
      default: P.defaultValue[p]!,
      repeat: P.repeat[p]! !== 0,
      decimals: Math.max(0, Math.min(9, decimals)),
      type: P.type?.[p] === 1 ? 'blendShape' : 'normal',
      keys,
    });
  }

  // ---------------------------------------------------------------- bands → bindings
  const bandBindings = (band: number) => {
    const out: { parameter: Uid; keys: number[] }[] = [];
    const first = data.bands.firstEntry[band]!;
    for (let i = 0; i < data.bands.entryCount[band]!; i++) {
      const b = data.bindingIndices[first + i]!;
      out.push({ parameter: paramUid[bindingParam[b]!]!, keys: bindingKeys(b) });
    }
    return out;
  };

  // ---------------------------------------------------------------- colors
  const C4 = version >= 4 && data.multiplyColors && data.screenColors;
  type Rgb3 = [number, number, number];
  const color = (mi: number, si: number): { multiply: Rgb3; screen: Rgb3 } =>
    C4
      ? {
          multiply: [
            data.multiplyColors!.r[mi]!,
            data.multiplyColors!.g[mi]!,
            data.multiplyColors!.b[mi]!,
          ],
          screen: [data.screenColors!.r[si]!, data.screenColors!.g[si]!, data.screenColors!.b[si]!],
        }
      : { multiply: [1, 1, 1], screen: [0, 0, 0] };
  /**
   * The color entry of each normal keyform, by keyform index: object by object, keyform k of an
   * object uses firstColor + k (Mochi2D's moc-data.md, C5; a version 5 keyform's own color indices
   * count only for blend-shape keyforms). Where objects share keyforms, the later object's entry
   * is the one the runtime uses, as Mochi2D's loader fills the same table.
   */
  const colorTable = (
    first: Int32Array,
    count: Int32Array,
    firstColor: Int32Array | undefined,
    keyforms: number,
  ) => {
    const t = new Int32Array(keyforms);
    if (firstColor)
      for (let o = 0; o < first.length; o++)
        for (let k = 0; k < count[o]!; k++)
          if (first[o]! + k < keyforms) t[first[o]! + k] = firstColor[o]! + k;
    return t;
  };
  /** A version 6 blend code as a blend mode, or null for a code the document has no name for. */
  const decodeBlend = (code: number): BlendMode | null => {
    const c = COLOR_BLENDS[code & 255];
    const a = ALPHA_BLENDS[(code >> 8) & 255];
    return c && a && code >>> 16 === 0 ? { color: c, alpha: a } : null;
  };
  /** An offscreen's blend mode; a code the document gives otherwise is kept (keep.blendCodes). */
  const blendOf = (uid: Uid, code: number): BlendMode => {
    const b = decodeBlend(code) ?? { color: 'normal', alpha: 'over' };
    if (blendCode(b) !== code) keep.blendCodes.push([uid, blendCode(b), code]);
    return b;
  };
  /**
   * An art mesh's version 6 blend mode: null where its legacy flags say it (the blends every
   * version has). A code the document gives otherwise is kept, as for offscreens.
   */
  const meshBlend = (i: number, uid: Uid, legacyCode: number): BlendMode | null => {
    const codes = data.artMeshes.blendMode;
    if (version < 6 || !codes) return null;
    const code = codes[i]!;
    const b = decodeBlend(code);
    const blend = b && !isCompatibleBlend(b) ? b : null;
    const doc = blend ? blendCode(blend) : legacyCode;
    if (doc !== code) keep.blendCodes.push([uid, doc, code]);
    return blend;
  };
  const keyformColor = (table: Int32Array, kf: number) =>
    C4 ? color(table[kf]!, table[kf]!) : color(0, 0);

  // ---------------------------------------------------------------- textures
  const textures: { uid: Uid; width: number; height: number }[] = [];
  for (const [i, rel] of settings.textures.entries()) {
    const bytes = file(rel, 'texture');
    let img;
    try {
      img = decodePng(bytes, rel);
    } catch (e) {
      throw new MochiError('E_MODEL_IMPORT', `${rel}: ${(e as Error).message}`);
    }
    const uid = d.allocate('layer');
    d.put({
      kind: 'layer',
      uid,
      name: stemOf(rel, '.png') || `texture_${String(i).padStart(2, '0')}`,
      asset: await assets.put(bytes),
      x: 0,
      y: 0,
      width: img.width,
      height: img.height,
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      clipped: false,
      notes: ['a texture page of the imported model, kept as it is'],
      source: joinPath(dir, rel),
      texturePage: true,
    });
    d.updateProject((p) => ({ ...p, layerOrder: [...p.layerOrder, uid] }));
    textures.push({ uid, width: img.width, height: img.height });
  }

  // ---------------------------------------------------------------- parts
  const PA = data.parts;
  const partCount = PA.ids.length;
  // Allocate in display-info order where it lists the parts, so lists by kind keep that order.
  const partOrder = [...Array(partCount).keys()];
  const listed = new Map((display?.parts ?? []).map((p, i) => [p.id, i]));
  const allocOrder = [...partOrder].sort(
    (a, b) => (listed.get(PA.ids[a]!) ?? Infinity) - (listed.get(PA.ids[b]!) ?? Infinity) || a - b,
  );
  const partUid: Uid[] = [];
  for (const i of allocOrder) partUid[i] = d.allocate('part');
  const partNames = new Map((display?.parts ?? []).map((p) => [p.id, p.name]));

  // Nested draw-order groups: their parts sort among their own children.
  const ownScope = new Set<number>();
  const DG = data.drawOrderGroupObjects;
  for (let i = 0; i < DG.kind.length; i++) if (DG.kind[i] === 1) ownScope.add(DG.index[i]!);

  // ---------------------------------------------------------------- deformers
  const DE = data.deformers;
  const defCount = DE.ids.length;
  const defUid: Uid[] = [];
  for (let i = 0; i < defCount; i++)
    defUid.push(d.allocate(DE.kind[i] === 0 ? 'warp' : 'rotation'));
  const hasRotationAbove = (i: number) => {
    let p = DE.parent[i]!;
    while (p >= 0) {
      if (DE.kind[p] === 1) return true;
      p = DE.parent[p]!;
    }
    return false;
  };

  // ---------------------------------------------------------------- meshes
  const AM = data.artMeshes;
  const meshCount = AM.ids.length;
  const meshUid: Uid[] = [];
  for (let i = 0; i < meshCount; i++) meshUid.push(d.allocate('artMesh'));
  const GLU = data.glues;
  const glueUid: Uid[] = [];
  for (let i = 0; i < GLU.ids.length; i++) glueUid.push(d.allocate('glue'));

  // ---------------------------------------------------------------- blend shapes
  const KB = data.blendShapeKeyformBindings;
  /** The blend shapes of object `obj` in a target table; `delta(k)` reads keyform k's delta. */
  const shapesOf = <T>(
    targets: { object: Int32Array; firstBinding: Int32Array; bindingCount: Int32Array } | undefined,
    obj: number,
    uid: Uid,
    delta: (keyform: number, path: string) => T,
  ): BlendShape<never>[] => {
    if (!targets || !KB || !BPB) return [];
    const out: BlendShape<never>[] = [];
    for (let t = 0; t < targets.object.length; t++) {
      if (targets.object[t] !== obj) continue;
      for (let j = 0; j < targets.bindingCount[t]!; j++) {
        const kb = targets.firstBinding[t]! + j;
        const pb = KB.parameterBinding[kb]!;
        const keys = blendKeys(pb);
        const constraints = [];
        for (let c = 0; c < KB.constraintEntryCount[kb]!; c++) {
          const cs = data.blendShapeConstraintEntries![KB.firstConstraintEntry[kb]! + c]!;
          const CS = data.blendShapeConstraints!;
          const CV = data.blendShapeConstraintValues!;
          constraints.push({
            parameter: paramUid[CS.parameter[cs]!]!,
            points: Array.from({ length: CS.valueCount[cs]! }, (_, i): [number, number] => [
              CV.key[CS.firstValue[cs]! + i]!,
              CV.weight[CS.firstValue[cs]! + i]!,
            ]),
          });
        }
        out.push({
          parameter: paramUid[blendBindingParam[pb]!]!,
          keys,
          base: keys[BPB.baseKey[pb]!]!,
          deltas: Array.from({ length: KB.keyformCount[kb]! }, (_, k) =>
            delta(KB.firstKeyform[kb]! + k, `${uid}/bs${out.length}/${k}`),
          ) as never[],
          constraints,
        });
      }
    }
    return out;
  };
  // Version 4 ignores blend-shape values other than positions and grid points (§1c.4); the
  // document keeps them at zero, so the project still exports at version 4.
  const v4Zero = <X extends { opacity?: number; drawOrder?: number }>(x: X, nonzero: boolean) => {
    if (nonzero) ignoredV4++;
    return x;
  };
  let ignoredV4 = 0;
  const deltaColor = (kf: { multiplyColor?: Int32Array; screenColor?: Int32Array }, k: number) =>
    version >= 5 && kf.multiplyColor && kf.screenColor
      ? color(kf.multiplyColor[k]!, kf.screenColor[k]!)
      : { multiply: [0, 0, 0] as Rgb3, screen: [0, 0, 0] as Rgb3 };

  // ---------------------------------------------------------------- write the objects
  const WD = data.warpDeformers;
  const RD = data.rotationDeformers;
  const WK = data.warpKeyforms;
  const RK = data.rotationKeyforms;
  const MK = data.artMeshKeyforms;
  const warpColors = colorTable(WD.firstKeyform, WD.keyformCount, WD.firstColor, WK.opacity.length);
  const rotationColors = colorTable(
    RD.firstKeyform,
    RD.keyformCount,
    RD.firstColor,
    RK.opacity.length,
  );
  const meshColors = colorTable(AM.firstKeyform, AM.keyformCount, AM.firstColor, MK.opacity.length);
  const pos = data.keyformPositions;
  for (let i = 0; i < defCount; i++) {
    const top = DE.parent[i]! < 0;
    const common = {
      uid: defUid[i]!,
      exportId: DE.ids[i]!,
      name: DE.ids[i]!,
      part: DE.part[i]! >= 0 ? partUid[DE.part[i]!]! : null,
      parent: DE.parent[i]! >= 0 ? defUid[DE.parent[i]!]! : null,
      enabled: DE.enabled[i]! !== 0,
    };
    if (DE.visible[i] === 0) keep.hidden.push(defUid[i]!);
    const duid = defUid[i]!;
    const ki = DE.kindIndex[i]!;
    // The warp or rotation record's band is the one evaluated (Mochi2D: band-mismatch).
    const bindings = bandBindings((DE.kind[i] === 0 ? WD.band : RD.band)[ki]!);
    if (DE.kind[i] === 0) {
      const n = WD.pointCount[ki]! * 2;
      const keyforms = Array.from({ length: WD.keyformCount[ki]! }, (_, k) => {
        const kf = WD.firstKeyform[ki]! + k;
        const fp = WK.firstPosition[kf]!;
        return {
          authored: true,
          grid: top ? toPixels(pos, fp, n, `${duid}/kf${k}`) : slice(pos, fp, n),
          opacity: WK.opacity[kf]!,
          ...keyformColor(warpColors, kf),
        };
      });
      d.put({
        kind: 'warp',
        ...common,
        rows: WD.rows[ki]!,
        cols: WD.columns[ki]!,
        cellMode: (WD.bilinear?.[ki] ?? 0) !== 0 ? 'bilinear' : 'triangles',
        rig: { bindings, keyforms },
        blendShapes: shapesOf(data.warpBlendShapeTargets, ki, duid, (kf, path) => {
          const fp = WK.firstPosition[kf]!;
          const op = WK.opacity[kf]!;
          const c = deltaColor(WK, kf);
          return v4Zero(
            {
              grid: top ? toPixelOffsets(pos, fp, n, path) : slice(pos, fp, n),
              opacity: version >= 5 ? op : 0,
              ...c,
            },
            version < 5 && op !== 0,
          );
        }),
      } as unknown as DocObject);
    } else {
      const factor = hasRotationAbove(i) ? 1 : 1 / ppu;
      const keyforms = Array.from({ length: RD.keyformCount[ki]! }, (_, k) => {
        const kf = RD.firstKeyform[ki]! + k;
        const [px, py] = top
          ? [
              inv(`${duid}/kf${k}/ox`, RK.originX[kf]!, RK.originX[kf]! * ppu + ox, (x) =>
                f32((x - ox) / ppu),
              ),
              inv(`${duid}/kf${k}/oy`, RK.originY[kf]!, RK.originY[kf]! * ppu + oy, (x) =>
                f32((x - oy) / ppu),
              ),
            ]
          : [RK.originX[kf]!, RK.originY[kf]!];
        const s = RK.scale[kf]!;
        return {
          authored: true,
          angle: RK.angle[kf]!,
          originX: px!,
          originY: py!,
          scale: factor === 1 ? s : inv(`${duid}/kf${k}/s`, s, s / factor, (x) => f32(x * factor)),
          mirrorX: RK.mirrorX[kf]! !== 0,
          mirrorY: RK.mirrorY[kf]! !== 0,
          opacity: RK.opacity[kf]!,
          ...keyformColor(rotationColors, kf),
        };
      });
      d.put({
        kind: 'rotation',
        ...common,
        baseAngle: RD.baseAngle[ki]!,
        rig: { bindings, keyforms },
        blendShapes: shapesOf(data.rotationBlendShapeTargets, ki, duid, (kf, path) => {
          const off = (t: number, at: string) =>
            top ? inv(`${path}/${at}`, t, t * ppu, (x) => f32(x / ppu)) : t;
          const s = RK.scale[kf]!;
          // The document's deltas have no mirror flags; a file's are kept (lower.ts writes them).
          if (RK.mirrorX[kf]) keep.values.push([`${path}/mx`, 0, RK.mirrorX[kf]!]);
          if (RK.mirrorY[kf]) keep.values.push([`${path}/my`, 0, RK.mirrorY[kf]!]);
          return {
            angle: RK.angle[kf]!,
            originX: off(RK.originX[kf]!, 'ox'),
            originY: off(RK.originY[kf]!, 'oy'),
            scale: factor === 1 ? s : inv(`${path}/s`, s, s / factor, (x) => f32(x * factor)),
            opacity: RK.opacity[kf]!,
            ...deltaColor(RK, kf),
          };
        }),
      } as unknown as DocObject);
    }
  }

  const meshName = (id: string) => id;
  for (let i = 0; i < meshCount; i++) {
    const top = AM.deformer[i]! < 0;
    const n = AM.vertexCount[i]! * 2;
    const flags = AM.flags[i]!;
    const muid = meshUid[i]!;
    if (flags & ~15) keep.meshFlags.push([muid, flags & ~15]);
    // The blending every version has: from flag bits 0–1, or from version 6 on from the blend
    // code when it is a compatible one (the file's bits are then kept as they are).
    const code = version >= 6 ? AM.blendMode?.[i] : undefined;
    const legacyCode =
      code !== undefined && (code === 0 || (code & 255) === 1 || (code & 255) === 2)
        ? code & 255
        : flags & 1
          ? 1
          : flags & 2
            ? 2
            : 0;
    const legacyBlend = (['normal', 'additive', 'multiplicative'] as const)[legacyCode]!;
    if ((flags & 3) !== legacyCode) keep.blendFlags.push([muid, legacyCode, flags & 3]);
    if (AM.visible[i] === 0) keep.hidden.push(muid);
    const page = textures[AM.texture[i]!];
    if (!page)
      throw new MochiError(
        'E_MODEL_IMPORT',
        `Art mesh ${AM.ids[i]} uses texture ${AM.texture[i]}, which the model settings do not list.`,
      );
    const uv = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const t = data.uvs[AM.firstUv[i]! + j]!;
      const w = j % 2 === 0 ? page.width : page.height;
      uv[j] = inv(`${muid}/uv/${j}`, t, t * w, (x) => f32(x / w));
    }
    const keyforms = Array.from({ length: AM.keyformCount[i]! }, (_, k) => {
      const kf = AM.firstKeyform[i]! + k;
      const fp = MK.firstPosition[kf]!;
      return {
        authored: true,
        positions: top ? toPixels(pos, fp, n, `${muid}/kf${k}`) : slice(pos, fp, n),
        opacity: MK.opacity[kf]!,
        drawOrder: MK.drawOrder[kf]!,
        ...keyformColor(meshColors, kf),
      };
    });
    const masks = Array.from(
      { length: AM.maskCount[i]! },
      (_, k) => meshUid[data.maskEntries[AM.firstMask[i]! + k]!]!,
    );
    d.put({
      kind: 'artMesh',
      uid: meshUid[i]!,
      exportId: AM.ids[i]!,
      name: meshName(AM.ids[i]!),
      part: AM.part[i]! >= 0 ? partUid[AM.part[i]!]! : null,
      deformer: AM.deformer[i]! >= 0 ? defUid[AM.deformer[i]!]! : null,
      layer: page.uid,
      uv,
      triangles: Uint16Array.from(
        { length: AM.triangleIndexCount[i]! },
        (_, k) => data.triangleIndices[AM.firstTriangleIndex[i]! + k]!,
      ),
      doubleSided: (flags & 4) !== 0,
      enabled: AM.enabled[i]! !== 0,
      legacyBlend,
      blend: meshBlend(i, muid, legacyCode),
      clip: masks.length > 0 || flags & 8 ? { masks, invert: (flags & 8) !== 0 } : null,
      rig: { bindings: bandBindings(AM.band[i]!), keyforms },
      blendShapes: shapesOf(data.artMeshBlendShapeTargets, i, muid, (kf, path) => {
        const fp = MK.firstPosition[kf]!;
        const op = MK.opacity[kf]!;
        const dr = MK.drawOrder[kf]!;
        return v4Zero(
          {
            positions: top ? toPixelOffsets(pos, fp, n, path) : slice(pos, fp, n),
            opacity: version >= 5 ? op : 0,
            drawOrder: version >= 5 ? dr : 0,
            ...deltaColor(MK, kf),
          },
          version < 5 && (op !== 0 || dr !== 0),
        );
      }),
    } as unknown as DocObject);
  }

  // Parts, with their children, in stacking order: each child where its first entry in the
  // draw-order group stands (a mesh's own entry; a part with its own scope, its entry; any other
  // part, the first of its members). Where the tree cannot give a group's order, the project keeps
  // the file's (project.stacks, below).
  const childParts: number[][] = Array.from({ length: partCount + 1 }, () => []);
  const childMeshes: number[][] = Array.from({ length: partCount + 1 }, () => []);
  const slot = (p: number) => (p < 0 ? partCount : p);
  for (let i = 0; i < partCount; i++) childParts[slot(PA.parent[i]!)]!.push(i);
  for (let i = 0; i < meshCount; i++) childMeshes[slot(AM.part[i]!)]!.push(i);
  const DGG = data.drawOrderGroups;
  const meshEntry = new Map<number, number>();
  const partEntry = new Map<number, number>();
  const groupScope = new Map<number, number>(); // group → its own-scope part
  for (let g = 0; g < DGG.firstObject.length; g++)
    for (let j = 0; j < DGG.objectCount[g]!; j++) {
      const o = DGG.firstObject[g]! + j;
      if (DG.kind[o] === 0) meshEntry.set(DG.index[o]!, j);
      else {
        partEntry.set(DG.index[o]!, j);
        if (DG.nestedGroup[o]! >= 0) groupScope.set(DG.nestedGroup[o]!, DG.index[o]!);
      }
    }
  const firstEntry: number[] = [];
  const entryOf = (c: number): number => {
    if (ownScope.has(c)) return partEntry.get(c) ?? Infinity;
    if (firstEntry[c] !== undefined) return firstEntry[c]!;
    let m = Infinity;
    for (const x of childMeshes[c]!) m = Math.min(m, meshEntry.get(x) ?? Infinity);
    for (const x of childParts[c]!) m = Math.min(m, entryOf(x));
    return (firstEntry[c] = m);
  };
  const childrenOf = (p: number): Uid[] => {
    const parts = childParts[slot(p)]!;
    // A part with no entries sorts with the next sibling part that has some.
    const key: number[] = [];
    let next = Infinity;
    for (let j = parts.length - 1; j >= 0; j--) {
      const m = entryOf(parts[j]!);
      if (Number.isFinite(m)) next = m;
      key[j] = Number.isFinite(m) ? m : next;
    }
    const items = [
      ...parts.map((c, j) => ({ key: key[j]!, part: true, order: c, uid: partUid[c]! })),
      ...childMeshes[slot(p)]!.map((m) => ({
        key: meshEntry.get(m) ?? Infinity,
        part: false,
        order: m,
        uid: meshUid[m]!,
      })),
    ];
    items.sort((a, b) => a.key - b.key || Number(b.part) - Number(a.part) || a.order - b.order);
    return items.map((x) => x.uid);
  };
  // Version 6: offscreens. An offscreen's normal keyforms are its part's (part keyforms name them);
  // their colors come from consecutive entries after the first one's, as Mochi2D's loader reads
  // them, and an entry of -1 gives opacity 0 and colors 0.
  const OFD = data.offscreens;
  const OKD = data.offscreenKeyforms;
  const pok = data.partKeyforms.offscreenKeyform;
  const offscreenOfPart = new Map<number, number>();
  const offMul = OKD ? Int32Array.from(OKD.multiplyColor) : new Int32Array(0);
  const offScr = OKD ? Int32Array.from(OKD.screenColor) : new Int32Array(0);
  if (version >= 6 && OFD && OKD && pok) {
    OFD.part.forEach((p, o) => {
      offscreenOfPart.set(p, o);
      keep.offscreens.push(partUid[p]!);
      const firstOk = pok[PA.firstKeyform[p]!]!;
      if (firstOk < 0) return;
      for (let j = 0; j < PA.keyformCount[p]!; j++) {
        const ok = pok[PA.firstKeyform[p]! + j]!;
        if (ok < 0) continue;
        offMul[ok] = OKD.multiplyColor[firstOk]! + j;
        offScr[ok] = OKD.multiplyColor[firstOk]! + j;
      }
    });
  }
  const offscreenKeyform = (part: number, kf: number) => {
    if (!offscreenOfPart.has(part)) return { opacity: 1, multiply: [1, 1, 1], screen: [0, 0, 0] };
    const ok = pok![kf]!;
    if (ok < 0) return { opacity: 0, multiply: [0, 0, 0], screen: [0, 0, 0] };
    return { opacity: OKD!.opacity[ok]!, ...color(offMul[ok]!, offScr[ok]!) };
  };
  const offscreenOf = (part: number) => {
    const o = offscreenOfPart.get(part);
    if (o === undefined) return null;
    if (!ownScope.has(part))
      throw new MochiError(
        'E_MODEL_IMPORT',
        `Part ${PA.ids[part]} draws offscreen but is not drawn as an entry of a draw-order group of its own.`,
      );
    const flags = OFD!.flags[o]!;
    // Bit 2 is what files usually set (it is not read for offscreens); other bits are kept.
    if ((flags & ~8) !== 4) keep.offscreenFlags.push([partUid[part]!, flags & ~8]);
    const masks = Array.from(
      { length: OFD!.maskCount[o]! },
      (_, k) => meshUid[data.maskEntries[OFD!.firstMask[o]! + k]!]!,
    );
    return {
      blend: blendOf(partUid[part]!, OFD!.blendMode[o]!),
      clip: masks.length > 0 || flags & 8 ? { masks, invert: (flags & 8) !== 0 } : null,
    };
  };
  /**
   * A part's blend shapes: its part targets change its draw order, its offscreen's targets its
   * offscreen's opacity and colors. One blend shape per parameter holds both.
   */
  const partShapes = (part: number) => {
    const uid = partUid[part]!;
    const own = shapesOf(data.partBlendShapeTargets, part, uid, (kf) => ({
      drawOrder: data.partKeyforms.drawOrder[kf]!,
      opacity: 0,
      multiply: [0, 0, 0],
      screen: [0, 0, 0],
    })) as unknown as BlendShape<PartDelta>[];
    const o = offscreenOfPart.get(part);
    if (o === undefined) return own;
    const off = shapesOf(data.offscreenBlendShapeTargets, o, uid, (kf) => ({
      drawOrder: 0,
      opacity: OKD!.opacity[kf]!,
      ...color(offMul[kf]!, offScr[kf]!),
    })) as unknown as BlendShape<PartDelta>[];
    const out = [...own];
    for (const b of off) {
      const zero = b.deltas.every(
        (x) =>
          x.opacity === 0 && x.multiply.every((c) => c === 0) && x.screen.every((c) => c === 0),
      );
      if (zero)
        skipped.push({
          what: `an offscreen blend shape of ${PA.ids[part]} that changes nothing`,
          why: 'the project keeps offscreen blend shapes that change opacity or colors only, so the export leaves it out (it can still clamp the opacity and colors to 0…1)',
        });
      const same = out.findIndex((x) => x.parameter === b.parameter);
      if (same < 0) {
        if (!zero) out.push(b);
        continue;
      }
      const a = out[same]!;
      if (
        a.keys.join() !== b.keys.join() ||
        a.base !== b.base ||
        JSON.stringify(a.constraints) !== JSON.stringify(b.constraints)
      )
        throw new MochiError(
          'E_MODEL_IMPORT',
          `Part ${PA.ids[part]} has a blend shape and an offscreen blend shape on the same parameter with other keys or constraints; the project holds one blend shape per parameter.`,
        );
      out[same] = {
        ...a,
        deltas: a.deltas.map((x, k) => ({ ...b.deltas[k]!, drawOrder: x.drawOrder })),
      };
    }
    return out;
  };

  for (let i = 0; i < partCount; i++) {
    const id = PA.ids[i]!;
    d.put({
      kind: 'part',
      uid: partUid[i]!,
      exportId: id,
      name: partNames.get(id) || id,
      parent: PA.parent[i]! >= 0 ? partUid[PA.parent[i]!]! : null,
      children: childrenOf(i),
      visibleAtStart: PA.initiallyVisible[i]! !== 0,
      enabled: PA.enabled[i]! !== 0,
      sortingScope: ownScope.has(i) ? 'own' : 'inherit',
      guide: false,
      rig: {
        bindings: bandBindings(PA.band[i]!),
        keyforms: Array.from({ length: PA.keyformCount[i]! }, (_, k) => ({
          authored: true,
          drawOrder: data.partKeyforms.drawOrder[PA.firstKeyform[i]! + k]!,
          ...offscreenKeyform(i, PA.firstKeyform[i]! + k),
        })),
      },
      offscreen: offscreenOf(i),
      blendShapes: partShapes(i),
    } as unknown as DocObject);
  }

  // Glues: (vertex, weight) of A, then of B, for each pair.
  const GI = data.glueInfo;
  for (let g = 0; g < GLU.ids.length; g++) {
    const pairs: [number, number, number, number][] = [];
    const first = GLU.firstInfo[g]!;
    for (let k = 0; k + 1 < GLU.infoCount[g]!; k += 2)
      pairs.push([
        GI.vertex[first + k]!,
        GI.weight[first + k]!,
        GI.vertex[first + k + 1]!,
        GI.weight[first + k + 1]!,
      ]);
    d.put({
      kind: 'glue',
      uid: glueUid[g]!,
      exportId: GLU.ids[g]!,
      name: GLU.ids[g]!,
      meshA: meshUid[GLU.artMeshA[g]!]!,
      meshB: meshUid[GLU.artMeshB[g]!]!,
      pairs,
      rig: {
        bindings: bandBindings(GLU.band[g]!),
        keyforms: Array.from({ length: GLU.keyformCount[g]! }, (_, k) => ({
          authored: true,
          intensity: data.glueKeyforms.intensity[GLU.firstKeyform[g]! + k]!,
        })),
      },
      blendShapes: shapesOf(data.glueBlendShapeTargets, g, glueUid[g]!, (kf) => ({
        intensity: data.glueKeyforms.intensity[kf]!,
      })),
    } as unknown as DocObject);
  }
  if (ignoredV4 > 0)
    skipped.push({
      what: `${ignoredV4} blend-shape value(s) other than positions and grid points`,
      why: 'version 4 ignores them (§1c.4), so the project keeps them at zero',
    });

  const byId = (list: Uid[], ids: readonly string[]) => new Map(ids.map((id, i) => [id, list[i]!]));
  const paramById = byId(paramUid, P.ids);
  const partById = byId(partUid, PA.ids);
  const meshById = byId(meshUid, AM.ids);
  const roots = childrenOf(-1);
  // The document lists deformers parents first; the file's own order is kept for the export.
  const deformerOrder: Uid[] = [];
  const placedDef = new Set<number>();
  const placeDef = (i: number) => {
    if (placedDef.has(i)) return;
    placedDef.add(i);
    if (DE.parent[i]! >= 0) placeDef(DE.parent[i]!);
    deformerOrder.push(defUid[i]!);
  };
  for (let i = 0; i < defCount; i++) placeDef(i);
  d.updateProject((p) => ({
    ...p,
    parameterOrder: paramUid,
    parameterGroupOrder: [...groupUid.values()].filter((u) => d.get(u)),
    root: roots,
    deformerOrder,
    glueOrder: glueUid,
  }));
  keep.parts = [...partUid];
  keep.artMeshes = [...meshUid];
  keep.deformers = [...defUid];
  // Each draw-order group: its scope, in the file's group order, and its entries; where the tree's
  // order is not the file's, the project keeps the file's as the group's explicit stack.
  const stacks: { scope: Uid | null; entries: Uid[] }[] = [];
  for (let g = 0; g < DGG.firstObject.length; g++) {
    const scopePart = groupScope.get(g);
    const scope = scopePart === undefined ? null : partUid[scopePart]!;
    keep.groups.push(scope);
    const entries = Array.from({ length: DGG.objectCount[g]! }, (_, j) => {
      const o = DGG.firstObject[g]! + j;
      return DG.kind[o] === 0 ? meshUid[DG.index[o]!]! : partUid[DG.index[o]!]!;
    });
    if (stackMembers(d, scope).join() !== entries.join()) stacks.push({ scope, entries });
    // The document stacks an object in its part's group; a file may list it in another.
    for (const u of entries)
      if (scopeOf(d, u) !== scope)
        skipped.push({
          what: `the draw-order group entry of ${(d.get(u) as { exportId: string }).exportId}`,
          why: 'the file stacks it in another group than its part’s; the project stacks it with its part, so the order it is drawn in can differ',
        });
  }
  // Group ranges other than the reachable one: evaluation reads them, so they are kept too.
  expectedGroupRanges(data, version).forEach((r, g) => {
    const min = DGG.minDrawOrder[g]!;
    const max = DGG.maxDrawOrder[g]!;
    if (min !== r.min || max !== r.max) keep.ranges.push([g, min, max, r.min, r.max]);
  });
  d.updateProject((p) => ({ ...p, stacks }));

  // ---------------------------------------------------------------- the runtime files
  const lookup = (what: string, map: Map<string, Uid>, id: string): Uid | null => {
    const u = map.get(id);
    if (!u) skipped.push({ what: `${what} ${id}`, why: 'the model has no object with this ID' });
    return u ?? null;
  };
  const idsOf = (map: Map<string, Uid>, what: string, ids: string[]) =>
    ids.map((id) => lookup(what, map, id)).filter((u): u is Uid => u !== null);

  // Groups, hit areas, display info.
  const group = (name: string) =>
    settings.groups.find((g) => g.name === name && g.target === 'Parameter')?.ids ?? [];
  const hitAreas = settings.hitAreas
    .map((h) => ({ mesh: lookup('hit area', meshById, h.id), name: h.name }))
    .filter((h): h is { mesh: Uid; name: string } => h.mesh !== null);
  const combined = (display?.combinedParameters ?? [])
    .map(([a, b]) => [
      lookup('combined parameter', paramById, a),
      lookup('combined parameter', paramById, b),
    ])
    .filter((x): x is [Uid, Uid] => x[0] !== null && x[1] !== null);
  d.updateProject((p) => ({
    ...p,
    standardGroups: {
      eyeBlink: idsOf(paramById, 'EyeBlink parameter', group('EyeBlink')),
      lipSync: idsOf(paramById, 'LipSync parameter', group('LipSync')),
    },
    hitAreas,
    combinedParameters: combined,
  }));

  // User data.
  const userBytes = optional(settings.userData, 'user-data file');
  if (userBytes && parse('the user-data file', () => parseUserData(userBytes, settings.userData))) {
    const entries = (jsonOf(userBytes).UserData as Json[] | undefined) ?? [];
    const userData: { target: Uid; value: string }[] = [];
    for (const e of entries) {
      const map =
        e.Target === 'ArtMesh'
          ? meshById
          : e.Target === 'Part'
            ? partById
            : e.Target === 'Parameter'
              ? paramById
              : null;
      if (!map) {
        skipped.push({
          what: `user data for ${String(e.Target)} ${String(e.Id)}`,
          why: 'only art meshes, parts and parameters carry user data',
        });
        continue;
      }
      const u = lookup('user data for', map, String(e.Id));
      if (u) userData.push({ target: u, value: String(e.Value ?? '') });
    }
    d.updateProject((p) => ({ ...p, userData }));
  }

  // Pose.
  const poseBytes = optional(settings.pose, 'pose file');
  if (poseBytes && parse('the pose file', () => parsePose(poseBytes, settings.pose))) {
    const j = jsonOf(poseBytes);
    const groupsJ = (j.Groups as { Id: string; Link?: string[] }[][] | undefined) ?? [];
    d.updateProject((p) => ({
      ...p,
      pose: {
        fadeIn: num(j.FadeInTime),
        groups: groupsJ
          .map((g) =>
            g
              .map((e) => ({
                part: lookup('pose part', partById, e.Id),
                links: idsOf(partById, 'pose link', e.Link ?? []),
              }))
              .filter((e): e is { part: Uid; links: Uid[] } => e.part !== null),
          )
          .filter((g) => g.length > 0),
      },
    }));
  }

  // Physics.
  const physBytes = optional(settings.physics, 'physics file');
  if (physBytes && parse('the physics file', () => parsePhysics(physBytes, settings.physics))) {
    const j = jsonOf(physBytes);
    const meta = (j.Meta as Json | undefined) ?? {};
    const names = new Map(
      ((meta.PhysicsDictionary as { Id: string; Name: string }[] | undefined) ?? []).map((x) => [
        x.Id,
        x.Name,
      ]),
    );
    const order: Uid[] = [];
    for (const s of (j.PhysicsSettings as Json[] | undefined) ?? []) {
      const io = (x: Json, key: 'Source' | 'Destination') => {
        const ref = x[key] as { Id: string } | undefined;
        return ref ? lookup('physics parameter', paramById, ref.Id) : null;
      };
      const kind = (t: unknown): 'X' | 'Y' | 'Angle' =>
        t === 'X' || t === 'Y' || t === 'Angle' ? t : 'X';
      const inputs = ((s.Input as Json[] | undefined) ?? []).flatMap((x) => {
        const u = io(x, 'Source');
        return u
          ? [
              {
                parameter: u,
                weight: Number(x.Weight),
                type: kind(x.Type),
                reflect: x.Reflect === true,
              },
            ]
          : [];
      });
      const outputs = ((s.Output as Json[] | undefined) ?? []).flatMap((x) => {
        const u = io(x, 'Destination');
        return u
          ? [
              {
                parameter: u,
                weight: Number(x.Weight),
                type: kind(x.Type),
                reflect: x.Reflect === true,
                particle: Number(x.VertexIndex),
                scale: Number(x.Scale),
              },
            ]
          : [];
      });
      const v = (s.Vertices as Json[] | undefined) ?? [];
      const norm = (s.Normalization as Json | undefined) ?? {};
      const range = (r: unknown) => {
        const x = (r as Json | undefined) ?? {};
        return { min: Number(x.Minimum), default: Number(x.Default), max: Number(x.Maximum) };
      };
      const uid = d.allocate('physicsSetting');
      d.put({
        kind: 'physicsSetting',
        uid,
        name: names.get(String(s.Id)) ?? String(s.Id),
        inputs,
        outputs,
        particles: v.map((x) => {
          const p = (x.Position as Json | undefined) ?? {};
          return {
            x: Number(p.X),
            y: Number(p.Y),
            mobility: Number(x.Mobility),
            delay: Number(x.Delay),
            acceleration: Number(x.Acceleration),
            radius: Number(x.Radius),
          };
        }),
        normalization: { position: range(norm.Position), angle: range(norm.Angle) },
      });
      order.push(uid);
    }
    d.updateProject((p) => ({ ...p, physicsOrder: order, physicsFps: num(meta.Fps) ?? 0 }));
  }

  // Motion sync.
  const syncUid = new Map<string, Uid>();
  const syncBytes = optional(settings.motionSync, 'motion-sync file');
  const sync = syncBytes
    ? parse('the motion-sync file', () => parseMotionSync(syncBytes, settings.motionSync))
    : null;
  if (sync) {
    const order: Uid[] = [];
    for (const s of sync.settings) {
      const parameters = s.parameters.flatMap((x) => {
        const u = lookup('motion-sync parameter', paramById, x.id);
        return u ? [{ parameter: u, damper: x.damper, smooth: x.smooth }] : [];
      });
      if (parameters.length !== s.parameters.length) {
        skipped.push({
          what: `motion-sync setting ${s.name}`,
          why: 'it drives parameters the model does not have',
        });
        continue;
      }
      const uid = d.allocate('motionSyncSetting');
      d.put({
        kind: 'motionSyncSetting',
        uid,
        name: s.name,
        useCase: s.useCase,
        analysisType: s.analysisType,
        sampleRate: s.sampleRate,
        smoothing: s.smoothing,
        blendRatio: s.blendRatio,
        parameters,
        elements: s.elements.map((e) => ({
          id: e.id,
          name: e.name,
          enabled: e.enabled,
          scale: e.scale,
        })),
        shapes: s.shapes.map((r) => [...r]),
      });
      order.push(uid);
      syncUid.set(s.name, uid);
      syncUid.set(s.id, syncUid.get(s.id) ?? uid);
    }
    d.updateProject((p) => ({ ...p, motionSyncOrder: order }));
  }

  // Expressions.
  const exprOrder: Uid[] = [];
  for (const e of settings.expressions) {
    const bytes = optional(e.file, 'expression file');
    if (!bytes || !parse(`expression ${e.name}`, () => parseExpression(bytes, e.file))) continue;
    const j = jsonOf(bytes);
    const uid = d.allocate('expression');
    d.put({
      kind: 'expression',
      uid,
      name: e.name,
      fadeIn: num(j.FadeInTime),
      fadeOut: num(j.FadeOutTime),
      entries: ((j.Parameters as Json[] | undefined) ?? []).flatMap((x) => {
        const u = lookup(`expression ${e.name} parameter`, paramById, String(x.Id));
        const blend = x.Blend === 'Multiply' || x.Blend === 'Overwrite' ? x.Blend : 'Add';
        return u ? [{ parameter: u, value: Number(x.Value), blend }] : [];
      }),
    } as unknown as DocObject);
    exprOrder.push(uid);
  }

  // Motions and their sounds.
  const motionOrder: Uid[] = [];
  const soundOrder: Uid[] = [];
  const soundByPath = new Map<string, Uid>();
  for (const g of settings.motions)
    for (const entry of g.entries) {
      const bytes = optional(entry.file, 'motion file');
      const m = bytes && parse(`motion ${entry.file}`, () => parseMotion(bytes, entry.file));
      if (!m) continue;
      // Mochi2D's motion as written: Meta as the file has it, and each curve's own fades.
      const meta = m.written.meta;
      if (m.ignoredCurves > 0)
        skipped.push({
          what: `${m.ignoredCurves} curve(s) at the end of motion ${entry.file}`,
          why: 'they come after a curve of a later kind (model, parameter, part opacity), so they take no effect',
        });
      if (entry.fadeInTime !== undefined || entry.fadeOutTime !== undefined)
        skipped.push({
          what: `the fade times of motion ${entry.file}'s entry in the model settings`,
          why: 'the document keeps a motion’s fade times in its file only',
        });
      let sound: Uid | null = null;
      if (entry.sound) {
        const path = joinPath(dir, entry.sound);
        sound = soundByPath.get(path) ?? null;
        const wav = sound ? null : optional(entry.sound, 'sound');
        if (wav) {
          try {
            const info = readWavInfo(wav, entry.sound);
            sound = d.allocate('sound');
            d.put({
              kind: 'sound',
              uid: sound,
              name: stemOf(entry.sound, '.wav'),
              asset: await assets.put(wav),
              sampleRate: info.sampleRate,
              channels: info.channels,
              frames: info.frames,
            });
            soundByPath.set(path, sound);
            soundOrder.push(sound);
          } catch (e) {
            skipped.push({ what: `sound ${entry.sound}`, why: (e as Error).message });
          }
        }
      }
      const curves = m.curves.flatMap((c, ci) => {
        const target =
          c.target === 'Model'
            ? 'model'
            : c.target === 'Parameter'
              ? 'parameter'
              : c.target === 'PartOpacity'
                ? 'partOpacity'
                : null;
        if (!target) return [];
        const id = c.id;
        let object: Uid | null = null;
        let model: 'EyeBlink' | 'LipSync' | 'Opacity' | null = null;
        if (target === 'model') {
          if (id !== 'EyeBlink' && id !== 'LipSync' && id !== 'Opacity') {
            skipped.push({
              what: `motion ${entry.file}'s model curve ${id}`,
              why: 'not a model curve the document knows',
            });
            return [];
          }
          model = id;
        } else {
          object = lookup(
            `motion ${entry.file} curve for`,
            target === 'parameter' ? paramById : partById,
            id,
          );
          if (!object) return [];
        }
        return [
          {
            target,
            model,
            object,
            fadeIn: num(m.written.curves[ci]?.fadeIn),
            fadeOut: num(m.written.curves[ci]?.fadeOut),
            segments: segmentsOf(c),
            auto: [],
          },
        ];
      });
      const uid = d.allocate('motion');
      d.put({
        kind: 'motion',
        uid,
        name: stemOf(entry.file, '.motion3.json'),
        group: g.group,
        duration: m.duration,
        fps: m.fps,
        loop: m.loop,
        restrictedBeziers: m.restricted,
        fadeIn: num(meta.FadeInTime),
        fadeOut: num(meta.FadeOutTime),
        curves,
        events: m.events.map((u) => ({ time: u.time, value: u.value })),
        sound,
        motionSync: sound && entry.motionSync ? (syncUid.get(entry.motionSync) ?? null) : null,
        workArea: null,
        markers: [],
      } as unknown as DocObject);
      motionOrder.push(uid);
    }

  // ---------------------------------------------------------------- settings and origin
  const label = settings.textures[0]?.match(/\.(1024|2048|4096|8192)\//)?.[1];
  const biggest = Math.max(1024, ...textures.map((t) => Math.max(t.width, t.height)));
  const atlasSize = (label ? Number(label) : Math.min(8192, 2 ** Math.ceil(Math.log2(biggest)))) as
    1024 | 2048 | 4096 | 8192;
  const files0 = [...read].sort();
  d.updateProject((p) => ({
    ...p,
    expressionOrder: exprOrder,
    motionOrder,
    soundOrder,
    exportSettings: {
      ...p.exportSettings,
      mocVersion: version as 3 | 4 | 5 | 6,
      minimumVersion: Math.min(version, 5) as 3 | 4 | 5,
      atlasSize,
      fileStem: stem,
    },
    importedFrom: { format: 'moc3', date: options.date, mocVersion: version, files: files0, keep },
  }));
  for (const f of files.keys())
    if (!read.includes(f) && !/(^|\/)\./.test(f))
      skipped.push({ what: f, why: 'the model settings do not refer to it' });

  const { doc } = d.finish();
  const violations = checkInvariants(new DocView(doc));
  if (violations.length > 0)
    throw new MochiError(
      'E_MODEL_IMPORT',
      `The model's data does not fit the document: ${violations
        .slice(0, 5)
        .map((v) => `${v.uid} ${v.path}: ${v.message}`)
        .join('; ')}`,
      { details: { violations: violations.slice(0, 50) } },
    );

  // ---------------------------------------------------------------- the report
  const count = (k: string) => Object.values(doc.objects).filter((o) => o.kind === k).length;
  const shapes = Object.values(doc.objects).reduce(
    (s, o) => s + ('blendShapes' in o ? o.blendShapes.length : 0),
    0,
  );
  const uses = {
    glue: count('glue') > 0,
    blendShapes: shapes > 0 || P.type?.some((t) => t === 1) === true,
  };
  const lines: string[] = [];
  if (uses.glue)
    lines.push(
      `This model uses glue. The project keeps it, and it does not export while the glue feature is ${options.features?.glue ? 'off (it is on here)' : 'off'}.`,
    );
  if (uses.blendShapes)
    lines.push(
      `This model uses blend shapes. The project keeps them, and it does not export while the blendShapes feature is ${options.features?.blendShapes ? 'off (it is on here)' : 'off'}.`,
    );
  if (lines.length === 0) lines.push('This model uses neither glue nor blend shapes.');
  const report: ImportReport = {
    format: IMPORT_REPORT_FORMAT,
    version: 1,
    source: {
      settings: settingsPath,
      moc: joinPath(dir, settings.moc),
      mocVersion: version,
      files: files0,
    },
    reconstructed: {
      parameters: count('parameter'),
      parameterGroups: count('parameterGroup'),
      parts: count('part'),
      artMeshes: count('artMesh'),
      warps: count('warp'),
      rotations: count('rotation'),
      glues: count('glue'),
      blendShapes: shapes,
      texturePages: count('layer'),
      expressions: count('expression'),
      motions: count('motion'),
      sounds: count('sound'),
      physicsSettings: count('physicsSetting'),
      motionSyncSettings: count('motionSyncSetting'),
      hitAreas: hitAreas.length,
    },
    notInFile: [
      'source artwork and its layers: the texture pages are the art, one layer per page',
      'names of art meshes, deformers and glues: their IDs are used',
      display
        ? 'names of parameters, groups and parts beyond the display-info file'
        : 'names of parameters, groups and parts (no display-info file): their IDs are used',
      'editor data: guides, deform paths, timeline work areas and markers, Auto smooth handles (they are ordinary Bézier handles in the file), animation templates',
    ],
    skipped,
    inexact,
    features: { ...uses, lines },
    readerDiagnostics: (moc.diagnostics ?? []).map((x) => `${x.code}: ${x.message}`),
  };
  return { document: doc, report, notices: [MODEL_IMPORT_NOTICE] };
}

/** The import report as lines of text, for the command line. */
export function importReportText(r: ImportReport): string {
  const words: Record<string, [string, string]> = {
    parameters: ['parameter', 'parameters'],
    parameterGroups: ['parameter group', 'parameter groups'],
    parts: ['part', 'parts'],
    artMeshes: ['art mesh', 'art meshes'],
    warps: ['warp deformer', 'warp deformers'],
    rotations: ['rotation deformer', 'rotation deformers'],
    glues: ['glue', 'glues'],
    blendShapes: ['blend shape', 'blend shapes'],
    texturePages: ['texture page', 'texture pages'],
    expressions: ['expression', 'expressions'],
    motions: ['motion', 'motions'],
    sounds: ['sound', 'sounds'],
    physicsSettings: ['physics setting', 'physics settings'],
    motionSyncSettings: ['motion-sync setting', 'motion-sync settings'],
    hitAreas: ['hit area', 'hit areas'],
  };
  const counts = Object.entries(r.reconstructed)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${(words[k] ?? [k, k])[n === 1 ? 0 : 1]}`)
    .join(', ');
  const lines = [
    `Imported ${r.source.settings} (.moc3 version ${r.source.mocVersion}): ${counts}.`,
    ...r.features.lines,
    'Not in a model folder, so not in the project:',
    ...r.notInFile.map((x) => `  - ${x}`),
  ];
  if (r.inexact > 0)
    lines.push(
      `${r.inexact} value(s) had no exact float32 inverse: the project holds the nearest, and an unedited export writes the file's value.`,
    );
  for (const s of r.skipped) lines.push(`Skipped ${s.what}: ${s.why}`);
  return lines.join('\n');
}
