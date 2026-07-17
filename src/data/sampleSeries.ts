import type { CartesianSeriesData, DataPoint, DataPointTuple, SeriesSampling } from '../config/types';
import { lttbSample, lttbSampleCartesian } from './lttbSample';
import { getPointCount, getX, getY, getSize as getPointSize, hasNullGaps } from './cartesianData';

function clampTargetPoints(targetPoints: number): number {
  const t = Math.floor(targetPoints);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Type guard for XYArraysData format.
 */
function isXYArraysData(data: CartesianSeriesData): data is import('../config/types').XYArraysData {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    'x' in data &&
    'y' in data &&
    typeof (data as any).x === 'object' &&
    typeof (data as any).y === 'object' &&
    'length' in (data as any).x &&
    'length' in (data as any).y
  );
}

/**
 * Type guard for InterleavedXYData format (ArrayBufferView).
 */
function isInterleavedXYData(data: CartesianSeriesData): data is import('../config/types').InterleavedXYData {
  return typeof data === 'object' && data !== null && !Array.isArray(data) && ArrayBuffer.isView(data);
}

/**
 * Packs CartesianSeriesData into a Float32Array (absolute domain x).
 * **Not used for LTTB index selection on time axes** — Float32 ULP at epoch-ms
 * (~1e12) is ~1.3e5 ms and collapses second-spaced points before LTTB runs.
 * Kept for tests / callers that intentionally want absolute Float32 pack.
 * @internal
 */
export function packToFloat32ArrayAbsolute(data: CartesianSeriesData): Float32Array {
  // Dense DataPoint[] (tuple or object): avoid per-point getX/getY dispatch.
  if (Array.isArray(data)) {
    const count = data.length;
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const p = data[i] as DataPoint | null | undefined;
      if (p == null || typeof p !== 'object') {
        out[i * 2] = Number.NaN;
        out[i * 2 + 1] = Number.NaN;
        continue;
      }
      if (Array.isArray(p)) {
        out[i * 2] = p[0] as number;
        out[i * 2 + 1] = p[1] as number;
      } else {
        out[i * 2] = (p as { x: number }).x;
        out[i * 2 + 1] = (p as { y: number }).y;
      }
    }
    return out;
  }

  const count = getPointCount(data);
  const out = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    out[i * 2] = getX(data, i);
    out[i * 2 + 1] = getY(data, i);
  }

  return out;
}

type BucketMode = 'average' | 'max' | 'min';

/**
 * Samples CartesianSeriesData using bucket-based strategies (average, max, min).
 * Always returns DataPointTuple[] for newly allocated data.
 * Preserves size semantics when available.
 */
function sampleByBucketsFromCartesian(
  data: CartesianSeriesData,
  targetPoints: number,
  mode: BucketMode
): DataPointTuple[] {
  const n = getPointCount(data);
  const threshold = clampTargetPoints(targetPoints);

  if (threshold <= 0 || n === 0) return [];
  if (threshold === 1) {
    const x = getX(data, 0);
    const y = getY(data, 0);
    const size = getPointSize(data, 0);
    return size !== undefined ? [[x, y, size]] : [[x, y]];
  }
  if (threshold === 2) {
    if (n >= 2) {
      const x0 = getX(data, 0);
      const y0 = getY(data, 0);
      const size0 = getPointSize(data, 0);
      const xLast = getX(data, n - 1);
      const yLast = getY(data, n - 1);
      const sizeLast = getPointSize(data, n - 1);
      return [
        size0 !== undefined ? [x0, y0, size0] : [x0, y0],
        sizeLast !== undefined ? [xLast, yLast, sizeLast] : [xLast, yLast],
      ];
    } else {
      const x = getX(data, 0);
      const y = getY(data, 0);
      const size = getPointSize(data, 0);
      return size !== undefined ? [[x, y, size]] : [[x, y]];
    }
  }

  const lastIndex = n - 1;
  const out: DataPointTuple[] = new Array(threshold);

  // First and last points
  {
    const x0 = getX(data, 0);
    const y0 = getY(data, 0);
    const size0 = getPointSize(data, 0);
    out[0] = size0 !== undefined ? [x0, y0, size0] : [x0, y0];

    const xLast = getX(data, lastIndex);
    const yLast = getY(data, lastIndex);
    const sizeLast = getPointSize(data, lastIndex);
    out[threshold - 1] = sizeLast !== undefined ? [xLast, yLast, sizeLast] : [xLast, yLast];
  }

  const bucketSize = (n - 2) / (threshold - 2);

  for (let bucket = 0; bucket < threshold - 2; bucket++) {
    let rangeStart = Math.floor(bucketSize * bucket) + 1;
    let rangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 1)) + 1, lastIndex);

    if (rangeStart >= rangeEndExclusive) {
      rangeStart = Math.min(rangeStart, lastIndex - 1);
      rangeEndExclusive = Math.min(rangeStart + 1, lastIndex);
    }

    let chosen: DataPointTuple | null = null;

    if (mode === 'average') {
      let sumX = 0;
      let sumY = 0;
      let sumSize = 0;
      let count = 0;
      let sizeCount = 0;
      for (let i = rangeStart; i < rangeEndExclusive; i++) {
        const x = getX(data, i);
        const y = getY(data, i);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        sumX += x;
        sumY += y;
        count++;

        const size = getPointSize(data, i);
        if (typeof size === 'number' && Number.isFinite(size)) {
          sumSize += size;
          sizeCount++;
        }
      }

      if (count > 0) {
        const avgX = sumX / count;
        const avgY = sumY / count;
        if (sizeCount > 0) {
          chosen = [avgX, avgY, sumSize / sizeCount];
        } else {
          chosen = [avgX, avgY];
        }
      }
    } else {
      let bestY = mode === 'max' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      let bestIndex = rangeStart;
      for (let i = rangeStart; i < rangeEndExclusive; i++) {
        const y = getY(data, i);
        if (!Number.isFinite(y)) continue;
        if (mode === 'max') {
          if (y > bestY) {
            bestY = y;
            bestIndex = i;
          }
        } else {
          if (y < bestY) {
            bestY = y;
            bestIndex = i;
          }
        }
      }
      // Return the best point found
      const x = getX(data, bestIndex);
      const y = getY(data, bestIndex);
      const size = getPointSize(data, bestIndex);
      chosen = size !== undefined ? [x, y, size] : [x, y];
    }

    if (chosen === null) {
      // Fallback to first point in range
      const x = getX(data, rangeStart);
      const y = getY(data, rangeStart);
      const size = getPointSize(data, rangeStart);
      chosen = size !== undefined ? [x, y, size] : [x, y];
    }

    out[bucket + 1] = chosen;
  }

  return out;
}

/**
 * Samples CartesianSeriesData using the specified sampling strategy.
 *
 * Returns the ORIGINAL data reference when:
 * - `sampling === 'none'`
 * - `samplingThreshold` is invalid/non-positive
 * - Point count <= threshold
 *
 * When sampling occurs:
 * - For `lttb`:
 *   - Float32Array interleaved → sampled Float32Array (domain x already Float32)
 *   - Float64 interleaved / other typed arrays / XYArraysData / DataPoint[] →
 *     Float64-domain LTTB (`lttbSampleCartesian`); returns `DataPoint[]` with
 *     original domain x (epoch-ms safe). Null gaps are filtered first, then the
 *     same Float64 path runs on the non-null points.
 * - For `average`/`max`/`min`:
 *   - Returns DataPointTuple[] for all input formats
 */
export function sampleSeriesDataPoints(
  data: CartesianSeriesData,
  sampling: SeriesSampling,
  samplingThreshold: number
): CartesianSeriesData {
  const threshold = clampTargetPoints(samplingThreshold);
  const pointCount = getPointCount(data);

  // Disabled or already under threshold: keep original reference (avoid extra allocations).
  if (sampling === 'none') return data;
  if (!(threshold > 0)) return data;
  if (pointCount <= threshold) return data;

  switch (sampling) {
    case 'lttb': {
      // Float32Array: already Float32 domain x — LTTB on interleaved floats.
      // Callers that need epoch-ms precision must use Float64 domain formats
      // (DataPoint[] / XY arrays / Float64 interleaved) so index selection stays
      // in Float64 via lttbSampleCartesian.
      if (data instanceof Float32Array) {
        return lttbSample(data, threshold);
      }

      // Float64 interleaved: keep domain x in Float64 for index selection.
      if (data instanceof Float64Array) {
        return lttbSampleCartesian(data as unknown as CartesianSeriesData, threshold);
      }

      // Other interleaved typed arrays (Int32, etc.): use Float64 getX path.
      if (isInterleavedXYData(data)) {
        return lttbSampleCartesian(data, threshold);
      }

      // XYArraysData: Float64 getX path (preserves epoch-ms + optional size).
      if (isXYArraysData(data)) {
        return lttbSampleCartesian(data, threshold);
      }

      // DataPoint[] path — filter nulls before LTTB sampling.
      // Nulls represent line-segmentation gaps and will be handled by gap detection
      // in later pipeline stages; LTTB only operates on concrete data points.
      // Always use Float64-domain LTTB (not absolute Float32 pack) so time axes
      // keep distinct second-spaced timestamps through sampling — including the
      // null-gap branch (filtered non-nulls still go through lttbSampleCartesian).
      const asPoints = data as ReadonlyArray<DataPoint | null>;
      if (hasNullGaps(data)) {
        const nonNullData = asPoints.filter((p): p is DataPoint => p !== null);
        return lttbSampleCartesian(nonNullData as unknown as CartesianSeriesData, threshold);
      }
      return lttbSampleCartesian(asPoints as unknown as CartesianSeriesData, threshold);
    }

    case 'average':
      return sampleByBucketsFromCartesian(data, threshold, 'average');

    case 'max':
      return sampleByBucketsFromCartesian(data, threshold, 'max');

    case 'min':
      return sampleByBucketsFromCartesian(data, threshold, 'min');

    default: {
      // Defensive for JS callers / widened types.
      return data;
    }
  }
}
