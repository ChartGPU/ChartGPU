/**
 * Tests for tooltip and legend helper utilities.
 * Verifies caching logic, anchor positioning, and type guards.
 */

import { describe, it, expect } from 'vitest';
import {
  createTooltipCache,
  shouldUpdateTooltip,
  updateTooltipCache,
  clearTooltipCache,
  computeCandlestickTooltipAnchorFromMatch,
  isOHLCDataPoint,
} from '../tooltipLegendHelpers';
import { createLinearScale } from '../../../../utils/scales';

describe('createTooltipCache', () => {
  it('creates cache with null values', () => {
    const cache = createTooltipCache();

    expect(cache.content).toBe(null);
    expect(cache.x).toBe(null);
    expect(cache.y).toBe(null);
  });
});

describe('shouldUpdateTooltip', () => {
  it('returns true when content changes', () => {
    const cache = createTooltipCache();
    cache.content = 'Old content';
    cache.x = 100;
    cache.y = 200;

    const result = shouldUpdateTooltip(cache, 'New content', 100, 200);

    expect(result).toBe(true);
  });

  it('returns true when X position changes', () => {
    const cache = createTooltipCache();
    cache.content = 'Content';
    cache.x = 100;
    cache.y = 200;

    const result = shouldUpdateTooltip(cache, 'Content', 150, 200);

    expect(result).toBe(true);
  });

  it('returns true when Y position changes', () => {
    const cache = createTooltipCache();
    cache.content = 'Content';
    cache.x = 100;
    cache.y = 200;

    const result = shouldUpdateTooltip(cache, 'Content', 100, 250);

    expect(result).toBe(true);
  });

  it('returns false when nothing changes', () => {
    const cache = createTooltipCache();
    cache.content = 'Content';
    cache.x = 100;
    cache.y = 200;

    const result = shouldUpdateTooltip(cache, 'Content', 100, 200);

    expect(result).toBe(false);
  });

  it('returns true when cache is empty', () => {
    const cache = createTooltipCache();

    const result = shouldUpdateTooltip(cache, 'Content', 100, 200);

    expect(result).toBe(true);
  });

  it('returns true when multiple values change', () => {
    const cache = createTooltipCache();
    cache.content = 'Old';
    cache.x = 100;
    cache.y = 200;

    const result = shouldUpdateTooltip(cache, 'New', 150, 250);

    expect(result).toBe(true);
  });
});

describe('updateTooltipCache', () => {
  it('updates all cache values', () => {
    const cache = createTooltipCache();

    updateTooltipCache(cache, 'New content', 150, 250);

    expect(cache.content).toBe('New content');
    expect(cache.x).toBe(150);
    expect(cache.y).toBe(250);
  });

  it('overwrites previous values', () => {
    const cache = createTooltipCache();
    cache.content = 'Old';
    cache.x = 100;
    cache.y = 200;

    updateTooltipCache(cache, 'New', 150, 250);

    expect(cache.content).toBe('New');
    expect(cache.x).toBe(150);
    expect(cache.y).toBe(250);
  });
});

describe('clearTooltipCache', () => {
  it('clears all cache values to null', () => {
    const cache = createTooltipCache();
    cache.content = 'Content';
    cache.x = 100;
    cache.y = 200;

    clearTooltipCache(cache);

    expect(cache.content).toBe(null);
    expect(cache.x).toBe(null);
    expect(cache.y).toBe(null);
  });

  it('is idempotent', () => {
    const cache = createTooltipCache();
    cache.content = 'Content';

    clearTooltipCache(cache);
    clearTooltipCache(cache);

    expect(cache.content).toBe(null);
    expect(cache.x).toBe(null);
    expect(cache.y).toBe(null);
  });
});

describe('computeCandlestickTooltipAnchorFromMatch', () => {
  // Production path: scales map domain → grid-local CSS pixels (not clip space).
  const xScale = createLinearScale().domain(0, 100).range(0, 400);
  const yScale = createLinearScale().domain(0, 100).range(300, 0);
  const yScales = new Map([['default', yScale]]);
  const gridArea = {
    left: 40,
    top: 20,
    width: 400,
    height: 300,
    right: 440,
    bottom: 320,
    canvasWidth: 480,
    canvasHeight: 360,
    devicePixelRatio: 1,
  };
  const canvas = { offsetLeft: 10, offsetTop: 5 } as HTMLCanvasElement;

  it('computes anchor for tuple OHLC data point', () => {
    const point: [number, number, number, number, number] = [50, 80, 90, 70, 95];
    const anchor = computeCandlestickTooltipAnchorFromMatch({ point }, xScale, yScales, gridArea as any, canvas);

    expect(anchor).not.toBe(null);
    expect(anchor!.x).toBeGreaterThan(0);
    expect(anchor!.y).toBeGreaterThan(0);
  });

  it('computes anchor at body center with grid + canvas offsets', () => {
    const point: [number, number, number, number, number] = [50, 80, 90, 70, 95];
    // body mid Y = 85 → yScale(85) ≈ 45; x = 50 → 200
    const anchor = computeCandlestickTooltipAnchorFromMatch({ point }, xScale, yScales, gridArea as any, canvas);

    expect(anchor).not.toBe(null);
    expect(anchor!.x).toBeCloseTo(10 + 40 + 200, 0);
    expect(anchor!.y).toBeCloseTo(5 + 20 + 45, 0);
  });

  it('computes anchor for object OHLC data point', () => {
    const point = { timestamp: 50, open: 80, close: 90, low: 70, high: 95 };
    const anchor = computeCandlestickTooltipAnchorFromMatch({ point }, xScale, yScales, gridArea as any, canvas);

    expect(anchor).not.toBe(null);
    expect(anchor!.x).toBeGreaterThan(0);
    expect(anchor!.y).toBeGreaterThan(0);
  });

  it('returns null for non-finite timestamp', () => {
    const point: [number, number, number, number, number] = [NaN, 80, 90, 70, 95];
    const anchor = computeCandlestickTooltipAnchorFromMatch({ point }, xScale, yScales, gridArea as any, canvas);
    expect(anchor).toBe(null);
  });

  it('returns null for non-finite open', () => {
    const point: [number, number, number, number, number] = [50, NaN, 90, 70, 95];
    const anchor = computeCandlestickTooltipAnchorFromMatch({ point }, xScale, yScales, gridArea as any, canvas);
    expect(anchor).toBe(null);
  });

  it('returns null for non-finite close', () => {
    const point: [number, number, number, number, number] = [50, 80, Infinity, 70, 95];
    const anchor = computeCandlestickTooltipAnchorFromMatch({ point }, xScale, yScales, gridArea as any, canvas);
    expect(anchor).toBe(null);
  });

  it('anchors on price yAxis when vol scale is first in the map (dual-Y)', () => {
    // Volume first — bar renderer contract. Price values must not use this scale.
    const volScale = createLinearScale().domain(0, 100_000).range(300, 0);
    const priceScale = createLinearScale().domain(70, 110).range(300, 0);
    const dualY = new Map([
      ['vol', volScale],
      ['price', priceScale],
    ]);
    const point: [number, number, number, number, number] = [50, 80, 90, 70, 95];
    // body mid = 85 → priceScale maps near mid of 70–110 range
    const anchor = computeCandlestickTooltipAnchorFromMatch(
      { point, yAxisId: 'price' },
      xScale,
      dualY,
      gridArea as any,
      canvas
    );
    expect(anchor).not.toBe(null);
    // priceScale: domain 70→110, range 300→0; 85 is (85-70)/(110-70)=0.375 → y=300*0.625=187.5
    const expectedY = 5 + 20 + priceScale.scale(85);
    expect(anchor!.y).toBeCloseTo(expectedY, 0);
    // Must not be near the floor (vol-scale would map 85 ~ 300)
    expect(anchor!.y).toBeLessThan(5 + 20 + 280);
  });

  it('prefers price scale over first map entry when yAxisId omitted', () => {
    const volScale = createLinearScale().domain(0, 100_000).range(300, 0);
    const priceScale = createLinearScale().domain(70, 110).range(300, 0);
    const dualY = new Map([
      ['vol', volScale],
      ['price', priceScale],
    ]);
    const point: [number, number, number, number, number] = [50, 80, 90, 70, 95];
    const anchor = computeCandlestickTooltipAnchorFromMatch({ point }, xScale, dualY, gridArea as any, canvas);
    expect(anchor).not.toBe(null);
    expect(anchor!.y).toBeCloseTo(5 + 20 + priceScale.scale(85), 0);
  });
});

describe('isOHLCDataPoint', () => {
  it('returns true for 5-element tuple', () => {
    const point: [number, number, number, number, number] = [1, 2, 3, 4, 5];
    expect(isOHLCDataPoint(point)).toBe(true);
  });

  it('returns false for 2-element tuple', () => {
    const point = [1, 2];
    expect(isOHLCDataPoint(point)).toBe(false);
  });

  it('returns false for 4-element tuple', () => {
    const point = [1, 2, 3, 4];
    expect(isOHLCDataPoint(point)).toBe(false);
  });

  it('returns true for object with OHLC properties', () => {
    const point = { timestamp: 1, open: 2, close: 3, low: 4, high: 5 };
    expect(isOHLCDataPoint(point)).toBe(true);
  });

  it('returns false for object missing OHLC properties', () => {
    const point = { x: 1, y: 2 };
    expect(isOHLCDataPoint(point)).toBe(false);
  });

  it('returns false for object with partial OHLC properties', () => {
    const point = { x: 1, open: 2, close: 3 };
    expect(isOHLCDataPoint(point)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isOHLCDataPoint(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isOHLCDataPoint(undefined)).toBe(false);
  });

  it('returns false for number', () => {
    expect(isOHLCDataPoint(123)).toBe(false);
  });

  it('returns false for string', () => {
    expect(isOHLCDataPoint('data')).toBe(false);
  });
});

describe('integration: tooltip cache workflow', () => {
  it('supports typical show/hide/update cycle', () => {
    const cache = createTooltipCache();

    // Initial show
    expect(shouldUpdateTooltip(cache, 'Content 1', 100, 200)).toBe(true);
    updateTooltipCache(cache, 'Content 1', 100, 200);

    // No change
    expect(shouldUpdateTooltip(cache, 'Content 1', 100, 200)).toBe(false);

    // Position change
    expect(shouldUpdateTooltip(cache, 'Content 1', 150, 200)).toBe(true);
    updateTooltipCache(cache, 'Content 1', 150, 200);

    // Hide
    clearTooltipCache(cache);

    // Show again
    expect(shouldUpdateTooltip(cache, 'Content 2', 100, 200)).toBe(true);
    updateTooltipCache(cache, 'Content 2', 100, 200);
  });

  it('prevents unnecessary DOM updates', () => {
    const cache = createTooltipCache();
    updateTooltipCache(cache, 'Same content', 100, 200);

    // Simulate repeated render with same state
    for (let i = 0; i < 10; i++) {
      expect(shouldUpdateTooltip(cache, 'Same content', 100, 200)).toBe(false);
    }
  });
});
