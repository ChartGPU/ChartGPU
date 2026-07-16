/**
 * Zoom helper utilities for domain calculations and zoom state checks.
 *
 * Provides pure functions for computing visible domains from zoom ranges,
 * checking full-span zoom states, and other zoom-related calculations.
 *
 * @module zoomHelpers
 */

import type { ZoomRange } from '../../../interaction/createZoomState';

/**
 * Domain boundaries with min and max values.
 */
export interface DomainBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * Visible domain with span fraction for performance optimization hints.
 */
export interface VisibleDomain extends DomainBounds {
  /**
   * Fraction of the base domain that is visible (0 to 1).
   * Used to determine if full-resolution data can be used.
   */
  readonly spanFraction: number;
}

/**
 * Computes the visible X domain from base domain and zoom range.
 *
 * Converts a percent-space zoom range [0-100] to actual domain coordinates.
 * Returns the full base domain when zoom is null/undefined or full-span.
 *
 * @param baseDomain - The complete data domain (unzoomed)
 * @param zoomRange - Zoom window in percent space [0-100], or null for full view
 * @returns Visible domain with min, max, and span fraction
 *
 * @example
 * ```ts
 * const baseDomain = { min: 0, max: 1000 };
 * const zoomRange = { start: 25, end: 75 };
 * const visible = computeVisibleDomain(baseDomain, zoomRange);
 * // Returns: { min: 250, max: 750, spanFraction: 0.5 }
 * ```
 */
export function computeVisibleDomain(baseDomain: DomainBounds, zoomRange?: ZoomRange | null): VisibleDomain {
  if (!zoomRange) {
    return { ...baseDomain, spanFraction: 1 };
  }

  const span = baseDomain.max - baseDomain.min;
  if (!Number.isFinite(span) || span === 0) {
    return { ...baseDomain, spanFraction: 1 };
  }

  const start = zoomRange.start;
  const end = zoomRange.end;

  const min = baseDomain.min + (start / 100) * span;
  const max = baseDomain.min + (end / 100) * span;
  const spanFraction = (end - start) / 100;

  return {
    min,
    max,
    spanFraction,
  };
}

/**
 * Checks if a zoom range represents a full-span (unzoomed) view.
 *
 * **Single source of truth** for full-span checks (coordinator Y-bounds O(1)
 * path, slice/render series, zoom helpers). Do not reintroduce a strict
 * `start <= 0 && end >= 100` duplicate — UI edges and float noise need the
 * 0.5% tolerance below.
 *
 * A zoom is considered full-span if:
 * - Range is null/undefined
 * - Start is at or before 0% AND end is at or after 100% (within tolerance)
 *
 * Small tolerance (0.5%) is applied to account for floating-point arithmetic
 * and UI imprecision (e.g., slider at edge).
 *
 * @param zoomRange - Zoom window to check, or null
 * @returns True if the zoom represents a full-span view
 *
 * @example
 * ```ts
 * isFullSpanZoom(null);                        // true
 * isFullSpanZoom({ start: 0, end: 100 });      // true
 * isFullSpanZoom({ start: -0.1, end: 100.1 }); // true (tolerance)
 * isFullSpanZoom({ start: 25, end: 75 });      // false
 * ```
 */
export function isFullSpanZoom(zoomRange: ZoomRange | null | undefined): boolean {
  if (zoomRange == null) return true;

  const { start, end } = zoomRange;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;

  // Apply small tolerance for floating-point and UI edge cases
  const TOLERANCE = 0.5;
  return start <= TOLERANCE && end >= 100 - TOLERANCE;
}

/**
 * Computes a buffer zone around the visible domain for data caching.
 *
 * Adds a percentage buffer on each side of the visible domain to cache
 * extra data points for smooth panning. This reduces resampling frequency
 * when the user pans slightly beyond the current view.
 *
 * @param visibleDomain - Current visible domain
 * @param bufferPercent - Buffer percentage (0 to 1), default 0.1 (10%)
 * @returns Buffered domain bounds
 *
 * @example
 * ```ts
 * const visible = { min: 100, max: 200 };
 * const buffered = computeBufferedDomain(visible, 0.1);
 * // Returns: { min: 90, max: 210 } (±10% buffer)
 * ```
 */
export function computeBufferedDomain(visibleDomain: DomainBounds, bufferPercent: number = 0.1): DomainBounds {
  const span = visibleDomain.max - visibleDomain.min;
  if (!Number.isFinite(span) || span <= 0) {
    return { ...visibleDomain };
  }

  const buffer = span * Math.abs(bufferPercent);
  return {
    min: visibleDomain.min - buffer,
    max: visibleDomain.max + buffer,
  };
}

/**
 * Converts a domain coordinate to percent-space relative to base domain.
 *
 * Useful for converting mouse positions or data coordinates to zoom range
 * percentages for zoom/pan operations.
 *
 * @param value - Domain coordinate to convert
 * @param baseDomain - Base domain for reference
 * @returns Percent value [0-100]
 *
 * @example
 * ```ts
 * const percent = domainValueToPercent(500, { min: 0, max: 1000 });
 * // Returns: 50
 * ```
 */
export function domainValueToPercent(value: number, baseDomain: DomainBounds): number {
  const span = baseDomain.max - baseDomain.min;
  if (!Number.isFinite(span) || span === 0) return 0;

  const normalized = (value - baseDomain.min) / span;
  return normalized * 100;
}

/**
 * Converts a percent-space value to domain coordinate.
 *
 * Inverse of `domainValueToPercent`. Useful for converting zoom range
 * percentages back to domain coordinates.
 *
 * @param percent - Percent value [0-100]
 * @param baseDomain - Base domain for reference
 * @returns Domain coordinate
 *
 * @example
 * ```ts
 * const value = percentToDomainValue(50, { min: 0, max: 1000 });
 * // Returns: 500
 * ```
 */
export function percentToDomainValue(percent: number, baseDomain: DomainBounds): number {
  const span = baseDomain.max - baseDomain.min;
  return baseDomain.min + (percent / 100) * span;
}

/**
 * Calculates the zoom span (in percent) from a domain window.
 *
 * @param windowDomain - The zoomed window domain
 * @param baseDomain - The full base domain
 * @returns Span in percent [0-100]
 */
export function calculateZoomSpan(windowDomain: DomainBounds, baseDomain: DomainBounds): number {
  const baseSpan = baseDomain.max - baseDomain.min;
  const windowSpan = windowDomain.max - windowDomain.min;

  if (!Number.isFinite(baseSpan) || baseSpan === 0) return 100;
  if (!Number.isFinite(windowSpan) || windowSpan < 0) return 0;

  return Math.min(100, (windowSpan / baseSpan) * 100);
}
