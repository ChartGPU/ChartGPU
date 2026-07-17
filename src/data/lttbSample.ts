import type { CartesianSeriesData, DataPoint, DataPointTuple } from '../config/types';
import { getPointCount, getSize, getX, getY } from './cartesianData';

function isTupleDataPoint(point: DataPoint): point is DataPointTuple {
  // `DataPoint` uses a readonly tuple; `Array.isArray` doesn't narrow it well without a predicate.
  return Array.isArray(point);
}

/**
 * LTTB index selection over cartesian data using Float64 domain x via {@link getX}.
 * Avoids packing absolute epoch-ms into Float32 before index choice (which collapses
 * second-spaced timestamps at modern epoch scale).
 */
export function lttbIndicesForCartesian(data: CartesianSeriesData, targetPoints: number): Int32Array {
  const n = getPointCount(data);
  const lastIndex = n - 1;

  if (targetPoints <= 0 || n === 0) return new Int32Array(0);
  if (targetPoints === 1) return new Int32Array([0]);
  if (targetPoints === 2) return n >= 2 ? new Int32Array([0, lastIndex]) : new Int32Array([0]);
  if (n <= targetPoints) {
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    return indices;
  }

  const indices = new Int32Array(targetPoints);
  indices[0] = 0;
  indices[targetPoints - 1] = lastIndex;

  const bucketSize = (n - 2) / (targetPoints - 2);

  let a = 0;
  let out = 1;

  const lastX = getX(data, lastIndex);
  const lastY = getY(data, lastIndex);

  for (let bucket = 0; bucket < targetPoints - 2; bucket++) {
    let rangeStart = Math.floor(bucketSize * bucket) + 1;
    let rangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 1)) + 1, lastIndex);
    if (rangeStart >= rangeEndExclusive) {
      rangeStart = Math.min(rangeStart, lastIndex - 1);
      rangeEndExclusive = Math.min(rangeStart + 1, lastIndex);
    }

    const nextRangeStart = Math.floor(bucketSize * (bucket + 1)) + 1;
    const nextRangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 2)) + 1, lastIndex);

    let avgX = lastX;
    let avgY = lastY;
    if (nextRangeStart < nextRangeEndExclusive) {
      let sumX = 0;
      let sumY = 0;
      let avgCount = 0;
      for (let i = nextRangeStart; i < nextRangeEndExclusive; i++) {
        sumX += getX(data, i);
        sumY += getY(data, i);
        avgCount++;
      }
      if (avgCount > 0) {
        avgX = sumX / avgCount;
        avgY = sumY / avgCount;
      }
    }

    const ax = getX(data, a);
    const ay = getY(data, a);

    let maxArea = -1;
    let maxIndex = rangeStart;
    for (let i = rangeStart; i < rangeEndExclusive; i++) {
      const bx = getX(data, i);
      const by = getY(data, i);
      const area2 = (ax - avgX) * (by - ay) - (ax - bx) * (avgY - ay);
      const absArea2 = area2 < 0 ? -area2 : area2;
      if (absArea2 > maxArea) {
        maxArea = absArea2;
        maxIndex = i;
      }
    }

    indices[out++] = maxIndex;
    a = maxIndex;
  }

  return indices;
}

/**
 * Sample cartesian series via Float64-domain LTTB indices, returning DataPoint tuples
 * with original domain x (and optional size).
 */
export function lttbSampleCartesian(data: CartesianSeriesData, targetPoints: number): DataPoint[] {
  const n = getPointCount(data);
  const threshold = Math.floor(targetPoints);
  if (threshold <= 0 || n === 0) return [];
  if (n <= threshold) {
    const out: DataPoint[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const size = getSize(data, i);
      out[i] = size !== undefined ? [getX(data, i), getY(data, i), size] : [getX(data, i), getY(data, i)];
    }
    return out;
  }
  const indices = lttbIndicesForCartesian(data, threshold);
  const out: DataPoint[] = new Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]!;
    const size = getSize(data, idx);
    out[i] = size !== undefined ? [getX(data, idx), getY(data, idx), size] : [getX(data, idx), getY(data, idx)];
  }
  return out;
}

function lttbIndicesForInterleavedXY(data: Float32Array, targetPoints: number): Int32Array {
  const n = data.length >>> 1; // floor(length / 2)
  const lastIndex = n - 1;

  if (targetPoints <= 0 || n === 0) return new Int32Array(0);
  if (targetPoints === 1) return new Int32Array([0]);
  if (targetPoints === 2) return n >= 2 ? new Int32Array([0, lastIndex]) : new Int32Array([0]);
  if (n <= targetPoints) {
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    return indices;
  }

  const indices = new Int32Array(targetPoints);
  indices[0] = 0;
  indices[targetPoints - 1] = lastIndex;

  const bucketSize = (n - 2) / (targetPoints - 2);

  let a = 0;
  let out = 1;

  const lastX = data[lastIndex * 2 + 0];
  const lastY = data[lastIndex * 2 + 1];

  for (let bucket = 0; bucket < targetPoints - 2; bucket++) {
    // Current bucket: candidate points are [rangeStart, rangeEndExclusive) and never include lastIndex.
    let rangeStart = Math.floor(bucketSize * bucket) + 1;
    let rangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 1)) + 1, lastIndex);
    if (rangeStart >= rangeEndExclusive) {
      // Defensive: ensure at least one candidate point.
      rangeStart = Math.min(rangeStart, lastIndex - 1);
      rangeEndExclusive = Math.min(rangeStart + 1, lastIndex);
    }

    // Next bucket for average: [nextRangeStart, nextRangeEndExclusive)
    const nextRangeStart = Math.floor(bucketSize * (bucket + 1)) + 1;
    const nextRangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 2)) + 1, lastIndex);

    // If there are no points in the next bucket, use the last point as the average.
    let avgX = lastX;
    let avgY = lastY;
    if (nextRangeStart < nextRangeEndExclusive) {
      let sumX = 0;
      let sumY = 0;
      let avgCount = 0;
      for (let i = nextRangeStart; i < nextRangeEndExclusive; i++) {
        sumX += data[i * 2 + 0];
        sumY += data[i * 2 + 1];
        avgCount++;
      }
      if (avgCount > 0) {
        avgX = sumX / avgCount;
        avgY = sumY / avgCount;
      }
    }

    const ax = data[a * 2 + 0];
    const ay = data[a * 2 + 1];

    let maxArea = -1;
    let maxIndex = rangeStart;
    for (let i = rangeStart; i < rangeEndExclusive; i++) {
      const bx = data[i * 2 + 0];
      const by = data[i * 2 + 1];
      const area2 = (ax - avgX) * (by - ay) - (ax - bx) * (avgY - ay);
      const absArea2 = area2 < 0 ? -area2 : area2;
      if (absArea2 > maxArea) {
        maxArea = absArea2;
        maxIndex = i;
      }
    }

    indices[out++] = maxIndex;
    a = maxIndex;
  }

  return indices;
}

function lttbIndicesForDataPoints(data: ReadonlyArray<DataPoint>, targetPoints: number): Int32Array {
  const n = data.length;
  const lastIndex = n - 1;

  if (targetPoints <= 0 || n === 0) return new Int32Array(0);
  if (targetPoints === 1) return new Int32Array([0]);
  if (targetPoints === 2) return n >= 2 ? new Int32Array([0, lastIndex]) : new Int32Array([0]);
  if (n <= targetPoints) {
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    return indices;
  }

  const indices = new Int32Array(targetPoints);
  indices[0] = 0;
  indices[targetPoints - 1] = lastIndex;

  const bucketSize = (n - 2) / (targetPoints - 2);

  let a = 0;
  let out = 1;

  const pLast = data[lastIndex]!;
  const lastX = isTupleDataPoint(pLast) ? pLast[0] : pLast.x;
  const lastY = isTupleDataPoint(pLast) ? pLast[1] : pLast.y;

  for (let bucket = 0; bucket < targetPoints - 2; bucket++) {
    // Current bucket: candidate points are [rangeStart, rangeEndExclusive) and never include lastIndex.
    let rangeStart = Math.floor(bucketSize * bucket) + 1;
    let rangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 1)) + 1, lastIndex);
    if (rangeStart >= rangeEndExclusive) {
      // Defensive: ensure at least one candidate point.
      rangeStart = Math.min(rangeStart, lastIndex - 1);
      rangeEndExclusive = Math.min(rangeStart + 1, lastIndex);
    }

    // Next bucket for average: [nextRangeStart, nextRangeEndExclusive)
    const nextRangeStart = Math.floor(bucketSize * (bucket + 1)) + 1;
    const nextRangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 2)) + 1, lastIndex);

    // If there are no points in the next bucket, use the last point as the average.
    let avgX = lastX;
    let avgY = lastY;
    if (nextRangeStart < nextRangeEndExclusive) {
      let sumX = 0;
      let sumY = 0;
      let avgCount = 0;
      for (let i = nextRangeStart; i < nextRangeEndExclusive; i++) {
        const p = data[i]!;
        const x = isTupleDataPoint(p) ? p[0] : p.x;
        const y = isTupleDataPoint(p) ? p[1] : p.y;
        sumX += x;
        sumY += y;
        avgCount++;
      }
      if (avgCount > 0) {
        avgX = sumX / avgCount;
        avgY = sumY / avgCount;
      }
    }

    const pa = data[a]!;
    const ax = isTupleDataPoint(pa) ? pa[0] : pa.x;
    const ay = isTupleDataPoint(pa) ? pa[1] : pa.y;

    let maxArea = -1;
    let maxIndex = rangeStart;
    for (let i = rangeStart; i < rangeEndExclusive; i++) {
      const pb = data[i]!;
      const bx = isTupleDataPoint(pb) ? pb[0] : pb.x;
      const by = isTupleDataPoint(pb) ? pb[1] : pb.y;
      const area2 = (ax - avgX) * (by - ay) - (ax - bx) * (avgY - ay);
      const absArea2 = area2 < 0 ? -area2 : area2;
      if (absArea2 > maxArea) {
        maxArea = absArea2;
        maxIndex = i;
      }
    }

    indices[out++] = maxIndex;
    a = maxIndex;
  }

  return indices;
}

export function lttbSample(data: Float32Array, targetPoints: number): Float32Array;
export function lttbSample(data: DataPoint[], targetPoints: number): DataPoint[];
export function lttbSample(data: ReadonlyArray<DataPoint>, targetPoints: number): ReadonlyArray<DataPoint>;
export function lttbSample(
  data: ReadonlyArray<DataPoint> | Float32Array,
  targetPoints: number
): ReadonlyArray<DataPoint> | Float32Array {
  const threshold = Math.floor(targetPoints);

  if (data instanceof Float32Array) {
    const n = data.length >>> 1;
    if (threshold <= 0 || n === 0) return new Float32Array(0);

    // If we're already under the target, avoid copying.
    if (n <= threshold) return data;

    const indices = lttbIndicesForInterleavedXY(data, threshold);
    const out = new Float32Array(indices.length * 2);
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]!;
      out[i * 2 + 0] = data[idx * 2 + 0];
      out[i * 2 + 1] = data[idx * 2 + 1];
    }
    return out;
  }

  const n = data.length;
  if (threshold <= 0 || n === 0) return [];

  // Story requirement: when data is shorter than the target, return original.
  if (n <= threshold) return data;

  const indices = lttbIndicesForDataPoints(data, threshold);
  const out = new Array<DataPoint>(indices.length);
  for (let i = 0; i < indices.length; i++) {
    out[i] = data[indices[i]!]!;
  }
  return out;
}
