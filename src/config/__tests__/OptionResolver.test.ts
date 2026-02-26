import { describe, it, expect } from 'vitest';
import { resolveOptions } from '../OptionResolver';
import type { DataPoint } from '../types';
import { getPointCount } from '../../data/cartesianData';

describe('OptionResolver - connectNulls', () => {
  it('defaults connectNulls to false for line series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'line', data: [[0, 1], [1, 2]] }],
    });
    const series = resolved.series[0];
    expect(series.type).toBe('line');
    if (series.type === 'line') {
      expect(series.connectNulls).toBe(false);
    }
  });

  it('resolves connectNulls: true for line series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'line', data: [[0, 1], [1, 2]], connectNulls: true }],
    });
    const series = resolved.series[0];
    if (series.type === 'line') {
      expect(series.connectNulls).toBe(true);
    }
  });

  it('defaults connectNulls to false for area series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'area', data: [[0, 1], [1, 2]] }],
    });
    const series = resolved.series[0];
    expect(series.type).toBe('area');
    if (series.type === 'area') {
      expect(series.connectNulls).toBe(false);
    }
  });

  it('resolves connectNulls: true for area series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'area', data: [[0, 1], [1, 2]], connectNulls: true }],
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
      series: [{
        type: 'line',
        data: dataWithGaps,
        sampling: 'lttb',
        samplingThreshold: 5000,
      }],
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
      series: [{
        type: 'area',
        data: dataWithGaps,
        sampling: 'lttb',
        samplingThreshold: 5000,
      }],
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
      series: [{
        type: 'line',
        data,
        sampling: 'lttb',
        samplingThreshold: 5000,
      }],
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
      series: [{
        type: 'area',
        data,
        sampling: 'lttb',
        samplingThreshold: 5000,
      }],
    });
    const series = resolved.series[0];
    if (series.type === 'area') {
      expect(getPointCount(series.data)).toBeLessThanOrEqual(5000);
    }
  });
});
