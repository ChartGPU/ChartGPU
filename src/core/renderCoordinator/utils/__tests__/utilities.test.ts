/**
 * Tests for extracted render coordinator utilities.
 * These tests verify that the extracted pure functions work correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  getCanvasCssWidth,
  getCanvasCssHeight,
  getCanvasCssSizeFromDevicePixels,
  getCanvasLayoutSizeCss,
  pointerClientToLayoutCss,
  clampInt,
} from '../canvasUtils';
import { finiteOrNull, finiteOrUndefined, isTupleDataPoint, getPointXY, isTupleOHLCDataPoint } from '../dataPointUtils';
import { normalizeDomain } from '../boundsComputation';
import { clamp01 } from '../axisUtils';
import {
  generateLinearTicks,
  resolvePieCenterPlotCss,
  resolvePieRadiiCss,
  computeAdaptiveTimeXAxisTicks,
} from '../timeAxisUtils';

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
    expect(
      isTupleOHLCDataPoint({
        timestamp: 1000,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
      })
    ).toBe(false);
  });
});

describe('Bounds Computation', () => {
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
});

describe('Time Axis Utilities', () => {
  it('resolvePieCenterPlotCss resolves percent centers', () => {
    const c = resolvePieCenterPlotCss({ x: '50%', y: '50%' }, 200, 100);
    expect(c).toEqual({ x: 100, y: 50 });
  });

  it('resolvePieRadiiCss resolves outer radius from percent', () => {
    const r = resolvePieRadiiCss('50%', 100);
    expect(r.outer).toBe(50);
    expect(r.inner).toBe(0);
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
    expect(getCanvasCssSizeFromDevicePixels(null)).toEqual({
      width: 0,
      height: 0,
    });
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

  it('pointerClientToLayoutCss maps visual offset into layout space under CSS zoom', () => {
    // Layout 1000×500; visual rect 300×150 (CSS zoom 0.3)
    const mockCanvas = {
      clientWidth: 1000,
      clientHeight: 500,
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: 300,
        height: 150,
        right: 310,
        bottom: 170,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }),
    } as HTMLCanvasElement;

    // Pointer at visual center of canvas (10+150, 20+75)
    const mapped = pointerClientToLayoutCss(mockCanvas, 160, 95);
    expect(mapped).not.toBeNull();
    expect(mapped!.layoutWidth).toBe(1000);
    expect(mapped!.layoutHeight).toBe(500);
    // (150 visual-x) * (1000/300) = 500 layout-x
    expect(mapped!.x).toBeCloseTo(500);
    expect(mapped!.y).toBeCloseTo(250);
  });

  it('pointerClientToLayoutCss returns null when visual rect is empty', () => {
    const mockCanvas = {
      clientWidth: 100,
      clientHeight: 100,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    } as HTMLCanvasElement;
    expect(pointerClientToLayoutCss(mockCanvas, 10, 10)).toBeNull();
  });

  it('pointerClientToLayoutCss falls back to visual when layout client size is 0', () => {
    // Pre-layout / display:none: intentional fallback so callers still get finite coords.
    const mockCanvas = {
      clientWidth: 0,
      clientHeight: 0,
      getBoundingClientRect: () => ({
        left: 5,
        top: 10,
        width: 200,
        height: 100,
        right: 205,
        bottom: 110,
        x: 5,
        y: 10,
        toJSON: () => ({}),
      }),
    } as HTMLCanvasElement;

    const mapped = pointerClientToLayoutCss(mockCanvas, 55, 40);
    expect(mapped).not.toBeNull();
    expect(mapped!.layoutWidth).toBe(200);
    expect(mapped!.layoutHeight).toBe(100);
    expect(mapped!.x).toBeCloseTo(50); // 55 - 5
    expect(mapped!.y).toBeCloseTo(30); // 40 - 10
  });

  describe('getCanvasLayoutSizeCss', () => {
    it('prefers clientWidth/Height over visual getBoundingClientRect', () => {
      const mockCanvas = {
        clientWidth: 1000,
        clientHeight: 500,
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 300, // CSS zoom visual — must not win
          height: 150,
          right: 300,
          bottom: 150,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      } as HTMLCanvasElement;

      expect(getCanvasLayoutSizeCss(mockCanvas)).toEqual({ width: 1000, height: 500 });
    });

    it('falls back to visual rect when client size is 0', () => {
      const mockCanvas = {
        clientWidth: 0,
        clientHeight: 0,
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 200,
          height: 100,
          right: 200,
          bottom: 100,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      } as HTMLCanvasElement;

      expect(getCanvasLayoutSizeCss(mockCanvas)).toEqual({ width: 200, height: 100 });
    });
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
