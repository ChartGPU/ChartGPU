/**
 * Internal cartesian data abstraction for CartesianSeriesData.
 *
 * Provides high-performance, allocation-minimizing primitives to support all three cartesian formats:
 * - ReadonlyArray<DataPoint> (tuple or object)
 * - XYArraysData (separate x/y/size arrays)
 * - InterleavedXYData (typed array view with [x0,y0,x1,y1,...] layout)
 *
 * DO NOT export from public entrypoint (src/index.ts). This is internal-only.
 *
 * @module cartesianData
 * @internal
 */

import type { CartesianSeriesData, DataPoint, XYArraysData, InterleavedXYData } from '../config/types';

/**
 * Bounds type for min/max x and y values.
 */
export type Bounds = Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;

/**
 * Type for typed arrays with numeric indexing (excluding DataView and BigInt arrays).
 * BigInt arrays are excluded because coordinates must be numbers, not bigints.
 */
type TypedArray = 
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

/**
 * Type guard for XYArraysData format.
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
 * Type guard for InterleavedXYData format (ArrayBufferView).
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
 * Type guard for tuple DataPoint format.
 */
function isTupleDataPoint(p: DataPoint): p is readonly [number, number, number?] {
  return Array.isArray(p);
}

/**
 * Returns the number of points in the CartesianSeriesData.
 */
export function getPointCount(data: CartesianSeriesData): number {
  if (isXYArraysData(data)) {
    // Use minimum of x and y array lengths for safety
    return Math.min(data.x.length, data.y.length);
  }
  
  if (isInterleavedXYData(data)) {
    // DataView is unsupported - throw clear error
    if (data instanceof DataView) {
      throw new Error('DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).');
    }
    // Interpret pointCount as floor(length/2), tolerant of odd length
    // Cast to typed array with numeric indexing after DataView check
    const arr = data as TypedArray;
    return Math.floor(arr.length / 2);
  }
  
  // ReadonlyArray<DataPoint>
  return data.length;
}

/**
 * Returns the x-coordinate of the point at index i.
 * Returns NaN if the point is undefined, null, or non-object (for DataPoint[] format).
 * This allows callers using `Number.isFinite()` to naturally skip missing points.
 */
export function getX(data: CartesianSeriesData, i: number): number {
  if (isXYArraysData(data)) {
    return data.x[i]!;
  }
  
  if (isInterleavedXYData(data)) {
    if (data instanceof DataView) {
      throw new Error('DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).');
    }
    const arr = data as TypedArray;
    return arr[i * 2]!;
  }
  
  // ReadonlyArray<DataPoint>
  const p = data[i];
  // Guard against undefined/null/non-object entries (sparse arrays, holes)
  if (p === undefined || p === null || typeof p !== 'object') {
    return NaN;
  }
  return isTupleDataPoint(p) ? p[0] : p.x;
}

/**
 * Returns the y-coordinate of the point at index i.
 * Returns NaN if the point is undefined, null, or non-object (for DataPoint[] format).
 * This allows callers using `Number.isFinite()` to naturally skip missing points.
 */
export function getY(data: CartesianSeriesData, i: number): number {
  if (isXYArraysData(data)) {
    return data.y[i]!;
  }
  
  if (isInterleavedXYData(data)) {
    if (data instanceof DataView) {
      throw new Error('DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).');
    }
    const arr = data as TypedArray;
    return arr[i * 2 + 1]!;
  }
  
  // ReadonlyArray<DataPoint>
  const p = data[i];
  // Guard against undefined/null/non-object entries (sparse arrays, holes)
  if (p === undefined || p === null || typeof p !== 'object') {
    return NaN;
  }
  return isTupleDataPoint(p) ? p[1] : p.y;
}

/**
 * Returns the size value of the point at index i, or undefined if not available.
 * Returns undefined if the point is undefined, null, or non-object (for DataPoint[] format).
 * Note: InterleavedXYData does NOT support interleaved size (use XYArraysData.size if needed).
 */
export function getSize(data: CartesianSeriesData, i: number): number | undefined {
  if (isXYArraysData(data)) {
    return data.size?.[i];
  }
  
  if (isInterleavedXYData(data)) {
    // Size is not interleaved in InterleavedXYData format
    return undefined;
  }
  
  // ReadonlyArray<DataPoint>
  const p = data[i];
  // Guard against undefined/null/non-object entries (sparse arrays, holes)
  if (p === undefined || p === null || typeof p !== 'object') {
    return undefined;
  }
  return isTupleDataPoint(p) ? p[2] : p.size;
}

/**
 * Packs XY coordinates from CartesianSeriesData into a Float32Array in interleaved layout.
 * 
 * Writes `pointCount` points starting at `srcPointOffset` in the source data
 * into `out` starting at `outFloatOffset` (measured in float32 elements, not bytes).
 * 
 * Each point writes 2 floats: [x - xOffset, y].
 * Size dimension is NOT packed (use getSize() separately if needed).
 * 
 * @param out - Target Float32Array to write into
 * @param outFloatOffset - Starting offset in `out` (in float32 elements)
 * @param src - Source CartesianSeriesData
 * @param srcPointOffset - Starting point index in source
 * @param pointCount - Number of points to pack
 * @param xOffset - Value to subtract from x coordinates (for Float32 precision preservation)
 */
export function packXYInto(
  out: Float32Array,
  outFloatOffset: number,
  src: CartesianSeriesData,
  srcPointOffset: number,
  pointCount: number,
  xOffset: number
): void {
  const availablePoints = getPointCount(src) - srcPointOffset;
  const actualPointCount = Math.min(pointCount, availablePoints);
  
  if (actualPointCount <= 0) return;
  
  // Validate output buffer capacity
  const requiredOutLength = outFloatOffset + actualPointCount * 2;
  if (requiredOutLength > out.length) {
    throw new Error(
      `packXYInto: output buffer too small (need ${requiredOutLength} floats, have ${out.length})`
    );
  }
  
  if (isXYArraysData(src)) {
    // Fast path: bulk copy with xOffset adjustment
    for (let i = 0; i < actualPointCount; i++) {
      const srcIdx = srcPointOffset + i;
      const outIdx = outFloatOffset + i * 2;
      out[outIdx] = src.x[srcIdx]! - xOffset;
      out[outIdx + 1] = src.y[srcIdx]!;
    }
    return;
  }
  
  if (isInterleavedXYData(src)) {
    if (src instanceof DataView) {
      throw new Error('DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).');
    }
    
    const arr = src as TypedArray;
    
    // Fast path: bulk copy with xOffset adjustment
    for (let i = 0; i < actualPointCount; i++) {
      const srcIdx = (srcPointOffset + i) * 2;
      const outIdx = outFloatOffset + i * 2;
      out[outIdx] = arr[srcIdx]! - xOffset;
      out[outIdx + 1] = arr[srcIdx + 1]!;
    }
    return;
  }
  
  // ReadonlyArray<DataPoint> path
  for (let i = 0; i < actualPointCount; i++) {
    const srcIdx = srcPointOffset + i;
    const outIdx = outFloatOffset + i * 2;
    const p = src[srcIdx];
    
    // Guard against undefined/null/non-object entries (sparse arrays, holes)
    if (p === undefined || p === null || typeof p !== 'object') {
      out[outIdx] = NaN;
      out[outIdx + 1] = NaN;
      continue;
    }
    
    const x = isTupleDataPoint(p) ? p[0] : p.x;
    const y = isTupleDataPoint(p) ? p[1] : p.y;
    
    out[outIdx] = x - xOffset;
    out[outIdx + 1] = y;
  }
}

/**
 * Computes xMin/xMax/yMin/yMax bounds from CartesianSeriesData.
 * Skips non-finite x or y values. Returns null if no finite points found.
 * Ensures xMin !== xMax and yMin !== yMax for scale derivation (expands max by +1 if needed).
 *
 * @param data - CartesianSeriesData in any supported format
 * @returns Bounds object or null if no finite points
 */
export function computeRawBoundsFromCartesianData(data: CartesianSeriesData): Bounds | null {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  
  // Hoist type detection outside loop to avoid per-point type checks
  if (isXYArraysData(data)) {
    // Fast path for XYArraysData
    const count = Math.min(data.x.length, data.y.length);
    for (let i = 0; i < count; i++) {
      const x = data.x[i]!;
      const y = data.y[i]!;
      
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  } else if (isInterleavedXYData(data)) {
    // Fast path for InterleavedXYData
    if (data instanceof DataView) {
      throw new Error('DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).');
    }
    
    const arr = data as TypedArray;
    const count = Math.floor(arr.length / 2);
    
    for (let i = 0; i < count; i++) {
      const x = arr[i * 2]!;
      const y = arr[i * 2 + 1]!;
      
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  } else {
    // Array<DataPoint> path: use helper functions
    const count = data.length;
    for (let i = 0; i < count; i++) {
      const x = getX(data, i);
      const y = getY(data, i);
      
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return null;
  }
  
  // Preserve existing behavior: if min==max, expand max by +1 for usability
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;
  
  return { xMin, xMax, yMin, yMax };
}

/**
 * Returns true if a CartesianSeriesData array contains any null entries (gap markers).
 * Only applies to ReadonlyArray<DataPoint | null> format — XYArraysData and
 * InterleavedXYData cannot contain null entries and always return false.
 */
export function hasNullGaps(data: CartesianSeriesData): boolean {
  if (!Array.isArray(data)) return false;
  return data.includes(null);
}

/**
 * Removes null entries from a DataPoint array.
 * Used by connectNulls to strip gap markers before GPU upload,
 * so the line/area draws through gaps instead of breaking.
 */
export function filterNullGaps(data: ReadonlyArray<DataPoint | null>): ReadonlyArray<DataPoint> {
  return data.filter((p): p is DataPoint => p !== null);
}
