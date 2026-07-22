/**
 * Unit tests for visible slice computation utilities
 */

import { describe, it, expect } from 'vitest';
import {
  isTupleOHLCDataPoint,
  isMonotonicNonDecreasingFiniteX,
  sliceVisibleRangeByX,
  findVisibleRangeIndicesByX,
  sliceVisibleRangeByOHLC,
} from '../computeVisibleSlice';
import type { DataPoint, OHLCDataPoint } from '../../../../config/types';

describe('computeVisibleSlice', () => {
  describe('Type guards', () => {
    it('identifies tuple OHLC data points', () => {
      expect(isTupleOHLCDataPoint([100, 10, 12, 9, 11])).toBe(true);
      expect(
        isTupleOHLCDataPoint({
          timestamp: 100,
          open: 10,
          high: 12,
          low: 9,
          close: 11,
        })
      ).toBe(false);
    });
  });

  describe('Monotonicity checks - Cartesian', () => {
    it('detects monotonic tuple data', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 15],
        [4, 25],
      ];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(true);
    });

    it('detects monotonic object data', () => {
      const data: DataPoint[] = [
        { x: 1, y: 10 },
        { x: 2, y: 20 },
        { x: 3, y: 15 },
      ];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(true);
    });

    it('detects non-monotonic tuple data', () => {
      const data: DataPoint[] = [
        [1, 10],
        [3, 20],
        [2, 15],
      ];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('detects non-monotonic object data', () => {
      const data: DataPoint[] = [
        { x: 1, y: 10 },
        { x: 3, y: 20 },
        { x: 2, y: 15 },
      ];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('rejects data with non-finite X values (tuple)', () => {
      const data: DataPoint[] = [
        [1, 10],
        [NaN, 20],
        [3, 15],
      ];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('rejects data with non-finite X values (object)', () => {
      const data: DataPoint[] = [
        { x: 1, y: 10 },
        { x: Infinity, y: 20 },
      ];
      expect(isMonotonicNonDecreasingFiniteX(data)).toBe(false);
    });

    it('caches monotonicity results', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 15],
      ];
      const result1 = isMonotonicNonDecreasingFiniteX(data);
      const result2 = isMonotonicNonDecreasingFiniteX(data);
      expect(result1).toBe(result2);
      expect(result1).toBe(true);
    });

    it('allows equal consecutive X values (monotonic non-decreasing)', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [2, 25],
        [3, 15],
      ];
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

    it('FIFO multi-append at capacity stays mono without full rescan (device auto-window hover)', async () => {
      // ~device ring: many appends between mono polls (hover throttle) must not O(n).
      const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
      const cap = 10_000;
      const ring = createRingXYColumns(cap);
      const seed = {
        x: Float64Array.from({ length: cap }, (_, i) => i),
        y: Float64Array.from({ length: cap }, () => 0),
      };
      appendIntoRingXY(ring, seed, 0, cap, 0);
      expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);

      for (let a = 0; a < 5; a++) {
        const batch = {
          x: Float64Array.from({ length: 100 }, (_, i) => cap + a * 100 + i),
          y: Float64Array.from({ length: 100 }, () => 0),
        };
        appendIntoRingXY(ring, batch, 0, 100, 100);
      }
      const t0 = performance.now();
      for (let k = 0; k < 100; k++) {
        expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
      }
      expect(performance.now() - t0).toBeLessThan(50);
    });

    it('growing XY columns only re-check the new tail (streaming multi-M)', () => {
      // Owned MutableXYColumns grow under stable identity during appendData.
      const growable = {
        x: Array.from({ length: 5_000 }, (_, i) => i),
        y: Array.from({ length: 5_000 }, (_, i) => i),
      };
      expect(isMonotonicNonDecreasingFiniteX(growable)).toBe(true);
      for (let i = 5_000; i < 15_000; i++) {
        growable.x.push(i);
        growable.y.push(i);
      }
      expect(isMonotonicNonDecreasingFiniteX(growable)).toBe(true);
      // Same generation: pure cache hits must stay cheap
      const t1 = performance.now();
      for (let k = 0; k < 200; k++) {
        expect(isMonotonicNonDecreasingFiniteX(growable)).toBe(true);
      }
      expect(performance.now() - t1).toBeLessThan(50);

      growable.x.push(0);
      growable.y.push(0);
      expect(isMonotonicNonDecreasingFiniteX(growable)).toBe(false);
    });
  });

  describe('sliceVisibleRangeByX', () => {
    it('slices monotonic tuple data using binary search', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
        [4, 40],
        [5, 50],
      ];
      const result = sliceVisibleRangeByX(data, 2, 4);
      expect(result).toEqual([
        [2, 20],
        [3, 30],
        [4, 40],
      ]);
    });

    it('slices monotonic object data using binary search', () => {
      const data: DataPoint[] = [
        { x: 1, y: 10 },
        { x: 2, y: 20 },
        { x: 3, y: 30 },
        { x: 4, y: 40 },
      ];
      const result = sliceVisibleRangeByX(data, 2, 3);
      expect(result).toEqual([
        { x: 2, y: 20 },
        { x: 3, y: 30 },
      ]);
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
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [5, 50],
      ];
      const result = sliceVisibleRangeByX(data, 3, 4);
      expect(result).toEqual([]);
    });

    it('returns full data when range encompasses all points', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
      ];
      const result = sliceVisibleRangeByX(data, 0, 10);
      expect(result).toBe(data);
    });

    it('returns empty array for empty input', () => {
      const data: DataPoint[] = [];
      const result = sliceVisibleRangeByX(data, 1, 5);
      expect(result).toEqual([]);
    });

    it('returns full data when xMin/xMax are non-finite', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
      ];
      expect(sliceVisibleRangeByX(data, NaN, 5)).toBe(data);
      expect(sliceVisibleRangeByX(data, 1, Infinity)).toBe(data);
    });

    it('filters non-monotonic data using linear scan', () => {
      const data: DataPoint[] = [
        [3, 30],
        [1, 10],
        [4, 40],
        [2, 20],
      ];
      const result = sliceVisibleRangeByX(data, 2, 3);
      expect(result).toEqual([
        [3, 30],
        [2, 20],
      ]);
    });

    it('ignores non-finite X values in linear scan', () => {
      const data: DataPoint[] = [
        [3, 30],
        [NaN, 15],
        [1, 10],
        [2, 20],
      ];
      const result = sliceVisibleRangeByX(data, 1, 2);
      expect(result).toEqual([
        [1, 10],
        [2, 20],
      ]);
    });

    it('preserves null gap markers between in-range points (issue #150)', () => {
      // Repro: null at index 5; zoom window that spans both sides of the gap.
      const data: Array<DataPoint | null> = [];
      for (let i = 0; i < 10; i++) data.push([i, i % 2 ? 1.1 : 1.2]);
      data[5] = null;

      const result = sliceVisibleRangeByX(data as any, 2, 8) as Array<DataPoint | null>;
      expect(result).toEqual([[2, 1.2], [3, 1.1], [4, 1.2], null, [6, 1.2], [7, 1.1], [8, 1.2]]);
    });

    it('preserves multiple interior null gaps in one zoom window', () => {
      const data: Array<DataPoint | null> = [[0, 0], [1, 1], null, [3, 3], null, [5, 5], [6, 6]];
      expect(sliceVisibleRangeByX(data as any, 1, 5)).toEqual([[1, 1], null, [3, 3], null, [5, 5]]);
    });

    it('keeps interior nulls but drops mid-span out-of-range finite points (non-monotonic)', () => {
      // first kept idx=0 ([0,0]), last kept idx=5 ([2,3]); [100,1] is finite but out of range.
      const data: Array<DataPoint | null> = [[0, 0], null, [100, 1], null, [1, 2], [2, 3]];
      expect(sliceVisibleRangeByX(data as any, 0, 2)).toEqual([[0, 0], null, null, [1, 2], [2, 3]]);
    });

    it('preserves null gaps with object-form DataPoints', () => {
      const data: Array<DataPoint | null> = [{ x: 0, y: 0 }, { x: 1, y: 1 }, null, { x: 3, y: 3 }, { x: 4, y: 4 }];
      // Linear path materializes finite points as tuples; nulls stay null.
      expect(sliceVisibleRangeByX(data as any, 1, 4)).toEqual([[1, 1], null, [3, 3], [4, 4]]);
    });

    it('drops leading/trailing nulls outside the kept finite span', () => {
      const data: Array<DataPoint | null> = [null, [1, 10], [2, 20], null, [4, 40], null];
      // Zoom only left segment — no interior null between first and last kept.
      expect(sliceVisibleRangeByX(data as any, 1, 2)).toEqual([
        [1, 10],
        [2, 20],
      ]);
      // Zoom spanning the interior gap keeps the null between segments.
      expect(sliceVisibleRangeByX(data as any, 1, 4)).toEqual([[1, 10], [2, 20], null, [4, 40]]);
    });

    it('returns empty when only nulls fall in range', () => {
      const data: Array<DataPoint | null> = [[0, 0], null, [10, 10]];
      expect(sliceVisibleRangeByX(data as any, 3, 7)).toEqual([]);
    });

    it('handles boundary values correctly (inclusive)', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
        [4, 40],
      ];
      const result = sliceVisibleRangeByX(data, 2, 3);
      expect(result).toEqual([
        [2, 20],
        [3, 30],
      ]);
    });
  });

  describe('findVisibleRangeIndicesByX', () => {
    it('finds correct index range for monotonic data', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
        [4, 40],
        [5, 50],
      ];
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
      const data: DataPoint[] = [
        [3, 30],
        [1, 10],
        [2, 20],
      ];
      const result = findVisibleRangeIndicesByX(data, 1, 2);
      expect(result).toEqual({ start: 0, end: 3 });
    });

    it('returns full range when xMin/xMax are non-finite', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
      ];
      expect(findVisibleRangeIndicesByX(data, NaN, 5)).toEqual({
        start: 0,
        end: 3,
      });
    });

    it('clamps indices to valid range', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
      ];
      const result = findVisibleRangeIndicesByX(data, 0, 10);
      expect(result).toEqual({ start: 0, end: 3 });
    });

    it('returns empty range when no points in range', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [5, 50],
      ];
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
        [4000, 13, 15, 12, 14],
      ];
      const result = sliceVisibleRangeByOHLC(data, 2000, 3000);
      expect(result).toEqual([
        [2000, 11, 13, 10, 12],
        [3000, 12, 14, 11, 13],
      ]);
    });

    it('slices monotonic object OHLC data using binary search', () => {
      const data: OHLCDataPoint[] = [
        { timestamp: 1000, open: 10, high: 12, low: 9, close: 11 },
        { timestamp: 2000, open: 11, high: 13, low: 10, close: 12 },
        { timestamp: 3000, open: 12, high: 14, low: 11, close: 13 },
      ];
      const result = sliceVisibleRangeByOHLC(data, 1500, 2500);
      expect(result).toEqual([{ timestamp: 2000, open: 11, high: 13, low: 10, close: 12 }]);
    });

    it('returns empty array when timestamp range has no points', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [5000, 13, 15, 12, 14],
      ];
      const result = sliceVisibleRangeByOHLC(data, 2000, 4000);
      expect(result).toEqual([]);
    });

    it('returns full data when range encompasses all timestamps', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [2000, 11, 13, 10, 12],
      ];
      const result = sliceVisibleRangeByOHLC(data, 0, 10000);
      expect(result).toBe(data);
    });

    it('filters non-monotonic OHLC data using linear scan', () => {
      const data: OHLCDataPoint[] = [
        [3000, 12, 14, 11, 13],
        [1000, 10, 12, 9, 11],
        [2000, 11, 13, 10, 12],
      ];
      const result = sliceVisibleRangeByOHLC(data, 1500, 2500);
      expect(result).toEqual([[2000, 11, 13, 10, 12]]);
    });

    it('ignores non-finite timestamps in linear scan', () => {
      const data: OHLCDataPoint[] = [
        [1000, 10, 12, 9, 11],
        [NaN, 11, 13, 10, 12],
        [2000, 12, 14, 11, 13],
      ];
      const result = sliceVisibleRangeByOHLC(data, 1500, 2500);
      expect(result).toEqual([[2000, 12, 14, 11, 13]]);
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
        [3000, 12, 14, 11, 13],
      ];
      const result = sliceVisibleRangeByOHLC(data, 2000, 3000);
      expect(result).toEqual([
        [2000, 11, 13, 10, 12],
        [3000, 12, 14, 11, 13],
      ]);
    });
  });
});

describe('isMonotonicNonDecreasingFiniteX mutable ring/staging (issue 1.5 + generation cache)', () => {
  it('detects mono violation after FIFO append of decreasing x (same ring ref)', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const ring = createRingXYColumns(8);
    appendIntoRingXY(ring, { x: [0, 1, 2, 3], y: [0, 1, 2, 3] }, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    // Append decreasing x via API (generation count advances) — must not stick mono=true.
    appendIntoRingXY(ring, { x: [-50], y: [9] }, 0, 1, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(false);
  });

  it('detects mono violation on staging after count growth with decreasing x', async () => {
    const { createStagingRingView } = await import('../../../../data/cartesianData');
    const staging = new Float32Array(16);
    // linear: (0,0)(1,1)(2,2)(3,3)
    for (let i = 0; i < 4; i++) {
      staging[i * 2] = i;
      staging[i * 2 + 1] = i;
    }
    const view = createStagingRingView(staging, 0, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(view as any)).toBe(true);
    // Grow count with a decreasing x (generation change) — must re-verify tail.
    staging[8] = -1;
    staging[9] = 0;
    createStagingRingView(staging, 0, 0, 5, 0, view);
    expect(isMonotonicNonDecreasingFiniteX(view as any)).toBe(false);
  });

  it('monotonic ring append stays mono under many pure appends (incremental path)', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const ring = createRingXYColumns(10_000);
    appendIntoRingXY(ring, { x: [0, 1, 2, 3], y: [0, 1, 2, 3] }, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);

    // Many mono appends: generation-aware cache must keep mono=true (O(append) path).
    for (let k = 0; k < 200; k++) {
      const x0 = 4 + k;
      appendIntoRingXY(ring, { x: [x0], y: [0] }, 0, 1, 0);
      expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    }
    expect(ring.count).toBe(204);
  });

  it('same generation returns stable mono result', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const ring = createRingXYColumns(16);
    appendIntoRingXY(ring, { x: [1, 2, 3, 4], y: [0, 0, 0, 0] }, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
  });

  it('FIFO wrap at capacity keeps mono then detects violation', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const cap = 8;
    const ring = createRingXYColumns(cap);
    // Fill to capacity 0..7
    appendIntoRingXY(ring, { x: [0, 1, 2, 3, 4, 5, 6, 7], y: [0, 0, 0, 0, 0, 0, 0, 0] }, 0, 8, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    // Drop 2, append 8,9 → still mono
    appendIntoRingXY(ring, { x: [8, 9], y: [0, 0] }, 0, 2, 2);
    expect(ring.count).toBe(cap);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    // Drop 2, append decreasing → mono false via incremental
    appendIntoRingXY(ring, { x: [0, 1], y: [0, 0] }, 0, 2, 2);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(false);
  });

  it('strict full-buffer replace at start=0 detects non-mono (contentEpoch)', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const cap = 4;
    const ring = createRingXYColumns(cap);
    appendIntoRingXY(ring, { x: [0, 1, 2, 3], y: [0, 0, 0, 0] }, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    // Strict replace: drop all 4, write non-mono 3,1,2,0 — start/count/capacity stay 0/4/4.
    appendIntoRingXY(ring, { x: [3, 1, 2, 0], y: [0, 0, 0, 0] }, 0, 4, 4);
    expect(ring.start).toBe(0);
    expect(ring.count).toBe(cap);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(false);
  });

  it('wrap then strict full replace detects prefix-only mono violation', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const cap = 4;
    const ring = createRingXYColumns(cap);
    appendIntoRingXY(ring, { x: [0, 1, 2, 3], y: [0, 0, 0, 0] }, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    // Partial wrap so start != 0
    appendIntoRingXY(ring, { x: [4, 5], y: [0, 0] }, 0, 2, 2);
    expect(ring.start).not.toBe(0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    // Strict replace entire buffer with non-mono (prefix violation only if tail-only verify)
    appendIntoRingXY(ring, { x: [10, 0, 1, 2], y: [0, 0, 0, 0] }, 0, 4, 4);
    expect(ring.start).toBe(0);
    expect(ring.count).toBe(cap);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(false);
  });

  it('staging full rewrite under same layout fields detects non-mono via contentEpoch', async () => {
    const { createStagingRingView } = await import('../../../../data/cartesianData');
    const staging = new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]);
    const view = createStagingRingView(staging, 0, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(view as any)).toBe(true);
    // Rewrite floats in place; same start/count/capacity/xOffset; bump via createStagingRingView.
    staging[0] = 9;
    staging[2] = 1;
    staging[4] = 5;
    staging[6] = 0;
    createStagingRingView(staging, 0, 0, 4, 0, view);
    expect(isMonotonicNonDecreasingFiniteX(view as any)).toBe(false);
  });

  it('non-finite append tail makes mono false', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const ring = createRingXYColumns(8);
    appendIntoRingXY(ring, { x: [0, 1, 2], y: [0, 0, 0] }, 0, 3, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    appendIntoRingXY(ring, { x: [Number.NaN], y: [0] }, 0, 1, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(false);
  });

  it('equal consecutive x stays mono non-decreasing', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const ring = createRingXYColumns(8);
    appendIntoRingXY(ring, { x: [1, 1, 2, 2], y: [0, 1, 2, 3] }, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    appendIntoRingXY(ring, { x: [2], y: [4] }, 0, 1, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
  });

  it('mono recovers after false when full mono rewrite replaces content', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const ring = createRingXYColumns(4);
    appendIntoRingXY(ring, { x: [0, 1, 2, 3], y: [0, 0, 0, 0] }, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    appendIntoRingXY(ring, { x: [5, 1, 2, 3], y: [0, 0, 0, 0] }, 0, 4, 4);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(false);
    appendIntoRingXY(ring, { x: [10, 11, 12, 13], y: [0, 0, 0, 0] }, 0, 4, 4);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
  });

  it('capacity change forces re-eval (new ring)', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const ring = createRingXYColumns(4);
    appendIntoRingXY(ring, { x: [0, 1, 2, 3], y: [0, 0, 0, 0] }, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    const bigger = createRingXYColumns(8);
    appendIntoRingXY(bigger, { x: [0, 1, 2, 3, 4], y: [0, 0, 0, 0, 0] }, 0, 5, 0);
    expect(isMonotonicNonDecreasingFiniteX(bigger as any)).toBe(true);
  });

  it('staging multi-append mono stays true', async () => {
    const { createStagingRingView } = await import('../../../../data/cartesianData');
    const staging = new Float32Array(32);
    for (let i = 0; i < 4; i++) {
      staging[i * 2] = i;
      staging[i * 2 + 1] = 0;
    }
    const view = createStagingRingView(staging, 0, 0, 4, 0);
    expect(isMonotonicNonDecreasingFiniteX(view as any)).toBe(true);
    for (let n = 5; n <= 10; n++) {
      staging[(n - 1) * 2] = n - 1;
      staging[(n - 1) * 2 + 1] = 0;
      createStagingRingView(staging, 0, 0, n, 0, view);
      expect(isMonotonicNonDecreasingFiniteX(view as any)).toBe(true);
    }
  });

  it('large mono ring: many generation-stable checks stay correct and fast', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    // Behavioral perf guard: after one mono establish, repeated same-generation
    // checks must not re-walk multi-M points (would time out / be multi-ms).
    const n = 200_000;
    const ring = createRingXYColumns(n);
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = i;
      ys[i] = i * 0.01;
    }
    appendIntoRingXY(ring, { x: xs, y: ys }, 0, n, 0);
    expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      expect(isMonotonicNonDecreasingFiniteX(ring as any)).toBe(true);
    }
    const elapsed = performance.now() - t0;
    // 500 cached hits should be well under 50ms (full 200k×500 would be seconds).
    expect(elapsed).toBeLessThan(50);
  });
});

describe('sliceVisibleRangeByX ring / staging (live-streaming zoom)', () => {
  it('slices StagingRingView without calling data.slice', async () => {
    const { createStagingRingView } = await import('../../../../data/cartesianData');
    // Linear staging: points (0,0) (1,10) (2,20) (3,30) (4,40)
    const staging = new Float32Array([0, 0, 1, 10, 2, 20, 3, 30, 4, 40]);
    const view = createStagingRingView(staging, 0, 0, 5, 0);

    const result = sliceVisibleRangeByX(view as any, 1, 3) as DataPoint[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([1, 10]);
    expect(result[1]).toEqual([2, 20]);
    expect(result[2]).toEqual([3, 30]);
    // Full range returns original view identity
    expect(sliceVisibleRangeByX(view as any, -1, 100)).toBe(view);
  });

  it('slices modular StagingRingView in chronological order', async () => {
    const { createStagingRingView } = await import('../../../../data/cartesianData');
    // capacity 4, start 2: logical order phys 2,3,0,1 → x = 2,3,4,5 (domain + offset)
    // staging stores x - xOffset with xOffset=0: [4,y, 5,y, 2,y, 3,y]
    const staging = new Float32Array([4, 40, 5, 50, 2, 20, 3, 30]);
    const view = createStagingRingView(staging, 2, 4, 4, 0);

    const result = sliceVisibleRangeByX(view as any, 3, 5) as DataPoint[];
    expect(result.map((p) => (Array.isArray(p) ? p[0] : p.x))).toEqual([3, 4, 5]);
  });

  it('slices RingXYColumns with non-zero start without linear buffer slice', async () => {
    const { createRingXYColumns, appendIntoRingXY } = await import('../../../../data/cartesianData');
    const ring = createRingXYColumns(4);
    // Fill to capacity then append more to wrap
    appendIntoRingXY(ring, { x: [0, 1, 2, 3], y: [0, 10, 20, 30] }, 0, 4, 0);
    appendIntoRingXY(ring, { x: [4, 5], y: [40, 50] }, 0, 2, 0);
    // Logical: 2,3,4,5 after wrap (if maxPoints behavior) — check what append did
    expect(ring.count).toBeLessThanOrEqual(4);

    // Direct modular setup for clarity
    const ring2 = createRingXYColumns(4);
    ring2.x[0] = 10;
    ring2.y[0] = 100;
    ring2.x[1] = 11;
    ring2.y[1] = 110;
    ring2.x[2] = 8;
    ring2.y[2] = 80;
    ring2.x[3] = 9;
    ring2.y[3] = 90;
    ring2.start = 2;
    ring2.count = 4;
    // chronological: 8,9,10,11
    const result = sliceVisibleRangeByX(ring2 as any, 9, 11) as DataPoint[];
    expect(result.map((p) => (Array.isArray(p) ? p[0] : p.x))).toEqual([9, 10, 11]);
  });
});
