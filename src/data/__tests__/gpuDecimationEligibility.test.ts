import { describe, it, expect } from 'vitest';
import {
  isGpuDecimationEligible,
  mapSamplingToDecimationAlgorithm,
  GPU_DECIMATION_SAMPLING_MODES,
} from '../gpuDecimationEligibility';
import type { ResolvedSeriesConfig } from '../../config/OptionResolver';
import type { CartesianSeriesData } from '../../config/types';

function makeLineSeries(overrides: Partial<ResolvedSeriesConfig> = {}): ResolvedSeriesConfig {
  // Minimal realistic shape — only the fields the predicate reads must be
  // correct. Rest is filled with defensible defaults to satisfy the type.
  return {
    type: 'line',
    name: 'test',
    color: '#000',
    data: [],
    rawData: [],
    lineStyle: { width: 2, opacity: 1 },
    sampling: 'lttb',
    samplingThreshold: 4000,
    connectNulls: false,
    ...overrides,
  } as unknown as ResolvedSeriesConfig;
}

describe('isGpuDecimationEligible', () => {
  it('returns true for line series with `lttb` sampling and gap-free data', () => {
    const s = makeLineSeries({ sampling: 'lttb' });
    const data: CartesianSeriesData = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    expect(isGpuDecimationEligible(s, data)).toBe(true);
  });

  it('returns true for all three eligible sampling modes', () => {
    const data: CartesianSeriesData = [
      [0, 1],
      [1, 2],
    ];
    for (const mode of ['lttb', 'min', 'max'] as const) {
      const s = makeLineSeries({ sampling: mode });
      expect(isGpuDecimationEligible(s, data)).toBe(true);
    }
  });

  it('returns false for ineligible sampling modes', () => {
    const data: CartesianSeriesData = [
      [0, 1],
      [1, 2],
    ];
    for (const mode of ['none', 'average', 'ohlc'] as const) {
      const s = makeLineSeries({ sampling: mode });
      expect(isGpuDecimationEligible(s, data)).toBe(false);
    }
  });

  it('returns false for non-line series types', () => {
    const data: CartesianSeriesData = [
      [0, 1],
      [1, 2],
    ];
    const typesToReject = ['area', 'bar', 'scatter', 'pie', 'candlestick', 'heatmap', 'band'];
    for (const type of typesToReject) {
      const s = makeLineSeries({
        sampling: 'lttb',
        type: type as ResolvedSeriesConfig['type'],
      });
      expect(isGpuDecimationEligible(s, data)).toBe(false);
    }
  });

  it('returns false when the raw data contains null gaps', () => {
    const s = makeLineSeries({ sampling: 'lttb' });
    const data = [[0, 1], null, [2, 3]] as unknown as CartesianSeriesData;
    expect(isGpuDecimationEligible(s, data)).toBe(false);
  });

  it('allows line+areaStyle (shared storage / decimation path, issue 1.4)', () => {
    const s = makeLineSeries({
      sampling: 'lttb',
      areaStyle: { opacity: 0.3, color: '#0af' },
    } as Partial<ResolvedSeriesConfig>);
    const data: CartesianSeriesData = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    expect(isGpuDecimationEligible(s, data)).toBe(true);
  });

  it('treats Float32Array interleaved data as gap-free (no `null` entries possible)', () => {
    const s = makeLineSeries({ sampling: 'lttb' });
    const data: CartesianSeriesData = new Float32Array([0, 1, 1, 2, 2, 3]);
    expect(isGpuDecimationEligible(s, data)).toBe(true);
  });

  it('treats XYArraysData as gap-free (no `null` entries possible)', () => {
    const s = makeLineSeries({ sampling: 'lttb' });
    const data: CartesianSeriesData = {
      x: [0, 1, 2],
      y: [1, 2, 3],
    };
    expect(isGpuDecimationEligible(s, data)).toBe(true);
  });
});

describe('mapSamplingToDecimationAlgorithm', () => {
  it('returns the exact algorithm for the three eligible modes', () => {
    expect(mapSamplingToDecimationAlgorithm('lttb')).toBe('lttb');
    expect(mapSamplingToDecimationAlgorithm('min')).toBe('min');
    expect(mapSamplingToDecimationAlgorithm('max')).toBe('max');
  });

  it('returns null for modes with no GPU kernel', () => {
    expect(mapSamplingToDecimationAlgorithm('none')).toBeNull();
    expect(mapSamplingToDecimationAlgorithm('average')).toBeNull();
    expect(mapSamplingToDecimationAlgorithm('ohlc')).toBeNull();
  });
});

describe('GPU_DECIMATION_SAMPLING_MODES', () => {
  it('matches the set of modes that map to a non-null algorithm', () => {
    expect(GPU_DECIMATION_SAMPLING_MODES.has('lttb')).toBe(true);
    expect(GPU_DECIMATION_SAMPLING_MODES.has('min')).toBe(true);
    expect(GPU_DECIMATION_SAMPLING_MODES.has('max')).toBe(true);
    expect(GPU_DECIMATION_SAMPLING_MODES.has('none')).toBe(false);
    expect(GPU_DECIMATION_SAMPLING_MODES.has('average')).toBe(false);
    expect(GPU_DECIMATION_SAMPLING_MODES.has('ohlc')).toBe(false);
  });
});
