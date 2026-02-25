/**
 * Tests for extracted render coordinator utilities.
 * These tests verify that the extracted pure functions work correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  // Canvas utils
  getCanvasCssWidth,
  getCanvasCssHeight,
  getCanvasCssSizeFromDevicePixels,
  // Data point utils
  finiteOrNull,
  finiteOrUndefined,
  isTupleDataPoint,
  getPointXY,
  isTupleOHLCDataPoint,
  // Bounds computation
  computeRawBoundsFromData,
  extendBoundsWithDataPoints,
  normalizeDomain,
  // Axis utils
  clamp01,
  clampInt,
  lerp,
  rgba01ToCssRgba,
  // Time utils
  pad2,
  parseNumberOrPercent,
  computeMaxFractionDigitsFromStep,
  // Tick generation
  generateLinearTicks,
} from '../index';
import { computeAdaptiveTimeXAxisTicks } from '../timeAxisUtils';

describe('Data Point Utilities', () => {
  it('finiteOrNull returns number for finite values', () => {
    expect(finiteOrNull(42)).toBe(42);
    expect(finiteOrNull(0)).toBe(0);
    expect(finiteOrNull(-123.45)).toBe(-123.45);
  });

  it('finiteOrNull returns null for non-finite values', () => {
    expect(finiteOrNull(NaN)).toBe(null);
    expect(finiteOrNull(Infinity)).toBe(null);
    expect(finiteOrNull(-Infinity)).toBe(null);
    expect(finiteOrNull(null)).toBe(null);
    expect(finiteOrNull(undefined)).toBe(null);
  });

  it('finiteOrUndefined returns number for finite values', () => {
    expect(finiteOrUndefined(42)).toBe(42);
    expect(finiteOrUndefined(0)).toBe(0);
  });

  it('finiteOrUndefined returns undefined for non-finite values', () => {
    expect(finiteOrUndefined(NaN)).toBe(undefined);
    expect(finiteOrUndefined(Infinity)).toBe(undefined);
    expect(finiteOrUndefined(undefined)).toBe(undefined);
  });

  it('isTupleDataPoint correctly identifies tuple format', () => {
    expect(isTupleDataPoint([1, 2])).toBe(true);
    expect(isTupleDataPoint({ x: 1, y: 2 })).toBe(false);
  });

  it('getPointXY extracts coordinates from both formats', () => {
    expect(getPointXY([10, 20])).toEqual({ x: 10, y: 20 });
    expect(getPointXY({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it('isTupleOHLCDataPoint correctly identifies OHLC tuple format', () => {
    expect(isTupleOHLCDataPoint([1000, 100, 110, 90, 105])).toBe(true);
    expect(isTupleOHLCDataPoint({ timestamp: 1000, open: 100, high: 110, low: 90, close: 105 })).toBe(false);
  });
});

describe('Bounds Computation', () => {
  it('computeRawBoundsFromData computes correct bounds', () => {
    const data = [
      { x: 1, y: 10 },
      { x: 5, y: 20 },
      { x: 3, y: 15 },
    ];
    const bounds = computeRawBoundsFromData(data);
    expect(bounds).toEqual({ xMin: 1, xMax: 5, yMin: 10, yMax: 20 });
  });

  it('computeRawBoundsFromData handles tuple format', () => {
    const data = [[1, 10], [5, 20], [3, 15]] as const;
    const bounds = computeRawBoundsFromData(data as any);
    expect(bounds).toEqual({ xMin: 1, xMax: 5, yMin: 10, yMax: 20 });
  });

  it('computeRawBoundsFromData returns null for empty data', () => {
    expect(computeRawBoundsFromData([])).toBe(null);
  });

  it('computeRawBoundsFromData handles zero-span domains', () => {
    const data = [{ x: 5, y: 10 }, { x: 5, y: 10 }];
    const bounds = computeRawBoundsFromData(data);
    expect(bounds).toEqual({ xMin: 5, xMax: 6, yMin: 10, yMax: 11 });
  });

  it('extendBoundsWithDataPoints extends existing bounds', () => {
    const initial = { xMin: 1, xMax: 5, yMin: 10, yMax: 20 };
    const newPoints = [{ x: 0, y: 25 }, { x: 6, y: 5 }];
    const extended = extendBoundsWithDataPoints(initial, newPoints);
    expect(extended).toEqual({ xMin: 0, xMax: 6, yMin: 5, yMax: 25 });
  });

  it('normalizeDomain ensures min <= max', () => {
    expect(normalizeDomain(5, 10)).toEqual({ min: 5, max: 10 });
    expect(normalizeDomain(10, 5)).toEqual({ min: 5, max: 10 });
  });

  it('normalizeDomain handles zero-span domains', () => {
    expect(normalizeDomain(5, 5)).toEqual({ min: 5, max: 6 });
  });

  it('normalizeDomain handles non-finite values', () => {
    expect(normalizeDomain(NaN, 10)).toEqual({ min: 0, max: 1 });
    expect(normalizeDomain(5, Infinity)).toEqual({ min: 0, max: 1 });
  });
});

describe('Axis Utilities', () => {
  it('clamp01 clamps values to [0, 1]', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
  });

  it('clampInt clamps and converts to integer', () => {
    expect(clampInt(5.7, 0, 10)).toBe(5);
    expect(clampInt(-5, 0, 10)).toBe(0);
    expect(clampInt(15, 0, 10)).toBe(10);
  });

  it('lerp interpolates between values', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });

  it('rgba01ToCssRgba converts to CSS string', () => {
    expect(rgba01ToCssRgba([1, 0, 0, 1])).toBe('rgba(255,0,0,1)');
    expect(rgba01ToCssRgba([0, 0.5, 1, 0.5])).toBe('rgba(0,128,255,0.5)');
  });
});

describe('Time Axis Utilities', () => {
  it('pad2 pads single digits', () => {
    expect(pad2(5)).toBe('05');
    expect(pad2(12)).toBe('12');
    expect(pad2(0)).toBe('00');
  });

  it('parseNumberOrPercent parses numbers', () => {
    expect(parseNumberOrPercent(100, 1000)).toBe(100);
    expect(parseNumberOrPercent('150', 1000)).toBe(150);
  });

  it('parseNumberOrPercent parses percentages', () => {
    expect(parseNumberOrPercent('50%', 1000)).toBe(500);
    expect(parseNumberOrPercent('100%', 200)).toBe(200);
  });

  it('parseNumberOrPercent returns null for invalid input', () => {
    expect(parseNumberOrPercent('invalid', 100)).toBe(null);
    expect(parseNumberOrPercent('', 100)).toBe(null);
  });

  it('computeMaxFractionDigitsFromStep computes correct precision', () => {
    expect(computeMaxFractionDigitsFromStep(1)).toBe(0);
    expect(computeMaxFractionDigitsFromStep(0.1)).toBe(1);
    expect(computeMaxFractionDigitsFromStep(0.01)).toBe(2);
    expect(computeMaxFractionDigitsFromStep(2.5)).toBe(1);
  });

  it('generateLinearTicks generates evenly-spaced ticks', () => {
    const ticks = generateLinearTicks(0, 100, 5);
    expect(ticks).toHaveLength(5);
    expect(ticks[0]).toBe(0);
    expect(ticks[4]).toBe(100);
    expect(ticks[2]).toBe(50);
  });
});

describe('Canvas Utilities', () => {
  it('getCanvasCssWidth returns 0 for null canvas', () => {
    expect(getCanvasCssWidth(null)).toBe(0);
  });

  it('getCanvasCssHeight returns 0 for null canvas', () => {
    expect(getCanvasCssHeight(null)).toBe(0);
  });

  it('getCanvasCssSizeFromDevicePixels returns 0,0 for null canvas', () => {
    expect(getCanvasCssSizeFromDevicePixels(null)).toEqual({ width: 0, height: 0 });
  });

  it('getCanvasCssSizeFromDevicePixels computes correct size with DPR', () => {
    // Mock canvas with device pixel dimensions
    const mockCanvas = {
      width: 800,
      height: 600,
    } as HTMLCanvasElement;

    // With DPR of 2
    const size = getCanvasCssSizeFromDevicePixels(mockCanvas, 2);
    expect(size).toEqual({ width: 400, height: 300 });
  });
});

describe('computeAdaptiveTimeXAxisTicks with tickFormatter', () => {
  it('uses tickFormatter for label width measurement when provided', () => {
    const wideFormatter = (v: number) => `WIDE-LABEL-${v.toFixed(0)}`;

    const mockMeasureCtx = {
      font: '',
      measureText: (text: string) => ({
        width: text.length * 20,
      }),
    } as unknown as CanvasRenderingContext2D;

    const result = computeAdaptiveTimeXAxisTicks({
      axisMin: 0,
      axisMax: 86400000,
      xScale: {
        scale: (v: number) => -1 + (v / 86400000) * 2,
        invert: (c: number) => ((c + 1) / 2) * 86400000,
      } as any,
      plotClipLeft: -0.85,
      plotClipRight: 0.95,
      canvasCssWidth: 400,
      visibleRangeMs: 86400000,
      measureCtx: mockMeasureCtx,
      fontSize: 12,
      fontFamily: 'sans-serif',
      tickFormatter: wideFormatter,
    });

    expect(result.tickCount).toBeLessThan(9);
    expect(result.tickValues.length).toBe(result.tickCount);
  });

  it('falls back to formatTimeTickValue when tickFormatter is not provided', () => {
    const mockMeasureCtx = {
      font: '',
      measureText: () => ({ width: 40 }),
    } as unknown as CanvasRenderingContext2D;

    const result = computeAdaptiveTimeXAxisTicks({
      axisMin: 0,
      axisMax: 86400000,
      xScale: {
        scale: (v: number) => -1 + (v / 86400000) * 2,
        invert: (c: number) => ((c + 1) / 2) * 86400000,
      } as any,
      plotClipLeft: -0.85,
      plotClipRight: 0.95,
      canvasCssWidth: 800,
      visibleRangeMs: 86400000,
      measureCtx: mockMeasureCtx,
      fontSize: 12,
      fontFamily: 'sans-serif',
    });

    expect(result.tickCount).toBeGreaterThanOrEqual(1);
    expect(result.tickValues.length).toBe(result.tickCount);
  });
});
