/**
 * Bounds computation utilities for the RenderCoordinator.
 *
 * These pure functions compute xMin/xMax/yMin/yMax bounds from data arrays
 * and aggregate bounds across series. They handle edge cases like empty data,
 * NaN/Infinity values, and zero-span domains.
 *
 * @module boundsComputation
 */

import type { DataPoint, OHLCDataPoint } from '../../../config/types';
import type { ResolvedChartGPUOptions } from '../../../config/OptionResolver';
import { getPointXY, isTupleOHLCDataPoint } from './dataPointUtils';
import { computeRawBoundsFromCartesianData } from '../../../data/cartesianData';

/**
 * Bounds type for min/max x and y values.
 */
export type Bounds = Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;

/**
 * Computes xMin/xMax/yMin/yMax bounds from cartesian data array.
 * Skips non-finite values. Returns null if no finite points found.
 * Ensures xMin !== xMax and yMin !== yMax for scale derivation.
 *
 * @param data - Array of data points (tuple or object format)
 * @returns Bounds object or null if no finite points
 */
export const computeRawBoundsFromData = (data: ReadonlyArray<DataPoint>): Bounds | null => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < data.length; i++) {
    const { x, y } = getPointXY(data[i]!);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return null;
  }

  // Keep bounds usable for downstream scale derivation.
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
};

/**
 * Extends existing bounds with new cartesian data points.
 * If bounds is null and points are valid, seeds bounds from points.
 *
 * @param bounds - Existing bounds or null
 * @param points - New points to extend bounds with
 * @returns Updated bounds or null if no finite points
 */
export const extendBoundsWithDataPoints = (bounds: Bounds | null, points: ReadonlyArray<DataPoint>): Bounds | null => {
  if (points.length === 0) return bounds;

  let b = bounds;
  if (!b) {
    // Try to seed from the appended points.
    const seeded = computeRawBoundsFromData(points);
    if (!seeded) return bounds;
    b = seeded;
  }

  let xMin = b.xMin;
  let xMax = b.xMax;
  let yMin = b.yMin;
  let yMax = b.yMax;

  for (let i = 0; i < points.length; i++) {
    const { x, y } = getPointXY(points[i]!);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  // Keep bounds usable for downstream scale derivation.
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
};

/**
 * Extends bounds with OHLC candlestick data using low/high values.
 * If bounds is null, initializes bounds from OHLC points.
 *
 * @param bounds - Existing bounds or null
 * @param points - OHLC points (timestamp, open, high, low, close)
 * @returns Updated bounds or original bounds if no finite points
 */
export const extendBoundsWithOHLCDataPoints = (bounds: Bounds | null, points: ReadonlyArray<OHLCDataPoint>): Bounds | null => {
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
 * Aggregates bounds across all series, handling pie/candlestick special cases.
 * Prefers precomputed rawBounds from OptionResolver when available to avoid O(n) scans.
 *
 * @param series - Resolved series configurations
 * @param runtimeRawBoundsByIndex - Optional runtime bounds (used for streaming appends)
 * @returns Global bounds across all series, defaults to (0,1) x (0,1) if no finite data
 */
export const computeGlobalBounds = (
  series: ResolvedChartGPUOptions['series'],
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null
): Bounds => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    // Pie series are non-cartesian; they don't participate in x/y bounds.
    if (seriesConfig.type === 'pie') continue;

    const runtimeBoundsCandidate = runtimeRawBoundsByIndex?.[s] ?? null;
    if (runtimeBoundsCandidate) {
      const b = runtimeBoundsCandidate;
      if (
        Number.isFinite(b.xMin) &&
        Number.isFinite(b.xMax) &&
        Number.isFinite(b.yMin) &&
        Number.isFinite(b.yMax)
      ) {
        if (b.xMin < xMin) xMin = b.xMin;
        if (b.xMax > xMax) xMax = b.xMax;
        if (b.yMin < yMin) yMin = b.yMin;
        if (b.yMax > yMax) yMax = b.yMax;
        continue;
      }
    }

    // Prefer precomputed bounds from the original (unsampled) data when available.
    // This ensures sampling cannot affect axis auto-bounds and avoids per-render O(n) scans.
    const rawBoundsCandidate = seriesConfig.rawBounds;
    if (rawBoundsCandidate) {
      const b = rawBoundsCandidate;
      if (
        Number.isFinite(b.xMin) &&
        Number.isFinite(b.xMax) &&
        Number.isFinite(b.yMin) &&
        Number.isFinite(b.yMax)
      ) {
        if (b.xMin < xMin) xMin = b.xMin;
        if (b.xMax > xMax) xMax = b.xMax;
        if (b.yMin < yMin) yMin = b.yMin;
        if (b.yMax > yMax) yMax = b.yMax;
        continue;
      }
    }

    // Candlestick series: bounds should be precomputed in OptionResolver from timestamp/low/high.
    // If we reach here, `rawBounds` was undefined; fall back to a raw OHLC scan so axes don't break.
    if (seriesConfig.type === 'candlestick') {
      const rawOHLC = (seriesConfig.rawData ?? seriesConfig.data) as ReadonlyArray<OHLCDataPoint>;
      for (let i = 0; i < rawOHLC.length; i++) {
        const p = rawOHLC[i]!;
        if (isTupleOHLCDataPoint(p)) {
          const timestamp = p[0];
          const low = p[3];
          const high = p[4];
          if (!Number.isFinite(timestamp) || !Number.isFinite(low) || !Number.isFinite(high)) continue;

          const yLow = Math.min(low, high);
          const yHigh = Math.max(low, high);

          if (timestamp < xMin) xMin = timestamp;
          if (timestamp > xMax) xMax = timestamp;
          if (yLow < yMin) yMin = yLow;
          if (yHigh > yMax) yMax = yHigh;
        } else {
          const timestamp = p.timestamp;
          const low = p.low;
          const high = p.high;
          if (!Number.isFinite(timestamp) || !Number.isFinite(low) || !Number.isFinite(high)) continue;

          const yLow = Math.min(low, high);
          const yHigh = Math.max(low, high);

          if (timestamp < xMin) xMin = timestamp;
          if (timestamp > xMax) xMax = timestamp;
          if (yLow < yMin) yMin = yLow;
          if (yHigh > yMax) yMax = yHigh;
        }
      }
      continue;
    }

    // Compute bounds from CartesianSeriesData (supports all three formats)
    const cartesianBounds = computeRawBoundsFromCartesianData(seriesConfig.data);
    if (cartesianBounds) {
      const b = cartesianBounds;
      if (b.xMin < xMin) xMin = b.xMin;
      if (b.xMax > xMax) xMax = b.xMax;
      if (b.yMin < yMin) yMin = b.yMin;
      if (b.yMax > yMax) yMax = b.yMax;
    }
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
  }

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
