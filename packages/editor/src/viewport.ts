/**
 * The viewport (design 4.4): Mochi2D's view draws the model, and Mochi Maker draws its overlays
 * (meshes, vertices, selection) on a canvas above it through the view's documented transform.
 *
 * The preview is the export: after each change the document is lowered and written by the
 * exporter's own code (`PreviewBuilder`) and loaded into the view from memory. Mochi2D 0.4.0's view
 * loads models from files only, so the preview goes through the .moc3 bytes; the timings of every
 * step are kept for the round report and `window.mochi.stats()`.
 */
import {
  MochiView,
  writeMoc,
  type MochiModel,
  type MocData,
  type MocVersion,
  type ValuePatch,
} from 'mochi2d';
import { makeView } from './noview.js';
import {
  bindPoints,
  nearestPathPoint,
  skin,
  type Binding,
  type DeformPath,
  type Pt,
} from './deformpath.js';
import {
  anchorHandles,
  controlRole,
  defaultDivisions,
  fitNet,
  netWeights,
  type NetShape,
} from './bezier.js';
import {
  DocView,
  Draft,
  Tx,
  fieldAt,
  solveField,
  type ArtMesh,
  type Document,
  type Rotation,
  type Uid,
  type Warp,
} from '@mochi-maker/core';
import {
  DeformerMapper,
  PreviewBuilder,
  applyDataPatches,
  dataPatches,
  invertMap,
  type ForwardMap,
  type PreviewBuild,
  type PreviewTimings,
} from '@mochi-maker/export';
import { brushWeight } from '@mochi-maker/core';
import type { Editor } from './editor.js';
import type { Keymap } from './keymap.js';
import { SettingsStore } from './settings.js';

export interface BuildStats {
  revision: number;
  provisional: boolean;
  timings: PreviewTimings;
  /**
   * How the shown model was updated: value patches in place, other data keeping the textures
   * (`replace`), or a full load (new textures or settings).
   */
  mode: 'patch' | 'replace' | 'load';
  /** Value patches written (patch mode). */
  patches: number;
  /** Showing it: the patch, the replace, or view.load (parsing, decoding textures, uploading). */
  load: number;
  /** From the request to the model shown. */
  total: number;
  atlasReused: boolean;
  /** The lowering: from scratch, or the previous one with values rewritten. */
  lowering: 'full' | 'values';
  drawables: number;
}

/**
 * Canvas tools: the arrow (select and transform, A), lasso selection (L), adding vertices (mesh
 * editing) and the drag-to-create rotation deformer.
 */
export type Tool =
  'arrow' | 'lasso' | 'add' | 'rotation' | 'path' | 'brush' | 'deform' | 'addBrush' | 'stroke';

/** The tools that use the brush: B, C and V + drag set its size, angle and hardness. */
export const BRUSH_TOOLS: readonly Tool[] = ['brush', 'deform', 'addBrush', 'stroke'];

const EFFECTS = [
  'physics',
  'eyeBlink',
  'breath',
  'look',
  'idle',
  'lipSync',
  'pose',
  'expressions',
] as const;
const VERTEX_HIT = 7; // CSS pixels

interface Drag {
  kind:
    | 'points'
    | 'pan'
    | 'marquee'
    | 'click'
    | 'lasso'
    | 'rotateView'
    | 'zoomView'
    | 'createRotation'
    | 'path'
    | 'brushSet'
    | 'brushSelect'
    | 'addPaint'
    | 'stroke';
  /** B, C or V + drag: which brush setting, and its value at the start. */
  brushSet?: { which: 'size' | 'angle' | 'hardness'; v0: number };
  /** Brush selection with Alt: removes. */
  remove?: boolean;
  /** The add-points brush's points (viewport CSS pixels); a stroke's points (canvas pixels). */
  paint?: [number, number][];
  /** A deform-path drag. */
  pathEdit?: PathEdit;
  x0: number;
  y0: number;
  x: number;
  y: number;
  additive?: boolean;
  /** Lasso: the pointer's path (viewport CSS pixels). */
  path?: [number, number][];
  /** Pan: the axis it locked to (Space+Shift+drag). */
  axis?: 'x' | 'y' | null;
  /** Rotate or zoom the view: the transform at the start. */
  view0?: { rotation: number; zoom: number };
  points?: PointsEdit;
}

/**
 * An edit of points on the canvas: mesh vertices, warp grid points or a rotation's origin, angle
 * or scale. Each frame computes the points' canvas targets from the pointer; their local values
 * come from the inverse of the parent's forward map at the pose.
 */
interface PointsEdit {
  target: Uid;
  /** What the drag changes. */
  mode: 'move' | 'box' | 'angle' | 'scale' | 'base';
  cell: Record<Uid, number>;
  cellIndex: number;
  points: number[];
  space: {
    parent: Uid | null;
    all: Float64Array;
    canvas0: Float64Array;
    now: Float64Array;
  };
  /** Screen positions of the points at the start, and now. */
  screen0: [number, number][];
  screenNow: [number, number][];
  /** The transform box at the start: its corners in screen pixels, and what the press grabbed. */
  box?: { x0: number; y0: number; x1: number; y1: number; grab: BoxGrab };
  /** A rotation's angle and scale at the start (angle and scale drags). */
  rot?: { angle: number; scale: number; origin: [number, number]; a0: number; r0: number };
  /** Ctrl: the deformer changes, and its contents stay where they are. */
  contentsStay: boolean;
  /** The values written now (angle and scale drags). */
  values?: Record<string, number>;
  /** Ctrl: the contents, where they were at the start. */
  keep?: Keep[];
  /**
   * A Bézier control point drag (level 2 on a warp): how far each grid point follows the pointer,
   * and which control point is dragged.
   */
  weights?: Float64Array;
  control?: number;
  /** Mirrored editing: per point, 1, or −1 for a mirror partner (its x moves the other way). */
  mirror?: Int8Array;
}

/** A deform path's point dragged: the path before, and each target's points tied to it. */
interface PathEdit {
  path: DeformPath;
  index: number;
  before: Pt[];
  targets: { edit: PointsEdit; binds: Binding[] }[];
  /** In the animation view at levels 2 and 3: the drag poses parameters and keys them. */
  recording: boolean;
}

/** A child of a deformer kept in place: its cell at the pose, local values and canvas position. */
interface Keep {
  c: ArtMesh | Warp | Rotation;
  cell: Record<Uid, number>;
  local: Float64Array;
  canvas: Float64Array;
}

type BoxGrab =
  | { kind: 'move' }
  | { kind: 'scale'; corner: 0 | 1 | 2 | 3 }
  | { kind: 'rotate'; corner: 0 | 1 | 2 | 3 };

type Editable = ArtMesh | Warp | Rotation;

export class Viewport {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly view: MochiView;
  /** Why the view draws nothing (no WebGL2), or null when it draws. */
  readonly unavailable: string | null;
  tool: Tool = 'arrow';
  showAllMeshes = false;
  /** The canvas is shown mirrored left to right (R); a view setting, not the model. */
  flipped = false;
  /** Shows the texture atlas instead of the model (T). */
  atlasView = false;
  /** Hides the transform box (it can cover a warp's center point). */
  hideBox = false;
  /** Highlighted objects (Ctrl+Shift+D: a deformer's children). */
  highlight: Uid[] = [];
  /** Screen length of rotation deformers' handles (Alt+drag changes it). */
  handleLength = 60;
  keymap: Keymap | null = null;
  settings = new SettingsStore();
  /** Opens the canvas's context menu (main.ts). */
  onContextMenu: (e: MouseEvent, uid: Uid | null, ctrl: boolean) => void = () => {};
  /** A deformer moved with its contents (no Ctrl): the first time, a tip says how to avoid it. */
  onContentsMoved: (deformer: Uid) => void = () => {};
  /** A deformer was changed: children that stick out of a parent warp are reported. */
  onDeformerEdited: (deformer: Uid) => void = () => {};
  /** The last builds, newest last. */
  readonly builds: BuildStats[] = [];
  /** Drag frames: pointer event to provisional model shown, in ms. */
  readonly dragFrames: number[] = [];
  error: string | null = null;

  private builder: PreviewBuilder;
  private pending: { doc: Document; provisional: boolean; requested: number } | null = null;
  private running: Promise<void> | null = null;
  /** Drawable index of each mesh UID in the model shown, and the document it was built from. */
  private meshIndex = new Map<Uid, number>();
  /** Index of each deformer UID in the model shown. */
  private deformerIndex = new Map<Uid, number>();
  private shownDoc: Document | null = null;
  /** The model data shown, kept in step with every patch; and the files it came with. */
  private shownData: { data: MocData; version: MocVersion; files: Map<string, Uint8Array> } | null =
    null;
  private drag: Drag | null = null;
  private hover: Uid | null = null;
  private fitNext = true;
  /** Objects an agent said it is working on (bridge `focus`), outlined in the agent color. */
  private focus: Uid[] = [];
  private readonly waiters: (() => void)[] = [];
  private readonly atlas: HTMLDivElement;

  constructor(
    private readonly editor: Editor,
    parent: HTMLElement,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'viewport';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'model';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    this.overlay.tabIndex = 0;
    this.overlay.dataset.testid = 'overlay';
    this.atlas = document.createElement('div');
    this.atlas.className = 'atlas-view';
    this.atlas.hidden = true;
    this.root.append(this.canvas, this.overlay, this.atlas);
    parent.append(this.root);
    // Without WebGL2, a stand-in that draws nothing, and a notice in place of the model.
    const made = makeView(this.canvas, { look: 'off', zoom: false, pan: false });
    this.view = made.view;
    this.unavailable = made.unavailable;
    if (this.unavailable) {
      const notice = document.createElement('div');
      notice.className = 'no-view';
      notice.dataset.testid = 'no-view';
      notice.textContent = this.unavailable;
      this.root.append(notice);
    }
    this.view.on('frame', () => this.drawOverlay());
    this.builder = new PreviewBuilder(editor.assets);

    editor.on('project', () => {
      this.builder = new PreviewBuilder(editor.assets);
      this.view.unload();
      this.meshIndex.clear();
      this.shownDoc = null;
      this.shownData = null;
      this.focus = [];
      this.fitNext = true;
      this.request(editor.doc, false);
    });
    editor.on('document', () => this.request(editor.doc, false));
    editor.on('pose', () => this.applyPose());
    editor.on('selection', () => this.drawOverlay());
    editor.on('mode', () => this.drawOverlay());
    editor.on('viewState', () => this.request(editor.doc, false));
    this.bindPointer();
  }

  private viewCache: { doc: Document; view: DocView } | null = null;
  /** A reader of the document shown, kept while it is the same document. */
  private shownView(): DocView {
    const doc = this.shownDoc!;
    if (this.viewCache?.doc !== doc) this.viewCache = { doc, view: new DocView(doc) };
    return this.viewCache.view;
  }

  get model(): MochiModel | null {
    return this.view.model;
  }

  // ---------------------------------------------------------------- preview builds

  /** Shows a document (the session's, or a provisional one during a drag). Latest wins. */
  request(doc: Document, provisional: boolean): void {
    this.pending = { doc: this.viewFilter(doc), provisional, requested: performance.now() };
    // Start after the current task's listeners (the panels) have run, so build timings are clean.
    this.running ??= Promise.resolve()
      .then(() => this.loop())
      .finally(() => {
        this.running = null;
        if (this.pending) this.request(this.pending.doc, this.pending.provisional);
        else for (const w of this.waiters.splice(0)) w();
      });
  }

  /**
   * The document as the view shows it: objects the person hid (or that a solo leaves out) are
   * disabled in the preview only. The document itself is unchanged.
   */
  private viewFilter(doc: Document): Document {
    const e = this.editor;
    if (e.hidden.size === 0 && !e.solo && e.physicsMuted.size === 0) return doc;
    const v = new DocView(doc);
    const tx = new Tx(new Draft(doc));
    let n = 0;
    for (const u of e.physicsMuted)
      if (v.get(u)?.kind === 'physicsSetting') {
        tx.run('physics.removeSetting', { target: u });
        n++;
      }
    for (const m of v.ofKind('artMesh'))
      if (m.enabled && e.isHidden(m.uid)) {
        tx.run('mesh.update', { target: m.uid, enabled: false });
        n++;
      }
    return n ? tx.draft.finish().doc : doc;
  }

  /**
   * Live physics (the physics dialog's test): Mochi2D's physics runs in the view, overwriting its
   * outputs every frame. Off while editing otherwise, like the other effects.
   */
  simulate = false;

  setSimulate(on: boolean): void {
    this.simulate = on;
    const model = this.view.model;
    if (model?.effectAvailable('physics')) model.setEffect('physics', on);
  }

  /**
   * Scrubbing with physics (the Timeline, stopped): physics on, the view's clock paused, so the
   * pose the Timeline computed for the playhead stays as it is.
   */
  scrubbing = false;

  setScrubbing(on: boolean): void {
    if (on === this.scrubbing) return;
    this.scrubbing = on;
    this.view.paused = on;
    const model = this.view.model;
    if (model?.effectAvailable('physics')) model.setEffect('physics', on || this.simulate);
  }

  /** The files of the model shown (the preview export), for a headless copy of it. */
  shownFiles(): ReadonlyMap<string, Uint8Array> | null {
    const d = this.shownData;
    if (!d) return null;
    // The view gets the .moc3 as data; a copy needs its bytes, at the name the settings give.
    const settings = [...d.files.keys()].find((k) => k.endsWith('.model3.json'));
    if (!settings) return null;
    const json = JSON.parse(new TextDecoder().decode(d.files.get(settings)!)) as {
      FileReferences?: { Moc?: string };
    };
    const moc = json.FileReferences?.Moc;
    if (!moc) return null;
    const dir = settings.includes('/') ? settings.slice(0, settings.lastIndexOf('/') + 1) : '';
    const out = new Map(d.files);
    if (!out.has(dir + moc)) out.set(dir + moc, writeMoc(d.data, { version: d.version }));
    return out;
  }

  /** Effects after a load or replace: all off, physics as the test says. */
  private effectsOff(model: MochiModel): void {
    const on = (e: string) =>
      (e === 'physics' && (this.simulate || this.scrubbing)) ||
      (e === 'expressions' && this.previewExpression !== null) ||
      (e === 'pose' && this.posePreview !== null);
    for (const e of EFFECTS) if (model.effectAvailable(e)) model.setEffect(e, on(e));
    this.applyPreviews(model);
  }

  /**
   * Expression preview (the Expression palette): Mochi2D applies the expression, by its name in the
   * model settings, on top of the pose. Null: none.
   */
  previewExpression: string | null = null;
  /**
   * Pose preview (the Parts palette): Mochi2D's pose runs, and these part opacities (by export ID)
   * pick which part of each group shows. Null: off.
   */
  posePreview: Map<string, number> | null = null;

  setPreviewExpression(name: string | null): void {
    this.previewExpression = name;
    const model = this.view.model;
    if (model) this.effectsOff(model);
  }

  setPosePreview(opacities: Map<string, number> | null): void {
    const model = this.view.model;
    // Off again: the parts' own opacities, as while editing.
    if (!opacities && this.posePreview && model)
      for (const p of model.parts) model.setPartOpacity(p.id, p.defaultOpacity);
    this.posePreview = opacities;
    if (model) this.effectsOff(model);
  }

  private applyPreviews(model: MochiModel): void {
    if (this.previewExpression !== null) {
      if (model.effectAvailable('expressions')) void model.setExpression(this.previewExpression);
    } else if (model.effectAvailable('expressions')) model.clearExpression();
    // Like a motion's part-opacity curves, the chosen opacities are written every frame while the
    // preview runs; Mochi2D's pose turns them into the fades and the links.
    cancelAnimationFrame(this.poseRaf);
    if (!this.posePreview) return;
    const tick = () => {
      const m = this.view.model;
      if (!this.posePreview || !m) return;
      for (const [id, v] of this.posePreview) m.setPartOpacity(id, v);
      this.poseRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  private poseRaf = 0;

  /**
   * Recording: set by main to the Timeline. While it is active, turning a rotation
   * deformer at edit levels 2 and 3 changes the parameters that turn it, not its keyforms, and keys
   * them at the playhead on release.
   */
  recorder: { recordActive(): boolean; recordKeys(values: Map<Uid, number>): void } | null = null;

  /**
   * Part opacities from a motion's part-opacity curves at the Timeline's current frame (by export
   * ID), written every frame while set. Null: the parts' own opacities again.
   */
  partOverrides: Map<string, number> | null = null;
  private overrideRaf = 0;

  setPartOverrides(opacities: Map<string, number> | null): void {
    const model = this.view.model;
    if (!opacities && this.partOverrides && model)
      for (const p of model.parts) model.setPartOpacity(p.id, p.defaultOpacity);
    this.partOverrides = opacities;
    cancelAnimationFrame(this.overrideRaf);
    if (!opacities) return;
    const tick = () => {
      const m = this.view.model;
      if (!this.partOverrides || !m) return;
      for (const [id, v] of this.partOverrides) m.setPartOpacity(id, v);
      this.overrideRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Resolves when every requested build has been shown. */
  idle(): Promise<void> {
    if (!this.running && !this.pending) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private async loop(): Promise<void> {
    while (this.pending) {
      const job = this.pending;
      this.pending = null;
      const view = new DocView(job.doc);
      if (this.unavailable || view.ofKind('artMesh').length === 0) {
        this.view.unload();
        this.shownData = null;
        this.meshIndex.clear();
        this.deformerIndex.clear();
        this.shownDoc = job.doc;
        this.error = null;
        continue;
      }
      try {
        const build = await this.builder.build(job.doc, { writeMoc: false });
        const t0 = performance.now();
        const mode = await this.show(build);
        const load = performance.now() - t0;
        this.meshIndex = new Map(build.lowered.uids.artMeshes.map((u, i) => [u, i]));
        this.deformerIndex = new Map(build.lowered.uids.deformers.map((u, i) => [u, i]));
        this.shownDoc = job.doc;
        this.error = null;
        this.applyPose();
        const stats: BuildStats = {
          revision: this.editor.session.revision,
          provisional: job.provisional,
          timings: build.timings,
          mode,
          patches: this.lastPatches,
          load,
          total: performance.now() - job.requested,
          atlasReused: build.atlasReused,
          lowering: build.lowering.mode,
          drawables: build.lowered.uids.artMeshes.length,
        };
        this.builds.push(stats);
        if (this.builds.length > 200) this.builds.shift();
        if (job.provisional) {
          this.dragFrames.push(stats.total);
          if (this.dragFrames.length > 500) this.dragFrames.shift();
        }
      } catch (e) {
        this.error = (e as Error).message;
        this.editor.report(e);
      }
    }
  }

  /**
   * Shows a build in the cheapest way that gives the same result (Mochi2D 0.6.0):
   * - the same structure: value patches, written into the shown model;
   * - other structure, same textures and settings: `model.replace`, keeping textures and view;
   * - otherwise (a new atlas, other settings files, or nothing shown yet): a full load.
   */
  private lastPatches = 0;

  private async show(build: PreviewBuild): Promise<BuildStats['mode']> {
    this.lastPatches = 0;
    const model = this.view.model;
    const shown = this.shownData;
    const sameFiles =
      shown !== null &&
      build.atlasReused &&
      [...build.files].every(
        ([path, bytes]) => path.endsWith('.moc3') || equalBytes(shown.files.get(path), bytes),
      ) &&
      [...shown.files.keys()].every((p) => build.files.has(p));
    if (model && shown && sameFiles) {
      const patches =
        build.version === shown.version ? dataPatches(shown.data, build.lowered.data) : null;
      if (patches) {
        if (patches.length) model.patch(patches);
        this.lastPatches = patches.length;
        applyDataPatches(shown.data, patches);
        return 'patch';
      }
      await model.replace(build.lowered.data, build.version);
      this.shownData = { data: build.lowered.data, version: build.version, files: build.files };
      this.effectsOff(model);
      return 'replace';
    }
    // Loading fits the view; keep the person's zoom and pan unless a new project opened.
    const files = new Map(build.files);
    files.set(build.mocPath, writeMoc(build.lowered.data, { version: build.version }));
    const loaded = await this.view.load(
      { files },
      { settings: build.settings, keepView: this.view.model !== null && !this.fitNext },
    );
    this.fitNext = false;
    this.effectsOff(loaded);
    this.shownData = { data: build.lowered.data, version: build.version, files: build.files };
    return 'load';
  }

  private applyPose(): void {
    const model = this.view.model;
    if (!model) return;
    for (const [id, v] of Object.entries(this.editor.poseByExportId())) model.setParameter(id, v);
    // Evaluate now, so overlays, picking and the agent surface see the pose before the next frame.
    model.runtime.update(0);
    this.drawOverlay();
  }

  /** Mochi2D's evaluated drawables of the model shown, in canvas pixels (y down). */
  evaluation() {
    const inst = this.view.model?.runtime.instance;
    if (!inst || !this.shownDoc) return { drawables: [] };
    const c = this.editor.view.project().canvas;
    const uids = [...this.meshIndex.entries()].sort((a, b) => a[1] - b[1]).map(([u]) => u);
    const shown = this.shownView();
    return {
      drawables: uids.map((uid, i) => {
        const v = inst.drawableVertices[i]!;
        const px: number[] = [];
        for (let k = 0; k < v.length; k += 2)
          px.push(v[k]! * c.pixelsPerUnit + c.originX, -v[k + 1]! * c.pixelsPerUnit + c.originY);
        return {
          uid,
          id: shown.getAs(uid, 'artMesh').exportId,
          visible: inst.drawableVisible[i] === 1,
          opacity: inst.drawableOpacity[i]!,
          drawOrder: inst.drawableDrawOrder[i]!,
          renderOrder: inst.drawableRenderOrder[i]!,
          vertices: px,
        };
      }),
    };
  }

  // ---------------------------------------------------------------- coordinates

  /** Model units (y up) → CSS pixels relative to the viewport. */
  modelToLocal(x: number, y: number): [number, number] {
    const model = this.view.model;
    if (!model) return [NaN, NaN];
    const t = this.view.viewTransform;
    const c = model.canvas;
    const dx = x - (c.left + c.right) / 2 - t.x;
    const dy = y - (c.bottom + c.top) / 2 - t.y;
    const a = (t.rotation * Math.PI) / 180;
    const rx = dx * Math.cos(a) - dy * Math.sin(a);
    const ry = dx * Math.sin(a) + dy * Math.cos(a);
    const r = this.canvas.getBoundingClientRect();
    return [r.width / 2 + rx * t.pixelsPerUnit, r.height / 2 - ry * t.pixelsPerUnit];
  }

  /** Page coordinates → canvas pixels (y down), through Mochi2D's toModel. */
  clientToCanvas(clientX: number, clientY: number): [number, number] | null {
    const m = this.view.toModel(clientX, clientY);
    if (!m) return null;
    const c = this.editor.view.project().canvas;
    return [m.x * c.pixelsPerUnit + c.originX, -m.y * c.pixelsPerUnit + c.originY];
  }

  /** A mesh's evaluated vertices in viewport CSS pixels, or null when it is not in the model shown. */
  meshScreen(uid: Uid): [number, number][] | null {
    const i = this.meshIndex.get(uid);
    const inst = this.view.model?.runtime.instance;
    if (i === undefined || !inst) return null;
    const v = inst.drawableVertices[i];
    if (!v) return null;
    const out: [number, number][] = [];
    for (let k = 0; k < v.length; k += 2) out.push(this.modelToLocal(v[k]!, v[k + 1]!));
    return out;
  }

  /**
   * The shown model's forward map of a deformer at the current pose, in canvas pixels: from its
   * local space (a warp's (u, v), a rotation's pixels) to the canvas, with Jacobians.
   */
  forwardMap(deformer: Uid): ForwardMap | null {
    const inst = this.view.model?.runtime.instance;
    const di = this.deformerIndex.get(deformer);
    if (!inst || di === undefined) return null;
    const { pixelsPerUnit: ppu, originX, originY } = this.editor.view.project().canvas;
    return (pts) => {
      const k = inst.mapPoints(di, pts, 'keyform');
      const points = new Float64Array(k.length);
      for (let i = 0; i < k.length; i += 2) {
        points[i] = k[i]! * ppu + originX;
        points[i + 1] = k[i + 1]! * ppu + originY;
      }
      return { points, jacobians: inst.mapJacobians(di, pts, 'keyform').map((v) => v * ppu) };
    };
  }

  /** Local points of a shown deformer in viewport CSS pixels. */
  private deformerScreen(uid: Uid, local: number[]): [number, number][] | null {
    const inst = this.view.model?.runtime.instance;
    const di = this.deformerIndex.get(uid);
    if (!inst || di === undefined) return null;
    const m = inst.mapPoints(di, local, 'model');
    const out: [number, number][] = [];
    for (let k = 0; k < m.length; k += 2) out.push(this.modelToLocal(m[k]!, m[k + 1]!));
    return out;
  }

  /** A deformer's handles in viewport CSS pixels: a warp's grid points, a rotation's origin. */
  deformerHandles(uid: Uid): [number, number][] | null {
    const o = this.editor.view.get(uid);
    if (o?.kind === 'rotation') return this.deformerScreen(uid, [0, 0]);
    if (o?.kind !== 'warp') return null;
    const uv: number[] = [];
    for (let r = 0; r <= o.rows; r++)
      for (let c = 0; c <= o.cols; c++) uv.push(c / o.cols, r / o.rows);
    return this.deformerScreen(uid, uv);
  }

  /**
   * The mesh UID drawn topmost at a point that can be picked: Mochi2D's hit test, or, when that
   * mesh is locked, the topmost unlocked mesh whose triangles hold the point. Nothing while
   * drawables are locked on the canvas (Shift+A).
   */
  meshAt(clientX: number, clientY: number): Uid | null {
    if (this.editor.canvasLock.drawables) return null;
    const hit = this.view.hitTest(clientX, clientY);
    const mesh = hit?.drawable
      ? this.editor.view
          .ofKind('artMesh')
          .find((m) => m.exportId === hit.drawable && this.meshIndex.has(m.uid))
      : undefined;
    if (mesh && !this.editor.isLocked(mesh.uid)) return mesh.uid;
    if (!mesh) return null;
    return this.meshesAt(clientX, clientY).find((u) => !this.editor.isLocked(u)) ?? null;
  }

  /** Every shown mesh whose triangles hold a point, topmost first. */
  meshesAt(clientX: number, clientY: number): Uid[] {
    const inst = this.view.model?.runtime.instance;
    if (!inst || !this.shownDoc) return [];
    const r = this.overlay.getBoundingClientRect();
    const p: [number, number] = [clientX - r.left, clientY - r.top];
    const shown = this.shownView();
    const out: { uid: Uid; order: number }[] = [];
    for (const [uid, i] of this.meshIndex) {
      if (inst.drawableVisible[i] !== 1) continue;
      const mesh = shown.get(uid);
      const pts = this.meshScreen(uid);
      if (!pts || mesh?.kind !== 'artMesh') continue;
      const inside = triangles(mesh).some(([a, b, c]) => {
        const w = barycentric(p, pts[a]!, pts[b]!, pts[c]!);
        return w !== null && w.every((x) => x >= -1e-6);
      });
      if (inside) out.push({ uid, order: inst.drawableRenderOrder[i]! });
    }
    return out.sort((a, b) => b.order - a.order).map((x) => x.uid);
  }

  /** The topmost shown mesh at a point regardless of locks (the context menu). */
  meshUnder(clientX: number, clientY: number): Uid | null {
    return this.meshesAt(clientX, clientY)[0] ?? null;
  }

  /** Model units → page coordinates, inverse of clientToCanvas's first step. */
  canvasToLocal(cx: number, cy: number): [number, number] {
    const c = this.editor.view.project().canvas;
    return this.modelToLocal(
      (cx - c.originX) / c.pixelsPerUnit,
      -(cy - c.originY) / c.pixelsPerUnit,
    );
  }

  /** Page coordinates as the model sees them: mirrored back when the view is flipped. */
  unflip(clientX: number, clientY: number): [number, number] {
    if (!this.flipped) return [clientX, clientY];
    const r = this.root.getBoundingClientRect();
    return [r.left + r.right - clientX, clientY];
  }

  setFlipped(on: boolean): void {
    this.flipped = on;
    this.root.classList.toggle('flipped', on);
    this.drawOverlay();
  }

  /** Shows the texture atlas (T): the packed pages, with each mesh's UVs drawn over them. */
  setAtlasView(on: boolean): void {
    this.atlasView = on;
    this.atlas.hidden = !on;
    this.atlas.replaceChildren();
    if (!on || !this.shownData) return;
    const pngs = [...this.shownData.files].filter(([p]) => p.endsWith('.png'));
    for (const [path, bytes] of pngs) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
      img.title = path;
      img.dataset.testid = 'atlas-page';
      this.atlas.append(img);
    }
    if (pngs.length === 0) this.atlas.textContent = 'No texture atlas yet: import art first.';
  }

  /** Frames the selected objects at their evaluated position (or fits the whole model). */
  frameSelection(): void {
    const inst = this.view.model?.runtime.instance;
    const model = this.view.model;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (x: number, y: number) => {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    };
    const v = this.editor.view;
    for (const uid of this.editor.selection.uids) {
      const o = v.get(uid);
      const meshes =
        o?.kind === 'artMesh'
          ? [uid]
          : o?.kind === 'part'
            ? v
                .ofKind('artMesh')
                .filter((m) => this.inPart(m.uid, uid))
                .map((m) => m.uid)
            : o?.kind === 'warp' || o?.kind === 'rotation'
              ? v
                  .ofKind('artMesh')
                  .filter((m) => this.inDeformer(m.uid, uid))
                  .map((m) => m.uid)
              : [];
      for (const m of meshes) {
        const i = this.meshIndex.get(m);
        const pts = i !== undefined ? inst?.drawableVertices[i] : undefined;
        if (pts) for (let k = 0; k < pts.length; k += 2) add(pts[k]!, pts[k + 1]!);
      }
    }
    if (!model || !Number.isFinite(x0)) return this.view.resetView();
    const c = model.canvas;
    const t = this.view.viewTransform;
    const r = this.canvas.getBoundingClientRect();
    // pixelsPerUnit / zoom is the fitted view's scale; aim for the mesh to fill 60 % of the view.
    const fitted = t.pixelsPerUnit / t.zoom;
    const zoom = (0.6 * Math.min(r.width / (x1 - x0 || 1), r.height / (y1 - y0 || 1))) / fitted;
    this.view.setView({
      x: (x0 + x1) / 2 - (c.left + c.right) / 2,
      y: (y0 + y1) / 2 - (c.bottom + c.top) / 2,
      zoom: Math.min(64, Math.max(0.05, zoom)),
    });
    this.drawOverlay();
  }

  zoomAt(clientX: number, clientY: number, factor: number): void {
    const before = this.view.toModel(clientX, clientY);
    const t = this.view.viewTransform;
    this.view.setView({ zoom: Math.min(64, Math.max(0.05, t.zoom * factor)) });
    if (!before) return;
    const r = this.canvas.getBoundingClientRect();
    const [sx, sy] = this.modelToLocal(before.x, before.y);
    this.view.panBy(clientX - r.left - sx, clientY - r.top - sy);
  }

  /** Whether a mesh is inside a part (at any depth). */
  inPart(mesh: Uid, part: Uid): boolean {
    let p = this.editor.view.get(mesh) as { part?: Uid | null; parent?: Uid | null } | undefined;
    let u: Uid | null | undefined = p?.part;
    const seen = new Set<Uid>();
    while (u && !seen.has(u)) {
      if (u === part) return true;
      seen.add(u);
      p = this.editor.view.get(u) as { parent?: Uid | null } | undefined;
      u = p?.parent;
    }
    return false;
  }

  /** Whether a mesh is inside a deformer (at any depth). */
  inDeformer(mesh: Uid, deformer: Uid): boolean {
    const v = this.editor.view;
    const m = v.get(mesh);
    let u: Uid | null = m?.kind === 'artMesh' ? m.deformer : null;
    const seen = new Set<Uid>();
    while (u && !seen.has(u)) {
      if (u === deformer) return true;
      seen.add(u);
      const d = v.get(u) as Warp | Rotation | undefined;
      u = d?.parent ?? null;
    }
    return false;
  }

  setFocus(uids: Uid[]): void {
    this.focus = uids;
    this.drawOverlay();
  }

  // ---------------------------------------------------------------- overlay

  /** Whether the points of the selected object are shown and grabbed (edit levels 1 and 2). */
  private get pointsShown(): boolean {
    return this.editor.meshEdit !== null || this.editor.level !== 3;
  }

  drawOverlay(): void {
    const r = this.overlay.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    const g = this.overlay.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    if (!this.view.model || !this.shownDoc) return;
    this.drawSnapshot(g);
    const shown = this.shownView();
    const outline = (uid: Uid, style: string, width: number) => {
      const mesh = shown.get(uid);
      const pts = this.meshScreen(uid);
      if (!pts || mesh?.kind !== 'artMesh') return;
      g.strokeStyle = style;
      g.lineWidth = width;
      g.beginPath();
      for (const [a, b, c] of triangles(mesh)) {
        const [pa, pb, pc] = [pts[a], pts[b], pts[c]];
        if (!pa || !pb || !pc) continue;
        g.moveTo(...pa);
        g.lineTo(...pb);
        g.lineTo(...pc);
        g.closePath();
      }
      g.stroke();
    };
    const meshEdit = this.editor.meshEdit;
    if (this.showAllMeshes)
      for (const uid of this.meshIndex.keys()) outline(uid, 'rgba(120, 140, 170, 0.45)', 0.75);
    for (const uid of this.focus) outline(uid, 'rgba(70, 200, 255, 0.95)', 2);
    for (const uid of this.highlight) {
      const o = this.editor.view.get(uid);
      if (o?.kind === 'artMesh') outline(uid, 'rgba(150, 230, 120, 0.9)', 1.5);
      else if (o?.kind === 'warp' || o?.kind === 'rotation') this.drawDeformer(g, o, true);
    }
    if (this.hover && !this.editor.isSelected(this.hover))
      outline(this.hover, 'rgba(255, 190, 80, 0.8)', 1);
    const drag = this.drag?.points;
    for (const uid of this.editor.selection.uids) {
      const o = this.editor.view.get(uid);
      if (o?.kind === 'artMesh') {
        const editing = meshEdit?.uids.includes(uid) ?? false;
        outline(
          uid,
          editing ? 'rgba(255, 122, 162, 0.95)' : 'rgba(70, 200, 255, 0.9)',
          editing ? 1.25 : 1,
        );
      }
    }
    for (const uid of meshEdit?.uids ?? [])
      if (!this.editor.isSelected(uid)) outline(uid, 'rgba(255, 122, 162, 0.6)', 1);
    const mesh = this.editor.selectedMesh();
    if (mesh && this.pointsShown) {
      let pts = this.meshScreen(mesh.uid) ?? [];
      if (drag?.target === mesh.uid) {
        // The dragged points where the pointer has them, ahead of the preview.
        pts = pts.slice();
        drag.points.forEach((v, i) => (pts[v] = drag.screenNow[i] ?? pts[v]!));
      }
      const sel = new Set(this.editor.selection.vertices);
      pts.forEach(([x, y], i) => {
        g.beginPath();
        g.arc(x, y, sel.has(i) ? 4 : 3, 0, Math.PI * 2);
        g.fillStyle = sel.has(i) ? '#ff5a8a' : meshEdit ? '#ffe3ec' : '#ffffff';
        g.strokeStyle = '#0b3954';
        g.lineWidth = 1.25;
        g.fill();
        g.stroke();
      });
    }
    const sel = this.editor.selection.uid
      ? this.editor.view.get(this.editor.selection.uid)
      : undefined;
    if (sel?.kind === 'warp' || sel?.kind === 'rotation') this.drawDeformer(g, sel);
    const box = this.boxFor();
    if (box) {
      g.strokeStyle = 'rgba(70, 200, 255, 0.95)';
      g.lineWidth = 1;
      g.setLineDash([5, 3]);
      g.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      g.setLineDash([]);
      for (const [x, y] of boxCorners(box)) {
        g.fillStyle = '#16181d';
        g.fillRect(x - 4, y - 4, 8, 8);
        g.strokeRect(x - 4, y - 4, 8, 8);
      }
    }
    const d = this.drag;
    if (d?.kind === 'marquee') {
      const r0 = this.overlay.getBoundingClientRect();
      g.strokeStyle = '#46c8ff';
      g.setLineDash([4, 3]);
      g.strokeRect(d.x0 - r0.left, d.y0 - r0.top, d.x - d.x0, d.y - d.y0);
      g.setLineDash([]);
    } else if (d?.kind === 'lasso' && d.path && d.path.length > 1) {
      g.strokeStyle = '#46c8ff';
      g.setLineDash([4, 3]);
      g.beginPath();
      d.path.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.stroke();
      g.setLineDash([]);
    } else if (d?.kind === 'createRotation') {
      const r0 = this.overlay.getBoundingClientRect();
      g.strokeStyle = 'rgba(255, 170, 60, 0.95)';
      g.beginPath();
      g.arc(d.x0 - r0.left, d.y0 - r0.top, 9, 0, Math.PI * 2);
      g.moveTo(d.x0 - r0.left, d.y0 - r0.top);
      g.lineTo(d.x - r0.left, d.y - r0.top);
      g.stroke();
    }
    this.drawPaths(g);
    this.drawBrush(g);
    this.drawTemplateGuide(g);
  }

  /** Deform paths: the shown ones, and the one being drawn (dashed). */
  private drawPaths(g: CanvasRenderingContext2D): void {
    const list = [...this.visiblePaths(), ...(this.drawingPath ? [this.drawingPath] : [])];
    for (const p of list) {
      const pts = this.pathScreen(p);
      const drawing = p === this.drawingPath;
      const on = p.id === this.selectedPath;
      g.save();
      g.lineWidth = 2;
      g.strokeStyle = on || drawing ? '#c792ea' : 'rgba(199, 146, 234, 0.6)';
      if (drawing) g.setLineDash([6, 4]);
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.setLineDash([]);
      for (const [x, y] of pts) {
        g.beginPath();
        g.moveTo(x, y - 6);
        g.lineTo(x + 6, y);
        g.lineTo(x, y + 6);
        g.lineTo(x - 6, y);
        g.closePath();
        g.fillStyle = on || drawing ? '#c792ea' : '#2a1838';
        g.fill();
        g.strokeStyle = '#ffffff';
        g.lineWidth = 1;
        g.stroke();
      }
      g.restore();
    }
  }

  /**
   * A selected warp's lattice (curved as the parents bend it), or a rotation's origin, its handle
   * (drag to turn) and its scale handle (the square beyond it).
   */
  private drawDeformer(g: CanvasRenderingContext2D, o: Warp | Rotation, dim = false): void {
    g.strokeStyle = dim ? 'rgba(150, 230, 120, 0.8)' : 'rgba(255, 170, 60, 0.9)';
    g.lineWidth = 1.25;
    if (o.kind === 'warp') {
      const S = 8;
      const line = (pts: number[]) => {
        const scr = this.deformerScreen(o.uid, pts);
        if (!scr) return;
        g.beginPath();
        scr.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
      };
      for (let r = 0; r <= o.rows; r++) {
        const pts: number[] = [];
        for (let i = 0; i <= o.cols * S; i++) pts.push(i / (o.cols * S), r / o.rows);
        line(pts);
      }
      for (let c = 0; c <= o.cols; c++) {
        const pts: number[] = [];
        for (let i = 0; i <= o.rows * S; i++) pts.push(c / o.cols, i / (o.rows * S));
        line(pts);
      }
    } else {
      const hs = this.rotationHandles(o.uid);
      if (hs) {
        const [origin, tip, scale] = hs;
        g.beginPath();
        g.moveTo(...origin);
        g.lineTo(...scale);
        g.stroke();
        g.beginPath();
        g.arc(origin[0], origin[1], 9, 0, Math.PI * 2);
        g.stroke();
        if (!dim) {
          g.fillStyle = '#ffb347';
          g.beginPath();
          g.arc(tip[0], tip[1], 5, 0, Math.PI * 2);
          g.fill();
          g.fillRect(scale[0] - 3.5, scale[1] - 3.5, 7, 7);
        }
      }
    }
    if (dim || !this.pointsShown) return;
    let pts = this.deformerHandles(o.uid) ?? [];
    const drag = this.drag?.points;
    if (drag?.target === o.uid && drag.mode !== 'angle' && drag.mode !== 'scale') {
      pts = pts.slice();
      drag.points.forEach((v, i) => (pts[v] = drag.screenNow[i] ?? pts[v]!));
    }
    const net = o.kind === 'warp' && this.bezierShown(o);
    for (const [x, y] of pts) {
      g.fillStyle = '#ffb347';
      g.strokeStyle = '#3a2200';
      const r = net ? 2.5 : 3.5;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
      g.strokeRect(x - r, y - r, 2 * r, 2 * r);
    }
    if (o.kind === 'warp' && net) this.drawNet(g, o, pts);
  }

  /** The Bézier control layer: anchors as round pink dots, handles as rings on lines to them. */
  private drawNet(g: CanvasRenderingContext2D, o: Warp, grid: [number, number][]): void {
    const ctrl = this.bezierScreen(o, grid);
    if (!ctrl) return;
    const shape = this.netShape(o);
    g.save();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255, 122, 162, 0.85)';
    ctrl.forEach(([x, y], i) => {
      const role = controlRole(shape, i);
      if (role.kind !== 'handle') return;
      const [ax, ay] = ctrl[role.anchor]!;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(x, y);
      g.stroke();
    });
    ctrl.forEach(([x, y], i) => {
      const anchor = controlRole(shape, i).kind === 'anchor';
      g.beginPath();
      g.arc(x, y, anchor ? 5.5 : 4, 0, Math.PI * 2);
      if (anchor) {
        g.fillStyle = '#ff7aa2';
        g.fill();
        g.strokeStyle = '#4a0f22';
      } else {
        g.fillStyle = '#ffffff';
        g.fill();
        g.strokeStyle = '#ff7aa2';
      }
      g.stroke();
    });
    g.restore();
  }

  /**
   * A rotation deformer's handles on screen: its origin, the turning handle at the end of its
   * axis, and the scale handle beyond it.
   */
  rotationHandles(uid: Uid): [[number, number], [number, number], [number, number]] | null {
    const axis = this.deformerScreen(uid, [0, 0, 1, 0]);
    if (!axis) return null;
    const [o, x] = axis as [[number, number], [number, number]];
    const len = Math.hypot(x[0] - o[0], x[1] - o[1]) || 1;
    const u: [number, number] = [(x[0] - o[0]) / len, (x[1] - o[1]) / len];
    const L = this.handleLength;
    return [
      o,
      [o[0] + u[0] * L, o[1] + u[1] * L],
      [o[0] + u[0] * (L + 16), o[1] + u[1] * (L + 16)],
    ];
  }

  /**
   * The transform box (edit levels 2 and 3): around the selected vertices (two or more) or, at
   * level 3, all of the selected mesh's points or the selected warp's grid. Null when there is
   * none, or while the person hides it.
   */
  private boxFor(): {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    target: Uid;
    points: number[];
  } | null {
    if (this.hideBox || this.editor.meshEdit) return null;
    const d = this.drag?.points;
    if (d?.box) {
      const xs = d.screenNow.map((p) => p[0]);
      const ys = d.screenNow.map((p) => p[1]);
      return {
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
        target: d.target,
        points: d.points,
      };
    }
    const level = this.editor.level;
    if (level === 1) return null;
    const o = this.editor.selection.uid
      ? this.editor.view.get(this.editor.selection.uid)
      : undefined;
    let pts: [number, number][] | null = null;
    let points: number[] = [];
    if (o?.kind === 'artMesh') {
      const all = this.meshScreen(o.uid);
      if (!all) return null;
      const sel = this.editor.selection.vertices;
      points = level === 3 || sel.length < 2 ? all.map((_, i) => i) : sel;
      if (level === 2 && sel.length < 2) return null;
      pts = points.map((i) => all[i]!);
    } else if (o?.kind === 'warp') {
      const all = this.deformerHandles(o.uid);
      if (!all) return null;
      points = all.map((_, i) => i);
      pts = all;
    }
    if (!pts || pts.length < 2 || !o) return null;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const box = {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    };
    if (box.x1 - box.x0 < 2 && box.y1 - box.y0 < 2) return null;
    return { ...box, target: o.uid, points };
  }

  /** What a press grabs on the transform box: a corner to scale, the ring past it to rotate, the inside to move. */
  private boxGrab(
    box: { x0: number; y0: number; x1: number; y1: number },
    x: number,
    y: number,
  ): BoxGrab | null {
    const reach = this.settings.value.cornerReach;
    const corners = boxCorners(box);
    for (let c = 0; c < 4; c++) {
      const dist = Math.hypot(corners[c]![0] - x, corners[c]![1] - y);
      if (dist <= reach) return { kind: 'scale', corner: c as 0 | 1 | 2 | 3 };
    }
    for (let c = 0; c < 4; c++) {
      const [cx, cy] = corners[c]!;
      const dist = Math.hypot(cx - x, cy - y);
      const outside = x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1;
      if (dist <= 2.5 * reach && outside) return { kind: 'rotate', corner: c as 0 | 1 | 2 | 3 };
    }
    if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return { kind: 'move' };
    return null;
  }

  // ---------------------------------------------------------------- pointer

  private bindPointer(): void {
    const el = this.overlay;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Laying out a template: the right button scales it.
      if (this.layoutEdit) return;
      const [x, y] = this.unflip(e.clientX, e.clientY);
      this.onContextMenu(e, this.meshUnder(x, y), e.ctrlKey || e.metaKey);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = this.unflip(e.clientX, e.clientY);
      this.zoomAt(x, y, Math.exp(-e.deltaY * 0.0015));
    });
    el.addEventListener('dblclick', (e) => {
      const [x, y] = this.unflip(e.clientX, e.clientY);
      if (this.tool === 'path') {
        this.finishPath();
        return;
      }
      const km = this.keymap;
      if (km?.isHeld('view.rotate')) {
        km.useHold('view.rotate');
        this.view.setView({ rotation: 0 });
        this.drawOverlay();
        return;
      }
      // The double-click does not enter mesh editing while the deform brush is active.
      if (this.tool === 'deform') return;
      if (!this.settings.value.doubleClickMeshEdit || this.editor.meshEdit) return;
      const uid = this.meshAt(x, y);
      if (uid) {
        this.editor.select(uid);
        this.editor.enterMeshEdit();
      }
    });
    el.addEventListener('pointerdown', (e) => {
      el.focus();
      el.setPointerCapture(e.pointerId);
      const [cx, cy] = this.unflip(e.clientX, e.clientY);
      if (this.layoutEdit) {
        const at = this.clientToCanvas(cx, cy);
        if (at) this.layoutEdit({ kind: 'down', button: e.button, at });
        this.layoutDragging = true;
        return;
      }
      const base = { x0: cx, y0: cy, x: cx, y: cy };
      const km = this.keymap;
      if (e.button === 1 || (e.button === 0 && km?.isHeld('view.pan'))) {
        km?.useHold('view.pan');
        this.drag = { kind: 'pan', ...base, axis: e.shiftKey ? null : undefined };
        return;
      }
      if (e.button === 0 && km?.isHeld('view.zoom')) {
        km.useHold('view.zoom');
        this.drag = { kind: 'zoomView', ...base, view0: { ...this.view.viewTransform } };
        return;
      }
      if (e.button === 0 && km?.isHeld('view.rotate')) {
        km.useHold('view.rotate');
        this.drag = { kind: 'rotateView', ...base, view0: { ...this.view.viewTransform } };
        return;
      }
      if (e.button !== 0) return;
      // B, C or V + drag: the brush's size, angle or hardness.
      if (this.brushTool && km) {
        const holds = [
          ['tool.brush', 'size', this.brush.radius],
          ['brush.angle', 'angle', this.brush.angle],
          ['brush.hardness', 'hardness', this.brush.hardness],
        ] as const;
        for (const [id, which, v0] of holds)
          if (km.isHeld(id)) {
            km.useHold(id);
            this.drag = { kind: 'brushSet', ...base, brushSet: { which, v0 } };
            return;
          }
      }
      // An editing gesture: the person holds the control lease until shortly after it ends.
      this.editor.personGesture(true);
      const rr = this.overlay.getBoundingClientRect();
      const local: [number, number] = [cx - rr.left, cy - rr.top];
      this.brushAt = local;
      if (this.tool === 'brush') {
        if (!e.shiftKey && !e.altKey) {
          const m = this.editor.selectedMesh();
          if (m && (this.pointsShown || this.editor.meshEdit)) this.editor.select(m.uid, []);
          else if (!m) this.editor.select(null);
        }
        this.drag = { kind: 'brushSelect', ...base, remove: e.altKey };
        this.paintSelect(local, e.altKey);
        return;
      }
      if (this.tool === 'deform') {
        this.startDeform(base, local);
        return;
      }
      if (this.tool === 'addBrush') {
        this.drag = { kind: 'addPaint', ...base, paint: [] };
        this.paintAdd(this.drag, local);
        this.drawOverlay();
        return;
      }
      if (this.tool === 'stroke') {
        const c = this.clientToCanvas(cx, cy);
        if (c) this.drag = { kind: 'stroke', ...base, paint: [c] };
        return;
      }
      if (this.tool === 'add') {
        if (e.altKey) this.deleteVertexAt(cx, cy);
        else this.addVertexAt(cx, cy);
        return;
      }
      if (this.tool === 'rotation') {
        this.drag = { kind: 'createRotation', ...base };
        return;
      }
      if (this.tool === 'path') {
        this.pressPath(base);
        return;
      }
      if (this.tool === 'lasso') {
        const r = this.overlay.getBoundingClientRect();
        this.drag = {
          kind: 'lasso',
          ...base,
          path: [[cx - r.left, cy - r.top]],
          additive: e.shiftKey,
        };
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (this.pressHandles(e, base, ctrl)) return;
      this.drag = { kind: 'click', ...base, additive: e.shiftKey };
    });
    el.addEventListener('pointermove', (e) => {
      const [cx, cy] = this.unflip(e.clientX, e.clientY);
      const d = this.drag;
      const rr = this.overlay.getBoundingClientRect();
      if (this.layoutEdit && this.layoutDragging) {
        const at = this.clientToCanvas(cx, cy);
        if (at) this.layoutEdit({ kind: 'move', button: e.button, at });
        return;
      }
      if (this.brushTool) this.brushAt = [cx - rr.left, cy - rr.top];
      if (!d) {
        const h = this.meshAt(cx, cy);
        if (h !== this.hover || this.brushTool) {
          this.hover = h;
          this.drawOverlay();
        }
        return;
      }
      const [px, py] = [d.x, d.y];
      d.x = cx;
      d.y = cy;
      if (d.kind === 'pan') {
        let [dx, dy] = [d.x - px, d.y - py];
        if (d.axis === null && Math.hypot(d.x - d.x0, d.y - d.y0) > 3)
          d.axis = Math.abs(d.x - d.x0) >= Math.abs(d.y - d.y0) ? 'x' : 'y';
        if (d.axis === 'x') dy = 0;
        if (d.axis === 'y') dx = 0;
        if (d.axis !== null) this.view.panBy(this.flipped ? -dx : dx, dy);
      } else if (d.kind === 'zoomView') {
        // 1 % per pixel, right and up zoom in.
        const steps = d.x - d.x0 - (d.y - d.y0);
        this.view.setView({ zoom: Math.min(64, Math.max(0.05, d.view0!.zoom * 1.01 ** steps)) });
        this.drawOverlay();
      } else if (d.kind === 'rotateView') {
        const r = this.root.getBoundingClientRect();
        const [ox, oy] = [r.left + r.width / 2, r.top + r.height / 2];
        const a =
          (Math.atan2(d.y - oy, d.x - ox) - Math.atan2(d.y0 - oy, d.x0 - ox)) * (180 / Math.PI);
        let rot = d.view0!.rotation - a;
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        this.view.setView({ rotation: rot });
        this.drawOverlay();
      } else if (d.kind === 'marquee' || d.kind === 'click') {
        if (Math.hypot(d.x - d.x0, d.y - d.y0) > 4) d.kind = 'marquee';
        this.drawOverlay();
      } else if (d.kind === 'lasso') {
        const r = this.overlay.getBoundingClientRect();
        d.path!.push([cx - r.left, cy - r.top]);
        this.drawOverlay();
      } else if (d.kind === 'createRotation') {
        this.drawOverlay();
      } else if (d.kind === 'points') {
        this.dragTo(d, e);
        this.drawOverlay();
      } else if (d.kind === 'path') {
        this.dragPath(d, e.shiftKey);
        this.drawOverlay();
      } else if (d.kind === 'brushSet') {
        const s = d.brushSet!;
        const dx = d.x - d.x0;
        if (s.which === 'size') this.brush.radius = Math.max(2, Math.min(1000, s.v0 + dx));
        else if (s.which === 'angle') this.brush.angle = (((s.v0 + dx) % 360) + 360) % 360;
        else this.brush.hardness = Math.max(0, Math.min(1, s.v0 + dx / 200));
        this.brushAt = [d.x0 - rr.left, d.y0 - rr.top];
        this.editor.emit('viewState', undefined);
        this.drawOverlay();
      } else if (d.kind === 'brushSelect') {
        this.paintSelect([cx - rr.left, cy - rr.top], d.remove ?? false);
        this.drawOverlay();
      } else if (d.kind === 'addPaint') {
        this.paintAdd(d, [cx - rr.left, cy - rr.top]);
        this.drawOverlay();
      } else if (d.kind === 'stroke') {
        const c = this.clientToCanvas(cx, cy);
        const last = d.paint?.at(-1);
        if (c && (!last || Math.hypot(c[0] - last[0], c[1] - last[1]) > 1)) d.paint!.push(c);
        this.drawOverlay();
      }
    });
    const end = (e: PointerEvent) => {
      if (this.layoutEdit && this.layoutDragging) {
        this.layoutDragging = false;
        const [ex, ey] = this.unflip(e.clientX, e.clientY);
        const at = this.clientToCanvas(ex, ey);
        if (at) this.layoutEdit({ kind: 'up', button: e.button, at });
        return;
      }
      if (this.editor.inGesture) this.editor.personGesture(false);
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      const [cx, cy] = this.unflip(e.clientX, e.clientY);
      if (d.kind === 'points') this.commitPoints(d.points!);
      else if (d.kind === 'path') this.commitPath(d.pathEdit!);
      else if (d.kind === 'addPaint') this.commitAddPaint(d);
      else if (d.kind === 'stroke') {
        if ((d.paint?.length ?? 0) >= 2) this.strokes.push(d.paint!);
        this.editor.emit('viewState', undefined);
      } else if (d.kind === 'brushSet' || d.kind === 'brushSelect') {
        // Done while dragging.
      } else if (d.kind === 'marquee' && Math.hypot(d.x - d.x0, d.y - d.y0) > 4) {
        const r = this.overlay.getBoundingClientRect();
        const [x0, x1] = [Math.min(d.x0, d.x) - r.left, Math.max(d.x0, d.x) - r.left];
        const [y0, y1] = [Math.min(d.y0, d.y) - r.top, Math.max(d.y0, d.y) - r.top];
        this.selectInside(
          ([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
          d.additive ?? false,
        );
      } else if (d.kind === 'lasso' && d.path && d.path.length > 2) {
        const poly = d.path;
        this.selectInside((p) => insidePolygon(p, poly), d.additive ?? false);
      } else if (d.kind === 'click' || d.kind === 'marquee') {
        const uid = this.meshAt(cx, cy);
        if (this.editor.meshEdit) {
          // In mesh editing, a click outside the edited meshes only clears the vertex selection.
          const m = this.editor.selectedMesh();
          if (m) this.editor.select(m.uid, d.additive ? this.editor.selection.vertices : []);
        } else if (d.additive && uid) this.editor.toggleSelected(uid);
        else this.editor.select(uid);
      } else if (d.kind === 'createRotation') this.createRotationByDrag(d);
      this.drawOverlay();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /**
   * A press with the arrow tool on the selection's handles: a rotation's turning or scale handle,
   * a deformer's points, the transform box, or vertices of the selected mesh. True when it started
   * a drag (or changed the vertex selection).
   */
  private pressHandles(
    e: PointerEvent,
    base: { x0: number; y0: number; x: number; y: number },
    ctrl: boolean,
  ): boolean {
    const selected = this.editor.selection.uid
      ? this.editor.view.get(this.editor.selection.uid)
      : undefined;
    const r = this.overlay.getBoundingClientRect();
    const [lx, ly] = [base.x0 - r.left, base.y0 - r.top];
    const deformerOk = !this.editor.canvasLock.deformers;
    if (selected?.kind === 'rotation' && deformerOk && !this.editor.isLocked(selected.uid)) {
      const hs = this.rotationHandles(selected.uid);
      if (hs) {
        const near = (p: [number, number], reach = 7) => Math.hypot(p[0] - lx, p[1] - ly) <= reach;
        if (near(hs[2])) return this.startRotationDrag(selected, 'scale', base, ctrl);
        if (near(hs[1])) {
          if (e.altKey) {
            // Alt+drag lengthens only the handle's display.
            const move = (m: PointerEvent) => {
              const [mx, my] = this.unflip(m.clientX, m.clientY);
              this.handleLength = Math.max(
                20,
                Math.hypot(mx - r.left - hs[0][0], my - r.top - hs[0][1]),
              );
              this.drawOverlay();
            };
            const up = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
            return true;
          }
          if (this.editor.level >= 2 && this.recorder?.recordActive())
            return this.startRecordDrag(selected, base, hs[0]);
          return this.startRotationDrag(selected, 'angle', base, ctrl);
        }
      }
    }
    if (
      selected?.kind === 'warp' &&
      deformerOk &&
      this.bezierShown(selected) &&
      !this.editor.isLocked(selected.uid)
    ) {
      const i = nearest(this.bezierScreen(selected), this.overlay, base.x0, base.y0);
      if (i >= 0) return this.startBezierDrag(selected, i, base, ctrl);
    }
    if (
      (selected?.kind === 'warp' || selected?.kind === 'rotation') &&
      deformerOk &&
      this.pointsShown &&
      !this.editor.isLocked(selected.uid)
    ) {
      const i = nearest(this.deformerHandles(selected.uid), this.overlay, base.x0, base.y0);
      if (i >= 0) return this.startPoints(selected, [i], 'move', base, ctrl);
    }
    const box = this.boxFor();
    if (box) {
      const grab = this.boxGrab(box, lx, ly);
      const target = this.editor.view.get(box.target) as Editable;
      // A press right on a vertex inside the box drags the vertex (levels 1 and 2).
      const onVertex =
        target.kind === 'artMesh' &&
        this.pointsShown &&
        this.vertexAt(target.uid, base.x0, base.y0) >= 0;
      if (grab && !(grab.kind === 'move' && onVertex)) {
        if (target.kind !== 'artMesh' && !deformerOk) return false;
        return this.startPoints(target, box.points, 'box', base, ctrl, { ...box, grab });
      }
    }
    const mesh = this.editor.selectedMesh();
    const v = mesh && this.pointsShown ? this.vertexAt(mesh.uid, base.x0, base.y0) : -1;
    if (mesh && v >= 0) {
      let sel = this.editor.selection.vertices;
      if (e.shiftKey) {
        sel = sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v];
        this.editor.select(mesh.uid, sel);
        return true;
      }
      if (!sel.includes(v)) sel = [v];
      this.editor.select(mesh.uid, sel);
      return this.startPoints(mesh, sel, this.editor.meshEdit ? 'base' : 'move', base, false);
    }
    return false;
  }

  /** Selects what lies inside a marquee or lasso: vertices of the selected mesh, else objects. */
  private selectInside(inside: (p: [number, number]) => boolean, additive: boolean): void {
    const mesh = this.editor.selectedMesh();
    if (mesh && this.pointsShown) {
      const hit = (this.meshScreen(mesh.uid) ?? [])
        .map((p, i) => [p, i] as const)
        .filter(([p]) => inside(p))
        .map(([, i]) => i);
      if (hit.length || this.editor.meshEdit) {
        this.editor.select(mesh.uid, additive ? [...this.editor.selection.vertices, ...hit] : hit);
        return;
      }
    }
    if (this.editor.meshEdit || this.editor.canvasLock.drawables) return;
    const uids = [...this.meshIndex.keys()].filter(
      (u) =>
        !this.editor.isLocked(u) &&
        !this.editor.isHidden(u) &&
        (this.meshScreen(u) ?? []).some((p) => inside(p)),
    );
    this.editor.selectMany(additive ? [...this.editor.selection.uids, ...uids] : uids);
  }

  /** The vertex of a mesh within reach of a point, or -1. */
  vertexAt(uid: Uid, clientX: number, clientY: number): number {
    return nearest(this.meshScreen(uid), this.overlay, clientX, clientY);
  }

  /** Whether vertices of this mesh can be moved here, and the keyform cell at the pose. */
  editableCell(mesh: ArtMesh): Record<Uid, number> | null {
    const at = this.editor.cellAtPose(mesh.uid);
    if (!at.ok) {
      this.editor.emit('message', { level: 'error', text: at.reason });
      return null;
    }
    return at.cell;
  }

  /**
   * The canvas-space editing state of some points of an object, at the keyform cell of the pose:
   * the keyform's stored values, and where the points are on the canvas now. Reports and returns
   * null when the pose is between keys or the preview is not ready.
   */
  private pointSpace(
    o: Editable,
    points: number[],
  ): { cell: Record<Uid, number>; index: number; space: PointsEdit['space'] } | null {
    const at = this.editor.cellAtPose(o.uid);
    if (!at.ok) {
      this.editor.emit('message', { level: 'error', text: at.reason });
      return null;
    }
    const k = o.rig.keyforms[at.index]!;
    const all =
      o.kind === 'artMesh'
        ? Float64Array.from((k as ArtMesh['rig']['keyforms'][number]).positions)
        : o.kind === 'warp'
          ? Float64Array.from((k as Warp['rig']['keyforms'][number]).grid)
          : Float64Array.of(
              (k as Rotation['rig']['keyforms'][number]).originX,
              (k as Rotation['rig']['keyforms'][number]).originY,
            );
    const local0 = Float64Array.from(points.flatMap((p) => [all[2 * p]!, all[2 * p + 1]!]));
    const parent = o.kind === 'artMesh' ? o.deformer : o.parent;
    let canvas0 = local0;
    if (parent !== null) {
      const f = this.forwardMap(parent);
      if (!f) {
        this.editor.emit('message', { level: 'error', text: 'The preview is not ready yet.' });
        return null;
      }
      canvas0 = Float64Array.from(f(local0).points);
    }
    return {
      cell: at.cell,
      index: at.index,
      space: { parent, all, canvas0, now: Float64Array.from(local0) },
    };
  }

  /**
   * Sets the points' local values for canvas targets: through the inverse of the parent's
   * forward map, from their current values. False (and the values are kept) when the parent
   * cannot bring them there, where it folds.
   */
  private resolveTargets(s: PointsEdit['space'], targets: Float64Array): boolean {
    if (s.parent === null) {
      s.now = targets;
      return true;
    }
    const f = this.forwardMap(s.parent);
    if (!f) return false;
    const r = invertMap(f, targets, s.now, { tolerance: 1e-3 });
    if (!(r.maxError < 0.5)) return false;
    s.now = r.points;
    return true;
  }

  private resolvePoints(s: PointsEdit['space'], off: readonly [number, number]): boolean {
    return this.resolveTargets(
      s,
      s.canvas0.map((v, i) => v + off[i % 2]!),
    );
  }

  /** Starts a drag of points (vertices, grid points, an origin, or the transform box). */
  // ---------------------------------------------------------------- the snapshot

  /**
   * The snapshot (Ctrl+5): a translucent copy of the pose when it was taken, for
   * comparison. One at a time; view state. It is pinned to the model, so it follows pan, zoom and
   * rotation and stays put while parameters move: the model points under three corners of the
   * canvas at the time are kept, and the image is drawn through them.
   */
  snapshot: {
    png: Uint8Array;
    image: ImageBitmap;
    width: number;
    height: number;
    /** Model points (units, y up) under the canvas's top-left, top-right and bottom-left corners. */
    corners: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  } | null = null;
  snapshotShown = true;
  /** How opaque the snapshot is drawn. */
  snapshotOpacity = 0.4;

  // ---------------------------------------------------------------- brushes

  /** The brush: radius in screen pixels; B, C and V + drag set size, angle and hardness. */
  brush = { radius: 30, hardness: 0.5, angle: 0, roundness: 1 };
  /**
   * Applying a model template: the template's layer images, drawn over the art where the
   * layout puts them (canvas pixels), at `alpha`; and the dialog's handler for dragging the layout
   * on the canvas (left: move, right: scale). Null when no template is being laid out.
   */
  templateGuide: {
    images: { image: ImageBitmap; x: number; y: number; width: number; height: number }[];
    layout: { scale: number; x: number; y: number };
    alpha: number;
  } | null = null;
  layoutEdit:
    ((e: { kind: 'down' | 'move' | 'up'; button: number; at: [number, number] }) => void) | null =
    null;

  private drawTemplateGuide(g: CanvasRenderingContext2D): void {
    const t = this.templateGuide;
    if (!t) return;
    g.save();
    g.globalAlpha = t.alpha;
    for (const im of t.images) {
      const l = t.layout;
      const a = this.canvasToLocal(im.x * l.scale + l.x, im.y * l.scale + l.y);
      const b = this.canvasToLocal((im.x + im.width) * l.scale + l.x, im.y * l.scale + l.y);
      const c = this.canvasToLocal(im.x * l.scale + l.x, (im.y + im.height) * l.scale + l.y);
      // The affine map that puts the image's corners there (the view may be rotated or flipped).
      g.setTransform(
        ((b[0] - a[0]) / im.width) * (window.devicePixelRatio || 1),
        ((b[1] - a[1]) / im.width) * (window.devicePixelRatio || 1),
        ((c[0] - a[0]) / im.height) * (window.devicePixelRatio || 1),
        ((c[1] - a[1]) / im.height) * (window.devicePixelRatio || 1),
        a[0] * (window.devicePixelRatio || 1),
        a[1] * (window.devicePixelRatio || 1),
      );
      g.drawImage(im.image, 0, 0);
    }
    g.restore();
  }

  private layoutDragging = false;
  /** Where the brush cursor is (viewport CSS pixels). */
  private brushAt: [number, number] | null = null;
  /** Strokes drawn for stroke-based meshing (canvas pixels), until Shift+E confirms them. */
  strokes: [number, number][][] = [];
  /** Mirrored editing in mesh editing, about the vertical line at canvas x `mirrorAxis`. */
  mirrorEdit = false;
  /** Null: the canvas's origin (the model's center line). */
  mirrorAxis: number | null = null;

  get brushTool(): boolean {
    return BRUSH_TOOLS.includes(this.tool);
  }

  private brushWeightAt(p: [number, number], at: [number, number]): number {
    return brushWeight(p[0] - at[0], p[1] - at[1], this.brush);
  }

  /** Brush selection: the vertices of the selected mesh under the brush, else the meshes it touches. */
  private paintSelect(at: [number, number], remove: boolean): void {
    const mesh = this.editor.selectedMesh();
    if (mesh && (this.pointsShown || this.editor.meshEdit)) {
      const hit = (this.meshScreen(mesh.uid) ?? [])
        .map((p, i) => [p, i] as const)
        .filter(([p]) => this.brushWeightAt(p, at) >= 0.5)
        .map(([, i]) => i);
      const sel = new Set(this.editor.selection.vertices);
      for (const i of hit)
        if (remove) sel.delete(i);
        else sel.add(i);
      this.editor.select(
        mesh.uid,
        [...sel].sort((a, b) => a - b),
      );
      return;
    }
    if (this.editor.canvasLock.drawables) return;
    const touched = [...this.meshIndex.keys()].filter(
      (u) =>
        !this.editor.isLocked(u) &&
        !this.editor.isHidden(u) &&
        (this.meshScreen(u) ?? []).some((p) => this.brushWeightAt(p, at) >= 0.5),
    );
    const sel = new Set(this.editor.selection.uids);
    for (const u of touched)
      if (remove) sel.delete(u);
      else sel.add(u);
    this.editor.selectMany([...sel]);
  }

  /** The deform brush: a stroke moves the vertices under the brush, by its falloff, one step. */
  private startDeform(
    base: { x0: number; y0: number; x: number; y: number },
    at: [number, number],
  ): void {
    const sel = this.editor.selectedMesh();
    const uid = sel?.uid ?? this.meshAt(base.x0, base.y0);
    const mesh = uid ? this.editor.view.get(uid) : undefined;
    if (mesh?.kind !== 'artMesh') {
      this.editor.emit('message', { level: 'error', text: 'Select an ArtMesh to deform.' });
      return;
    }
    const pts = this.meshScreen(mesh.uid);
    if (!pts) return;
    const weights = pts.map((p) => this.brushWeightAt(p, at));
    if (!weights.some((w) => w > 0)) return;
    const points = pts.map((_, i) => i);
    const mode = this.editor.meshEdit ? 'base' : 'move';
    this.startPoints(mesh, points, mode, base, false);
    if (this.drag?.kind === 'points' && this.drag.points)
      this.drag.points.weights = Float64Array.from(weights);
  }

  /** The texture point (layer pixels) under a viewport point, through the mesh as drawn. */
  screenToUv(mesh: ArtMesh, p: [number, number], extrapolate: boolean): [number, number] | null {
    const pts = this.meshScreen(mesh.uid);
    if (!pts || pts.length !== mesh.uv.length / 2) return null;
    let best: { w: [number, number, number]; t: [number, number, number]; m: number } | null = null;
    for (const t of triangles(mesh)) {
      const w = barycentric(p, pts[t[0]]!, pts[t[1]]!, pts[t[2]]!);
      if (!w) continue;
      const m = Math.min(...w);
      if (!best || m > best.m) best = { w: w as [number, number, number], t, m };
    }
    if (!best || (!extrapolate && best.m < -1e-6)) return null;
    const uv = (i: number, k: number) => mesh.uv[2 * i + k]!;
    const [a, b, c] = best.t;
    const w = best.w;
    return [
      w[0] * uv(a, 0) + w[1] * uv(b, 0) + w[2] * uv(c, 0),
      w[0] * uv(a, 1) + w[1] * uv(b, 1) + w[2] * uv(c, 1),
    ];
  }

  /** The add-points brush: a point where the brush passes, a radius from every other vertex. */
  private paintAdd(d: Drag, at: [number, number]): void {
    const mesh = this.editor.selectedMesh();
    if (!mesh) return;
    const others = [...(this.meshScreen(mesh.uid) ?? []), ...(d.paint ?? [])];
    const r = this.brush.radius;
    if (others.every((p) => Math.hypot(p[0] - at[0], p[1] - at[1]) >= r)) {
      if (this.screenToUv(mesh, at, false)) (d.paint ??= []).push(at);
    }
  }

  private commitAddPaint(d: Drag): void {
    const mesh = this.editor.selectedMesh();
    if (!mesh || !d.paint?.length) return;
    const points = d.paint
      .map((p) => this.screenToUv(mesh, p, false))
      .filter((p): p is [number, number] => p !== null);
    if (!points.length) return;
    const res = this.editor.transact('Add vertices (brush)', [
      { name: 'mesh.addVertices', args: { target: mesh.uid, points } },
    ]);
    const added = (res?.results[0] as { vertices?: number[] } | undefined)?.vertices;
    if (added) this.editor.select(mesh.uid, added);
  }

  /** Canvas pixels per viewport CSS pixel, here. */
  private canvasPerScreen(): number {
    const a = this.canvasToLocal(0, 0);
    const b = this.canvasToLocal(100, 0);
    return 100 / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
  }

  /**
   * Shift+E: the strokes drawn over the selected mesh become its mesh (`mesh.fromStrokes`), strips
   * the brush's width wide, in one step. The strokes are cleared.
   */
  confirmStrokes(): boolean {
    const mesh = this.editor.selectedMesh();
    if (!mesh) {
      this.editor.emit('message', {
        level: 'error',
        text: 'Select the ArtMesh to mesh along the strokes.',
      });
      return false;
    }
    if (this.strokes.length === 0) {
      this.editor.emit('message', { level: 'error', text: 'Draw strokes over the layer first.' });
      return false;
    }
    const strokes = this.strokes
      .map((s) =>
        s
          .map(([x, y]) => this.screenToUv(mesh, this.canvasToLocal(x, y), true))
          .filter((p): p is [number, number] => p !== null),
      )
      .filter((s) => s.length >= 2);
    const width = 2 * this.brush.radius * this.canvasPerScreen();
    const res = this.editor.transact('Mesh from strokes', [
      { name: 'mesh.fromStrokes', args: { target: mesh.uid, strokes, width } },
    ]);
    if (res) this.strokes = [];
    this.drawOverlay();
    return !!res;
  }

  clearStrokes(): void {
    this.strokes = [];
    this.drawOverlay();
  }

  /**
   * Mirrored editing: the mirror partners of some vertices of a mesh, about the axis (a vertex at
   * the mirrored place, within 2 canvas pixels or 1 % of the mesh's size). Partners move with x
   * the other way.
   */
  private mirrorPartners(mesh: ArtMesh, points: number[]): { points: number[]; signs: Int8Array } {
    const c = this.evaluatedCanvas(mesh.uid);
    if (!c) return { points, signs: new Int8Array(points.length).fill(1) };
    const axis = this.mirrorAxis ?? this.editor.view.project().canvas.originX;
    let [x0, x1] = [Infinity, -Infinity];
    for (let i = 0; i < c.length; i += 2) [x0, x1] = [Math.min(x0, c[i]!), Math.max(x1, c[i]!)];
    const tol = Math.max(2, (x1 - x0) * 0.01);
    const out = [...points];
    const signs = points.map(() => 1);
    const taken = new Set(points);
    for (const i of points) {
      const [mx, my] = [2 * axis - c[2 * i]!, c[2 * i + 1]!];
      let best = -1;
      let dist = tol;
      for (let j = 0; j < c.length / 2; j++) {
        const dd = Math.hypot(c[2 * j]! - mx, c[2 * j + 1]! - my);
        if (dd <= dist) [best, dist] = [j, dd];
      }
      if (best >= 0 && !taken.has(best)) {
        taken.add(best);
        out.push(best);
        signs.push(-1);
      }
    }
    return { points: out, signs: Int8Array.from(signs) };
  }

  /** A viewport point mirrored about the mirror axis (for adding vertices in pairs). */
  private mirroredClient(clientX: number, clientY: number): [number, number] | null {
    const cp = this.clientToCanvas(clientX, clientY);
    if (!cp) return null;
    const axis = this.mirrorAxis ?? this.editor.view.project().canvas.originX;
    const r = this.overlay.getBoundingClientRect();
    const l = this.canvasToLocal(2 * axis - cp[0], cp[1]);
    return [l[0] + r.left, l[1] + r.top];
  }

  private drawBrush(g: CanvasRenderingContext2D): void {
    if (this.strokes.length || this.drag?.kind === 'stroke') {
      g.strokeStyle = 'rgba(244, 201, 93, 0.9)';
      g.lineWidth = Math.max(1, (2 * this.brush.radius) / 6);
      g.lineCap = 'round';
      const all = [
        ...this.strokes,
        ...(this.drag?.kind === 'stroke' ? [this.drag.paint ?? []] : []),
      ];
      for (const s of all) {
        g.beginPath();
        s.forEach(([x, y], i) => {
          const [lx, ly] = this.canvasToLocal(x, y);
          if (i) g.lineTo(lx, ly);
          else g.moveTo(lx, ly);
        });
        g.stroke();
      }
      g.lineWidth = 1;
    }
    if (this.mirrorEdit && this.editor.meshEdit) {
      const c = this.editor.view.project().canvas;
      const axis = this.mirrorAxis ?? c.originX;
      const [a, b] = [this.canvasToLocal(axis, -c.height), this.canvasToLocal(axis, 2 * c.height)];
      g.strokeStyle = 'rgba(199, 146, 234, 0.9)';
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
      g.setLineDash([]);
    }
    if (this.drag?.kind === 'addPaint')
      for (const [x, y] of this.drag.paint ?? []) {
        g.fillStyle = '#7bd88f';
        g.fillRect(x - 3, y - 3, 6, 6);
      }
    const at = this.brushAt;
    if (!this.brushTool || !at) return;
    const b = this.brush;
    const ang = (b.angle * Math.PI) / 180;
    g.strokeStyle = 'rgba(70, 200, 255, 0.95)';
    g.beginPath();
    g.ellipse(at[0], at[1], b.radius, b.radius * b.roundness, ang, 0, Math.PI * 2);
    g.stroke();
    if (b.hardness > 0 && b.hardness < 1) {
      g.setLineDash([3, 3]);
      g.beginPath();
      g.ellipse(
        at[0],
        at[1],
        b.radius * b.hardness,
        b.radius * b.hardness * b.roundness,
        ang,
        0,
        Math.PI * 2,
      );
      g.stroke();
      g.setLineDash([]);
    }
  }

  async takeSnapshot(): Promise<boolean> {
    if (!this.view.model) return false;
    const blob = await this.view.screenshot();
    const png = new Uint8Array(await blob.arrayBuffer());
    const image = await createImageBitmap(blob);
    const r = this.canvas.getBoundingClientRect();
    const at = (x: number, y: number) => this.view.toModel(x, y);
    const [tl, tr, bl] = [at(r.left, r.top), at(r.right, r.top), at(r.left, r.bottom)];
    if (!tl || !tr || !bl) return false;
    this.snapshot?.image.close();
    this.snapshot = { png, image, width: image.width, height: image.height, corners: [tl, tr, bl] };
    this.snapshotShown = true;
    this.drawOverlay();
    this.editor.emit('viewState', undefined);
    return true;
  }

  setSnapshotShown(on: boolean): void {
    this.snapshotShown = on;
    this.drawOverlay();
    this.editor.emit('viewState', undefined);
  }

  clearSnapshot(): void {
    this.snapshot?.image.close();
    this.snapshot = null;
    this.drawOverlay();
    this.editor.emit('viewState', undefined);
  }

  /** The snapshot's corners now, in overlay CSS pixels: top-left, top-right, bottom-left. */
  snapshotScreen(): [number, number][] | null {
    const s = this.snapshot;
    if (!s) return null;
    const r = this.overlay.getBoundingClientRect();
    const out: [number, number][] = [];
    for (const c of s.corners) {
      const p = this.view.toPage(c.x, c.y);
      if (!p) return null;
      out.push([p.x - r.left, p.y - r.top]);
    }
    return out;
  }

  private drawSnapshot(g: CanvasRenderingContext2D): void {
    const s = this.snapshot;
    if (!s || !this.snapshotShown) return;
    const c = this.snapshotScreen();
    if (!c) return;
    const [tl, tr, bl] = c as [[number, number], [number, number], [number, number]];
    g.save();
    g.globalAlpha = this.snapshotOpacity;
    g.transform(
      (tr[0] - tl[0]) / s.width,
      (tr[1] - tl[1]) / s.width,
      (bl[0] - tl[0]) / s.height,
      (bl[1] - tl[1]) / s.height,
      tl[0],
      tl[1],
    );
    g.drawImage(s.image, 0, 0);
    g.restore();
  }

  /**
   * The snapshot's quad in canvas pixels (y down): where a guide image of it goes, corner by
   * corner (top-left, top-right, bottom-right, bottom-left).
   */
  snapshotCanvasQuad(): [number, number][] | null {
    const s = this.snapshot;
    if (!s) return null;
    const { pixelsPerUnit: ppu, originX, originY } = this.editor.view.project().canvas;
    const [tl, tr, bl] = s.corners;
    const br = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y };
    return [tl, tr, br, bl].map((p) => [p.x * ppu + originX, -p.y * ppu + originY]);
  }

  // ---------------------------------------------------------------- deform paths

  /**
   * The deform paths, saved in the project (`deformPath.*` commands; never exported), with
   * targets that no longer exist left out. Copies: a drag moves its own.
   */
  get paths(): DeformPath[] {
    const v = this.editor.view;
    return v
      .project()
      .deformPaths.map((p) => ({
        ...p,
        targets: p.targets.filter((t) => v.get(t) !== undefined),
        points: p.points.map(([x, y]) => [x, y] as Pt),
      }))
      .filter((p) => p.targets.length > 0);
  }
  /** The path being drawn, point by point. */
  drawingPath: DeformPath | null = null;
  /** The path last touched (Tool Details deletes it). */
  selectedPath: number | null = null;
  /** How far points follow a new path, in canvas pixels. */
  pathReach = 60;

  /** Paths belong to edit level 2 or 3 (level 1 draws and shows level 2's). */
  pathLevel(): 2 | 3 {
    return this.editor.level === 3 ? 3 : 2;
  }

  /** The selected art meshes and warps that a new path deforms. */
  pathTargets(): Uid[] {
    const v = this.editor.view;
    return this.editor.selection.uids.filter((u) => {
      const o = v.get(u);
      return (o?.kind === 'artMesh' || o?.kind === 'warp') && !this.editor.isLocked(u);
    });
  }

  /** The paths shown now: with the path tool, of this level, over a selected object. */
  visiblePaths(): DeformPath[] {
    if (this.tool !== 'path') return [];
    const sel = new Set(this.editor.selection.uids);
    const level = this.pathLevel();
    // The path being dragged shows where the drag has it.
    const dragged = this.drag?.pathEdit?.path;
    return this.paths
      .filter((p) => p.level === level && p.targets.some((t) => sel.has(t)))
      .map((p) => (dragged?.id === p.id ? dragged : p));
  }

  private pathScreen(p: DeformPath): Pt[] {
    return p.points.map(([x, y]) => this.canvasToLocal(x, y));
  }

  /** A press with the path tool: the next point of the path drawn, or a drag of a path's point. */
  private pressPath(base: { x0: number; y0: number; x: number; y: number }): void {
    const r = this.overlay.getBoundingClientRect();
    const [lx, ly] = [base.x0 - r.left, base.y0 - r.top];
    const at = this.clientToCanvas(base.x0, base.y0);
    if (!at) return;
    const d = this.drawingPath;
    if (d) {
      // A press on the last point finishes the path.
      const last = this.pathScreen(d).at(-1)!;
      if (d.points.length > 1 && Math.hypot(last[0] - lx, last[1] - ly) <= 8) this.finishPath();
      else d.points.push(at);
      this.drawOverlay();
      this.editor.emit('mode', undefined);
      return;
    }
    for (const p of this.visiblePaths()) {
      const i = nearestPathPoint(this.pathScreen(p), lx, ly);
      if (i >= 0) {
        this.selectedPath = p.id;
        this.startPathDrag(p, i, base);
        return;
      }
    }
    const targets = this.pathTargets();
    if (targets.length === 0) {
      this.editor.emit('message', {
        level: 'error',
        text: 'Select the ArtMeshes or warp deformers to deform, then draw the path over them.',
      });
      return;
    }
    this.drawingPath = {
      id: 0,
      targets,
      level: this.pathLevel(),
      points: [at],
      reach: this.pathReach,
    };
    this.drawOverlay();
    this.editor.emit('mode', undefined);
  }

  /** Ends the path being drawn (Enter, a double-click, or a press on its last point). */
  finishPath(): boolean {
    const d = this.drawingPath;
    if (!d) return false;
    this.drawingPath = null;
    const r = this.editor.transact('Draw deform path', [
      {
        name: 'deformPath.create',
        args: { targets: d.targets, level: d.level, points: d.points, reach: d.reach },
      },
    ]);
    if (r) this.selectedPath = (r.results[0] as { id: number }).id;
    this.drawOverlay();
    this.editor.emit('mode', undefined);
    return true;
  }

  cancelPath(): boolean {
    if (!this.drawingPath) return false;
    this.drawingPath = null;
    this.drawOverlay();
    this.editor.emit('mode', undefined);
    return true;
  }

  /** The reach of a saved path, or of new paths. */
  setPathReach(id: number | null, reach: number): void {
    if (id === null) this.pathReach = reach;
    else
      this.editor.transact('Deform path reach', [
        { name: 'deformPath.update', args: { id, reach } },
      ]);
    this.drawOverlay();
  }

  deletePath(id: number): void {
    this.editor.transact('Delete deform path', [{ name: 'deformPath.delete', args: { id } }]);
    if (this.selectedPath === id) this.selectedPath = null;
    this.drawOverlay();
    this.editor.emit('mode', undefined);
  }

  private startPathDrag(
    path: DeformPath,
    index: number,
    base: { x0: number; y0: number; x: number; y: number },
  ): void {
    const recording = this.editor.level >= 2 && !!this.recorder?.recordActive();
    const targets: PathEdit['targets'] = [];
    for (const uid of path.targets) {
      const o = this.editor.view.get(uid);
      if (o?.kind !== 'artMesh' && o?.kind !== 'warp') continue;
      const n =
        (o.kind === 'artMesh'
          ? o.rig.keyforms[0]!.positions.length
          : o.rig.keyforms[0]!.grid.length) / 2;
      const points = Array.from({ length: n }, (_, i) => i);
      let space: PointsEdit['space'];
      let cell: Record<Uid, number> = {};
      let cellIndex = 0;
      if (recording) {
        // Recording needs only where the points are now.
        const now = this.evaluatedCanvas(uid);
        if (!now) return;
        space = { parent: null, all: now, canvas0: now, now: Float64Array.from(now) };
      } else {
        const ps = this.pointSpace(o, points);
        if (!ps) return;
        ({ space, cell, index: cellIndex } = ps);
      }
      targets.push({
        edit: {
          target: uid,
          mode: 'move',
          cell,
          cellIndex,
          points,
          space,
          screen0: [],
          screenNow: [],
          contentsStay: false,
        },
        binds: bindPoints(path.points, space.canvas0, path.reach),
      });
    }
    this.drag = {
      kind: 'path',
      ...base,
      pathEdit: { path, index, before: path.points.map((p) => [...p] as Pt), targets, recording },
    };
  }

  private dragPath(d: Drag, shift: boolean): void {
    const pe = d.pathEdit!;
    const a = this.clientToCanvas(d.x0, d.y0);
    const b = this.clientToCanvas(d.x, d.y);
    if (!a || !b) return;
    let off: Pt = [b[0] - a[0], b[1] - a[1]];
    if (shift) off = Math.abs(off[0]) >= Math.abs(off[1]) ? [off[0], 0] : [0, off[1]];
    const after = pe.before.map((p, i) =>
      i === pe.index ? ([p[0] + off[0], p[1] + off[1]] as Pt) : p,
    );
    pe.path.points = after;
    if (pe.recording) return;
    const tx = new Tx(new Draft(this.editor.doc));
    for (const t of pe.targets) {
      this.resolveTargets(t.edit.space, skin(pe.before, after, t.edit.space.canvas0, t.binds));
      for (const c of this.pointsCalls(t.edit)) tx.run(c.name, c.args);
    }
    this.request(tx.draft.finish().doc, true);
  }

  private commitPath(pe: PathEdit): void {
    const moved = pe.path.points.some(
      (p, i) => p[0] !== pe.before[i]![0] || p[1] !== pe.before[i]![1],
    );
    if (!moved) {
      this.request(this.editor.doc, false);
      return;
    }
    if (pe.recording) {
      this.recordPath(pe);
      return;
    }
    // The keyforms, and the path where the drag left it, in one step.
    const calls = [
      ...pe.targets.flatMap((t) =>
        t.edit.space.now.some((v, i) => v !== t.edit.space.all[i]) ? this.pointsCalls(t.edit) : [],
      ),
      { name: 'deformPath.update', args: { id: pe.path.id, points: pe.path.points } },
    ];
    const res = this.editor.transact('Deform path', calls);
    if (!res) {
      pe.path.points = pe.before;
      this.request(this.editor.doc, false);
    }
  }

  /** Each target's points in canvas pixels as the shown model evaluates them now. */
  private evaluatedCanvas(uid: Uid): Float64Array | null {
    const o = this.editor.view.get(uid);
    const inst = this.view.model?.runtime.instance;
    if (!inst || !o) return null;
    const { pixelsPerUnit: ppu, originX, originY } = this.editor.view.project().canvas;
    if (o.kind === 'artMesh') {
      const i = this.meshIndex.get(uid);
      const v = i === undefined ? undefined : inst.drawableVertices[i];
      if (!v) return null;
      const out = new Float64Array(v.length);
      for (let k = 0; k < v.length; k += 2) {
        out[k] = v[k]! * ppu + originX;
        out[k + 1] = -v[k + 1]! * ppu + originY;
      }
      return out;
    }
    if (o.kind === 'warp') {
      const f = this.forwardMap(uid);
      if (!f) return null;
      const uv: number[] = [];
      for (let r = 0; r <= o.rows; r++)
        for (let c = 0; c <= o.cols; c++) uv.push(c / o.cols, r / o.rows);
      return Float64Array.from(f(Float64Array.from(uv)).points);
    }
    return null;
  }

  /**
   * Recording with a deform path (the animation view, levels 2 and 3): the parameters that move
   * the targets (theirs and their deformers') take the values that bring the targets' points
   * nearest to where the path puts them, and are keyed at the playhead. Coordinate descent: each
   * parameter in turn, sampled over its range and refined, twice over.
   */
  private recordPath(pe: PathEdit): void {
    const model = this.view.model;
    const v = this.editor.view;
    if (!model) return;
    const params = new Set<Uid>();
    const addRig = (uid: Uid | null) => {
      for (let u = uid; u;) {
        const o = v.get(u);
        if (!o || !('rig' in o)) break;
        for (const b of (o.rig as { bindings: { parameter: Uid }[] }).bindings)
          params.add(b.parameter);
        u = o.kind === 'artMesh' ? o.deformer : 'parent' in o ? (o.parent as Uid | null) : null;
      }
    };
    for (const t of pe.targets) addRig(t.edit.target);
    if (params.size === 0) {
      this.editor.emit('message', {
        level: 'warning',
        text: 'The path’s objects are bound to no parameter, so dragging the path records nothing.',
      });
      pe.path.points = pe.before;
      this.drawOverlay();
      return;
    }
    const wanted = pe.targets.map((t) =>
      skin(pe.before, pe.path.points, t.edit.space.canvas0, t.binds),
    );
    const values = new Map([...params].map((p) => [p, this.editor.value(p)]));
    const id = (p: Uid) => v.getAs(p, 'parameter').exportId;
    const error = (): number => {
      for (const [p, x] of values) model.setParameter(id(p), x);
      model.runtime.update(0);
      let e = 0;
      pe.targets.forEach((t, k) => {
        const now = this.evaluatedCanvas(t.edit.target);
        if (!now) return;
        for (let i = 0; i < now.length; i++) e += (now[i]! - wanted[k]![i]!) ** 2;
      });
      return e;
    };
    for (let sweep = 0; sweep < 2; sweep++)
      for (const p of params) {
        const { min, max } = v.getAs(p, 'parameter');
        const best = { x: values.get(p)!, e: error() };
        const steps = 16;
        for (let s = 0; s <= steps; s++) {
          values.set(p, min + ((max - min) * s) / steps);
          const e = error();
          if (e < best.e) Object.assign(best, { x: values.get(p)!, e });
        }
        let [lo, hi] = [
          Math.max(min, best.x - (max - min) / steps),
          Math.min(max, best.x + (max - min) / steps),
        ];
        for (let it = 0; it < 24; it++) {
          const m1 = lo + (hi - lo) / 3;
          const m2 = hi - (hi - lo) / 3;
          values.set(p, m1);
          const e1 = error();
          values.set(p, m2);
          const e2 = error();
          if (e1 < e2) hi = m2;
          else lo = m1;
        }
        values.set(p, (lo + hi) / 2);
        if (error() > best.e) values.set(p, best.x);
      }
    const changed = new Map<Uid, number>();
    for (const [p, x] of values) if (Math.abs(x - this.editor.value(p)) > 1e-6) changed.set(p, x);
    for (const [p, x] of changed) this.editor.setPoseRaw(p, x);
    this.applyPose();
    if (changed.size) this.recorder?.recordKeys(changed);
  }

  /** Bézier divisions per warp (view state: the document keeps only the grid). */
  private readonly divisions = new Map<Uid, NetShape>();

  netShape(o: Warp): NetShape {
    const d = this.divisions.get(o.uid) ?? defaultDivisions(o.rows, o.cols);
    return { bu: Math.min(d.bu, o.cols), bv: Math.min(d.bv, o.rows) };
  }

  setDivisions(uid: Uid, shape: NetShape): void {
    this.divisions.set(uid, { bu: Math.max(1, shape.bu), bv: Math.max(1, shape.bv) });
    this.drawOverlay();
    this.editor.emit('mode', undefined);
  }

  /** The Bézier control layer shows on a selected warp at edit level 2. */
  bezierShown(o: Warp): boolean {
    return this.editor.level === 2 && this.editor.meshEdit === null;
  }

  /** The control points on screen, fitted to the grid as shown (or as dragged now). */
  bezierScreen(o: Warp, grid?: [number, number][]): [number, number][] | null {
    const pts = grid ?? this.deformerHandles(o.uid);
    if (!pts) return null;
    const net = fitNet(pts.flat(), o.rows, o.cols, this.netShape(o));
    const out: [number, number][] = [];
    for (let i = 0; i < net.length; i += 2) out.push([net[i]!, net[i + 1]!]);
    return out;
  }

  /**
   * Drags a Bézier control point: every grid point of the keyform moves by the surface of the
   * move (`netWeights`), so the grid's own detail stays. An anchor takes its handles along.
   */
  private startBezierDrag(
    o: Warp,
    control: number,
    base: { x0: number; y0: number; x: number; y: number },
    ctrl: boolean,
  ): boolean {
    const shape = this.netShape(o);
    const moved =
      controlRole(shape, control).kind === 'anchor'
        ? [control, ...anchorHandles(shape, control)]
        : [control];
    const all = Array.from({ length: (o.rows + 1) * (o.cols + 1) }, (_, i) => i);
    const ok = this.startPoints(o, all, 'move', base, ctrl);
    if (this.drag?.points?.target === o.uid) {
      this.drag.points.weights = netWeights(shape, o.rows, o.cols, moved);
      this.drag.points.control = control;
    }
    return ok;
  }

  private startPoints(
    o: Editable,
    points: number[],
    mode: 'move' | 'box' | 'base',
    base: { x0: number; y0: number; x: number; y: number },
    ctrl: boolean,
    box?: PointsEdit['box'],
  ): boolean {
    if (o.kind === 'artMesh' && this.editor.isLocked(o.uid)) return false;
    // Mirrored editing (mesh editing): the vertices' mirror partners move too, x the other way.
    let mirror: Int8Array | undefined;
    if (this.mirrorEdit && mode === 'base' && o.kind === 'artMesh') {
      const m = this.mirrorPartners(o, points);
      points = m.points;
      mirror = m.signs;
    }
    const ps = this.pointSpace(o, points);
    if (!ps) return true;
    const c0 = ps.space.canvas0;
    const screen = points.map((_, j) => this.canvasToLocal(c0[2 * j]!, c0[2 * j + 1]!));
    this.drag = {
      kind: 'points',
      ...base,
      points: {
        target: o.uid,
        mode,
        cell: ps.cell,
        cellIndex: ps.index,
        points,
        space: ps.space,
        screen0: screen,
        screenNow: screen.map((p) => [...p] as [number, number]),
        box,
        contentsStay: ctrl && (o.kind === 'warp' || o.kind === 'rotation'),
        keep: ctrl ? this.contentsOf(o) : undefined,
        mirror,
      },
    };
    return true;
  }

  /**
   * Recording: turning a rotation deformer's handle poses the parameters bound to it so that its
   * angle follows the pointer (`solveField`: one parameter, the one that needs the least change),
   * and keys that parameter at the playhead on release. Shift snaps the angle to the rotation
   * step. A rotation with no bindings has nothing to record, and says so.
   */
  private startRecordDrag(
    o: Rotation,
    base: { x0: number; y0: number; x: number; y: number },
    origin: [number, number],
  ): boolean {
    const v = this.editor.view;
    if (o.rig.bindings.length === 0) {
      this.editor.emit('message', {
        level: 'warning',
        text: `${o.exportId} is bound to no parameter, so turning it records nothing. Bind it in the Modeling workspace.`,
      });
      return true;
    }
    const r = this.overlay.getBoundingClientRect();
    const start = new Map(o.rig.bindings.map((b) => [b.parameter, this.editor.value(b.parameter)]));
    const values = (p: Uid) => start.get(p) ?? this.editor.value(p);
    const angle0 = fieldAt(o.rig, 'angle', values);
    const a0 = Math.atan2(base.y0 - r.top - origin[1], base.x0 - r.left - origin[0]);
    const range = (p: Uid) => v.getAs(p, 'parameter');
    let changed: { parameter: Uid; value: number } | null = null;
    const move = (m: PointerEvent) => {
      const [mx, my] = this.unflip(m.clientX, m.clientY);
      let da = ((Math.atan2(my - r.top - origin[1], mx - r.left - origin[0]) - a0) * 180) / Math.PI;
      da = ((da + 540) % 360) - 180;
      let target = angle0 + (this.flipped ? -da : da);
      if (m.shiftKey) {
        const step = this.settings.value.rotationStep || 45;
        target = Math.round(target / step) * step;
      }
      const sol = solveField(o.rig, 'angle', values, target, range);
      if (!sol) return;
      // Only one parameter moves: put back any other one an earlier frame chose.
      if (changed && changed.parameter !== sol.parameter)
        this.editor.setPoseRaw(changed.parameter, start.get(changed.parameter)!);
      changed = sol;
      this.editor.setPoseRaw(sol.parameter, sol.value);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const c = changed as { parameter: Uid; value: number } | null;
      if (c && Math.abs(c.value - start.get(c.parameter)!) > 1e-9)
        this.recorder?.recordKeys(new Map([[c.parameter, this.editor.value(c.parameter)]]));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return true;
  }

  /** Starts turning or scaling a rotation deformer with its handles. */
  private startRotationDrag(
    o: Rotation,
    mode: 'angle' | 'scale',
    base: { x0: number; y0: number; x: number; y: number },
    ctrl: boolean,
  ): boolean {
    const ps = this.pointSpace(o, [0]);
    if (!ps) return true;
    const k = o.rig.keyforms[ps.index]!;
    const hs = this.rotationHandles(o.uid)!;
    const r = this.overlay.getBoundingClientRect();
    const [lx, ly] = [base.x0 - r.left, base.y0 - r.top];
    this.drag = {
      kind: 'points',
      ...base,
      points: {
        target: o.uid,
        mode,
        cell: ps.cell,
        cellIndex: ps.index,
        points: [0],
        space: ps.space,
        screen0: [hs[0]],
        screenNow: [hs[0]],
        rot: {
          angle: k.angle,
          scale: k.scale,
          origin: hs[0],
          a0: Math.atan2(ly - hs[0][1], lx - hs[0][0]),
          r0: Math.hypot(lx - hs[0][0], ly - hs[0][1]),
        },
        contentsStay: ctrl,
        keep: ctrl ? this.contentsOf(o) : undefined,
      },
    };
    return true;
  }

  /** The canvas targets of a points drag for the pointer now, with its modifiers. */
  private targetsFor(
    d: Drag,
    p: PointsEdit,
    e: { shiftKey: boolean; altKey: boolean },
  ): Float64Array {
    const a = this.clientToCanvas(d.x0, d.y0);
    const b = this.clientToCanvas(d.x, d.y);
    if (!a || !b) return p.space.canvas0;
    let off: [number, number] = [b[0] - a[0], b[1] - a[1]];
    const c0 = p.space.canvas0;
    if (p.mode !== 'box' || p.box?.grab.kind === 'move') {
      // Shift on a single point keeps the move horizontal or vertical.
      if (e.shiftKey && (p.points.length === 1 || p.weights))
        off = Math.abs(off[0]) >= Math.abs(off[1]) ? [off[0], 0] : [0, off[1]];
      const w = p.weights;
      const m = p.mirror;
      return c0.map(
        (v, i) => v + off[i % 2]! * (w ? w[i >> 1]! : 1) * (m && i % 2 === 0 ? m[i >> 1]! : 1),
      );
    }
    const box = p.box!;
    // The box's corners and center in canvas pixels.
    const corners = boxCorners(box).map(([x, y]) => {
      const rr = this.overlay.getBoundingClientRect();
      return this.clientToCanvas(rr.left + x, rr.top + y)!;
    });
    const center: [number, number] = [
      (corners[0]![0] + corners[2]![0]) / 2,
      (corners[0]![1] + corners[2]![1]) / 2,
    ];
    if (box.grab.kind === 'rotate') {
      const ang =
        Math.atan2(b[1] - center[1], b[0] - center[0]) -
        Math.atan2(a[1] - center[1], a[0] - center[0]);
      const t = e.shiftKey ? (Math.round((ang * 180) / Math.PI / 15) * 15 * Math.PI) / 180 : ang;
      p.values = { turned: (t * 180) / Math.PI };
      const [cs, sn] = [Math.cos(t), Math.sin(t)];
      const out = new Float64Array(c0.length);
      for (let i = 0; i < c0.length; i += 2) {
        const [x, y] = [c0[i]! - center[0], c0[i + 1]! - center[1]];
        out[i] = center[0] + cs * x - sn * y;
        out[i + 1] = center[1] + sn * x + cs * y;
      }
      return out;
    }
    // Scale: about the opposite corner, or about the center with Alt; Shift keeps proportions.
    const k = (box.grab as { corner: 0 | 1 | 2 | 3 }).corner;
    const pivot = e.altKey ? center : corners[(k + 2) % 4]!;
    const grabbed = corners[k]!;
    const moved: [number, number] = [grabbed[0] + off[0], grabbed[1] + off[1]];
    let sx = (moved[0] - pivot[0]) / (grabbed[0] - pivot[0] || 1);
    let sy = (moved[1] - pivot[1]) / (grabbed[1] - pivot[1] || 1);
    if (e.shiftKey) sx = sy = Math.abs(sx) > Math.abs(sy) ? sx : sy;
    const out = new Float64Array(c0.length);
    for (let i = 0; i < c0.length; i += 2) {
      out[i] = pivot[0] + (c0[i]! - pivot[0]) * sx;
      out[i + 1] = pivot[1] + (c0[i + 1]! - pivot[1]) * sy;
    }
    return out;
  }

  /**
   * One drag frame. Mesh vertex moves patch the shown model in place and evaluate at once
   * (Mochi2D 0.6.0); the positions come from the same command applied to a draft, converted as the
   * lowering converts them, and a test checks that this equals a rebuild. Other drags (deformer
   * handles, the base mesh, contents kept in place) preview a draft through a preview build.
   */
  private dragTo(d: Drag, e: { shiftKey: boolean; altKey: boolean }): void {
    const t0 = performance.now();
    const p = d.points!;
    const o = this.editor.view.get(p.target) as Editable;
    if (p.mode === 'angle' || p.mode === 'scale') {
      const r = this.overlay.getBoundingClientRect();
      const [lx, ly] = [d.x - r.left, d.y - r.top];
      const rot = p.rot!;
      if (p.mode === 'angle') {
        let da = ((Math.atan2(ly - rot.origin[1], lx - rot.origin[0]) - rot.a0) * 180) / Math.PI;
        da = ((da + 540) % 360) - 180;
        // A turn on screen (y down, clockwise positive) is the same turn of the keyform angle.
        let angle = rot.angle + (this.flipped ? -da : da);
        if (e.shiftKey) {
          const step = this.settings.value.rotationStep || 45;
          angle = Math.round(angle / step) * step;
        }
        p.values = { angle };
      } else {
        const ratio = Math.hypot(lx - rot.origin[0], ly - rot.origin[1]) / (rot.r0 || 1);
        p.values = { scale: Math.max(1e-3, rot.scale * ratio) };
      }
      this.request(this.provisional(p), true);
      return;
    }
    const targets = this.targetsFor(d, p, e);
    // A target the parent cannot reach (it folds there) keeps the last good position.
    this.resolveTargets(p.space, targets);
    const canvasNow =
      p.space.parent === null
        ? p.space.now
        : (this.forwardMap(p.space.parent)?.(p.space.now).points ?? targets);
    p.screenNow = p.points.map((_, i) =>
      this.canvasToLocal(canvasNow[2 * i]!, canvasNow[2 * i + 1]!),
    );
    const draft = this.provisional(p);
    if (o.kind !== 'artMesh' || p.mode === 'base') {
      this.request(draft, true);
      return;
    }
    const patch = this.positionPatch(this.viewFilter(draft), o.uid, p.cellIndex);
    const model = this.view.model;
    if (!patch || !model || !this.shownData) {
      this.request(draft, true);
      return;
    }
    model.patch(patch);
    applyDataPatches(this.shownData.data, [patch]);
    model.runtime.update(0);
    this.dragFrames.push(performance.now() - t0);
    if (this.dragFrames.length > 500) this.dragFrames.shift();
  }

  /** The calls a points edit records: the resolved local values (never canvas positions). */
  private pointsCalls(p: PointsEdit): { name: string; args: unknown }[] {
    const o = this.editor.view.get(p.target) as Editable;
    if (p.mode === 'angle' || p.mode === 'scale') {
      const calls = [
        {
          name: 'keyform.set',
          args: {
            target: o.uid,
            ...(o.rig.bindings.length ? { cell: p.cell } : {}),
            values: p.values ?? {},
          },
        },
      ];
      return p.contentsStay ? [...calls, ...this.keepContents(o, calls, p.keep ?? [])] : calls;
    }
    const s = p.space;
    if (p.mode === 'base' && o.kind === 'artMesh') return this.baseCalls(o, p);
    const next = Float64Array.from(s.all);
    p.points.forEach((pt, j) => {
      next[2 * pt] = s.now[2 * j]!;
      next[2 * pt + 1] = s.now[2 * j + 1]!;
    });
    const pairs: [number, number][] = [];
    for (let i = 0; i < next.length; i += 2) pairs.push([next[i]!, next[i + 1]!]);
    const values =
      o.kind === 'artMesh'
        ? { positions: pairs }
        : o.kind === 'warp'
          ? { grid: pairs }
          : { originX: next[0]!, originY: next[1]! };
    const calls = [
      {
        name: 'keyform.set',
        args: { target: o.uid, ...(o.rig.bindings.length ? { cell: p.cell } : {}), values },
      },
    ];
    return p.contentsStay ? [...calls, ...this.keepContents(o, calls, p.keep ?? [])] : calls;
  }

  /**
   * Moving vertices in mesh editing: each vertex moves in every keyform by its offset in the
   * mesh's space, and its texture coordinates follow, so the image stays where it is.
   */
  private baseCalls(m: ArtMesh, p: PointsEdit): { name: string; args: unknown }[] {
    const calls: { name: string; args: unknown }[] = [];
    const s = p.space;
    const pos = s.all;
    p.points.forEach((v, j) => {
      const dl: [number, number] = [
        s.now[2 * j]! - pos[2 * v]!,
        s.now[2 * j + 1]! - pos[2 * v + 1]!,
      ];
      if (dl[0] === 0 && dl[1] === 0) return;
      calls.push({
        name: 'mesh.moveVertices',
        args: { target: m.uid, all: true, vertices: [v], offset: dl },
      });
      // ∂uv/∂position from a triangle at the vertex, in this keyform.
      const tri = triangles(m).find((t) => t.includes(v));
      if (!tri) return;
      const [a, b, c] = tri;
      const P = (i: number) => [pos[2 * i]!, pos[2 * i + 1]!];
      const U = (i: number) => [m.uv[2 * i]!, m.uv[2 * i + 1]!];
      const e1 = [P(b)[0]! - P(a)[0]!, P(b)[1]! - P(a)[1]!];
      const e2 = [P(c)[0]! - P(a)[0]!, P(c)[1]! - P(a)[1]!];
      const f1 = [U(b)[0]! - U(a)[0]!, U(b)[1]! - U(a)[1]!];
      const f2 = [U(c)[0]! - U(a)[0]!, U(c)[1]! - U(a)[1]!];
      const det = e1[0]! * e2[1]! - e2[0]! * e1[1]!;
      if (Math.abs(det) < 1e-12) return;
      // Solve [e1 e2]·w = dl, then du = [f1 f2]·w.
      const w0 = (e2[1]! * dl[0] - e2[0]! * dl[1]) / det;
      const w1 = (-e1[1]! * dl[0] + e1[0]! * dl[1]) / det;
      const du: [number, number] = [f1[0]! * w0 + f2[0]! * w1, f1[1]! * w0 + f2[1]! * w1];
      calls.push({ name: 'mesh.moveUv', args: { target: m.uid, vertices: [v], offset: du } });
    });
    return calls;
  }

  /**
   * The direct contents of a deformer at the pose, and where they are on the canvas now: taken
   * when a Ctrl-drag starts, so they can stay there. Children between keys are left out, and a
   * message says so.
   */
  private contentsOf(d: Editable): Keep[] {
    if (d.kind === 'artMesh') return [];
    const before = this.forwardMap(d.uid);
    if (!before) return [];
    const v = this.editor.view;
    const out: Keep[] = [];
    const skipped: string[] = [];
    const children: Editable[] = [
      ...v.ofKind('artMesh').filter((m) => m.deformer === d.uid),
      ...v.ofKind(['warp', 'rotation']).filter((c) => c.parent === d.uid),
    ];
    for (const c of children) {
      const at = this.editor.cellAtPose(c.uid);
      if (!at.ok) {
        skipped.push(c.exportId);
        continue;
      }
      const k = c.rig.keyforms[at.index]! as unknown as Record<string, unknown>;
      const local =
        c.kind === 'artMesh'
          ? Float64Array.from(k.positions as number[])
          : c.kind === 'warp'
            ? Float64Array.from(k.grid as number[])
            : Float64Array.of(k.originX as number, k.originY as number);
      out.push({ c, cell: at.cell, local, canvas: Float64Array.from(before(local).points) });
    }
    if (skipped.length)
      this.editor.emit('message', {
        level: 'warning',
        text: `${skipped.join(', ')} will move: their parameters are between keys.`,
      });
    return out;
  }

  /**
   * Ctrl while changing a deformer: its direct contents keep their place on
   * the canvas at this pose. Each child's keyform at its own cell of the pose is converted into
   * the deformer as it will be, from where it was when the drag started.
   */
  private keepContents(
    d: Editable,
    calls: { name: string; args: unknown }[],
    keep: Keep[],
  ): { name: string; args: unknown }[] {
    if (d.kind === 'artMesh' || keep.length === 0) return [];
    const tx = new Tx(new Draft(this.editor.doc));
    for (const c of calls) tx.run(c.name, c.args);
    const after = tx.draft.finish().doc;
    const pose: Record<Uid, number> = {};
    for (const [u, v] of this.editor.pose) pose[u] = v;
    const mapper = new DeformerMapper(new DocView(after), pose);
    return keep.map(({ c, cell, local, canvas }) => {
      const r = mapper.toLocal(d.uid, canvas, local);
      const pairs: [number, number][] = [];
      for (let i = 0; i < r.points.length; i += 2) pairs.push([r.points[i]!, r.points[i + 1]!]);
      const values =
        c.kind === 'artMesh'
          ? { positions: pairs }
          : c.kind === 'warp'
            ? { grid: pairs }
            : { originX: r.points[0]!, originY: r.points[1]! };
      return {
        name: 'keyform.set',
        args: { target: c.uid, ...(c.rig.bindings.length ? { cell } : {}), values },
      };
    });
  }

  /** The document as a points edit has it now. */
  private provisional(p: PointsEdit): Document {
    const tx = new Tx(new Draft(this.editor.doc));
    for (const c of this.pointsCalls(p)) tx.run(c.name, c.args);
    return tx.draft.finish().doc;
  }

  private commitPoints(p: PointsEdit): void {
    const o = this.editor.view.get(p.target) as Editable | undefined;
    const changed =
      p.mode === 'angle' || p.mode === 'scale'
        ? p.values !== undefined
        : p.space.now.some((v, i) => v !== p.space.all[2 * p.points[i >> 1]! + (i & 1)]);
    if (!o || !changed) {
      this.request(this.editor.doc, false);
      return;
    }
    const label =
      p.weights && this.tool === 'deform'
        ? 'Deform brush'
        : p.mode === 'angle'
          ? 'Rotate'
          : p.mode === 'scale'
            ? 'Scale'
            : p.mode === 'box'
              ? 'Transform'
              : o.kind === 'artMesh'
                ? 'Move vertices'
                : o.kind === 'warp'
                  ? 'Move grid points'
                  : 'Move origin';
    // A plain translation of a mesh on the canvas records the offset, as a person reads it.
    const off =
      p.space.parent === null && o.kind === 'artMesh' && p.mode === 'move' && !p.weights
        ? [p.space.now[0]! - p.space.canvas0[0]!, p.space.now[1]! - p.space.canvas0[1]!]
        : null;
    const calls = off
      ? [
          {
            name: 'mesh.moveVertices',
            args: { target: o.uid, cell: p.cell, vertices: p.points, offset: off },
          },
        ]
      : this.pointsCalls(p);
    const res = this.editor.transact(p.contentsStay ? `${label} (contents stay)` : label, calls);
    if (!res) return;
    if (o.kind !== 'artMesh') {
      if (!p.contentsStay) {
        const v = this.editor.view;
        const hasContents =
          v.ofKind('artMesh').some((m) => m.deformer === o.uid) ||
          v.ofKind(['warp', 'rotation']).some((c) => c.parent === o.uid);
        if (hasContents) this.onContentsMoved(o.uid);
      }
      this.onDeformerEdited(o.uid);
    }
    if (p.mode === 'box' && p.values?.turned !== undefined && Math.abs(p.values.turned) > 30)
      this.editor.emit('message', {
        level: 'warning',
        code: 'tip:turn-by-keyform',
        text: `Turned ${Math.round(Math.abs(p.values.turned))}° by keyform: in-between shapes are straight-line blends, so a turn this large shrinks midway. A rotation deformer turns without shrinking.`,
      });
  }

  /**
   * Moves vertices by a canvas offset (the arrow keys): `mesh.moveVertices` for a mesh on the
   * canvas, and for a mesh inside deformers `keyform.set` with the positions resolved through
   * them, as a drag would.
   */
  nudge(mesh: ArtMesh, vertices: number[], offset: [number, number]): void {
    if (mesh.deformer === null) {
      const cell = this.editableCell(mesh);
      if (!cell) return;
      this.editor.transact('Nudge vertices', [
        { name: 'mesh.moveVertices', args: { target: mesh.uid, cell, vertices, offset } },
      ]);
      return;
    }
    const ps = this.pointSpace(mesh, vertices);
    if (!ps) return;
    if (!this.resolvePoints(ps.space, offset)) {
      this.editor.emit('message', {
        level: 'error',
        text: `${mesh.exportId}'s deformer cannot move these vertices there (it folds there).`,
      });
      return;
    }
    this.editor.transact(
      'Nudge vertices',
      this.pointsCalls({
        target: mesh.uid,
        mode: 'move',
        cell: ps.cell,
        cellIndex: ps.index,
        points: vertices,
        space: ps.space,
        screen0: [],
        screenNow: [],
        contentsStay: false,
      }),
    );
  }

  /** The patch of one mesh keyform's positions in the shown model, or null if it is not shown. */
  positionPatch(doc: Document, mesh: Uid, cellIndex: number): ValuePatch | null {
    const shown = this.shownData;
    const i = this.meshIndex.get(mesh);
    if (!shown || i === undefined) return null;
    const m = new DocView(doc).getAs(mesh, 'artMesh');
    const data = shown.data;
    if (cellIndex >= data.artMeshes.keyformCount[i]!) return null;
    const start = data.artMeshKeyforms.firstPosition[data.artMeshes.firstKeyform[i]! + cellIndex]!;
    const pts = m.rig.keyforms[cellIndex]!.positions;
    const c = new DocView(doc).project().canvas;
    const values = new Array<number>(pts.length);
    for (let k = 0; k < pts.length; k += 2) {
      values[k] = Math.fround(
        m.deformer === null ? (pts[k]! - c.originX) / c.pixelsPerUnit : pts[k]!,
      );
      values[k + 1] = Math.fround(
        m.deformer === null ? (pts[k + 1]! - c.originY) / c.pixelsPerUnit : pts[k + 1]!,
      );
    }
    return { group: 'keyformPositions', start, values };
  }

  /**
   * The drag-to-create rotation deformer: the press sets the pivot and the drag's
   * direction the Standard Angle (the rest direction that reads as zero); no dialog. The selected
   * objects move into it in place.
   */
  private async createRotationByDrag(d: Drag): Promise<void> {
    const a = this.clientToCanvas(d.x0, d.y0);
    const b = this.clientToCanvas(d.x, d.y);
    if (!a || !b) return;
    const v = this.editor.view;
    const sel = this.editor.selection.uids
      .map((u) => v.get(u))
      .filter(
        (o): o is ArtMesh | Warp | Rotation =>
          o?.kind === 'artMesh' || o?.kind === 'warp' || o?.kind === 'rotation',
      );
    const parents = new Set(sel.map((o) => (o.kind === 'artMesh' ? o.deformer : o.parent)));
    const parent = parents.size === 1 ? [...parents][0]! : null;
    let origin = { x: a[0], y: a[1] };
    if (parent !== null) {
      const f = this.forwardMap(parent);
      if (!f) return;
      const r = invertMap(f, Float64Array.of(a[0], a[1]), Float64Array.of(0.5, 0.5), {
        tolerance: 1e-3,
      });
      origin = { x: r.points[0]!, y: r.points[1]! };
    }
    // Up on the canvas reads 0°; turning toward the right is negative (counterclockwise is positive).
    const long = Math.hypot(b[0] - a[0], b[1] - a[1]) > 6;
    const baseAngle = long ? -((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI) : 0;
    const used = new Set([...v.all()].flatMap((o) => ('exportId' in o ? [o.exportId] : [])));
    let id = 'Rotation';
    for (let n = 1; used.has(id); n++) id = `Rotation${n}`;
    const part = sel[0] && 'part' in sel[0] ? sel[0].part : null;
    const calls: { name: string; args: unknown }[] = [
      {
        name: 'deformer.createRotation',
        args: { exportId: id, part, parent, origin, baseAngle: Math.round(baseAngle * 100) / 100 },
      },
      ...sel.map((o) =>
        o.kind === 'artMesh'
          ? { name: 'mesh.reparent', args: { target: o.uid, deformer: '$0' } }
          : { name: 'deformer.reparent', args: { target: o.uid, parent: '$0' } },
      ),
    ];
    const r = await this.editor.runItems('Create rotation deformer', calls);
    const created = (r?.results[0] as { uid?: Uid } | undefined)?.uid;
    if (created) this.editor.select(created);
  }

  /** Adds a vertex where the person clicked inside the edited mesh (any space: through its UVs). */
  addVertexAt(clientX: number, clientY: number): void {
    const mesh = this.editor.selectedMesh();
    if (!mesh) {
      this.editor.emit('message', {
        level: 'error',
        text: 'Select an ArtMesh to add vertices to.',
      });
      return;
    }
    const r = this.overlay.getBoundingClientRect();
    const point = this.screenToUv(mesh, [clientX - r.left, clientY - r.top], false);
    if (!point) {
      this.editor.emit('message', { level: 'error', text: 'Click inside the edited ArtMesh.' });
      return;
    }
    const points = [point];
    // Mirrored editing adds the mirrored vertex too, when it falls inside the mesh away from this one.
    if (this.mirrorEdit && this.editor.meshEdit) {
      const m = this.mirroredClient(clientX, clientY);
      const q = m && this.screenToUv(mesh, [m[0] - r.left, m[1] - r.top], false);
      if (q && Math.hypot(q[0] - point[0], q[1] - point[1]) > 1) points.push(q);
    }
    const res = this.editor.transact(points.length > 1 ? 'Add vertices (mirrored)' : 'Add vertex', [
      { name: 'mesh.addVertices', args: { target: mesh.uid, points } },
    ]);
    const added = (res?.results[0] as { vertices?: number[] } | undefined)?.vertices;
    if (added) this.editor.select(mesh.uid, added);
  }

  /** Alt+click with the add tool: deletes the vertex under the pointer. */
  deleteVertexAt(clientX: number, clientY: number): void {
    const mesh = this.editor.selectedMesh();
    const v = mesh ? this.vertexAt(mesh.uid, clientX, clientY) : -1;
    if (!mesh || v < 0) return;
    this.editor.transact('Delete vertices', [
      { name: 'mesh.deleteVertices', args: { target: mesh.uid, vertices: [v] } },
    ]);
  }
}

/** The corners of a box, clockwise from the top left. */
function boxCorners(b: { x0: number; y0: number; x1: number; y1: number }): [number, number][] {
  return [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x1, b.y1],
    [b.x0, b.y1],
  ];
}

function insidePolygon([x, y]: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The index of the screen point within reach of a pointer position, or -1. */
function nearest(
  pts: [number, number][] | null,
  overlay: HTMLElement,
  clientX: number,
  clientY: number,
): number {
  if (!pts) return -1;
  const r = overlay.getBoundingClientRect();
  const x = clientX - r.left;
  const y = clientY - r.top;
  let best = -1;
  let bestD = VERTEX_HIT;
  pts.forEach(([px, py], i) => {
    const d = Math.hypot(px - x, py - y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

export function triangles(mesh: ArtMesh): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 2 < mesh.triangles.length; i += 3)
    out.push([mesh.triangles[i]!, mesh.triangles[i + 1]!, mesh.triangles[i + 2]!]);
  return out;
}

function barycentric(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  c: [number, number],
): [number, number, number] | null {
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(det) < 1e-12) return null;
  const l0 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
  const l1 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det;
  return [l0, l1, 1 - l0 - l1];
}

function equalBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
