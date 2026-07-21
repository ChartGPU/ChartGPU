/**
 * Pure display/sample resolution for series prepare paths.
 *
 * Single place for: GPU-decimation keeps full raw on the series; otherwise
 * CPU `sampleSeriesDataPoints` (or OHLC sample for candles).
 *
 * @module resolveSeriesDisplayData
 * @internal
 */

import type { ResolvedSeriesConfig } from '../../../config/OptionResolver';
import type { CartesianSeriesData, OHLCDataPoint } from '../../../config/types';
import { hasNullGaps } from '../../../data/cartesianData';
import { isGpuDecimationEligible } from '../../../data/gpuDecimationEligibility';
import { sampleSeriesDataPoints } from '../../../data/sampleSeries';
import { ohlcSample } from '../../../data/ohlcSample';

type DisplayResolveMode = 'baseline' | 'zoomed' | 'setOptionsReuse';

/**
 * Baseline / setOptions: choose series `data` for one cartesian line-like series.
 * GPU-eligible → raw; null-gap data → raw (preserve segmentation); else sample.
 */
export function resolveCartesianDisplayData(input: {
  readonly series: ResolvedSeriesConfig;
  readonly raw: CartesianSeriesData;
  readonly mode: DisplayResolveMode;
  /** Zoomed path: override sample target (threshold scaled by zoom). */
  readonly sampleTarget?: number;
}): CartesianSeriesData {
  const { series, raw, mode, sampleTarget } = input;
  if (
    series.type === 'pie' ||
    series.type === 'candlestick' ||
    series.type === 'ohlc' ||
    series.type === 'heatmap' ||
    series.type === 'pointCloud3d' ||
    series.type === 'surface3d'
  ) {
    return raw;
  }
  if (isGpuDecimationEligible(series, raw)) {
    return raw;
  }
  if (mode === 'setOptionsReuse') {
    // Keep OptionResolver-sampled data when present; caller merges rawData/bounds.
    return (series.data as CartesianSeriesData) ?? raw;
  }
  // Mirror OptionResolver: bypass sampling when null gap markers are present so
  // LTTB/min/max do not filter nulls and join line segments (zoom path issue #150).
  // sampling:'none' already returns data as-is inside sampleSeriesDataPoints.
  if (series.sampling !== 'none' && hasNullGaps(raw)) {
    return raw;
  }
  const threshold =
    sampleTarget != null && Number.isFinite(sampleTarget) ? Math.max(2, sampleTarget | 0) : series.samplingThreshold;
  return sampleSeriesDataPoints(raw, series.sampling, threshold);
}

/**
 * Candlestick baseline sample-or-raw.
 */
export function resolveCandlestickDisplayData(input: {
  readonly sampling: string | undefined;
  readonly samplingThreshold: number;
  readonly rawOHLC: ReadonlyArray<OHLCDataPoint>;
  readonly sampleTarget?: number;
}): ReadonlyArray<OHLCDataPoint> {
  const { sampling, samplingThreshold, rawOHLC, sampleTarget } = input;
  const target =
    sampleTarget != null && Number.isFinite(sampleTarget)
      ? Math.max(1, sampleTarget | 0)
      : Math.max(1, samplingThreshold | 0);
  if (sampling === 'ohlc' && rawOHLC.length > target) {
    return ohlcSample(rawOHLC, target);
  }
  return rawOHLC;
}

/**
 * Zoom target point count from base threshold and visible span fraction.
 */
export function computeZoomSampleTarget(
  baseThreshold: number,
  spanFraction: number,
  options?: {
    readonly minTarget?: number;
    readonly maxAbs?: number;
    readonly maxMultiplier?: number;
  }
): number {
  const MIN_TARGET_POINTS = options?.minTarget ?? 2;
  const MAX_TARGET_POINTS_ABS = options?.maxAbs ?? 200_000;
  const MAX_TARGET_MULTIPLIER = options?.maxMultiplier ?? 32;
  const spanFracSafe = Math.max(1e-3, Math.min(1, spanFraction));
  const baseT = Number.isFinite(baseThreshold) ? Math.max(1, baseThreshold | 0) : 1;
  const maxTarget = Math.min(MAX_TARGET_POINTS_ABS, Math.max(MIN_TARGET_POINTS, baseT * MAX_TARGET_MULTIPLIER));
  const rounded = Math.round(baseT / spanFracSafe);
  return Math.min(maxTarget, Math.max(MIN_TARGET_POINTS, rounded));
}
