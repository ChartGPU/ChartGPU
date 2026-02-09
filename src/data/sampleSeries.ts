import type { CartesianSeriesData, DataPointTuple, SeriesSampling } from '../config/types';
import { lttbSample } from './lttbSample';
import { getPointCount, getX, getY, getSize as getPointSize } from './cartesianData';


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
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    ArrayBuffer.isView(data)
  );
}

/**
 * Packs CartesianSeriesData into a Float32Array for LTTB sampling.
 * Returns the packed Float32Array.
 */
function packToFloat32Array(data: CartesianSeriesData): Float32Array {
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
 *   - Float32Array interleaved → returns sampled Float32Array
 *   - Other interleaved typed array → packs to Float32Array, returns sampled Float32Array
 *   - DataPoint[] → returns sampled DataPoint[]
 *   - XYArraysData → packs to Float32Array, returns sampled Float32Array
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
      // Float32Array fast path
      if (data instanceof Float32Array) {
        return lttbSample(data, threshold);
      }
      
      // Other interleaved typed arrays: pack to Float32Array and sample
      if (isInterleavedXYData(data)) {
        const packed = packToFloat32Array(data);
        return lttbSample(packed, threshold);
      }
      
      // XYArraysData: pack to Float32Array and sample
      if (isXYArraysData(data)) {
        const packed = packToFloat32Array(data);
        return lttbSample(packed, threshold);
      }
      
      // DataPoint[] path (existing behavior)
      return lttbSample(data, threshold);
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

