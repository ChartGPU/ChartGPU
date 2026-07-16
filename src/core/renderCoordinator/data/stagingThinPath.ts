/**
 * Staging thin-path (zero-copy DataStore alias) eligibility helpers.
 *
 * Thin path = GPU append fast path (`fullRawLine` / `gpuDecimationRaw`). Coordinator
 * runtime raw binds to DataStore **Float32** staging (no dual-pack into
 * RingXYColumns or growing MutableXYColumns). Covers:
 * - FIFO `maxPoints` modular ring (issue 1.5)
 * - Unbounded pure growth (series compression / multi-chart line slots with
 *   LTTB + `appendData` and no maxPoints — dual number[] growth was a primary
 *   steady-state tax as N climbed past 1M)
 *
 * **Dual residency:** GPU/staging is F32 interleaved vec2. ChartGPU's hit-test
 * columnar store (F64 when present) is independent — skipped when
 * `tooltip.show === false` (lazy resync on hitTest / tooltip re-enable). Thin-path
 * eligibility is **not** gated on tooltip; F32 domain precision is acceptable for
 * streaming scales while tooltips may prefer dual-store F64 when enabled.
 *
 * @module stagingThinPath
 * @internal
 */

import { isStagingRingView } from '../../../data/cartesianData';

/**
 * True when coordinator runtime raw should bind to DataStore staging instead of
 * dual-packing into RingXYColumns / owned MutableXYColumns.
 *
 * `hasMaxPointsInFlush` and `tooltipShow` remain in the signature for call-site
 * compatibility; neither gates eligibility anymore. FIFO and unbounded growth
 * both dual-pack-free when the GPU append fast path is live. Float32 staging
 * precision is acceptable for streaming domain; hit-test dual-store is independent.
 */
export function isStagingThinPathEligible(
  canUseFastPath: boolean,
  _hasMaxPointsInFlush: boolean,
  _tooltipShow?: boolean | undefined
): boolean {
  return canUseFastPath;
}

/**
 * After a thin-path rebind failure (DataStore throw post-append), demote any
 * live StagingRingView so dual-pack fallthrough can re-sync with the store.
 * Non-staging raw is returned unchanged.
 */
export function demoteStagingViewAfterRebindFailure<T>(raw: T | null): T | null {
  if (raw != null && isStagingRingView(raw)) {
    return null;
  }
  return raw;
}
