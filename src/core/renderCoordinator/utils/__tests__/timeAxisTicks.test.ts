/**
 * Unit tests for nice time-axis tick generation (#161).
 *
 * `generateTimeTicks` / `chooseTimeTickStepMs` are module-private (module honesty);
 * behavior is exercised through `computeAdaptiveTimeXAxisTicks` (production entry)
 * and `generateLinearTicks` (unchanged value-axis path).
 */

import { describe, it, expect } from 'vitest';
import { generateLinearTicks, computeAdaptiveTimeXAxisTicks, formatTimeTickValue } from '../timeAxisUtils';

const makeLinearScale = (min: number, max: number) =>
  ({
    scale: (v: number) => -1 + ((v - min) / (max - min || 1)) * 2,
    invert: (c: number) => min + ((c + 1) / 2) * (max - min || 1),
  }) as any;

const mockMeasureCtx = (labelWidth = 40) =>
  ({
    font: '',
    measureText: () => ({ width: labelWidth }),
  }) as unknown as CanvasRenderingContext2D;

const mockMeasureCtxByLength = (k: number) =>
  ({
    font: '',
    measureText: (text: string) => ({ width: text.length * k }),
  }) as unknown as CanvasRenderingContext2D;

const computeTicks = (
  start: number,
  end: number,
  opts?: {
    measureCtx?: CanvasRenderingContext2D | null;
    canvasCssWidth?: number;
    labelWidth?: number;
    axisMin?: number | null;
    axisMax?: number | null;
  }
) =>
  computeAdaptiveTimeXAxisTicks({
    axisMin: opts?.axisMin !== undefined ? opts.axisMin : start,
    axisMax: opts?.axisMax !== undefined ? opts.axisMax : end,
    xScale: makeLinearScale(start, end),
    plotClipLeft: -1,
    plotClipRight: 1,
    canvasCssWidth: opts?.canvasCssWidth ?? 800,
    visibleRangeMs: Math.abs(end - start),
    measureCtx: opts?.measureCtx === undefined ? mockMeasureCtx(opts?.labelWidth ?? 40) : opts.measureCtx,
    fontSize: 12,
    fontFamily: 'sans-serif',
  });

describe('generateLinearTicks (value axes unchanged)', () => {
  it('still generates evenly-spaced linear ticks', () => {
    const linear = generateLinearTicks(0, 100, 5);
    expect(linear).toEqual([0, 25, 50, 75, 100]);
  });
});

describe('computeAdaptiveTimeXAxisTicks nice time steps', () => {
  it('returns tickValues length matching tickCount and values in domain', () => {
    const start = Date.UTC(2026, 4, 13, 4, 42, 0);
    const end = start + 24 * 3_600_000;
    const result = computeTicks(start, end);

    expect(result.tickCount).toBe(result.tickValues.length);
    expect(result.tickCount).toBeGreaterThanOrEqual(1);
    for (const t of result.tickValues) {
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThanOrEqual(end);
    }
  });

  it('produces nice hour-aligned ticks for a ~24h domain (issue #161 full range)', () => {
    const start = Date.UTC(2026, 4, 13, 4, 42, 0);
    const end = start + 23.933 * 3_600_000;
    const { tickValues: ticks } = computeTicks(start, end);

    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeLessThanOrEqual(9);

    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThanOrEqual(end);
    }

    const step = ticks[1]! - ticks[0]!;
    expect(step).toBeGreaterThan(0);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBe(step);
    }
    for (const t of ticks) {
      expect(t % step).toBe(0);
    }

    for (const t of ticks) {
      expect(new Date(t).getUTCMinutes()).toBe(0);
      expect(new Date(t).getUTCSeconds()).toBe(0);
    }
    expect([7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000]).toContain(step);
  });

  it('uses a fine step (≤30s) for a ~4 minute deep-zoom domain', () => {
    const t0 = Date.UTC(2026, 4, 13, 11, 49, 0);
    const end = t0 + 4 * 60_000;
    const { tickValues: ticks } = computeTicks(t0, end, { labelWidth: 20 });

    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeLessThanOrEqual(9);

    const step = ticks[1]! - ticks[0]!;
    expect(step).toBeLessThanOrEqual(30_000);
    expect(step).toBeGreaterThan(0);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBe(step);
    }
  });

  it('falls back to nice ticks when measureCtx is null', () => {
    const start = 0;
    const end = 3_600_000;
    const result = computeTicks(start, end, { measureCtx: null });

    expect(result.tickValues.length).toBe(result.tickCount);
    expect(result.tickCount).toBeGreaterThanOrEqual(1);
    if (result.tickValues.length >= 2) {
      const step = result.tickValues[1]! - result.tickValues[0]!;
      expect(result.tickValues[0]! % step).toBe(0);
    }
  });

  it('does not exceed 9 ticks on dense ms-scale ranges', () => {
    const start = Date.UTC(2026, 0, 1);
    const end = start + 1000;
    const { tickValues } = computeTicks(start, end, { labelWidth: 4 });
    expect(tickValues.length).toBeLessThanOrEqual(9);
  });

  it('thins multi-year domains to ≤9 ticks that span the domain', () => {
    const start = Date.UTC(2020, 0, 1);
    const end = Date.UTC(2026, 0, 1);
    const span = end - start;
    const { tickValues } = computeTicks(start, end, { measureCtx: null });
    expect(tickValues.length).toBeGreaterThanOrEqual(2);
    expect(tickValues.length).toBeLessThanOrEqual(9);
    for (const t of tickValues) {
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThanOrEqual(end);
    }
    // Must span the window — not cluster in the first quarter (prefix-thin bug).
    const first = tickValues[0]!;
    const last = tickValues[tickValues.length - 1]!;
    expect((last - first) / span).toBeGreaterThan(0.5);
    expect(first).toBeLessThan(start + 0.25 * span);
    expect(last).toBeGreaterThan(start + 0.75 * span);
    // No tick may sit only in the first quarter if we have multiple marks.
    const allInFirstQuarter = tickValues.every((t) => t < start + 0.25 * span);
    expect(allInFirstQuarter).toBe(false);
  });

  it('spans multi-decade domains without prefix clustering', () => {
    // Larger than the last ladder rung (≈1y) so last-step stride sampling must run.
    const start = Date.UTC(2000, 0, 1);
    const end = Date.UTC(2040, 0, 1);
    const span = end - start;
    const { tickValues } = computeTicks(start, end, { measureCtx: null });
    expect(tickValues.length).toBeGreaterThanOrEqual(2);
    expect(tickValues.length).toBeLessThanOrEqual(9);
    const first = tickValues[0]!;
    const last = tickValues[tickValues.length - 1]!;
    expect((last - first) / span).toBeGreaterThan(0.5);
    expect(last).toBeGreaterThan(start + 0.75 * span);
  });

  it('handles inverted domain via scale invert / axis min-max swap in ticks', () => {
    // axisMin > axisMax should still produce ascending nice ticks within the span.
    const lo = Date.UTC(2026, 4, 13, 0, 0, 0);
    const hi = lo + 6 * 3_600_000;
    const result = computeAdaptiveTimeXAxisTicks({
      axisMin: hi,
      axisMax: lo,
      xScale: makeLinearScale(lo, hi),
      plotClipLeft: -1,
      plotClipRight: 1,
      canvasCssWidth: 800,
      visibleRangeMs: hi - lo,
      measureCtx: null,
      fontSize: 12,
      fontFamily: 'sans-serif',
    });
    expect(result.tickCount).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < result.tickValues.length; i++) {
      expect(result.tickValues[i]!).toBeGreaterThanOrEqual(result.tickValues[i - 1]!);
    }
  });

  it('handles non-finite axis bounds by falling back to scale invert domain', () => {
    const start = 0;
    const end = 3_600_000;
    const result = computeTicks(start, end, {
      measureCtx: null,
      axisMin: null,
      axisMax: null,
    });
    // null axis bounds → invert plot clip (our scale maps -1..1 → start..end)
    expect(result.tickValues.length).toBeGreaterThanOrEqual(1);
    for (const t of result.tickValues) {
      expect(Number.isFinite(t)).toBe(true);
    }
  });

  it('zero-span domain yields a single finite tick', () => {
    const t = Date.UTC(2026, 4, 13, 12, 0, 0);
    const result = computeTicks(t, t);
    expect(result.tickCount).toBeGreaterThanOrEqual(1);
    expect(result.tickValues.length).toBe(result.tickCount);
    expect(result.tickValues.every((v) => v === t)).toBe(true);
  });

  it('tiny range still returns ticks within endpoints (range ≪ step fallback)', () => {
    // 3 ms span — may collapse to endpoints or a 1ms step tick
    const start = 1_700_000_000_000;
    const end = start + 3;
    const result = computeTicks(start, end, { measureCtx: null });
    expect(result.tickValues.length).toBeGreaterThanOrEqual(1);
    for (const t of result.tickValues) {
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThanOrEqual(end);
    }
  });

  it('deep-zoom labels include unique seconds under 2 minutes', () => {
    const t0 = Date.UTC(2026, 4, 13, 11, 49, 0);
    const end = t0 + 90_000;
    const { tickValues } = computeTicks(t0, end, { labelWidth: 50 });
    const labels = tickValues.map((v) => formatTimeTickValue(v, end - t0)).filter((l): l is string => l != null);

    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const label of labels) {
      expect(label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
    expect(new Set(labels).size).toBeGreaterThan(1);
  });

  it('4-minute domain dense ticks format to unique HH:mm:ss (issue #161 failure mode)', () => {
    const t0 = Date.UTC(2026, 4, 13, 11, 49, 0);
    const end = t0 + 4 * 60_000;
    const { tickValues } = computeTicks(t0, end, { labelWidth: 20 });
    const range = end - t0;
    const labels = tickValues.map((v) => formatTimeTickValue(v, range)).filter((l): l is string => l != null);

    expect(tickValues.length).toBeGreaterThanOrEqual(2);
    for (const label of labels) {
      expect(label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
    // Adjacent uniqueness: no two consecutive identical strings.
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i]).not.toBe(labels[i - 1]);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('wider HH:mm:ss labels thin adaptive density vs HH:mm on a narrow canvas', () => {
    // ~90s → seconds labels; ~10min → HH:mm. Length-based measure on 400px canvas.
    const t0 = Date.UTC(2026, 4, 13, 11, 0, 0);
    const shortEnd = t0 + 90_000;
    const longEnd = t0 + 10 * 60_000;
    const measureCtx = mockMeasureCtxByLength(12);

    const shortResult = computeAdaptiveTimeXAxisTicks({
      axisMin: t0,
      axisMax: shortEnd,
      xScale: makeLinearScale(t0, shortEnd),
      plotClipLeft: -1,
      plotClipRight: 1,
      canvasCssWidth: 400,
      visibleRangeMs: shortEnd - t0,
      measureCtx,
      fontSize: 12,
      fontFamily: 'sans-serif',
    });

    const longResult = computeAdaptiveTimeXAxisTicks({
      axisMin: t0,
      axisMax: longEnd,
      xScale: makeLinearScale(t0, longEnd),
      plotClipLeft: -1,
      plotClipRight: 1,
      canvasCssWidth: 400,
      visibleRangeMs: longEnd - t0,
      measureCtx,
      fontSize: 12,
      fontFamily: 'sans-serif',
    });

    // Seconds labels are wider ("11:00:00" vs "11:00") so short-window density should not
    // exceed long-window density on the same canvas (and often is strictly thinner).
    expect(shortResult.tickCount).toBeLessThanOrEqual(longResult.tickCount);
    // Sanity: both paths produced valid ticks.
    expect(shortResult.tickCount).toBeGreaterThanOrEqual(1);
    expect(longResult.tickCount).toBeGreaterThanOrEqual(1);

    // Confirm format tiers used in the comparison.
    const shortLabel = formatTimeTickValue(t0, shortEnd - t0)!;
    const longLabel = formatTimeTickValue(t0, longEnd - t0)!;
    expect(shortLabel.split(':').length).toBe(3);
    expect(longLabel.split(':').length).toBe(2);
    expect(shortLabel.length).toBeGreaterThan(longLabel.length);
  });
});
