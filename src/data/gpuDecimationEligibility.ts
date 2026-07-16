/**
 * Eligibility gate for GPU-side compute-shader decimation.
 *
 * A single predicate consumed by both the coordinator's sampling-skip decision
 * (`recomputeRuntimeBaseSeries` / `recomputeRenderSeries` in
 * `createRenderCoordinator.ts`) and `prepareSeries`'s buffer-swap decision
 * (`renderCoordinator/render/renderSeries.ts`).
 *
 * A series is eligible when **all** hold:
 *   1. Series type is `'line'` — area fills on line series share the same
 *      DataStore buffer, so the decimation output can feed the area renderer
 *      too, but pure `'area'` (no rawData) is currently out of scope because
 *      its data flow re-uses the same `rawData`/`data` pair differently. This
 *      module errs on the conservative side by requiring `'line'`.
 *   2. `sampling` is one of the three CPU modes we have GPU kernels for:
 *      `'lttb'`, `'min'`, `'max'`. `'none'`, `'average'`, and `'ohlc'` fall
 *      back to the CPU path.
 *   3. Raw data is null-gap-free. Null entries denote segmentation breaks for
 *      the line renderer; the compute shader cannot reason about those, so we
 *      stay on the CPU path (which already has established gap handling).
 */

import type { SeriesSampling } from "../config/types";
import type { ResolvedSeriesConfig } from "../config/OptionResolver";
import {
  hasNullGaps,
  type CoordinatorCartesianData,
} from "./cartesianData";
import type { DecimationAlgorithm } from "../renderers/createDecimationCompute";

/**
 * Sampling modes that route to the GPU compute decimation path.
 */
export const GPU_DECIMATION_SAMPLING_MODES: ReadonlySet<SeriesSampling> =
  new Set<SeriesSampling>(["lttb", "min", "max"]);

/**
 * Maps a CPU `SeriesSampling` value to the GPU compute algorithm that will
 * handle it.
 *
 * Returns `null` for modes that have no GPU kernel (caller falls back to CPU).
 */
export function mapSamplingToDecimationAlgorithm(
  sampling: SeriesSampling,
): DecimationAlgorithm | null {
  switch (sampling) {
    case "lttb":
      return "lttb";
    case "min":
      return "min";
    case "max":
      return "max";
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
export function isGpuDecimationEligible(
  series: ResolvedSeriesConfig,
  rawData: CoordinatorCartesianData,
): boolean {
  if (series.type !== "line") return false;
  // Line+areaStyle still uses the CPU area vertex path on this branch (P1-3/P1-4).
  // Keep those series on CPU sampling so fill and stroke share the same sampled data.
  if (series.type === "line" && "areaStyle" in series && series.areaStyle) {
    return false;
  }
  if (!GPU_DECIMATION_SAMPLING_MODES.has(series.sampling)) return false;
  if (hasNullGaps(rawData)) return false;
  return true;
}
