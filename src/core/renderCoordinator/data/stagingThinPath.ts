/**
 * Staging thin-path (zero-copy DataStore alias) eligibility helpers.
 *
 * Thin path = tooltip off + maxPoints + GPU append fast path. Extracted so the
 * triple gate is unit-testable without standing up a full RenderCoordinator.
 *
 * @module stagingThinPath
 * @internal
 */

import { isStagingRingView } from "../../../data/cartesianData";

/**
 * True when coordinator runtime raw should bind to DataStore modular staging
 * instead of dual-packing into RingXYColumns / owned columns.
 */
export function isStagingThinPathEligible(
  canUseFastPath: boolean,
  hasMaxPointsInFlush: boolean,
  tooltipShow: boolean | undefined,
): boolean {
  return (
    canUseFastPath &&
    hasMaxPointsInFlush &&
    tooltipShow === false
  );
}

/**
 * After a thin-path rebind failure (DataStore throw post-append), demote any
 * live StagingRingView so dual-pack fallthrough can re-sync with the store.
 * Non-staging raw is returned unchanged.
 */
export function demoteStagingViewAfterRebindFailure<T>(
  raw: T | null,
): T | null {
  if (raw != null && isStagingRingView(raw)) {
    return null;
  }
  return raw;
}
