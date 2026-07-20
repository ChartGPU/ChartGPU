/**
 * Pure invalidation policy for 3D point-cloud packed GPU state.
 *
 * Keep packed (including appends) when both the series `data` seed identity and
 * the effective value-channel identity are unchanged. Re-pack when either changes.
 */

import type { PointCloud3DData } from '../../config/types';

export type CloudPackSeed = Readonly<{
  /** Series `data` object / array / typed-array reference. */
  readonly data: unknown;
  /**
   * Effective value channel used at pack time:
   * `colorBy.values` when set, else `data.value` for split arrays, else null.
   */
  readonly valueChannel: unknown;
}>;

/**
 * Resolve the value-channel identity that participates in pack (matches packPointCloud3D).
 * - Explicit override (colorBy.values) wins
 * - Else split-array `data.value` if present
 * - Else null (solid color / no value)
 */
export function resolveCloudValueChannelIdentity(
  data: PointCloud3DData | unknown,
  colorByValues?: ArrayLike<number> | null
): unknown {
  if (colorByValues != null) return colorByValues;
  if (
    data != null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    !ArrayBuffer.isView(data) &&
    'value' in (data as object)
  ) {
    return (data as { readonly value?: unknown }).value ?? null;
  }
  return null;
}

/**
 * True when an existing packed buffer (keyed by previous seed) must be discarded
 * and rebuilt from the next series config.
 */
export function shouldInvalidateCloudPack(previous: CloudPackSeed | null | undefined, next: CloudPackSeed): boolean {
  if (previous == null) return true;
  if (previous.data !== next.data) return true;
  if (previous.valueChannel !== next.valueChannel) return true;
  return false;
}

/** Inverse of shouldInvalidateCloudPack for readable tests. */
export function shouldKeepCloudPack(previous: CloudPackSeed | null | undefined, next: CloudPackSeed): boolean {
  return !shouldInvalidateCloudPack(previous, next);
}
