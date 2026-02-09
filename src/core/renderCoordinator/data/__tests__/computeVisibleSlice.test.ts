/**
 * Unit tests for visible slice computation utilities
 */

import { describe, it, expect } from 'vitest';
import {
  isTupleOHLCDataPoint,
  isMonotonicNonDecreasingFiniteX,
  isMonotonicNonDecreasingFiniteTimestamp,
  sliceVisibleRangeByX,
  findVisibleRangeIndicesByX,
  sliceVisibleRangeByOHLC
} from '../computeVisibleSlice';
import type { DataPoint, OHLCDataPoint } from '../../../../config/types';

describe('computeVisibleSlice', () => {
  describe('Type guards', () => {

    it('identifies tuple OHLC data points', () => {
      expect(isTupleOHLCDataPoint([100, 10, 12, 9, 11])).toBe(true);
      expect(isTupleOHLCDataPoint({ timestamp: 100, open: 10, high: 12, low: 9, close: 11 })).toBe(false);
    });
  });

  describe('Monotonicity checks - Cartesian', () => {
    it('detects monotonic tuple data', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 15], [4, 25]];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(true);
    });

    it('detects monotonic object data', () => {
      const data: DataPoint[] = [{ x: 1, y: 10 }, { x: 2, y: 20 }, { x: 3, y: 15 }];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(true);
    });

    it('detects non-monotonic tuple data', () => {
      const data: DataPoint[] = [[1, 10], [3, 20], [2, 15]];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('detects non-monotonic object data', () => {
      const data: DataPoint[] = [{ x: 1, y: 10 }, { x: 3, y: 20 }, { x: 2, y: 15 }];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('rejects data with non-finite X values (tuple)', () => {
      const data: DataPoint[] = [[1, 10], [NaN, 20], [3, 15]];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('rejects data with non-finite X values (object)', () => {
      const data: DataPoint[] = [{ x: 1, y: 10 }, { x: Infinity, y: 20 }];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('caches monotonicity results', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 15]];
      const result1 = isMonotonicNonDecreasingFiniteX(data);
      const result2 = isMonotonicNonDecreasingFiniteX(data);
      expect(result1).toBe(result2);
      expect(result1).toBe(true);
    });

    it('allows equal consecutive X values (monotonic non-decreasing)', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [2, 25], [3, 15]];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(true);
    });

    it('detects monotonic XYArraysData', () => {
      const data = { x: [1, 2, 3, 4], y: [10, 20, 15, 25] };
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(true);
    });

    it('detects non-monotonic XYArraysData', () => {
      const data = { x: [1, 3, 2, 4], y: [10, 20, 15, 25] };
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('detects monotonic InterleavedXYData (Float32Array)', () => {
      const data = new Float32Array([1, 10, 2, 20, 3, 15, 4, 25]);
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(true);
    });

    it('detects non-monotonic InterleavedXYData (Float32Array)', () => {
      const data = new Float32Array([1, 10, 3, 20, 2, 15, 4, 25]);
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('handles InterleavedXYData with byteOffset (subarray)', () => {
      const base = new Float32Array([99, 99, 1, 10, 2, 20, 3, 15]);
      const data = base.subarray(2); // [1, 10, 2, 20, 3, 15]
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(true);
    });

    it('rejects InterleavedXYData with non-finite X values', () => {
      const data = new Float32Array([1, 10, NaN, 20, 3, 15]);
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });
  });

  describe('Monotonicity checks - OHLC', () => {
    it('detects monotonic tuple OHLC data', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [2000, 11, 13, 10, 12],
        [3000, 12, 14, 11, 13]
      ];
      expect(isMonotonicNonDecreasingFiniteTimestamp(data)).toBe(true);
    });

    it('detects monotonic object OHLC data', () => {
      const data: OHLCDataPoint[] = [
        { timestamp: 1000, open: 10, high: 12, low: 9, close: 11 },
        { timestamp: 2000, open: 11, high: 13, low: 10, close: 12 }
      ];
      expect(isMonotonicNonDecreasingFiniteTimestamp(data)).toBe(true);
    });

    it('detects non-monotonic OHLC data', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [3000, 12, 14, 11, 13],
        [2000, 11, 13, 10, 12]
      ];
      expect(isMonotonicNonDecreasingFiniteTimestamp(data)).toBe(false);
    });

    it('rejects OHLC data with non-finite timestamps', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [NaN, 11, 13, 10, 12]
      ];
      expect(isMonotonicNonDecreasingFiniteTimestamp(data)).toBe(false);
    });

    it('caches OHLC monotonicity results', () => {
      const data: OHLCDataPoint[] = [[1000, 10, 12, 9, 11], [2000, 11, 13, 10, 12]];
      const result1 = isMonotonicNonDecreasingFiniteTimestamp(data);
      const result2 = isMonotonicNonDecreasingFiniteTimestamp(data);
      expect(result1).toBe(result2);
      expect(result1).toBe(true);
    });
  });

  describe('sliceVisibleRangeByX', () => {
    it('slices monotonic tuple data using binary search', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50]];
      const result = sliceVisibleRangeByX(data, 2, 4);
      expect(result).toEqual([[2, 20], [3, 30], [4, 40]]);
    });

    it('slices monotonic object data using binary search', () => {
      const data: DataPoint[] = [
        { x: 1, y: 10 },
        { x: 2, y: 20 },
        { x: 3, y: 30 },
        { x: 4, y: 40 }
      ];
      const result = sliceVisibleRangeByX(data, 2, 3);
      expect(result).toEqual([{ x: 2, y: 20 }, { x: 3, y: 30 }]);
    });

    it('slices monotonic XYArraysData using binary search', () => {
      const data = { x: [1, 2, 3, 4, 5], y: [10, 20, 30, 40, 50] };
      const result = sliceVisibleRangeByX(data, 2, 4);
      expect(result).toEqual({ x: [2, 3, 4], y: [20, 30, 40] });
    });

    it('slices monotonic InterleavedXYData (Float32Array) using binary search', () => {
      const data = new Float32Array([1, 10, 2, 20, 3, 30, 4, 40, 5, 50]);
      const result = sliceVisibleRangeByX(data, 2, 4) as Float32Array;
      expect(Array.from(result)).toEqual([2, 20, 3, 30, 4, 40]);
    });

    it('handles InterleavedXYData subarray with byteOffset', () => {
      const base = new Float32Array([99, 99, 1, 10, 2, 20, 3, 30, 4, 40]);
      const data = base.subarray(2); // [1, 10, 2, 20, 3, 30, 4, 40]
      const result = sliceVisibleRangeByX(data, 2, 3) as Float32Array;
      expect(Array.from(result)).toEqual([2, 20, 3, 30]);
    });

    it('returns empty array when range has no points', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [5, 50]];
      const result = sliceVisibleRangeByX(data, 3, 4);
      expect(result).toEqual([]);
    });

    it('returns full data when range encompasses all points', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 30]];
      const result = sliceVisibleRangeByX(data, 0, 10);
      expect(result).toBe(data);
    });

    it('returns empty array for empty input', () => {
      const data: DataPoint[] = [];
      const result = sliceVisibleRangeByX(data, 1, 5);
      expect(result).toEqual([]);
    });

    it('returns full data when xMin/xMax are non-finite', () => {
      const data: DataPoint[] = [[1, 10], [2, 20]];
      expect(sliceVisibleRangeByX(data, NaN, 5)).toBe(data);
      expect(sliceVisibleRangeByX(data, 1, Infinity)).toBe(data);
    });

    it('filters non-monotonic data using linear scan', () => {
      const data: DataPoint[] = [[3, 30], [1, 10], [4, 40], [2, 20]];
      const result = sliceVisibleRangeByX(data, 2, 3);
      expect(result).toEqual([[3, 30], [2, 20]]);
    });

    it('ignores non-finite X values in linear scan', () => {
      const data: DataPoint[] = [[3, 30], [NaN, 15], [1, 10], [2, 20]];
      const result = sliceVisibleRangeByX(data, 1, 2);
      expect(result).toEqual([[1, 10], [2, 20]]);
    });

    it('handles boundary values correctly (inclusive)', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 30], [4, 40]];
      const result = sliceVisibleRangeByX(data, 2, 3);
      expect(result).toEqual([[2, 20], [3, 30]]);
    });
  });

  describe('findVisibleRangeIndicesByX', () => {
    it('finds correct index range for monotonic data', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50]];
      const result = findVisibleRangeIndicesByX(data, 2, 4);
      expect(result).toEqual({ start: 1, end: 4 });
    });

    it('finds correct index range for monotonic XYArraysData', () => {
      const data = { x: [1, 2, 3, 4, 5], y: [10, 20, 30, 40, 50] };
      const result = findVisibleRangeIndicesByX(data, 2, 4);
      expect(result).toEqual({ start: 1, end: 4 });
    });

    it('finds correct index range for monotonic InterleavedXYData', () => {
      const data = new Float32Array([1, 10, 2, 20, 3, 30, 4, 40, 5, 50]);
      const result = findVisibleRangeIndicesByX(data, 2, 4);
      expect(result).toEqual({ start: 1, end: 4 });
    });

    it('returns { 0, 0 } for empty data', () => {
      const data: DataPoint[] = [];
      const result = findVisibleRangeIndicesByX(data, 1, 5);
      expect(result).toEqual({ start: 0, end: 0 });
    });

    it('returns full range for non-monotonic data', () => {
      const data: DataPoint[] = [[3, 30], [1, 10], [2, 20]];
      const result = findVisibleRangeIndicesByX(data, 1, 2);
      expect(result).toEqual({ start: 0, end: 3 });
    });

    it('returns full range when xMin/xMax are non-finite', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 30]];
      expect(findVisibleRangeIndicesByX(data, NaN, 5)).toEqual({ start: 0, end: 3 });
    });

    it('clamps indices to valid range', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 30]];
      const result = findVisibleRangeIndicesByX(data, 0, 10);
      expect(result).toEqual({ start: 0, end: 3 });
    });

    it('returns empty range when no points in range', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [5, 50]];
      const result = findVisibleRangeIndicesByX(data, 3, 4);
      expect(result).toEqual({ start: 2, end: 2 });
    });
  });

  describe('sliceVisibleRangeByOHLC', () => {
    it('slices monotonic tuple OHLC data using binary search', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [2000, 11, 13, 10, 12],
        [3000, 12, 14, 11, 13],
        [4000, 13, 15, 12, 14]
      ];
      const result = sliceVisibleRangeByOHLC(data, 2000, 3000);
      expect(result).toEqual([
        [2000, 11, 13, 10, 12],
        [3000, 12, 14, 11, 13]
      ]);
    });

    it('slices monotonic object OHLC data using binary search', () => {
      const data: OHLCDataPoint[] = [
        { timestamp: 1000, open: 10, high: 12, low: 9, close: 11 },
        { timestamp: 2000, open: 11, high: 13, low: 10, close: 12 },
        { timestamp: 3000, open: 12, high: 14, low: 11, close: 13 }
      ];
      const result = sliceVisibleRangeByOHLC(data, 1500, 2500);
      expect(result).toEqual([
        { timestamp: 2000, open: 11, high: 13, low: 10, close: 12 }
      ]);
    });

    it('returns empty array when timestamp range has no points', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [5000, 13, 15, 12, 14]
      ];
      const result = sliceVisibleRangeByOHLC(data, 2000, 4000);
      expect(result).toEqual([]);
    });

    it('returns full data when range encompasses all timestamps', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [2000, 11, 13, 10, 12]
      ];
      const result = sliceVisibleRangeByOHLC(data, 0, 10000);
      expect(result).toBe(data);
    });

    it('filters non-monotonic OHLC data using linear scan', () => {
      const data: OHLCDataPoint[] = [
        [3000, 12, 14, 11, 13],
        [1000, 10, 12, 9, 11],
        [2000, 11, 13, 10, 12]
      ];
      const result = sliceVisibleRangeByOHLC(data, 1500, 2500);
      expect(result).toEqual([
        [2000, 11, 13, 10, 12]
      ]);
    });

    it('ignores non-finite timestamps in linear scan', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [NaN, 11, 13, 10, 12],
        [2000, 12, 14, 11, 13]
      ];
      const result = sliceVisibleRangeByOHLC(data, 1500, 2500);
      expect(result).toEqual([
        [2000, 12, 14, 11, 13]
      ]);
    });

    it('returns empty array for empty input', () => {
      const data: OHLCDataPoint[] = [];
      const result = sliceVisibleRangeByOHLC(data, 1000, 5000);
      expect(result).toEqual([]);
    });

    it('returns full data when timestamps are non-finite', () => {
      const data: OHLCDataPoint[] = [[1000, 10, 12, 9, 11]];
      expect(sliceVisibleRangeByOHLC(data, NaN, 5000)).toBe(data);
      expect(sliceVisibleRangeByOHLC(data, 1000, Infinity)).toBe(data);
    });

    it('handles boundary timestamps correctly (inclusive)', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [2000, 11, 13, 10, 12],
        [3000, 12, 14, 11, 13]
      ];
      const result = sliceVisibleRangeByOHLC(data, 2000, 3000);
      expect(result).toEqual([
        [2000, 11, 13, 10, 12],
        [3000, 12, 14, 11, 13]
      ]);
    });
  });
});
