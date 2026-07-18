/**
 * Bounds computation utilities for the RenderCoordinator.
 *
 * These pure functions compute xMin/xMax/yMin/yMax bounds from data arrays
 * and aggregate bounds across series. They handle edge cases like empty data,
 * NaN/Infinity values, and zero-span domains.
 *
 * @module boundsComputation
 */

import type { OHLCDataPoint } from '../../../config/types';
import { isTupleOHLCDataPoint } from './dataPointUtils';

/**
 * Bounds type for min/max x and y values.
 */
type Bounds = Readonly<{
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}>;

/**
 * Extends bounds with OHLC candlestick data using low/high values.
 * If bounds is null, initializes bounds from OHLC points.
 *
 * @param bounds - Existing bounds or null
 * @param points - OHLC points (timestamp, open, high, low, close)
 * @returns Updated bounds or original bounds if no finite points
 */
export const extendBoundsWithOHLCDataPoints = (
  bounds: Bounds | null,
  points: ReadonlyArray<OHLCDataPoint>
): Bounds | null => {
  if (points.length === 0) return bounds;

  let xMin = bounds?.xMin ?? Number.POSITIVE_INFINITY;
  let xMax = bounds?.xMax ?? Number.NEGATIVE_INFINITY;
  let yMin = bounds?.yMin ?? Number.POSITIVE_INFINITY;
  let yMax = bounds?.yMax ?? Number.NEGATIVE_INFINITY;

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
    const low = isTupleOHLCDataPoint(p) ? p[3] : p.low;
    const high = isTupleOHLCDataPoint(p) ? p[4] : p.high;

    if (!Number.isFinite(timestamp) || !Number.isFinite(low) || !Number.isFinite(high)) continue;
    if (timestamp < xMin) xMin = timestamp;
    if (timestamp > xMax) xMax = timestamp;
    if (low < yMin) yMin = low;
    if (high > yMax) yMax = high;
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return bounds;
  }

  // Keep bounds usable for downstream scale derivation.
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
};

/**
 * Ensures min ≤ max, handles infinities with defaults (0,1), handles zero-span domains.
 * Returns a usable domain for scale derivation.
 *
 * @param minCandidate - Candidate minimum value
 * @param maxCandidate - Candidate maximum value
 * @returns Normalized domain with min ≤ max, both finite
 */
export const normalizeDomain = (
  minCandidate: number,
  maxCandidate: number
): { readonly min: number; readonly max: number } => {
  let min = minCandidate;
  let max = maxCandidate;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }

  if (min === max) {
    max = min + 1;
  } else if (min > max) {
    const t = min;
    min = max;
    max = t;
  }

  return { min, max };
};

/** Last sanitized result warned per axis key — suppress streaming spam. */
const lastLogDomainWarnByKey = new Map<string, string>();

/**
 * Sanitize a domain for logarithmic axes.
 *
 * - Both ends must be finite and strictly positive.
 * - Explicit min/max ≤ 0 are clamped using `positiveDataMin` when available
 *   (prefer `positiveDataMin * 0.5`, floored at a power of `base`), else fallback.
 * - Empty / all-non-positive data → `[1, 10]` (or `[1, base]` when base > 1).
 *
 * @returns Sanitized domain plus whether a clamp/fallback warning was applied
 */
export function sanitizeLogDomain(
  minCandidate: number,
  maxCandidate: number,
  options?: Readonly<{
    base?: number;
    /** Smallest positive finite data value on this axis (for clamping explicit ≤0). */
    positiveDataMin?: number;
    /** When true, emit a console warning on clamp/fallback (dev). */
    warn?: boolean;
    /**
     * Stable key for de-duplicating warnings (e.g. `'x'`, `'y:0'`).
     * Warns once per key, or again when the sanitized `[min, max]` changes.
     */
    warnKey?: string;
  }>
): { readonly min: number; readonly max: number; readonly warned: boolean } {
  const base =
    options?.base != null && Number.isFinite(options.base) && options.base > 0 && options.base !== 1
      ? options.base
      : 10;
  const fallbackMax = base > 1 ? base : 10;
  let warned = false;

  let min = minCandidate;
  let max = maxCandidate;

  const clampPositive = (v: number, role: 'min' | 'max'): number => {
    if (Number.isFinite(v) && v > 0) return v;
    warned = true;
    const pd = options?.positiveDataMin;
    if (pd != null && Number.isFinite(pd) && pd > 0) {
      const half = pd * 0.5;
      // Floor at a power of base near half (or EPSILON-scale positive).
      const logHalf = Math.log(Math.max(half, Number.MIN_VALUE)) / Math.log(base);
      const floored = base ** Math.floor(logHalf);
      return Math.max(floored, Number.MIN_VALUE);
    }
    return role === 'min' ? 1 : fallbackMax;
  };

  min = clampPositive(min, 'min');
  max = clampPositive(max, 'max');

  if (min === max) {
    max = min * base;
  } else if (min > max) {
    const t = min;
    min = max;
    max = t;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || !(min > 0) || !(max > 0)) {
    warned = true;
    min = 1;
    max = fallbackMax;
  }

  if (warned && options?.warn !== false) {
    const key = options?.warnKey ?? 'default';
    const resultKey = `${min}|${max}|${base}`;
    if (lastLogDomainWarnByKey.get(key) !== resultKey) {
      lastLogDomainWarnByKey.set(key, resultKey);
      console.warn(
        `[ChartGPU] Log axis domain was non-positive or invalid; using [${min}, ${max}]. ` +
          `Log axes require strictly positive min/max.`
      );
    }
  }

  return { min, max, warned };
}
