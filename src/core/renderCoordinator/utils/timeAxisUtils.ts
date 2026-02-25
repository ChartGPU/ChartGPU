/**
 * Time axis and formatting utilities for the RenderCoordinator.
 *
 * These pure functions handle time-based tick generation, adaptive label formatting,
 * and number/percentage parsing for pie chart configuration.
 *
 * @module timeAxisUtils
 */

import type { LinearScale } from '../../../utils/scales';
import type { TextOverlayAnchor } from '../../../components/createTextOverlay';
import type { PieCenter, PieRadius } from '../../../config/types';
import { clipXToCanvasCssPx } from './axisUtils';
import { finiteOrNull } from './dataPointUtils';

/**
 * Time constants for axis formatting decisions.
 */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MS_PER_MONTH_APPROX = 30 * MS_PER_DAY;
export const MS_PER_YEAR_APPROX = 365 * MS_PER_DAY;

/**
 * Tick configuration constants.
 */
export const MAX_TIME_X_TICK_COUNT = 9;
export const MIN_TIME_X_TICK_COUNT = 1;
export const MIN_X_LABEL_GAP_CSS_PX = 6;
export const DEFAULT_MAX_TICK_FRACTION_DIGITS = 6;
export const DEFAULT_TICK_COUNT = 5;

/**
 * English month abbreviations for time axis labels.
 */
export const MONTH_SHORT_EN: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Parses value as number or percentage string, returns null if invalid.
 * Used for pie chart center and radius configuration.
 *
 * @param value - Number or percentage string (e.g. "50%", "120", 120)
 * @param basis - Basis value for percentage calculation
 * @returns Parsed number or null if invalid
 */
export const parseNumberOrPercent = (value: number | string, basis: number): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const s = value.trim();
  if (s.length === 0) return null;

  if (s.endsWith('%')) {
    const pct = Number.parseFloat(s.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return (pct / 100) * basis;
  }

  // Be permissive: allow numeric strings like "120".
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Resolves pie center from mixed number/string/percent format.
 * Defaults to center of plot area (50%, 50%).
 *
 * @param center - Pie center configuration or undefined
 * @param plotWidthCss - Plot area width in CSS pixels
 * @param plotHeightCss - Plot area height in CSS pixels
 * @returns Resolved center coordinates in CSS pixels
 */
export const resolvePieCenterPlotCss = (
  center: PieCenter | undefined,
  plotWidthCss: number,
  plotHeightCss: number
): { readonly x: number; readonly y: number } => {
  const xRaw = center?.[0] ?? '50%';
  const yRaw = center?.[1] ?? '50%';

  const x = parseNumberOrPercent(xRaw, plotWidthCss);
  const y = parseNumberOrPercent(yRaw, plotHeightCss);

  return {
    x: Number.isFinite(x) ? x! : plotWidthCss * 0.5,
    y: Number.isFinite(y) ? y! : plotHeightCss * 0.5,
  };
};

/**
 * Type guard for pie radius tuple format `[inner, outer]`.
 *
 * @param radius - Pie radius configuration
 * @returns True if radius is a tuple
 */
export const isPieRadiusTuple = (
  radius: PieRadius
): radius is readonly [inner: number | string, outer: number | string] => Array.isArray(radius);

/**
 * Resolves pie inner/outer radii with defaults, bounds checking.
 * Default outer radius is 70% of max, inner radius is 0 (full pie).
 *
 * @param radius - Pie radius configuration or undefined
 * @param maxRadiusCss - Maximum radius in CSS pixels
 * @returns Resolved inner and outer radii in CSS pixels
 */
export const resolvePieRadiiCss = (
  radius: PieRadius | undefined,
  maxRadiusCss: number
): { readonly inner: number; readonly outer: number } => {
  // Default similar to common chart libs (mirrors `createPieRenderer.ts`).
  if (radius == null) return { inner: 0, outer: maxRadiusCss * 0.7 };

  if (isPieRadiusTuple(radius)) {
    const inner = parseNumberOrPercent(radius[0], maxRadiusCss);
    const outer = parseNumberOrPercent(radius[1], maxRadiusCss);
    const innerCss = Math.max(0, Number.isFinite(inner) ? inner! : 0);
    const outerCss = Math.max(innerCss, Number.isFinite(outer) ? outer! : maxRadiusCss * 0.7);
    return { inner: innerCss, outer: Math.min(maxRadiusCss, outerCss) };
  }

  const outer = parseNumberOrPercent(radius, maxRadiusCss);
  const outerCss = Math.max(0, Number.isFinite(outer) ? outer! : maxRadiusCss * 0.7);
  return { inner: 0, outer: Math.min(maxRadiusCss, outerCss) };
};

/**
 * Calculates decimal precision needed for clean tick formatting from tick step.
 * Prefers "clean" decimal representations (e.g. 2.5, 0.25, 0.125) without relying on magnitude alone.
 *
 * @param tickStep - Step size between ticks
 * @param cap - Maximum fraction digits to return (default 6)
 * @returns Number of fraction digits for formatting
 */
export const computeMaxFractionDigitsFromStep = (tickStep: number, cap: number = DEFAULT_MAX_TICK_FRACTION_DIGITS): number => {
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
  return Math.max(0, Math.min(cap, Math.ceil(-Math.log10(stepAbs)) + 1));
};

/**
 * Creates Intl.NumberFormat instance for consistent tick formatting.
 * Automatically computes appropriate fraction digits from tick step.
 *
 * @param tickStep - Step size between ticks
 * @returns NumberFormat instance
 */
export const createTickFormatter = (tickStep: number): Intl.NumberFormat => {
  const maximumFractionDigits = computeMaxFractionDigitsFromStep(tickStep);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits });
};

/**
 * Formats numeric value using NumberFormat, handles -0 and NaN edge cases.
 *
 * @param nf - NumberFormat instance
 * @param v - Value to format
 * @returns Formatted string or null if invalid
 */
export const formatTickValue = (nf: Intl.NumberFormat, v: number): string | null => {
  if (!Number.isFinite(v)) return null;
  // Avoid displaying "-0" from floating-point artifacts.
  const normalized = Math.abs(v) < 1e-12 ? 0 : v;
  const formatted = nf.format(normalized);
  // Guard against unexpected output like "NaN" even after the finite check (defensive).
  return formatted === 'NaN' ? null : formatted;
};

/**
 * Pads single-digit numbers with leading zero (used by time formatting).
 *
 * @param n - Number to pad
 * @returns Zero-padded string (minimum 2 digits)
 */
export const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, '0');

/**
 * Formats millisecond timestamps with adaptive precision based on visible range.
 * Format tiers:
 * - < 1 day: HH:mm
 * - 1-7 days: MM/DD HH:mm
 * - 1-12 weeks (up to ~3 months): MM/DD
 * - 3-12 months: MMM DD
 * - > 1 year: YYYY/MM
 *
 * @param timestampMs - Timestamp in milliseconds
 * @param visibleRangeMs - Visible range width in milliseconds
 * @returns Formatted time string or null if invalid
 */
export const formatTimeTickValue = (timestampMs: number, visibleRangeMs: number): string | null => {
  if (!Number.isFinite(timestampMs)) return null;
  if (!Number.isFinite(visibleRangeMs) || visibleRangeMs < 0) visibleRangeMs = 0;

  const d = new Date(timestampMs);
  // Guard against out-of-range timestamps that produce an invalid Date.
  if (!Number.isFinite(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = d.getMonth() + 1; // 1-12
  const dd = d.getDate();
  const hh = d.getHours();
  const min = d.getMinutes();

  if (visibleRangeMs < MS_PER_DAY) {
    return `${pad2(hh)}:${pad2(min)}`;
  }
  // Treat the 7-day boundary as inclusive for the "1–7 days" tier.
  if (visibleRangeMs <= 7 * MS_PER_DAY) {
    return `${pad2(mm)}/${pad2(dd)} ${pad2(hh)}:${pad2(min)}`;
  }
  // Keep short calendar dates until the visible range reaches ~3 months.
  if (visibleRangeMs < 3 * MS_PER_MONTH_APPROX) {
    return `${pad2(mm)}/${pad2(dd)}`;
  }
  if (visibleRangeMs <= MS_PER_YEAR_APPROX) {
    const mmm = MONTH_SHORT_EN[d.getMonth()] ?? pad2(mm);
    return `${mmm} ${pad2(dd)}`;
  }
  return `${yyyy}/${pad2(mm)}`;
};

/**
 * Generates evenly-spaced tick values across domain.
 *
 * @param domainMin - Domain minimum value
 * @param domainMax - Domain maximum value
 * @param tickCount - Number of ticks to generate
 * @returns Array of tick values
 */
export const generateLinearTicks = (domainMin: number, domainMax: number, tickCount: number): number[] => {
  const count = Math.max(1, Math.floor(tickCount));
  const ticks: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    ticks[i] = domainMin + t * (domainMax - domainMin);
  }
  return ticks;
};

/**
 * Computes optimal tick count + values to avoid label overlap on time x-axis.
 * Uses text measurement context to test label widths.
 * Tries tick counts from MAX (9) down to MIN (1) until labels fit without overlap.
 *
 * @param params - Configuration object with axis, scale, canvas, and measurement settings
 * @returns Object with tickCount and tickValues
 */
export const computeAdaptiveTimeXAxisTicks = (params: {
  readonly axisMin: number | null;
  readonly axisMax: number | null;
  readonly xScale: LinearScale;
  readonly plotClipLeft: number;
  readonly plotClipRight: number;
  readonly canvasCssWidth: number;
  readonly visibleRangeMs: number;
  readonly measureCtx: CanvasRenderingContext2D | null;
  readonly measureCache?: Map<string, number>;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly tickFormatter?: (value: number) => string | null;
}): { readonly tickCount: number; readonly tickValues: readonly number[] } => {
  const {
    axisMin,
    axisMax,
    xScale,
    plotClipLeft,
    plotClipRight,
    canvasCssWidth,
    visibleRangeMs,
    measureCtx,
    measureCache,
    fontSize,
    fontFamily,
    tickFormatter,
  } = params;

  // Domain fallback matches `createAxisRenderer` (use explicit min/max when provided).
  const domainMin = finiteOrNull(axisMin) ?? xScale.invert(plotClipLeft);
  const domainMax = finiteOrNull(axisMax) ?? xScale.invert(plotClipRight);

  if (!measureCtx || canvasCssWidth <= 0) {
    return { tickCount: DEFAULT_TICK_COUNT, tickValues: generateLinearTicks(domainMin, domainMax, DEFAULT_TICK_COUNT) };
  }

  // Ensure the measurement font matches the overlay labels.
  measureCtx.font = `${fontSize}px ${fontFamily}`;
  if (measureCache && measureCache.size > 2000) measureCache.clear();

  // Pre-construct the font part of the cache key to avoid repeated concatenation.
  const cacheKeyPrefix = measureCache ? `${fontSize}px ${fontFamily}@@` : null;

  for (let tickCount = MAX_TIME_X_TICK_COUNT; tickCount >= MIN_TIME_X_TICK_COUNT; tickCount--) {
    const tickValues = generateLinearTicks(domainMin, domainMax, tickCount);

    // Compute label extents in *canvas-local CSS px* and ensure adjacent labels don't overlap.
    let prevRight = Number.NEGATIVE_INFINITY;
    let ok = true;

    for (let i = 0; i < tickValues.length; i++) {
      const v = tickValues[i]!;
      const label = tickFormatter ? tickFormatter(v) : formatTimeTickValue(v, visibleRangeMs);
      if (label == null) continue;

      const w = (() => {
        if (!cacheKeyPrefix) return measureCtx.measureText(label).width;
        const key = cacheKeyPrefix + label;
        const cached = measureCache!.get(key);
        if (cached != null) return cached;
        const measured = measureCtx.measureText(label).width;
        measureCache!.set(key, measured);
        return measured;
      })();
      const xClip = xScale.scale(v);
      const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);

      const anchor: TextOverlayAnchor =
        tickCount === 1 ? 'middle' : i === 0 ? 'start' : i === tickValues.length - 1 ? 'end' : 'middle';

      const left = anchor === 'start' ? xCss : anchor === 'end' ? xCss - w : xCss - w * 0.5;
      const right = anchor === 'start' ? xCss + w : anchor === 'end' ? xCss : xCss + w * 0.5;

      if (left < prevRight + MIN_X_LABEL_GAP_CSS_PX) {
        ok = false;
        break;
      }
      prevRight = right;
    }

    if (ok) {
      return { tickCount, tickValues };
    }
  }

  return { tickCount: MIN_TIME_X_TICK_COUNT, tickValues: generateLinearTicks(domainMin, domainMax, MIN_TIME_X_TICK_COUNT) };
};
