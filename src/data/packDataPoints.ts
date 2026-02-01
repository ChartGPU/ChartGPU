/**
 * Data point packing utilities for GPU buffer uploads.
 * 
 * Internal utilities that convert high-level DataPoint/OHLCDataPoint arrays into
 * interleaved Float32Array buffers suitable for direct GPU buffer uploads via
 * `queue.writeBuffer()`.
 * 
 * @module packDataPoints
 * @internal
 */

import type { DataPoint, OHLCDataPoint, DataPointTuple } from '../config/types';
import type { OHLCDataPointTuple, OHLCDataPointObject } from '../config/types';

/**
 * Type guard to check if a DataPoint is in tuple form.
 */
function isTupleDataPoint(point: DataPoint): point is DataPointTuple {
  return Array.isArray(point);
}

/**
 * Type guard to check if an OHLCDataPoint is in tuple form.
 */
function isOHLCTuple(point: OHLCDataPoint): point is OHLCDataPointTuple {
  return Array.isArray(point);
}

/**
 * Packs DataPoint array into an interleaved Float32Array for GPU buffer uploads.
 * 
 * **Internal utility** used by data store for efficient GPU buffer management.
 * 
 * **Format**: `[x0, y0, x1, y1, x2, y2, ...]` (2 floats per point = 8 bytes stride)
 * 
 * @param points - Array of data points (tuple or object form)
 * @returns Interleaved Float32Array [x0,y0,x1,y1,...] for GPU vertex buffer upload
 * @throws {TypeError} If points is null, undefined, or not an array
 * @throws {RangeError} If points array is empty or contains invalid values
 * @internal
 * 
 * @example
 * ```typescript
 * const points = [{ x: 0, y: 10 }, { x: 1, y: 20 }];
 * const packed = packDataPoints(points);
 * // packed = Float32Array[0, 10, 1, 20]
 * 
 * // Upload to GPU buffer:
 * device.queue.writeBuffer(vertexBuffer, 0, packed.buffer);
 * ```
 */
export function packDataPoints(points: ReadonlyArray<DataPoint>): Float32Array {
  // Input validation
  if (!points) {
    throw new TypeError('packDataPoints: points parameter is required');
  }
  
  if (!Array.isArray(points)) {
    throw new TypeError('packDataPoints: points must be an array');
  }
  
  if (points.length === 0) {
    // Return empty array for empty input (valid case)
    return new Float32Array(0);
  }
  
  // Validate array length doesn't exceed safe limits
  // Max safe array size: ~2GB / 8 bytes = 268M points
  const MAX_POINTS = 268_435_456; // 2^28 points = 2GB buffer
  if (points.length > MAX_POINTS) {
    throw new RangeError(
      `packDataPoints: points array too large (${points.length} points). ` +
      `Maximum supported: ${MAX_POINTS.toLocaleString()} points (2GB buffer limit)`
    );
  }

  // Allocate buffer: 2 floats per point × 4 bytes per float = 8 bytes per point
  const buffer = new ArrayBuffer(points.length * 2 * 4);
  const f32 = new Float32Array(buffer);

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    
    // Validate point is not null/undefined
    if (point === null || point === undefined) {
      throw new TypeError(
        `packDataPoints: Invalid point at index ${i}. ` +
        `Expected DataPoint (tuple or object), got ${point}`
      );
    }
    
    const x = isTupleDataPoint(point) ? point[0] : point.x;
    const y = isTupleDataPoint(point) ? point[1] : point.y;
    
    // Validate numeric values (catches NaN, undefined properties)
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new TypeError(
        `packDataPoints: Invalid coordinate values at index ${i}. ` +
        `Expected numbers, got x=${typeof x}, y=${typeof y}`
      );
    }
    
    // Note: NaN and Infinity are valid Float32 values and will be preserved
    // If you need to reject them, add additional checks here
    
    f32[i * 2 + 0] = x;
    f32[i * 2 + 1] = y;
  }

  return f32;
}

/**
 * Packs OHLCDataPoint array into an interleaved Float32Array for GPU buffer uploads.
 * 
 * **Internal utility** used by data store for efficient candlestick GPU buffer management.
 * 
 * **Format**: `[t0, o0, h0, l0, c0, t1, o1, h1, l1, c1, ...]` (5 floats per point = 20 bytes stride)
 * 
 * Order follows ECharts convention: timestamp, open, high, low, close (t, o, h, l, c).
 * 
 * @param points - Array of OHLC data points (tuple or object form)
 * @returns Interleaved Float32Array [t0,o0,h0,l0,c0,t1,...] for GPU vertex buffer upload
 * @throws {TypeError} If points is null, undefined, or not an array
 * @throws {RangeError} If points array is empty or contains invalid values
 * @internal
 * 
 * @example
 * ```typescript
 * const ohlcPoints = [
 *   { timestamp: 1000, open: 100, high: 110, low: 95, close: 105 },
 *   { timestamp: 2000, open: 105, high: 115, low: 100, close: 110 }
 * ];
 * const packed = packOHLCDataPoints(ohlcPoints);
 * // packed = Float32Array[1000, 100, 110, 95, 105, 2000, 105, 115, 100, 110]
 * 
 * // Upload to GPU buffer:
 * device.queue.writeBuffer(vertexBuffer, 0, packed.buffer);
 * ```
 */
export function packOHLCDataPoints(points: ReadonlyArray<OHLCDataPoint>): Float32Array {
  // Input validation
  if (!points) {
    throw new TypeError('packOHLCDataPoints: points parameter is required');
  }
  
  if (!Array.isArray(points)) {
    throw new TypeError('packOHLCDataPoints: points must be an array');
  }
  
  if (points.length === 0) {
    // Return empty array for empty input (valid case)
    return new Float32Array(0);
  }
  
  // Validate array length doesn't exceed safe limits
  // Max safe array size: ~2GB / 20 bytes = 107M points
  const MAX_POINTS = 107_374_182; // 2^30 / 10 points = ~2GB buffer
  if (points.length > MAX_POINTS) {
    throw new RangeError(
      `packOHLCDataPoints: points array too large (${points.length} points). ` +
      `Maximum supported: ${MAX_POINTS.toLocaleString()} points (2GB buffer limit)`
    );
  }

  // Allocate buffer: 5 floats per point × 4 bytes per float = 20 bytes per point
  const buffer = new ArrayBuffer(points.length * 5 * 4);
  const f32 = new Float32Array(buffer);

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    
    // Validate point is not null/undefined
    if (point === null || point === undefined) {
      throw new TypeError(
        `packOHLCDataPoints: Invalid point at index ${i}. ` +
        `Expected OHLCDataPoint (tuple or object), got ${point}`
      );
    }
    
    if (isOHLCTuple(point)) {
      // Tuple form: [timestamp, open, close, low, high]
      // NOTE: ECharts convention is [t, o, c, l, h] but we store as [t, o, h, l, c]
      
      // Validate tuple has 5 elements
      if (point.length !== 5) {
        throw new TypeError(
          `packOHLCDataPoints: Invalid OHLC tuple at index ${i}. ` +
          `Expected 5 elements [timestamp, open, close, low, high], got ${point.length}`
        );
      }
      
      const timestamp = point[0];
      const open = point[1];
      const close = point[2];
      const low = point[3];
      const high = point[4];
      
      // Validate all values are numbers
      if (typeof timestamp !== 'number' || typeof open !== 'number' || 
          typeof close !== 'number' || typeof low !== 'number' || typeof high !== 'number') {
        throw new TypeError(
          `packOHLCDataPoints: Invalid OHLC values at index ${i}. ` +
          `All values must be numbers, got [${typeof timestamp}, ${typeof open}, ${typeof close}, ${typeof low}, ${typeof high}]`
        );
      }
      
      f32[i * 5 + 0] = timestamp;
      f32[i * 5 + 1] = open;
      f32[i * 5 + 2] = high; // Reorder: high comes from index 4
      f32[i * 5 + 3] = low;  // Reorder: low from index 3
      f32[i * 5 + 4] = close; // Reorder: close from index 2
    } else {
      // Object form: { timestamp, open, close, low, high }
      const ohlcObj = point as OHLCDataPointObject;
      
      const { timestamp, open, high, low, close } = ohlcObj;
      
      // Validate all required properties exist and are numbers
      if (typeof timestamp !== 'number' || typeof open !== 'number' || 
          typeof high !== 'number' || typeof low !== 'number' || typeof close !== 'number') {
        throw new TypeError(
          `packOHLCDataPoints: Invalid OHLC object at index ${i}. ` +
          `All properties (timestamp, open, high, low, close) must be numbers, got ` +
          `{timestamp: ${typeof timestamp}, open: ${typeof open}, high: ${typeof high}, low: ${typeof low}, close: ${typeof close}}`
        );
      }
      
      f32[i * 5 + 0] = timestamp;
      f32[i * 5 + 1] = open;
      f32[i * 5 + 2] = high;
      f32[i * 5 + 3] = low;
      f32[i * 5 + 4] = close;
    }
  }

  return f32;
}
