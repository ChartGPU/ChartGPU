import { describe, it, expect, vi } from 'vitest';
import { resolveOptions, resolveSeriesContentHash, type ResolvedSeriesConfig } from '../OptionResolver';
import type { DataPoint, OHLCDataPoint } from '../types';
import { getPointCount } from '../../data/cartesianData';
import * as seriesContentHashModule from '../../data/seriesContentHash';

describe('OptionResolver - connectNulls', () => {
  it('defaults connectNulls to false for line series', () => {
    const resolved = resolveOptions({
      series: [
        {
          type: 'line',
          data: [
            [0, 1],
            [1, 2],
          ],
        },
      ],
    });
    const series = resolved.series[0];
    expect(series.type).toBe('line');
    if (series.type === 'line') {
      expect(series.connectNulls).toBe(false);
    }
  });

  it('resolves connectNulls: true for line series', () => {
    const resolved = resolveOptions({
      series: [
        {
          type: 'line',
          data: [
            [0, 1],
            [1, 2],
          ],
          connectNulls: true,
        },
      ],
    });
    const series = resolved.series[0];
    if (series.type === 'line') {
      expect(series.connectNulls).toBe(true);
    }
  });

  it('defaults connectNulls to false for area series', () => {
    const resolved = resolveOptions({
      series: [
        {
          type: 'area',
          data: [
            [0, 1],
            [1, 2],
          ],
        },
      ],
    });
    const series = resolved.series[0];
    expect(series.type).toBe('area');
    if (series.type === 'area') {
      expect(series.connectNulls).toBe(false);
    }
  });

  it('resolves connectNulls: true for area series', () => {
    const resolved = resolveOptions({
      series: [
        {
          type: 'area',
          data: [
            [0, 1],
            [1, 2],
          ],
          connectNulls: true,
        },
      ],
    });
    const series = resolved.series[0];
    if (series.type === 'area') {
      expect(series.connectNulls).toBe(true);
    }
  });
});

describe('OptionResolver - sampling bypass with gaps', () => {
  it('bypasses LTTB sampling when line data contains null gaps', () => {
    const dataWithGaps: (DataPoint | null)[] = [];
    for (let i = 0; i < 10000; i++) {
      dataWithGaps.push(i === 5000 ? null : [i, Math.sin(i)]);
    }
    const resolved = resolveOptions({
      series: [
        {
          type: 'line',
          data: dataWithGaps,
          sampling: 'lttb',
          samplingThreshold: 5000,
        },
      ],
    });
    const series = resolved.series[0];
    if (series.type === 'line') {
      // Data should not be downsampled — null gaps must be preserved
      expect(getPointCount(series.data)).toBe(10000);
    }
  });

  it('bypasses LTTB sampling when area data contains null gaps', () => {
    const dataWithGaps: (DataPoint | null)[] = [];
    for (let i = 0; i < 10000; i++) {
      dataWithGaps.push(i === 5000 ? null : [i, Math.sin(i)]);
    }
    const resolved = resolveOptions({
      series: [
        {
          type: 'area',
          data: dataWithGaps,
          sampling: 'lttb',
          samplingThreshold: 5000,
        },
      ],
    });
    const series = resolved.series[0];
    if (series.type === 'area') {
      // Data should not be downsampled — null gaps must be preserved
      expect(getPointCount(series.data)).toBe(10000);
    }
  });

  it('applies sampling normally when line data has no null gaps', () => {
    const data: DataPoint[] = [];
    for (let i = 0; i < 10000; i++) {
      data.push([i, Math.sin(i)]);
    }
    const resolved = resolveOptions({
      series: [
        {
          type: 'line',
          data,
          sampling: 'lttb',
          samplingThreshold: 5000,
        },
      ],
    });
    const series = resolved.series[0];
    if (series.type === 'line') {
      expect(getPointCount(series.data)).toBeLessThanOrEqual(5000);
    }
  });

  it('applies sampling normally when area data has no null gaps', () => {
    const data: DataPoint[] = [];
    for (let i = 0; i < 10000; i++) {
      data.push([i, Math.sin(i)]);
    }
    const resolved = resolveOptions({
      series: [
        {
          type: 'area',
          data,
          sampling: 'lttb',
          samplingThreshold: 5000,
        },
      ],
    });
    const series = resolved.series[0];
    if (series.type === 'area') {
      expect(getPointCount(series.data)).toBeLessThanOrEqual(5000);
    }
  });
});

describe('resolveSeriesContentHash', () => {
  it('reuses previous hash when type and raw data identity match', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const prev = {
      type: 'line',
      rawData: data,
      data,
      contentHash: 0xabc,
    } as unknown as ResolvedSeriesConfig;
    let hashCalls = 0;
    const hash = resolveSeriesContentHash(prev, 'line', data, () => {
      hashCalls++;
      return 0xdead;
    });
    expect(hash).toBe(0xabc);
    expect(hashCalls).toBe(0);
  });

  it('recomputes when data reference changes', () => {
    const prevData: DataPoint[] = [[0, 1]];
    const nextData: DataPoint[] = [[0, 2]];
    const prev = {
      type: 'bar',
      rawData: prevData,
      data: prevData,
      contentHash: 1,
    } as unknown as ResolvedSeriesConfig;
    const hash = resolveSeriesContentHash(prev, 'bar', nextData, () => 42);
    expect(hash).toBe(42);
  });

  it('recomputes when series type changes', () => {
    const data: DataPoint[] = [[0, 1]];
    const prev = {
      type: 'line',
      rawData: data,
      data,
      contentHash: 7,
    } as unknown as ResolvedSeriesConfig;
    const hash = resolveSeriesContentHash(prev, 'bar', data, () => 99);
    expect(hash).toBe(99);
  });

  it('recomputes when previous contentHash is missing', () => {
    const data: DataPoint[] = [[0, 1]];
    const prev = {
      type: 'scatter',
      rawData: data,
      data,
    } as unknown as ResolvedSeriesConfig;
    const hash = resolveSeriesContentHash(prev, 'scatter', data, () => 11);
    expect(hash).toBe(11);
  });
});

describe('OptionResolver candlestick contentHash reuse', () => {
  it('reuses OHLC contentHash without full scan on stable data ref', () => {
    const data: OHLCDataPoint[] = [
      [0, 1, 2, 0.5, 2.5],
      [1, 2, 1.5, 1, 2.2],
    ];
    // Suppress one-time candlestick warning.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = resolveOptions({
      series: [{ type: 'candlestick', data, sampling: 'none' }],
    });
    const hashSpy = vi.spyOn(seriesContentHashModule, 'hashOHLCSeriesData');
    const second = resolveOptions(
      {
        series: [{ type: 'candlestick', data, sampling: 'none', color: '#f00' }],
        yAxis: { min: 0, max: 10 },
      },
      { previousResolved: first }
    );
    expect(hashSpy).not.toHaveBeenCalled();
    expect((second.series[0] as { contentHash?: number }).contentHash).toBe(
      (first.series[0] as { contentHash?: number }).contentHash
    );
    hashSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('OptionResolver full series rewrite path', () => {
  it('does not full-scan hashCartesianSeriesData when data ref changes', () => {
    const a: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const b: DataPoint[] = [
      [0, 1.1],
      [1, 2.1],
      [2, 3.1],
    ];
    const first = resolveOptions({
      series: [{ type: 'scatter', data: a, sampling: 'none' }],
      xAxis: { min: 0, max: 10 },
      yAxis: { min: 0, max: 10 },
    });
    const fullHashSpy = vi.spyOn(seriesContentHashModule, 'hashCartesianSeriesData');
    const cheapSpy = vi.spyOn(seriesContentHashModule, 'cheapCartesianContentStamp');
    const second = resolveOptions(
      {
        series: [{ type: 'scatter', data: b, sampling: 'none' }],
        xAxis: { min: 0, max: 10 },
        yAxis: { min: 0, max: 10 },
      },
      { previousResolved: first }
    );
    expect(fullHashSpy).not.toHaveBeenCalled();
    expect(cheapSpy).toHaveBeenCalled();
    expect((second.series[0] as { contentHash?: number }).contentHash).not.toBe(
      (first.series[0] as { contentHash?: number }).contentHash
    );
    fullHashSpy.mockRestore();
    cheapSpy.mockRestore();
  });

  it('skips O(n) bounds scan when all axis domains are explicit', () => {
    const a: DataPoint[] = Array.from({ length: 200 }, (_, i) => [i, i * 0.5]);
    const b: DataPoint[] = Array.from({ length: 200 }, (_, i) => [i + 0.1, i * 0.5 + 0.1]);
    const first = resolveOptions({
      series: [{ type: 'line', data: a, sampling: 'none' }],
      xAxis: { min: -10, max: 110 },
      yAxis: { min: -10, max: 60 },
    });
    // rawBounds should be synthetic axis domain, not data extrema
    expect(first.series[0]).toMatchObject({
      rawBounds: { xMin: -10, xMax: 110, yMin: -10, yMax: 60 },
    });
    const second = resolveOptions(
      {
        series: [{ type: 'line', data: b, sampling: 'none' }],
        xAxis: { min: -10, max: 110 },
        yAxis: { min: -10, max: 60 },
      },
      { previousResolved: first }
    );
    expect(second.series[0]).toMatchObject({
      rawBounds: { xMin: -10, xMax: 110, yMin: -10, yMax: 60 },
    });
  });

  it('still computes data x-extent when x axis is auto and y is fixed (group 4)', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 5],
      [2, 3],
    ];
    const resolved = resolveOptions({
      series: [{ type: 'scatter', data, sampling: 'none' }],
      // x auto, y fixed — y bounds come from axis, not data extrema
      yAxis: { min: -10, max: 60 },
    });
    expect(resolved.series[0]).toMatchObject({
      rawBounds: { xMin: 0, xMax: 2, yMin: -10, yMax: 60 },
    });
  });

  it('does not keep synthetic rawBounds when axes switch to auto under same data ref', () => {
    const data: DataPoint[] = [
      [0, 1],
      [10, 50],
      [20, 25],
    ];
    const first = resolveOptions({
      series: [{ type: 'line', data, sampling: 'none' }],
      xAxis: { min: -100, max: 100 },
      yAxis: { min: -100, max: 100 },
    });
    expect(first.series[0]).toMatchObject({
      rawBounds: { xMin: -100, xMax: 100, yMin: -100, yMax: 100 },
      rawBoundsMode: 'synthetic',
    });
    const second = resolveOptions(
      {
        series: [{ type: 'line', data, sampling: 'none' }],
        // auto axes
      },
      { previousResolved: first }
    );
    expect((second.series[0] as { rawBoundsMode?: string }).rawBoundsMode).toBe('data');
    expect(second.series[0]).toMatchObject({
      rawBounds: { xMin: 0, xMax: 20, yMin: 1, yMax: 50 },
    });
  });

  it('y-fixed + non-index x uses data-driven x extent (not 0..n-1)', () => {
    const data: DataPoint[] = [
      [5, 1],
      [15, 2],
      [25, 3],
    ];
    const resolved = resolveOptions({
      series: [{ type: 'scatter', data, sampling: 'none' }],
      yAxis: { min: -10, max: 60 },
    });
    expect(resolved.series[0]).toMatchObject({
      rawBoundsMode: 'xDataYAxis',
      rawBounds: { xMin: 5, xMax: 25, yMin: -10, yMax: 60 },
    });
  });

  it('uses cheapOHLCContentStamp on candlestick data ref change', () => {
    const a: OHLCDataPoint[] = [[0, 1, 2, 0.5, 1.5]];
    const b: OHLCDataPoint[] = [[0, 1, 2, 0.5, 1.8]];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = resolveOptions({
      series: [{ type: 'candlestick', data: a, sampling: 'none' }],
    });
    const fullSpy = vi.spyOn(seriesContentHashModule, 'hashOHLCSeriesData');
    const cheapSpy = vi.spyOn(seriesContentHashModule, 'cheapOHLCContentStamp');
    resolveOptions({ series: [{ type: 'candlestick', data: b, sampling: 'none' }] }, { previousResolved: first });
    expect(fullSpy).not.toHaveBeenCalled();
    expect(cheapSpy).toHaveBeenCalled();
    fullSpy.mockRestore();
    cheapSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('OptionResolver equal-N LTTB y-remap (group 4)', () => {
  it('indexSorted equal-N skips sampleSeriesDataPoints and remaps y at frozen indices', async () => {
    const sampleSeries = await import('../../data/sampleSeries');
    const n = 100;
    const threshold = 10;
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i, Math.sin(i) * 10] as DataPoint);
    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i, Math.sin(i) * 10 + 1] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'lttb', samplingThreshold: threshold }],
      yAxis: { min: -20, max: 20 },
    });
    const firstSampled = (first.series[0] as { data: DataPoint[] }).data;
    expect(getPointCount(firstSampled)).toBeLessThanOrEqual(threshold);

    const spy = vi.spyOn(sampleSeries, 'sampleSeriesDataPoints');
    const second = resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'lttb', samplingThreshold: threshold }],
        yAxis: { min: -20, max: 20 },
      },
      { previousResolved: first }
    );
    expect(spy).not.toHaveBeenCalled();
    const remapped = (second.series[0] as { data: DataPoint[] }).data;
    expect(getPointCount(remapped)).toBe(getPointCount(firstSampled));
    // X indices frozen; y re-read from rawB
    for (let j = 0; j < getPointCount(remapped); j++) {
      const x = Array.isArray(remapped[j]) ? (remapped[j] as number[])[0]! : (remapped[j] as { x: number }).x;
      const y = Array.isArray(remapped[j]) ? (remapped[j] as number[])[1]! : (remapped[j] as { y: number }).y;
      const idx = Math.round(x as number);
      expect(y).toBe(rawB[idx]![1]);
    }
    spy.mockRestore();
  });

  it('Brownian xy still calls full sampleSeriesDataPoints', async () => {
    const sampleSeries = await import('../../data/sampleSeries');
    const n = 80;
    const threshold = 10;
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i * 0.1, i] as DataPoint);
    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i * 0.1 + 0.5, i + 1] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'lttb', samplingThreshold: threshold }],
      xAxis: { min: -5, max: 20 },
      yAxis: { min: -5, max: 100 },
    });
    const spy = vi.spyOn(sampleSeries, 'sampleSeriesDataPoints');
    resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'lttb', samplingThreshold: threshold }],
        xAxis: { min: -5, max: 20 },
        yAxis: { min: -5, max: 100 },
      },
      { previousResolved: first }
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('equalX (stable x≠i) does not use index remap — full sample', async () => {
    const sampleSeries = await import('../../data/sampleSeries');
    const n = 60;
    const threshold = 10;
    // Stable x spaced by 2 — equal-X y-only, not index-sorted
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i * 2, i] as DataPoint);
    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i * 2, i + 5] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'lttb', samplingThreshold: threshold }],
      yAxis: { min: -5, max: 100 },
    });
    const spy = vi.spyOn(sampleSeries, 'sampleSeriesDataPoints');
    resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'lttb', samplingThreshold: threshold }],
        yAxis: { min: -5, max: 100 },
      },
      { previousResolved: first }
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('samplingThreshold change forces full sample (not frozen k)', async () => {
    const sampleSeries = await import('../../data/sampleSeries');
    const n = 100;
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i + 1] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'lttb', samplingThreshold: 10 }],
      yAxis: { min: -5, max: 200 },
    });
    const spy = vi.spyOn(sampleSeries, 'sampleSeriesDataPoints');
    const second = resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'lttb', samplingThreshold: 20 }],
        yAxis: { min: -5, max: 200 },
      },
      { previousResolved: first }
    );
    expect(spy).toHaveBeenCalled();
    expect(getPointCount((second.series[0] as { data: DataPoint[] }).data)).toBeLessThanOrEqual(20);
    spy.mockRestore();
  });

  it('min sampling does not freeze prior indices (always re-sample)', async () => {
    const sampleSeries = await import('../../data/sampleSeries');
    const n = 80;
    const threshold = 10;
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i + 1] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'min', samplingThreshold: threshold }],
      yAxis: { min: -5, max: 200 },
    });
    const spy = vi.spyOn(sampleSeries, 'sampleSeriesDataPoints');
    resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'min', samplingThreshold: threshold }],
        yAxis: { min: -5, max: 200 },
      },
      { previousResolved: first }
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('null remap fallback calls sampleSeriesDataPoints when indices invalid', async () => {
    const sampleSeries = await import('../../data/sampleSeries');
    const rewrite = await import('../../data/seriesRewriteDetect');
    const n = 50;
    const threshold = 10;
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i + 1] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'lttb', samplingThreshold: threshold }],
      yAxis: { min: -5, max: 100 },
    });
    const remapSpy = vi.spyOn(rewrite, 'remapIndexSortedSampleY').mockReturnValue(null);
    const sampleSpy = vi.spyOn(sampleSeries, 'sampleSeriesDataPoints');
    resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'lttb', samplingThreshold: threshold }],
        yAxis: { min: -5, max: 100 },
      },
      { previousResolved: first }
    );
    expect(remapSpy).toHaveBeenCalled();
    expect(sampleSpy).toHaveBeenCalled();
    remapSpy.mockRestore();
    sampleSpy.mockRestore();
  });

  it('sticky indexSortedProven: second equal-N frame skips full isIndexSortedX', async () => {
    const rewrite = await import('../../data/seriesRewriteDetect');
    const n = 80;
    const threshold = 10;
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i + 1] as DataPoint);
    const rawC: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i + 2] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'lttb', samplingThreshold: threshold }],
      yAxis: { min: -5, max: 200 },
    });
    expect((first.series[0] as { indexSortedProven?: boolean }).indexSortedProven).toBe(true);
    expect((first.series[0] as { indexSortedPointCount?: number }).indexSortedPointCount).toBe(n);

    // Warm sticky on second resolve
    const second = resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'lttb', samplingThreshold: threshold }],
        yAxis: { min: -5, max: 200 },
      },
      { previousResolved: first }
    );
    expect((second.series[0] as { indexSortedProven?: boolean }).indexSortedProven).toBe(true);

    const fullScanSpy = vi.spyOn(rewrite, 'isIndexSortedX');
    resolveOptions(
      {
        series: [{ type: 'scatter', data: rawC, sampling: 'lttb', samplingThreshold: threshold }],
        yAxis: { min: -5, max: 200 },
      },
      { previousResolved: second }
    );
    // Sticky path: classify should not call full isIndexSortedX; bounds trusts sticky.
    expect(fullScanSpy).not.toHaveBeenCalled();
    fullScanSpy.mockRestore();
  });

  it('clears sticky when Brownian x change after proven stream', () => {
    const n = 40;
    const threshold = 10;
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i * 0.1 + 0.5, i] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'lttb', samplingThreshold: threshold }],
      xAxis: { min: -5, max: 20 },
      yAxis: { min: -5, max: 100 },
    });
    expect((first.series[0] as { indexSortedProven?: boolean }).indexSortedProven).toBe(true);

    const second = resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'lttb', samplingThreshold: threshold }],
        xAxis: { min: -5, max: 20 },
        yAxis: { min: -5, max: 100 },
      },
      { previousResolved: first }
    );
    expect((second.series[0] as { indexSortedProven?: boolean }).indexSortedProven).toBeFalsy();
  });

  it('length / N mismatch does not reuse sticky — cold re-proofs at new N', async () => {
    const rewrite = await import('../../data/seriesRewriteDetect');
    const n = 50;
    const threshold = 10;
    const rawN: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
    const rawNPlus: DataPoint[] = Array.from({ length: n + 1 }, (_, i) => [i, i + 1] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawN, sampling: 'lttb', samplingThreshold: threshold }],
      yAxis: { min: -5, max: 200 },
    });
    expect((first.series[0] as { indexSortedProven?: boolean }).indexSortedProven).toBe(true);
    expect((first.series[0] as { indexSortedPointCount?: number }).indexSortedPointCount).toBe(n);

    const fullScanSpy = vi.spyOn(rewrite, 'isIndexSortedX');
    const second = resolveOptions(
      {
        series: [{ type: 'scatter', data: rawNPlus, sampling: 'lttb', samplingThreshold: threshold }],
        yAxis: { min: -5, max: 200 },
      },
      { previousResolved: first }
    );
    // N mismatch: sticky gate fails → cold isIndexSortedX must run for new N.
    expect(fullScanSpy).toHaveBeenCalled();
    // New N re-proved index-sorted at n+1 (not silent reuse of old sticky).
    expect((second.series[0] as { indexSortedProven?: boolean }).indexSortedProven).toBe(true);
    expect((second.series[0] as { indexSortedPointCount?: number }).indexSortedPointCount).toBe(n + 1);
    fullScanSpy.mockRestore();
  });

  it('sampling none: sticky continuity skips isIndexSortedX; Brownian clears', async () => {
    const rewrite = await import('../../data/seriesRewriteDetect');
    const n = 60;
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i + 1] as DataPoint);
    const rawBrownian: DataPoint[] = Array.from({ length: n }, (_, i) => [i * 0.1 + 0.3, i] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'none' }],
      yAxis: { min: -5, max: 200 },
    });
    expect((first.series[0] as { indexSortedProven?: boolean }).indexSortedProven).toBe(true);
    expect((first.series[0] as { indexSortedPointCount?: number }).indexSortedPointCount).toBe(n);

    const fullScanSpy = vi.spyOn(rewrite, 'isIndexSortedX');
    const second = resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'none' }],
        yAxis: { min: -5, max: 200 },
      },
      { previousResolved: first }
    );
    // Non-LTTB sticky + sampleLooksIndexSortedX path — no full re-proof.
    expect(fullScanSpy).not.toHaveBeenCalled();
    expect((second.series[0] as { indexSortedProven?: boolean }).indexSortedProven).toBe(true);
    fullScanSpy.mockRestore();

    const third = resolveOptions(
      {
        series: [{ type: 'scatter', data: rawBrownian, sampling: 'none' }],
        yAxis: { min: -5, max: 200 },
      },
      { previousResolved: second }
    );
    expect((third.series[0] as { indexSortedProven?: boolean }).indexSortedProven).toBeFalsy();
  });
});
