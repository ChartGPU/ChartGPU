/**
 * Pure helpers for error-bar geometry (stem + whisker caps).
 * Shared by GPU pack path and unit tests.
 *
 * Domain-axis hygiene (OHLC lesson):
 * - Vertical: stem thickness in domain **X**; cap thickness in domain **Y**.
 * - Horizontal: stem thickness in domain **Y**; cap thickness in domain **X**.
 */

import type { ErrorBarDirection, ErrorBarMode } from '../config/types';
import type { ErrorBarPoint } from '../data/errorBarData';

export type DomainRect = Readonly<{
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;

/**
 * Resolve cap full width (whisker length) in domain units.
 *
 * - number with `capWidthAsDomain`: CSS px already converted to domain
 * - percent string: fraction of category step (vertical → domain X; horizontal → domain Y step)
 * - omitted: defaultFraction * categoryStep (default 0.4)
 *
 * Returns **full** cap width (tip-to-tip). Half is applied in quads.
 */
export function resolveErrorBarCapLengthDomain(args: {
  readonly capWidth: number | string | undefined;
  readonly categoryStep: number;
  /** When `capWidth` is a number, caller has already converted CSS→domain. */
  readonly capWidthAsDomain?: number;
  readonly defaultFraction?: number;
}): number {
  const defaultFraction = args.defaultFraction ?? 0.4;
  const step = Number.isFinite(args.categoryStep) ? Math.max(0, args.categoryStep) : 0;

  if (typeof args.capWidth === 'number') {
    const d = args.capWidthAsDomain;
    if (typeof d === 'number' && Number.isFinite(d)) return Math.max(0, d);
    return Number.isFinite(args.capWidth) ? Math.max(0, args.capWidth) : 0;
  }

  if (typeof args.capWidth === 'string') {
    const m = args.capWidth.trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (m) {
      const p = Number(m[1]) / 100;
      if (Number.isFinite(p)) return step * Math.min(1, Math.max(0, p));
    }
    warnInvalidCapWidthOnce(args.capWidth);
    return step * defaultFraction;
  }

  return step * defaultFraction;
}

let invalidCapWidthWarned = false;
function warnInvalidCapWidthOnce(raw: string): void {
  if (invalidCapWidthWarned) return;
  invalidCapWidthWarned = true;
  console.warn(
    `ChartGPU: errorBar capWidth "${raw}" is not a percent string (e.g. "40%") or CSS-px number; using default ${0.4 * 100}% of category step.`
  );
}

/**
 * Stem full-width in domain units from CSS conversion result → half via *0.5 at call site.
 * Returns full domain thickness (caller halves).
 */
export function resolveErrorBarStemWidthDomain(stemWidthDomain: number): number {
  if (!Number.isFinite(stemWidthDomain) || stemWidthDomain <= 0) return 0;
  return stemWidthDomain;
}

export function resolveErrorBarStemHalfWidthDomain(stemWidthDomain: number): number {
  return resolveErrorBarStemWidthDomain(stemWidthDomain) * 0.5;
}

/**
 * Stem endpoints for a sample under errorMode.
 * Locked v1:
 * - both: low → high
 * - high: y → high
 * - low: low → y
 */
export function errorBarStemRange(
  point: ErrorBarPoint,
  errorMode: ErrorBarMode
): { readonly a: number; readonly b: number } {
  if (errorMode === 'high') {
    return { a: point.y, b: point.high };
  }
  if (errorMode === 'low') {
    return { a: point.low, b: point.y };
  }
  return { a: point.low, b: point.high };
}

/**
 * Domain-space quads for one error bar.
 *
 * Vertical:
 * - stem at x, thickness stemHalf in domain X, from stem lo→hi in Y
 * - caps horizontal at high and/or low, half-length capHalf, thickness capHalfThick in domain Y
 *
 * Horizontal:
 * - stem at y, thickness stemHalf in domain Y, from stem lo→hi in X (high/low are X)
 * - caps vertical at high/low X, half-length capHalf in Y, thickness capHalfThick in domain X
 */
export function errorBarInstanceQuads(args: {
  readonly x: number;
  readonly y: number;
  readonly high: number;
  readonly low: number;
  readonly stemHalf: number;
  /** Half of tip-to-tip cap length. */
  readonly capHalf: number;
  /**
   * Half-thickness of caps in the cross-axis domain
   * (vertical bars → domain Y; horizontal → domain X).
   * Must not reuse domain stem width from the wrong axis.
   */
  readonly capHalfThick: number;
  readonly errorMode?: ErrorBarMode;
  readonly drawWhiskers?: boolean;
  readonly drawConnector?: boolean;
  readonly direction?: ErrorBarDirection;
}): {
  readonly stem: DomainRect | null;
  readonly highCap: DomainRect | null;
  readonly lowCap: DomainRect | null;
} {
  const errorMode = args.errorMode ?? 'both';
  const drawWhiskers = args.drawWhiskers !== false;
  const drawConnector = args.drawConnector !== false;
  const direction = args.direction ?? 'vertical';
  const s = Math.max(0, args.stemHalf);
  const c = Math.max(0, args.capHalf);
  const t = Math.max(0, args.capHalfThick);
  const point: ErrorBarPoint = { x: args.x, y: args.y, high: args.high, low: args.low };
  const range = errorBarStemRange(point, errorMode);
  const lo = Math.min(range.a, range.b);
  const hi = Math.max(range.a, range.b);

  let stem: DomainRect | null = null;
  let highCap: DomainRect | null = null;
  let lowCap: DomainRect | null = null;

  if (direction === 'horizontal') {
    // Stem along X at y; high/low are absolute X.
    if (drawConnector) {
      stem = { minX: lo, maxX: hi, minY: args.y - s, maxY: args.y + s };
    }
    if (drawWhiskers) {
      if (errorMode === 'both' || errorMode === 'high') {
        highCap = {
          minX: args.high - t,
          maxX: args.high + t,
          minY: args.y - c,
          maxY: args.y + c,
        };
      }
      if (errorMode === 'both' || errorMode === 'low') {
        lowCap = {
          minX: args.low - t,
          maxX: args.low + t,
          minY: args.y - c,
          maxY: args.y + c,
        };
      }
    }
  } else {
    // Vertical (default)
    if (drawConnector) {
      stem = { minX: args.x - s, maxX: args.x + s, minY: lo, maxY: hi };
    }
    if (drawWhiskers) {
      if (errorMode === 'both' || errorMode === 'high') {
        highCap = {
          minX: args.x - c,
          maxX: args.x + c,
          minY: args.high - t,
          maxY: args.high + t,
        };
      }
      if (errorMode === 'both' || errorMode === 'low') {
        lowCap = {
          minX: args.x - c,
          maxX: args.x + c,
          minY: args.low - t,
          maxY: args.low + t,
        };
      }
    }
  }

  return { stem, highCap, lowCap };
}

/** Expand rect by pad in both axes (domain units). */
export function expandDomainRect(r: DomainRect, padX: number, padY: number): DomainRect {
  return {
    minX: r.minX - padX,
    maxX: r.maxX + padX,
    minY: r.minY - padY,
    maxY: r.maxY + padY,
  };
}

export function pointInDomainRect(x: number, y: number, r: DomainRect): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}
