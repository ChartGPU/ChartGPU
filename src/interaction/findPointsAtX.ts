import type { DataPoint, CartesianSeriesData } from '../config/types';
import type { ResolvedBarSeriesConfig, ResolvedSeriesConfig } from '../config/OptionResolver';
import type { LinearScale } from '../utils/scales';
import { computeBarLayoutPx } from './findNearestPoint';
import { getPointCount, getX, getY, getSize } from '../data/cartesianData';

export type PointsAtXMatch = Readonly<{
  seriesIndex: number;
  dataIndex: number;
  point: DataPoint;
}>;

const hasNaNXCache = new WeakMap<object, boolean>();

const seriesHasNaNX = (data: CartesianSeriesData): boolean => {
  // Use data object as cache key (works for arrays, typed arrays, and XYArraysData)
  const cacheKey = typeof data === 'object' && data !== null ? data : null;
  if (cacheKey && hasNaNXCache.has(cacheKey)) {
    return hasNaNXCache.get(cacheKey)!;
  }

  let hasNaN = false;
  const n = getPointCount(data);

  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    if (Number.isNaN(x)) {
      hasNaN = true;
      break;
    }
  }

  if (cacheKey) hasNaNXCache.set(cacheKey, hasNaN);
  return hasNaN;
};

type BarHitTestLayout = Readonly<{
  /** bar width in xScale range units (grid-local CSS px) */
  barWidth: number;
  /** gap between cluster slots, in xScale range units */
  gap: number;
  /** total cluster width (all bar slots), in xScale range units */
  clusterWidth: number;
  /** maps global series index -> cluster slot index */
  clusterIndexByGlobalSeriesIndex: ReadonlyMap<number, number>;
}>;

const computeBarHitTestLayout = (
  series: ReadonlyArray<ResolvedSeriesConfig>,
  xScale: LinearScale
): BarHitTestLayout | null => {
  // Mirror the bar renderer's shared layout math via `computeBarLayoutPx(...)`, but in xScale range units.
  // IMPORTANT: Bar layout depends on all bar series (stacking + grouped slots), not per-series.
  const barSeries: { readonly globalSeriesIndex: number; readonly s: ResolvedBarSeriesConfig }[] = [];
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    if (s?.type === 'bar') barSeries.push({ globalSeriesIndex: i, s });
  }
  if (barSeries.length === 0) return null;

  const layout = computeBarLayoutPx(
    barSeries.map((b) => b.s),
    xScale
  );

  const barWidthRange = layout.barWidthPx;
  const gap = layout.gapPx;
  const clusterWidth = layout.clusterWidthPx;
  if (!Number.isFinite(barWidthRange) || !(barWidthRange > 0)) return null;

  const clusterIndexByGlobalSeriesIndex = new Map<number, number>();
  for (let i = 0; i < barSeries.length; i++) {
    const globalSeriesIndex = barSeries[i].globalSeriesIndex;
    const clusterIndex = layout.clusterSlots.clusterIndexBySeries[i] ?? 0;
    clusterIndexByGlobalSeriesIndex.set(globalSeriesIndex, clusterIndex);
  }

  return {
    barWidth: barWidthRange,
    gap,
    clusterWidth,
    clusterIndexByGlobalSeriesIndex,
  };
};

const lowerBoundX = (data: CartesianSeriesData, xTarget: number): number => {
  let lo = 0;
  let hi = getPointCount(data);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = getX(data, mid);
    if (x < xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * Finds (at most) one nearest point per series at a given x position.
 *
 * Coordinate system contract (mirrors `findNearestPoint`):
 * - `xValue` and optional `tolerance` MUST be in the same units as `xScale` **range**.
 *   (Example: if your `xScale.range()` is in grid-local CSS pixels, pass `payload.gridX` from `createEventManager`.)
 *   Note: ChartGPU's internal renderer scales are currently in clip space (NDC, typically \[-1, 1\]); in that case
 *   convert your pointer x into clip space before calling this helper.
 *
 * Behavior:
 * - Assumes each series is sorted by increasing x in domain space.
 * - Uses a lower-bound binary search in domain-x, then expands outward while x-distance alone can still improve.
 * - Skips points with non-finite domain x or non-finite scaled x. If a series contains any NaN x values, this helper
 *   falls back to an O(n) scan for correctness (NaN breaks total ordering for binary search).
 * - Stable tie-breaking: for equal distance, chooses the smaller `dataIndex`.
 *
 * If `tolerance` is provided, it is interpreted in **xScale range units**. Matches beyond tolerance are omitted.
 * If `tolerance` is omitted (or non-finite), the nearest point per series is returned when possible.
 *
 * Bar series special-case:
 * - Bars occupy x-intervals \([left, right)\) in **xScale range units** (grid-local CSS px for interaction scales),
 *   using the same shared layout math as the bar renderer (grouping + stacking slots).
 * - If `tolerance` is finite, a bar match is only returned when `xValue` falls inside the bar interval expanded by
 *   `tolerance` on both sides: \([left - tolerance, right + tolerance)\).
 * - If `tolerance` is omitted / non-finite, we first attempt an exact interval hit (no expansion) and otherwise fall
 *   back to the existing nearest-x behavior (so axis-trigger tooltips still work away from bars).
 */
export function findPointsAtX(
  series: ReadonlyArray<ResolvedSeriesConfig>,
  xValue: number,
  xScale: LinearScale,
  tolerance?: number,
): ReadonlyArray<PointsAtXMatch> {
  if (!Number.isFinite(xValue)) return [];

  const maxDx =
    tolerance === undefined || !Number.isFinite(tolerance) ? Number.POSITIVE_INFINITY : Math.max(0, tolerance);
  const maxDxSq = maxDx * maxDx;

  const xTarget = xScale.invert(xValue);
  if (!Number.isFinite(xTarget)) return [];

  const matches: PointsAtXMatch[] = [];
  const barLayout = computeBarHitTestLayout(series, xScale);

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    // Pie and candlestick are non-cartesian (or not yet implemented); they can't match an x position.
    if (seriesConfig.type === 'pie' || seriesConfig.type === 'candlestick') continue;

    // Skip invisible series.
    if (seriesConfig.visible === false) continue;

    const data = seriesConfig.data as CartesianSeriesData;
    const n = getPointCount(data);
    if (n === 0) continue;

    // Bar series: return the correct bar dataIndex for xValue when inside the bar interval.
    // When tolerance is finite: require an (expanded) interval hit.
    // When tolerance is non-finite: attempt exact hit, otherwise fall back to nearest-x behavior below.
    if (seriesConfig.type === 'bar' && barLayout) {
      const clusterIndex = barLayout.clusterIndexByGlobalSeriesIndex.get(s);
      if (clusterIndex !== undefined) {
        const { barWidth, gap, clusterWidth } = barLayout;
        const offsetLeftFromCategoryCenter = -clusterWidth / 2 + clusterIndex * (barWidth + gap);

        const hitTol =
          tolerance === undefined || !Number.isFinite(tolerance) ? 0 : Math.max(0, tolerance);

        // If we can't safely compute an interval hit, don't guess when tolerance is finite.
        if (Number.isFinite(barWidth) && barWidth > 0 && Number.isFinite(offsetLeftFromCategoryCenter)) {
          let hitIndex = -1;

          const isHit = (xCenterRange: number): boolean => {
            if (!Number.isFinite(xCenterRange)) return false;
            const left = xCenterRange + offsetLeftFromCategoryCenter;
            const right = left + barWidth;
            // Expanded interval: [left - tol, right + tol)
            return xValue >= left - hitTol && xValue < right + hitTol;
          };

          if (seriesHasNaNX(data)) {
            // NaN breaks ordering; linear scan for correctness.
            for (let i = 0; i < n; i++) {
              const px = getX(data, i);
              if (!Number.isFinite(px)) continue;
              const xCenter = xScale.scale(px);
              if (isHit(xCenter)) {
                hitIndex = hitIndex < 0 ? i : Math.min(hitIndex, i);
              }
            }
          } else {
            // Use a lower-bound search around the adjusted x (accounts for cluster offset).
            const xTargetAdjusted = xScale.invert(xValue - offsetLeftFromCategoryCenter);
            if (Number.isFinite(xTargetAdjusted)) {
              const insertionIndex = lowerBoundX(data, xTargetAdjusted);

              const getXCenterAt = (idx: number): number | null => {
                if (idx < 0 || idx >= n) return null;
                const px = getX(data, idx);
                if (!Number.isFinite(px)) return null;
                const xCenter = xScale.scale(px);
                return Number.isFinite(xCenter) ? xCenter : null;
              };

              // Scan left while intervals could still contain xValue.
              for (let i = insertionIndex - 1; i >= 0; i--) {
                const xCenter = getXCenterAt(i);
                if (xCenter === null) continue;
                const left = xCenter + offsetLeftFromCategoryCenter;
                const right = left + barWidth;
                if (right + hitTol <= xValue) break;
                if (xValue >= left - hitTol && xValue < right + hitTol) {
                  hitIndex = hitIndex < 0 ? i : Math.min(hitIndex, i);
                }
              }

              // Scan right until intervals start strictly after xValue.
              for (let i = insertionIndex; i < n; i++) {
                const xCenter = getXCenterAt(i);
                if (xCenter === null) continue;
                const left = xCenter + offsetLeftFromCategoryCenter;
                if (left - hitTol > xValue) break;
                const right = left + barWidth;
                if (xValue < right + hitTol) {
                  hitIndex = hitIndex < 0 ? i : Math.min(hitIndex, i);
                }
              }
            }
          }

          if (hitIndex >= 0) {
            const x = getX(data, hitIndex);
            const y = getY(data, hitIndex);
            const size = getSize(data, hitIndex);
            const point: DataPoint = size !== undefined ? [x, y, size] : [x, y];
            matches.push({ seriesIndex: s, dataIndex: hitIndex, point });
            continue;
          }

          // If tolerance is finite, require a hit (no nearest-x fallback).
          if (tolerance !== undefined && Number.isFinite(tolerance)) {
            continue;
          }
          // Else: fall through to nearest-x behavior (existing logic) for axis-trigger tooltips.
        } else if (tolerance !== undefined && Number.isFinite(tolerance)) {
          continue;
        }
      }
    }

    let bestDataIndex = -1;
    let bestPoint: DataPoint | null = null;
    let bestDxSq = maxDxSq;

    const tryUpdate = (idx: number, dxSq: number) => {
      if (!Number.isFinite(dxSq)) return;
      const isBetter =
        dxSq < bestDxSq || (dxSq === bestDxSq && (bestDataIndex < 0 || idx < bestDataIndex));
      if (!isBetter) return;
      bestDxSq = dxSq;
      bestDataIndex = idx;
      // Construct DataPoint for return
      const x = getX(data, idx);
      const y = getY(data, idx);
      const size = getSize(data, idx);
      bestPoint = size !== undefined ? [x, y, size] : [x, y];
    };

    // If the series contains NaN x values, binary search cannot be trusted (NaN breaks ordering).
    // Fall back to a linear scan for correctness. Cached per data array for performance.
    if (seriesHasNaNX(data)) {
      for (let i = 0; i < n; i++) {
        const px = getX(data, i);
        if (!Number.isFinite(px)) continue;
        const sx = xScale.scale(px);
        if (!Number.isFinite(sx)) continue;
        const dx = sx - xValue;
        tryUpdate(i, dx * dx);
      }
    } else {
      const insertionIndex = lowerBoundX(data, xTarget);

      let left = insertionIndex - 1;
      let right = insertionIndex;

      const dxSqAt = (idx: number): number | null => {
        const px = getX(data, idx);
        if (!Number.isFinite(px)) return null;
        const sx = xScale.scale(px);
        if (!Number.isFinite(sx)) return null;
        const dx = sx - xValue;
        return dx * dx;
      };

      while (left >= 0 || right < n) {
        while (left >= 0 && dxSqAt(left) === null) left--;
        while (right < n && dxSqAt(right) === null) right++;
        if (left < 0 && right >= n) break;

        const dxSqLeft = left >= 0 ? (dxSqAt(left) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        const dxSqRight = right < n ? (dxSqAt(right) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;

        if (dxSqLeft > bestDxSq && dxSqRight > bestDxSq) break;

        // If both sides are equally close in x, evaluate left first (smaller index) for stable ties.
        if (dxSqLeft <= dxSqRight) {
          if (left >= 0 && dxSqLeft <= bestDxSq) tryUpdate(left, dxSqLeft);
          left--;
          if (right < n && dxSqRight <= bestDxSq && dxSqRight === dxSqLeft) {
            tryUpdate(right, dxSqRight);
            right++;
          }
        } else {
          if (right < n && dxSqRight <= bestDxSq) tryUpdate(right, dxSqRight);
          right++;
        }
      }
    }

    if (bestPoint !== null) matches.push({ seriesIndex: s, dataIndex: bestDataIndex, point: bestPoint });
  }

  return matches;
}

