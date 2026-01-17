import type { DataPoint } from '../config/types';
import type { ResolvedSeriesConfig } from '../config/OptionResolver';
import type { LinearScale } from '../utils/scales';

export type PointsAtXMatch = Readonly<{
  seriesIndex: number;
  dataIndex: number;
  point: DataPoint;
}>;

type TuplePoint = readonly [x: number, y: number];
type ObjectPoint = Readonly<{ x: number; y: number }>;

const hasNaNXCache = new WeakMap<ReadonlyArray<unknown>, boolean>();

const seriesHasNaNX = (data: ReadonlyArray<DataPoint>, isTuple: boolean): boolean => {
  if (hasNaNXCache.has(data)) return hasNaNXCache.get(data)!;

  let hasNaN = false;

  if (isTuple) {
    const tupleData = data as ReadonlyArray<TuplePoint>;
    for (let i = 0; i < tupleData.length; i++) {
      const x = tupleData[i][0];
      if (Number.isNaN(x)) {
        hasNaN = true;
        break;
      }
    }
  } else {
    const objectData = data as ReadonlyArray<ObjectPoint>;
    for (let i = 0; i < objectData.length; i++) {
      const x = objectData[i].x;
      if (Number.isNaN(x)) {
        hasNaN = true;
        break;
      }
    }
  }

  hasNaNXCache.set(data, hasNaN);
  return hasNaN;
};

const lowerBoundTuple = (data: ReadonlyArray<TuplePoint>, xTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = data[mid][0];
    if (x < xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const lowerBoundObject = (data: ReadonlyArray<ObjectPoint>, xTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = data[mid].x;
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

  for (let s = 0; s < series.length; s++) {
    const data = series[s]?.data;
    const n = data.length;
    if (n === 0) continue;

    const first = data[0];
    const isTuple = Array.isArray(first);

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
      bestPoint = data[idx] as DataPoint;
    };

    // If the series contains NaN x values, binary search cannot be trusted (NaN breaks ordering).
    // Fall back to a linear scan for correctness. Cached per data array for performance.
    if (seriesHasNaNX(data, isTuple)) {
      if (isTuple) {
        const tupleData = data as ReadonlyArray<TuplePoint>;
        for (let i = 0; i < n; i++) {
          const px = tupleData[i][0];
          if (!Number.isFinite(px)) continue;
          const sx = xScale.scale(px);
          if (!Number.isFinite(sx)) continue;
          const dx = sx - xValue;
          tryUpdate(i, dx * dx);
        }
      } else {
        const objectData = data as ReadonlyArray<ObjectPoint>;
        for (let i = 0; i < n; i++) {
          const px = objectData[i].x;
          if (!Number.isFinite(px)) continue;
          const sx = xScale.scale(px);
          if (!Number.isFinite(sx)) continue;
          const dx = sx - xValue;
          tryUpdate(i, dx * dx);
        }
      }
    } else if (isTuple) {
      const tupleData = data as ReadonlyArray<TuplePoint>;
      const insertionIndex = lowerBoundTuple(tupleData, xTarget);

      let left = insertionIndex - 1;
      let right = insertionIndex;

      const dxSqAt = (idx: number): number | null => {
        const px = tupleData[idx][0];
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
    } else {
      const objectData = data as ReadonlyArray<ObjectPoint>;
      const insertionIndex = lowerBoundObject(objectData, xTarget);

      let left = insertionIndex - 1;
      let right = insertionIndex;

      const dxSqAt = (idx: number): number | null => {
        const px = objectData[idx].x;
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

