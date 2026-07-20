/**
 * Tests for animation helper utilities.
 * Verifies animation config resolution, easing, interpolation, and state transitions.
 */

import { describe, it, expect } from 'vitest';
import {
  clamp01,
  resolveAnimationConfig,
  createEasingWithDelay,
  hasAnyDrawableMarks,
  isSnapOnlyUpdateAnimationSeries,
  lerpDomain,
  lerpLogDomain,
  interpolateCartesianData,
  interpolatePieData,
  isDomainEqual,
  computeNextIntroPhase,
  applyBarIntroProgress,
} from '../animationHelpers';

describe('clamp01', () => {
  it('clamps value to [0, 1]', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps values below 0', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(-100)).toBe(0);
  });

  it('clamps values above 1', () => {
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(100)).toBe(1);
  });
});

describe('resolveAnimationConfig', () => {
  const linearEasing = (t: number) => t;
  const getEasing = (name: string) => linearEasing;

  it('returns null when animation is false', () => {
    expect(resolveAnimationConfig(false, getEasing)).toBe(null);
  });

  it('returns null when animation is null', () => {
    expect(resolveAnimationConfig(null, getEasing)).toBe(null);
  });

  it('returns default config when animation is true', () => {
    const config = resolveAnimationConfig(true, getEasing);

    expect(config).not.toBe(null);
    expect(config!.delayMs).toBe(0);
    expect(config!.durationMs).toBe(300);
    expect(typeof config!.easing).toBe('function');
  });

  it('returns default config when animation is empty object', () => {
    const config = resolveAnimationConfig({}, getEasing);

    expect(config).not.toBe(null);
    expect(config!.delayMs).toBe(0);
    expect(config!.durationMs).toBe(300);
  });

  it('uses provided delay', () => {
    const config = resolveAnimationConfig({ delay: 100 }, getEasing);

    expect(config!.delayMs).toBe(100);
    expect(config!.durationMs).toBe(300); // Default
  });

  it('uses provided duration', () => {
    const config = resolveAnimationConfig({ duration: 1000 }, getEasing);

    expect(config!.delayMs).toBe(0); // Default
    expect(config!.durationMs).toBe(1000);
  });

  it('uses provided easing function', () => {
    const customEasing = (t: number) => t * t;
    const config = resolveAnimationConfig({ easing: customEasing }, getEasing);

    expect(config!.easing).toBe(customEasing);
  });

  it('resolves easing from string name', () => {
    const customEasing = (t: number) => t * t;
    const getCustom = (name: string) => customEasing;
    const config = resolveAnimationConfig({ easing: 'cubicOut' }, getCustom);

    expect(config!.easing).toBe(customEasing);
  });

  it('combines all config options', () => {
    const customEasing = (t: number) => t * t;
    const config = resolveAnimationConfig(
      {
        delay: 200,
        duration: 500,
        easing: customEasing,
      },
      getEasing
    );

    expect(config!.delayMs).toBe(200);
    expect(config!.durationMs).toBe(500);
    expect(config!.easing).toBe(customEasing);
  });
});

describe('createEasingWithDelay', () => {
  const linear = (t: number) => t;

  it('returns 0 during delay phase', () => {
    const easing = createEasingWithDelay(100, 200, linear);

    expect(easing(0)).toBe(0);
    expect(easing(0.25)).toBe(0); // 25% of 300ms = 75ms < 100ms delay
    expect(easing(100 / 300)).toBe(0); // Exactly at delay end
  });

  it('applies easing after delay', () => {
    const easing = createEasingWithDelay(100, 200, linear);

    // After delay (100ms), 50% through duration (100ms of 200ms)
    const t = (100 + 100) / 300;
    expect(easing(t)).toBeCloseTo(0.5, 5);
  });

  it('returns 1 after delay + duration', () => {
    const easing = createEasingWithDelay(100, 200, linear);

    expect(easing(1)).toBe(1);
  });

  it('handles zero delay', () => {
    const easing = createEasingWithDelay(0, 200, linear);

    expect(easing(0)).toBe(0);
    expect(easing(0.5)).toBe(0.5);
    expect(easing(1)).toBe(1);
  });

  it('handles zero duration', () => {
    const easing = createEasingWithDelay(100, 0, linear);

    expect(easing(0)).toBe(0); // In delay
    expect(easing(0.5)).toBe(0); // Still in delay
    expect(easing(1)).toBe(1); // Past delay
  });

  it('applies custom easing function', () => {
    const quadratic = (t: number) => t * t;
    const easing = createEasingWithDelay(0, 100, quadratic);

    expect(easing(0.5)).toBeCloseTo(0.25, 5); // 0.5^2 = 0.25
  });

  it('handles total duration of zero', () => {
    const easing = createEasingWithDelay(0, 0, linear);

    expect(easing(0)).toBe(1);
    expect(easing(0.5)).toBe(1);
    expect(easing(1)).toBe(1);
  });
});

describe('isSnapOnlyUpdateAnimationSeries', () => {
  it('snaps heatmap and band so dual-Y / grid data is not cartesian-lerped', () => {
    // Coordinator uses this predicate to set out[i] = target series (no y-lerp).
    // Band must snap so y1 is not stripped by interpolateCartesianSeriesDataByIndex.
    expect(isSnapOnlyUpdateAnimationSeries('band')).toBe(true);
    expect(isSnapOnlyUpdateAnimationSeries('heatmap')).toBe(true);
    expect(isSnapOnlyUpdateAnimationSeries('line')).toBe(false);
    expect(isSnapOnlyUpdateAnimationSeries('area')).toBe(false);
    expect(isSnapOnlyUpdateAnimationSeries('scatter')).toBe(false);
    expect(isSnapOnlyUpdateAnimationSeries('pie')).toBe(false);
    expect(isSnapOnlyUpdateAnimationSeries('bar')).toBe(false);
  });
});

describe('hasAnyDrawableMarks', () => {
  it('returns true for line series with data', () => {
    const series = {
      type: 'line' as const,
      data: [
        [0, 1],
        [1, 2],
      ],
    };
    expect(hasAnyDrawableMarks([series as any])).toBe(true);
  });

  it('returns false for line series with no data', () => {
    const series = { type: 'line' as const, data: [] };
    expect(hasAnyDrawableMarks([series as any])).toBe(false);
  });

  it('returns true for pie series with positive value', () => {
    const series = {
      type: 'pie' as const,
      data: [{ name: 'A', value: 10, color: '#000', startAngle: 0, endAngle: 90 }],
    };
    expect(hasAnyDrawableMarks([series as any])).toBe(true);
  });

  it('returns false for pie series with zero values', () => {
    const series = {
      type: 'pie' as const,
      data: [{ name: 'A', value: 0, color: '#000', startAngle: 0, endAngle: 0 }],
    };
    expect(hasAnyDrawableMarks([series as any])).toBe(false);
  });

  it('returns false for pie series with non-finite values', () => {
    const series = {
      type: 'pie' as const,
      data: [{ name: 'A', value: NaN, color: '#000', startAngle: 0, endAngle: 0 }],
    };
    expect(hasAnyDrawableMarks([series as any])).toBe(false);
  });

  it('returns true for area/bar/scatter/candlestick series with data', () => {
    expect(hasAnyDrawableMarks([{ type: 'area' as const, data: [[0, 1]] } as any])).toBe(true);
    expect(hasAnyDrawableMarks([{ type: 'bar' as const, data: [[0, 1]] } as any])).toBe(true);
    expect(hasAnyDrawableMarks([{ type: 'scatter' as const, data: [[0, 1]] } as any])).toBe(true);
    expect(hasAnyDrawableMarks([{ type: 'candlestick' as const, data: [[0, 1, 2, 3, 4]] } as any])).toBe(true);
    expect(hasAnyDrawableMarks([{ type: 'band' as const, data: { x: [0, 1], y: [0, 0], y1: [1, 1] } } as any])).toBe(
      true
    );
    expect(hasAnyDrawableMarks([{ type: 'band' as const, data: { x: [], y: [], y1: [] } } as any])).toBe(false);
  });

  it('returns true when at least one series has marks', () => {
    const series = [
      { type: 'line' as const, data: [] },
      { type: 'line' as const, data: [[0, 1]] },
    ];
    expect(hasAnyDrawableMarks(series as any)).toBe(true);
  });

  it('returns false when no series have marks', () => {
    const series = [
      { type: 'line' as const, data: [] },
      { type: 'area' as const, data: [] },
    ];
    expect(hasAnyDrawableMarks(series as any)).toBe(false);
  });

  it('returns false for empty series list', () => {
    expect(hasAnyDrawableMarks([])).toBe(false);
  });
});

describe('lerpDomain', () => {
  it('interpolates domain bounds', () => {
    const from = { min: 0, max: 100 };
    const to = { min: 50, max: 150 };

    const result = lerpDomain(from, to, 0.5);

    expect(result.min).toBe(25); // 0 + (50-0)*0.5
    expect(result.max).toBe(125); // 100 + (150-100)*0.5
  });

  it('returns from domain at t=0', () => {
    const from = { min: 0, max: 100 };
    const to = { min: 50, max: 150 };

    const result = lerpDomain(from, to, 0);

    expect(result.min).toBe(0);
    expect(result.max).toBe(100);
  });

  it('returns to domain at t=1', () => {
    const from = { min: 0, max: 100 };
    const to = { min: 50, max: 150 };

    const result = lerpDomain(from, to, 1);

    expect(result.min).toBe(50);
    expect(result.max).toBe(150);
  });

  it('clamps t to [0, 1]', () => {
    const from = { min: 0, max: 100 };
    const to = { min: 50, max: 150 };

    const resultNeg = lerpDomain(from, to, -0.5);
    const resultOver = lerpDomain(from, to, 1.5);

    expect(resultNeg.min).toBe(0);
    expect(resultOver.min).toBe(50);
  });

  it('handles negative domains', () => {
    const from = { min: -100, max: 0 };
    const to = { min: -50, max: 50 };

    const result = lerpDomain(from, to, 0.5);

    expect(result.min).toBe(-75);
    expect(result.max).toBe(25);
  });
});

describe('lerpLogDomain', () => {
  it('interpolates multi-decade domains in log space', () => {
    const from = { min: 1, max: 100 };
    const to = { min: 1, max: 10000 };
    // Geometric mean of max: sqrt(100 * 10000) = 1000
    const mid = lerpLogDomain(from, to, 0.5);
    expect(mid.min).toBeCloseTo(1, 10);
    expect(mid.max).toBeCloseTo(1000, 10);
  });

  it('returns endpoints at t=0 and t=1', () => {
    const from = { min: 0.1, max: 10 };
    const to = { min: 1, max: 1000 };
    expect(lerpLogDomain(from, to, 0)).toEqual(from);
    expect(lerpLogDomain(from, to, 1)).toEqual(to);
  });

  it('falls back to linear lerp when any endpoint is non-positive', () => {
    const from = { min: -10, max: 100 };
    const to = { min: 1, max: 100 };
    const mid = lerpLogDomain(from, to, 0.5);
    // Linear: min = -10 + (1 - -10)*0.5 = -4.5
    expect(mid.min).toBeCloseTo(-4.5, 10);
    expect(mid.max).toBe(100);
  });
});

describe('interpolateCartesianData', () => {
  it('interpolates tuple data points', () => {
    const from = [
      [0, 0],
      [10, 10],
    ] as const;
    const to = [
      [0, 100],
      [10, 110],
    ] as const;

    const result = interpolateCartesianData(from, to, 0.5, null);

    expect(result).not.toBe(null);
    expect(result![0]).toEqual([0, 50]);
    expect(result![1]).toEqual([10, 60]);
  });

  it('interpolates object data points into tuple slots', () => {
    const from = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    const to = [
      { x: 0, y: 100 },
      { x: 10, y: 110 },
    ];

    const result = interpolateCartesianData(from, to, 0.5, null);

    expect(result).not.toBe(null);
    // Fresh cache is tuple-backed for packing/renderer compatibility.
    expect(result![0]).toEqual([0, 50]);
    expect(result![1]).toEqual([10, 60]);
  });

  it('returns null for mismatched array lengths', () => {
    const from = [[0, 0]] as const;
    const to = [
      [0, 100],
      [10, 110],
    ] as const;

    const result = interpolateCartesianData(from, to, 0.5, null);

    expect(result).toBe(null);
  });

  it('returns empty array for empty inputs', () => {
    const result = interpolateCartesianData([], [], 0.5, null);

    expect(result).toEqual([]);
  });

  it('reuses cache array when same length', () => {
    const from = [[0, 0]] as const;
    const to = [[0, 100]] as const;
    const cache: any[] = [[0, 0]];

    const result = interpolateCartesianData(from, to, 0.5, cache);

    expect(result).toBe(cache); // Same array reference
    expect(cache[0]).toEqual([0, 50]);
  });

  it('creates new array when cache length differs', () => {
    const from = [
      [0, 0],
      [10, 10],
    ] as const;
    const to = [
      [0, 100],
      [10, 110],
    ] as const;
    const cache: any[] = [null]; // Wrong length

    const result = interpolateCartesianData(from, to, 0.5, cache);

    expect(result).not.toBe(cache); // New array
    expect(result!.length).toBe(2);
  });

  it('returns from data at t=0', () => {
    const from = [[0, 0]] as const;
    const to = [[0, 100]] as const;

    const result = interpolateCartesianData(from, to, 0, null);

    expect(result![0]).toEqual([0, 0]);
  });

  it('returns to data at t=1', () => {
    const from = [[0, 0]] as const;
    const to = [[0, 100]] as const;

    const result = interpolateCartesianData(from, to, 1, null);

    expect(result![0]).toEqual([0, 100]);
  });
});

describe('interpolatePieData', () => {
  const createPieSeries = (data: any) => ({
    type: 'pie' as const,
    data,
    innerRadius: 0,
    outerRadius: 100,
  });

  it('interpolates pie slice values', () => {
    const fromSeries = createPieSeries([{ name: 'A', value: 0, color: '#000' }]);
    const toSeries = createPieSeries([{ name: 'A', value: 100, color: '#000' }]);

    const result = interpolatePieData(fromSeries as any, toSeries as any, 0.5, null);

    expect(result.data[0]!.value).toBe(50);
  });

  it('preserves name and color from to series', () => {
    const fromSeries = createPieSeries([{ name: 'Old', value: 0, color: '#000' }]);
    const toSeries = createPieSeries([{ name: 'New', value: 100, color: '#fff' }]);

    const result = interpolatePieData(fromSeries as any, toSeries as any, 0.5, null);

    expect(result.data[0]!.name).toBe('New');
    expect(result.data[0]!.color).toBe('#fff');
  });

  it('returns to series for mismatched array lengths', () => {
    const fromSeries = createPieSeries([{ name: 'A', value: 0, color: '#000' }]);
    const toSeries = createPieSeries([
      { name: 'A', value: 100, color: '#000' },
      { name: 'B', value: 50, color: '#fff' },
    ]);

    const result = interpolatePieData(fromSeries as any, toSeries as any, 0.5, null);

    expect(result).toBe(toSeries); // Unchanged
  });

  it('returns to series for empty data', () => {
    const fromSeries = createPieSeries([]);
    const toSeries = createPieSeries([]);

    const result = interpolatePieData(fromSeries as any, toSeries as any, 0.5, null);

    expect(result).toBe(toSeries);
  });

  it('reuses cache array when same length', () => {
    const fromSeries = createPieSeries([{ name: 'A', value: 0, color: '#000' }]);
    const toSeries = createPieSeries([{ name: 'A', value: 100, color: '#000' }]);
    // Create initial cache with proper structure
    const cache: any = [{ name: 'A', value: 0, color: '#000' }];

    const result = interpolatePieData(fromSeries as any, toSeries as any, 0.5, cache);

    expect(result.data).toBe(cache); // Same array reference
    expect(result.data[0]!.value).toBe(50); // Value interpolated
  });
});

describe('isDomainEqual', () => {
  it('returns true for equal domains', () => {
    const a = { min: 0, max: 100 };
    const b = { min: 0, max: 100 };

    expect(isDomainEqual(a, b)).toBe(true);
  });

  it('returns false when min differs', () => {
    const a = { min: 0, max: 100 };
    const b = { min: 10, max: 100 };

    expect(isDomainEqual(a, b)).toBe(false);
  });

  it('returns false when max differs', () => {
    const a = { min: 0, max: 100 };
    const b = { min: 0, max: 110 };

    expect(isDomainEqual(a, b)).toBe(false);
  });

  it('returns false when both differ', () => {
    const a = { min: 0, max: 100 };
    const b = { min: 10, max: 110 };

    expect(isDomainEqual(a, b)).toBe(false);
  });
});

describe('computeNextIntroPhase', () => {
  it('transitions from pending to running when conditions met', () => {
    const next = computeNextIntroPhase('pending', true, true);
    expect(next).toBe('running');
  });

  it('stays pending without drawable marks', () => {
    const next = computeNextIntroPhase('pending', false, true);
    expect(next).toBe('pending');
  });

  it('stays pending when animation disabled', () => {
    const next = computeNextIntroPhase('pending', true, false);
    expect(next).toBe('pending');
  });

  it('stays running during animation', () => {
    const next = computeNextIntroPhase('running', true, true);
    expect(next).toBe('running');
  });

  it('stays done after completion', () => {
    const next = computeNextIntroPhase('done', true, true);
    expect(next).toBe('done');
  });

  it('retriggers from done to pending when requested', () => {
    const next = computeNextIntroPhase('done', true, true, true);
    expect(next).toBe('pending');
  });
});

describe('applyBarIntroProgress', () => {
  it('interpolates from zero line to value', () => {
    const result = applyBarIntroProgress(100, 0, 200, 0.5);
    expect(result).toBe(50); // Halfway from 0 to 100
  });

  it('returns zero line at progress 0', () => {
    const result = applyBarIntroProgress(100, 0, 200, 0);
    expect(result).toBe(0);
  });

  it('returns actual value at progress 1', () => {
    const result = applyBarIntroProgress(100, 0, 200, 1);
    expect(result).toBe(100);
  });

  it('uses domain min when no zero line', () => {
    const result = applyBarIntroProgress(150, 100, 200, 0.5);
    expect(result).toBe(125); // Halfway from 100 to 150
  });

  it('handles negative values', () => {
    const result = applyBarIntroProgress(-50, -100, 0, 0.5);
    expect(result).toBe(-25); // Halfway from 0 to -50
  });

  it('clamps progress to [0, 1]', () => {
    expect(applyBarIntroProgress(100, 0, 200, -0.5)).toBe(0);
    expect(applyBarIntroProgress(100, 0, 200, 1.5)).toBe(100);
  });
});
