/**
 * Exporting a motion as images or video (Ctrl+I and Ctrl+Shift+M). The off-screen view plays the motion as Mochi2D does, physics included from the
 * motion's start (`Offscreen.frames`), and each frame becomes:
 *
 * - a PNG with transparency, for an image sequence (a zip in a browser, a folder on the desktop);
 * - a frame of a WebM video (VP9, else VP8), with an alpha channel when the background is
 *   transparent: the alpha is encoded as a second, grey stream and stored in each block's
 *   BlockAdditions (`WebmWriter`);
 * - or a frame of an MP4 video (H.264, through mp4-muxer), where the platform has an encoder.
 *   MP4 has no alpha, so it needs a background.
 *
 * Range: the whole motion, or its work area. Frames are numbered from the motion's start
 * (frame f is at f / fps seconds); a looping motion leaves out the frame at its very end, which is
 * its first again.
 */
import { MochiError, type Motion, type Uid } from '@mochi-maker/core';
import { planFiles, safeFileName } from '@mochi-maker/export';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { round, type Editor } from './editor.js';
import { dialog, type Dialog } from './dialogs.js';
import { h } from './dom.js';
import type { Offscreen } from './offscreen.js';
import { WebmWriter } from './webm.js';

export type MovieFormat = 'png' | 'webm' | 'mp4';

export interface MovieSettings {
  /** The motion (UID or reference). */
  motion: string;
  format: MovieFormat;
  width: number;
  height: number;
  fps: number;
  /** A CSS color, or null for transparent (not for MP4). */
  background: string | null;
  range: 'scene' | 'workArea';
}

export interface MovieResult {
  format: MovieFormat;
  /** File name to save (the video, or the zip's folder name). */
  name: string;
  /** PNG frames by name, or the one video file. */
  files: Map<string, Uint8Array>;
  frames: number;
  first: number;
  width: number;
  height: number;
  fps: number;
  alpha: boolean;
  codec: string | null;
  ms: number;
}

export interface MovieProgress {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

const WEBM_CODECS = [
  { codec: 'vp09.00.10.08', id: 'V_VP9' },
  { codec: 'vp8', id: 'V_VP8' },
] as const;
const MP4_CODECS = ['avc1.640033', 'avc1.4d0033', 'avc1.42003e', 'avc1.42001f'];

const hasEncoder = () => typeof VideoEncoder !== 'undefined';

async function supported(codec: string, width: number, height: number, avc = false) {
  try {
    const r = await VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      ...(avc ? { avc: { format: 'avc' as const } } : {}),
    });
    return r.supported === true;
  } catch {
    return false;
  }
}

/** The video codecs this platform can encode at a size (null: none). */
export async function videoSupport(
  width = 640,
  height = 480,
): Promise<{ webm: string | null; mp4: string | null }> {
  if (!hasEncoder()) return { webm: null, mp4: null };
  let webm: string | null = null;
  for (const c of WEBM_CODECS)
    if (await supported(c.codec, width, height)) {
      webm = c.codec;
      break;
    }
  let mp4: string | null = null;
  for (const c of MP4_CODECS)
    if (await supported(c, width, height, true)) {
      mp4 = c;
      break;
    }
  return { webm, mp4 };
}

/** The frames a range covers, at a frame rate. */
export function frameRange(
  m: Motion,
  range: 'scene' | 'workArea',
  fps: number,
): { first: number; last: number } {
  const wa = m.workArea;
  if (range === 'workArea' && !wa)
    throw new MochiError('E_RANGE', `${m.name} has no work area: set one, or export the scene.`);
  const start = range === 'workArea' ? Math.max(0, Math.min(wa!.start, m.duration)) : 0;
  const end = range === 'workArea' ? Math.max(start, Math.min(wa!.end, m.duration)) : m.duration;
  const first = Math.ceil(start * fps - 1e-6);
  let last = Math.floor(end * fps + 1e-6);
  // A loop's last instant is its first: leave it out when the range reaches the end.
  if (m.loop && Math.abs(end - m.duration) < 1e-6 && last > first) last--;
  if (last < first) throw new MochiError('E_RANGE', 'The range holds no frame at this frame rate.');
  return { first, last };
}

const even = (n: number) => Math.max(2, Math.ceil(n / 2) * 2);

/** Straight-alpha RGBA pixels of a PNG. */
export async function pixels(png: Blob, width: number, height: number): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(png, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const c = new OffscreenCanvas(width, height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.clearRect(0, 0, width, height);
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return g.getImageData(0, 0, width, height).data;
}

/** An I420 frame whose luma is the alpha (the WebM alpha stream). */
function alphaFrame(rgba: Uint8ClampedArray, width: number, height: number, timestamp: number) {
  const y = width * height;
  const c = (width / 2) * (height / 2);
  const buf = new Uint8Array(y + 2 * c);
  for (let i = 0; i < y; i++) buf[i] = rgba[i * 4 + 3]!;
  buf.fill(128, y);
  return new VideoFrame(buf, {
    format: 'I420',
    codedWidth: width,
    codedHeight: height,
    timestamp,
    colorSpace: { fullRange: true, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' },
  });
}

interface Encoded {
  data: Uint8Array;
  key: boolean;
  timestamp: number;
  meta?: EncodedVideoChunkMetadata;
}

/** A VideoEncoder that collects its chunks, with back-pressure. */
class Encoder {
  readonly chunks: Encoded[] = [];
  private failed: Error | null = null;
  private readonly enc: VideoEncoder;

  constructor(config: VideoEncoderConfig) {
    this.enc = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.chunks.push({ data, key: chunk.type === 'key', timestamp: chunk.timestamp, meta });
      },
      error: (e) => (this.failed = e as Error),
    });
    this.enc.configure(config);
  }

  async encode(frame: VideoFrame, keyFrame: boolean): Promise<void> {
    if (this.failed) throw this.failed;
    this.enc.encode(frame, { keyFrame });
    frame.close();
    while (this.enc.encodeQueueSize > 4)
      await new Promise((r) => this.enc.addEventListener('dequeue', r, { once: true }));
  }

  async finish(): Promise<Encoded[]> {
    await this.enc.flush();
    this.enc.close();
    if (this.failed) throw this.failed;
    return this.chunks;
  }

  close(): void {
    if (this.enc.state !== 'closed') this.enc.close();
  }
}

/** Renders and encodes a motion (see the module comment). */
export async function renderMovie(
  editor: Editor,
  offscreen: Offscreen,
  s: MovieSettings,
  progress: MovieProgress = {},
): Promise<MovieResult> {
  const t0 = performance.now();
  const doc = editor.view;
  const uid = doc.resolve(s.motion, ['motion'], 'motion') as Uid;
  const m = doc.getAs(uid, 'motion');
  if (!(s.fps > 0 && s.fps <= 120))
    throw new MochiError('E_RANGE', 'The frame rate must be 1–120.');
  if (!(s.width >= 2 && s.height >= 2 && s.width <= 4096 && s.height <= 4096))
    throw new MochiError('E_RANGE', 'The size must be 2–4096 pixels a side.');
  const video = s.format !== 'png';
  // Video encoders need even sizes.
  const width = video ? even(s.width) : Math.round(s.width);
  const height = video ? even(s.height) : Math.round(s.height);
  if (s.format === 'mp4' && !s.background)
    throw new MochiError('E_RANGE', 'MP4 has no transparency: choose a background color.');
  const alpha = s.format === 'png' ? !s.background : s.format === 'webm' && !s.background;
  const { first, last } = frameRange(m, s.range, s.fps);
  const total = last - first + 1;
  const settings = doc.project().exportSettings;
  const motionFile = planFiles(doc, settings.fileStem, 1, settings.atlasSize).motions.find(
    (x) => x.uid === uid,
  )?.file;
  if (!motionFile) throw new MochiError('E_EXPORT', `${m.name} is not in the export.`);
  const base = safeFileName(m.name) || 'motion';
  const files = new Map<string, Uint8Array>();
  let codec: string | null = null;
  let color: Encoder | null = null;
  let alphaEnc: Encoder | null = null;
  if (video) {
    if (!hasEncoder())
      throw new MochiError(
        'E_RENDER_UNAVAILABLE',
        'This browser cannot encode video (no WebCodecs).',
      );
    const support = await videoSupport(width, height);
    codec = s.format === 'webm' ? support.webm : support.mp4;
    if (!codec)
      throw new MochiError(
        'E_RENDER_UNAVAILABLE',
        `This platform has no ${s.format === 'webm' ? 'VP9 or VP8' : 'H.264'} encoder for ${width} × ${height}.`,
      );
    const bitrate = Math.round(Math.min(40e6, Math.max(1e6, width * height * s.fps * 0.12)));
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      framerate: s.fps,
      bitrate,
      latencyMode: 'quality',
      ...(s.format === 'mp4' ? { avc: { format: 'avc' as const } } : {}),
    };
    color = new Encoder(config);
    if (alpha) alphaEnc = new Encoder({ ...config, bitrate: Math.round(bitrate / 2) });
  }
  const digits = Math.max(4, String(last).length);
  let done = 0;
  try {
    await offscreen.frames(
      editor.doc,
      { motionFile, fps: s.fps, first, last, width, height, background: s.background },
      async (png, f) => {
        if (progress.signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
        if (!video) {
          files.set(
            `${base}_${String(f).padStart(digits, '0')}.png`,
            new Uint8Array(await png.arrayBuffer()),
          );
        } else {
          const i = f - first;
          const timestamp = Math.round((i * 1e6) / s.fps);
          const key = i % Math.max(1, Math.round(s.fps)) === 0;
          const rgba = await pixels(png, width, height);
          await color!.encode(
            new VideoFrame(rgba, {
              format: 'RGBA',
              codedWidth: width,
              codedHeight: height,
              timestamp,
            }),
            key,
          );
          if (alphaEnc) await alphaEnc.encode(alphaFrame(rgba, width, height, timestamp), key);
        }
        done++;
        progress.onProgress?.(done, total);
      },
    );
    if (video) {
      const chunks = await color!.finish();
      if (s.format === 'webm') {
        const alphaChunks = alphaEnc ? await alphaEnc.finish() : null;
        const w = new WebmWriter({
          width,
          height,
          fps: s.fps,
          codec: codec!.startsWith('vp8') ? 'V_VP8' : 'V_VP9',
          alpha: !!alphaChunks,
        });
        chunks.forEach((c, i) => {
          const a = alphaChunks?.find((x) => x.timestamp === c.timestamp) ?? alphaChunks?.[i];
          if (alphaChunks && !a) throw new MochiError('E_EXPORT', 'An alpha frame is missing.');
          w.addFrame(c.data, c.key, c.timestamp, a?.data);
        });
        files.set(`${base}.webm`, w.finish());
      } else {
        const target = new ArrayBufferTarget();
        const mux = new Muxer({
          target,
          video: { codec: 'avc', width, height, frameRate: s.fps },
          fastStart: 'in-memory',
        });
        for (const c of chunks)
          mux.addVideoChunkRaw(
            c.data,
            c.key ? 'key' : 'delta',
            c.timestamp,
            Math.round(1e6 / s.fps),
            c.meta,
          );
        mux.finalize();
        files.set(`${base}.mp4`, new Uint8Array(target.buffer));
      }
    }
  } finally {
    color?.close();
    alphaEnc?.close();
  }
  return {
    format: s.format,
    name: video ? [...files.keys()][0]! : base,
    files,
    frames: total,
    first,
    width,
    height,
    fps: s.fps,
    alpha,
    codec,
    ms: Math.round(performance.now() - t0),
  };
}

/** The default size: the model's canvas, scaled to fit 1280 pixels on its longer side. */
export function defaultMovieSize(editor: Editor): { width: number; height: number } {
  const c = editor.view.project().canvas;
  const k = Math.min(1, 1280 / Math.max(c.width, c.height, 1));
  return { width: even(c.width * k), height: even(c.height * k) };
}

/**
 * «Export Image Sequence…» (Ctrl+I) and «Export Video…» (Ctrl+Shift+M): the motion, size, frame
 * rate, background and range, then a progress bar with Cancel. `save` writes the result.
 */
export function movieDialog(
  editor: Editor,
  offscreen: Offscreen,
  kind: 'images' | 'video',
  current: Uid | null,
  save: (r: MovieResult) => Promise<void>,
): Dialog | null {
  const motions = editor.view.ofKind('motion');
  if (motions.length === 0) {
    editor.emit('message', {
      level: 'error',
      text: 'There are no motions to export: make one first.',
    });
    return null;
  }
  const size = defaultMovieSize(editor);
  const pick = motions.find((m) => m.uid === current) ?? motions[0]!;
  const num = (testid: string, value: number, min: number, max: number) =>
    h('input.num', {
      type: 'number',
      min: String(min),
      max: String(max),
      step: '1',
      value: String(value),
      dataset: { testid },
    }) as HTMLInputElement;
  const motion = h(
    'select',
    { dataset: { testid: 'movie-motion' } },
    motions.map((m) => h('option', { value: m.uid, selected: m.uid === pick.uid }, m.name)),
  ) as HTMLSelectElement;
  const width = num('movie-width', size.width, 2, 4096);
  const height = num('movie-height', size.height, 2, 4096);
  const fps = num('movie-fps', pick.fps || 30, 1, 120);
  const transparent = h('input', {
    type: 'checkbox',
    checked: true,
    dataset: { testid: 'movie-transparent' },
  }) as HTMLInputElement;
  const color = h('input', {
    type: 'color',
    value: '#ffffff',
    dataset: { testid: 'movie-color' },
  }) as HTMLInputElement;
  const range = h(
    'select',
    { dataset: { testid: 'movie-range' } },
    h('option', { value: 'scene' }, 'The whole scene'),
    h('option', { value: 'workArea' }, 'The work area'),
  ) as HTMLSelectElement;
  const format = h(
    'select',
    { dataset: { testid: 'movie-format' } },
    h('option', { value: 'webm' }, 'WebM (VP9; transparency kept)'),
    h('option', { value: 'mp4' }, 'MP4 (H.264; needs a background)'),
  ) as HTMLSelectElement;
  const info = h('div.facts', { dataset: { testid: 'movie-info' } });
  const bar = h('progress', { max: '1', value: '0', dataset: { testid: 'movie-progress' } });
  const status = h('div.facts', { dataset: { testid: 'movie-status' } });
  let controller: AbortController | null = null;
  const settings = (): MovieSettings => ({
    motion: motion.value,
    format: kind === 'images' ? 'png' : (format.value as MovieFormat),
    width: Number(width.value),
    height: Number(height.value),
    fps: Number(fps.value),
    background:
      transparent.checked && !(kind === 'video' && format.value === 'mp4') ? null : color.value,
    range: range.value as 'scene' | 'workArea',
  });
  const refresh = () => {
    const m = editor.view.getAs(motion.value as Uid, 'motion');
    const wa = range.querySelector<HTMLOptionElement>('option[value="workArea"]')!;
    wa.disabled = !m.workArea;
    if (!m.workArea) range.value = 'scene';
    else
      wa.textContent = `The work area (${round(m.workArea.start, 3)}–${round(m.workArea.end, 3)} s)`;
    const mp4 = kind === 'video' && format.value === 'mp4';
    transparent.disabled = mp4;
    color.disabled = transparent.checked && !mp4;
    try {
      const r = frameRange(m, range.value as 'scene' | 'workArea', Number(fps.value) || 30);
      info.textContent = `${r.last - r.first + 1} frames (${r.first}–${r.last}); physics runs from the motion's start.`;
    } catch (e) {
      info.textContent = (e as Error).message;
    }
  };
  for (const el of [motion, range, fps, transparent, format])
    el.addEventListener('change', refresh);
  motion.addEventListener('change', () => {
    fps.value = String(editor.view.getAs(motion.value as Uid, 'motion').fps || 30);
    refresh();
  });
  const run = h(
    'button.primary',
    {
      dataset: { testid: 'movie-export' },
      on: {
        click: async () => {
          controller = new AbortController();
          run.disabled = true;
          status.textContent = 'Rendering…';
          try {
            const r = await renderMovie(editor, offscreen, settings(), {
              signal: controller.signal,
              onProgress: (done, total) => {
                bar.value = done / total;
                status.textContent = `Frame ${done} of ${total}…`;
              },
            });
            status.textContent = `Saving ${r.frames} frames…`;
            await save(r);
            d.close();
          } catch (e) {
            const cancelled = (e as Error).name === 'AbortError';
            status.textContent = cancelled ? 'Cancelled.' : (e as Error).message;
            bar.value = 0;
            if (!cancelled) editor.report(e);
          } finally {
            controller = null;
            run.disabled = false;
          }
        },
      },
    },
    'Export',
  ) as HTMLButtonElement;
  const d = dialog(
    kind === 'images' ? 'Export Image Sequence' : 'Export Video',
    [
      h('label.field', h('span', 'Motion'), motion),
      h('label.field', h('span', 'Width'), width),
      h('label.field', h('span', 'Height'), height),
      h('label.field', h('span', 'Frame rate'), fps),
      ...(kind === 'video' ? [h('label.field', h('span', 'Format'), format)] : []),
      h('label.field', h('span', 'Transparent background'), transparent),
      h('label.field', h('span', 'Background color'), color),
      h('label.field', h('span', 'Range'), range),
      info,
      bar,
      status,
      h(
        'div.buttons',
        run,
        h(
          'button',
          {
            dataset: { testid: 'movie-cancel' },
            on: { click: () => (controller ? controller.abort() : d.close()) },
          },
          'Cancel',
        ),
      ),
    ],
    { testid: 'movie-dialog' },
  );
  refresh();
  if (kind === 'video')
    void videoSupport(Number(width.value), Number(height.value)).then((v) => {
      const [webm, mp4] = [...format.options];
      webm!.disabled = !v.webm;
      mp4!.disabled = !v.mp4;
      if (!v.webm && v.mp4) format.value = 'mp4';
      if (!v.webm && !v.mp4) status.textContent = 'This platform cannot encode video.';
      refresh();
    });
  return d;
}

/** Settings with defaults for what an agent leaves out (PNG, the default size and the motion's fps). */
export function movieSettings(
  editor: Editor,
  a: Partial<MovieSettings> & { motion: string },
): MovieSettings {
  const v = editor.view;
  const m = v.getAs(v.resolve(a.motion, ['motion'], 'motion'), 'motion');
  const size = defaultMovieSize(editor);
  return {
    motion: m.uid,
    format: a.format ?? 'png',
    width: a.width ?? size.width,
    height: a.height ?? size.height,
    fps: a.fps ?? (m.fps || 30),
    background: a.background ?? (a.format === 'mp4' ? '#ffffff' : null),
    range: a.range ?? 'scene',
  };
}
