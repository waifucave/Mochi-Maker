/**
 * The brush (brush selection and the deform brush): an ellipse of `radius`
 * (its long half-axis), `roundness` (short / long, 1 for a circle) turned by `angle` degrees, and
 * `hardness`: the weight is 1 inside `hardness` of the way out and falls smoothly to 0 at the edge.
 * The editor sets size, angle and hardness with B, C and V + drag.
 */
export interface Brush {
  radius: number;
  hardness: number;
  /** Degrees, clockwise on screen (y down). */
  angle?: number;
  roundness?: number;
}

/** The brush's weight (0–1) at an offset from its center. */
export function brushWeight(dx: number, dy: number, b: Brush): number {
  const r = Math.max(b.radius, 1e-9);
  const a = ((b.angle ?? 0) * Math.PI) / 180;
  const u = dx * Math.cos(a) + dy * Math.sin(a);
  const v = -dx * Math.sin(a) + dy * Math.cos(a);
  const round = Math.min(1, Math.max(0.05, b.roundness ?? 1));
  const d = Math.hypot(u / r, v / (r * round));
  if (d >= 1) return 0;
  const h = Math.min(1, Math.max(0, b.hardness));
  if (d <= h) return 1;
  const t = (d - h) / (1 - h);
  return 1 - t * t * (3 - 2 * t);
}
