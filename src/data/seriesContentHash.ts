/**
 * Content fingerprint for series raw data (P1-7 correctness).
 *
 * Used when the raw data **reference** changes (or no prior hash is available).
 * `OptionResolver.resolveSeriesContentHash` reuses a previous `contentHash` in
 * O(1) when the data reference is unchanged — full scans are not performed on
 * every axes-only / presentation-only `setOption`.
 *
 * **Full rewrite path:** When the data reference changes every frame (harnesses
 * regenerating arrays), use {@link cheapCartesianContentStamp}.
 *
 * @module seriesContentHash
 */

import type { CartesianSeriesData, OHLCDataPoint } from '../config/types';
import { getPointCount } from './cartesianData';

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * Monotonic generation mixed into cheap stamps so same-length rewrites stay distinct.
 *
 * **Module-global:** shared across all charts in the page. Stamps are dirty
 * tokens only (not content fingerprints); cross-chart coupling is intentional
 * and harmless — identity reuse requires a stable data ref, not stamp equality.
 */
let rewriteGeneration = 0;

const mixUint = (h: number, v: number): number => Math.imul(h ^ (v >>> 0), FNV_PRIME) >>> 0;

/**
 * O(1) content stamp for cartesian series when the data **reference** changed.
 *
 * Not a content fingerprint: does not scan point values. Mixes point count with a
 * generation counter so consecutive same-length rewrites produce distinct stamps.
 */
export function cheapCartesianContentStamp(data: CartesianSeriesData): number {
  rewriteGeneration = (rewriteGeneration + 1) >>> 0;
  let h = FNV_OFFSET >>> 0;
  h = mixUint(h, getPointCount(data));
  h = mixUint(h, rewriteGeneration);
  // Marker so stamps never collide with accidental full-hash equals checks.
  h = mixUint(h, 0xc0ffee);
  return h >>> 0;
}

/**
 * O(1) content stamp for OHLC series when the data reference changed.
 * See {@link cheapCartesianContentStamp}.
 */
export function cheapOHLCContentStamp(data: ReadonlyArray<OHLCDataPoint>): number {
  rewriteGeneration = (rewriteGeneration + 1) >>> 0;
  let h = FNV_OFFSET >>> 0;
  h = mixUint(h, data.length);
  h = mixUint(h, rewriteGeneration);
  h = mixUint(h, 0x0f1ce);
  return h >>> 0;
}

