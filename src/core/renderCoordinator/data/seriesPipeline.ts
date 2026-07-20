/**
 * Series display pipeline — owns sample/raw resolution for coordinator recompute.
 *
 * Pure functions used by createRenderCoordinatorImpl for:
 * - baseline recompute (`mode: 'baseline'`)
 * - setOptions full-rewrite raw alignment (`mode: 'setOptionsReuse'`)
 * - zoomed recompute (`mode: 'zoomed'` with sample target + optional buffer slice)
 *
 * @module seriesPipeline
 * @internal
 */

import type { ResolvedChartGPUOptions, ResolvedSeriesConfig } from '../../../config/OptionResolver';
import type { CartesianSeriesData, OHLCDataPoint } from '../../../config/types';
import { isGpuDecimationEligible } from '../../../data/gpuDecimationEligibility';
import {
  resolveCartesianDisplayData,
  resolveCandlestickDisplayData,
  computeZoomSampleTarget,
} from './resolveSeriesDisplayData';

/** Runtime raw slot — any runtime series raw ref (columns, ring, staging, OHLC, empty). */
type RuntimeRawSlot = unknown;

type RawBoundsSlot =
  | Readonly<{
      xMin: number;
      xMax: number;
      yMin: number;
      yMax: number;
    }>
  | null
  | undefined;

/**
 * Build one baseline series entry (pie / candle / cartesian).
 */
function resolveBaselineSeriesEntry(
  s: ResolvedSeriesConfig,
  rawSlot: RuntimeRawSlot,
  boundsSlot: RawBoundsSlot
): ResolvedSeriesConfig {
  if (s.type === 'pie' || s.type === 'heatmap') return s;

  if (s.type === 'candlestick') {
    const anyS = s as ResolvedSeriesConfig & {
      rawData?: unknown;
      rawBounds?: RawBoundsSlot;
      sampling?: string;
      samplingThreshold?: number;
      data?: unknown;
    };
    const rawOHLC =
      (rawSlot as ReadonlyArray<OHLCDataPoint> | null | undefined) ??
      ((anyS.rawData ?? anyS.data) as ReadonlyArray<OHLCDataPoint>);
    const bounds = boundsSlot ?? anyS.rawBounds ?? undefined;
    const baselineSampled = resolveCandlestickDisplayData({
      sampling: anyS.sampling,
      samplingThreshold: anyS.samplingThreshold ?? 0,
      rawOHLC,
    });
    return {
      ...s,
      rawData: rawOHLC,
      rawBounds: bounds,
      data: baselineSampled,
    } as ResolvedSeriesConfig;
  }

  const anyS = s as ResolvedSeriesConfig & {
    rawData?: unknown;
    rawBounds?: RawBoundsSlot;
    sampling?: string;
    samplingThreshold?: number;
    data?: unknown;
  };
  const rawCartesian: CartesianSeriesData =
    (rawSlot as CartesianSeriesData | null | undefined) ?? ((anyS.rawData ?? anyS.data) as CartesianSeriesData);
  const bounds = boundsSlot ?? anyS.rawBounds ?? undefined;
  const baselineSampled = resolveCartesianDisplayData({
    series: s,
    raw: rawCartesian,
    mode: 'baseline',
  });
  return {
    ...s,
    rawData: rawCartesian,
    rawBounds: bounds,
    data: baselineSampled,
  } as ResolvedSeriesConfig;
}

/**
 * Full baseline recompute for all series indices.
 */
export function buildRuntimeBaseSeries(
  series: ResolvedChartGPUOptions['series'],
  runtimeRawDataByIndex: ReadonlyArray<RuntimeRawSlot>,
  runtimeRawBoundsByIndex: ReadonlyArray<RawBoundsSlot>
): ResolvedChartGPUOptions['series'] {
  const next: ResolvedSeriesConfig[] = new Array(series.length);
  for (let i = 0; i < series.length; i++) {
    next[i] = resolveBaselineSeriesEntry(series[i]!, runtimeRawDataByIndex[i], runtimeRawBoundsByIndex[i]);
  }
  return next as ResolvedChartGPUOptions['series'];
}

/**
 * setOptions full-rewrite path: align rawData/rawBounds; GPU-eligible forces raw on `data`,
 * otherwise keep OptionResolver-sampled `s.data` (setOptionsReuse).
 */
function resolveSetOptionsReuseSeriesEntry(
  s: ResolvedSeriesConfig,
  rawSlot: RuntimeRawSlot,
  boundsSlot: RawBoundsSlot
): ResolvedSeriesConfig {
  if (s.type === 'pie' || s.type === 'heatmap') return s;

  const anyS = s as ResolvedSeriesConfig & {
    rawData?: unknown;
    rawBounds?: RawBoundsSlot;
    data?: unknown;
  };
  if (s.type === 'candlestick') {
    const rawOHLC =
      (rawSlot as ReadonlyArray<OHLCDataPoint> | null | undefined) ??
      ((anyS.rawData ?? anyS.data) as ReadonlyArray<OHLCDataPoint>);
    return {
      ...s,
      rawData: rawOHLC,
      rawBounds: boundsSlot ?? anyS.rawBounds ?? undefined,
    } as ResolvedSeriesConfig;
  }

  const rawCartesian: CartesianSeriesData =
    (rawSlot as CartesianSeriesData | null | undefined) ?? ((anyS.rawData ?? anyS.data) as CartesianSeriesData);
  const bounds = boundsSlot ?? anyS.rawBounds ?? undefined;
  const display = resolveCartesianDisplayData({
    series: s,
    raw: rawCartesian,
    mode: 'setOptionsReuse',
  });
  return {
    ...s,
    rawData: rawCartesian,
    rawBounds: bounds,
    data: display,
  } as ResolvedSeriesConfig;
}

export function buildSetOptionsReuseSeries(
  series: ResolvedChartGPUOptions['series'],
  runtimeRawDataByIndex: ReadonlyArray<RuntimeRawSlot>,
  runtimeRawBoundsByIndex: ReadonlyArray<RawBoundsSlot>
): ResolvedChartGPUOptions['series'] {
  return series.map((s, i) =>
    resolveSetOptionsReuseSeriesEntry(s, runtimeRawDataByIndex[i], runtimeRawBoundsByIndex[i])
  ) as ResolvedChartGPUOptions['series'];
}

type ZoomedSeriesResult = {
  readonly series: ResolvedSeriesConfig;
  /** When set, caller should store into lastSampledData[i]. */
  readonly cacheEntry: {
    readonly data: CartesianSeriesData | ReadonlyArray<OHLCDataPoint>;
    readonly cachedRange: { readonly min: number; readonly max: number };
  } | null;
};

/**
 * One zoomed series entry.
 *
 * - GPU-eligible cartesian (`lttb`/`min`/`max` without null gaps): keep full raw;
 *   prepare scopes via visibleStart/End on the compute path.
 * - `sampling: 'none'`: also keep full raw. Zoom must not replace `data` with a
 *   visible slice — DataStore is tagged `fullRawLine` for ranged append, and
 *   uploading a windowed subset then append-streaming corrupts the buffer and
 *   makes right-side zoom show the wrong prefix (live-streaming regression).
 * - Other CPU sampling: sample a buffered X window at a zoom-scaled target.
 */
export function resolveZoomedSeriesEntry(input: {
  readonly series: ResolvedSeriesConfig;
  readonly rawSlot: RuntimeRawSlot;
  readonly bufferedMin: number;
  readonly bufferedMax: number;
  readonly visibleMin: number;
  readonly visibleMax: number;
  readonly spanFraction: number;
  readonly sliceX: (data: CartesianSeriesData, min: number, max: number) => CartesianSeriesData;
  readonly sliceOHLC: (data: ReadonlyArray<OHLCDataPoint>, min: number, max: number) => ReadonlyArray<OHLCDataPoint>;
}): ZoomedSeriesResult {
  const s = input.series;
  const anyS = s as ResolvedSeriesConfig & {
    rawData?: unknown;
    data?: unknown;
    sampling?: string;
    samplingThreshold?: number;
  };
  const target = computeZoomSampleTarget(anyS.samplingThreshold ?? 0, input.spanFraction);

  if (s.type === 'candlestick') {
    const rawOHLC =
      (input.rawSlot as ReadonlyArray<OHLCDataPoint> | null | undefined) ??
      ((anyS.rawData ?? anyS.data) as ReadonlyArray<OHLCDataPoint>);
    const bufferedOHLC = input.sliceOHLC(rawOHLC, input.bufferedMin, input.bufferedMax);
    const sampled = resolveCandlestickDisplayData({
      sampling: anyS.sampling,
      samplingThreshold: anyS.samplingThreshold ?? 0,
      rawOHLC: bufferedOHLC,
      sampleTarget: target,
    });
    const visibleSampled = input.sliceOHLC(sampled, input.visibleMin, input.visibleMax);
    return {
      series: { ...s, data: visibleSampled } as ResolvedSeriesConfig,
      cacheEntry: {
        data: sampled,
        cachedRange: { min: input.bufferedMin, max: input.bufferedMax },
      },
    };
  }

  const rawCartesian: CartesianSeriesData =
    (input.rawSlot as CartesianSeriesData | null | undefined) ?? ((anyS.rawData ?? anyS.data) as CartesianSeriesData);

  // sampling:'none' → full raw resident at any zoom (matches fullRawLine append contract).
  // Visibility is via xScale domain, not by shrinking series.data / DataStore contents.
  if (anyS.sampling === 'none') {
    return {
      series: {
        ...s,
        rawData: rawCartesian,
        data: rawCartesian,
      } as ResolvedSeriesConfig,
      cacheEntry: null,
    };
  }

  const bufferedRaw = input.sliceX(rawCartesian, input.bufferedMin, input.bufferedMax);

  // GPU decimation: keep full raw; compute scopes via visibleStart/End in prepare.
  if (isGpuDecimationEligible(s, bufferedRaw)) {
    return {
      series: {
        ...s,
        rawData: rawCartesian,
        data: rawCartesian,
      } as ResolvedSeriesConfig,
      cacheEntry: null,
    };
  }

  const sampled = resolveCartesianDisplayData({
    series: s,
    raw: bufferedRaw,
    mode: 'zoomed',
    sampleTarget: target,
  });
  const visibleSampled = input.sliceX(sampled, input.visibleMin, input.visibleMax);
  return {
    series: { ...s, data: visibleSampled } as ResolvedSeriesConfig,
    cacheEntry: {
      data: sampled,
      cachedRange: { min: input.bufferedMin, max: input.bufferedMax },
    },
  };
}
