/**
 * Line draw policy for dense high-N paths (group 3 unsorted full rewrite) and
 * multi-series fill cliffs (group 1 N×M line series).
 *
 * At high segment counts, fill from thick AA quads under 4× MSAA dominates the frame.
 * This policy switches **draw only** to a 1-device-px `line-list` hairline when:
 * - single-series (or any series) point count ≥ {@link DENSE_HAIRLINE_POINT_THRESHOLD}, or
 * - multi-series total segment budget ≥ {@link MULTI_SERIES_HAIRLINE_SEGMENT_BUDGET}
 *   (group 1 1000×1000+ cliff; 500×500 stays standard AA).
 *
 * Does not change sampling, packing, or data residency. FIFO suite rows stay under
 * the per-series threshold when GPU/CPU decimation keeps displayed points low.
 *
 * @module lineDrawPolicy
 * @internal
 */

export type LineDrawPolicy = 'standard' | 'denseHairline';

export type LineDrawPolicyInput = Readonly<{
  readonly pointCount: number;
  readonly lineWidthCssPx: number;
  /**
   * Number of visible line series in the chart (optional).
   * Used with pointCount to estimate total segment fill for multi-series cliffs.
   */
  readonly lineSeriesCount?: number;
  /**
   * Main-pass multisample count (1 or 4). Dense hairline exists to avoid **4×
   * MSAA** overdraw on high-N line-list. When main is already `sampleCount: 1`
   * (`antialias: false` multi-chart), keep standard AA quads:
   * - Native `line-list` looks dashed/faint without MSAA (Metal diamond coverage)
   * - Deferred hairline pass is only opened when `msaaSampleCount > 1`, so
   *   selecting hairline at sampleCount 1 would draw nothing (blank stroke)
   */
  readonly msaaSampleCount?: number;
  /**
   * When true (`performance.lod: 'strict'`), always use standard AA quads and
   * honor configured line width — never enter dense hairline.
   */
  readonly forceStandard?: boolean;
}>;

export type LineDrawPolicyResult = Readonly<{
  readonly policy: LineDrawPolicy;
  /** Effective CSS width for the AA-quad path. Hairline ignores width (native 1 device px). */
  readonly effectiveLineWidthCssPx: number;
}>;

/**
 * Enter dense hairline (line-list) at/above this point count.
 * Chosen so group 3 **10k** stays full AA quads (~display refresh) while **50k**
 * leaves the AA-quad fill cliff (primary DoD row).
 */
export const DENSE_HAIRLINE_POINT_THRESHOLD = 25_000;

/**
 * Multi-series total-segment budget for hairline.
 *
 * Group 1 rows (seriesNum === pointsNum):
 * - 500×500 → ~249k segments → **standard** (protect display-refresh win)
 * - 1000×1000 → ~999k segments → **denseHairline** (mid multi-series cliff)
 * - 2000×2000+ → multi-M segments → **denseHairline**
 *
 * **Approximation:** budget uses `lineSeriesCount * max(0, pointCount - 1)` with
 * this series' own `pointCount` (equal-N suite shape). Mixed lengths are not a
 * true sum of segments across series. `lineSeriesCount` should be **visible**
 * line series only (coordinator counts `visible !== false`).
 */
export const MULTI_SERIES_HAIRLINE_SEGMENT_BUDGET = 500_000;

/** Floor width reported for hairline bookkeeping (CSS px). Native stroke is 1 device px. */
export const DENSE_LINE_MIN_WIDTH_CSS = 1;

/**
 * Resolve draw-only line policy for high-N rewrites and multi-series cliffs.
 *
 * - `standard`: screen-space AA quads (width honored)
 * - `denseHairline`: WebGPU `line-list` (1 device px), drawn in a post-resolve sampleCount:1 pass
 *   (only when main MSAA is 4× — see {@link LineDrawPolicyInput.msaaSampleCount})
 */
export function resolveLineDrawPolicy(input: LineDrawPolicyInput): LineDrawPolicyResult {
  const w = Number.isFinite(input.lineWidthCssPx) && input.lineWidthCssPx > 0 ? input.lineWidthCssPx : 2;
  const pointCount = Number.isFinite(input.pointCount) && input.pointCount > 0 ? Math.floor(input.pointCount) : 0;
  const lineSeriesCount =
    Number.isFinite(input.lineSeriesCount) && (input.lineSeriesCount as number) > 0
      ? Math.floor(input.lineSeriesCount as number)
      : 1;
  // Strict LOD: always honor configured width + AA quads (no dense hairline).
  if (input.forceStandard === true) {
    return { policy: 'standard', effectiveLineWidthCssPx: w };
  }
  // Default allow hairline when msaaSampleCount omitted (unit tests / 4× default path).
  const msaa =
    Number.isFinite(input.msaaSampleCount) && (input.msaaSampleCount as number) > 0
      ? Math.floor(input.msaaSampleCount as number)
      : 4;
  // sampleCount 1: never hairline (visual + undrawn-pass bug with multi-chart antialias:false).
  if (msaa <= 1) {
    return { policy: 'standard', effectiveLineWidthCssPx: w };
  }

  const perSeriesHairline = pointCount >= DENSE_HAIRLINE_POINT_THRESHOLD;
  const segmentsPerSeries = Math.max(0, pointCount - 1);
  const approxTotalSegments = lineSeriesCount * segmentsPerSeries;
  const multiSeriesHairline = lineSeriesCount >= 2 && approxTotalSegments >= MULTI_SERIES_HAIRLINE_SEGMENT_BUDGET;

  if (!perSeriesHairline && !multiSeriesHairline) {
    return { policy: 'standard', effectiveLineWidthCssPx: w };
  }
  // Hairline: native line width is always 1 device px; report min(w, 1) for uniform bookkeeping.
  const floor = Math.min(w, DENSE_LINE_MIN_WIDTH_CSS);
  return {
    policy: 'denseHairline',
    effectiveLineWidthCssPx: floor,
  };
}
