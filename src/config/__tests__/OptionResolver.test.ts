import { describe, it, expect, vi } from 'vitest';
import {
  isCandlePrimaryChart,
  resolveOptions,
  resolveSeriesContentHash,
  type ResolvedSeriesConfig,
} from '../OptionResolver';
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
    const cheapSpy = vi.spyOn(seriesContentHashModule, 'cheapOHLCContentStamp');
    const second = resolveOptions(
      {
        series: [{ type: 'candlestick', data, sampling: 'none', color: '#f00' }],
        yAxis: { min: 0, max: 10 },
      },
      { previousResolved: first }
    );
    // Stable data ref reuses contentHash without restamping.
    expect(cheapSpy).not.toHaveBeenCalled();
    expect((second.series[0] as { contentHash?: number }).contentHash).toBe(
      (first.series[0] as { contentHash?: number }).contentHash
    );
    cheapSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('OptionResolver full series-array identity reuse (group 1 axes-only)', () => {
  it('reuses entire previous resolved series array when user series elements are stable', () => {
    const dataA: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const dataB: DataPoint[] = [
      [0, 3],
      [1, 4],
    ];
    const userSeries = [
      { type: 'line' as const, data: dataA, sampling: 'none' as const, color: '#f00' },
      { type: 'line' as const, data: dataB, sampling: 'none' as const, color: '#0f0' },
    ];
    const firstUser = {
      series: userSeries,
      xAxis: { min: 0, max: 10 },
      yAxis: { min: -10, max: 10 },
    };
    const first = resolveOptions(firstUser);
    const elementSnapshot = userSeries.slice();
    const secondUser = {
      series: userSeries, // same array identity
      xAxis: { min: 0, max: 10 },
      yAxis: { min: -20, max: 20 }, // axes-only change
    };
    const second = resolveOptions(secondUser, {
      previousResolved: first,
      previousUserOptions: firstUser,
      lastUserSeriesElements: elementSnapshot,
    });
    expect(second.series).toBe(first.series);
    expect(second.series[0]).toBe(first.series[0]);
    expect(second.series[1]).toBe(first.series[1]);
    // Axes still resolve to new values
    expect(second.yAxes[0]?.min).toBe(-20);
    expect(second.yAxes[0]?.max).toBe(20);
  });

  it('reuses when new outer array wraps the same element objects', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const s0 = { type: 'line' as const, data, sampling: 'none' as const, color: '#f00' };
    const firstUser = { series: [s0], yAxis: { min: 0, max: 1 } };
    const first = resolveOptions(firstUser);
    const secondUser = { series: [s0], yAxis: { min: 0, max: 2 } }; // new array, same element
    const second = resolveOptions(secondUser, {
      previousResolved: first,
      previousUserOptions: firstUser,
      lastUserSeriesElements: [s0],
    });
    expect(second.series).toBe(first.series);
  });

  it('does not reuse when user series element is replaced under stable outer array', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const userSeries: Array<{
      type: 'line';
      data: DataPoint[];
      sampling: 'none';
      color: string;
    }> = [{ type: 'line', data, sampling: 'none', color: '#f00' }];
    const firstUser = { series: userSeries, yAxis: { min: 0, max: 1 } };
    const first = resolveOptions(firstUser);
    const snapshot = userSeries.slice();
    // Element replace under same outer array
    userSeries[0] = {
      type: 'line',
      data: [
        [0, 9],
        [1, 8],
      ],
      sampling: 'none',
      color: '#00f',
    };
    const second = resolveOptions(
      { series: userSeries, yAxis: { min: 0, max: 2 } },
      {
        previousResolved: first,
        previousUserOptions: firstUser,
        lastUserSeriesElements: snapshot,
      }
    );
    expect(second.series).not.toBe(first.series);
    expect((second.series[0] as { color?: string }).color).toBe('#00f');
  });

  it('still reuses full series array when only series[i].data is replaced under stable element (immutable-element contract)', () => {
    // Full-array reuse keys on element identity, not deep data. Mutating/replacing
    // data under a stable element is the documented in-place contract (not detected).
    // Element replace is required for full-array miss; data-only change under same
    // element still reuses full array (same as prior contentHash path).
    const data1: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const s0 = { type: 'line' as const, data: data1 as DataPoint[], sampling: 'none' as const, color: '#f00' };
    const userSeries = [s0];
    const firstUser = { series: userSeries, yAxis: { min: 0, max: 1 } };
    const first = resolveOptions(firstUser);
    const snapshot = userSeries.slice();
    // Property replace under same element object — still full-array reuse (immutable contract).
    (s0 as { data: DataPoint[] }).data = [
      [0, 99],
      [1, 98],
    ];
    const second = resolveOptions(
      { series: userSeries, yAxis: { min: 0, max: 2 } },
      {
        previousResolved: first,
        previousUserOptions: firstUser,
        lastUserSeriesElements: snapshot,
      }
    );
    // Full-array path still hits (element identity stable) — consumer must replace element.
    expect(second.series).toBe(first.series);
  });

  it('reuses resolved theme identity when user theme/palette refs are unchanged (axes-only)', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const userSeries = [{ type: 'line' as const, data, sampling: 'none' as const, color: '#f00' }];
    const firstUser = { series: userSeries, theme: 'dark' as const, yAxis: { min: 0, max: 1 } };
    const first = resolveOptions(firstUser);
    const second = resolveOptions(
      { series: userSeries, theme: 'dark' as const, yAxis: { min: -10, max: 10 } },
      {
        previousResolved: first,
        previousUserOptions: firstUser,
        lastUserSeriesElements: userSeries.slice(),
      }
    );
    expect(second.theme).toBe(first.theme);
    expect(second.series).toBe(first.series);
  });

  it('does not reuse resolved theme when user theme identity changes', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const userSeries = [{ type: 'line' as const, data, sampling: 'none' as const, color: '#f00' }];
    const firstUser = { series: userSeries, theme: 'dark' as const, yAxis: { min: 0, max: 1 } };
    const first = resolveOptions(firstUser);
    const second = resolveOptions(
      { series: userSeries, theme: 'light' as const, yAxis: { min: 0, max: 2 } },
      {
        previousResolved: first,
        previousUserOptions: firstUser,
        lastUserSeriesElements: userSeries.slice(),
      }
    );
    expect(second.theme).not.toBe(first.theme);
  });

  it('does not reuse when theme identity changes', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const userSeries = [{ type: 'line' as const, data, sampling: 'none' as const, color: '#f00' }];
    const firstUser = { series: userSeries, theme: 'dark' as const, yAxis: { min: 0, max: 1 } };
    const first = resolveOptions(firstUser);
    const second = resolveOptions(
      { series: userSeries, theme: 'light' as const, yAxis: { min: 0, max: 2 } },
      {
        previousResolved: first,
        previousUserOptions: firstUser,
        lastUserSeriesElements: userSeries.slice(),
      }
    );
    expect(second.series).not.toBe(first.series);
  });

  it('does not reuse when palette identity changes', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const userSeries = [{ type: 'line' as const, data, sampling: 'none' as const }];
    const paletteA = ['#f00', '#0f0'];
    const paletteB = ['#00f', '#ff0'];
    const firstUser = { series: userSeries, palette: paletteA, yAxis: { min: 0, max: 1 } };
    const first = resolveOptions(firstUser);
    const second = resolveOptions(
      { series: userSeries, palette: paletteB, yAxis: { min: 0, max: 2 } },
      {
        previousResolved: first,
        previousUserOptions: firstUser,
        lastUserSeriesElements: userSeries.slice(),
      }
    );
    expect(second.series).not.toBe(first.series);
  });

  it('does not reuse when previousUserOptions is omitted', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const userSeries = [{ type: 'line' as const, data, sampling: 'none' as const, color: '#f00' }];
    const firstUser = { series: userSeries, yAxis: { min: 0, max: 1 } };
    const first = resolveOptions(firstUser);
    const second = resolveOptions(
      { series: userSeries, yAxis: { min: 0, max: 2 } },
      { previousResolved: first, lastUserSeriesElements: userSeries.slice() }
    );
    expect(second.series).not.toBe(first.series);
  });

  it('does not reuse same outer array when lastUserSeriesElements snapshot is omitted (fail closed)', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const userSeries = [{ type: 'line' as const, data, sampling: 'none' as const, color: '#f00' }];
    const firstUser = { series: userSeries, yAxis: { min: 0, max: 1 } };
    const first = resolveOptions(firstUser);
    const second = resolveOptions(
      { series: userSeries, yAxis: { min: 0, max: 2 } },
      { previousResolved: first, previousUserOptions: firstUser }
      // no lastUserSeriesElements — same-array element compare would be tautological
    );
    expect(second.series).not.toBe(first.series);
  });

  it('does not reuse when element objects differ (new series configs)', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const firstUser = {
      series: [{ type: 'line' as const, data, sampling: 'none' as const, color: '#f00' }],
      yAxis: { min: 0, max: 1 },
    };
    const first = resolveOptions(firstUser);
    const secondUser = {
      series: [{ type: 'line' as const, data, sampling: 'none' as const, color: '#f00' }],
      yAxis: { min: 0, max: 2 },
    };
    const second = resolveOptions(secondUser, {
      previousResolved: first,
      previousUserOptions: firstUser,
      lastUserSeriesElements: firstUser.series.slice(),
    });
    expect(second.series).not.toBe(first.series);
  });
});

describe('OptionResolver full series rewrite path', () => {
  it('uses cheapCartesianContentStamp when data ref changes', () => {
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
    const cheapSpy = vi.spyOn(seriesContentHashModule, 'cheapCartesianContentStamp');
    const second = resolveOptions(
      {
        series: [{ type: 'scatter', data: b, sampling: 'none' }],
        xAxis: { min: 0, max: 10 },
        yAxis: { min: 0, max: 10 },
      },
      { previousResolved: first }
    );
    expect(cheapSpy).toHaveBeenCalled();
    expect((second.series[0] as { contentHash?: number }).contentHash).not.toBe(
      (first.series[0] as { contentHash?: number }).contentHash
    );
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
    const cheapSpy = vi.spyOn(seriesContentHashModule, 'cheapOHLCContentStamp');
    resolveOptions({ series: [{ type: 'candlestick', data: b, sampling: 'none' }] }, { previousResolved: first });
    expect(cheapSpy).toHaveBeenCalled();
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

  it('defaults performance.lod to auto and preserves explicit strict (issue 9)', () => {
    const def = resolveOptions({
      series: [{ type: 'scatter', data: [[0, 1]], sampling: 'none' }],
    });
    expect(def.performance.lod).toBe('auto');

    const strict = resolveOptions({
      series: [{ type: 'scatter', data: [[0, 1]], sampling: 'none' }],
      performance: { lod: 'strict' },
    });
    expect(strict.performance.lod).toBe('strict');
  });

  it('performance.lod strict forces full LTTB and picks new peak; auto freezes indices (issue 2.3)', async () => {
    const rewrite = await import('../../data/seriesRewriteDetect');
    const { getY, getPointCount, getX } = await import('../../data/cartesianData');
    const n = 50;
    const threshold = 10;
    const rawA: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);

    const first = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'lttb', samplingThreshold: threshold }],
      yAxis: { min: -5, max: 1000 },
      performance: { lod: 'auto' },
    });
    const firstSampled = (first.series[0] as { data: DataPoint[] }).data;
    const firstIndices = new Set<number>();
    for (let i = 0; i < getPointCount(firstSampled); i++) {
      firstIndices.add(Math.round(getX(firstSampled, i)));
    }
    // Pick an interior index NOT retained by first LTTB sample for the y spike.
    let spikeIdx = -1;
    for (let i = 1; i < n - 1; i++) {
      if (!firstIndices.has(i)) {
        spikeIdx = i;
        break;
      }
    }
    expect(spikeIdx).toBeGreaterThan(0);

    const rawB: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i + 10] as DataPoint);
    rawB[spikeIdx] = [spikeIdx, 999];

    const remapSpy = vi.spyOn(rewrite, 'remapIndexSortedSampleY');

    // Auto: remap freezes indices → spike at unretained index absent from sample.
    const autoSecond = resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'lttb', samplingThreshold: threshold }],
        yAxis: { min: -5, max: 1000 },
        performance: { lod: 'auto' },
      },
      { previousResolved: first }
    );
    expect(remapSpy).toHaveBeenCalled();
    const autoSampled = (autoSecond.series[0] as { data: DataPoint[] }).data;
    let autoHasSpike = false;
    for (let i = 0; i < getPointCount(autoSampled); i++) {
      if (getY(autoSampled, i) === 999) autoHasSpike = true;
    }
    expect(autoHasSpike).toBe(false);
    remapSpy.mockClear();

    const firstStrict = resolveOptions({
      series: [{ type: 'scatter', data: rawA, sampling: 'lttb', samplingThreshold: threshold }],
      yAxis: { min: -5, max: 1000 },
      performance: { lod: 'strict' },
    });
    const strictSecond = resolveOptions(
      {
        series: [{ type: 'scatter', data: rawB, sampling: 'lttb', samplingThreshold: threshold }],
        yAxis: { min: -5, max: 1000 },
        performance: { lod: 'strict' },
      },
      { previousResolved: firstStrict }
    );
    // Strict: full LTTB, no frozen remap — new peak must appear.
    expect(remapSpy).not.toHaveBeenCalled();
    const strictSampled = (strictSecond.series[0] as { data: DataPoint[] }).data;
    let strictHasSpike = false;
    for (let i = 0; i < getPointCount(strictSampled); i++) {
      if (getY(strictSampled, i) === 999) strictHasSpike = true;
    }
    expect(strictHasSpike).toBe(true);
    remapSpy.mockRestore();
  });
});

describe('isCandlePrimaryChart', () => {
  it('returns false for empty options / empty series', () => {
    expect(isCandlePrimaryChart({})).toBe(false);
    expect(isCandlePrimaryChart({ series: [] })).toBe(false);
  });

  it('returns true when first series is candlestick', () => {
    expect(
      isCandlePrimaryChart({
        series: [{ type: 'candlestick', data: [[0, 1, 1, 1, 1]] }],
      })
    ).toBe(true);
  });

  it('returns false when first series is line', () => {
    expect(
      isCandlePrimaryChart({
        series: [{ type: 'line', data: [[0, 1]] }],
      })
    ).toBe(false);
  });

  it('returns false when candlestick is not first', () => {
    expect(
      isCandlePrimaryChart({
        series: [
          { type: 'line', data: [[0, 1]] },
          { type: 'candlestick', data: [[0, 1, 1, 1, 1]] },
        ],
      })
    ).toBe(false);
  });
});

describe('OptionResolver - candle-primary Y-axis and grid defaults', () => {
  const candleSeries = {
    type: 'candlestick' as const,
    data: [[1_700_000_000_000, 100, 101, 99, 102]] as const satisfies ReadonlyArray<OHLCDataPoint>,
  };

  it('defaults first Y position to right and gutters left=20 / right=70 when unset', () => {
    const resolved = resolveOptions({ series: [candleSeries] });
    expect(resolved.yAxes[0]!.position).toBe('right');
    expect(resolved.grid.left).toBe(20);
    expect(resolved.grid.right).toBe(70);
    // Non-gutter keys still use standard defaults
    expect(resolved.grid.top).toBe(40);
    expect(resolved.grid.bottom).toBe(40);
  });

  it('honors explicit yAxis.position left', () => {
    const resolved = resolveOptions({
      series: [candleSeries],
      yAxis: { type: 'value', position: 'left' },
    });
    expect(resolved.yAxes[0]!.position).toBe('left');
    // Left Y remains → dual-Y-safe left gutter 60; right still soft-defaults to 70
    expect(resolved.grid.left).toBe(60);
    expect(resolved.grid.right).toBe(70);
  });

  it('soft-sets only unset grid keys (user left only → keep left, right 70)', () => {
    const resolved = resolveOptions({
      series: [candleSeries],
      grid: { left: 80 },
    });
    expect(resolved.grid.left).toBe(80);
    expect(resolved.grid.right).toBe(70);
    expect(resolved.yAxes[0]!.position).toBe('right');
  });

  it('soft-sets only unset grid keys (user right only → keep right, left 20)', () => {
    const resolved = resolveOptions({
      series: [candleSeries],
      grid: { right: 90 },
    });
    expect(resolved.grid.left).toBe(20);
    expect(resolved.grid.right).toBe(90);
  });

  it('honors both explicit grid margins', () => {
    const resolved = resolveOptions({
      series: [candleSeries],
      grid: { left: 12, right: 34 },
    });
    expect(resolved.grid.left).toBe(12);
    expect(resolved.grid.right).toBe(34);
  });

  it('dual-Y with left secondary keeps left gutter 60 and right 70', () => {
    const resolved = resolveOptions({
      series: [
        { ...candleSeries, yAxis: 'price' },
        { type: 'bar', data: [[0, 10]], yAxis: 'vol' },
      ],
      axes: {
        y: [
          { id: 'price', type: 'value' }, // position unset → right (first Y, candle-primary)
          { id: 'vol', type: 'value' }, // position unset → left (secondary)
        ],
      },
    });
    expect(resolved.yAxes[0]!.position).toBe('right');
    expect(resolved.yAxes[1]!.position).toBe('left');
    expect(resolved.grid.left).toBe(60);
    expect(resolved.grid.right).toBe(70);
  });

  it('does not flip secondary Y position when first is candle-primary', () => {
    const resolved = resolveOptions({
      series: [candleSeries],
      axes: {
        y: [
          { id: 'price', type: 'value', position: 'right' },
          { id: 'vol', type: 'value' }, // must stay left default
        ],
      },
    });
    expect(resolved.yAxes[1]!.position).toBe('left');
  });

  it('non-candle charts keep default left Y and left-biased gutters', () => {
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
    expect(resolved.yAxes[0]!.position).toBe('left');
    expect(resolved.grid.left).toBe(60);
    expect(resolved.grid.right).toBe(20);
  });

  it('candle-not-first is not candle-primary (left Y, standard gutters)', () => {
    const resolved = resolveOptions({
      series: [{ type: 'line', data: [[0, 1]] }, candleSeries],
    });
    expect(isCandlePrimaryChart({ series: [{ type: 'line', data: [[0, 1]] }, candleSeries] })).toBe(false);
    expect(resolved.yAxes[0]!.position).toBe('left');
    expect(resolved.grid.left).toBe(60);
    expect(resolved.grid.right).toBe(20);
  });

  it('applies right default via synthetic y when both yAxis and axes.y omitted', () => {
    const resolved = resolveOptions({ series: [candleSeries] });
    expect(resolved.yAxes).toHaveLength(1);
    expect(resolved.yAxes[0]!.id).toBe('y');
    expect(resolved.yAxes[0]!.position).toBe('right');
  });

  it('dual-Y with both axes on right yields left gutter 20 (no left Y)', () => {
    const resolved = resolveOptions({
      series: [
        { ...candleSeries, yAxis: 'price' },
        { type: 'bar', data: [[0, 10]], yAxis: 'vol' },
      ],
      axes: {
        y: [
          { id: 'price', type: 'value', position: 'right' },
          { id: 'vol', type: 'value', position: 'right' },
        ],
      },
    });
    expect(resolved.yAxes.every((a) => a.position === 'right')).toBe(true);
    expect(resolved.grid.left).toBe(20);
    expect(resolved.grid.right).toBe(70);
  });

  it('preserves grid.left: 0 (nullish only — zero is not missing)', () => {
    const resolved = resolveOptions({
      series: [candleSeries],
      grid: { left: 0 },
    });
    expect(resolved.grid.left).toBe(0);
    expect(resolved.grid.right).toBe(70);
  });

  it('axes.y-only single axis defaults first Y to right with left 20 / right 70', () => {
    const resolved = resolveOptions({
      series: [candleSeries],
      axes: {
        y: [{ id: 'price', type: 'value' }],
      },
    });
    expect(resolved.yAxes).toHaveLength(1);
    expect(resolved.yAxes[0]!.id).toBe('price');
    expect(resolved.yAxes[0]!.position).toBe('right');
    expect(resolved.grid.left).toBe(20);
    expect(resolved.grid.right).toBe(70);
  });
});
