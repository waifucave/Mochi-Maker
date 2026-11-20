/**
 * The Bézier control layer of warps (at edit level 2 a warp shows
 * Bézier control points over its grid). An editor-side helper: the document keeps the grid, and the
 * net is fitted to the grid whenever it is shown, so export is unchanged.
 *
 * The net divides the warp into `bu` × `bv` patches (Bézier divisions). Its control points are an
 * anchor at each patch corner and two handles on each edge between neighbouring anchors. Each
 * patch is a Coons patch bounded by the four cubic Bézier curves of its edges, so the surface is
 * linear in the control points. Fitting puts every control point on the grid itself (the anchors
 * at the patch corners, the handles at the edges' thirds), so a flat grid is reproduced exactly.
 *
 * Moving control points moves each grid point by the surface of the moves (`netWeights`). The
 * grid's own detail, edited at level 1, therefore stays; only the smooth deformation is added.
 *
 * Grid points are row-major: point (r, c) of a grid with `rows` × `cols` cells is at index
 * r·(cols + 1) + c, at surface coordinates u = c / cols, v = r / rows.
 */

export interface NetShape {
  /** Bézier divisions across (u) and down (v). */
  bu: number;
  bv: number;
}

/** Control points: anchors, then the handles of the across edges, then of the down edges. */
export function controlCount({ bu, bv }: NetShape): number {
  return (bu + 1) * (bv + 1) + 2 * bu * (bv + 1) + 2 * (bu + 1) * bv;
}

const anchor = (n: NetShape, i: number, j: number) => j * (n.bu + 1) + i;
/** Handle k (0 near anchor (i, j), 1 near (i + 1, j)) of the across edge from anchor (i, j). */
const hHandle = (n: NetShape, i: number, j: number, k: number) =>
  (n.bu + 1) * (n.bv + 1) + 2 * (j * n.bu + i) + k;
/** Handle k (0 near anchor (i, j), 1 near (i, j + 1)) of the down edge from anchor (i, j). */
const vHandle = (n: NetShape, i: number, j: number, k: number) =>
  (n.bu + 1) * (n.bv + 1) + 2 * n.bu * (n.bv + 1) + 2 * (j * (n.bu + 1) + i) + k;

/** What a control point is: an anchor, or a handle with the anchor it belongs to. */
export function controlRole(
  n: NetShape,
  index: number,
): { kind: 'anchor' } | { kind: 'handle'; anchor: number } {
  const na = (n.bu + 1) * (n.bv + 1);
  if (index < na) return { kind: 'anchor' };
  let k = index - na;
  if (k < 2 * n.bu * (n.bv + 1)) {
    const e = Math.floor(k / 2);
    const [i, j] = [e % n.bu, Math.floor(e / n.bu)];
    return { kind: 'handle', anchor: anchor(n, i + (k % 2), j) };
  }
  k -= 2 * n.bu * (n.bv + 1);
  const e = Math.floor(k / 2);
  const [i, j] = [e % (n.bu + 1), Math.floor(e / (n.bu + 1))];
  return { kind: 'handle', anchor: anchor(n, i, j + (k % 2)) };
}

/** The handles next to an anchor: they move with it. */
export function anchorHandles(n: NetShape, index: number): number[] {
  const [i, j] = [index % (n.bu + 1), Math.floor(index / (n.bu + 1))];
  const out: number[] = [];
  if (i < n.bu) out.push(hHandle(n, i, j, 0));
  if (i > 0) out.push(hHandle(n, i - 1, j, 1));
  if (j < n.bv) out.push(vHandle(n, i, j, 0));
  if (j > 0) out.push(vHandle(n, i, j - 1, 1));
  return out;
}

/** A grid's point at surface coordinates (u, v), bilinear between its points. */
export function gridAt(
  grid: ArrayLike<number>,
  rows: number,
  cols: number,
  u: number,
  v: number,
): [number, number] {
  const fc = Math.min(Math.max(u * cols, 0), cols);
  const fr = Math.min(Math.max(v * rows, 0), rows);
  const c = Math.min(Math.floor(fc), cols - 1);
  const r = Math.min(Math.floor(fr), rows - 1);
  const [s, t] = [fc - c, fr - r];
  const p = (rr: number, cc: number, k: number) => grid[2 * (rr * (cols + 1) + cc) + k]!;
  const at = (k: number) =>
    (1 - s) * (1 - t) * p(r, c, k) +
    s * (1 - t) * p(r, c + 1, k) +
    (1 - s) * t * p(r + 1, c, k) +
    s * t * p(r + 1, c + 1, k);
  return [at(0), at(1)];
}

/** The net fitted to a grid: every control point on the grid (see the module comment). */
export function fitNet(
  grid: ArrayLike<number>,
  rows: number,
  cols: number,
  n: NetShape,
): Float64Array {
  const out = new Float64Array(2 * controlCount(n));
  const put = (index: number, u: number, v: number) => {
    const [x, y] = gridAt(grid, rows, cols, u, v);
    out[2 * index] = x;
    out[2 * index + 1] = y;
  };
  for (let j = 0; j <= n.bv; j++)
    for (let i = 0; i <= n.bu; i++) {
      put(anchor(n, i, j), i / n.bu, j / n.bv);
      if (i < n.bu)
        for (const k of [0, 1]) put(hHandle(n, i, j, k), (i + (k + 1) / 3) / n.bu, j / n.bv);
      if (j < n.bv)
        for (const k of [0, 1]) put(vHandle(n, i, j, k), i / n.bu, (j + (k + 1) / 3) / n.bv);
    }
  return out;
}

const bez = (a: number, b: number, c: number, d: number, s: number) => {
  const m = 1 - s;
  return m * m * m * a + 3 * m * m * s * b + 3 * m * s * s * c + s * s * s * d;
};

/** The net's surface at (u, v): the Coons patch of the patch holding it. */
export function netSurface(
  ctrl: ArrayLike<number>,
  n: NetShape,
  u: number,
  v: number,
): [number, number] {
  const fu = Math.min(Math.max(u, 0), 1) * n.bu;
  const fv = Math.min(Math.max(v, 0), 1) * n.bv;
  const i = Math.min(Math.floor(fu), n.bu - 1);
  const j = Math.min(Math.floor(fv), n.bv - 1);
  const [s, t] = [fu - i, fv - j];
  const P = (index: number, k: number) => ctrl[2 * index + k]!;
  const at = (k: number) => {
    const a00 = P(anchor(n, i, j), k);
    const a10 = P(anchor(n, i + 1, j), k);
    const a01 = P(anchor(n, i, j + 1), k);
    const a11 = P(anchor(n, i + 1, j + 1), k);
    const bottom = bez(a00, P(hHandle(n, i, j, 0), k), P(hHandle(n, i, j, 1), k), a10, s);
    const top = bez(a01, P(hHandle(n, i, j + 1, 0), k), P(hHandle(n, i, j + 1, 1), k), a11, s);
    const left = bez(a00, P(vHandle(n, i, j, 0), k), P(vHandle(n, i, j, 1), k), a01, t);
    const right = bez(a10, P(vHandle(n, i + 1, j, 0), k), P(vHandle(n, i + 1, j, 1), k), a11, t);
    const corners = (1 - s) * (1 - t) * a00 + s * (1 - t) * a10 + (1 - s) * t * a01 + s * t * a11;
    return (1 - t) * bottom + t * top + (1 - s) * left + s * right - corners;
  };
  return [at(0), at(1)];
}

/**
 * How much each grid point moves when the given control points move by one unit together: the
 * surface of a net that is 1 at those points and 0 elsewhere. A drag by (dx, dy) moves grid point k
 * by (w[k]·dx, w[k]·dy).
 */
export function netWeights(
  n: NetShape,
  rows: number,
  cols: number,
  moved: readonly number[],
): Float64Array {
  const unit = new Float64Array(2 * controlCount(n));
  for (const m of moved) unit[2 * m] = 1;
  const w = new Float64Array((rows + 1) * (cols + 1));
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++)
      w[r * (cols + 1) + c] = netSurface(unit, n, c / cols, r / rows)[0];
  return w;
}

/** The default divisions for a grid: 2 × 2, or fewer when the grid has fewer cells. */
export function defaultDivisions(rows: number, cols: number): NetShape {
  return { bu: Math.max(1, Math.min(2, cols)), bv: Math.max(1, Math.min(2, rows)) };
}
