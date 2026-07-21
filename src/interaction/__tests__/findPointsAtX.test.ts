import { describe, it, expect } from 'vitest';
import { findPointsAtX } from '../findPointsAtX';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedSeriesConfig } from '../../config/OptionResolver';

describe('findPointsAtX band', () => {
  it('returns nearest band sample by screen x', () => {
    const data = {
      x: [1, 2, 3, 4, 5],
      y: [0, 0, 0, 0, 0],
      y1: [1, 2, 3, 4, 5],
    };
    const series: ResolvedSeriesConfig[] = [
      {
        type: 'band',
        data,
        color: '#0af',
        visible: true,
        connectNulls: false,
        sampling: 'none',
        samplingThreshold: 5000,
        yAxis: 'y',
        rawData: data,
        areaStyle: { color: '#0af', opacity: 0.2 },
      } as any,
    ];
    const xScale = createLinearScale().domain(0, 6).range(0, 600);
    const matches = findPointsAtX(series, xScale.scale(3.2), xScale);
    expect(matches.length).toBe(1);
    expect(matches[0]!.seriesIndex).toBe(0);
    expect(matches[0]!.dataIndex).toBe(2);
    expect(matches[0]!.point).toEqual([3, 0]);
  });

  it('skips invisible band series', () => {
    const data = { x: [1, 2], y: [0, 0], y1: [1, 1] };
    const series: ResolvedSeriesConfig[] = [
      {
        type: 'band',
        data,
        visible: false,
        color: '#0af',
        connectNulls: false,
        sampling: 'none',
        samplingThreshold: 5000,
        yAxis: 'y',
        rawData: data,
        areaStyle: { color: '#0af', opacity: 0.2 },
      } as any,
    ];
    const xScale = createLinearScale().domain(0, 3).range(0, 300);
    expect(findPointsAtX(series, xScale.scale(1), xScale)).toEqual([]);
  });
});

describe('findPointsAtX impulse', () => {
  it('returns nearest impulse sample by screen x', () => {
    const data = { x: [1, 2, 3, 4, 5], y: [2, 4, 1, 3, 0] };
    const series: ResolvedSeriesConfig[] = [
      {
        type: 'impulse',
        data,
        rawData: data,
        color: '#a78bfa',
        visible: true,
        baseline: 0,
        lineStyle: { width: 2, opacity: 1, color: '#a78bfa' },
        showMarker: true,
        symbolSize: 6,
        sampling: 'none',
        samplingThreshold: 5000,
        yAxis: 'y',
      } as any,
    ];
    const xScale = createLinearScale().domain(0, 6).range(0, 600);
    const matches = findPointsAtX(series, xScale.scale(3.2), xScale);
    expect(matches.length).toBe(1);
    expect(matches[0]!.seriesIndex).toBe(0);
    expect(matches[0]!.dataIndex).toBe(2);
    expect(matches[0]!.point).toEqual([3, 1]);
  });

  it('skips invisible and empty impulse series', () => {
    const data = { x: [1, 2], y: [1, 2] };
    const series: ResolvedSeriesConfig[] = [
      {
        type: 'impulse',
        data,
        rawData: data,
        visible: false,
        color: '#a',
        baseline: 0,
        lineStyle: { width: 2, opacity: 1, color: '#a' },
        showMarker: true,
        symbolSize: 6,
        sampling: 'none',
        samplingThreshold: 5000,
        yAxis: 'y',
      } as any,
      {
        type: 'impulse',
        data: { x: [], y: [] },
        rawData: { x: [], y: [] },
        visible: true,
        color: '#b',
        baseline: 0,
        lineStyle: { width: 2, opacity: 1, color: '#b' },
        showMarker: true,
        symbolSize: 6,
        sampling: 'none',
        samplingThreshold: 5000,
        yAxis: 'y',
      } as any,
    ];
    const xScale = createLinearScale().domain(0, 3).range(0, 300);
    expect(findPointsAtX(series, xScale.scale(1), xScale)).toEqual([]);
  });
});
