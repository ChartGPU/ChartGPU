import type {
  BandSeriesData,
  DataPoint,
  CartesianSeriesData,
  DataPointTuple,
  ScatterPointTuple,
} from '../config/types';
import type {
  ResolvedBarSeriesConfig,
  ResolvedScatterSeriesConfig,
  ResolvedSeriesConfig,
} from '../config/OptionResolver';
import type { LinearScale } from '../utils/scales';
import { bucketStackedXKey } from '../utils/barStackKey';
import { getPointCount, getX, getY, getSize } from '../data/cartesianData';
import { getBandLength, getBandPoint } from '../data/bandData';
import { isMonotonicNonDecreasingFiniteX } from '../core/renderCoordinator/data/computeVisibleSlice';
import {
  computeStackedAreaBaselines,
  findStackedMountainHit,
  groupStackedMountainLayers,
  resolveStackedMountainDataView,
} from '../data/stackedArea';

const DEFAULT_MAX_DISTANCE_PX = 20;
const DEFAULT_BAR_GAP = 0.01; // Minimal gap between bars within a group (was 0.1)
const DEFAULT_BAR_CATEGORY_GAP = 0.2;
const DEFAULT_SCATTER_RADIUS_CSS_PX = 4;
/**
 * Above this count, never full-linear-scan for nearest (would freeze multi‑M hover
 * and block streaming). Use lowerBound + x-window expand instead (best-effort if
 * non-monotonic).
 */
const LARGE_N_NO_FULL_LINEAR = 8_192;
/**
 * Max samples inside the maxDistance x-window before we stride.
 * Full-span multi‑M (e.g. 16M pts on ~1000 CSS px) puts **hundreds of thousands**
 * of points under a 20px hit radius. Walking them every hover frame freezes
 * setInterval streaming even when mono/binary-search is correct. Stride the
 * window then refine around the best / x-nearest index.
 */
const DENSE_EXPAND_MAX_SAMPLES = 4_096;

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
  /**
   * Domain data point for tooltips / APIs.
   * Stacked mountain: `[x, contributionY]` (layer’s own y, not cumulative top).
   */
  point: DataPoint;
  /** Euclidean distance in range units. */
  distance: number;
  /** Stack group id when the hit is a stacked mountain/area layer. */
  stack?: string;
  /**
   * Stacked mountain: composition total at hit x.
   * `point.y` / contribution remains the layer’s own y.
   */
  stackTotal?: number;
  /**
   * Domain Y for the hover highlight marker when it must not equal `point.y`.
   * Stacked mountain: layer **yTop** (where the stroke is drawn), so the ring
   * sits on the visible layer surface rather than at contribution y near 0.
   */
  highlightY?: number;
}>;

export type BarBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export function isPointInBar(x: number, y: number, barBounds: BarBounds): boolean {
  // Inclusive bounds.
  // Note: stacked bar segments can share edges; tie-breaking is handled by the caller.
  return x >= barBounds.left && x <= barBounds.right && y >= barBounds.top && y <= barBounds.bottom;
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

const safeCallSymbolSize = (fn: (value: ScatterPointTuple) => number, value: ScatterPointTuple): number | null => {
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
    return Number.isFinite(seriesSymbolSize) ? Math.max(0, seriesSymbolSize) : DEFAULT_SCATTER_RADIUS_CSS_PX;
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

export function computeBarClusterSlots(seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>): BarClusterSlots {
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
  categoryStep: number
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

const computeSharedBarLayout = (seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>): BarSharedLayout => {
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
  xScale: LinearScale
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
  yScale: LinearScale
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
  plotHeightPx: number
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
  /**
   * Optional per-axis Y scales for multi-axis charts. When provided, stacked
   * mountain hits invert cursor Y with the group's yAxis scale (issue 6).
   * Other series still use the primary `yScale` (caller usually primary left).
   */
  yScalesByAxis?: ReadonlyMap<string, LinearScale>
): NearestPointMatch | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const md = Number.isFinite(maxDistance) ? Math.max(0, maxDistance) : DEFAULT_MAX_DISTANCE_PX;
  const maxDistSq = md * md;

  const xTarget = xScale.invert(x);
  if (!Number.isFinite(xTarget)) return null;

  const resolveYScaleForSeries = (seriesIndex: number): LinearScale => {
    if (!yScalesByAxis || yScalesByAxis.size === 0) return yScale;
    const s = series[seriesIndex] as { yAxis?: string } | undefined;
    const axisId = s?.yAxis ?? 'y';
    return yScalesByAxis.get(axisId) ?? yScale;
  };

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

  // Stacked mountain/area: hit prefers topmost layer under cursor between yBottom and yTop (D8).
  // Runs before generic cartesian nearest-point so fill hits win over stroke distance.
  {
    const groups = groupStackedMountainLayers(series, { includeHidden: false });
    if (groups.size > 0) {
      // Domain x tolerance from maxDistance CSS px near cursor.
      const xLeft = xScale.invert(x - md);
      const xRight = xScale.invert(x + md);
      const xTol = Number.isFinite(xLeft) && Number.isFinite(xRight) ? Math.abs(xRight - xLeft) / 2 : 0;

      let bestStack: NearestPointMatch | null = null;
      for (const members of groups.values()) {
        if (members.length === 0) continue;
        // Per-group yAxis scale (multi-axis stacks — issue 6).
        const groupYScale = resolveYScaleForSeries(members[0]!.seriesIndex);
        const yTarget = groupYScale.invert(y);
        if (!Number.isFinite(yTarget)) continue;

        // Same data view as prepare pack: connectNulls → filterGaps; sampling none → raw.
        const layers = members.map((m) => ({
          seriesIndex: m.seriesIndex,
          data: resolveStackedMountainDataView(
            m.series as {
              sampling?: string;
              connectNulls?: boolean;
              data?: CartesianSeriesData;
              rawData?: CartesianSeriesData;
            }
          ),
        }));
        const geometries = computeStackedAreaBaselines(layers);
        const hit = findStackedMountainHit({
          layers,
          geometries,
          xTarget,
          yTarget,
          xTolerance: xTol,
        });
        if (!hit) continue;
        const stackId = normalizeStackId((series[hit.seriesIndex] as { stack?: unknown } | undefined)?.stack);
        const cand: NearestPointMatch = {
          seriesIndex: hit.seriesIndex,
          dataIndex: hit.dataIndex,
          // Tooltip / API: layer contribution. Highlight: cumulative yTop (stroke surface).
          point: [hit.x, hit.contributionY],
          distance: 0,
          highlightY: hit.yTop,
          ...(stackId !== '' ? { stack: stackId } : {}),
          stackTotal: hit.stackTotal,
        };
        // Prefer higher seriesIndex (topmost in array order among hits).
        if (
          bestStack === null ||
          cand.seriesIndex > bestStack.seriesIndex ||
          (cand.seriesIndex === bestStack.seriesIndex && cand.dataIndex < bestStack.dataIndex)
        ) {
          bestStack = cand;
        }
      }
      if (bestStack) return bestStack;
    }
  }

  if (barSeriesConfigs.length > 0) {
    const layoutPx = computeBarLayoutPx(barSeriesConfigs, xScale);
    if (layoutPx.barWidthPx > 0 && layoutPx.clusterWidthPx >= 0) {
      const plotHeightPx = inferPlotHeightPxForBarHitTesting(barSeriesConfigs, yScale);
      const { baselineDomain, baselinePx } = computeBaselineDomainAndPx(barSeriesConfigs, yScale, plotHeightPx);

      const { clusterSlots, barWidthPx, gapPx, clusterWidthPx, categoryWidthPx, categoryStep } = layoutPx;
      const stackSumsByStackId = new Map<string, Map<number, { posSum: number; negSum: number }>>();

      let bestBarHit: {
        readonly seriesIndex: number;
        readonly dataIndex: number;
        readonly top: number;
      } | null = null;

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
            bestBarHit = {
              seriesIndex: originalSeriesIndex,
              dataIndex: i,
              top: bounds.top,
            };
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

  // Band series: prefer nearest-x sample (plan D7), then attach y/y1 from that index.
  // Distance uses midline in screen space for multi-series tie-breaks.
  for (let s = 0; s < series.length; s++) {
    const seriesCfg = series[s];
    if (seriesCfg.type !== 'band' || seriesCfg.visible === false) continue;
    const data = seriesCfg.data as BandSeriesData;
    const n = getBandLength(data);
    if (n === 0) continue;

    let mono = true;
    let prevBandX = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const p = getBandPoint(data, i);
      if (!p || !Number.isFinite(p.x)) {
        mono = false;
        break;
      }
      if (p.x < prevBandX) {
        mono = false;
        break;
      }
      prevBandX = p.x;
    }

    const considerBandIndex = (i: number): void => {
      const p = getBandPoint(data, i);
      if (!p || !Number.isFinite(p.x)) return;
      const y0 = Number.isFinite(p.y) ? p.y : Number.NaN;
      const y1v = Number.isFinite(p.y1) ? p.y1 : Number.NaN;
      if (!Number.isFinite(y0) && !Number.isFinite(y1v)) return;
      const midY = Number.isFinite(y0) && Number.isFinite(y1v) ? (y0 + y1v) / 2 : Number.isFinite(y0) ? y0 : y1v;
      const sx = xScale.scale(p.x);
      const sy = yScale.scale(midY);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
      const dx = sx - x;
      const dy = sy - y;
      const distSq = dx * dx + dy * dy;
      if (distSq > maxDistSq) return;
      const isBetter =
        distSq < bestDistSq ||
        (distSq === bestDistSq &&
          (bestPoint === null || s < bestSeriesIndex || (s === bestSeriesIndex && i < bestDataIndex)));
      if (isBetter) {
        bestDistSq = distSq;
        bestSeriesIndex = s;
        bestDataIndex = i;
        bestPoint = [p.x, Number.isFinite(y0) ? y0 : midY];
      }
    };

    if (mono) {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const px = getBandPoint(data, mid)?.x ?? Number.NaN;
        if (px < xTarget) lo = mid + 1;
        else hi = mid;
      }
      const startIdx = lo;
      for (let i = startIdx; i < n; i++) {
        const p = getBandPoint(data, i);
        if (!p || !Number.isFinite(p.x)) continue;
        const sx = xScale.scale(p.x);
        if (!Number.isFinite(sx)) continue;
        const dx = sx - x;
        if (dx * dx > bestDistSq && bestPoint !== null) break;
        considerBandIndex(i);
      }
      for (let i = startIdx - 1; i >= 0; i--) {
        const p = getBandPoint(data, i);
        if (!p || !Number.isFinite(p.x)) continue;
        const sx = xScale.scale(p.x);
        if (!Number.isFinite(sx)) continue;
        const dx = sx - x;
        if (dx * dx > bestDistSq && bestPoint !== null) break;
        considerBandIndex(i);
      }
    } else {
      let bestI = -1;
      let bestDx = Number.POSITIVE_INFINITY;
      for (let i = 0; i < n; i++) {
        const p = getBandPoint(data, i);
        if (!p || !Number.isFinite(p.x)) continue;
        if (!Number.isFinite(p.y) && !Number.isFinite(p.y1)) continue;
        const sx = xScale.scale(p.x);
        if (!Number.isFinite(sx)) continue;
        const dx = Math.abs(sx - x);
        if (dx < bestDx || (dx === bestDx && (bestI < 0 || i < bestI))) {
          bestDx = dx;
          bestI = i;
        }
      }
      if (bestI >= 0) considerBandIndex(bestI);
    }
  }

  // Build index mapping for non-bar cartesian series (scatter, line, area) to preserve original series indices
  // after filtering for visibility, matching the pattern used for bar series above.
  const cartesianSeriesConfigs: ResolvedSeriesConfig[] = [];
  const cartesianSeriesIndexMap: number[] = [];
  for (let s = 0; s < series.length; s++) {
    const seriesCfg = series[s];
    // Pie / candlestick / heatmap / band / errorBar / impulse handled separately.
    if (
      seriesCfg.type === 'pie' ||
      seriesCfg.type === 'candlestick' ||
      seriesCfg.type === 'ohlc' ||
      seriesCfg.type === 'heatmap' ||
      seriesCfg.type === 'band' ||
      seriesCfg.type === 'errorBar' ||
      seriesCfg.type === 'impulse'
    ) {
      continue;
    }

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

    // Multi‑M (incl. device auto-window ~16M at 128 MiB): never call mono —
    // even a "soft" mono scan or cache miss under hover freezes setInterval
    // streaming. Windowed lowerBound+expand is correct for mono line streams
    // and best-effort for unsorted. Small series still use exact mono check.
    const useWindowedSearch = n >= LARGE_N_NO_FULL_LINEAR || isMonotonicNonDecreasingFiniteX(data);

    const considerCartesianIndex = (i: number): boolean => {
      // Returns true when expand should stop (x beyond hit radius).
      const px = getX(data, i);
      const py = getY(data, i);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return false;

      const sx = xScale.scale(px);
      const sy = yScale.scale(py);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;

      const dx = sx - x;
      const dy = sy - y;
      const dxSq = dx * dx;
      // Hard stop: no point with |dx| > maxDistance can be a valid hit
      // (scatter radius added below for allowedSq only). Critical when
      // bestDistSq is still +∞ (all prior y non-finite) — without this,
      // mono expand scans the entire multi‑M series and freezes streaming.
      let allowedSq = maxDistSq;
      if (scatterCfg) {
        const size = getSize(data, i);
        const p: DataPoint = size !== undefined ? [px, py, size] : [px, py];
        const r = getScatterRadiusCssPx(scatterCfg, p);
        const allowed = md + r;
        allowedSq = allowed * allowed;
      }
      if (dxSq > allowedSq) return true;

      const distSq = dxSq + dy * dy;
      // Also stop when x alone exceeds the current best Euclidean distance.
      if (dxSq > bestDistSq) return true;

      if (distSq > allowedSq) return false;

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
      return false;
    };

    if (useWindowedSearch) {
      // Binary search, then only visit points whose range-x is within maxDistance.
      // Dense multi‑M: that window can still be O(100k+) indices — stride + refine.
      const startIdx = lowerBoundX(data, xTarget);

      // Scatter hit radius extends past `md`; pad the domain window a little so
      // large markers near the edge of the cursor radius are not skipped.
      const padPx = scatterCfg ? md + DEFAULT_SCATTER_RADIUS_CSS_PX * 4 : md;
      const xLo = xScale.invert(x - padPx);
      const xHi = xScale.invert(x + padPx);
      let iLeft = 0;
      let iRight = n;
      if (Number.isFinite(xLo) && Number.isFinite(xHi)) {
        const domainLeft = Math.min(xLo, xHi);
        const domainRight = Math.max(xLo, xHi);
        iLeft = lowerBoundX(data, domainLeft);
        // Exclusive end: first index with domain x > domainRight (mono).
        iRight = lowerBoundX(data, domainRight);
        while (iRight < n && getX(data, iRight) <= domainRight) {
          iRight++;
        }
      }
      // Always include the x-nearest neighbourhood even if invert failed.
      iLeft = Math.max(0, Math.min(iLeft, startIdx > 0 ? startIdx - 1 : 0));
      iRight = Math.min(n, Math.max(iRight, Math.min(n, startIdx + 1)));

      const span = iRight - iLeft;
      if (span <= 0) {
        // fall through — nothing in window
      } else if (span <= DENSE_EXPAND_MAX_SAMPLES) {
        for (let i = startIdx; i < iRight; i++) {
          if (considerCartesianIndex(i)) break;
        }
        for (let i = startIdx - 1; i >= iLeft; i--) {
          if (considerCartesianIndex(i)) break;
        }
      } else {
        // Dense window: stride so hover stays O(DENSE_EXPAND_MAX_SAMPLES), then
        // refine ±stride around the best hit (or x-nearest if no hit yet).
        const stride = Math.max(1, Math.ceil(span / DENSE_EXPAND_MAX_SAMPLES));
        for (let i = iLeft; i < iRight; i += stride) {
          considerCartesianIndex(i);
        }
        // Ensure the two x-nearest samples are always evaluated (exact for flat y).
        if (startIdx < n) considerCartesianIndex(startIdx);
        if (startIdx > 0) considerCartesianIndex(startIdx - 1);

        const refineCenter = bestSeriesIndex === originalSeriesIndex && bestDataIndex >= 0 ? bestDataIndex : startIdx;
        const refineLo = Math.max(iLeft, refineCenter - stride);
        const refineHi = Math.min(iRight, refineCenter + stride + 1);
        for (let i = refineLo; i < refineHi; i++) {
          considerCartesianIndex(i);
        }
      }
    } else {
      // Small non-monotonic series: full linear scan.
      for (let i = 0; i < n; i++) {
        considerCartesianIndex(i);
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
