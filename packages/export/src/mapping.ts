/**
 * Deformer mapping (design 3.5, 3.6): where a deformer's local points land on the canvas, and
 * back.
 *
 * The forward map is Mochi2D's (0.5.0, `mapPoints` and `mapJacobians`): the document is lowered,
 * evaluated at a pose (the rest pose by default: every parameter at its default), and points are
 * mapped from a deformer's input space through its world form, exactly as the evaluator maps the
 * vertices of its child meshes. The inverse is a damped Newton iteration on that forward map, with
 * the analytic Jacobians, so a canvas edit resolves to the local values that the evaluator maps
 * back onto it.
 *
 * Canvas coordinates are the document's pixels (y down). Local coordinates are the stored ones: a
 * warp's normalized (u, v), a rotation's pixels around its origin, or canvas pixels with no
 * deformer.
 */
import type { DocReader, Uid } from '@mochi-maker/core';
import { ModelInstance, mocModelFromData } from 'mochi2d/headless';
import { lowerDocument, type LowerResult } from './lower.js';
import { previewVersion } from './preview.js';

/** A forward map with Jacobians, on flat x, y pairs. */
export type ForwardMap = (points: Float64Array) => {
  points: ArrayLike<number>;
  /** ∂x/∂u, ∂x/∂v, ∂y/∂u, ∂y/∂v per point. */
  jacobians: ArrayLike<number>;
};

export interface InverseOptions {
  /** Stop when every point lands within this distance of its target (default 1e-4). */
  tolerance?: number;
  /** Default 40. */
  maxIterations?: number;
}

export interface InverseResult {
  points: Float64Array;
  /** Distance from each point's image to its target. */
  errors: Float64Array;
  maxError: number;
  iterations: number;
}

/**
 * Finds points whose images under `forward` are `targets`, starting from `guess`, by damped
 * Newton steps: a step that does not bring a point closer is shortened, and a point whose
 * Jacobian is singular takes a gradient step instead.
 */
export function invertMap(
  forward: ForwardMap,
  targets: ArrayLike<number>,
  guess: ArrayLike<number>,
  options: InverseOptions = {},
): InverseResult {
  const tol = options.tolerance ?? 1e-4;
  const maxIt = options.maxIterations ?? 40;
  const n = targets.length / 2;
  const p = Float64Array.from(guess);
  const err = new Float64Array(n);
  const res = new Float64Array(2 * n);
  const jac = new Float64Array(4 * n);
  const damp = new Float64Array(n).fill(1);

  const measure = (at: Float64Array, into: Float64Array, errs: Float64Array, j?: Float64Array) => {
    const f = forward(at);
    for (let i = 0; i < n; i++) {
      const rx = f.points[2 * i]! - targets[2 * i]!;
      const ry = f.points[2 * i + 1]! - targets[2 * i + 1]!;
      into[2 * i] = rx;
      into[2 * i + 1] = ry;
      errs[i] = Math.hypot(rx, ry);
      if (j) for (let k = 0; k < 4; k++) j[4 * i + k] = f.jacobians[4 * i + k]!;
    }
  };
  measure(p, res, err, jac);
  const trial = new Float64Array(2 * n);
  const tRes = new Float64Array(2 * n);
  const tErr = new Float64Array(n);
  const tJac = new Float64Array(4 * n);
  let it = 0;
  for (; it < maxIt; it++) {
    let open = false;
    for (let i = 0; i < n; i++) {
      trial[2 * i] = p[2 * i]!;
      trial[2 * i + 1] = p[2 * i + 1]!;
      if (!(err[i]! > tol)) continue;
      open = true;
      const [a, b, c, d] = [jac[4 * i]!, jac[4 * i + 1]!, jac[4 * i + 2]!, jac[4 * i + 3]!];
      const rx = res[2 * i]!;
      const ry = res[2 * i + 1]!;
      const det = a * d - b * c;
      const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d), 1e-30);
      let sx: number;
      let sy: number;
      if (Math.abs(det) > 1e-12 * scale * scale) {
        sx = (d * rx - b * ry) / det;
        sy = (-c * rx + a * ry) / det;
      } else {
        // Gradient of |r|²/2, scaled to the Jacobian.
        sx = (a * rx + c * ry) / (scale * scale);
        sy = (b * rx + d * ry) / (scale * scale);
      }
      trial[2 * i] = p[2 * i]! - damp[i]! * sx;
      trial[2 * i + 1] = p[2 * i + 1]! - damp[i]! * sy;
    }
    if (!open) break;
    measure(trial, tRes, tErr, tJac);
    for (let i = 0; i < n; i++) {
      if (!(err[i]! > tol)) continue;
      if (tErr[i]! < err[i]! || !Number.isFinite(err[i]!)) {
        p[2 * i] = trial[2 * i]!;
        p[2 * i + 1] = trial[2 * i + 1]!;
        res[2 * i] = tRes[2 * i]!;
        res[2 * i + 1] = tRes[2 * i + 1]!;
        err[i] = tErr[i]!;
        for (let k = 0; k < 4; k++) jac[4 * i + k] = tJac[4 * i + k]!;
        damp[i] = Math.min(1, damp[i]! * 2);
      } else damp[i] = damp[i]! / 4;
    }
  }
  let maxError = 0;
  for (let i = 0; i < n; i++) maxError = Math.max(maxError, err[i]!);
  return { points: p, errors: err, maxError, iterations: it };
}

/** Parameter values by document UID; parameters not named stay at their defaults. */
export type Pose = Readonly<Record<Uid, number>>;

/**
 * The document's deformers evaluated at a pose, for mapping points between their local spaces
 * and the canvas.
 */
export class DeformerMapper {
  readonly lowered: LowerResult;
  readonly instance: ModelInstance;
  private readonly index = new Map<Uid, number>();
  private readonly ppu: number;
  private readonly ox: number;
  private readonly oy: number;

  /** Lowers `doc` (textures are not needed) and evaluates it at `pose`. */
  constructor(doc: DocReader, pose: Pose = {}) {
    const version = previewVersion(doc);
    this.lowered = lowerDocument(doc, { version, placement: new Map() });
    this.instance = new ModelInstance(mocModelFromData(this.lowered.data, version));
    const c = doc.project().canvas;
    this.ppu = c.pixelsPerUnit;
    this.ox = c.originX;
    this.oy = c.originY;
    this.lowered.uids.deformers.forEach((u, i) => this.index.set(u, i));
    this.setPose(pose);
  }

  /** Evaluates at a new pose. */
  setPose(pose: Pose): void {
    const params = this.lowered.uids.parameters;
    const defaults = this.lowered.data.parameters.defaultValue;
    params.forEach((u, i) => this.instance.setParameter(i, pose[u] ?? defaults[i]!));
    this.instance.evaluate();
  }

  /** The deformer's index in the lowered data (−1 for none). */
  deformerIndex(deformer: Uid | null): number {
    if (deformer === null) return -1;
    const i = this.index.get(deformer);
    if (i === undefined) throw new Error(`Deformer ${deformer} is not in the lowered model.`);
    return i;
  }

  /** Maps local points of `deformer` (null: canvas pixels) to canvas pixels. */
  toCanvas(deformer: Uid | null, local: ArrayLike<number>): Float64Array {
    if (deformer === null) return Float64Array.from(local);
    const k = this.instance.mapPoints(this.deformerIndex(deformer), local, 'keyform');
    const out = new Float64Array(k.length);
    for (let i = 0; i < k.length; i += 2) {
      out[i] = k[i]! * this.ppu + this.ox;
      out[i + 1] = k[i + 1]! * this.ppu + this.oy;
    }
    return out;
  }

  /** ∂canvas/∂local at each point (row-major 2×2 per point). */
  jacobians(deformer: Uid | null, local: ArrayLike<number>): Float64Array {
    const n = local.length / 2;
    if (deformer === null) {
      const out = new Float64Array(4 * n);
      for (let i = 0; i < n; i++) ((out[4 * i] = 1), (out[4 * i + 3] = 1));
      return out;
    }
    const j = this.instance.mapJacobians(this.deformerIndex(deformer), local, 'keyform');
    return j.map((v) => v * this.ppu);
  }

  /** The forward map of one deformer, in canvas pixels. */
  forward(deformer: Uid | null): ForwardMap {
    return (pts) => ({
      points: this.toCanvas(deformer, pts),
      jacobians: this.jacobians(deformer, pts),
    });
  }

  /**
   * An affine guess at the inverse, from where (0, 0), (1, 0) and (0, 1) land: exact for a
   * rotation, close for a warp.
   */
  affineGuess(deformer: Uid | null, canvas: ArrayLike<number>): Float64Array {
    if (deformer === null) return Float64Array.from(canvas);
    const [x0, y0, x1, y1, x2, y2] = this.toCanvas(deformer, [0, 0, 1, 0, 0, 1]);
    const a = x1! - x0!;
    const b = x2! - x0!;
    const c = y1! - y0!;
    const d = y2! - y0!;
    const det = a * d - b * c;
    const out = new Float64Array(canvas.length);
    for (let i = 0; i < canvas.length; i += 2) {
      const dx = canvas[i]! - x0!;
      const dy = canvas[i + 1]! - y0!;
      out[i] = det === 0 ? 0 : (d * dx - b * dy) / det;
      out[i + 1] = det === 0 ? 0 : (-c * dx + a * dy) / det;
    }
    return out;
  }

  /**
   * Local points of `deformer` that land on the canvas points, from `guess` (default: the affine
   * guess). Errors are in canvas pixels.
   */
  toLocal(
    deformer: Uid | null,
    canvas: ArrayLike<number>,
    guess?: ArrayLike<number>,
    options: InverseOptions = {},
  ): InverseResult {
    if (deformer === null) {
      const n = canvas.length / 2;
      return {
        points: Float64Array.from(canvas),
        errors: new Float64Array(n),
        maxError: 0,
        iterations: 0,
      };
    }
    return invertMap(this.forward(deformer), canvas, guess ?? this.affineGuess(deformer, canvas), {
      tolerance: 1e-4,
      ...options,
    });
  }

  /**
   * The evaluated vertices of each mesh that is drawn (active: enabled, in active parts and
   * deformers), in canvas pixels, by document UID, after glue. An inactive mesh's vertices are not
   * evaluated, so it is left out.
   */
  meshVertices(): Map<Uid, Float64Array> {
    const out = new Map<Uid, Float64Array>();
    const flip = (this.lowered.data.canvas.flags & 1) === 0 ? -1 : 1;
    this.lowered.uids.artMeshes.forEach((u, i) => {
      if (!this.instance.drawableActive[i]) return;
      const v = this.instance.drawableVertices[i]!;
      const c = new Float64Array(v.length);
      for (let k = 0; k < v.length; k += 2) {
        c[k] = v[k]! * this.ppu + this.ox;
        c[k + 1] = flip * v[k + 1]! * this.ppu + this.oy;
      }
      out.set(u, c);
    });
    return out;
  }
}
