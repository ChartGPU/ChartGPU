/**
 * Eligibility gate for GPU-side compute-shader decimation.
 *
 * A single predicate consumed by both the coordinator's sampling-skip decision
 * (`recomputeRuntimeBaseSeries` / `recomputeRenderSeries` in
 * `createRenderCoordinator.ts`) and `prepareSeries`'s buffer-swap decision
 * (`renderCoordinator/render/renderSeries.ts`).
 *
 * A series is eligible when **all** hold:
 *   1. Series type is `'line'` — pure `'area'` is out of scope (different
 *      rawData/data flow). Line series with `areaStyle` **are** eligible
 *      (issue 1.4): the area renderer binds the same storage / decimation
 *      output as the stroke (no dual CPU pack).
 *   2. `sampling` is one of the three CPU modes we have GPU kernels for:
 *      `'lttb'`, `'min'`, `'max'`. `'none'`, `'average'`, and `'ohlc'` fall
 *      back to the CPU path.
 *   3. Raw data is null-gap-free. Null entries denote segmentation breaks for
 *      the line renderer; the compute shader cannot reason about those, so we
 *      stay on the CPU path (which already has established gap handling).
 */

import type { SeriesSampling } from '../config/types';
import type { ResolvedSeriesConfig } from '../config/OptionResolver';
import { hasNullGaps, type CoordinatorCartesianData } from './cartesianData';
import type { DecimationAlgorithm } from '../renderers/createDecimationCompute';
import { isStackedMountainSeries } from './stackedArea';

/**
 * Sampling modes that route to the GPU compute decimation path.
 */
export const GPU_DECIMATION_SAMPLING_MODES: ReadonlySet<SeriesSampling> = new Set<SeriesSampling>([
  'lttb',
  'min',
  'max',
]);

/**
 * Maps a CPU `SeriesSampling` value to the GPU compute algorithm that will
 * handle it.
 *
 * Returns `null` for modes that have no GPU kernel (caller falls back to CPU).
 */
export function mapSamplingToDecimationAlgorithm(sampling: SeriesSampling): DecimationAlgorithm | null {
  switch (sampling) {
    case 'lttb':
      return 'lttb';
    case 'min':
      return 'min';
    case 'max':
      return 'max';
    default:
      return null;
  }
}

/**
 * Returns `true` when the given series + raw-data pair should run through the
 * GPU compute decimation path instead of CPU `sampleSeriesDataPoints`.
 *
 * The predicate is reference-cheap: the only potentially O(n) check is
 * `hasNullGaps`, which short-circuits on the first non-null entry and is only
 * reached when the earlier gates pass.
 */
export function isGpuDecimationEligible(series: ResolvedSeriesConfig, rawData: CoordinatorCartesianData): boolean {
  if (series.type !== 'line') return false;
  // Stacked mountain composition requires full peer alignment — not GPU-decimation eligible (D9).
  // Stroke-only lines with inert stack (no areaStyle) remain eligible.
  if (isStackedMountainSeries(series)) return false;
  // Step (digital) connection: expand on CPU after sampling; GPU LTTB then linear draw is wrong (D6).
  const step = (series as { readonly step?: unknown }).step;
  if (step != null && step !== false) return false;
  // Line+areaStyle shares the stroke storage / decimation output (issue 1.4).
  if (!GPU_DECIMATION_SAMPLING_MODES.has(series.sampling)) return false;
  if (hasNullGaps(rawData)) return false;
  return true;
}
