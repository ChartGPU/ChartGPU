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

  it('rejects non-cartesian streaming series', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'bar',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: raw,
      })
    ).toBe(false);
  });

  it('allows fixed-radius point scatter with sampling none', () => {
    const scatter = {
      type: 'scatter' as const,
      mode: 'points' as const,
      sampling: 'none' as const,
      symbolSize: 4,
    };
    expect(
      canRangedAppendLine({
        seriesType: 'scatter',
        sampling: 'none',
        kind: 'unknown',
        rawData: raw,
        series: scatter as any,
      })
    ).toBe(true);
    expect(
      canRangedAppendLine({
        seriesType: 'scatter',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: raw,
        series: scatter as any,
      })
    ).toBe(true);
    expect(
      canRangedAppendLine({
        seriesType: 'scatter',
        sampling: 'none',
        kind: 'unknown',
        rawData: raw,
        series: { ...scatter, symbolSize: undefined } as any,
      })
    ).toBe(true);
  });

  it('keeps a non-empty cold scatter seed until the first prepare', () => {
    const scatter = {
      type: 'scatter' as const,
      mode: 'points' as const,
      sampling: 'none' as const,
      symbolSize: 4,
    };
    expect(
      canRangedAppendLine({
        seriesType: 'scatter',
        sampling: 'none',
        kind: 'unknown',
        rawData: raw,
        appendedData: [{ x: [3], y: [4] }],
        series: scatter as any,
      })
    ).toBe(false);
    expect(
      canRangedAppendLine({
        seriesType: 'scatter',
        sampling: 'none',
        kind: 'unknown',
        rawData: { x: [], y: [] },
        appendedData: [{ x: [3], y: [4] }],
        series: scatter as any,
      })
    ).toBe(true);
  });

  it('rejects scatter paths that need private geometry', () => {
    const baseScatter = {
      type: 'scatter' as const,
      mode: 'points' as const,
      sampling: 'none' as const,
      symbolSize: 4,
    };
    const eligible = (overrides: Record<string, unknown>) =>
      canRangedAppendLine({
        seriesType: 'scatter',
        sampling: (overrides.sampling ?? 'none') as any,
        kind: 'unknown',
        rawData: raw,
        series: { ...baseScatter, ...overrides } as any,
      });

    expect(eligible({ mode: 'density' })).toBe(false);
    expect(eligible({ sampling: 'lttb' })).toBe(false);
    expect(eligible({ symbolSize: () => 4 })).toBe(false);
    expect(
      canRangedAppendLine({
        seriesType: 'scatter',
        sampling: 'none',
        kind: 'unknown',
        rawData: [
          [0, 1, 3],
          [1, 2, 5],
        ],
        series: baseScatter as any,
      })
    ).toBe(false);
    expect(
      canRangedAppendLine({
        seriesType: 'scatter',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: raw,
        appendedData: [
          [
            [3, 4, 9],
            [4, 5, 11],
          ],
        ],
        series: baseScatter as any,
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

describe('canRangedAppendLine — C1 connectNulls + M1 step', () => {
  it('rejects connectNulls even when sampling none / fullRawLine (C1)', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: raw,
        series: { type: 'line', sampling: 'none', connectNulls: true } as any,
      })
    ).toBe(false);
  });

  it('rejects cold unknown + connectNulls + sampling none (C1)', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'none',
        kind: 'unknown',
        rawData: raw,
        series: { type: 'line', sampling: 'none', connectNulls: true } as any,
      })
    ).toBe(false);
  });

  it('rejects step digital line for all step modes (M1)', () => {
    for (const step of [true, 'after', 'before', 'middle'] as const) {
      expect(
        canRangedAppendLine({
          seriesType: 'line',
          sampling: 'none',
          kind: 'unknown',
          rawData: raw,
          series: { type: 'line', sampling: 'none', step } as any,
        })
      ).toBe(false);
      expect(
        canRangedAppendLine({
          seriesType: 'line',
          sampling: 'none',
          kind: 'fullRawLine',
          rawData: raw,
          series: { type: 'line', sampling: 'none', step } as any,
        })
      ).toBe(false);
    }
  });

  it('allows step: false (linear) with sampling none', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: raw,
        series: { type: 'line', sampling: 'none', step: false } as any,
      })
    ).toBe(true);
  });

  it('rejects pure area with connectNulls (C1 area path)', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'area',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: raw,
        series: { type: 'area', sampling: 'none', connectNulls: true } as any,
      })
    ).toBe(false);
  });

  it('rejects pure area with step (M1 area path)', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'area',
        sampling: 'none',
        kind: 'unknown',
        rawData: raw,
        series: { type: 'area', sampling: 'none', step: true } as any,
      })
    ).toBe(false);
  });
});
