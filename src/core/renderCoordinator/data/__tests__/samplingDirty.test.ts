/**
 * P1-7: sampling dirty flags + presentation patch without re-sample.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  didSeriesDataLikelyChange,
  shouldRecomputeBaselineSampling,
  patchSeriesPresentationKeepingSampledData,
} from '../samplingDirty';
import {
  resolveOptions,
  canReuseResolvedSeriesSample,
  type ResolvedSeriesConfig,
} from '../../../../config/OptionResolver';
import * as sampleSeriesModule from '../../../../data/sampleSeries';
import * as seriesContentHashModule from '../../../../data/seriesContentHash';
import type { DataPoint } from '../../../../config/types';

/** Fixture contentHash — arbitrary stable number for dirty tests (not a full scan). */
function fixtureHash(data: ReadonlyArray<DataPoint>, salt = 0): number {
  return ((data.length * 2654435761) ^ salt) >>> 0;
}

function lineSeries(data: ReadonlyArray<DataPoint>, extra: Record<string, unknown> = {}): ResolvedSeriesConfig {
  const contentHash =
    typeof extra.contentHash === 'number' ? (extra.contentHash as number) : fixtureHash(data as DataPoint[]);
  return {
    type: 'line',
    name: 's',
    data,
    rawData: data,
    color: '#0af',
    lineStyle: { width: 2, opacity: 1, color: '#0af' },
    sampling: 'lttb',
    samplingThreshold: 5000,
    connectNulls: false,
    yAxis: 'y',
    visible: true,
    contentHash,
    ...extra,
  } as ResolvedSeriesConfig;
}

describe('samplingDirty predicates (P1-7)', () => {
  it('didSeriesDataLikelyChange is false for same data refs and same contentHash', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const h = fixtureHash(data);
    const a = [lineSeries(data, { contentHash: h })];
    const b = [lineSeries(data, { color: '#f00', name: 'renamed', contentHash: h })];
    expect(didSeriesDataLikelyChange(a, b)).toBe(false);
  });

  it('didSeriesDataLikelyChange is true when data ref changes', () => {
    const a = [
      lineSeries([
        [0, 1],
        [1, 2],
      ]),
    ];
    const b = [
      lineSeries([
        [0, 1],
        [1, 9],
      ]),
    ];
    expect(didSeriesDataLikelyChange(a, b)).toBe(true);
  });

  it('didSeriesDataLikelyChange is true when caller supplies differing contentHash under same ref', () => {
    // Public setOption identity-reuses contentHash for a stable data ref, so this
    // path only applies when hashes are supplied manually (tests / custom resolve).
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const a = [lineSeries(data, { contentHash: 111 })];
    const b = [lineSeries(data, { contentHash: 222 })];
    expect(didSeriesDataLikelyChange(a, b)).toBe(true);
  });

  it('compose resolve→didSeriesDataLikelyChange is false after in-place mutation under stable ref', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const first = resolveOptions({
      series: [{ type: 'line', data, sampling: 'none' }],
    });
    (data[1] as [number, number])[1] = 99;
    const second = resolveOptions({ series: [{ type: 'line', data, sampling: 'none' }] }, { previousResolved: first });
    expect(didSeriesDataLikelyChange(first.series, second.series)).toBe(false);
  });

  it('shouldRecomputeBaselineSampling is false for presentation-only', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const a = [lineSeries(data, { color: '#0af' })];
    const b = [lineSeries(data, { color: '#f0f', name: 'Theme update' })];
    expect(shouldRecomputeBaselineSampling(a, b)).toBe(false);
  });

  it('patchSeriesPresentationKeepingSampledData identity short-circuit returns same array', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const resolved = resolveOptions({
      series: [
        { type: 'line', data, sampling: 'none', color: '#f00' },
        { type: 'line', data, sampling: 'none', color: '#0f0' },
      ],
      yAxis: { min: 0, max: 1 },
    });
    // Simulate OptionResolver full series-array reuse (same object refs).
    const patched = patchSeriesPresentationKeepingSampledData(resolved.series, resolved.series);
    expect(patched).toBe(resolved.series);
  });

  it('patchSeriesPresentationKeepingSampledData does not full-reuse on partial element mismatch', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const a = resolveOptions({
      series: [
        { type: 'line', data, sampling: 'none', color: '#f00' },
        { type: 'line', data, sampling: 'none', color: '#0f0' },
      ],
      yAxis: { min: 0, max: 1 },
    });
    const b = resolveOptions({
      series: [
        { type: 'line', data, sampling: 'none', color: '#f00' },
        { type: 'line', data, sampling: 'none', color: '#00f' },
      ],
      yAxis: { min: 0, max: 1 },
    });
    // next[0] may differ by object identity from previous[0]; force partial:
    // share index 0 object, differ at index 1.
    const nextPartial = [a.series[0]!, b.series[1]!] as typeof a.series;
    const patched = patchSeriesPresentationKeepingSampledData(nextPartial, a.series);
    expect(patched).not.toBe(a.series);
    expect(patched[0]).toBe(a.series[0]); // identity reuse per-slot
    expect(patched[1]).not.toBe(a.series[1]);
  });

  it('patchSeriesPresentationKeepingSampledData reuses sampled data ref', () => {
    const raw: DataPoint[] = Array.from({ length: 100 }, (_, i) => [i, Math.sin(i)]);
    const sampled: DataPoint[] = [
      [0, 0],
      [50, 1],
      [99, 0],
    ];
    const h = fixtureHash(raw as DataPoint[]);
    const previous = [
      lineSeries(raw, {
        data: sampled,
        rawData: raw,
        color: '#0af',
        contentHash: h,
      }),
    ];
    const nextMeta = [
      lineSeries(raw, {
        data: raw, // would-be re-sampled placeholder
        rawData: raw,
        color: '#ff0',
        name: 'after theme',
        contentHash: h,
      }),
    ];
    const patched = patchSeriesPresentationKeepingSampledData(nextMeta, previous);
    expect(patched[0]!.color).toBe('#ff0');
    expect((patched[0] as { name?: string }).name).toBe('after theme');
    expect((patched[0] as { data: unknown }).data).toBe(sampled);
    expect((patched[0] as { rawData: unknown }).rawData).toBe(raw);
    expect((patched[0] as { contentHash?: number }).contentHash).toBe(h);
  });
});

describe('OptionResolver sample reuse (P1-7)', () => {
  it('reuses previous sampled data when raw ref, content, and sampling are unchanged', () => {
    const data: DataPoint[] = Array.from({ length: 200 }, (_, i) => [i, i % 17]);
    const first = resolveOptions({
      series: [{ type: 'line', data, sampling: 'lttb', samplingThreshold: 20 }],
    });
    const sampledRef = first.series[0]!.data;

    const spy = vi.spyOn(sampleSeriesModule, 'sampleSeriesDataPoints');
    const second = resolveOptions(
      {
        theme: 'light',
        series: [
          {
            type: 'line',
            data,
            sampling: 'lttb',
            samplingThreshold: 20,
            color: '#c0ffee',
          },
        ],
      },
      { previousResolved: first }
    );
    expect(spy).not.toHaveBeenCalled();
    expect(second.series[0]!.data).toBe(sampledRef);
    expect(second.series[0]!.color).toBe('#c0ffee');
    spy.mockRestore();
  });

  it('re-samples when data array identity changes', () => {
    const data1: DataPoint[] = Array.from({ length: 200 }, (_, i) => [i, i]);
    const data2: DataPoint[] = Array.from({ length: 200 }, (_, i) => [i, i * 2]);
    const first = resolveOptions({
      series: [{ type: 'line', data: data1, sampling: 'lttb', samplingThreshold: 20 }],
    });
    const spy = vi.spyOn(sampleSeriesModule, 'sampleSeriesDataPoints');
    resolveOptions(
      {
        series: [{ type: 'line', data: data2, sampling: 'lttb', samplingThreshold: 20 }],
      },
      { previousResolved: first }
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not re-hash or re-sample when values mutate in place under a stable ref', () => {
    // Contract: in-place mutation under a stable data reference is not detected
    // until a new data reference (or appendData) is provided. Axes-only / high-FPS
    // setOption paths depend on this O(1) identity reuse.
    const data: DataPoint[] = Array.from({ length: 200 }, (_, i) => [i, i]);
    const first = resolveOptions({
      series: [{ type: 'line', data, sampling: 'lttb', samplingThreshold: 20 }],
    });
    const firstSampled = first.series[0]!.data;
    const firstHash = (first.series[0] as { contentHash?: number }).contentHash;
    (data[50] as [number, number])[1] = 99999;

    const hashSpy = vi.spyOn(seriesContentHashModule, 'cheapCartesianContentStamp');
    const sampleSpy = vi.spyOn(sampleSeriesModule, 'sampleSeriesDataPoints');
    const second = resolveOptions(
      {
        series: [{ type: 'line', data, sampling: 'lttb', samplingThreshold: 20 }],
      },
      { previousResolved: first }
    );
    expect(hashSpy).not.toHaveBeenCalled();
    expect(sampleSpy).not.toHaveBeenCalled();
    expect(second.series[0]!.data).toBe(firstSampled);
    expect((second.series[0] as { contentHash?: number }).contentHash).toBe(firstHash);
    hashSpy.mockRestore();
    sampleSpy.mockRestore();
  });

  it('re-stamps and re-samples when a new data reference is provided after mutation', () => {
    const data: DataPoint[] = Array.from({ length: 200 }, (_, i) => [i, i]);
    const first = resolveOptions({
      series: [{ type: 'line', data, sampling: 'lttb', samplingThreshold: 20 }],
    });
    const firstSampled = first.series[0]!.data;
    const firstHash = (first.series[0] as { contentHash?: number }).contentHash;
    const firstBounds = (first.series[0] as { rawBounds?: unknown }).rawBounds;
    // Replace the array (new identity) so resolve must stamp / re-sample.
    const nextData: DataPoint[] = data.map((p, i) => (i === 50 ? [50, 99999] : ([p[0], p[1]] as DataPoint)));

    const cheapSpy = vi.spyOn(seriesContentHashModule, 'cheapCartesianContentStamp');
    const sampleSpy = vi.spyOn(sampleSeriesModule, 'sampleSeriesDataPoints');
    const second = resolveOptions(
      {
        series: [
          {
            type: 'line',
            data: nextData,
            sampling: 'lttb',
            samplingThreshold: 20,
          },
        ],
      },
      { previousResolved: first }
    );
    expect(cheapSpy).toHaveBeenCalled();
    expect(sampleSpy).toHaveBeenCalled();
    expect(second.series[0]!.data).not.toBe(firstSampled);
    expect((second.series[0] as { contentHash?: number }).contentHash).not.toBe(firstHash);
    // rawBounds must recompute (new object; y max reflects mutated value).
    const secondBounds = (
      second.series[0] as {
        rawBounds?: { yMin: number; yMax: number };
      }
    ).rawBounds;
    expect(secondBounds).not.toBe(firstBounds);
    expect(secondBounds?.yMax).toBeGreaterThanOrEqual(99999);
    cheapSpy.mockRestore();
    sampleSpy.mockRestore();
  });

  it('reuses contentHash without full scan on axes-only resolve (same data ref)', () => {
    const data: DataPoint[] = Array.from({ length: 5000 }, (_, i) => [i, Math.sin(i * 0.01)]);
    const first = resolveOptions({
      series: [
        {
          type: 'line',
          data,
          sampling: 'none',
          areaStyle: { opacity: 0.4 },
        },
      ],
      yAxis: { min: 0, max: 1 },
    });
    const firstHash = (first.series[0] as { contentHash?: number }).contentHash;
    const firstBounds = (
      first.series[0] as {
        rawBounds?: { xMin: number; xMax: number };
      }
    ).rawBounds;

    const hashSpy = vi.spyOn(seriesContentHashModule, 'cheapCartesianContentStamp');
    const second = resolveOptions(
      {
        series: [
          {
            type: 'line',
            data,
            sampling: 'none',
            areaStyle: { opacity: 0.4 },
            color: '#0af',
          },
        ],
        yAxis: { min: -1, max: 2 },
      },
      { previousResolved: first }
    );
    expect(hashSpy).not.toHaveBeenCalled();
    expect((second.series[0] as { contentHash?: number }).contentHash).toBe(firstHash);
    // x extent reused from data; y tracks current explicit axis (mode xDataYAxis).
    const secondBounds = (
      second.series[0] as {
        rawBounds?: { xMin: number; xMax: number; yMin: number; yMax: number };
      }
    ).rawBounds;
    expect(secondBounds?.xMin).toBe(firstBounds?.xMin);
    expect(secondBounds?.xMax).toBe(firstBounds?.xMax);
    expect(secondBounds?.yMin).toBe(-1);
    expect(secondBounds?.yMax).toBe(2);
    hashSpy.mockRestore();
  });

  it('reuses contentHash for bar series on stable data ref', () => {
    const data: DataPoint[] = Array.from({ length: 1000 }, (_, i) => [i, i % 7]);
    const first = resolveOptions({
      series: [{ type: 'bar', data, sampling: 'none' }],
    });
    const hashSpy = vi.spyOn(seriesContentHashModule, 'cheapCartesianContentStamp');
    const second = resolveOptions(
      {
        series: [{ type: 'bar', data, sampling: 'none', color: '#f00' }],
        yAxis: { min: 0, max: 10 },
      },
      { previousResolved: first }
    );
    expect(hashSpy).not.toHaveBeenCalled();
    expect((second.series[0] as { contentHash?: number }).contentHash).toBe(
      (first.series[0] as { contentHash?: number }).contentHash
    );
    hashSpy.mockRestore();
  });

  it('reuses contentHash but re-samples when samplingThreshold changes', () => {
    // Sampling change forces re-sample; content hash is content/identity-only.
    const data: DataPoint[] = Array.from({ length: 200 }, (_, i) => [i, i]);
    const first = resolveOptions({
      series: [{ type: 'line', data, sampling: 'lttb', samplingThreshold: 20 }],
    });
    const hashSpy = vi.spyOn(seriesContentHashModule, 'cheapCartesianContentStamp');
    const sampleSpy = vi.spyOn(sampleSeriesModule, 'sampleSeriesDataPoints');
    const second = resolveOptions(
      {
        series: [{ type: 'line', data, sampling: 'lttb', samplingThreshold: 50 }],
      },
      { previousResolved: first }
    );
    // Data ref stable → contentHash reuse (no full scan).
    expect(hashSpy).not.toHaveBeenCalled();
    // Sampling config changed → must re-sample.
    expect(sampleSpy).toHaveBeenCalled();
    expect((second.series[0] as { samplingThreshold?: number }).samplingThreshold).toBe(50);
    hashSpy.mockRestore();
    sampleSpy.mockRestore();
  });

  it('line areaStyle on/off under lttb marks sampling dirty (hash may reuse)', () => {
    const data: DataPoint[] = Array.from({ length: 200 }, (_, i) => [i, i]);
    const without = resolveOptions({
      series: [{ type: 'line', data, sampling: 'lttb', samplingThreshold: 20 }],
    });
    const withFill = resolveOptions(
      {
        series: [
          {
            type: 'line',
            data,
            sampling: 'lttb',
            samplingThreshold: 20,
            areaStyle: { opacity: 0.3, color: '#0af' },
          },
        ],
      },
      { previousResolved: without }
    );
    // Data identity stable: contentHash reused.
    expect((withFill.series[0] as { contentHash?: number }).contentHash).toBe(
      (without.series[0] as { contentHash?: number }).contentHash
    );
    // Eligibility-sensitive: sampling dirty flags treat areaStyle presence as config change.
    expect(shouldRecomputeBaselineSampling(without.series, withFill.series)).toBe(true);
  });
});

describe('didSeriesDataLikelyChange — heatmap', () => {
  const z = new Float32Array([1, 2, 3, 4]);
  function hm(extra: Record<string, unknown> = {}): ResolvedSeriesConfig {
    return {
      type: 'heatmap',
      name: 'h',
      data: {
        xStart: 0,
        xStep: 1,
        yStart: 0,
        yStep: 1,
        columns: 2,
        rows: 2,
        z,
        ...(extra.data as object),
      },
      colormap: 'viridis',
      zMin: 0,
      zMax: 1,
      zScale: 'linear',
      opacity: 1,
      cellAnchor: 'corner',
      nullHandling: 'transparent',
      cellGapPx: 0,
      yAxis: 'y',
      color: '#0af',
      drawable: true,
      cellCount: 4,
      visible: true,
      ...extra,
    } as ResolvedSeriesConfig;
  }

  it('same identity → false', () => {
    const a = hm();
    expect(didSeriesDataLikelyChange([a], [a])).toBe(false);
  });

  it('style-only with same data ref → false (presentation path)', () => {
    const a = hm();
    // Reuse same data object (style setOption keeps stream identity)
    const b = {
      ...a,
      name: 'h2',
      opacity: 0.5,
      colormap: 'inferno',
      zMin: -50,
      zMax: 0,
    } as ResolvedSeriesConfig;
    expect(didSeriesDataLikelyChange([a], [b])).toBe(false);
  });

  it('new data object identity (even same z buffer) → true', () => {
    const a = hm();
    const b = hm({ name: 'h2' }); // hm() builds a new data object each call
    expect(didSeriesDataLikelyChange([a], [b])).toBe(true);
  });

  it('z ref change → true', () => {
    const a = hm();
    const b = hm({
      data: {
        xStart: 0,
        xStep: 1,
        yStart: 0,
        yStep: 1,
        columns: 2,
        rows: 2,
        z: new Float32Array([9, 9, 9, 9]),
      },
    });
    expect(didSeriesDataLikelyChange([a], [b])).toBe(true);
  });

  it('dimension change → true', () => {
    const a = hm();
    const b = hm({
      data: {
        xStart: 0,
        xStep: 1,
        yStart: 0,
        yStep: 1,
        columns: 4,
        rows: 1,
        z,
      },
    });
    expect(didSeriesDataLikelyChange([a], [b])).toBe(true);
  });
});
