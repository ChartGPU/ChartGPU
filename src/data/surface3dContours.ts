/**
 * Marching-squares isolines for uniform surface3d height fields.
 * Output: world-space line-list segments (x,y,z) with y = contour level
 * (isoline on constant height; projected onto XZ with Y = level).
 */

export type Surface3DContourSegment = Readonly<{
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
}>;

export type Surface3DContourInput = Readonly<{
  readonly xStart: number;
  readonly xStep: number;
  readonly zStart: number;
  readonly zStep: number;
  readonly columns: number;
  readonly rows: number;
  /** Row-major y[j * columns + i]. */
  readonly y: ArrayLike<number>;
}>;

/**
 * Resolve level set: explicit array, or N evenly spaced between yMin/yMax (exclusive of exact flat ends when equal).
 */
export function resolveContourLevels(
  levels: number | readonly number[] | undefined,
  yMin: number,
  yMax: number
): number[] {
  if (Array.isArray(levels)) {
    const out: number[] = [];
    for (const v of levels) {
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
    return out;
  }
  const count =
    typeof levels === 'number' && Number.isFinite(levels) ? Math.max(0, Math.min(64, Math.floor(levels))) : 0;
  if (count <= 0) return [];
  let lo = yMin;
  let hi = yMax;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) return count > 0 ? [lo] : [];
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  // Interior levels: exclude exact min/max endpoints for cleaner isolines
  const out: number[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    out.push(lo + t * (hi - lo));
  }
  return out;
}

const hAt = (y: ArrayLike<number>, columns: number, i: number, j: number): number => {
  const idx = j * columns + i;
  if (idx < 0 || idx >= y.length) return Number.NaN;
  return Number(y[idx]);
};

/**
 * Marching squares → line segments in world space (Y = level on surface isosurface along edges).
 * Edge interpolation places vertices at true height = level on the cell edges.
 */
export function generateSurface3DContours(grid: Surface3DContourInput, levels: readonly number[]): Float32Array {
  const cols = Math.floor(grid.columns);
  const rows = Math.floor(grid.rows);
  if (cols < 2 || rows < 2 || levels.length === 0) return new Float32Array(0);

  // Collect segments as flat x,y,z,x,y,z,...
  const parts: number[] = [];

  for (const level of levels) {
    if (!Number.isFinite(level)) continue;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const h00 = hAt(grid.y, cols, i, j);
        const h10 = hAt(grid.y, cols, i + 1, j);
        const h11 = hAt(grid.y, cols, i + 1, j + 1);
        const h01 = hAt(grid.y, cols, i, j + 1);
        if (![h00, h10, h11, h01].every((h) => Number.isFinite(h))) continue;

        // Bit mask: corner above level
        let mask = 0;
        if (h00 >= level) mask |= 1;
        if (h10 >= level) mask |= 2;
        if (h11 >= level) mask |= 4;
        if (h01 >= level) mask |= 8;
        if (mask === 0 || mask === 15) continue;

        const x0 = grid.xStart + i * grid.xStep;
        const x1 = grid.xStart + (i + 1) * grid.xStep;
        const z0 = grid.zStart + j * grid.zStep;
        const z1 = grid.zStart + (j + 1) * grid.zStep;

        // Edge midpoints (lerp where level crosses): returns u in [0,1] along the edge
        const edgeU = (ha: number, hb: number): number => {
          const d = hb - ha;
          if (!(Math.abs(d) > 1e-12)) return 0.5;
          return Math.min(1, Math.max(0, (level - ha) / d));
        };

        // Edge points: bottom, right, top, left
        const bottom = (): [number, number, number] => {
          const u = edgeU(h00, h10);
          return [x0 + u * (x1 - x0), level, z0];
        };
        const right = (): [number, number, number] => {
          const u = edgeU(h10, h11);
          return [x1, level, z0 + u * (z1 - z0)];
        };
        const top = (): [number, number, number] => {
          const u = edgeU(h01, h11);
          return [x0 + u * (x1 - x0), level, z1];
        };
        const left = (): [number, number, number] => {
          const u = edgeU(h00, h01);
          return [x0, level, z0 + u * (z1 - z0)];
        };

        // Slight +Y bias reduces z-fighting with the solid heightfield (depth-tested lines).
        const Y_BIAS = 1e-3 * (Math.abs(level) + 1);
        const pushSeg = (a: [number, number, number], b: [number, number, number]): void => {
          parts.push(a[0], a[1] + Y_BIAS, a[2], b[0], b[1] + Y_BIAS, b[2]);
        };

        // Standard MS cases (asymmetric saddle: pick one diagonal)
        switch (mask) {
          case 1:
          case 14:
            pushSeg(left(), bottom());
            break;
          case 2:
          case 13:
            pushSeg(bottom(), right());
            break;
          case 3:
          case 12:
            pushSeg(left(), right());
            break;
          case 4:
          case 11:
            pushSeg(right(), top());
            break;
          case 5:
            pushSeg(left(), bottom());
            pushSeg(right(), top());
            break;
          case 6:
          case 9:
            pushSeg(bottom(), top());
            break;
          case 7:
          case 8:
            pushSeg(left(), top());
            break;
          case 10:
            pushSeg(bottom(), right());
            pushSeg(left(), top());
            break;
          default:
            break;
        }
      }
    }
  }

  return new Float32Array(parts);
}

/** Vertex count for a contour line-list buffer (floats / 3). */
export function contourVertexCount(positions: Float32Array): number {
  return Math.floor(positions.length / 3);
}
