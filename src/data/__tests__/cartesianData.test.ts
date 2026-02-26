/**
 * Tests for cartesianData helpers - guards against undefined/null entries.
 */

import { describe, it, expect } from 'vitest';
import { getX, getY, getSize, computeRawBoundsFromCartesianData, packXYInto } from '../cartesianData';
import type { DataPoint } from '../../config/types';

describe('cartesianData - sparse array handling', () => {
  describe('getX', () => {
    it('returns NaN for undefined DataPoint entries', () => {
      const sparseData: DataPoint[] = [
        { x: 1, y: 2 },
        undefined as any,
        { x: 3, y: 4 },
      ];
      
      expect(getX(sparseData, 0)).toBe(1);
      expect(Number.isNaN(getX(sparseData, 1))).toBe(true);
      expect(getX(sparseData, 2)).toBe(3);
    });

    it('returns NaN for null DataPoint entries', () => {
      const invalidData: any = [
        { x: 1, y: 2 },
        null,
        { x: 3, y: 4 },
      ];
      
      expect(getX(invalidData, 0)).toBe(1);
      expect(Number.isNaN(getX(invalidData, 1))).toBe(true);
      expect(getX(invalidData, 2)).toBe(3);
    });

    it('handles tuple format with undefined entries', () => {
      const sparseData: DataPoint[] = [
        [1, 2],
        undefined as any,
        [3, 4],
      ];
      
      expect(getX(sparseData, 0)).toBe(1);
      expect(Number.isNaN(getX(sparseData, 1))).toBe(true);
      expect(getX(sparseData, 2)).toBe(3);
    });
  });

  describe('getY', () => {
    it('returns NaN for undefined DataPoint entries', () => {
      const sparseData: DataPoint[] = [
        { x: 1, y: 2 },
        undefined as any,
        { x: 3, y: 4 },
      ];
      
      expect(getY(sparseData, 0)).toBe(2);
      expect(Number.isNaN(getY(sparseData, 1))).toBe(true);
      expect(getY(sparseData, 2)).toBe(4);
    });

    it('returns NaN for null DataPoint entries', () => {
      const invalidData: any = [
        { x: 1, y: 2 },
        null,
        { x: 3, y: 4 },
      ];
      
      expect(getY(invalidData, 0)).toBe(2);
      expect(Number.isNaN(getY(invalidData, 1))).toBe(true);
      expect(getY(invalidData, 2)).toBe(4);
    });

    it('handles tuple format with undefined entries', () => {
      const sparseData: DataPoint[] = [
        [1, 2],
        undefined as any,
        [3, 4],
      ];
      
      expect(getY(sparseData, 0)).toBe(2);
      expect(Number.isNaN(getY(sparseData, 1))).toBe(true);
      expect(getY(sparseData, 2)).toBe(4);
    });
  });

  describe('getSize', () => {
    it('returns undefined for undefined DataPoint entries', () => {
      const sparseData: DataPoint[] = [
        { x: 1, y: 2, size: 10 },
        undefined as any,
        { x: 3, y: 4, size: 20 },
      ];
      
      expect(getSize(sparseData, 0)).toBe(10);
      expect(getSize(sparseData, 1)).toBeUndefined();
      expect(getSize(sparseData, 2)).toBe(20);
    });

    it('returns undefined for null DataPoint entries', () => {
      const invalidData: any = [
        { x: 1, y: 2, size: 10 },
        null,
        { x: 3, y: 4, size: 20 },
      ];
      
      expect(getSize(invalidData, 0)).toBe(10);
      expect(getSize(invalidData, 1)).toBeUndefined();
      expect(getSize(invalidData, 2)).toBe(20);
    });

    it('handles tuple format with undefined entries', () => {
      const sparseData: DataPoint[] = [
        [1, 2, 10],
        undefined as any,
        [3, 4, 20],
      ];
      
      expect(getSize(sparseData, 0)).toBe(10);
      expect(getSize(sparseData, 1)).toBeUndefined();
      expect(getSize(sparseData, 2)).toBe(20);
    });
  });

  describe('computeRawBoundsFromCartesianData', () => {
    it('skips undefined and null DataPoint entries when computing bounds', () => {
      const sparseData: DataPoint[] = [
        { x: 1, y: 2 },
        undefined as any,
        { x: 3, y: 4 },
        null as any,
        { x: 5, y: 6 },
      ];

      const bounds = computeRawBoundsFromCartesianData(sparseData);

      expect(bounds).not.toBeNull();
      expect(bounds?.xMin).toBe(1);
      expect(bounds?.xMax).toBe(5);
      expect(bounds?.yMin).toBe(2);
      expect(bounds?.yMax).toBe(6);
    });
  });
});

describe('packXYInto - null gap handling', () => {
  it('writes NaN for null entries in DataPoint array', () => {
    const data: (DataPoint | null)[] = [[0, 1], null, [2, 3]];
    const out = new Float32Array(6);
    packXYInto(out, 0, data as any, 0, 3, 0);

    expect(out[0]).toBe(0); // x0
    expect(out[1]).toBe(1); // y0
    expect(Number.isNaN(out[2])).toBe(true); // x1 (null -> NaN)
    expect(Number.isNaN(out[3])).toBe(true); // y1 (null -> NaN)
    expect(out[4]).toBe(2); // x2
    expect(out[5]).toBe(3); // y2
  });

  it('handles consecutive null entries', () => {
    const data: (DataPoint | null)[] = [[0, 1], null, null, [3, 4]];
    const out = new Float32Array(8);
    packXYInto(out, 0, data as any, 0, 4, 0);

    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(Number.isNaN(out[2])).toBe(true);
    expect(Number.isNaN(out[3])).toBe(true);
    expect(Number.isNaN(out[4])).toBe(true);
    expect(Number.isNaN(out[5])).toBe(true);
    expect(out[6]).toBe(3);
    expect(out[7]).toBe(4);
  });

  it('writes NaN for undefined entries in DataPoint array', () => {
    const data: DataPoint[] = [[0, 1], undefined as any, [2, 3]];
    const out = new Float32Array(6);
    packXYInto(out, 0, data as any, 0, 3, 0);

    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(Number.isNaN(out[2])).toBe(true);
    expect(Number.isNaN(out[3])).toBe(true);
    expect(out[4]).toBe(2);
    expect(out[5]).toBe(3);
  });

  it('applies xOffset correctly alongside null entries', () => {
    const data: (DataPoint | null)[] = [[10, 1], null, [20, 3]];
    const out = new Float32Array(6);
    packXYInto(out, 0, data as any, 0, 3, 10);

    expect(out[0]).toBe(0); // 10 - 10
    expect(out[1]).toBe(1);
    expect(Number.isNaN(out[2])).toBe(true); // null -> NaN (xOffset not applied)
    expect(Number.isNaN(out[3])).toBe(true);
    expect(out[4]).toBe(10); // 20 - 10
    expect(out[5]).toBe(3);
  });
});
