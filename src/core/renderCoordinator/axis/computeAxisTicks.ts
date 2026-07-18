/**
 * Axis tick computation and formatting.
 *
 * Generates tick values and formatting for linear and logarithmic axes. Handles
 * decimal precision determination based on tick step size and provides number
 * formatting utilities.
 *
 * @module computeAxisTicks
 */

import { DEFAULT_LOG_BASE, normalizeLogBase } from '../../../utils/scales';

/**
 * Default maximum fraction digits for tick formatting (single source of truth).
 * Imported by timeAxisUtils to avoid 6-vs-8 drift.
 */
const DEFAULT_MAX_TICK_FRACTION_DIGITS = 8;

/**
 * Generates evenly-spaced tick values between domain min and max.
 *
 * @param domainMin - Minimum value of the domain
 * @param domainMax - Maximum value of the domain
 * @param tickCount - Number of ticks to generate (must be >= 1)
 * @returns Array of tick values
 */
export function generateLinearTicks(domainMin: number, domainMax: number, tickCount: number): number[] {
  const count = Math.max(1, Math.floor(tickCount));
  const ticks: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const v = domainMin + t * (domainMax - domainMin);
    ticks[i] = v;
  }
  return ticks;
}

/**
 * Generates major log tick values at integer powers of `base` inside [min, max].
 *
 * Domain endpoints that are non-positive are replaced with a safe fallback
 * `[1, base]` before generation. If no integer power falls inside the domain
 * (intra-decade window, e.g. `[2, 3]`), domain endpoints are returned so grid
 * lines and labels stay inside the plot range.
 *
 * @param domainMin - Domain minimum (data space)
 * @param domainMax - Domain maximum (data space)
 * @param base - Logarithm base (default 10; invalid bases fall back to 10)
 * @returns Sorted major tick values in data space
 */
export function generateLogTicks(domainMin: number, domainMax: number, base: number = DEFAULT_LOG_BASE): number[] {
  const b = normalizeLogBase(base);
  let lo = Math.min(domainMin, domainMax);
  let hi = Math.max(domainMin, domainMax);

  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(lo > 0) || !(hi > 0)) {
    lo = 1;
    hi = b > 1 ? b : 10;
  }
  if (lo === hi) {
    hi = lo * b;
  }

  const logLo = Math.log(lo) / Math.log(b);
  const logHi = Math.log(hi) / Math.log(b);
  // Inclusive powers that land within the domain (with float tolerance).
  const kStart = Math.ceil(logLo - 1e-12);
  const kEnd = Math.floor(logHi + 1e-12);

  if (kStart > kEnd) {
    // Domain lies strictly between two consecutive powers — prefer endpoints
    // so labels/grid stay inside the visible window (not surrounding powers).
    return [lo, hi];
  }

  const ticks: number[] = [];
  for (let k = kStart; k <= kEnd; k++) {
    const v = b ** k;
    // Keep powers that fall inside [lo, hi] with a tiny relative slack for float noise.
    if (v >= lo * (1 - 1e-12) && v <= hi * (1 + 1e-12)) {
      ticks.push(v);
    }
  }

  // Deduplicate / sort (base**k can collide for pathological bases).
  ticks.sort((a, c) => a - c);
  const out: number[] = [];
  for (let i = 0; i < ticks.length; i++) {
    const v = ticks[i]!;
    if (out.length === 0 || Math.abs(out[out.length - 1]! - v) > Math.abs(v) * 1e-12) {
      out.push(v);
    }
  }

  if (out.length === 0) {
    return [lo, hi];
  }
  if (out.length === 1) {
    const only = out[0]!;
    return only > lo ? [lo, only] : [only, hi];
  }
  return out;
}

/**
 * Generates log-axis ticks for the *visible* domain (e.g. after zoom/pan).
 *
 * Always places majors at integer powers of `base` that fall inside the window.
 * When few majors are present (zoomed into one decade or an intra-decade band),
 * densifies with intermediate mantissas (2×/5× then denser for base 10; log-spaced
 * samples for other bases) so labels and grid stay useful inside the plot.
 *
 * Ticks are filtered to the visible domain. Callers should pass the scale's
 * current domain (visible window), not the full explicit axis min/max.
 *
 * @param domainMin - Visible domain minimum (data space)
 * @param domainMax - Visible domain maximum (data space)
 * @param base - Logarithm base (default 10)
 * @param options - Optional maxTicks cap (default 12)
 * @returns Sorted tick values in data space, all within the visible domain
 */
export function generateLogTicksForVisibleDomain(
  domainMin: number,
  domainMax: number,
  base: number = DEFAULT_LOG_BASE,
  options?: { maxTicks?: number }
): number[] {
  const maxTicks = Math.max(2, Math.floor(options?.maxTicks ?? 12));
  const b = normalizeLogBase(base);
  let lo = Math.min(domainMin, domainMax);
  let hi = Math.max(domainMin, domainMax);

  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(lo > 0) || !(hi > 0)) {
    lo = 1;
    hi = b > 1 ? b : 10;
  }
  if (lo === hi) {
    hi = lo * b;
  }

  const logLo = Math.log(lo) / Math.log(b);
  const logHi = Math.log(hi) / Math.log(b);
  const decadeSpan = logHi - logLo;

  // Integer powers that land inside the visible window.
  const kStart = Math.ceil(logLo - 1e-12);
  const kEnd = Math.floor(logHi + 1e-12);
  const majors: number[] = [];
  for (let k = kStart; k <= kEnd; k++) {
    const v = b ** k;
    if (isInLogDomain(v, lo, hi)) {
      majors.push(v);
    }
  }

  // Enough majors for a multi-decade view: classic power-of-base labels only.
  if (majors.length >= 3 || (majors.length >= 2 && decadeSpan >= 1.2)) {
    return majors.length <= maxTicks ? majors : thinPreferringValues(majors, majors, maxTicks);
  }

  return densifyLogTicks(lo, hi, b, majors, maxTicks);
}

/** Relative float slack for domain membership checks. */
function isInLogDomain(v: number, lo: number, hi: number): boolean {
  return v >= lo * (1 - 1e-12) && v <= hi * (1 + 1e-12);
}

function dedupSortedTicks(ticks: number[]): number[] {
  ticks.sort((a, c) => a - c);
  const out: number[] = [];
  for (let i = 0; i < ticks.length; i++) {
    const v = ticks[i]!;
    if (out.length === 0 || Math.abs(out[out.length - 1]! - v) > Math.abs(v) * 1e-12) {
      out.push(v);
    }
  }
  return out;
}

/**
 * Prefer keeping `preferred` values (e.g. major powers) when thinning to maxTicks.
 * Fills remaining slots with evenly spaced picks from the full sorted list.
 */
function thinPreferringValues(all: number[], preferred: number[], maxTicks: number): number[] {
  if (all.length <= maxTicks) return all;
  const keep = new Set<number>();
  for (const p of preferred) {
    if (all.includes(p)) keep.add(p);
  }
  // Always try to keep endpoints of the candidate list.
  if (all.length > 0) {
    keep.add(all[0]!);
    keep.add(all[all.length - 1]!);
  }
  if (keep.size >= maxTicks) {
    const forced = dedupSortedTicks([...keep]);
    if (forced.length <= maxTicks) return forced;
    const out: number[] = [];
    for (let i = 0; i < maxTicks; i++) {
      const idx = maxTicks === 1 ? 0 : Math.round((i * (forced.length - 1)) / (maxTicks - 1));
      out.push(forced[idx]!);
    }
    return dedupSortedTicks(out);
  }
  // Fill with evenly spaced non-preferred from `all`.
  const remaining = maxTicks - keep.size;
  const candidates = all.filter((v) => !keep.has(v));
  if (candidates.length > 0 && remaining > 0) {
    for (let i = 0; i < remaining; i++) {
      const idx =
        remaining === 1
          ? Math.floor(candidates.length / 2)
          : Math.round((i * (candidates.length - 1)) / (remaining - 1));
      keep.add(candidates[Math.min(idx, candidates.length - 1)]!);
    }
  }
  return dedupSortedTicks([...keep]).slice(0, maxTicks);
}

/**
 * Densify when the visible window has few integer powers of `base`.
 * Base 10: mantissa ladders 1/2/5 → denser 1–9. Other bases: log-spaced samples.
 */
function densifyLogTicks(lo: number, hi: number, base: number, majors: number[], maxTicks: number): number[] {
  const isBase10 = Math.abs(base - 10) < 1e-9;

  if (isBase10) {
    const mantissaSets: readonly (readonly number[])[] = [
      [1, 2, 5],
      [1, 2, 3, 5, 7],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    ];
    const logLo = Math.log10(lo);
    const logHi = Math.log10(hi);
    const expStart = Math.floor(logLo - 1e-12);
    const expEnd = Math.ceil(logHi + 1e-12);

    let best: number[] = majors.length > 0 ? [...majors] : [lo, hi];
    for (let si = 0; si < mantissaSets.length; si++) {
      const mantissas = mantissaSets[si]!;
      const ticks: number[] = [];
      for (let e = expStart; e <= expEnd; e++) {
        const decade = 10 ** e;
        for (let mi = 0; mi < mantissas.length; mi++) {
          const v = mantissas[mi]! * decade;
          if (isInLogDomain(v, lo, hi)) {
            ticks.push(v);
          }
        }
      }
      const unique = dedupSortedTicks(ticks);
      if (unique.length === 0) continue;
      best = unique;
      // Stop once we have a usable density (or last ladder).
      if (unique.length >= 3 || si === mantissaSets.length - 1) {
        break;
      }
    }

    // Always merge visible domain endpoints before thinning (parity with non-base-10 path)
    // so edge labels/grid stay at lo/hi even when the mantissa ladder omits them
    // (e.g. [2e3, 8e3] → ladder has 2/3/5/7e3 but not 8e3).
    best = dedupSortedTicks([...best, lo, hi]);
    // Ensure in-range majors are present (mantissa 1 covers them for base 10).
    for (const m of majors) {
      if (!best.some((t) => Math.abs(t - m) <= Math.abs(m) * 1e-12)) {
        best.push(m);
      }
    }
    best = dedupSortedTicks(best);
    if (best.length > maxTicks) {
      return thinPreferringValues(best, majors, maxTicks);
    }
    return best;
  }

  // Non-base-10: evenly sample log space, always include majors.
  const logLo = Math.log(lo) / Math.log(base);
  const logHi = Math.log(hi) / Math.log(base);
  // Aim for ~4 ticks per decade of log space; clamp to maxTicks.
  const span = logHi - logLo;
  const target = Math.min(maxTicks, Math.max(3, !Number.isFinite(span) || !(span > 0) ? 3 : Math.round(span * 4) + 1));
  const ticks: number[] = [...majors];
  for (let i = 0; i < target; i++) {
    const t = target === 1 ? 0.5 : i / (target - 1);
    const v = base ** (logLo + t * (logHi - logLo));
    if (isInLogDomain(v, lo, hi)) {
      ticks.push(v);
    }
  }
  // Include endpoints so sparse windows still label the edges.
  ticks.push(lo, hi);
  const unique = dedupSortedTicks(ticks);
  if (unique.length > maxTicks) {
    return thinPreferringValues(unique, majors, maxTicks);
  }
  return unique.length > 0 ? unique : [lo, hi];
}

/**
 * Formats a log-axis tick value for display (data-space value, not the log exponent).
 *
 * Policy (base 10):
 * - Exact powers with |exp| ≥ 3 → scientific `1eN`
 * - Exact powers with |exp| ≤ 2 → plain decimal (`0.01`, `0.1`, `1`, `10`, `100`)
 * - Non-power / other bases → compact scientific or plain via Number formatting
 *
 * @param v - Data-space tick value
 * @param base - Logarithm base used for power detection
 */
export function formatLogTickValue(v: number, base: number = DEFAULT_LOG_BASE): string | null {
  if (!Number.isFinite(v) || v <= 0) return null;
  const b = normalizeLogBase(base);

  const exp = Math.log(v) / Math.log(b);
  const nearest = Math.round(exp);
  const isExactPower = Math.abs(exp - nearest) < 1e-9 * Math.max(1, Math.abs(nearest));

  if (isExactPower && b === 10) {
    if (Math.abs(nearest) >= 3) {
      return `1e${nearest}`;
    }
    // Plain decimal for small powers of ten.
    if (nearest >= 0) {
      return String(10 ** nearest);
    }
    // 10^-1, 10^-2
    const digits = -nearest;
    return (10 ** nearest).toFixed(digits);
  }

  if (isExactPower && b !== 10) {
    // e.g. base 2 → "2^10"
    return `${formatCompactBase(b)}^${nearest}`;
  }

  // Non-power: prefer scientific for large/small magnitude.
  const abs = Math.abs(v);
  if (abs >= 1e3 || abs < 1e-2) {
    return v.toExponential(2).replace(/\.?0+e/, 'e');
  }
  return String(Number(v.toPrecision(6)));
}

function formatCompactBase(b: number): string {
  if (Number.isInteger(b)) return String(b);
  return String(Number(b.toPrecision(6)));
}

/**
 * Computes the maximum number of decimal places needed to display a tick step cleanly.
 *
 * Prefers "clean" decimal representations (e.g., 2.5, 0.25, 0.125) without relying on
 * magnitude alone. Accepts floating-point noise and caps the search to keep formatting
 * reasonable.
 *
 * @param tickStep - The step size between ticks
 * @param cap - Maximum number of decimal places to consider (default: 8)
 * @returns Number of decimal places (0 to cap)
 */
function computeMaxFractionDigitsFromStep(tickStep: number, cap: number = DEFAULT_MAX_TICK_FRACTION_DIGITS): number {
  const stepAbs = Math.abs(tickStep);
  if (!Number.isFinite(stepAbs) || stepAbs === 0) return 0;

  // Prefer "clean" decimal representations (e.g. 2.5, 0.25, 0.125) without relying on magnitude alone.
  // We accept floating-point noise and cap the search to keep formatting reasonable.
  for (let d = 0; d <= cap; d++) {
    const scaled = stepAbs * 10 ** d;
    const rounded = Math.round(scaled);
    const err = Math.abs(scaled - rounded);
    const tol = 1e-9 * Math.max(1, Math.abs(scaled));
    if (err <= tol) return d;
  }

  // Fallback for repeating decimals (e.g. 1/3): show a small number of digits based on magnitude.
  // The +1 nudges values like 0.333.. towards 2 decimals rather than 1.
  return Math.max(0, Math.min(cap, 1 - Math.floor(Math.log10(stepAbs)) + 1));
}

/**
 * Creates an Intl.NumberFormat for tick value formatting.
 *
 * Automatically determines the appropriate number of decimal places based on the
 * tick step size using `computeMaxFractionDigitsFromStep()`.
 *
 * @param tickStep - The step size between ticks
 * @returns Intl.NumberFormat configured for tick formatting
 */
export function createTickFormatter(tickStep: number): Intl.NumberFormat {
  const maximumFractionDigits = computeMaxFractionDigitsFromStep(tickStep);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits });
}

/**
 * Formats a numeric tick value using the provided number formatter.
 *
 * Handles edge cases:
 * - Non-finite values return null
 * - Values near zero (< 1e-12) are normalized to 0 to avoid "-0" display
 * - Unexpected "NaN" output from formatter is guarded against
 *
 * @param nf - Intl.NumberFormat to use for formatting
 * @param v - Numeric value to format
 * @returns Formatted string or null if value cannot be formatted
 */
export function formatTickValue(nf: Intl.NumberFormat, v: number): string | null {
  if (!Number.isFinite(v)) return null;
  // Avoid displaying "-0" from floating-point artifacts.
  const normalized = Math.abs(v) < 1e-12 ? 0 : v;
  const formatted = nf.format(normalized);
  // Guard against unexpected output like "NaN" even after the finite check (defensive).
  return formatted === 'NaN' ? null : formatted;
}
