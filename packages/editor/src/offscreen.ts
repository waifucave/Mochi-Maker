/**
 * Renders and evaluations for agents, off the person's screen: a second Mochi2D view in a hidden
 * element, so an agent can look at any pose, size or revision without moving the person's view.
 * (What the person sees is the main viewport; `render { source: 'editor' }` captures that.)
 */
import { MochiView } from 'mochi2d';
import { makeView } from './noview.js';
import { DocView, MochiError, type Document, type Uid } from '@mochi-maker/core';
import { BUILD_TEXTURES, PreviewBuilder, type PreviewBuild } from '@mochi-maker/export';
import type { AssetStore } from '@mochi-maker/core';

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

export interface OffscreenOptions {
  parameters?: Record<string, number>;
  width?: number;
  height?: number;
  /** Frame one mesh (a reference) with `margin` canvas pixels around it. */
  around?: string;
  margin?: number;
  /** An explicit view: the model point at the image center and image pixels per model unit. */
  view?: { x: number; y: number; pixelsPerUnit: number };
  /** Straight-alpha RGBA background, 0–1 (default transparent). */
  background?: [number, number, number, number];
}

export interface DrawableState {
  id: string;
  uid: Uid;
  visible: boolean;
  opacity: number;
  drawOrder: number;
  renderOrder: number;
  multiplyColor: number[];
  screenColor: number[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  vertices?: number[];
}

export class Offscreen {
  private readonly box: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly view: MochiView;
  private builder: PreviewBuilder;
  private shown: { doc: Document; build: PreviewBuild } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private assets: AssetStore) {
    this.box = document.createElement('div');
    this.box.setAttribute('aria-hidden', 'true');
    this.box.style.cssText =
      'position:fixed;left:-20000px;top:0;width:512px;height:512px;pointer-events:none;';
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;';
    this.box.append(this.canvas);
    document.body.append(this.box);
    this.view = makeView(this.canvas, { look: 'off', autoStart: false, maxPixelRatio: 1 }).view;
    this.builder = new PreviewBuilder(assets);
  }

  /** A new project: new assets, nothing cached. */
  reset(assets: AssetStore): void {
    this.assets = assets;
    this.builder = new PreviewBuilder(assets);
    this.shown = null;
    this.view.unload();
  }

  /** Runs one job at a time (the view is shared). */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async prepare(doc: Document, parameters: Record<string, number>) {
    if (new DocView(doc).ofKind('artMesh').length === 0)
      throw new MochiError('E_EXPORT', 'The model has no art meshes, so there is nothing to show.');
    if (this.shown?.doc !== doc) {
      const build = await this.builder.build(doc);
      const model = await this.view.load(
        { files: build.files },
        { settings: build.settings, textures: BUILD_TEXTURES, sounds: { compressed: true } },
      );
      for (const e of EFFECTS) if (model.effectAvailable(e)) model.setEffect(e, false);
      this.shown = { doc, build };
    }
    const model = this.view.model!;
    model.resetParameters();
    for (const [id, v] of Object.entries(parameters))
      if (!model.setParameter(id, v))
        throw new MochiError('E_NOT_FOUND', `No parameter with export ID "${id}".`, {
          path: `args.parameters.${id}`,
        });
    model.runtime.update(0);
    return { model, build: this.shown!.build };
  }

  /** Mochi2D's evaluation at a pose, in canvas pixels (the agent API's `evaluate` shape). */
  evaluate(doc: Document, parameters: Record<string, number> = {}, vertices = false) {
    return this.serial(async () => {
      const { model, build } = await this.prepare(doc, parameters);
      return { version: build.version, drawables: this.drawables(doc, model, build, vertices) };
    });
  }

  private drawables(
    doc: Document,
    model: NonNullable<MochiView['model']>,
    build: PreviewBuild,
    vertices: boolean,
  ): DrawableState[] {
    const inst = model.runtime.instance;
    const v = new DocView(doc);
    const c = v.project().canvas;
    return build.lowered.uids.artMeshes.map((uid, i) => {
      const raw = inst.drawableVertices[i]!;
      const px: number[] = [];
      for (let k = 0; k < raw.length; k += 2)
        px.push(raw[k]! * c.pixelsPerUnit + c.originX, -raw[k + 1]! * c.pixelsPerUnit + c.originY);
      const xs = px.filter((_, k) => k % 2 === 0);
      const ys = px.filter((_, k) => k % 2 === 1);
      const d: DrawableState = {
        id: v.getAs(uid, 'artMesh').exportId,
        uid,
        visible: inst.drawableVisible[i] === 1,
        opacity: inst.drawableOpacity[i]!,
        drawOrder: inst.drawableDrawOrder[i]!,
        renderOrder: inst.drawableRenderOrder[i]!,
        multiplyColor: Array.from(inst.drawableMultiply.subarray(3 * i, 3 * i + 3)),
        screenColor: Array.from(inst.drawableScreen.subarray(3 * i, 3 * i + 3)),
        bounds: {
          minX: Math.min(...xs),
          minY: Math.min(...ys),
          maxX: Math.max(...xs),
          maxY: Math.max(...ys),
        },
      };
      if (vertices) d.vertices = px;
      return d;
    });
  }

  /** A PNG of a pose, with the view used (model point at the center, image pixels per unit). */
  /**
   * The frames of a motion, as Mochi2D plays it (image and video export). The motion
   * starts at frame 0 with physics and the pose on (where the model has them; the other effects
   * stay off), and the view steps one frame at a time, so physics runs from the motion's start even
   * when only later frames are wanted. Frames `first` to `last` (inclusive) are captured as PNGs
   * (straight alpha) and handed to `onFrame` in order; `onFrame` may throw to stop.
   */
  frames(
    doc: Document,
    o: {
      motionFile: string;
      fps: number;
      first: number;
      last: number;
      width: number;
      height: number;
      background: string | null;
    },
    onFrame: (png: Blob, frame: number) => Promise<void> | void,
  ) {
    return this.serial(async () => {
      this.box.style.width = `${o.width}px`;
      this.box.style.height = `${o.height}px`;
      this.view.resize();
      const { model } = await this.prepare(doc, {});
      this.view.resetView();
      this.view.background = o.background ?? 'transparent';
      for (const e of ['physics', 'pose'] as const)
        if (model.effectAvailable(e)) model.setEffect(e, true);
      try {
        model.stopMotions();
        const started = await model.startMotionFile(o.motionFile, {
          priority: 3,
          hold: true,
          sound: false,
        });
        if (!started) throw new MochiError('E_EXPORT', `The motion ${o.motionFile} did not start.`);
        const dt = 1 / o.fps;
        for (let f = 0; f <= o.last; f++) {
          if (f < o.first) {
            this.view.advance(f === 0 ? 0 : dt);
            continue;
          }
          const shot = this.view.screenshot();
          this.view.advance(f === 0 ? 0 : dt);
          await onFrame(await shot, f);
        }
      } finally {
        model.stopMotions();
        for (const e of ['physics', 'pose'] as const)
          if (model.effectAvailable(e)) model.setEffect(e, false);
        this.view.background = 'transparent';
      }
    });
  }

  /**
   * Each art mesh as drawn at a pose, alone (the PSD of the pose): the canvas at its own
   * pixel size, the other meshes tinted to opacity 0 (they still mask, so clipping is kept), one
   * PNG per mesh, in draw order (back to front). Also the whole image.
   */
  layers(doc: Document, parameters: Record<string, number>) {
    return this.serial(async () => {
      const c = new DocView(doc).project().canvas;
      const width = Math.max(1, Math.round(c.width));
      const height = Math.max(1, Math.round(c.height));
      this.box.style.width = `${width}px`;
      this.box.style.height = `${height}px`;
      this.view.resize();
      const { model, build } = await this.prepare(doc, parameters);
      this.view.resetView();
      this.view.background = 'transparent';
      const rt = model.runtime;
      const inst = rt.instance;
      const ids = build.lowered.uids.artMeshes.map((u) => {
        const o = new DocView(doc).get(u) as { exportId: string; name: string; uid: Uid };
        return o;
      });
      const shot = async () => {
        const s = this.view.screenshot();
        this.view.advance(0);
        return s;
      };
      const whole = await shot();
      const order = ids
        .map((o, i) => ({ o, i, at: inst.drawableRenderOrder[i] ?? i }))
        .sort((a, b) => a.at - b.at);
      const out: { uid: Uid; exportId: string; name: string; png: Blob }[] = [];
      try {
        for (const { o, i } of order) {
          rt.clearTints();
          ids.forEach((x, j) => {
            if (j !== i) rt.setTint(x.exportId, [1, 1, 1, 0]);
          });
          out.push({ uid: o.uid, exportId: o.exportId, name: o.name, png: await shot() });
        }
      } finally {
        rt.clearTints();
      }
      return { width, height, whole, layers: out };
    });
  }

  render(doc: Document, o: OffscreenOptions = {}) {
    return this.serial(async () => {
      const width = Math.round(o.width ?? 512);
      const height = Math.round(o.height ?? 512);
      this.box.style.width = `${width}px`;
      this.box.style.height = `${height}px`;
      this.view.resize();
      const parameters = o.parameters ?? {};
      const { model, build } = await this.prepare(doc, parameters);
      const rect = model.canvas;
      const mid = { x: (rect.left + rect.right) / 2, y: (rect.bottom + rect.top) / 2 };
      this.view.resetView();
      const fitted = this.view.viewTransform.pixelsPerUnit;
      let target = o.view;
      if (!target && o.around) {
        const v = new DocView(doc);
        const uid = v.resolve(o.around, ['artMesh'], 'around');
        const i = build.lowered.uids.artMeshes.indexOf(uid);
        const raw = model.runtime.instance.drawableVertices[i];
        if (!raw) throw new MochiError('E_WRONG_KIND', `${v.describe(uid)} is not a drawn mesh.`);
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let k = 0; k < raw.length; k += 2) {
          x0 = Math.min(x0, raw[k]!);
          x1 = Math.max(x1, raw[k]!);
          y0 = Math.min(y0, raw[k + 1]!);
          y1 = Math.max(y1, raw[k + 1]!);
        }
        const m = (o.margin ?? 20) / v.project().canvas.pixelsPerUnit;
        target = {
          x: (x0 + x1) / 2,
          y: (y0 + y1) / 2,
          pixelsPerUnit: Math.min(
            width / Math.max(x1 - x0 + 2 * m, 1e-6),
            height / Math.max(y1 - y0 + 2 * m, 1e-6),
          ),
        };
      }
      if (target)
        this.view.setView({
          x: target.x - mid.x,
          y: target.y - mid.y,
          zoom: target.pixelsPerUnit / fitted,
        });
      const b = o.background;
      this.view.background = b
        ? `rgba(${Math.round(b[0] * 255)}, ${Math.round(b[1] * 255)}, ${Math.round(b[2] * 255)}, ${b[3]})`
        : 'transparent';
      const t = this.view.viewTransform;
      const shot = this.view.screenshot();
      this.view.advance(0);
      const png = new Uint8Array(await (await shot).arrayBuffer());
      return {
        png,
        width,
        height,
        pixelsPerUnit: t.pixelsPerUnit,
        center: [mid.x + t.x, mid.y + t.y] as [number, number],
        version: build.version,
      };
    });
  }
}
