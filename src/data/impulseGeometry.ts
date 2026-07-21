/**
 * Pure impulse / stem geometry helpers.
 *
 * One vertical stem per sample from baseline → y. Not error-bar HLC.
 * Shared by GPU pack path, bounds, hit-test, and unit tests.
 *
 * @module impulseGeometry
 * @internal
 */

import type { CartesianSeriesData } from '../config/types';
import {
  computeRawBoundsFromCartesianData,
  getPointCount,
  getX,
  getY,
  type Bounds,
  type CoordinatorCartesianData,
} from './cartesianData';

export type ImpulseStem = Readonly<{
  readonly x: number;
  readonly y: number;
  readonly baseline: number;
  /** True when |y - baseline| is effectively zero — skip zero-length stem. */
  readonly zeroLength: boolean;
}>;

/** Domain rect for a vertical stem with half-thickness in domain X. */
export type ImpulseStemRect = Readonly<{
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}>;

const ZERO_LENGTH_EPS = 1e-15;

/**
 * Stem endpoints for one sample. Returns null when x or y is non-finite.
 * Degenerate (y ≈ baseline) stems are still returned with zeroLength=true
 * so callers can skip the stem body but still draw a marker.
 */
export function impulseStemForSample(x: number, y: number, baseline: number): ImpulseStem | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const base = Number.isFinite(baseline) ? baseline : 0;
  const zeroLength = Math.abs(y - base) <= ZERO_LENGTH_EPS;
  return { x, y, baseline: base, zeroLength };
}

/**
 * Domain-space axis-aligned rect for a vertical stem at x from baseline→y,
 * with half-thickness `stemHalf` in domain X.
 * Returns null for non-finite / zero-length stems.
 */
export function impulseStemRect(stem: ImpulseStem, stemHalf: number): ImpulseStemRect | null {
  if (stem.zeroLength) return null;
  const half = Math.max(0, stemHalf);
  const lo = Math.min(stem.baseline, stem.y);
  const hi = Math.max(stem.baseline, stem.y);
  return {
    minX: stem.x - half,
    maxX: stem.x + half,
    minY: lo,
    maxY: hi,
  };
}

/**
 * Iterate drawable stems from cartesian data. Skips non-finite samples.
 */
export function forEachImpulseStem(
  data: CoordinatorCartesianData,
  baseline: number,
  visit: (stem: ImpulseStem, dataIndex: number) => void
): void {
  const n = getPointCount(data);
  const base = Number.isFinite(baseline) ? baseline : 0;
  for (let i = 0; i < n; i++) {
    const stem = impulseStemForSample(getX(data, i), getY(data, i), base);
    if (stem) visit(stem, i);
  }
}

/**
 * Bounds for auto domain: include all finite y and baseline when it lies
 * outside the data y range (or when no finite y exists).
 */
export function impulseBounds(data: CartesianSeriesData | CoordinatorCartesianData, baseline: number): Bounds | null {
  const dataBounds = computeRawBoundsFromCartesianData(data as CartesianSeriesData);
  const base = Number.isFinite(baseline) ? baseline : 0;

  if (!dataBounds) {
    // No finite samples — still expose baseline so axes have a floor if markers empty.
    if (!Number.isFinite(base)) return null;
    return { xMin: 0, xMax: 1, yMin: base, yMax: base };
  }

  let yMin = dataBounds.yMin;
  let yMax = dataBounds.yMax;
  if (Number.isFinite(base)) {
    if (base < yMin) yMin = base;
    if (base > yMax) yMax = base;
  }
  return {
    xMin: dataBounds.xMin,
    xMax: dataBounds.xMax,
    yMin,
    yMax,
  };
}

/**
 * Point-in-rect with optional domain padding (hit-test pad already folded in).
 */
export function pointInImpulseRect(domainX: number, domainY: number, rect: ImpulseStemRect): boolean {
  return domainX >= rect.minX && domainX <= rect.maxX && domainY >= rect.minY && domainY <= rect.maxY;
}

/**
 * Expand a domain rect by padX / padY (domain units).
 */
export function expandImpulseRect(rect: ImpulseStemRect, padX: number, padY: number): ImpulseStemRect {
  const px = Math.max(0, padX);
  const py = Math.max(0, padY);
  return {
    minX: rect.minX - px,
    maxX: rect.maxX + px,
    minY: rect.minY - py,
    maxY: rect.maxY + py,
  };
}

/**
 * Marker hit square centered at (x, y) with half-size in domain (max of X/Y).
 */
export function impulseMarkerRect(x: number, y: number, halfDomain: number): ImpulseStemRect {
  const h = Math.max(0, halfDomain);
  return {
    minX: x - h,
    maxX: x + h,
    minY: y - h,
    maxY: y + h,
  };
}
