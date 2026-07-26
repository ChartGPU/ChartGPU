/**
 * Visible Y-bounds helpers for autoBounds + zoom.
 *
 * Full-span zoom uses O(1) raw bounds (caller). Zoomed GPU-decimation series
 * may still hold full raw — callers pass an X window so extrema reflect the
 * visible slice, not the entire series.
 *
 * Full-span detection is the single shared predicate {@link isFullSpanZoom} from
 * `zoomHelpers` (0.5% edge tolerance for UI/float imprecision). Re-exported as
 * `isFullSpanZoomRange` for call-site naming; do not reintroduce a strict
 * start≤0/end≥100 duplicate.
 *
 * @module visibleYBounds
 * @internal
 */

import type { CartesianSeriesData } from '../../../config/types';
import { getPointCount, getX, getY } from '../../../data/cartesianData';
import { isFullSpanZoom } from './zoomHelpers';

/** @see isFullSpanZoom — single source of truth (0.5% tolerance). */
export const isFullSpanZoomRange = isFullSpanZoom;

type ScanCartesianYBoundsOptions = {
  /** When set, only points with finite x in [min, max] contribute. */
  readonly xWindow?: { readonly min: number; readonly max: number } | null;
  /** When true, only strictly positive y contribute (log-axis auto domain). */
  readonly positiveOnly?: boolean;
  /**
   * When true and yMin === yMax after scan (and not positiveOnly), expand max by +1
   * so linear auto-bounds do not collapse. Default true for full scan; false for positive-only.
   */
  readonly expandEqual?: boolean;
};

/**
 * Scan cartesian points for y min/max with optional X window / positive-only filter.
 * Returns null when no finite points contribute (caller aggregates / falls back).
 */
function scanCartesianYBounds(
  data: CartesianSeriesData,
  options?: ScanCartesianYBoundsOptions
): { yMin: number; yMax: number } | null {
  const xWindow = options?.xWindow;
  const positiveOnly = options?.positiveOnly === true;
  const expandEqual = options?.expandEqual ?? !positiveOnly;

  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  const filterX = xWindow != null && Number.isFinite(xWindow.min) && Number.isFinite(xWindow.max);
  const xMinW = filterX ? xWindow!.min : 0;
  const xMaxW = filterX ? xWindow!.max : 0;
  const n = getPointCount(data);
  for (let i = 0; i < n; i++) {
    if (filterX) {
      const x = getX(data, i);
      if (!Number.isFinite(x) || x < xMinW || x > xMaxW) continue;
    }
    const y = getY(data, i);
    if (!Number.isFinite(y)) continue;
    if (positiveOnly && !(y > 0)) continue;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return null;
  }
  if (positiveOnly && (!(yMin > 0) || !(yMax > 0))) {
    return null;
  }
  if (expandEqual && yMin === yMax) yMax = yMin + 1;
  return { yMin, yMax };
}

/**
 * Scan cartesian points for y min/max, optionally restricted to an X window.
 * Returns null when no finite points contribute (caller aggregates / falls back).
 */
export function scanCartesianVisibleYBounds(
  data: CartesianSeriesData,
  xWindow?: { readonly min: number; readonly max: number } | null
): { yMin: number; yMax: number } | null {
  return scanCartesianYBounds(data, { xWindow, positiveOnly: false, expandEqual: true });
}

/**
 * Scan cartesian points for **strictly positive** y min/max (log-axis auto domain).
 * Optionally restricted to an X window — same window used for visible Y under zoom
 * so positives outside the view do not pull the log domain.
 * Returns null when no positive finite y contributes (caller falls back).
 */
export function scanCartesianPositiveYBounds(
  data: CartesianSeriesData,
  xWindow?: { readonly min: number; readonly max: number } | null
): { yMin: number; yMax: number } | null {
  return scanCartesianYBounds(data, { xWindow, positiveOnly: true, expandEqual: false });
}
