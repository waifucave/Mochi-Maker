/**
 * Preview builds (design 4.4): the runtime files of the current document for the editor's live
 * preview, without the export's lint, validation and load check.
 *
 * A preview build is the export's own lowering and writer, so the preview shows what the export
 * will produce. What it skips are the checks (the editor runs validation separately) and the work
 * that rarely changes: decoded layer images are kept by asset hash, and the atlas pages with their
 * PNG files by the atlas layout's inputs (layers, UV bounds and page size), so an edit that moves
 * vertices or changes keyforms reuses them.
 */
import {
  DocView,
  type AssetStore,
  type Document,
  type DocReader,
  type Uid,
} from '@mochi-maker/core';
import { decodePng, encodePng } from '@mochi-maker/art';
import type { Image } from '@mochi-maker/geometry';
import { writeMoc, type MocVersion } from 'mochi2d/headless';
import { atlasNeeds, buildAtlas, type Atlas } from './atlas.js';
import { addRuntimeFiles, requiredVersion } from './export.js';
import { planFiles } from './files.js';
import { type LowerResult } from './lower.js';
import { LoweringCache, type LowerStats } from './lowercache.js';

/** Milliseconds spent in each step of a preview build. */
export interface PreviewTimings {
  atlas: number;
  lower: number;
  write: number;
  files: number;
  total: number;
}

export interface PreviewBuild {
  /** The runtime files: path → bytes. */
  files: Map<string, Uint8Array>;
  /** The settings file's path. */
  settings: string;
  /** The .moc3 file's path (in `files` unless the build left it out). */
  mocPath: string;
  version: MocVersion;
  lowered: LowerResult;
  /** How the lowering went: from scratch, or the previous one with values rewritten. */
  lowering: LowerStats;
  /** True when the atlas pages (and their PNG files) came from the cache. */
  atlasReused: boolean;
  timings: PreviewTimings;
}

/** The file version a preview uses: the export's choice, raised to what the document needs. */
export function previewVersion(doc: DocReader): MocVersion {
  const settings = doc.project().exportSettings;
  const need = requiredVersion(doc).version;
  const set = settings.mocVersion === 'auto' ? settings.minimumVersion : settings.mocVersion;
  return Math.max(set, need) as MocVersion;
}

/** Builds preview files, caching decoded images and atlas pages between builds. */
export class PreviewBuilder {
  private readonly images = new Map<string, Image>();
  private atlas: { key: string; atlas: Atlas; pngs: Uint8Array[] } | undefined;
  /** Reuses the previous lowering when only values changed. */
  private readonly lowering = new LoweringCache();

  constructor(private readonly assets: AssetStore) {}

  private async image(hash: string, name: string): Promise<Image> {
    let img = this.images.get(hash);
    if (!img) {
      img = decodePng(await this.assets.get(hash), `layer "${name}"`);
      this.images.set(hash, img);
    }
    return img;
  }

  /**
   * `writeMoc: false` leaves the .moc3 out of `files` (its path is `mocPath`): an editor that
   * patches or replaces the shown model from the model data does not need the bytes.
   */
  async build(document: Document, options: { writeMoc?: boolean } = {}): Promise<PreviewBuild> {
    const now = () => globalThis.performance.now();
    const t0 = now();
    const doc = new DocView(document);
    const settings = doc.project().exportSettings;
    const pageSize = settings.atlasSize;
    const version = previewVersion(doc);

    // Atlas, from the cache when its inputs are unchanged.
    const needs = atlasNeeds(doc);
    const assetOf = (layer: Uid) => doc.getAs(layer, 'layer').asset;
    const key = JSON.stringify([pageSize, needs.map((n) => [n, assetOf(n.layer)])]);
    let atlasReused = true;
    if (this.atlas?.key !== key) {
      atlasReused = false;
      const images = new Map<Uid, Image>();
      for (const n of needs) {
        const layer = doc.getAs(n.layer, 'layer');
        images.set(layer.uid, await this.image(layer.asset, layer.name));
      }
      const atlas = buildAtlas(doc, images, pageSize);
      this.atlas = { key, atlas, pngs: atlas.pages.map((p) => encodePng(p)) };
    }
    const { atlas, pngs } = this.atlas!;
    const t1 = now();

    const lowered = this.lowering.lower(document, { version, placement: atlas.placement });
    const t2 = now();
    const moc = options.writeMoc === false ? null : writeMoc(lowered.data, { version });
    const t3 = now();

    const plan = planFiles(doc, settings.fileStem, atlas.pages.length, pageSize);
    const files = new Map<string, Uint8Array>();
    if (moc) files.set(plan.moc, moc);
    pngs.forEach((png, i) => files.set(plan.textures[i]!, png));
    await addRuntimeFiles(doc, plan, this.assets, files);
    const t4 = now();
    return {
      files,
      settings: `${plan.stem}.model3.json`,
      mocPath: plan.moc,
      version,
      lowered,
      lowering: { ...this.lowering.stats },
      atlasReused,
      timings: { atlas: t1 - t0, lower: t2 - t1, write: t3 - t2, files: t4 - t3, total: t4 - t0 },
    };
  }
}
