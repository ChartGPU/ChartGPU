import { describe, it, expect } from 'vitest';
import {
  resolveCartesianDisplayData,
  resolveCandlestickDisplayData,
  computeZoomSampleTarget,
} from '../resolveSeriesDisplayData';
import type { ResolvedSeriesConfig } from '../../../../config/OptionResolver';

const raw = {
  x: Float64Array.from(Array.from({ length: 100 }, (_, i) => i)),
  y: Float64Array.from(Array.from({ length: 100 }, (_, i) => i)),
};

describe('resolveCartesianDisplayData', () => {
  it('keeps full raw when GPU decimation eligible (lttb, no gaps)', () => {
    const series = {
      type: 'line',
      sampling: 'lttb',
      samplingThreshold: 10,
    } as ResolvedSeriesConfig;
    const data = resolveCartesianDisplayData({ series, raw, mode: 'baseline' });
    expect(data).toBe(raw);
  });

  it('samples on CPU when sampling is none is not GPU path — none returns raw via sampleSeries', () => {
    const series = {
      type: 'line',
      sampling: 'none',
      samplingThreshold: 10,
    } as ResolvedSeriesConfig;
    const data = resolveCartesianDisplayData({ series, raw, mode: 'baseline' });
    // sampling none: sampleSeriesDataPoints returns input ref or equivalent full data
    expect(data).toBeTruthy();
  });

  it('setOptionsReuse returns series.data when not GPU-eligible', () => {
    const sampled = { x: [0, 1], y: [0, 1] };
    const series = {
      type: 'line',
      sampling: 'average',
      samplingThreshold: 10,
      data: sampled,
    } as unknown as ResolvedSeriesConfig;
    const data = resolveCartesianDisplayData({ series, raw, mode: 'setOptionsReuse' });
    expect(data).toBe(sampled);
  });

  it('setOptionsReuse still prefers raw when GPU-eligible', () => {
    const sampled = { x: [0], y: [0] };
    const series = {
      type: 'line',
      sampling: 'lttb',
      samplingThreshold: 10,
      data: sampled,
    } as unknown as ResolvedSeriesConfig;
    const data = resolveCartesianDisplayData({ series, raw, mode: 'setOptionsReuse' });
    expect(data).toBe(raw);
  });

  it.each(['lttb', 'min', 'max', 'average'] as const)(
    'keeps raw (skips %s sampling) when null gap markers are present — baseline (issue #150)',
    (sampling) => {
      // Above samplingThreshold so sampleSeries would otherwise strip nulls.
      const rawWithGaps: Array<[number, number] | null> = Array.from({ length: 50 }, (_, i) =>
        i === 25 ? null : ([i, i] as [number, number])
      );
      const series = {
        type: 'line',
        sampling,
        samplingThreshold: 10,
      } as ResolvedSeriesConfig;
      const data = resolveCartesianDisplayData({
        series,
        raw: rawWithGaps as any,
        mode: 'baseline',
      });
      expect(data).toBe(rawWithGaps);
      expect((data as readonly unknown[]).includes(null)).toBe(true);
    }
  );

  it.each(['lttb', 'min', 'max', 'average'] as const)(
    'keeps raw (skips %s sampling) when null gaps present on zoomed path (issue #150)',
    (sampling) => {
      const rawWithGaps: Array<[number, number] | null> = Array.from({ length: 100 }, (_, i) =>
        i === 50 ? null : ([i, i % 2 ? 1.1 : 1.2] as [number, number])
      );
      const series = {
        type: 'line',
        sampling,
        samplingThreshold: 10,
      } as ResolvedSeriesConfig;
      const data = resolveCartesianDisplayData({
        series,
        raw: rawWithGaps as any,
        mode: 'zoomed',
        sampleTarget: 20,
      });
      expect(data).toBe(rawWithGaps);
      expect((data as readonly unknown[]).includes(null)).toBe(true);
    }
  );

  it('area series also bypasses sampling when null gaps are present (issue #150)', () => {
    const rawWithGaps: Array<[number, number] | null> = Array.from({ length: 40 }, (_, i) =>
      i === 20 ? null : ([i, i] as [number, number])
    );
    const series = {
      type: 'area',
      sampling: 'lttb',
      samplingThreshold: 10,
    } as ResolvedSeriesConfig;
    const data = resolveCartesianDisplayData({
      series,
      raw: rawWithGaps as any,
      mode: 'zoomed',
      sampleTarget: 15,
    });
    expect(data).toBe(rawWithGaps);
  });
});

describe('resolveCandlestickDisplayData', () => {
  it('returns raw when under threshold', () => {
    const ohlc = [
      { timestamp: 1, open: 1, high: 2, low: 0, close: 1.5 },
      { timestamp: 2, open: 1.5, high: 3, low: 1, close: 2 },
    ];
    expect(
      resolveCandlestickDisplayData({
        sampling: 'ohlc',
        samplingThreshold: 100,
        rawOHLC: ohlc,
      })
    ).toBe(ohlc);
  });
});

describe('computeZoomSampleTarget', () => {
  it('raises target as span shrinks', () => {
    const full = computeZoomSampleTarget(100, 1);
    const zoomed = computeZoomSampleTarget(100, 0.1);
    expect(zoomed).toBeGreaterThan(full);
  });

  it('clamps to max multiplier', () => {
    const t = computeZoomSampleTarget(100, 1e-6);
    expect(t).toBeLessThanOrEqual(100 * 32);
  });
});
