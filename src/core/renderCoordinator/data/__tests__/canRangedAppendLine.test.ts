/**
 * Pure ranged-append eligibility (replaces structural canUseFastPathKind greps).
 */

import { describe, it, expect } from 'vitest';
import { canRangedAppendLine } from '../canRangedAppendLine';
import type { ResolvedSeriesConfig } from '../../../../config/OptionResolver';

const lineNone = {
  type: 'line' as const,
  sampling: 'none' as const,
};

const lineLttb = {
  type: 'line' as const,
  sampling: 'lttb' as const,
  samplingThreshold: 2500,
};

const raw = { x: [0, 1, 2], y: [1, 2, 3] };

describe('canRangedAppendLine', () => {
  it('allows fullRawLine at any zoom (sampling none)', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: raw,
        series: lineNone as Pick<ResolvedSeriesConfig, 'type' | 'sampling'>,
      })
    ).toBe(true);
  });

  it('allows gpuDecimationRaw when GPU-eligible raw is present', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'lttb',
        kind: 'gpuDecimationRaw',
        rawData: raw,
        series: lineLttb as Pick<ResolvedSeriesConfig, 'type' | 'sampling' | 'samplingThreshold'>,
      })
    ).toBe(true);
  });

  it('unlocks cold unknown + sampling none before first prepare tags kind', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'none',
        kind: 'unknown',
        rawData: raw,
        series: lineNone as Pick<ResolvedSeriesConfig, 'type' | 'sampling'>,
      })
    ).toBe(true);
  });

  it('unlocks cold unknown + GPU-eligible lttb', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'lttb',
        kind: 'unknown',
        rawData: raw,
        series: lineLttb as Pick<ResolvedSeriesConfig, 'type' | 'sampling' | 'samplingThreshold'>,
      })
    ).toBe(true);
  });

  it('rejects other (sampled/private pack) kind', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'none',
        kind: 'other',
        rawData: raw,
        series: lineNone as Pick<ResolvedSeriesConfig, 'type' | 'sampling'>,
      })
    ).toBe(false);
  });

  it('rejects non-line non-area series', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'scatter',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: raw,
      })
    ).toBe(false);
  });

  it('allows pure area with sampling none (streaming full-raw resident)', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'area',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: raw,
        series: { type: 'area', sampling: 'none' } as Pick<ResolvedSeriesConfig, 'type' | 'sampling'>,
      })
    ).toBe(true);
  });

  it('unlocks cold unknown + area + sampling none', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'area',
        sampling: 'none',
        kind: 'unknown',
        rawData: raw,
        series: { type: 'area', sampling: 'none' } as Pick<ResolvedSeriesConfig, 'type' | 'sampling'>,
      })
    ).toBe(true);
  });

  it('rejects pure area with lttb when kind is unknown (no GPU decimation for area)', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'area',
        sampling: 'lttb',
        kind: 'unknown',
        rawData: raw,
        series: { type: 'area', sampling: 'lttb' } as Pick<ResolvedSeriesConfig, 'type' | 'sampling'>,
      })
    ).toBe(false);
  });

  it('rejects line with average sampling when kind is unknown', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'average',
        kind: 'unknown',
        rawData: raw,
        series: { type: 'line', sampling: 'average' } as Pick<ResolvedSeriesConfig, 'type' | 'sampling'>,
      })
    ).toBe(false);
  });
});

it('rejects stacked mountain line+areaStyle even when sampling none / fullRawLine', () => {
  const stacked = {
    type: 'line' as const,
    sampling: 'none' as const,
    stack: 'traffic',
    areaStyle: { opacity: 0.85 },
  };
  expect(
    canRangedAppendLine({
      seriesType: 'line',
      sampling: 'none',
      kind: 'fullRawLine',
      rawData: raw,
      series: stacked as any,
    })
  ).toBe(false);
});

it('rejects stacked pure area', () => {
  expect(
    canRangedAppendLine({
      seriesType: 'area',
      sampling: 'none',
      kind: 'unknown',
      rawData: raw,
      series: { type: 'area', sampling: 'none', stack: 'm' } as any,
    })
  ).toBe(false);
});

it('allows stroke-only line with inert stack (no areaStyle)', () => {
  expect(
    canRangedAppendLine({
      seriesType: 'line',
      sampling: 'none',
      kind: 'fullRawLine',
      rawData: raw,
      series: { type: 'line', sampling: 'none', stack: 'm' } as any,
    })
  ).toBe(true);
});
