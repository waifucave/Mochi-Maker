/**
 * Animation (M10): the Scene palette (the motions) and the Timeline palette, with its two edit modes:
 * the «Dope Sheet» (keys as marks per row, the default) and the «Graph Editor» (value curves), switched with C or the button in the header.
 *
 * Every change is a motion command (`motion.insertKey`, `deleteKeys`, `moveKeys`,
 * `setInterpolation`, `setKeys`, `setCurve`, `setEvents`, `update`), so agents can do the same.
 * Playback plays the motion with Mochi2D (`startMotionFile` on the preview's files); while stopped,
 * the playhead poses the model from the curves.
 */
import {
  INTERPOLATIONS,
  clipMotion,
  curveKeys,
  sampleSegments,
  type Interpolation,
  type Motion,
  type MotionCurve,
  type MotionKey,
  type Uid,
} from '@mochi-maker/core';
import { motionFile, planFiles } from '@mochi-maker/export';
import { MemoryFileSource, ModelRuntime, type MotionPlayback } from 'mochi2d';
import { parseMotion } from 'mochi2d/headless';
import { PhysicsScrubber } from './scrub.js';
import { round, type Editor } from './editor.js';
import { fill, h } from './dom.js';
import { askText, dialog } from './dialogs.js';
import type { Viewport } from './viewport.js';
import type { Keymap } from './keymap.js';
import { lazyRender, popupMenu } from './panels.js';
import { fileBytes } from './limits.js';

export const INTERP_LABEL: Record<Interpolation, string> = {
  linear: 'Linear',
  auto: 'Auto smooth',
  step: 'Step',
  inverseStep: 'Inverse step',
  bezier: 'Bezier',
};

/** A curve's identity, as the motion commands name it. */
export interface CurveRef {
  target: MotionCurve['target'];
  model?: NonNullable<MotionCurve['model']>;
  object?: Uid;
}
export const refOf = (c: MotionCurve): CurveRef =>
  c.target === 'model'
    ? { target: 'model', model: c.model! }
    : { target: c.target, object: c.object! };
export const keyOf = (r: CurveRef) => `${r.target}|${r.model ?? ''}|${r.object ?? ''}`;

const EPS = 1e-6;

// ---------------------------------------------------------------- playback

/** The animation state shared by the Scene and Timeline palettes. */
export class Playback {
  motion: Uid | null = null;
  time = 0;
  playing = false;
  private started = 0;
  private raf = 0;
  readonly listeners = new Set<() => void>();
  /** Set by main: the viewport that shows the model. */
  viewport: Viewport | null = null;

  constructor(private readonly editor: Editor) {
    editor.on('project', () => {
      this.motion = null;
      this.scrub = null;
      this.viewport?.setScrubbing(false);
      this.stop();
    });
    // Baked physics depends on the document (curves, physics, model) and on the other parameters.
    editor.on('document', () => (this.scrub = null));
    editor.on('poseEdit', () => (this.scrub = null));
  }

  get current(): Motion | undefined {
    const m = this.motion ? this.editor.view.get(this.motion) : undefined;
    return m?.kind === 'motion' ? m : undefined;
  }

  changed(): void {
    for (const l of this.listeners) l();
  }

  select(uid: Uid | null): void {
    this.motion = uid;
    if (uid === null) this.viewport?.setScrubbing(false);
    this.seek(0);
  }

  /** The frame duration (1 / fps). */
  get frame(): number {
    return 1 / (this.current?.fps || 30);
  }

  /** The work area, clamped to the motion, or null when there is none. */
  get workArea(): { start: number; end: number } | null {
    const m = this.current;
    const w = m?.workArea;
    if (!m || !w) return null;
    const start = Math.max(0, Math.min(w.start, m.duration));
    const end = Math.max(start, Math.min(w.end, m.duration));
    return end > start ? { start, end } : null;
  }

  /** The times playback and exports cover: the work area, or the whole motion. */
  get range(): { start: number; end: number } {
    return this.workArea ?? { start: 0, end: this.current?.duration ?? 0 };
  }

  /** Jumps to the previous or next marker (Ctrl+J, Ctrl+K). */
  jumpMarker(dir: -1 | 1): void {
    const m = this.current;
    if (!m) return;
    const times = m.markers.map((x) => x.time).sort((a, b) => a - b);
    const next =
      dir > 0
        ? times.find((x) => x > this.time + EPS)
        : times.reverse().find((x) => x < this.time - EPS);
    if (next !== undefined) this.seek(next);
  }

  /** Snaps a time to the motion's frames. */
  snap(t: number): number {
    const f = this.frame;
    return Math.round(t / f) * f;
  }

  /** Poses the model from the motion's curves at a time (stopped). */
  seek(t: number): void {
    const m = this.current;
    this.time = m ? Math.max(0, Math.min(m.duration, t)) : 0;
    if (m && !this.playing) this.apply(m);
    this.changed();
  }

  /** Scrubbing with physics: the playhead shows physics as it would be at that time. */
  scrubPhysics = true;
  /** Set by main: whether the Animation workspace is shown. */
  active: () => boolean = () => true;
  private scrub: { scrubber: PhysicsScrubber; motion: Uid; fps: number } | null = null;
  private scrubLoading: Promise<void> | null = null;
  /** Why the last bake could not start (no physics in the preview, a load error). */
  scrubError: string | null = null;
  /** The last scrub: how long it took and how many frames it stepped (for tests and tuning). */
  lastScrub: { ms: number; steps: number; frame: number } | null = null;

  /** Forget the baked physics (the motion, the model or the pose changed). */
  invalidateScrub(): void {
    this.scrub = null;
  }

  private applyPhysics(m: Motion): void {
    const vp = this.viewport;
    const model = vp?.model;
    const on =
      this.scrubPhysics && !this.playing && this.active() && !!model?.effectAvailable('physics');
    vp?.setScrubbing(on);
    if (!on || !vp || !model) return;
    const fps = m.fps || 30;
    const frame = Math.round(this.time * fps);
    const s = this.scrub;
    if (s && s.motion === m.uid && s.fps === fps) {
      const t0 = performance.now();
      s.scrubber.show(model.runtime, frame);
      this.lastScrub = { ms: performance.now() - t0, steps: s.scrubber.lastSteps, frame };
      return;
    }
    if (this.scrubLoading) return;
    const files = vp.shownFiles();
    if (!files) return;
    // A headless copy of the shown export bakes: fresh physics, nothing else running.
    const v = this.editor.view;
    const base = this.editor.poseByExportId();
    const curves = m.curves.flatMap((c) => {
      const o = c.object ? v.get(c.object) : undefined;
      return c.target === 'parameter' && o?.kind === 'parameter'
        ? [{ id: o.exportId, segments: c.segments }]
        : [];
    });
    const values = (f: number) => {
      const out: Record<string, number> = { ...base };
      for (const c of curves) out[c.id] = sampleSegments(c.segments, f / fps);
      return out;
    };
    this.scrubLoading = ModelRuntime.load(MemoryFileSource.fromFiles(files), undefined, {
      holdPhysicsInZeroSteps: true,
    })
      .then((rt) => {
        for (const e of [
          'eyeBlink',
          'breath',
          'look',
          'idle',
          'lipSync',
          'pose',
          'expressions',
        ] as const)
          if (rt.effectAvailable(e)) rt.setEffect(e, false);
        rt.setEffect('physics', true);
        this.scrub = { scrubber: new PhysicsScrubber(rt, values, 1 / fps, 10), motion: m.uid, fps };
      })
      .catch((e: unknown) => {
        this.scrub = null;
        this.scrubError = (e as Error).message;
      })
      .finally(() => {
        this.scrubLoading = null;
        // Show the playhead now that the bake can run.
        const cur = this.current;
        if (cur && this.scrub) this.applyPhysics(cur);
      });
  }

  private apply(m: Motion): void {
    const opacities = new Map<string, number>();
    for (const c of m.curves) {
      const o = c.object ? this.editor.view.get(c.object) : undefined;
      const v = sampleSegments(c.segments, this.time);
      if (c.target === 'parameter' && o?.kind === 'parameter') this.editor.setPoseRaw(o.uid, v);
      else if (c.target === 'partOpacity' && o?.kind === 'part') opacities.set(o.exportId, v);
    }
    this.viewport?.setPartOverrides(opacities.size ? opacities : null);
    this.applyPhysics(m);
  }

  step(frames: number): void {
    this.seek(this.time + frames * this.frame);
  }

  toggle(): void {
    if (this.playing) this.stop();
    else void this.play();
  }

  /**
   * Plays the motion with Mochi2D: its file in the preview, with the effects the view has on. With
   * a work area, it loops the work area: a copy of the motion clipped to it (`clipMotion`), since a
   * motion cannot start partway.
   */
  async play(): Promise<void> {
    const m = this.current;
    const model = this.viewport?.model;
    if (!m || !model) return;
    const doc = this.editor.view;
    const s = doc.project().exportSettings;
    const wa = this.workArea;
    this.viewport?.setPartOverrides(null);
    this.viewport?.setScrubbing(false);
    model.stopMotions();
    let playback: MotionPlayback | false;
    if (wa) {
      const clip = motionFile(doc, clipMotion(m, wa.start, wa.end));
      playback = model.runtime.playMotion(parseMotion(JSON.stringify(clip), 'work area'), {
        priority: 3,
        loop: true,
        sound: false,
      });
    } else {
      const plan = planFiles(doc, s.fileStem, 1, s.atlasSize);
      const file = plan.motions.find((x) => x.uid === m.uid)?.file;
      if (!file) return;
      playback = await model.startMotionFile(file, { priority: 3, loop: m.loop });
    }
    // A motion's sound is checked when it is to play: tell what Mochi2D warns, now and when the
    // motion ends.
    this.viewport?.reportWarnings();
    if (!playback) return;
    this.playing = true;
    // Mochi2D plays from the motion's (or the work area's) start, so the playhead does too.
    this.started = performance.now();
    this.time = wa ? wa.start : 0;
    void playback.ended.then(() => {
      this.viewport?.reportWarnings();
      if (this.playing) this.stop(true);
    });
    const tick = () => {
      if (!this.playing) return;
      const t = (performance.now() - this.started) / 1000;
      const w = this.workArea;
      this.time = w
        ? w.start + (t % (w.end - w.start))
        : m.loop
          ? t % (m.duration || 1)
          : Math.min(t, m.duration);
      const model = this.viewport?.model;
      if (model) {
        const live = new Map<Uid, number>();
        for (const p of this.editor.view.ofKind('parameter'))
          live.set(p.uid, model.getParameterBase(p.exportId));
        this.editor.setLive(live);
      }
      this.changed();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.changed();
  }

  stop(finished = false): void {
    cancelAnimationFrame(this.raf);
    const was = this.playing;
    this.playing = false;
    if (this.editor.live) this.editor.setLive(null);
    if (was) {
      this.viewport?.model?.stopMotions();
      if (finished) this.time = this.current?.duration ?? 0;
      // Back to the pose the curves give at the playhead.
      const m = this.current;
      if (m) this.apply(m);
      else this.editor.emit('pose', undefined);
    }
    this.changed();
  }

  /** Jumps to the previous or next key time of any curve. */
  jump(dir: -1 | 1): void {
    const m = this.current;
    if (!m) return;
    const times = [
      ...new Set(m.curves.flatMap((c) => curveKeys(c.segments).map((k) => k.time))),
    ].sort((a, b) => a - b);
    const next =
      dir > 0
        ? times.find((x) => x > this.time + EPS)
        : times.reverse().find((x) => x < this.time - EPS);
    if (next !== undefined) this.seek(next);
  }
}

// ---------------------------------------------------------------- scene palette

/** «Scene»: the project's motions (an animation's scenes). */
export class ScenePalette {
  readonly el = h('section.scene');

  constructor(
    private readonly editor: Editor,
    private readonly playback: Playback,
  ) {
    const update = lazyRender(this.el, () => this.render());
    editor.on('project', update);
    editor.on(
      'document',
      (e) => e.changes.some((c) => c.kind === 'motion' || c.kind === 'project') && update(),
    );
    playback.listeners.add(update);
    this.render();
  }

  render(): void {
    const motions = this.editor.view.ofKind('motion');
    fill(
      this.el,
      h(
        'div.palette-bar',
        h(
          'button',
          {
            title: 'Create a motion',
            dataset: { testid: 'motion-create' },
            on: {
              click: () => {
                const r = this.editor.transact('New motion', [
                  {
                    name: 'motion.create',
                    args: { name: `Motion ${motions.length + 1}`, duration: 2, fps: 30 },
                  },
                ]);
                const uid = (r?.results[0] as { uid?: Uid } | undefined)?.uid;
                if (uid) this.playback.select(uid);
              },
            },
          },
          'New',
        ),
        h(
          'button',
          {
            disabled: !this.playback.motion,
            on: {
              click: () =>
                this.playback.motion &&
                this.editor.transact('Delete motion', [
                  { name: 'motion.delete', args: { target: this.playback.motion } },
                ]),
            },
          },
          'Delete',
        ),
      ),
      motions.length
        ? motions.map((m) =>
            h(
              'div.row',
              {
                class: m.uid === this.playback.motion ? 'selected' : '',
                dataset: { motion: m.name },
                on: { click: () => this.playback.select(m.uid) },
              },
              h('span.icon', '▶'),
              h('span.name', m.name),
              h('span.extra', `${m.group || 'no group'} · ${round(m.duration, 2)} s`),
            ),
          )
        : h('div.empty', 'No motions yet.'),
    );
  }
}

// ---------------------------------------------------------------- timeline palette

/** A selected key: its curve and its time. */
interface KeySel {
  curve: string;
  time: number;
}
interface Row {
  key: string;
  ref: CurveRef;
  label: string;
  curve: MotionCurve;
  /** The value range shown and used for pasting by ratio. */
  min: number;
  max: number;
  /** The reference value that Reverse Keyframes mirrors around. */
  reference: number;
}
interface Clip {
  ref: CurveRef;
  min: number;
  max: number;
  keys: MotionKey[];
}

const COLORS = ['#ff7aa2', '#46c8ff', '#7bd88f', '#f4c95d', '#c792ea', '#ff9e64', '#89ddff'];

/** «Timeline»: the keys of the motion picked in the Scene palette, in the Dope Sheet or the Graph Editor. */
export class TimelinePalette {
  readonly el = h('section.timeline');
  mode: 'dope' | 'graph' = 'dope';
  /** Selected keys, and selected rows (for pasting and for the curves the Graph Editor shows). */
  readonly selected: KeySel[] = [];
  readonly rows = new Set<string>();
  private eventsSelected = new Set<number>();
  clip: Clip[] = [];
  /** Moving a parameter slider keys it at the playhead (the Animation workspace). */
  keyOnSlider = true;
  /**
   * Dragging a rotation deformer's handle in the animation view, at edit levels 2 and 3, keys the
   * parameters that turn it (recording from the viewport).
   */
  recordDrags = true;
  /** Graph Editor options. */
  options = { snapFrames: true, snapValues: false, snapNeighbours: false, continuous: true };
  private readonly update: () => void;
  private canvas: HTMLCanvasElement | null = null;
  private pending = new Map<Uid, ReturnType<typeof setTimeout>>();
  /** The times shown across the Dope Sheet and the Graph Editor; null: the whole motion. */
  viewRange: { start: number; end: number } | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly playback: Playback,
    private readonly keymap: Keymap,
    private readonly animationActive: () => boolean,
  ) {
    this.update = lazyRender(this.el, () => this.render());
    editor.on(
      'document',
      (e) =>
        e.changes.some(
          (c) =>
            c.kind === 'motion' ||
            c.kind === 'parameter' ||
            c.kind === 'part' ||
            c.kind === 'sound' ||
            c.kind === 'motionSyncSetting',
        ) && this.update(),
    );
    editor.on('project', () => {
      this.selected.length = 0;
      this.rows.clear();
      this.update();
    });
    playback.listeners.add(() => this.onTime());
    // Keys by moving a slider at the current frame (the Dope Sheet's insert).
    editor.on('poseEdit', ({ param, value }) => this.sliderKey(param, value));
    this.render();
  }

  get motion(): Motion | undefined {
    return this.playback.current;
  }

  // ---------------------------------------------------------------- rows and keys

  /** The rows of the motion: model curves, parameter curves, part-opacity curves. */
  rowList(): Row[] {
    const m = this.motion;
    if (!m) return [];
    const v = this.editor.view;
    return m.curves.map((c) => {
      const ref = refOf(c);
      const o = c.object ? v.get(c.object) : undefined;
      const isParam = o?.kind === 'parameter';
      return {
        key: keyOf(ref),
        ref,
        curve: c,
        label:
          c.target === 'model'
            ? `Model · ${c.model}`
            : c.target === 'partOpacity'
              ? `${o && 'exportId' in o ? o.exportId : '?'} · opacity`
              : o && 'exportId' in o
                ? o.exportId
                : '?',
        min: isParam ? o.min : 0,
        max: isParam ? o.max : 1,
        reference: isParam ? o.default : 0.5,
      };
    });
  }

  private keysOf(row: Row): MotionKey[] {
    return curveKeys(row.curve.segments, row.curve.auto);
  }

  isSelected(curve: string, time: number): boolean {
    return this.selected.some((s) => s.curve === curve && Math.abs(s.time - time) < EPS);
  }

  selectKey(curve: string, time: number, additive: boolean, redraw = true): void {
    const i = this.selected.findIndex((s) => s.curve === curve && Math.abs(s.time - time) < EPS);
    if (!additive) this.selected.length = 0;
    if (additive && i >= 0) this.selected.splice(i, 1);
    else if (i < 0 || !additive) this.selected.push({ curve, time });
    if (redraw) this.render();
  }

  /** Selected keys grouped by row. */
  private byRow(): { row: Row; times: number[] }[] {
    return this.rowList()
      .map((row) => ({
        row,
        times: this.selected.filter((s) => s.curve === row.key).map((s) => s.time),
      }))
      .filter((x) => x.times.length > 0);
  }

  private run(label: string, calls: { name: string; args: unknown }[]): boolean {
    if (calls.length === 0) return false;
    return this.editor.transact(label, calls) !== undefined;
  }

  /**
   * The motion's sound and, beside it, the motion-sync setting through which the sound moves the
   * mouth. «Import WAV…» imports a sound and gives it to the motion in one step.
   */
  private soundControls(m: Motion): Node {
    const v = this.editor.view;
    const sounds = v.project().soundOrder.map((u) => v.getAs(u, 'sound'));
    const settings = v.project().motionSyncOrder.map((u) => v.getAs(u, 'motionSyncSetting'));
    const file = h('input', {
      type: 'file',
      accept: '.wav,audio/wav',
      hidden: true,
      dataset: { testid: 'motion-sound-file' },
      on: {
        change: async (e) => {
          const input = e.target as HTMLInputElement;
          const f = input.files?.[0];
          input.value = '';
          if (!f) return;
          const path = `import/${f.name}`;
          try {
            await this.editor.fs.writeBytes(path, await fileBytes(f));
          } catch (e) {
            return this.editor.report(e);
          }
          await this.editor.runItems(`Sound ${f.name}`, [
            { name: 'sound.import', args: { path } },
            { name: 'motion.update', args: { target: m.uid, sound: '$0' } },
          ]);
        },
      },
    }) as HTMLInputElement;
    const sound = h(
      'select',
      {
        title: 'The sound the motion starts (model settings Sound)',
        dataset: { testid: 'motion-sound' },
        on: {
          change: (e) => {
            const el = e.target as HTMLSelectElement;
            if (el.value === '+') {
              el.value = m.sound ?? '';
              file.click();
              return;
            }
            this.run('Motion sound', [
              { name: 'motion.update', args: { target: m.uid, sound: el.value || null } },
            ]);
          },
        },
      },
      h('option', { value: '', selected: m.sound === null }, 'No sound'),
      sounds.map((x) => h('option', { value: x.uid, selected: m.sound === x.uid }, x.name)),
      h('option', { value: '+' }, 'Import WAV…'),
    );
    const sync = h(
      'select',
      {
        title:
          'How the sound moves the mouth: lip sync, or a motion-sync setting (model settings MotionSync)',
        disabled: m.sound === null && m.motionSync === null,
        dataset: { testid: 'motion-sync' },
        on: {
          change: (e) =>
            this.run('Motion sync', [
              {
                name: 'motion.update',
                args: {
                  target: m.uid,
                  motionSync: (e.target as HTMLSelectElement).value || null,
                },
              },
            ]),
        },
      },
      h('option', { value: '', selected: m.motionSync === null }, 'Lip sync'),
      settings.map((x) =>
        h('option', { value: x.uid, selected: m.motionSync === x.uid }, `Motion sync: ${x.name}`),
      ),
    );
    return h('label.toggle', 'Sound', sound, sync, file);
  }

  /** Inserts a key on a row at a time, with the curve's value there (Ctrl+click). */
  insertAt(row: Row, time: number): void {
    const m = this.motion!;
    const t = this.playback.snap(time);
    this.run('Insert key', [
      {
        name: 'motion.insertKey',
        args: {
          target: m.uid,
          curve: row.ref,
          time: t,
          value: sampleSegments(row.curve.segments, t),
        },
      },
    ]);
    this.selected.length = 0;
    this.selected.push({ curve: row.key, time: t });
  }

  /** Keys every row (or one new curve) at the playhead with its current value. */
  insertKeyHere(row?: Row): void {
    const rows = row
      ? [row]
      : this.rowList().filter((r) => this.rows.size === 0 || this.rows.has(r.key));
    const m = this.motion;
    if (!m) return;
    const t = this.playback.snap(this.playback.time);
    this.run(
      'Insert keys',
      rows.map((r) => ({
        name: 'motion.insertKey',
        args: {
          target: m.uid,
          curve: r.ref,
          time: t,
          value:
            r.curve.target === 'parameter' && r.ref.object
              ? this.editor.value(r.ref.object)
              : sampleSegments(r.curve.segments, t),
        },
      })),
    );
  }

  deleteSelected(): void {
    const m = this.motion;
    if (!m) return;
    const calls = this.byRow().map(({ row, times }) => ({
      name: 'motion.deleteKeys',
      args: { target: m.uid, curve: row.ref, times },
    }));
    if (this.eventsSelected.size) {
      calls.push({
        name: 'motion.setEvents',
        args: {
          target: m.uid,
          events: m.events.filter((_, i) => !this.eventsSelected.has(i)),
        } as never,
      });
      this.eventsSelected.clear();
    }
    if (this.run('Delete keys', calls)) this.selected.length = 0;
  }

  copySelected(): void {
    this.clip = this.byRow().map(({ row, times }) => ({
      ref: row.ref,
      min: row.min,
      max: row.max,
      keys: this.keysOf(row).filter((k) => times.some((t) => Math.abs(t - k.time) < EPS)),
    }));
    const n = this.clip.reduce((s, c) => s + c.keys.length, 0);
    this.editor.emit('message', { level: 'info', text: `Copied ${n} key${n === 1 ? '' : 's'}.` });
  }

  cutSelected(): void {
    this.copySelected();
    this.deleteSelected();
  }

  /** Pastes copied keys onto their own curves, the earliest at the playhead. */
  paste(): void {
    const m = this.motion;
    if (!m || this.clip.length === 0) return;
    const t0 = Math.min(...this.clip.flatMap((c) => c.keys.map((k) => k.time)));
    const at = this.playback.snap(this.playback.time);
    const rows = new Map(this.rowList().map((r) => [r.key, r]));
    this.run(
      'Paste keys',
      this.clip.map((c) => {
        const row = rows.get(keyOf(c.ref));
        return {
          name: 'motion.setKeys',
          args: {
            target: m.uid,
            curve: c.ref,
            keys: this.merge(row ? this.keysOf(row) : [], this.shifted(c.keys, at - t0, 0)),
          },
        };
      }),
    );
  }

  /**
   * «Paste Keyframes to Selected Rows»: the first copied curve's keys onto each selected row, with
   * values scaled by the ranges' ratio, clamped to the target's range, or as they are.
   */
  pasteToRows(how: 'ratio' | 'clamp' | 'asIs'): void {
    const m = this.motion;
    const src = this.clip[0];
    if (!m || !src) return;
    const t0 = Math.min(...src.keys.map((k) => k.time));
    const at = this.playback.snap(this.playback.time);
    const targets = this.rowList().filter((r) => this.rows.has(r.key));
    this.run(
      'Paste keys to rows',
      targets.map((row) => {
        const map = (v: number) =>
          how === 'ratio'
            ? row.min + ((v - src.min) / (src.max - src.min || 1)) * (row.max - row.min)
            : how === 'clamp'
              ? Math.min(row.max, Math.max(row.min, v))
              : v;
        const keys = this.shifted(src.keys, at - t0, 0).map((k) => ({
          ...k,
          value: map(k.value),
          handles: k.handles
            ? ([
                k.handles[0],
                map(k.handles[1]),
                k.handles[2],
                map(k.handles[3]),
              ] as MotionKey['handles'])
            : undefined,
        }));
        return {
          name: 'motion.setKeys',
          args: { target: m.uid, curve: row.ref, keys: this.merge(this.keysOf(row), keys) },
        };
      }),
    );
  }

  private shifted(keys: MotionKey[], dt: number, dv: number): MotionKey[] {
    return keys.map((k) => ({
      ...k,
      time: k.time + dt,
      value: k.value + dv,
      handles: k.handles
        ? ([
            k.handles[0] + dt,
            k.handles[1] + dv,
            k.handles[2] + dt,
            k.handles[3] + dv,
          ] as MotionKey['handles'])
        : undefined,
    }));
  }

  /** Keys of a curve with others laid over them (the new ones win at equal times). */
  private merge(base: MotionKey[], over: MotionKey[]): MotionKey[] {
    const out = base.filter((k) => !over.some((o) => Math.abs(o.time - k.time) < EPS));
    return [...out, ...over].sort((a, b) => a.time - b.time);
  }

  /** Writes changed keys of the selected rows: `change` maps a row's keys and the selected ones. */
  private transformSelected(
    label: string,
    change: (keys: MotionKey[], selected: MotionKey[], row: Row) => MotionKey[],
  ): void {
    const m = this.motion;
    if (!m) return;
    const next: KeySel[] = [];
    const calls = this.byRow().map(({ row, times }) => {
      const keys = this.keysOf(row);
      const sel = keys.filter((k) => times.some((t) => Math.abs(t - k.time) < EPS));
      const out = change(keys, sel, row);
      for (const k of sel) next.push({ curve: row.key, time: k.time });
      return { name: 'motion.setKeys', args: { target: m.uid, curve: row.ref, keys: out } };
    });
    if (this.run(label, calls)) {
      this.selected.length = 0;
      this.selected.push(...next);
    }
  }

  /** «Adjust Spacing»: the selected keys' spacing stretched or squeezed by a percentage. */
  adjustSpacing(percent: number): void {
    const f = percent / 100;
    const all = this.selected.map((s) => s.time);
    const t0 = Math.min(...all);
    this.transformSelected('Adjust spacing', (keys, sel) => {
      for (const k of sel) {
        const nt = t0 + (k.time - t0) * f;
        if (k.handles)
          k.handles = [
            t0 + (k.handles[0] - t0) * f,
            k.handles[1],
            t0 + (k.handles[2] - t0) * f,
            k.handles[3],
          ];
        k.time = this.playback.snap(nt);
      }
      return keys;
    });
  }

  /** «Reverse Keyframes»: the selected keys' values mirrored around the row's reference value. */
  reverse(): void {
    this.transformSelected('Reverse keyframes', (keys, sel, row) => {
      const r = row.reference;
      for (const k of sel) {
        k.value = 2 * r - k.value;
        if (k.handles)
          k.handles = [k.handles[0], 2 * r - k.handles[1], k.handles[2], 2 * r - k.handles[3]];
      }
      return keys;
    });
  }

  /** Moves the selected keys by a time (snapped to frames) and a value. */
  moveSelected(dt: number, dv: number): void {
    const m = this.motion;
    if (!m) return;
    const groups = this.byRow();
    const calls = groups.map(({ row, times }) => ({
      name: 'motion.moveKeys',
      args: {
        target: m.uid,
        curve: row.ref,
        times,
        dt,
        dv,
      },
    }));
    if (this.run(dt !== 0 ? 'Move keys' : 'Change key values', calls)) {
      const min = Math.min(...this.selected.map((s) => s.time));
      const shift = Math.max(dt, -min);
      for (const s of this.selected) s.time += shift;
    }
  }

  /** The value step of the arrow keys: a hundredth of the row's range. */
  nudgeValue(dir: 1 | -1): void {
    const m = this.motion;
    if (!m) return;
    const calls = this.byRow().map(({ row, times }) => ({
      name: 'motion.moveKeys',
      args: { target: m.uid, curve: row.ref, times, dv: (dir * (row.max - row.min)) / 100 },
    }));
    this.run('Change key values', calls);
  }

  setInterpolation(interp: Interpolation): void {
    const m = this.motion;
    if (!m) return;
    this.run(
      `Interpolation: ${INTERP_LABEL[interp]}`,
      this.byRow().map(({ row, times }) => ({
        name: 'motion.setInterpolation',
        args: { target: m.uid, curve: row.ref, times, interp },
      })),
    );
  }

  /** A new curve for a parameter, a part's opacity or a model value, keyed at the playhead. */
  addTrack(ref: CurveRef): void {
    const m = this.motion;
    if (!m) return;
    const t = this.playback.snap(this.playback.time);
    const value =
      ref.target === 'parameter' && ref.object
        ? this.editor.value(ref.object)
        : ref.target === 'partOpacity'
          ? 1
          : ref.model === 'Opacity'
            ? 1
            : 0;
    const ok = this.run('Add track', [
      { name: 'motion.insertKey', args: { target: m.uid, curve: ref, time: t, value } },
    ]);
    if (!ok) return;
    // The new row alone selected, with its own fades shown.
    this.rows.clear();
    this.rows.add(keyOf(ref));
    this.render();
  }

  /** Whether a viewport drag records keys now (the viewport asks; see `recordDrags`). */
  recordActive(): boolean {
    return this.recordDrags && !!this.motion && !this.playback.playing && this.animationActive();
  }

  /** Keys parameters at the playhead after a recording drag: one key per parameter per drag. */
  recordKeys(values: Map<Uid, number>): void {
    const m = this.motion;
    if (!m || values.size === 0) return;
    const t = this.playback.snap(this.playback.time);
    this.run(
      'Key from drag',
      [...values].map(([param, value]) => ({
        name: 'motion.insertKey',
        args: { target: m.uid, curve: { target: 'parameter', object: param }, time: t, value },
      })),
    );
  }

  private sliderKey(param: Uid, value: number): void {
    const m = this.motion;
    if (!m || !this.keyOnSlider || this.playback.playing || !this.animationActive()) return;
    clearTimeout(this.pending.get(param));
    this.pending.set(
      param,
      setTimeout(() => {
        this.pending.delete(param);
        const t = this.playback.snap(this.playback.time);
        this.run('Key from slider', [
          {
            name: 'motion.insertKey',
            args: { target: m.uid, curve: { target: 'parameter', object: param }, time: t, value },
          },
        ]);
      }, 250),
    );
  }

  // ---------------------------------------------------------------- events and fades

  async addEvent(): Promise<void> {
    const m = this.motion;
    if (!m) return;
    const value = await askText('Add event', 'Event value', 'event');
    if (value === null) return;
    const t = this.playback.snap(this.playback.time);
    this.run('Add event', [
      {
        name: 'motion.setEvents',
        args: { target: m.uid, events: [...m.events, { time: t, value }] },
      },
    ]);
  }

  // ---------------------------------------------------------------- work area and markers

  /** The times shown across the views: the view range (clamped), or the whole motion. */
  span(): { start: number; end: number } {
    const dur = this.motion?.duration || 1;
    const r = this.viewRange;
    if (!r) return { start: 0, end: dur };
    const start = Math.max(0, Math.min(r.start, dur));
    const end = Math.min(dur, Math.max(r.end, start));
    return end - start > EPS ? { start, end } : { start: 0, end: dur };
  }

  private setWorkArea(wa: { start: number; end: number } | null, label: string): void {
    const m = this.motion;
    if (!m) return;
    this.run(label, [{ name: 'motion.update', args: { target: m.uid, workArea: wa } }]);
  }

  /** Shift+Home: the work area starts at the playhead (and ends where it did, or at the end). */
  setWorkAreaStart(): void {
    const m = this.motion;
    if (!m) return;
    const t = this.playback.snap(this.playback.time);
    const end = this.playback.workArea?.end ?? m.duration;
    if (t >= end - EPS) {
      this.editor.emit('message', {
        level: 'warning',
        text: 'The work area must start before it ends: move the playhead earlier.',
      });
      return;
    }
    this.setWorkArea({ start: t, end }, 'Set work area start');
  }

  /** Shift+End: the work area ends at the playhead (and starts where it did, or at 0). */
  setWorkAreaEnd(): void {
    const m = this.motion;
    if (!m) return;
    const t = this.playback.snap(this.playback.time);
    const start = this.playback.workArea?.start ?? 0;
    if (t <= start + EPS) {
      this.editor.emit('message', {
        level: 'warning',
        text: 'The work area must end after it starts: move the playhead later.',
      });
      return;
    }
    this.setWorkArea({ start, end: t }, 'Set work area end');
  }

  clearWorkArea(): void {
    if (this.motion?.workArea) this.setWorkArea(null, 'Clear work area');
  }

  /** Shift+F: shows the work area across the views; again (or without one), the whole motion. */
  fitWorkArea(): void {
    const wa = this.playback.workArea;
    const r = this.viewRange;
    const fitted = wa && r && Math.abs(r.start - wa.start) < EPS && Math.abs(r.end - wa.end) < EPS;
    this.viewRange = wa && !fitted ? { ...wa } : null;
    this.render();
  }

  private setMarkers(markers: { time: number; name: string }[], label: string): void {
    const m = this.motion;
    if (!m) return;
    this.run(label, [{ name: 'motion.setMarkers', args: { target: m.uid, markers } }]);
  }

  /** Adds a marker at a time (the playhead by default), asking for its name. */
  async addMarker(time = this.playback.time, name?: string): Promise<void> {
    const m = this.motion;
    if (!m) return;
    const n = name ?? (await askText('Add marker', 'Marker name', `M${m.markers.length + 1}`));
    if (n === null) return;
    const t = this.playback.snap(Math.max(0, Math.min(m.duration, time)));
    this.setMarkers([...m.markers, { time: t, name: n }], 'Add marker');
  }

  private async renameMarker(i: number): Promise<void> {
    const m = this.motion;
    const mk = m?.markers[i];
    if (!m || !mk) return;
    const n = await askText('Rename marker', 'Marker name', mk.name);
    if (n === null || n === mk.name) return;
    this.setMarkers(
      m.markers.map((x, j) => (j === i ? { ...x, name: n } : x)),
      'Rename marker',
    );
  }

  private removeMarker(i: number): void {
    const m = this.motion;
    if (!m) return;
    this.setMarkers(
      m.markers.filter((_, j) => j !== i),
      'Delete marker',
    );
  }

  /** The Dope Sheet's top lane: the work area as a band, the markers, and the playhead. */
  private markerLane(m: Motion): HTMLElement {
    const { start: a, end: b } = this.span();
    const len = b - a;
    const pct = (t: number) => `${(100 * (t - a)) / len}%`;
    const lane = h('div.track-lane.markers', {
      dataset: { lane: 'Markers' },
      title:
        'Click: go there. Ctrl+click: add a marker. Drag a marker to move it; double-click to rename; right-click for more.',
    });
    const timeAt = (clientX: number) => {
      const r = lane.getBoundingClientRect();
      return Math.max(0, Math.min(m.duration, a + ((clientX - r.left) / r.width) * len));
    };
    const wa = this.playback.workArea;
    if (wa)
      lane.append(
        h('span.work-area', {
          style: `left:${pct(wa.start)};width:${(100 * (wa.end - wa.start)) / len}%`,
          title: `Work area: ${round(wa.start, 3)}–${round(wa.end, 3)} s`,
          dataset: { testid: 'work-area' },
        }),
      );
    m.markers.forEach((mk, i) => {
      const el = h('span.marker', {
        style: `left:${pct(mk.time)}`,
        title: `${mk.name} · ${round(mk.time, 3)} s`,
        dataset: { marker: mk.name },
      });
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const [x0, r] = [e.clientX, lane.getBoundingClientRect()];
        const left = parseFloat(el.style.left);
        const move = (mv: PointerEvent) =>
          (el.style.left = `${left + ((mv.clientX - x0) / r.width) * 100}%`);
        const up = (u: PointerEvent) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          const dt = this.playback.snap(((u.clientX - x0) / r.width) * len);
          if (Math.abs(dt) > EPS)
            this.setMarkers(
              m.markers.map((x, j) =>
                j === i ? { ...x, time: Math.max(0, Math.min(m.duration, x.time + dt)) } : x,
              ),
              'Move marker',
            );
          else this.playback.seek(mk.time);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        void this.renameMarker(i);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        popupMenu(e, [
          { label: 'Rename…', run: () => void this.renameMarker(i) },
          { label: 'Delete', testid: 'marker-delete', run: () => this.removeMarker(i) },
        ]);
      });
      lane.append(el);
    });
    lane.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).classList.contains('marker')) return;
      const t = timeAt(e.clientX);
      if (e.ctrlKey || e.metaKey) void this.addMarker(t);
      else this.playback.seek(this.playback.snap(t));
    });
    lane.append(h('span.playhead', { style: `left:${pct(this.playback.time)}` }));
    return lane;
  }

  // ---------------------------------------------------------------- rendering

  private onTime(): void {
    if (!this.el.isConnected) return;
    const m = this.motion;
    const { start: a, end: b } = this.span();
    const ph = this.el.querySelectorAll<HTMLElement>('.playhead');
    for (const p of ph) p.style.left = `${(100 * (this.playback.time - a)) / (b - a)}%`;
    const r = this.el.querySelector('[data-testid="timeline-readout"]');
    if (r) r.textContent = `${round(this.playback.time, 3)} / ${round(m?.duration ?? 0, 3)} s`;
    const range = this.el.querySelector<HTMLInputElement>('[data-testid="timeline-time"]');
    if (range && document.activeElement !== range) range.value = String(this.playback.time);
    const play = this.el.querySelector('[data-testid="play"]');
    if (play) play.textContent = this.playback.playing ? '■ Stop' : '▶ Play';
    if (this.mode === 'graph') this.drawGraph();
    // A new motion selected: draw it.
    if (this.el.dataset.motion !== (this.motion?.uid ?? '')) this.render();
  }

  switchMode(): void {
    this.mode = this.mode === 'dope' ? 'graph' : 'dope';
    this.render();
  }

  render(): void {
    const m = this.motion;
    if (this.el.dataset.motion !== (m?.uid ?? '')) this.viewRange = null;
    this.el.dataset.motion = m?.uid ?? '';
    if (!m) {
      fill(this.el, h('div.empty', 'Pick a motion in the Scene palette.'));
      return;
    }
    const pb = this.playback;
    const key = (id: string) => (this.keymap.shortcut(id) ? ` (${this.keymap.shortcut(id)})` : '');
    const rows = this.rowList();
    const num = (
      value: number | null,
      change: (n: number | null) => void,
      testid: string,
      title: string,
    ) =>
      h('input.num', {
        type: 'number',
        min: '0',
        step: '0.1',
        title,
        placeholder: 'default',
        value: value === null ? '' : String(value),
        dataset: { testid },
        on: {
          change: (e) => {
            const s = (e.target as HTMLInputElement).value;
            change(s === '' ? null : Number(s));
          },
        },
      });
    const v = this.editor.view;
    const addTrack = h(
      'select',
      {
        dataset: { testid: 'track-add' },
        on: {
          change: (e) => {
            const s = (e.target as HTMLSelectElement).value;
            (e.target as HTMLSelectElement).value = '';
            if (!s) return;
            const [target, id] = s.split(':') as [CurveRef['target'], string];
            this.addTrack(
              target === 'model'
                ? { target, model: id as CurveRef['model'] }
                : { target, object: id },
            );
          },
        },
      },
      h('option', { value: '' }, '+ Track…'),
      h(
        'optgroup',
        { label: 'Parameters' },
        v
          .project()
          .parameterOrder.map((u) =>
            h('option', { value: `parameter:${u}` }, v.getAs(u, 'parameter').exportId),
          ),
      ),
      h(
        'optgroup',
        { label: 'Part opacity' },
        v.ofKind('part').map((p) => h('option', { value: `partOpacity:${p.uid}` }, p.exportId)),
      ),
      h(
        'optgroup',
        { label: 'Model' },
        (['EyeBlink', 'LipSync', 'Opacity'] as const).map((x) =>
          h('option', { value: `model:${x}` }, x),
        ),
      ),
    );
    fill(
      this.el,
      h(
        'div.palette-bar',
        h(
          'button',
          { dataset: { testid: 'play' }, on: { click: () => pb.toggle() } },
          pb.playing ? '■ Stop' : '▶ Play',
        ),
        h(
          'button',
          { title: `Previous frame${key('anim.prevFrame')}`, on: { click: () => pb.step(-1) } },
          '◀',
        ),
        h(
          'button',
          { title: `Next frame${key('anim.nextFrame')}`, on: { click: () => pb.step(1) } },
          '▶',
        ),
        h(
          'span.extra',
          { dataset: { testid: 'timeline-readout' } },
          `${round(pb.time, 3)} / ${round(m.duration, 3)} s`,
        ),
        h(
          'button.mode',
          {
            title: `Switch Edit Mode${key('anim.switchMode')}`,
            dataset: { testid: 'timeline-mode' },
            on: { click: () => this.switchMode() },
          },
          this.mode === 'dope' ? 'Dope Sheet' : 'Graph Editor',
        ),
        h(
          'button',
          {
            title: 'Key the selected rows (or all) at the playhead',
            dataset: { testid: 'key-here' },
            on: { click: () => this.insertKeyHere() },
          },
          '◆ Key',
        ),
        addTrack,
        h(
          'button.menu-button',
          {
            title: 'Timeline menu',
            dataset: { testid: 'timeline-menu' },
            on: { click: (e) => this.menu(e as MouseEvent) },
          },
          '⋯',
        ),
      ),
      h(
        'div.palette-bar.motion-props',
        h(
          'label.toggle',
          'Length',
          h('input.num', {
            type: 'number',
            min: '0',
            step: '0.1',
            value: String(m.duration),
            dataset: { testid: 'motion-duration' },
            on: {
              change: (e) =>
                this.run('Motion length', [
                  {
                    name: 'motion.update',
                    args: { target: m.uid, duration: Number((e.target as HTMLInputElement).value) },
                  },
                ]),
            },
          }),
        ),
        h(
          'label.toggle',
          'fps',
          h('input.num', {
            type: 'number',
            min: '1',
            step: '1',
            value: String(m.fps),
            on: {
              change: (e) =>
                this.run('Motion fps', [
                  {
                    name: 'motion.update',
                    args: { target: m.uid, fps: Number((e.target as HTMLInputElement).value) },
                  },
                ]),
            },
          }),
        ),
        h(
          'label.toggle',
          h('input', {
            type: 'checkbox',
            checked: m.loop,
            on: {
              change: (e) =>
                this.run('Motion loop', [
                  {
                    name: 'motion.update',
                    args: { target: m.uid, loop: (e.target as HTMLInputElement).checked },
                  },
                ]),
            },
          }),
          'Loop',
        ),
        h(
          'label.toggle',
          'Fade in',
          num(
            m.fadeIn,
            (n) =>
              this.run('Motion fade', [
                { name: 'motion.update', args: { target: m.uid, fadeIn: n } },
              ]),
            'motion-fade-in',
            'Fade-in time (s)',
          ),
        ),
        h(
          'label.toggle',
          'out',
          num(
            m.fadeOut,
            (n) =>
              this.run('Motion fade', [
                { name: 'motion.update', args: { target: m.uid, fadeOut: n } },
              ]),
            'motion-fade-out',
            'Fade-out time (s)',
          ),
        ),
        this.soundControls(m),
        h(
          'label.toggle',
          { title: 'Moving a parameter slider keys it at the playhead (Animation workspace)' },
          h('input', {
            type: 'checkbox',
            checked: this.keyOnSlider,
            dataset: { testid: 'key-on-slider' },
            on: { change: (e) => (this.keyOnSlider = (e.target as HTMLInputElement).checked) },
          }),
          'Key sliders',
        ),
        h(
          'label.toggle',
          {
            title:
              'Turning a rotation deformer in the view (edit levels 2 and 3) keys the parameters that turn it',
          },
          h('input', {
            type: 'checkbox',
            checked: this.recordDrags,
            dataset: { testid: 'record-drags' },
            on: { change: (e) => (this.recordDrags = (e.target as HTMLInputElement).checked) },
          }),
          'Record drags',
        ),
        h(
          'label.toggle',
          { title: 'Moving the playhead shows physics as it would be at that time' },
          h('input', {
            type: 'checkbox',
            checked: pb.scrubPhysics,
            dataset: { testid: 'scrub-physics' },
            on: {
              change: (e) => {
                pb.scrubPhysics = (e.target as HTMLInputElement).checked;
                pb.seek(pb.time);
              },
            },
          }),
          'Physics',
        ),
      ),
      this.mode === 'graph' ? this.graphBar() : null,
      h('input.range.time', {
        type: 'range',
        min: '0',
        max: String(m.duration || 1),
        step: String(pb.frame),
        value: String(pb.time),
        dataset: { testid: 'timeline-time' },
        on: { input: (e) => pb.seek(Number((e.target as HTMLInputElement).value)) },
      }),
      this.mode === 'dope' ? this.dopeSheet(m, rows) : this.graphEditor(rows),
      this.rowProps(m, rows),
    );
    if (this.mode === 'graph') requestAnimationFrame(() => this.drawGraph());
  }

  private menu(e: MouseEvent): void {
    const n = this.selected.length;
    popupMenu(e, [
      { label: 'Insert keys at the playhead', run: () => this.insertKeyHere() },
      {
        label: 'Copy keys',
        key: this.keymap.shortcut('anim.copyKeys'),
        disabled: n === 0,
        run: () => this.copySelected(),
      },
      {
        label: 'Cut keys',
        key: this.keymap.shortcut('anim.cutKeys'),
        disabled: n === 0,
        run: () => this.cutSelected(),
      },
      {
        label: 'Paste keys',
        key: this.keymap.shortcut('anim.pasteKeys'),
        disabled: this.clip.length === 0,
        run: () => this.paste(),
      },
      {
        label: 'Paste Keyframes to Selected Rows…',
        disabled: this.clip.length === 0 || this.rows.size === 0,
        testid: 'paste-to-rows',
        run: () => this.pasteToRowsDialog(),
      },
      {
        label: 'Delete keys',
        key: this.keymap.shortcut('anim.deleteKeys'),
        disabled: n === 0,
        run: () => this.deleteSelected(),
      },
      null,
      {
        label: 'Adjust Spacing…',
        disabled: n < 2,
        testid: 'adjust-spacing',
        run: () => this.spacingDialog(),
      },
      {
        label: 'Reverse Keyframes',
        disabled: n === 0,
        testid: 'reverse-keys',
        run: () => this.reverse(),
      },
      null,
      { label: 'Add event at the playhead…', run: () => void this.addEvent() },
      {
        label: 'Markers to Events',
        testid: 'markers-to-events',
        disabled: !this.motion?.markers.length,
        run: () =>
          this.motion &&
          this.run('Markers to events', [
            { name: 'motion.markersToEvents', args: { target: this.motion.uid } },
          ]),
      },
      null,
      {
        label: 'Set Work Area Start',
        key: this.keymap.shortcut('anim.workAreaStart'),
        run: () => this.setWorkAreaStart(),
      },
      {
        label: 'Set Work Area End',
        key: this.keymap.shortcut('anim.workAreaEnd'),
        run: () => this.setWorkAreaEnd(),
      },
      {
        label: 'Clear Work Area',
        disabled: !this.motion?.workArea,
        run: () => this.clearWorkArea(),
      },
      {
        label: 'Fit Work Area in View',
        key: this.keymap.shortcut('anim.fitWorkArea'),
        run: () => this.fitWorkArea(),
      },
      { label: 'Add marker at the playhead…', run: () => void this.addMarker() },
      null,
      {
        label: 'Snap keys to frames',
        checked: this.options.snapFrames,
        run: () => ((this.options.snapFrames = !this.options.snapFrames), this.render()),
      },
      {
        label: 'Graph: snap values to the grid',
        checked: this.options.snapValues,
        run: () => ((this.options.snapValues = !this.options.snapValues), this.render()),
      },
      {
        label: 'Graph: snap to neighbouring keys’ values',
        checked: this.options.snapNeighbours,
        run: () => ((this.options.snapNeighbours = !this.options.snapNeighbours), this.render()),
      },
      {
        label: 'Graph: edit handles as continuous',
        checked: this.options.continuous,
        run: () => ((this.options.continuous = !this.options.continuous), this.render()),
      },
    ]);
  }

  pasteToRowsDialog(): void {
    const how = h(
      'select',
      { dataset: { testid: 'paste-how' } },
      h('option', { value: 'ratio' }, 'Scale values by the ranges’ ratio'),
      h('option', { value: 'clamp' }, 'Clamp values to the target’s range'),
      h('option', { value: 'asIs' }, 'Copy values as they are (not advised)'),
    );
    const d = dialog(
      'Paste Keyframes to Selected Rows',
      [
        h(
          'div.facts',
          `The first copied curve's keys go onto ${this.rows.size} selected row(s), the earliest at the playhead.`,
        ),
        h('label.field', h('span', 'When ranges differ'), how),
        h(
          'div.buttons',
          h(
            'button.primary',
            {
              dataset: { testid: 'paste-ok' },
              on: {
                click: () => {
                  d.close();
                  this.pasteToRows(how.value as 'ratio' | 'clamp' | 'asIs');
                },
              },
            },
            'Paste',
          ),
          h('button', { on: { click: () => d.close() } }, 'Cancel'),
        ),
      ],
      { testid: 'paste-rows' },
    );
  }

  spacingDialog(): void {
    const pct = h('input', {
      type: 'number',
      value: '100',
      step: '5',
      dataset: { testid: 'spacing-percent' },
    });
    const d = dialog(
      'Adjust Spacing',
      [
        h('label.field', h('span', 'Spacing (%)'), pct),
        h(
          'div.hint',
          'Stretches (over 100) or squeezes (under 100) the selected keys’ spacing, from the earliest one.',
        ),
        h(
          'div.buttons',
          h(
            'button.primary',
            {
              dataset: { testid: 'spacing-ok' },
              on: {
                click: () => {
                  d.close();
                  this.adjustSpacing(Number(pct.value) || 100);
                },
              },
            },
            'OK',
          ),
          h('button', { on: { click: () => d.close() } }, 'Cancel'),
        ),
      ],
      { testid: 'spacing' },
    );
  }

  /** The selected row's own fades (one row selected). */
  private rowProps(m: Motion, rows: Row[]): HTMLElement | null {
    if (this.rows.size !== 1) return null;
    const row = rows.find((r) => this.rows.has(r.key));
    if (!row) return null;
    const fade = (k: 'fadeIn' | 'fadeOut') =>
      h('input.num', {
        type: 'number',
        min: '0',
        step: '0.1',
        placeholder: 'motion’s',
        value: row.curve[k] === null ? '' : String(row.curve[k]),
        dataset: { testid: `curve-${k}` },
        on: {
          change: (e) => {
            const s = (e.target as HTMLInputElement).value;
            this.run('Curve fade', [
              {
                name: 'motion.setCurve',
                args: {
                  target: m.uid,
                  curve: {
                    ...row.ref,
                    segments: row.curve.segments,
                    auto: row.curve.auto,
                    fadeIn: k === 'fadeIn' ? (s === '' ? null : Number(s)) : row.curve.fadeIn,
                    fadeOut: k === 'fadeOut' ? (s === '' ? null : Number(s)) : row.curve.fadeOut,
                  },
                },
              },
            ]);
          },
        },
      });
    return h(
      'div.palette-bar.row-props',
      h('b', row.label),
      h('label.toggle', 'Fade in', fade('fadeIn')),
      h('label.toggle', 'out', fade('fadeOut')),
      h(
        'button',
        {
          on: {
            click: () => {
              this.run('Remove track', [
                {
                  name: 'motion.removeCurve',
                  args: {
                    target: m.uid,
                    curveTarget: row.ref.target,
                    model: row.ref.model,
                    object: row.ref.object,
                  },
                },
              ]);
              this.rows.clear();
            },
          },
        },
        'Remove track',
      ),
    );
  }

  private trackName(row: Row, i: number): HTMLElement {
    return h(
      'span.track-name',
      {
        class: this.rows.has(row.key) ? 'on' : '',
        style: this.mode === 'graph' ? `color:${COLORS[i % COLORS.length]}` : '',
        title: 'Click to select the row (Ctrl or Shift: add)',
        dataset: { row: row.label },
        on: {
          click: (e) => {
            const me = e as MouseEvent;
            if (!(me.ctrlKey || me.metaKey || me.shiftKey)) this.rows.clear();
            if (this.rows.has(row.key) && (me.ctrlKey || me.metaKey)) this.rows.delete(row.key);
            else this.rows.add(row.key);
            this.render();
          },
        },
      },
      row.label,
    );
  }

  // ---------------------------------------------------------------- Dope Sheet

  private dopeSheet(m: Motion, rows: Row[]): HTMLElement {
    const dur = m.duration || 1;
    const { start: a, end: b } = this.span();
    const len = b - a;
    const pct = (t: number) => `${(100 * (t - a)) / len}%`;
    const timeAt = (lane: HTMLElement, clientX: number) => {
      const r = lane.getBoundingClientRect();
      return Math.max(0, Math.min(dur, a + ((clientX - r.left) / r.width) * len));
    };
    const lane = (row: Row) => {
      const el = h('div.track-lane', { dataset: { lane: row.label } });
      el.addEventListener('pointerdown', (e) => {
        if (e.target !== el || e.button !== 0) return;
        const t = timeAt(el, e.clientX);
        if (e.ctrlKey || e.metaKey) this.insertAt(row, t);
        else {
          if (!e.shiftKey) this.selected.length = 0;
          this.playback.seek(this.playback.snap(t));
          this.render();
        }
      });
      for (const k of this.keysOf(row)) {
        const mark = h('span.keyframe', {
          class: `${this.isSelected(row.key, k.time) ? 'on' : ''} ${k.interp}`,
          style: `left:${pct(k.time)}`,
          title: `${round(k.time, 3)} s: ${round(k.value, 4)} (${INTERP_LABEL[k.interp]})`,
          dataset: { key: `${row.label}@${round(k.time, 4)}` },
        });
        mark.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          if (e.button !== 0) return;
          if (e.ctrlKey || e.metaKey) {
            // The insert modifier on a key deletes it.
            this.run('Delete key', [
              {
                name: 'motion.deleteKeys',
                args: { target: m.uid, curve: row.ref, times: [k.time] },
              },
            ]);
            return;
          }
          // Measured before selecting: the selection draws the lanes anew.
          const r = el.getBoundingClientRect();
          const already = this.isSelected(row.key, k.time) && !e.shiftKey;
          if (!already) this.selectKey(row.key, k.time, e.shiftKey);
          // A click without a drag on a key of a selection selects only that key.
          this.dragKeys(e, r, len, () => already && this.selectKey(row.key, k.time, false));
        });
        el.append(mark);
      }
      el.append(h('span.playhead', { style: `left:${pct(this.playback.time)}` }));
      return el;
    };
    const events = h('div.track-lane.events', { dataset: { lane: 'Events' } });
    m.events.forEach((ev, i) => {
      const mark = h('span.event', {
        class: this.eventsSelected.has(i) ? 'on' : '',
        style: `left:${pct(ev.time)}`,
        title: `${round(ev.time, 3)} s: ${ev.value}`,
        dataset: { event: ev.value },
      });
      mark.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (!e.shiftKey) this.eventsSelected.clear();
        this.eventsSelected.add(i);
        const [x0, r] = [e.clientX, events.getBoundingClientRect()];
        const up = (u: PointerEvent) => {
          window.removeEventListener('pointerup', up);
          const dt = this.playback.snap(((u.clientX - x0) / r.width) * len);
          if (Math.abs(dt) > EPS)
            this.run('Move event', [
              {
                name: 'motion.setEvents',
                args: {
                  target: m.uid,
                  events: m.events.map((x, j) =>
                    j === i ? { ...x, time: Math.max(0, Math.min(dur, x.time + dt)) } : x,
                  ),
                },
              },
            ]);
          else this.render();
        };
        window.addEventListener('pointerup', up);
      });
      events.append(mark);
    });
    events.addEventListener('pointerdown', (e) => {
      if (e.target === events && (e.ctrlKey || e.metaKey)) {
        this.playback.seek(this.playback.snap(timeAt(events, e.clientX)));
        void this.addEvent();
      }
    });
    return h(
      'div.dope-sheet',
      h('div.track', h('span.track-name.dim', 'Markers'), this.markerLane(m)),
      h('div.track', h('span.track-name.dim', 'Events'), events),
      rows.length
        ? rows.map((r, i) => h('div.track', this.trackName(r, i), lane(r)))
        : h('div.empty', 'No tracks yet: add one, or move a slider with Key sliders on.'),
    );
  }

  /** Drags the selected keys in time (Dope Sheet), snapped to frames. */
  private dragKeys(e: PointerEvent, r: DOMRect, dur: number, click: () => void): void {
    const x0 = e.clientX;
    const marks = [...this.el.querySelectorAll<HTMLElement>('.keyframe.on')];
    const lefts = marks.map((mk) => parseFloat(mk.style.left));
    const move = (mv: PointerEvent) => {
      const dx = ((mv.clientX - x0) / r.width) * 100;
      marks.forEach((mk, i) => (mk.style.left = `${lefts[i]! + dx}%`));
    };
    const up = (u: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      let dt = ((u.clientX - x0) / r.width) * dur;
      if (this.options.snapFrames) dt = this.playback.snap(dt);
      if (Math.abs(dt) > EPS) this.moveSelected(dt, 0);
      else {
        click();
        this.render();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------------------------------------------------------------- Graph Editor

  private graphBar(): HTMLElement {
    return h(
      'div.palette-bar.interp',
      INTERPOLATIONS.map((i) =>
        h(
          'button',
          {
            disabled: this.selected.length === 0,
            title: `The segment after each selected key: ${INTERP_LABEL[i]}`,
            dataset: { testid: `interp-${i}` },
            on: { click: () => this.setInterpolation(i) },
          },
          INTERP_LABEL[i],
        ),
      ),
    );
  }

  /** The rows the Graph Editor draws: the selected rows, or all. */
  private graphRows(): Row[] {
    const rows = this.rowList();
    const sel = rows.filter((r) => this.rows.has(r.key));
    return sel.length ? sel : rows;
  }

  private graphEditor(rows: Row[]): HTMLElement {
    this.canvas = h('canvas.graph', { dataset: { testid: 'graph' } });
    this.bindGraph(this.canvas);
    return h(
      'div.graph-editor',
      h(
        'div.graph-rows',
        rows.map((r, i) => this.trackName(r, i)),
      ),
      this.canvas,
    );
  }

  /** Screen mapping of the Graph Editor: time across, each row's value range scaled to the height. */
  private graphMap() {
    const c = this.canvas!;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    const { start: a, end: b } = this.span();
    const len = b - a;
    const rows = this.graphRows();
    // One shared value range over the drawn rows (their ranges).
    const lo = Math.min(...rows.map((r) => r.min), 0);
    const hi = Math.max(...rows.map((r) => r.max), 1);
    const pad = 12;
    const x = (t: number) => pad + ((t - a) / len) * (w - 2 * pad);
    const y = (v: number) => hh - pad - ((v - lo) / (hi - lo || 1)) * (hh - 2 * pad);
    const t = (px: number) => a + ((px - pad) / (w - 2 * pad)) * len;
    const v = (py: number) => lo + ((hh - pad - py) / (hh - 2 * pad)) * (hi - lo || 1);
    return { x, y, t, v, w, hh, lo, hi, rows };
  }

  drawGraph(): void {
    const c = this.canvas;
    if (!c || !c.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const M = this.graphMap();
    g.clearRect(0, 0, M.w, M.hh);
    // Grid: frames are too dense; tenths of the length and of the range.
    g.strokeStyle = 'rgba(120,130,150,0.18)';
    g.lineWidth = 1;
    const dur = this.motion?.duration || 1;
    const sp = this.span();
    // The work area as a band, and the markers as lines.
    const wa = this.playback.workArea;
    if (wa) {
      g.fillStyle = 'rgba(70,200,255,0.08)';
      g.fillRect(M.x(wa.start), 0, M.x(wa.end) - M.x(wa.start), M.hh);
    }
    g.strokeStyle = 'rgba(244,201,93,0.7)';
    for (const mk of this.motion?.markers ?? []) {
      g.beginPath();
      g.moveTo(M.x(mk.time), 0);
      g.lineTo(M.x(mk.time), M.hh);
      g.stroke();
    }
    g.strokeStyle = 'rgba(120,130,150,0.18)';
    for (let k = 0; k <= 10; k++) {
      const gt = sp.start + ((sp.end - sp.start) * k) / 10;
      g.beginPath();
      g.moveTo(M.x(gt), 0);
      g.lineTo(M.x(gt), M.hh);
      g.moveTo(0, M.y(M.lo + ((M.hi - M.lo) * k) / 10));
      g.lineTo(M.w, M.y(M.lo + ((M.hi - M.lo) * k) / 10));
      g.stroke();
    }
    const all = this.rowList();
    for (const row of M.rows) {
      const color = COLORS[all.indexOf(row) % COLORS.length]!;
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.beginPath();
      for (let px = 0; px <= M.w; px += 2) {
        const t = Math.max(0, Math.min(dur, M.t(px)));
        const val = sampleSegments(row.curve.segments, t);
        if (px === 0) g.moveTo(M.x(t), M.y(val));
        else g.lineTo(M.x(t), M.y(val));
      }
      g.stroke();
      const keys = this.keysOf(row);
      keys.forEach((k, i) => {
        const on = this.isSelected(row.key, k.time);
        // Handles of Bézier segments next to a selected key.
        const next = keys[i + 1];
        if (
          k.interp === 'bezier' &&
          k.handles &&
          next &&
          (on || this.isSelected(row.key, next.time))
        ) {
          g.strokeStyle = 'rgba(230,230,240,0.7)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(M.x(k.time), M.y(k.value));
          g.lineTo(M.x(k.handles[0]), M.y(k.handles[1]));
          g.moveTo(M.x(next.time), M.y(next.value));
          g.lineTo(M.x(k.handles[2]), M.y(k.handles[3]));
          g.stroke();
          for (const [ht, hv] of [
            [k.handles[0], k.handles[1]],
            [k.handles[2], k.handles[3]],
          ] as const) {
            g.fillStyle = '#e6e6f0';
            g.fillRect(M.x(ht) - 3, M.y(hv) - 3, 6, 6);
          }
        }
        g.beginPath();
        g.arc(M.x(k.time), M.y(k.value), on ? 5 : 4, 0, Math.PI * 2);
        g.fillStyle = on ? '#ffffff' : color;
        g.fill();
      });
    }
    // The box around several selected keys.
    const box = this.selectionBox(M);
    if (box) {
      g.strokeStyle = 'rgba(70,200,255,0.9)';
      g.setLineDash([4, 3]);
      g.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      g.setLineDash([]);
      g.fillStyle = '#46c8ff';
      g.fillRect(box.x1 - 4, (box.y0 + box.y1) / 2 - 4, 8, 8); // time scale
      g.fillRect((box.x0 + box.x1) / 2 - 4, box.y0 - 4, 8, 8); // value scale
    }
    // The playhead.
    g.strokeStyle = '#46c8ff';
    g.beginPath();
    g.moveTo(M.x(this.playback.time), 0);
    g.lineTo(M.x(this.playback.time), M.hh);
    g.stroke();
    if (this.drag?.kind === 'box') {
      const d = this.drag;
      g.strokeStyle = '#46c8ff';
      g.setLineDash([3, 3]);
      g.strokeRect(d.x0, d.y0, d.x - d.x0, d.y - d.y0);
      g.setLineDash([]);
    }
  }

  private selectionBox(M: ReturnType<TimelinePalette['graphMap']>) {
    if (this.selected.length < 2) return null;
    const pts: [number, number][] = [];
    for (const row of M.rows)
      for (const k of this.keysOf(row))
        if (this.isSelected(row.key, k.time)) pts.push([M.x(k.time), M.y(k.value)]);
    if (pts.length < 2) return null;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return {
      x0: Math.min(...xs) - 6,
      y0: Math.min(...ys) - 6,
      x1: Math.max(...xs) + 6,
      y1: Math.max(...ys) + 6,
    };
  }

  private drag: { kind: 'box'; x0: number; y0: number; x: number; y: number } | null = null;

  /** What lies under a point of the Graph Editor: a key, a handle, the box's handles, or nothing. */
  private graphHit(px: number, py: number) {
    const M = this.graphMap();
    const box = this.selectionBox(M);
    if (box) {
      if (Math.hypot(px - box.x1, py - (box.y0 + box.y1) / 2) < 7)
        return { kind: 'scaleTime' as const, box };
      if (Math.hypot(px - (box.x0 + box.x1) / 2, py - box.y0) < 7)
        return { kind: 'scaleValue' as const, box };
    }
    for (const row of M.rows) {
      const keys = this.keysOf(row);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (Math.hypot(px - M.x(k.time), py - M.y(k.value)) < 7)
          return { kind: 'key' as const, row, key: k };
        const next = keys[i + 1];
        if (
          k.interp === 'bezier' &&
          k.handles &&
          next &&
          (this.isSelected(row.key, k.time) || this.isSelected(row.key, next.time))
        ) {
          if (Math.hypot(px - M.x(k.handles[0]), py - M.y(k.handles[1])) < 6)
            return { kind: 'handle' as const, row, key: k, which: 0 as const, next };
          if (Math.hypot(px - M.x(k.handles[2]), py - M.y(k.handles[3])) < 6)
            return { kind: 'handle' as const, row, key: k, which: 1 as const, next };
        }
      }
    }
    if (box && px > box.x0 && px < box.x1 && py > box.y0 && py < box.y1)
      return { kind: 'boxMove' as const, box };
    return null;
  }

  private bindGraph(c: HTMLCanvasElement): void {
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = c.getBoundingClientRect();
      const [px, py] = [e.clientX - r.left, e.clientY - r.top];
      const M = this.graphMap();
      const hit = this.graphHit(px, py);
      const m = this.motion;
      if (!m) return;
      c.setPointerCapture(e.pointerId);
      if (!hit) {
        if (e.ctrlKey || e.metaKey) {
          // Insert on the curve of the first drawn row at this time, on the curve (or at the pointer's value with Alt).
          const row = M.rows[0];
          if (!row) return;
          const t = this.playback.snap(M.t(px));
          const value = e.altKey ? M.v(py) : sampleSegments(row.curve.segments, t);
          this.run('Insert key', [
            { name: 'motion.insertKey', args: { target: m.uid, curve: row.ref, time: t, value } },
          ]);
          return;
        }
        this.drag = { kind: 'box', x0: px, y0: py, x: px, y: py };
        const move = (mv: PointerEvent) => {
          this.drag!.x = mv.clientX - r.left;
          this.drag!.y = mv.clientY - r.top;
          this.drawGraph();
        };
        const up = () => {
          c.removeEventListener('pointermove', move);
          c.removeEventListener('pointerup', up);
          const d = this.drag!;
          this.drag = null;
          if (!e.shiftKey) this.selected.length = 0;
          const [x0, x1] = [Math.min(d.x0, d.x), Math.max(d.x0, d.x)];
          const [y0, y1] = [Math.min(d.y0, d.y), Math.max(d.y0, d.y)];
          if (x1 - x0 < 3 && y1 - y0 < 3) this.playback.seek(this.playback.snap(M.t(px)));
          for (const row of M.rows)
            for (const k of this.keysOf(row)) {
              const [kx, ky] = [M.x(k.time), M.y(k.value)];
              if (kx >= x0 && kx <= x1 && ky >= y0 && ky <= y1 && !this.isSelected(row.key, k.time))
                this.selected.push({ curve: row.key, time: k.time });
            }
          this.render();
        };
        c.addEventListener('pointermove', move);
        c.addEventListener('pointerup', up);
        return;
      }
      if (hit.kind === 'key' && (!this.isSelected(hit.row.key, hit.key.time) || e.shiftKey)) {
        // The canvas stays for the gesture: only redrawn, the palette drawn anew on release.
        this.selectKey(hit.row.key, hit.key.time, e.shiftKey, false);
        this.drawGraph();
        if (e.shiftKey) return void this.render();
      }
      const x0 = px;
      const y0 = py;
      const finish = (u: PointerEvent) => {
        const [ux, uy] = [u.clientX - r.left, u.clientY - r.top];
        let dt = M.t(ux) - M.t(x0);
        let dv = M.v(uy) - M.v(y0);
        if (u.shiftKey) {
          // Shift: only along the axis moved more.
          if (Math.abs(ux - x0) > Math.abs(uy - y0)) dv = 0;
          else dt = 0;
        }
        if (this.options.snapFrames) dt = this.playback.snap(dt);
        if (hit.kind === 'key' || hit.kind === 'boxMove') {
          if (hit.kind === 'key') dv = this.snapValue(hit.row, hit.key, dv, M);
          if (Math.abs(dt) > EPS || Math.abs(dv) > EPS) this.moveSelected(dt, dv);
        } else if (hit.kind === 'handle') {
          this.moveHandle(
            hit.row,
            hit.key,
            hit.next,
            hit.which,
            M.t(ux),
            M.v(uy),
            u.ctrlKey || u.metaKey,
          );
        } else if (hit.kind === 'scaleTime' || hit.kind === 'scaleValue') {
          this.scaleSelected(hit.kind, hit.box, ux, uy, M, u.altKey);
        }
      };
      const up = (u: PointerEvent) => {
        c.removeEventListener('pointerup', up);
        finish(u);
        this.render();
      };
      c.addEventListener('pointerup', up);
    });
  }

  /** Snaps a key's value change to the grid or to a neighbouring key's value (the options). */
  private snapValue(
    row: Row,
    key: MotionKey,
    dv: number,
    M: ReturnType<TimelinePalette['graphMap']>,
  ): number {
    let v = key.value + dv;
    if (this.options.snapValues) {
      const step = (M.hi - M.lo) / 20;
      v = Math.round(v / step) * step;
    }
    if (this.options.snapNeighbours) {
      const keys = this.keysOf(row);
      const i = keys.findIndex((k) => Math.abs(k.time - key.time) < EPS);
      for (const n of [keys[i - 1], keys[i + 1]])
        if (n && Math.abs(n.value - v) < (M.hi - M.lo) / 40) v = n.value;
    }
    return v - key.value;
  }

  /** A Bézier handle moved: the segment keeps its interpolation; continuous handles stay in line. */
  private moveHandle(
    row: Row,
    key: MotionKey,
    next: MotionKey,
    which: 0 | 1,
    t: number,
    v: number,
    invert: boolean,
  ): void {
    const m = this.motion!;
    const hd = [...key.handles!] as [number, number, number, number];
    if (which === 0) [hd[0], hd[1]] = [t, v];
    else [hd[2], hd[3]] = [t, v];
    const calls: { name: string; args: unknown }[] = [
      {
        name: 'motion.setInterpolation',
        args: { target: m.uid, curve: row.ref, times: [key.time], interp: 'bezier', handles: hd },
      },
    ];
    // Continuous (the option, or Ctrl when it is off): the handle on the key's other side mirrors.
    if (this.options.continuous !== invert) {
      const keys = this.keysOf(row);
      const i = keys.findIndex((k) => Math.abs(k.time - key.time) < EPS);
      const pivot = which === 0 ? key : next;
      const [dt, dvv] = [t - pivot.time, v - pivot.value];
      const other = which === 0 ? keys[i - 1] : keys[i + 1];
      if (other?.interp === 'bezier' && other.handles && which === 0) {
        const oh = [...other.handles] as [number, number, number, number];
        const len = Math.hypot(oh[2] - pivot.time, oh[3] - pivot.value);
        const n = Math.hypot(dt, dvv) || 1;
        [oh[2], oh[3]] = [pivot.time - (dt / n) * len, pivot.value - (dvv / n) * len];
        calls.push({
          name: 'motion.setInterpolation',
          args: {
            target: m.uid,
            curve: row.ref,
            times: [other.time],
            interp: 'bezier',
            handles: oh,
          },
        });
      } else if (which === 1 && next.interp === 'bezier' && next.handles) {
        const oh = [...next.handles] as [number, number, number, number];
        const len = Math.hypot(oh[0] - pivot.time, oh[1] - pivot.value);
        const n = Math.hypot(dt, dvv) || 1;
        [oh[0], oh[1]] = [pivot.time - (dt / n) * len, pivot.value - (dvv / n) * len];
        calls.push({
          name: 'motion.setInterpolation',
          args: {
            target: m.uid,
            curve: row.ref,
            times: [next.time],
            interp: 'bezier',
            handles: oh,
          },
        });
      }
    }
    this.run('Move handle', calls);
  }

  /** Box editing: the box's right handle scales timing from its left edge; its top handle scales values from its bottom (Alt: from the middle). */
  private scaleSelected(
    kind: 'scaleTime' | 'scaleValue',
    box: { x0: number; y0: number; x1: number; y1: number },
    ux: number,
    uy: number,
    M: ReturnType<TimelinePalette['graphMap']>,
    alt: boolean,
  ): void {
    if (kind === 'scaleTime') {
      const [a, b] = [M.t(box.x0 + 6), M.t(box.x1 - 6)];
      const f = (M.t(ux - 6) - a) / (b - a || 1);
      this.transformSelected('Scale keys in time', (keys, sel) => {
        for (const k of sel) {
          k.time = this.playback.snap(Math.max(0, a + (k.time - a) * f));
          if (k.handles)
            k.handles = [
              a + (k.handles[0] - a) * f,
              k.handles[1],
              a + (k.handles[2] - a) * f,
              k.handles[3],
            ];
        }
        return keys;
      });
    } else {
      const [lo, hi] = [M.v(box.y1 - 6), M.v(box.y0 + 6)];
      const pivot = alt ? (lo + hi) / 2 : lo;
      const f = (M.v(uy + 6) - pivot) / (hi - pivot || 1);
      this.transformSelected('Scale key values', (keys, sel) => {
        for (const k of sel) {
          k.value = pivot + (k.value - pivot) * f;
          if (k.handles)
            k.handles = [
              k.handles[0],
              pivot + (k.handles[1] - pivot) * f,
              k.handles[2],
              pivot + (k.handles[3] - pivot) * f,
            ];
        }
        return keys;
      });
    }
  }
}
