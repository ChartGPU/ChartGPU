/**
 * Visible Slice Computation Utilities
 *
 * Provides efficient data slicing for zoom operations using binary search
 * when data is monotonic, with fallback to linear filtering.
 *
 * Key features:
 * - Binary search slicing for O(log n) performance on sorted data
 * - WeakMap caching of monotonicity checks to avoid O(n) scans
 * - Separate implementations for cartesian (x-based) and OHLC (timestamp-based) data
 * - Support for DataPoint[], XYArraysData, and InterleavedXYData formats
 */

import type {
  CartesianSeriesData,
  DataPoint,
  OHLCDataPoint,
  OHLCDataPointTuple,
  OHLCDataPointObject,
  XYArraysData,
  InterleavedXYData,
} from '../../../config/types';
import { getPointCount, getX, getY } from '../../../data/cartesianData';
import { clampInt } from '../utils/canvasUtils';

// Type guards for OHLC data
export function isTupleOHLCDataPoint(p: OHLCDataPoint): p is OHLCDataPointTuple {
  return Array.isArray(p);
}

// Cache monotonicity checks to avoid O(n) scans on every zoom operation
// WeakMap works for arrays, typed arrays, and object references (XYArraysData)
const monotonicXCache = new WeakMap<object, boolean>();
const monotonicTimestampCache = new WeakMap<ReadonlyArray<OHLCDataPoint>, boolean>();

/**
 * Checks if cartesian data is monotonic non-decreasing by X coordinate with all finite values.
 * Results are cached in a WeakMap to avoid repeated O(n) scans.
 * 
 * Supports all CartesianSeriesData formats: DataPoint[], XYArraysData, InterleavedXYData.
 */
export function isMonotonicNonDecreasingFiniteX(data: CartesianSeriesData): boolean {
  // For primitive arrays and typed arrays, we can cache by object reference
  // For XYArraysData, we cache by the object itself
  const cacheKey = typeof data === 'object' && data !== null ? data : null;
  if (cacheKey) {
    const cached = monotonicXCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  let prevX = Number.NEGATIVE_INFINITY;
  const n = getPointCount(data);

  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    if (!Number.isFinite(x)) {
      if (cacheKey) monotonicXCache.set(cacheKey, false);
      return false;
    }
    if (x < prevX) {
      if (cacheKey) monotonicXCache.set(cacheKey, false);
      return false;
    }
    prevX = x;
  }

  if (cacheKey) monotonicXCache.set(cacheKey, true);
  return true;
}

/**
 * Checks if OHLC data is monotonic non-decreasing by timestamp with all finite values.
 * Results are cached in a WeakMap to avoid repeated O(n) scans.
 */
export function isMonotonicNonDecreasingFiniteTimestamp(data: ReadonlyArray<OHLCDataPoint>): boolean {
  const cached = monotonicTimestampCache.get(data);
  if (cached !== undefined) return cached;

  let prevTimestamp = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < data.length; i++) {
    const p = data[i]!;
    const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
    if (!Number.isFinite(timestamp)) {
      monotonicTimestampCache.set(data, false);
      return false;
    }
    if (timestamp < prevTimestamp) {
      monotonicTimestampCache.set(data, false);
      return false;
    }
    prevTimestamp = timestamp;
  }
  monotonicTimestampCache.set(data, true);
  return true;
}

// Binary search: lower bound (first element >= target) for CartesianSeriesData
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

// Binary search: upper bound (first element > target) for CartesianSeriesData
function upperBoundX(data: CartesianSeriesData, xTarget: number): number {
  let lo = 0;
  let hi = getPointCount(data);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = getX(data, mid);
    if (x <= xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundTimestampTuple(data: ReadonlyArray<OHLCDataPointTuple>, timestampTarget: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid][0];
    if (timestamp < timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundTimestampTuple(data: ReadonlyArray<OHLCDataPointTuple>, timestampTarget: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid][0];
    if (timestamp <= timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundTimestampObject(data: ReadonlyArray<OHLCDataPointObject>, timestampTarget: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid].timestamp;
    if (timestamp < timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundTimestampObject(data: ReadonlyArray<OHLCDataPointObject>, timestampTarget: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid].timestamp;
    if (timestamp <= timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Helper: Check if data is XYArraysData format.
 */
function isXYArraysData(data: CartesianSeriesData): data is XYArraysData {
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
 * Helper: Check if data is InterleavedXYData format (ArrayBufferView).
 */
function isInterleavedXYData(data: CartesianSeriesData): data is InterleavedXYData {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    ArrayBuffer.isView(data)
  );
}

/**
 * Helper: Slice CartesianSeriesData to index range [start, end).
 * Returns appropriate view/slice for each format.
 */
function sliceCartesianData(
  data: CartesianSeriesData,
  start: number,
  end: number
): CartesianSeriesData {
  // Clamp indices
  const n = getPointCount(data);
  const s = Math.max(0, Math.min(start, n));
  const e = Math.max(s, Math.min(end, n));

  if (s === 0 && e === n) return data;
  if (e <= s) {
    // Return empty data in appropriate format
    if (isXYArraysData(data)) {
      return { x: [], y: [], ...(data.size ? { size: [] } : {}) };
    }
    if (isInterleavedXYData(data)) {
      // Return empty view of same type
      if (data instanceof DataView) {
        throw new Error('DataView is not supported for InterleavedXYData');
      }
      const TypedArrayConstructor = (data as any).constructor;
      return new TypedArrayConstructor(0);
    }
    return [];
  }

  // XYArraysData: slice x, y, and optional size arrays
  if (isXYArraysData(data)) {
    const xSliced = Array.isArray(data.x)
      ? data.x.slice(s, e)
      : 'subarray' in data.x
      ? (data.x as any).subarray(s, e)
      : Array.from(data.x).slice(s, e);

    const ySliced = Array.isArray(data.y)
      ? data.y.slice(s, e)
      : 'subarray' in data.y
      ? (data.y as any).subarray(s, e)
      : Array.from(data.y).slice(s, e);

    const result: XYArraysData = { x: xSliced, y: ySliced };

    if (data.size) {
      const sizeSliced = Array.isArray(data.size)
        ? data.size.slice(s, e)
        : 'subarray' in data.size
        ? (data.size as any).subarray(s, e)
        : Array.from(data.size).slice(s, e);
      (result as any).size = sizeSliced;
    }

    return result;
  }

  // InterleavedXYData: return subarray view (start*2, end*2)
  if (isInterleavedXYData(data)) {
    if (data instanceof DataView) {
      throw new Error('DataView is not supported for InterleavedXYData');
    }
    return (data as any).subarray(s * 2, e * 2);
  }

  // ReadonlyArray<DataPoint>: standard slice
  return (data as ReadonlyArray<DataPoint>).slice(s, e);
}

/**
 * Slices cartesian data to the visible X range [xMin, xMax].
 *
 * Uses binary search (O(log n)) when data is monotonic by X;
 * otherwise falls back to linear filtering (O(n)).
 *
 * @param data - Cartesian data in any supported format
 * @param xMin - Minimum X value (inclusive)
 * @param xMax - Maximum X value (inclusive)
 * @returns Sliced data in the same format as input
 */
export function sliceVisibleRangeByX(
  data: CartesianSeriesData,
  xMin: number,
  xMax: number
): CartesianSeriesData {
  const n = getPointCount(data);
  if (n === 0) return data;
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return data;

  const canBinarySearch = isMonotonicNonDecreasingFiniteX(data);

  if (canBinarySearch) {
    const lo = lowerBoundX(data, xMin);
    const hi = upperBoundX(data, xMax);

    if (lo <= 0 && hi >= n) return data;
    return sliceCartesianData(data, lo, hi);
  }

  // Safe fallback: linear filter (preserves order, ignores non-finite x)
  // For non-monotonic data, we must return a filtered array
  const out: DataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    if (!Number.isFinite(x)) continue;
    if (x >= xMin && x <= xMax) {
      const y = getY(data, i);
      out.push([x, y]);
    }
  }
  return out;
}

/**
 * Finds the index range of visible points in cartesian data.
 *
 * Returns { start, end } indices suitable for slicing or iteration.
 * Only works correctly when data is monotonic; returns full range otherwise.
 *
 * @param data - Cartesian data in any supported format
 * @param xMin - Minimum X value (inclusive)
 * @param xMax - Maximum X value (inclusive)
 * @returns Index range { start, end } for visible data
 */
export function findVisibleRangeIndicesByX(
  data: CartesianSeriesData,
  xMin: number,
  xMax: number
): { readonly start: number; readonly end: number } {
  const n = getPointCount(data);
  if (n === 0) return { start: 0, end: 0 };
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return { start: 0, end: n };

  const canBinarySearch = isMonotonicNonDecreasingFiniteX(data);
  if (!canBinarySearch) {
    // Data is not monotonic by x; we can't represent the visible set as a contiguous index range
    // Fall back to processing the full series for correctness
    return { start: 0, end: n };
  }

  const start = lowerBoundX(data, xMin);
  const end = upperBoundX(data, xMax);

  const s = clampInt(start, 0, n);
  const e = clampInt(end, 0, n);
  return e <= s ? { start: s, end: s } : { start: s, end: e };
}

/**
 * Slices OHLC/candlestick data to the visible timestamp range [xMin, xMax].
 *
 * Uses binary search (O(log n)) when timestamps are monotonic;
 * otherwise falls back to linear filtering (O(n)).
 *
 * @param data - OHLC data points (tuple or object format)
 * @param xMin - Minimum timestamp (inclusive)
 * @param xMax - Maximum timestamp (inclusive)
 * @returns Sliced data array containing only points within [xMin, xMax]
 */
export function sliceVisibleRangeByOHLC(
  data: ReadonlyArray<OHLCDataPoint>,
  xMin: number,
  xMax: number
): ReadonlyArray<OHLCDataPoint> {
  const n = data.length;
  if (n === 0) return data;
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return data;

  const canBinarySearch = isMonotonicNonDecreasingFiniteTimestamp(data);
  const isTuple = n > 0 && isTupleOHLCDataPoint(data[0]!);

  if (canBinarySearch) {
    const lo = isTuple
      ? lowerBoundTimestampTuple(data as ReadonlyArray<OHLCDataPointTuple>, xMin)
      : lowerBoundTimestampObject(data as ReadonlyArray<OHLCDataPointObject>, xMin);
    const hi = isTuple
      ? upperBoundTimestampTuple(data as ReadonlyArray<OHLCDataPointTuple>, xMax)
      : upperBoundTimestampObject(data as ReadonlyArray<OHLCDataPointObject>, xMax);

    if (lo <= 0 && hi >= n) return data;
    if (hi <= lo) return [];
    return data.slice(lo, hi);
  }

  // Safe fallback: linear filter (preserves order, ignores non-finite timestamp)
  const out: OHLCDataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = data[i]!;
    const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp >= xMin && timestamp <= xMax) out.push(p);
  }
  return out;
}
