/**
 * The view, or a stand-in where there is none. Mochi2D's view needs WebGL2; a browser
 * or machine without it (a GPU-less virtual machine, a locked-down browser) throws when the view is
 * made. The editor then gets a stand-in with the same members that shows nothing: the rest of the
 * editor opens, edits, saves and exports, and the View area says why it is empty. Anything that
 * needs pixels (screenshots, movies) fails with that reason.
 */
import { MochiView } from 'mochi2d';

type ViewOptions = ConstructorParameters<typeof MochiView>[1];

export const NO_WEBGL2 =
  'The view needs WebGL2, which this browser or machine does not offer: the model is not drawn, but it can still be edited, saved and exported.';

/** A view that draws nothing: the members the editor uses, inert. */
class StandInView {
  readonly model = null;
  paused = false;
  drawing = true;
  background = 'transparent';
  readonly viewTransform = { zoom: 1, x: 0, y: 0, rotation: 0, pixelsPerUnit: 1 };
  constructor(private readonly reason: string) {}
  on(): () => void {
    return () => {};
  }
  load(): Promise<never> {
    return Promise.reject(new Error(this.reason));
  }
  unload(): void {}
  advance(): void {}
  draw(): void {}
  resize(): void {}
  setView(): void {}
  panBy(): void {}
  resetView(): void {}
  lookAt(): void {}
  toModel(): null {
    return null;
  }
  toPage(): null {
    return null;
  }
  hitTest(): null {
    return null;
  }
  screenshot(): Promise<never> {
    return Promise.reject(new Error(this.reason));
  }
  dispose(): void {}
}

/**
 * The editor's runtime options. Motion sync applies the file's per-parameter smoothing (each driven
 * parameter's «smooth %»), which Mochi2D leaves off by default: the editor shows what the values
 * in the document do, in the viewport, the Motion Sync dialog's preview and movie export alike.
 */
export const EDITOR_RUNTIME = { animation: { motionSync: { fileSmoothing: true } } } as const;

/** Mochi2D's view on `canvas` with the editor's runtime options, or the stand-in, with the reason. */
export function makeView(
  canvas: HTMLCanvasElement,
  options: ViewOptions,
): { view: MochiView; unavailable: string | null } {
  try {
    return {
      view: new MochiView(canvas, { runtime: EDITOR_RUNTIME, ...options }),
      unavailable: null,
    };
  } catch (e) {
    const detail = (e as Error)?.message ?? String(e);
    const reason = /webgl/i.test(detail) ? NO_WEBGL2 : `The view could not start: ${detail}`;
    return { view: new StandInView(reason) as unknown as MochiView, unavailable: reason };
  }
}
