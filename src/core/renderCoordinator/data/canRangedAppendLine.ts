/**
 * Pure eligibility for O(k) DataStore.appendSeries on line / area series.
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
import { isGpuDecimationEligible } from '../../../data/gpuDecimationEligibility';
import { isStackedMountainSeries } from '../../../data/stackedArea';

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
};

/**
 * True when ranged append may write only the new points without full setSeries.
 */
export function canRangedAppendLine(input: CanRangedAppendLineInput): boolean {
  // Line and pure area share the XY storage layout; both may ranged-append when
  // the resident buffer is full raw. GPU decimation remains line-only (predicate).
  if (input.seriesType !== 'line' && input.seriesType !== 'area') return false;

  // Stacked mountain private-packs yBottom/yTop and may upload yTop stroke columns —
  // ranged contribution append would desync stack baselines (issue 7).
  if (input.series != null && isStackedMountainSeries(input.series)) return false;

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
