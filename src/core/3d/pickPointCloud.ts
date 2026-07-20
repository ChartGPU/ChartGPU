/**
 * Pure screen-space nearest-point pick for packed XYZV point clouds.
 * Fixed-stride subsample when count > maxFullScan (default 50_000).
 */

import { transformPoint, type Mat4 } from './mat4';

export type PointCloudPickHit = Readonly<{
  readonly dataIndex: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly value: number;
  readonly dist2: number;
}>;

export const DEFAULT_POINT_CLOUD_PICK_FULL_SCAN = 50_000;

/**
 * Scan step for large clouds: ceil(count / maxFullScan) so roughly maxFullScan samples.
 */
export function pointCloudPickStep(count: number, maxFullScan = DEFAULT_POINT_CLOUD_PICK_FULL_SCAN): number {
  if (!(count > maxFullScan)) return 1;
  return Math.ceil(count / maxFullScan);
}

/**
 * Nearest packed point to (cssX, cssY) within thresholdPx (screen CSS pixels).
 * `packed` is xyzv floats; only first `count` points are considered.
 * View-projection is column-major mat4 (clip = VP * world).
 */
export function pickNearestPointCloud(
  packed: Float32Array,
  count: number,
  viewProj: Mat4,
  cssX: number,
  cssY: number,
  viewportCssW: number,
  viewportCssH: number,
  thresholdPx = 10,
  maxFullScan = DEFAULT_POINT_CLOUD_PICK_FULL_SCAN
): PointCloudPickHit | null {
  if (!(count > 0) || !(viewportCssW > 0) || !(viewportCssH > 0)) return null;
  const thr2 = thresholdPx * thresholdPx;
  const step = pointCloudPickStep(count, maxFullScan);
  let best: PointCloudPickHit | null = null;
  let bestDist = thr2;

  for (let i = 0; i < count; i += step) {
    const x = packed[i * 4]!;
    const y = packed[i * 4 + 1]!;
    const z = packed[i * 4 + 2]!;
    const val = packed[i * 4 + 3]!;
    const clip = transformPoint(viewProj, x, y, z);
    if (!(Math.abs(clip[3]) > 1e-8)) continue;
    const ndcX = clip[0] / clip[3];
    const ndcY = clip[1] / clip[3];
    if (ndcX < -1.2 || ndcX > 1.2 || ndcY < -1.2 || ndcY > 1.2) continue;
    const sx = (ndcX * 0.5 + 0.5) * viewportCssW;
    const sy = (1 - (ndcY * 0.5 + 0.5)) * viewportCssH;
    const dx = sx - cssX;
    const dy = sy - cssY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      best = { dataIndex: i, x, y, z, value: val, dist2: d2 };
    }
  }
  return best;
}
