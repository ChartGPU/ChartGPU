/**
 * Axis tick computation and formatting.
 *
 * Generates tick values and formatting for linear axes. Handles decimal precision
 * determination based on tick step size and provides number formatting utilities.
 *
 * @module computeAxisTicks
 */

/**
 * Default maximum fraction digits for tick formatting.
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
export function generateLinearTicks(
  domainMin: number,
  domainMax: number,
  tickCount: number,
): number[] {
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
export function computeMaxFractionDigitsFromStep(
  tickStep: number,
  cap: number = DEFAULT_MAX_TICK_FRACTION_DIGITS,
): number {
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
  return new Intl.NumberFormat("en-US", { maximumFractionDigits });
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
export function formatTickValue(
  nf: Intl.NumberFormat,
  v: number,
): string | null {
  if (!Number.isFinite(v)) return null;
  // Avoid displaying "-0" from floating-point artifacts.
  const normalized = Math.abs(v) < 1e-12 ? 0 : v;
  const formatted = nf.format(normalized);
  // Guard against unexpected output like "NaN" even after the finite check (defensive).
  return formatted === "NaN" ? null : formatted;
}
