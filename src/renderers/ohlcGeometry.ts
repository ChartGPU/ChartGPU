/**
 * Pure helpers for OHLC bar geometry (stem + open/close ticks).
 * Shared by the GPU pack path and unit tests.
 */

export type OhlcDirection = 'up' | 'down';

/**
 * Direction color rule (match candlestick body fill): close > open → up.
 * Equal open/close (doji) counts as down for color.
 */
export function resolveOhlcDirection(open: number, close: number): OhlcDirection {
  return close > open ? 'up' : 'down';
}

/**
 * Resolve tick half-length in domain units from `tickLength` config + body width.
 *
 * - number: CSS px already converted to domain via `cssWidthToDomainX`
 * - percent string of body width: `p * bodyWidthDomain` (full arm length, not half)
 * - default fraction when tickLength omitted: `defaultFraction * bodyWidthDomain`
 *
 * Returns the **full** tick arm length (center → tip). Open is left of center by
 * this amount; close is right by this amount.
 */
export function resolveOhlcTickLengthDomain(args: {
  readonly tickLength: number | string | undefined;
  readonly bodyWidthDomain: number;
  /** When `tickLength` is a number, caller has already converted CSS→domain. */
  readonly tickLengthAsDomain?: number;
  readonly defaultFraction?: number;
}): number {
  const defaultFraction = args.defaultFraction ?? 0.45;
  const body = Number.isFinite(args.bodyWidthDomain) ? Math.max(0, args.bodyWidthDomain) : 0;

  if (typeof args.tickLength === 'number') {
    const d = args.tickLengthAsDomain;
    if (typeof d === 'number' && Number.isFinite(d)) return Math.max(0, d);
    // Caller passed a domain number directly as tickLength.
    return Number.isFinite(args.tickLength) ? Math.max(0, args.tickLength) : 0;
  }

  if (typeof args.tickLength === 'string') {
    const m = args.tickLength.trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (m) {
      const p = Number(m[1]) / 100;
      if (Number.isFinite(p)) return body * Math.min(1, Math.max(0, p));
    }
    warnInvalidTickLengthOnce(args.tickLength);
    return body * defaultFraction;
  }

  return body * defaultFraction;
}

let invalidTickLengthWarned = false;
function warnInvalidTickLengthOnce(raw: string): void {
  if (invalidTickLengthWarned) return;
  invalidTickLengthWarned = true;
  console.warn(
    `ChartGPU: ohlc tickLength "${raw}" is not a percent string (e.g. "45%") or CSS-px number; using default ${0.45 * 100}% of body width.`
  );
}

/**
 * Stem half-width in domain units from CSS px conversion result.
 * Minimum 0; non-finite → 0.
 */
export function resolveOhlcStemHalfWidthDomain(stemWidthDomain: number): number {
  if (!Number.isFinite(stemWidthDomain) || stemWidthDomain <= 0) return 0;
  return stemWidthDomain * 0.5;
}

/**
 * Domain-space quads for one OHLC bar (see goal Appendix A).
 *
 * - `stemHalf` is half-width in **domain X** (stem thickness).
 * - `tickHalfY` is half-height in **domain Y** (open/close tick thickness).
 *   Must not reuse domain-X stem units as Y thickness (time-axis X widths are
 *   enormous in price Y and paint full-height slabs).
 */
export function ohlcBarQuads(args: {
  readonly x: number;
  readonly open: number;
  readonly close: number;
  readonly low: number;
  readonly high: number;
  readonly stemHalf: number;
  readonly tickLength: number;
  /** Half-thickness of open/close ticks in domain Y. Defaults to `stemHalf` only for unit tests with isotropic domains. */
  readonly tickHalfY?: number;
}): {
  readonly stem: { minX: number; maxX: number; minY: number; maxY: number };
  readonly openTick: { minX: number; maxX: number; minY: number; maxY: number };
  readonly closeTick: { minX: number; maxX: number; minY: number; maxY: number };
} {
  const { x, open, close, low, high, stemHalf, tickLength } = args;
  const s = Math.max(0, stemHalf);
  const t = Math.max(0, tickLength);
  const ty = Math.max(0, args.tickHalfY ?? stemHalf);
  return {
    stem: { minX: x - s, maxX: x + s, minY: low, maxY: high },
    openTick: { minX: x - t, maxX: x, minY: open - ty, maxY: open + ty },
    closeTick: { minX: x, maxX: x + t, minY: close - ty, maxY: close + ty },
  };
}
