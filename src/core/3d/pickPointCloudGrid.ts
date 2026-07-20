/**
 * Screen-space spatial grid for exact nearest-point cloud pick at large N.
 * Rebuild on camera / data identity change; query is O(cell + neighbors).
 * Replaces stride-only approximation as the primary large-N path.
 */

import { transformPoint, type Mat4 } from './mat4';
import type { PointCloudPickHit } from './pickPointCloud';
import { pickNearestPointCloud } from './pickPointCloud';

export type PointCloudScreenGrid = {
  /** Flat list of data indices per cell (variable length arrays). */
  cells: Int32Array[];
  cols: number;
  rows: number;
  cellSize: number;
  viewportW: number;
  viewportH: number;
  /** Identity stamp used to detect stale grids. */
  stamp: string;
  count: number;
  packedRef: Float32Array | null;
};

const DEFAULT_CELL_PX = 16;

export function createEmptyPointCloudScreenGrid(): PointCloudScreenGrid {
  return {
    cells: [],
    cols: 0,
    rows: 0,
    cellSize: DEFAULT_CELL_PX,
    viewportW: 0,
    viewportH: 0,
    stamp: '',
    count: 0,
    packedRef: null,
  };
}

export function pointCloudScreenGridStamp(
  count: number,
  viewportW: number,
  viewportH: number,
  viewProj: Mat4,
  packed: Float32Array
): string {
  // Sample matrix + buffer identity/content cues (not full content hash).
  // Include packed object identity via length + endpoint samples so equal-N
  // rewrites that keep length but change samples invalidate the grid.
  const head = count > 0 ? `${packed[0]},${packed[1]},${packed[2]},${packed[3]}` : '';
  const tail =
    count > 1
      ? `${packed[(count - 1) * 4]},${packed[(count - 1) * 4 + 1]},${packed[(count - 1) * 4 + 2]},${packed[(count - 1) * 4 + 3]}`
      : '';
  const mid = count > 2 ? `${packed[Math.floor(count / 2) * 4]},${packed[Math.floor(count / 2) * 4 + 1]}` : '';
  return [
    count,
    viewportW | 0,
    viewportH | 0,
    packed.length,
    packed.byteOffset,
    head,
    mid,
    tail,
    // viewProj fingerprint
    viewProj[0]?.toFixed(5),
    viewProj[5]?.toFixed(5),
    viewProj[10]?.toFixed(5),
    viewProj[12]?.toFixed(4),
    viewProj[13]?.toFixed(4),
    viewProj[14]?.toFixed(4),
    viewProj[15]?.toFixed(5),
  ].join('|');
}

/**
 * Rebuild screen-space grid. O(N) project — call when stamp changes (camera/data), not every move.
 */
export function rebuildPointCloudScreenGrid(
  grid: PointCloudScreenGrid,
  packed: Float32Array,
  count: number,
  viewProj: Mat4,
  viewportCssW: number,
  viewportCssH: number,
  cellSizePx = DEFAULT_CELL_PX
): void {
  const cellSize = Math.max(8, cellSizePx);
  const cols = Math.max(1, Math.ceil(viewportCssW / cellSize));
  const rows = Math.max(1, Math.ceil(viewportCssH / cellSize));
  const cells: Int32Array[] = new Array(cols * rows);
  // Use growable arrays then freeze to Int32Array
  const buckets: number[][] = new Array(cols * rows);
  for (let i = 0; i < buckets.length; i++) buckets[i] = [];

  for (let i = 0; i < count; i++) {
    const x = packed[i * 4]!;
    const y = packed[i * 4 + 1]!;
    const z = packed[i * 4 + 2]!;
    const clip = transformPoint(viewProj, x, y, z);
    if (!(Math.abs(clip[3]) > 1e-8) || clip[3] <= 0) continue;
    const ndcX = clip[0] / clip[3];
    const ndcY = clip[1] / clip[3];
    if (ndcX < -1.2 || ndcX > 1.2 || ndcY < -1.2 || ndcY > 1.2) continue;
    const sx = (ndcX * 0.5 + 0.5) * viewportCssW;
    const sy = (1 - (ndcY * 0.5 + 0.5)) * viewportCssH;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(sx / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(sy / cellSize)));
    buckets[cy * cols + cx]!.push(i);
  }

  for (let i = 0; i < buckets.length; i++) {
    cells[i] = buckets[i]!.length > 0 ? Int32Array.from(buckets[i]!) : new Int32Array(0);
  }

  grid.cells = cells;
  grid.cols = cols;
  grid.rows = rows;
  grid.cellSize = cellSize;
  grid.viewportW = viewportCssW;
  grid.viewportH = viewportCssH;
  grid.count = count;
  grid.packedRef = packed;
  grid.stamp = pointCloudScreenGridStamp(count, viewportCssW, viewportCssH, viewProj, packed);
}

/**
 * Exact nearest point using screen grid (falls back to full/strided scan if empty).
 */
export function pickNearestPointCloudWithGrid(
  grid: PointCloudScreenGrid,
  packed: Float32Array,
  count: number,
  viewProj: Mat4,
  cssX: number,
  cssY: number,
  viewportCssW: number,
  viewportCssH: number,
  thresholdPx = 10
): PointCloudPickHit | null {
  if (!(count > 0) || !(viewportCssW > 0) || !(viewportCssH > 0)) return null;

  // Cold / stale: use classic path
  if (
    grid.cells.length === 0 ||
    grid.count !== count ||
    grid.packedRef !== packed ||
    grid.viewportW !== viewportCssW ||
    grid.viewportH !== viewportCssH
  ) {
    return pickNearestPointCloud(packed, count, viewProj, cssX, cssY, viewportCssW, viewportCssH, thresholdPx);
  }

  const thr2 = thresholdPx * thresholdPx;
  const cellSize = grid.cellSize;
  const cols = grid.cols;
  const rows = grid.rows;
  const cx = Math.floor(cssX / cellSize);
  const cy = Math.floor(cssY / cellSize);
  // Search radius in cells covering the threshold
  const r = Math.max(1, Math.ceil(thresholdPx / cellSize) + 1);

  let best: PointCloudPickHit | null = null;
  let bestDist = thr2;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      const bucket = grid.cells[y * cols + x];
      if (!bucket || bucket.length === 0) continue;
      for (let k = 0; k < bucket.length; k++) {
        const i = bucket[k]!;
        const wx = packed[i * 4]!;
        const wy = packed[i * 4 + 1]!;
        const wz = packed[i * 4 + 2]!;
        const val = packed[i * 4 + 3]!;
        const clip = transformPoint(viewProj, wx, wy, wz);
        if (!(Math.abs(clip[3]) > 1e-8) || clip[3] <= 0) continue;
        const ndcX = clip[0] / clip[3];
        const ndcY = clip[1] / clip[3];
        const sx = (ndcX * 0.5 + 0.5) * viewportCssW;
        const sy = (1 - (ndcY * 0.5 + 0.5)) * viewportCssH;
        const ddx = sx - cssX;
        const ddy = sy - cssY;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < bestDist) {
          bestDist = d2;
          best = { dataIndex: i, x: wx, y: wy, z: wz, value: val, dist2: d2 };
        }
      }
    }
  }
  return best;
}
