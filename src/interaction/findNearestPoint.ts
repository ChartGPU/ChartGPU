import type { DataPoint, CartesianSeriesData, DataPointTuple, ScatterPointTuple } from '../config/types';
import type {
  ResolvedBarSeriesConfig,
  ResolvedScatterSeriesConfig,
  ResolvedSeriesConfig,
} from '../config/OptionResolver';
import type { LinearScale } from '../utils/scales';
import { getPointCount, getX, getY, getSize } from '../data/cartesianData';
import { isMonotonicNonDecreasingFiniteX } from '../core/renderCoordinator/data/computeVisibleSlice';

const DEFAULT_MAX_DISTANCE_PX = 20;
const DEFAULT_BAR_GAP = 0.01; // Minimal gap between bars within a group (was 0.1)
const DEFAULT_BAR_CATEGORY_GAP = 0.2;
const DEFAULT_SCATTER_RADIUS_CSS_PX = 4;

/**
 * Binary search: finds the lower bound index (first element >= target) in monotonic cartesian data.
 * Returns index in range [0, n] where n = point count.
 */
function lowerBoundX(data: CartesianSeriesData, xTarget: number): number {
  let lo = 0;
  let hi = getPointCount(data);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = getX(data, mid);
    if (x < xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type NearestPointMatch = Readonly<{
  seriesIndex: number;
  dataIndex: number;
  point: DataPoint;
  /** Euclidean distance in range units. */
  distance: number;
}>;

export type BarBounds = { left: number; right: number; top: number; bottom: number };

export function isPointInBar(x: number, y: number, barBounds: BarBounds): boolean {
  // Inclusive bounds.
  // Note: stacked bar segments can share edges; tie-breaking is handled by the caller.
  return (
    x >= barBounds.left &&
    x <= barBounds.right &&
    y >= barBounds.top &&
    y <= barBounds.bottom
  );
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const parsePercent = (value: string): number | null => {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
  if (!m) return null;
  const p = Number(m[1]) / 100;
  return Number.isFinite(p) ? p : null;
};

const normalizeStackId = (stack: unknown): string => {
  if (typeof stack !== 'string') return '';
  const trimmed = stack.trim();
  return trimmed.length > 0 ? trimmed : '';
};

const isTupleDataPoint = (p: DataPoint): p is DataPointTuple => Array.isArray(p);

const getPointSizeCssPx = (p: DataPoint): number | null => {
  if (isTupleDataPoint(p)) {
    const s = p[2];
    return typeof s === 'number' && Number.isFinite(s) ? s : null;
  }
  const s = p.size;
  return typeof s === 'number' && Number.isFinite(s) ? s : null;
};

const toScatterTuple = (p: DataPoint): ScatterPointTuple => {
  if (isTupleDataPoint(p)) return p;
  return [p.x, p.y, p.size] as const;
};

const safeCallSymbolSize = (
  fn: (value: ScatterPointTuple) => number,
  value: ScatterPointTuple,
): number | null => {
  try {
    const v = fn(value);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
};

const getScatterRadiusCssPx = (seriesCfg: ResolvedScatterSeriesConfig, p: DataPoint): number => {
  // Mirrors `createScatterRenderer.ts` size semantics (but stays in CSS px):
  // point.size -> series.symbolSize -> default 4px.
  const perPoint = getPointSizeCssPx(p);
  if (perPoint != null) return Math.max(0, perPoint);

  const seriesSymbolSize = seriesCfg.symbolSize;
  if (typeof seriesSymbolSize === 'number') {
    return Number.isFinite(seriesSymbolSize)
      ? Math.max(0, seriesSymbolSize)
      : DEFAULT_SCATTER_RADIUS_CSS_PX;
  }
  if (typeof seriesSymbolSize === 'function') {
    const v = safeCallSymbolSize(seriesSymbolSize, toScatterTuple(p));
    return v == null ? DEFAULT_SCATTER_RADIUS_CSS_PX : Math.max(0, v);
  }

  return DEFAULT_SCATTER_RADIUS_CSS_PX;
};


// Note: we intentionally do NOT compute “nearest bar by distance”.
// Bars are only considered a match when the cursor is inside their rect bounds.

export type BarClusterSlots = Readonly<{
  clusterIndexBySeries: ReadonlyArray<number>;
  clusterCount: number;
  stackIdBySeries: ReadonlyArray<string>;
}>;

export function computeBarClusterSlots(
  seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
): BarClusterSlots {
  // Cluster slots (mirrors `createBarRenderer.ts`):
  // - Each unique non-empty stackId gets a single cluster slot.
  // - Each unstacked series gets its own cluster slot.
  const stackIdToClusterIndex = new Map<string, number>();
  const clusterIndexBySeries: number[] = new Array(seriesConfigs.length);
  const stackIdBySeries: string[] = new Array(seriesConfigs.length);

  let clusterCount = 0;
  for (let i = 0; i < seriesConfigs.length; i++) {
    const stackId = normalizeStackId(seriesConfigs[i].stack);
    stackIdBySeries[i] = stackId;

    if (stackId !== '') {
      const existing = stackIdToClusterIndex.get(stackId);
      if (existing !== undefined) {
        clusterIndexBySeries[i] = existing;
      } else {
        const idx = clusterCount++;
        stackIdToClusterIndex.set(stackId, idx);
        clusterIndexBySeries[i] = idx;
      }
    } else {
      clusterIndexBySeries[i] = clusterCount++;
    }
  }

  return {
    clusterIndexBySeries,
    clusterCount: Math.max(1, clusterCount),
    stackIdBySeries,
  };
}

export function computeBarCategoryStep(seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>): number {
  const xs: number[] = [];
  for (let s = 0; s < seriesConfigs.length; s++) {
    const data = seriesConfigs[s].data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const x = getX(data, i);
      if (Number.isFinite(x)) xs.push(x);
    }
  }

  if (xs.length < 2) return 1;
  xs.sort((a, b) => a - b);

  let minStep = Number.POSITIVE_INFINITY;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > 0 && d < minStep) minStep = d;
  }
  return Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
}

export function computeCategoryWidthPx(
  seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
  xScale: LinearScale,
  categoryStep: number,
): number {
  // Primary path (mirrors renderer): derive width from domain step via scale().
  if (Number.isFinite(categoryStep) && categoryStep > 0) {
    const x0 = 0;
    const p0 = xScale.scale(x0);
    const p1 = xScale.scale(x0 + categoryStep);
    const w = Math.abs(p1 - p0);
    if (Number.isFinite(w) && w > 0) return w;
  }

  // Fallback: compute min positive delta in *scaled* x positions.
  const sx: number[] = [];
  for (let s = 0; s < seriesConfigs.length; s++) {
    const data = seriesConfigs[s].data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const x = getX(data, i);
      if (!Number.isFinite(x)) continue;
      const px = xScale.scale(x);
      if (Number.isFinite(px)) sx.push(px);
    }
  }
  if (sx.length < 2) return 0;
  sx.sort((a, b) => a - b);

  let minDx = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sx.length; i++) {
    const d = sx[i] - sx[i - 1];
    if (d > 0 && d < minDx) minDx = d;
  }

  return Number.isFinite(minDx) && minDx > 0 ? minDx : 0;
}

type BarSharedLayout = Readonly<{
  barWidth?: number | string;
  barGap?: number;
  barCategoryGap?: number;
}>;

const computeSharedBarLayout = (
  seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
): BarSharedLayout => {
  let barWidth: number | string | undefined = undefined;
  let barGap: number | undefined = undefined;
  let barCategoryGap: number | undefined = undefined;

  for (let i = 0; i < seriesConfigs.length; i++) {
    const s = seriesConfigs[i];
    if (barWidth === undefined && s.barWidth !== undefined) barWidth = s.barWidth;
    if (barGap === undefined && s.barGap !== undefined) barGap = s.barGap;
    if (barCategoryGap === undefined && s.barCategoryGap !== undefined) barCategoryGap = s.barCategoryGap;
  }

  return { barWidth, barGap, barCategoryGap };
};

export type BarLayoutPx = Readonly<{
  categoryStep: number;
  categoryWidthPx: number;
  barWidthPx: number;
  gapPx: number;
  clusterWidthPx: number;
  clusterSlots: BarClusterSlots;
}>;

export function computeBarLayoutPx(
  seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
  xScale: LinearScale,
): BarLayoutPx {
  const clusterSlots = computeBarClusterSlots(seriesConfigs);
  const clusterCount = clusterSlots.clusterCount;

  const categoryStep = computeBarCategoryStep(seriesConfigs);
  const categoryWidthPx = computeCategoryWidthPx(seriesConfigs, xScale, categoryStep);

  const layout = computeSharedBarLayout(seriesConfigs);
  const barGap = clamp01(layout.barGap ?? DEFAULT_BAR_GAP);
  const barCategoryGap = clamp01(layout.barCategoryGap ?? DEFAULT_BAR_CATEGORY_GAP);

  const categoryInnerWidthPx = Math.max(0, categoryWidthPx * (1 - barCategoryGap));
  const denom = clusterCount + Math.max(0, clusterCount - 1) * barGap;
  const maxBarWidthPx = denom > 0 ? categoryInnerWidthPx / denom : 0;

  let barWidthPx = 0;
  const rawBarWidth = layout.barWidth;
  if (typeof rawBarWidth === 'number') {
    barWidthPx = Math.max(0, rawBarWidth);
    barWidthPx = Math.min(barWidthPx, maxBarWidthPx);
  } else if (typeof rawBarWidth === 'string') {
    const p = parsePercent(rawBarWidth);
    barWidthPx = p == null ? 0 : maxBarWidthPx * clamp01(p);
  }

  if (!(barWidthPx > 0)) {
    // Auto-width: max per-bar width that still avoids overlap (given clusterCount and barGap).
    barWidthPx = maxBarWidthPx;
  }

  const gapPx = barWidthPx * barGap;
  const clusterWidthPx = clusterCount * barWidthPx + Math.max(0, clusterCount - 1) * gapPx;

  return {
    categoryStep,
    categoryWidthPx,
    barWidthPx,
    gapPx,
    clusterWidthPx,
    clusterSlots,
  };
}

const computeBaselineForBarsFromData = (seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>): number => {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < seriesConfigs.length; s++) {
    const data = seriesConfigs[s].data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const y = getY(data, i);
      if (!Number.isFinite(y)) continue;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return 0;
  if (yMin <= 0 && 0 <= yMax) return 0;
  return Math.abs(yMin) < Math.abs(yMax) ? yMin : yMax;
};

export function inferPlotHeightPxForBarHitTesting(
  seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
  yScale: LinearScale,
): number {
  // We don't have direct access to the scale range endpoints, so infer the plot height in range-space.
  // In the common ChartGPU interaction setup, yScale.range(plotHeightCss, 0), so max(scaledY) should
  // approximate plotHeightCss (or be <= plotHeightCss if axis min/max are overridden).
  let maxY = 0;
  for (let s = 0; s < seriesConfigs.length; s++) {
    const data = seriesConfigs[s].data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const y = getY(data, i);
      if (!Number.isFinite(y)) continue;
      const py = yScale.scale(y);
      if (Number.isFinite(py) && py > maxY) maxY = py;
    }
  }
  return Math.max(0, maxY);
}

export function computeBaselineDomainAndPx(
  seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
  yScale: LinearScale,
  plotHeightPx: number,
): Readonly<{ baselineDomain: number; baselinePx: number }> {
  // Axis-aware baseline logic (mirrors `createBarRenderer.ts`, but in px-space):
  // Determine visible y-domain from yScale via invert(bottom/top) where top=0 and bottom=plotHeightPx.
  const yDomainA = yScale.invert(plotHeightPx);
  const yDomainB = yScale.invert(0);
  const yMin = Math.min(yDomainA, yDomainB);
  const yMax = Math.max(yDomainA, yDomainB);

  let baselineDomain: number;
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    baselineDomain = computeBaselineForBarsFromData(seriesConfigs);
  } else if (yMin <= 0 && 0 <= yMax) {
    baselineDomain = 0;
  } else if (yMin > 0) {
    baselineDomain = yMin;
  } else if (yMax < 0) {
    baselineDomain = yMax;
  } else {
    baselineDomain = computeBaselineForBarsFromData(seriesConfigs);
  }

  let baselinePx = yScale.scale(baselineDomain);
  if (!Number.isFinite(baselinePx)) {
    baselineDomain = computeBaselineForBarsFromData(seriesConfigs);
    baselinePx = yScale.scale(baselineDomain);
  }
  if (!Number.isFinite(baselinePx)) {
    baselineDomain = 0;
    baselinePx = yScale.scale(0);
  }

  return { baselineDomain, baselinePx };
}

export function bucketStackedXKey(
  xCenterPx: number,
  categoryWidthPx: number,
  xDomain: number,
  categoryStep: number,
): number {
  // Match renderer intent:
  // - Prefer bucketing in *range-space* to avoid float-equality issues in domain-x.
  // - Requirement: Math.round(xCenterPx / categoryWidthPx) (grid-local).
  if (Number.isFinite(categoryWidthPx) && categoryWidthPx > 0 && Number.isFinite(xCenterPx)) {
    return Math.round(xCenterPx / categoryWidthPx);
  }
  if (Number.isFinite(categoryStep) && categoryStep > 0 && Number.isFinite(xDomain)) {
    return Math.round(xDomain / categoryStep);
  }
  return Math.round(xDomain * 1e6);
}

/**
 * Finds the nearest data point to the given cursor position across all series.
 *
 * Coordinate system contract:
 * - `x`/`y` MUST be in the same units as `xScale`/`yScale` **range**.
 * - If you pass **grid-local CSS pixels** (e.g. `payload.gridX` / `payload.gridY` from `createEventManager`),
 *   then `xScale.range()` / `yScale.range()` must also be in **CSS pixels**.
 * - If your scales are in **clip space** (e.g. \([-1, 1]\)), pass cursor coordinates in clip space too.
 *
 * DPR/WebGPU note:
 * - Pointer events are naturally in CSS pixels; WebGPU rendering often uses device pixels or clip space.
 *   This helper stays agnostic and only computes Euclidean distance in the provided **range-space**.
 *
 * Performance notes:
 * - Assumes each series is sorted by increasing x in domain space.
 * - Uses per-series lower-bound binary search on x, then expands outward while x-distance alone can still win.
 * - Uses squared distance comparisons and computes `sqrt` only for the final match.
 * - Skips non-finite points and any points whose scaled coordinates are NaN.
 */
export function findNearestPoint(
  series: ReadonlyArray<ResolvedSeriesConfig>,
  x: number,
  y: number,
  xScale: LinearScale,
  yScale: LinearScale,
  maxDistance: number = DEFAULT_MAX_DISTANCE_PX,
): NearestPointMatch | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const md = Number.isFinite(maxDistance)
    ? Math.max(0, maxDistance)
    : DEFAULT_MAX_DISTANCE_PX;
  const maxDistSq = md * md;

  const xTarget = xScale.invert(x);
  if (!Number.isFinite(xTarget)) return null;

  let bestSeriesIndex = -1;
  let bestDataIndex = -1;
  let bestPoint: DataPoint | null = null;
  let bestDistSq = Number.POSITIVE_INFINITY;

  // Story 4.6: Bar hit-testing (range-space bounds).
  // - Only counts as a match when cursor is inside a bar rect.
  // - For stacked bars, uses the same stacking bucket logic as the bar renderer (xKey bucketing).
  // - If multiple segments match (shared edges), prefer visually topmost (smallest `top` in CSS px).
  //   If still tied, prefer larger `seriesIndex` for determinism.
  const barSeriesConfigs: ResolvedBarSeriesConfig[] = [];
  const barSeriesIndexByBar: number[] = [];
  for (let s = 0; s < series.length; s++) {
    const cfg = series[s];
    if (cfg?.type === 'bar' && cfg.visible !== false) {
      barSeriesConfigs.push(cfg);
      barSeriesIndexByBar.push(s);
    }
  }

  if (barSeriesConfigs.length > 0) {
    const layoutPx = computeBarLayoutPx(barSeriesConfigs, xScale);
    if (layoutPx.barWidthPx > 0 && layoutPx.clusterWidthPx >= 0) {
      const plotHeightPx = inferPlotHeightPxForBarHitTesting(barSeriesConfigs, yScale);
      const { baselineDomain, baselinePx } = computeBaselineDomainAndPx(barSeriesConfigs, yScale, plotHeightPx);

      const { clusterSlots, barWidthPx, gapPx, clusterWidthPx, categoryWidthPx, categoryStep } = layoutPx;
      const stackSumsByStackId = new Map<string, Map<number, { posSum: number; negSum: number }>>();

      let bestBarHit:
        | {
            readonly seriesIndex: number;
            readonly dataIndex: number;
            readonly top: number;
          }
        | null = null;

      for (let b = 0; b < barSeriesConfigs.length; b++) {
        const seriesCfg = barSeriesConfigs[b];
        const originalSeriesIndex = barSeriesIndexByBar[b] ?? -1;
        if (originalSeriesIndex < 0) continue;

        const data = seriesCfg.data as CartesianSeriesData;
        const n = getPointCount(data);
        const clusterIndex = clusterSlots.clusterIndexBySeries[b] ?? 0;
        const stackId = clusterSlots.stackIdBySeries[b] ?? '';

        for (let i = 0; i < n; i++) {
          const xDomain = getX(data, i);
          const yDomain = getY(data, i);
          if (!Number.isFinite(xDomain) || !Number.isFinite(yDomain)) continue;

          const xCenterPx = xScale.scale(xDomain);
          if (!Number.isFinite(xCenterPx)) continue;

          const left = xCenterPx - clusterWidthPx / 2 + clusterIndex * (barWidthPx + gapPx);
          const right = left + barWidthPx;

          let baseDomain = baselineDomain;
          let topDomain = yDomain;

          if (stackId !== '') {
            let sumsForX = stackSumsByStackId.get(stackId);
            if (!sumsForX) {
              sumsForX = new Map<number, { posSum: number; negSum: number }>();
              stackSumsByStackId.set(stackId, sumsForX);
            }

            const xKey = bucketStackedXKey(xCenterPx, categoryWidthPx, xDomain, categoryStep);
            let sums = sumsForX.get(xKey);
            if (!sums) {
              sums = { posSum: baselineDomain, negSum: baselineDomain };
              sumsForX.set(xKey, sums);
            }

            if (yDomain >= 0) {
              baseDomain = sums.posSum;
              topDomain = baseDomain + yDomain;
              sums.posSum = topDomain;
            } else {
              baseDomain = sums.negSum;
              topDomain = baseDomain + yDomain;
              sums.negSum = topDomain;
            }
          } else {
            baseDomain = baselineDomain;
            topDomain = yDomain;
          }

          const basePx = stackId !== '' ? yScale.scale(baseDomain) : baselinePx;
          const topPx = yScale.scale(topDomain);
          if (!Number.isFinite(basePx) || !Number.isFinite(topPx)) continue;

          const bounds: BarBounds = {
            left,
            right,
            top: Math.min(basePx, topPx),
            bottom: Math.max(basePx, topPx),
          };

          if (!isPointInBar(x, y, bounds)) continue;

          const isBetter =
            bestBarHit === null ||
            bounds.top < bestBarHit.top ||
            (bounds.top === bestBarHit.top && originalSeriesIndex > bestBarHit.seriesIndex);

          if (isBetter) {
            bestBarHit = { seriesIndex: originalSeriesIndex, dataIndex: i, top: bounds.top };
          }
        }
      }

      if (bestBarHit) {
        const seriesData = series[bestBarHit.seriesIndex]?.data as CartesianSeriesData | undefined;
        if (seriesData) {
          const x = getX(seriesData, bestBarHit.dataIndex);
          const y = getY(seriesData, bestBarHit.dataIndex);
          const size = getSize(seriesData, bestBarHit.dataIndex);
          const point: DataPoint = size !== undefined ? [x, y, size] : [x, y];
          return {
            seriesIndex: bestBarHit.seriesIndex,
            dataIndex: bestBarHit.dataIndex,
            point,
            distance: 0,
          };
        }
      }
    }
  }

  // Build index mapping for non-bar cartesian series (scatter, line, area) to preserve original series indices
  // after filtering for visibility, matching the pattern used for bar series above.
  const cartesianSeriesConfigs: ResolvedSeriesConfig[] = [];
  const cartesianSeriesIndexMap: number[] = [];
  for (let s = 0; s < series.length; s++) {
    const seriesCfg = series[s];
    // Pie and candlestick series are non-cartesian (or not yet implemented); they don't participate in x/y nearest-point hit-testing.
    if (seriesCfg.type === 'pie' || seriesCfg.type === 'candlestick') continue;

    // Skip invisible series (matches bar series visibility check above).
    if (seriesCfg.visible === false) continue;

    cartesianSeriesConfigs.push(seriesCfg);
    cartesianSeriesIndexMap.push(s);
  }

  for (let s = 0; s < cartesianSeriesConfigs.length; s++) {
    const seriesCfg = cartesianSeriesConfigs[s];
    const originalSeriesIndex = cartesianSeriesIndexMap[s] ?? -1;
    if (originalSeriesIndex < 0) continue;

    const data = seriesCfg.data as CartesianSeriesData;
    const n = getPointCount(data);
    if (n === 0) continue;

    const isScatter = seriesCfg.type === 'scatter';
    const scatterCfg = isScatter ? (seriesCfg as ResolvedScatterSeriesConfig) : null;

    // Check if data is monotonic for O(log n) fast path
    const canBinarySearch = isMonotonicNonDecreasingFiniteX(data);

    if (canBinarySearch) {
      // Fast path: binary search + expand outward
      // Find the index where data[i].x >= xTarget (lower bound)
      const startIdx = lowerBoundX(data, xTarget);

      // Expand outward from startIdx while points could still be closer
      // Check right side first (startIdx onwards)
      for (let i = startIdx; i < n; i++) {
        const px = getX(data, i);
        const py = getY(data, i);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;

        const sx = xScale.scale(px);
        const sy = yScale.scale(py);
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;

        const dx = sx - x;
        const dy = sy - y;
        const distSq = dx * dx + dy * dy;

        // Early exit: if x-distance alone exceeds current best, no point can be closer (monotonic x)
        const dxSq = dx * dx;
        if (dxSq > bestDistSq) break;

        // Check scatter radius if applicable
        let allowedSq = maxDistSq;
        if (scatterCfg) {
          const size = getSize(data, i);
          const p: DataPoint = size !== undefined ? [px, py, size] : [px, py];
          const r = getScatterRadiusCssPx(scatterCfg, p);
          const allowed = md + r;
          allowedSq = allowed * allowed;
        }

        if (distSq > allowedSq) continue;

        const isBetter =
          distSq < bestDistSq ||
          (distSq === bestDistSq &&
            (bestPoint === null ||
              originalSeriesIndex < bestSeriesIndex ||
              (originalSeriesIndex === bestSeriesIndex && i < bestDataIndex)));

        if (isBetter) {
          bestDistSq = distSq;
          bestSeriesIndex = originalSeriesIndex;
          bestDataIndex = i;
          const size = getSize(data, i);
          bestPoint = size !== undefined ? [px, py, size] : [px, py];
        }
      }

      // Check left side (before startIdx)
      for (let i = startIdx - 1; i >= 0; i--) {
        const px = getX(data, i);
        const py = getY(data, i);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;

        const sx = xScale.scale(px);
        const sy = yScale.scale(py);
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;

        const dx = sx - x;
        const dy = sy - y;
        const distSq = dx * dx + dy * dy;

        // Early exit: if x-distance alone exceeds current best, no point can be closer
        const dxSq = dx * dx;
        if (dxSq > bestDistSq) break;

        // Check scatter radius if applicable
        let allowedSq = maxDistSq;
        if (scatterCfg) {
          const size = getSize(data, i);
          const p: DataPoint = size !== undefined ? [px, py, size] : [px, py];
          const r = getScatterRadiusCssPx(scatterCfg, p);
          const allowed = md + r;
          allowedSq = allowed * allowed;
        }

        if (distSq > allowedSq) continue;

        const isBetter =
          distSq < bestDistSq ||
          (distSq === bestDistSq &&
            (bestPoint === null ||
              originalSeriesIndex < bestSeriesIndex ||
              (originalSeriesIndex === bestSeriesIndex && i < bestDataIndex)));

        if (isBetter) {
          bestDistSq = distSq;
          bestSeriesIndex = originalSeriesIndex;
          bestDataIndex = i;
          const size = getSize(data, i);
          bestPoint = size !== undefined ? [px, py, size] : [px, py];
        }
      }
    } else {
      // Fallback: linear scan for non-monotonic data
      for (let i = 0; i < n; i++) {
        const px = getX(data, i);
        const py = getY(data, i);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;

        const sx = xScale.scale(px);
        const sy = yScale.scale(py);
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;

        const dx = sx - x;
        const dy = sy - y;
        const distSq = dx * dx + dy * dy;

        // Check scatter radius if applicable
        let allowedSq = maxDistSq;
        if (scatterCfg) {
          const size = getSize(data, i);
          const p: DataPoint = size !== undefined ? [px, py, size] : [px, py];
          const r = getScatterRadiusCssPx(scatterCfg, p);
          const allowed = md + r;
          allowedSq = allowed * allowed;
        }

        if (distSq > allowedSq) continue;

        const isBetter =
          distSq < bestDistSq ||
          (distSq === bestDistSq &&
            (bestPoint === null ||
              originalSeriesIndex < bestSeriesIndex ||
              (originalSeriesIndex === bestSeriesIndex && i < bestDataIndex)));

        if (isBetter) {
          bestDistSq = distSq;
          bestSeriesIndex = originalSeriesIndex;
          bestDataIndex = i;
          const size = getSize(data, i);
          bestPoint = size !== undefined ? [px, py, size] : [px, py];
        }
      }
    }
  }

  if (bestPoint === null) return null;
  if (!Number.isFinite(bestDistSq)) return null;

  return {
    seriesIndex: bestSeriesIndex,
    dataIndex: bestDataIndex,
    point: bestPoint,
    distance: Math.sqrt(bestDistSq),
  };
}

