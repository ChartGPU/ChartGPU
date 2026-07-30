/**
 * H2 — Eligibility agreement matrix across the three coordinator call sites.
 *
 * Sites:
 *  1. Baseline / setOptions: resolveCartesianDisplayData → isGpuDecimationEligible(series, fullRaw)
 *  2. Zoom recompute: resolveZoomedSeriesEntry → isGpuDecimationEligible(series, fullRawCartesian)
 *  3. prepareSeries: isPrepareSeriesGpuDecimationEligible (production gate helper)
 *
 * The pure predicate is the single source of truth. Extra prepareSeries gates for
 * runtime stacked geometry map entries must never *enable* GPU when the predicate
 * is false; they may only add a hard-disable when stack geometry is already built.
 */

import { describe, it, expect } from 'vitest';
import { isGpuDecimationEligible } from '../gpuDecimationEligibility';
import { isPrepareSeriesGpuDecimationEligible } from '../gpuDecimationPrepareGate';
import { resolveCartesianDisplayData } from '../../core/renderCoordinator/data/resolveSeriesDisplayData';
import { resolveZoomedSeriesEntry, buildRuntimeBaseSeries } from '../../core/renderCoordinator/data/seriesPipeline';
import { resolveStepMode } from '../stepGeometry';
import type { ResolvedSeriesConfig } from '../../config/OptionResolver';
import type { CartesianSeriesData } from '../../config/types';

function makeLineSeries(overrides: Partial<ResolvedSeriesConfig> = {}): ResolvedSeriesConfig {
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

const finiteRaw: CartesianSeriesData = {
  x: Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  y: Float64Array.from([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]),
};

const gappedDataPoint = [[0, 1], null, [2, 3], [3, 4]] as unknown as CartesianSeriesData;
const gappedXy: CartesianSeriesData = {
  x: [0, Number.NaN, 2, 3],
  y: [1, Number.NaN, 3, 4],
};

function baselineKeepsRaw(series: ResolvedSeriesConfig, raw: CartesianSeriesData): boolean {
  const display = resolveCartesianDisplayData({ series, raw, mode: 'baseline' });
  return display === raw;
}

function zoomKeepsRaw(series: ResolvedSeriesConfig, raw: CartesianSeriesData): boolean {
  const r = resolveZoomedSeriesEntry({
    series,
    rawSlot: raw,
    bufferedMin: 2,
    bufferedMax: 8,
    visibleMin: 3,
    visibleMax: 7,
    spanFraction: 0.4,
    sliceX: (data, min, max) => {
      const any = data as { x?: ArrayLike<number>; y?: ArrayLike<number> };
      if (any.x && any.y) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (let i = 0; i < any.x.length; i++) {
          const x = any.x[i]!;
          if (x >= min && x <= max) {
            xs.push(x);
            ys.push(any.y[i]!);
          }
        }
        return { x: xs, y: ys } as CartesianSeriesData;
      }
      if (Array.isArray(data)) {
        return (data as ReadonlyArray<{ x?: number } | readonly [number, number] | null>).filter((p) => {
          if (p == null) return false;
          const x = Array.isArray(p) ? p[0] : (p as { x: number }).x;
          return typeof x === 'number' && x >= min && x <= max;
        }) as CartesianSeriesData;
      }
      return data;
    },
    sliceOHLC: (d) => d,
  });
  return r.series.data === raw && r.series.rawData === raw;
}

type Fixture = {
  readonly name: string;
  readonly series: ResolvedSeriesConfig;
  readonly raw: CartesianSeriesData | null;
  readonly expectGpu: boolean;
  readonly prepareExtras?: { hasStackGeometry?: boolean };
};

const fixtures: Fixture[] = [
  {
    name: 'lttb finite',
    series: makeLineSeries({ sampling: 'lttb' }),
    raw: finiteRaw,
    expectGpu: true,
  },
  {
    name: 'min finite',
    series: makeLineSeries({ sampling: 'min' }),
    raw: finiteRaw,
    expectGpu: true,
  },
  {
    name: 'max finite',
    series: makeLineSeries({ sampling: 'max' }),
    raw: finiteRaw,
    expectGpu: true,
  },
  {
    name: 'none sampling',
    series: makeLineSeries({ sampling: 'none' }),
    raw: finiteRaw,
    expectGpu: false,
  },
  {
    name: 'average sampling',
    series: makeLineSeries({ sampling: 'average' }),
    raw: finiteRaw,
    expectGpu: false,
  },
  {
    name: 'step after',
    series: makeLineSeries({ sampling: 'lttb', step: 'after' } as Partial<ResolvedSeriesConfig>),
    raw: finiteRaw,
    expectGpu: false,
  },
  {
    name: 'step true',
    series: makeLineSeries({ sampling: 'lttb', step: true } as Partial<ResolvedSeriesConfig>),
    raw: finiteRaw,
    expectGpu: false,
  },
  {
    name: 'stacked mountain',
    series: makeLineSeries({
      sampling: 'lttb',
      stack: 's',
      areaStyle: { opacity: 0.5 },
    } as Partial<ResolvedSeriesConfig>),
    raw: finiteRaw,
    expectGpu: false,
  },
  {
    name: 'areaStyle only (eligible share path)',
    series: makeLineSeries({
      sampling: 'lttb',
      areaStyle: { opacity: 0.3 },
    } as Partial<ResolvedSeriesConfig>),
    raw: finiteRaw,
    expectGpu: true,
  },
  {
    name: 'null gaps DataPoint[]',
    series: makeLineSeries({ sampling: 'lttb' }),
    raw: gappedDataPoint,
    expectGpu: false,
  },
  {
    name: 'NaN gaps XY after promote',
    series: makeLineSeries({ sampling: 'lttb' }),
    raw: gappedXy,
    expectGpu: false,
  },
  {
    name: 'null raw',
    series: makeLineSeries({ sampling: 'lttb' }),
    raw: null,
    expectGpu: false,
  },
  {
    name: 'prepare stackGeom extra gate (intentional disable)',
    series: makeLineSeries({ sampling: 'lttb' }),
    raw: finiteRaw,
    expectGpu: true,
    prepareExtras: { hasStackGeometry: true },
  },
];

describe('GPU decimation eligibility agreement matrix (H2)', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      const predicate = isGpuDecimationEligible(f.series, f.raw as any);
      expect(predicate).toBe(f.expectGpu);

      if (f.raw != null) {
        // Site 1 — baseline keep-raw for paths that must retain full raw.
        // (Under-threshold CPU average/step/stack may still return raw identity
        // from sampleSeries — do not assert keeps=false there; zoom is the GPU lock.)
        const keeps = baselineKeepsRaw(f.series, f.raw);
        if (f.expectGpu || f.name === 'none sampling' || f.name.includes('null gaps') || f.name.includes('NaN gaps')) {
          expect(keeps).toBe(true);
        }

        // Site 2 — zoom recompute: GPU keep-raw vs non-GPU (except sampling none).
        const zoomKeeps = zoomKeepsRaw(f.series, f.raw);
        if (f.expectGpu) {
          expect(zoomKeeps).toBe(true);
        } else if (f.name === 'none sampling') {
          expect(zoomKeeps).toBe(true);
        } else {
          expect(zoomKeeps).toBe(false);
        }

        const base = buildRuntimeBaseSeries([f.series], [f.raw], [null]);
        if (f.expectGpu) {
          expect(base[0]!.data).toBe(f.raw);
        }
      }

      // Site 3 — production prepare gate (not a local mock).
      const stepMode = resolveStepMode(
        (f.series as { step?: boolean | string | null }).step as boolean | string | null | undefined
      );
      const prepare = isPrepareSeriesGpuDecimationEligible(f.series, f.raw, {
        hasStackGeometry: f.prepareExtras?.hasStackGeometry,
        stepMode,
      });
      if (f.prepareExtras?.hasStackGeometry) {
        // Extra gate disables prepare while pure predicate stays true.
        expect(predicate).toBe(true);
        expect(prepare).toBe(false);
      } else {
        expect(prepare).toBe(f.expectGpu);
      }
    });
  }

  it('gap outside zoom buffer still blocks GPU (full-raw eligibility, L1/H2)', () => {
    const raw: CartesianSeriesData = {
      x: [0, 1, 5, 6, 7, 8, 9],
      y: [Number.NaN, 1, 2, 3, 4, 5, 6],
    };
    const series = makeLineSeries({ sampling: 'lttb' });
    expect(isGpuDecimationEligible(series, raw)).toBe(false);
    expect(zoomKeepsRaw(series, raw)).toBe(false);
    expect(baselineKeepsRaw(series, raw)).toBe(true);
    expect(isPrepareSeriesGpuDecimationEligible(series, raw)).toBe(false);
  });

  it('prepare extra gate never enables when pure predicate is false', () => {
    const series = makeLineSeries({ sampling: 'average' });
    expect(isGpuDecimationEligible(series, finiteRaw)).toBe(false);
    expect(
      isPrepareSeriesGpuDecimationEligible(series, finiteRaw, {
        hasStackGeometry: false,
        stepMode: null,
      })
    ).toBe(false);
  });
});
