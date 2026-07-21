/**
 * Shared draw-only LOD stride for multi-M series under `performance.lod: 'auto'`.
 *
 * Caps **drawn** consecutive-segment instances toward a plot-pixel budget while
 * GPU residency / sampling stay unchanged. Used by mountain area fill and dense
 * hairline stroke so 5M–10M axes-only redraws stay fill-rate bounded.
 *
 * @module denseDrawLod
 * @internal
 */

/**
 * Minimum max-draw-segment budget when plot width is tiny or unknown.
 * Keeps mid-N series from collapsing to a handful of segments.
 */
export const DENSE_DRAW_MIN_TARGET_SEGMENTS = 2_048;

/**
 * Oversample factor × plot width (device px) → max drawn segments.
 * ~1 sample per device pixel is continuous for mountain fill under suite cameras;
 * multi-M group 8 needs a tight budget to stay at display refresh.
 */
export const DENSE_DRAW_WIDTH_OVERSAMPLE = 1;

/**
 * Only enter multi-segment stride when raw point count is at/above this floor.
 * Protects ≤200k fidelity. At N ≥ 250k under lod:auto, series over
 * `max(2048, 1× plotWidthDevicePx)` densify — including suite protect rows
 * at 500k / 1M (intentional display-refresh budget; use lod:'strict' for full N).
 */
export const DENSE_DRAW_POINT_THRESHOLD = 250_000;

export type DenseDrawStrideInput = Readonly<{
  readonly pointCount: number;
  /** Plot (or canvas) width in device pixels — drives max draw segments. */
  readonly plotWidthDevicePx?: number;
  /**
   * When true (`performance.lod: 'strict'`), always stride 1 (full N geometry).
   */
  readonly forceStandard?: boolean;
  /**
   * Override max drawn segments (tests). When omitted, derived from plot width.
   */
  readonly maxDrawSegments?: number;
}>;

export type DenseDrawStrideResult = Readonly<{
  /** Index step between consecutive drawn endpoints (≥1). */
  readonly stride: number;
  /** Instance count for triangle-list / line-list segment draws. */
  readonly drawSegmentCount: number;
  /** Last valid point index (`pointCount - 1`, or 0 when empty). */
  readonly lastPointIndex: number;
  /** True when stride > 1 (dense LOD active). */
  readonly dense: boolean;
}>;

/**
 * Resolve max drawn segments from plot width (device px).
 */
export function resolveMaxDrawSegments(plotWidthDevicePx?: number): number {
  const w =
    Number.isFinite(plotWidthDevicePx) && (plotWidthDevicePx as number) > 0
      ? Math.floor(plotWidthDevicePx as number)
      : 0;
  const fromWidth = w > 0 ? w * DENSE_DRAW_WIDTH_OVERSAMPLE : 0;
  return Math.max(DENSE_DRAW_MIN_TARGET_SEGMENTS, fromWidth);
}

/**
 * Resolve draw-only index stride + instance count.
 *
 * - `stride === 1`: instance `i` connects points `i → i+1` (full fidelity)
 * - `stride > 1`: instance `i` connects `min(i*stride, last) → min((i+1)*stride, last)`
 *   so the polyline still ends on the final sample
 *
 * Does **not** change uploaded buffers or sampling mode.
 */
export function resolveDenseDrawStride(input: DenseDrawStrideInput): DenseDrawStrideResult {
  const pointCount = Number.isFinite(input.pointCount) && input.pointCount > 0 ? Math.floor(input.pointCount) : 0;
  if (pointCount < 2) {
    return { stride: 1, drawSegmentCount: 0, lastPointIndex: 0, dense: false };
  }
  const lastPointIndex = pointCount - 1;
  const fullSegments = lastPointIndex;

  if (input.forceStandard === true || pointCount < DENSE_DRAW_POINT_THRESHOLD) {
    return { stride: 1, drawSegmentCount: fullSegments, lastPointIndex, dense: false };
  }

  const maxDraw =
    Number.isFinite(input.maxDrawSegments) && (input.maxDrawSegments as number) > 0
      ? Math.floor(input.maxDrawSegments as number)
      : resolveMaxDrawSegments(input.plotWidthDevicePx);

  if (fullSegments <= maxDraw) {
    return { stride: 1, drawSegmentCount: fullSegments, lastPointIndex, dense: false };
  }

  const stride = Math.max(1, Math.ceil(fullSegments / maxDraw));
  const drawSegmentCount = Math.max(1, Math.ceil(fullSegments / stride));
  return { stride, drawSegmentCount, lastPointIndex, dense: stride > 1 };
}
