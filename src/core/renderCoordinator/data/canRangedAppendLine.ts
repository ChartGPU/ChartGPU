/**
 * Pure eligibility for O(k) DataStore.appendSeries on append-safe XY series.
 *
 * Full raw resident kinds (`fullRawLine`, `gpuDecimationRaw`) are append-safe at
 * any zoom — the buffer holds full raw, not a zoomed sampled slice.
 * Cold `unknown` unlocks when sampling is `'none'` or GPU decimation is eligible
 * (before the first prepare tags the kind).
 *
 * Pure `type: 'area'` is included so streaming dashboards can ranged-append into
 * the same DataStore buffer the area renderer binds (private pack identity-cache
 * cannot see in-place column growth under a stable ref).
 *
 * @module canRangedAppendLine
 * @internal
 */

import type { ResolvedSeriesConfig } from '../../../config/OptionResolver';
import type { CartesianSeriesData, SeriesSampling, SeriesType } from '../../../config/types';
import { getPointCount, hasAnyPerPointSize } from '../../../data/cartesianData';
import { isGpuDecimationEligible } from '../../../data/gpuDecimationEligibility';
import { isStackedMountainSeries } from '../../../data/stackedArea';
import { resolveStepMode } from '../../../data/stepGeometry';

/** What DataStore currently holds for a series index (written by prepareSeries). */
export type DataStoreBufferKind = 'unknown' | 'fullRawLine' | 'gpuDecimationRaw' | 'other';

export type CanRangedAppendLineInput = {
  readonly seriesType: SeriesType | string;
  readonly sampling: SeriesSampling | string | undefined;
  readonly kind: DataStoreBufferKind;
  /** Runtime raw (or series raw) for GPU-decimation eligibility when kind is cold/active. */
  readonly rawData: CartesianSeriesData | null | undefined;
  /** Full series config when available (areaStyle, samplingThreshold, etc.). */
  readonly series?: ResolvedSeriesConfig | null;
  /** Coalesced append batches, used to keep scatter size channels on the private path. */
  readonly appendedData?: ReadonlyArray<CartesianSeriesData>;
};

/**
 * True when ranged append may write only the new points without full setSeries.
 */
export function canRangedAppendLine(input: CanRangedAppendLineInput): boolean {
  // Fixed-radius point scatter can bind the same interleaved XY DataStore buffer
  // as line/area. Ordering inside a modular ring is irrelevant for point marks.
  // Density and variable/per-point radius need their dedicated geometry paths.
  if (input.seriesType === 'scatter') {
    const series = input.series;
    const raw = input.rawData ?? null;
    const symbolSize = series?.type === 'scatter' ? series.symbolSize : undefined;
    if (
      series?.type !== 'scatter' ||
      series.mode === 'density' ||
      input.sampling !== 'none' ||
      (symbolSize !== undefined &&
        (typeof symbolSize !== 'number' || !Number.isFinite(symbolSize) || symbolSize <= 0)) ||
      raw == null ||
      hasAnyPerPointSize(raw) ||
      input.appendedData?.some(hasAnyPerPointSize)
    ) {
      return false;
    }
    // During append flush, `unknown` can mean the first render has not seeded
    // DataStore yet. Its maxPoints cold seed contains only the appended batch,
    // so keep non-empty option data on the CPU path for the first prepare.
    if (input.kind === 'unknown' && input.appendedData != null && getPointCount(raw) > 0) {
      return false;
    }
    return input.kind === 'fullRawLine' || input.kind === 'unknown';
  }

  // Line and pure area share the XY storage layout; both may ranged-append when
  // the resident buffer is full raw. GPU decimation remains line-only (predicate).
  if (input.seriesType !== 'line' && input.seriesType !== 'area') return false;

  // Stacked mountain private-packs yBottom/yTop and may upload yTop stroke columns —
  // ranged contribution append would desync stack baselines (issue 7).
  if (input.series != null && isStackedMountainSeries(input.series)) return false;

  // Step (digital): prepare expands stairs (N_draw ≠ N_source). Cold unknown +
  // sampling:'none' must not ranged-append raw while prepare binds expanded geometry
  // (M1 / C1 family: pointCount must agree with bound buffer).
  if (input.series != null) {
    const step = (input.series as { readonly step?: unknown }).step;
    if (resolveStepMode(step as boolean | string | null | undefined) != null) return false;
  }

  // connectNulls may strip gap markers before upload (filtered N ≠ raw GPU N).
  // Ranged full-raw append + skip-setSeries would bind unfiltered buffer against
  // filtered draw count (C1 G0). Force full setSeries path whenever connectNulls.
  if (input.series != null && (input.series as { readonly connectNulls?: boolean }).connectNulls === true) {
    return false;
  }

  const kind = input.kind;
  const isGpuDecimationActive = kind === 'gpuDecimationRaw';
  const sampling = input.sampling;

  const seriesForEligibility: ResolvedSeriesConfig =
    input.series ??
    ({
      type: input.seriesType === 'area' ? 'area' : 'line',
      sampling: (sampling ?? 'lttb') as SeriesSampling,
    } as ResolvedSeriesConfig);

  const raw = input.rawData ?? null;
  // Pure area is never GPU-decimation eligible; only line+lttb/min/max unlocks that path.
  const isGpuDecimationEligibleNow =
    input.seriesType === 'line' && raw != null && isGpuDecimationEligible(seriesForEligibility, raw);

  // fullRawLine / gpuDecimationRaw: buffer holds full raw (any zoom).
  // unknown + (none | GPU-eligible): cold path before first prepare tags kind.
  const kindAllows =
    kind === 'fullRawLine' ||
    isGpuDecimationActive ||
    (kind === 'unknown' && (isGpuDecimationEligibleNow || sampling === 'none'));

  if (!kindAllows) return false;

  // GPU path and sampling none both keep full raw at any zoom.
  return isGpuDecimationActive || isGpuDecimationEligibleNow || sampling === 'none';
}
