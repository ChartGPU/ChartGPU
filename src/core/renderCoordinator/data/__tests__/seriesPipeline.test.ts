/**
 * seriesPipeline owns baseline / setOptionsReuse / zoomed display resolution.
 */

import { describe, it, expect } from 'vitest';
import { packToFloat32ArrayAbsolute } from '../../../../data/sampleSeries';
import { getBandLength, getBandPoint } from '../../../../data/bandData';
import { sliceVisibleRangeByX } from '../computeVisibleSlice';
import { buildRuntimeBaseSeries, buildSetOptionsReuseSeries, resolveZoomedSeriesEntry } from '../seriesPipeline';
import type { ResolvedSeriesConfig } from '../../../../config/OptionResolver';
import type { CartesianSeriesData, DataPoint } from '../../../../config/types';

const raw100 = {
  x: Float64Array.from(Array.from({ length: 100 }, (_, i) => i)),
  y: Float64Array.from(Array.from({ length: 100 }, (_, i) => i)),
};

const lineLttb = {
  type: 'line',
  sampling: 'lttb',
  samplingThreshold: 10,
  data: { x: [0], y: [0] },
  rawData: raw100,
} as unknown as ResolvedSeriesConfig;

const lineAverage = {
  type: 'line',
  sampling: 'average',
  samplingThreshold: 10,
  data: { x: [0, 1], y: [0, 1] },
  rawData: raw100,
} as unknown as ResolvedSeriesConfig;

const lineNone = {
  type: 'line',
  sampling: 'none',
  samplingThreshold: 2500,
  data: { x: [0], y: [0] },
  rawData: raw100,
} as unknown as ResolvedSeriesConfig;

describe('buildRuntimeBaseSeries', () => {
  it('GPU-eligible lttb keeps full raw on data', () => {
    const out = buildRuntimeBaseSeries([lineLttb], [raw100], [null]);
    expect(out[0]!.data).toBe(raw100);
    expect(out[0]!.rawData).toBe(raw100);
  });

  it('builds full array for all indices', () => {
    const out = buildRuntimeBaseSeries([lineLttb, lineAverage], [raw100, raw100], [null, null]);
    expect(out).toHaveLength(2);
    expect(out[0]!.data).toBe(raw100);
  });
});

describe('buildSetOptionsReuseSeries', () => {
  it('GPU-eligible forces raw on data', () => {
    const out = buildSetOptionsReuseSeries([lineLttb], [raw100], [null]);
    expect(out[0]!.data).toBe(raw100);
  });

  it('non-GPU keeps OptionResolver sampled data (setOptionsReuse)', () => {
    const sampled = lineAverage.data;
    const out = buildSetOptionsReuseSeries([lineAverage], [raw100], [null]);
    expect(out[0]!.data).toBe(sampled);
    expect(out[0]!.rawData).toBe(raw100);
  });
});

describe('resolveZoomedSeriesEntry', () => {
  const sliceX = (data: { x: ArrayLike<number>; y: ArrayLike<number> }, min: number, max: number) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < data.x.length; i++) {
      const x = data.x[i]!;
      if (x >= min && x <= max) {
        xs.push(x);
        ys.push(data.y[i]!);
      }
    }
    return { x: xs, y: ys };
  };
  const sliceOHLC = (data: readonly unknown[]) => data;

  it('GPU-eligible zoom keeps full raw (not buffered sample)', () => {
    const r = resolveZoomedSeriesEntry({
      series: lineLttb,
      rawSlot: raw100,
      bufferedMin: 10,
      bufferedMax: 50,
      visibleMin: 20,
      visibleMax: 40,
      spanFraction: 0.3,
      sliceX: sliceX as any,
      sliceOHLC: sliceOHLC as any,
    });
    expect(r.series.data).toBe(raw100);
    expect(r.cacheEntry).toBeNull();
  });

  it('sampling none keeps full raw at any zoom (no visible slice upload)', () => {
    let sliceCalls = 0;
    const countingSlice = (data: any, min: number, max: number) => {
      sliceCalls++;
      return sliceX(data, min, max);
    };
    const r = resolveZoomedSeriesEntry({
      series: lineNone,
      rawSlot: raw100,
      bufferedMin: 10,
      bufferedMax: 50,
      visibleMin: 20,
      visibleMax: 40,
      spanFraction: 0.3,
      sliceX: countingSlice as any,
      sliceOHLC: sliceOHLC as any,
    });
    // Must not window series.data — fullRawLine append + right-side zoom depend on it.
    expect(r.series.data).toBe(raw100);
    expect((r.series as { rawData?: unknown }).rawData).toBe(raw100);
    expect(r.cacheEntry).toBeNull();
    expect(sliceCalls).toBe(0);
  });

  it('sampling none prefers rawSlot over series.data when zoomed', () => {
    const slot = {
      x: Float64Array.from([100, 101, 102]),
      y: Float64Array.from([1, 2, 3]),
    };
    const r = resolveZoomedSeriesEntry({
      series: lineNone,
      rawSlot: slot,
      bufferedMin: 0,
      bufferedMax: 200,
      visibleMin: 100,
      visibleMax: 102,
      spanFraction: 0.1,
      sliceX: sliceX as any,
      sliceOHLC: sliceOHLC as any,
    });
    expect(r.series.data).toBe(slot);
    expect((r.series as { rawData?: unknown }).rawData).toBe(slot);
  });

  it('band sampling:none keeps full Xyy raw at any zoom', () => {
    const rawBand = {
      x: Float64Array.from([0, 1, 2, 3, 4, 5]),
      y: Float64Array.from([0, 0, 0, 0, 0, 0]),
      y1: Float64Array.from([1, 2, 3, 4, 5, 6]),
    };
    const bandNone = {
      type: 'band',
      sampling: 'none',
      samplingThreshold: 10,
      data: rawBand,
      rawData: rawBand,
    } as unknown as ResolvedSeriesConfig;
    const r = resolveZoomedSeriesEntry({
      series: bandNone,
      rawSlot: rawBand,
      bufferedMin: 1,
      bufferedMax: 4,
      visibleMin: 2,
      visibleMax: 3,
      spanFraction: 0.2,
      sliceX: sliceX as any,
      sliceOHLC: sliceOHLC as any,
    });
    expect(r.series.data).toBe(rawBand);
    expect((r.series as { rawData?: unknown }).rawData).toBe(rawBand);
    expect(r.cacheEntry).toBeNull();
  });

  it('band CPU lttb samples and returns cache with y+y1 aligned', () => {
    const n = 80;
    const rawBand = {
      x: Float64Array.from(Array.from({ length: n }, (_, i) => i)),
      y: Float64Array.from(Array.from({ length: n }, (_, i) => i)),
      y1: Float64Array.from(Array.from({ length: n }, (_, i) => i * 1000 + 7)),
    };
    const bandLttb = {
      type: 'band',
      sampling: 'lttb',
      samplingThreshold: 12,
      data: rawBand,
      rawData: rawBand,
    } as unknown as ResolvedSeriesConfig;
    const r = resolveZoomedSeriesEntry({
      series: bandLttb,
      rawSlot: rawBand,
      bufferedMin: 0,
      bufferedMax: n - 1,
      visibleMin: 0,
      visibleMax: n - 1,
      spanFraction: 1,
      sliceX: sliceX as any,
      sliceOHLC: sliceOHLC as any,
    });
    // Zoomed band path returns sampled tuples/array with cache entry when not sampling none.
    expect(r.cacheEntry).not.toBeNull();
    const data = r.series.data as any;
    // When full-span-ish, sampled length ≤ threshold*buffer factor; y1 pairing holds.
    const sn = getBandLength(data);
    expect(sn).toBeGreaterThan(0);
    expect(sn).toBeLessThanOrEqual(n);
    for (let i = 0; i < sn; i++) {
      const p = getBandPoint(data, i);
      if (!p || !Number.isFinite(p.y)) continue;
      expect(p.y1).toBe(p.y * 1000 + 7);
    }
  });

  it('CPU path samples and returns cache entry', () => {
    const identitySlice = (data: any) => data;
    const r = resolveZoomedSeriesEntry({
      series: lineAverage,
      rawSlot: raw100,
      bufferedMin: 0,
      bufferedMax: 99,
      visibleMin: 0,
      visibleMax: 99,
      spanFraction: 1,
      sliceX: identitySlice,
      sliceOHLC: sliceOHLC as any,
    });
    expect(r.series.data).toBeTruthy();
    expect(r.cacheEntry).not.toBeNull();
    expect(r.cacheEntry!.cachedRange).toEqual({ min: 0, max: 99 });
  });

  it('null-gap line data is not stripped by zoom sample path (issue #150)', () => {
    const rawWithGaps: Array<[number, number] | null> = Array.from({ length: 100 }, (_, i) =>
      i === 50 ? null : ([i, i % 2 ? 1.1 : 1.2] as [number, number])
    );
    const lineWithGaps = {
      type: 'line',
      sampling: 'lttb',
      samplingThreshold: 10,
      data: rawWithGaps,
      rawData: rawWithGaps,
    } as unknown as ResolvedSeriesConfig;

    const visibleMin = 20;
    const visibleMax = 80;
    const r = resolveZoomedSeriesEntry({
      series: lineWithGaps,
      rawSlot: rawWithGaps,
      bufferedMin: 10,
      bufferedMax: 90,
      visibleMin,
      visibleMax,
      spanFraction: 0.6,
      sliceX: sliceVisibleRangeByX,
      sliceOHLC: sliceOHLC as any,
    });

    const display = r.series.data as ReadonlyArray<DataPoint | null>;
    expect(Array.isArray(display)).toBe(true);
    expect(display.includes(null)).toBe(true);
    // Windowed: every finite point is inside the visible range (not full raw).
    for (const p of display) {
      if (p === null) continue;
      const x = Array.isArray(p) ? p[0] : (p as { x: number }).x;
      expect(x).toBeGreaterThanOrEqual(visibleMin);
      expect(x).toBeLessThanOrEqual(visibleMax);
    }
    expect(display.some((p) => p !== null && Array.isArray(p) && p[0] === 20)).toBe(true);
    expect(display.some((p) => p !== null && Array.isArray(p) && p[0] === 80)).toBe(true);
    // Gap at x=50 sits between neighbors in the display sequence.
    const nullIdx = display.indexOf(null);
    expect(nullIdx).toBeGreaterThan(0);
    expect(nullIdx).toBeLessThan(display.length - 1);
    expect(r.cacheEntry).not.toBeNull();
    expect(r.cacheEntry!.cachedRange).toEqual({ min: 10, max: 90 });

    // Layering: pack path turns preserved nulls into NaN gap slots for shader discard
    // (full packXYInto null→NaN coverage lives in cartesianData.test.ts).
    const packed = packToFloat32ArrayAbsolute(display as CartesianSeriesData);
    expect(Number.isNaN(packed[nullIdx * 2])).toBe(true);
    expect(Number.isNaN(packed[nullIdx * 2 + 1])).toBe(true);
  });
});
