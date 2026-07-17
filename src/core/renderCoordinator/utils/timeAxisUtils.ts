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
import { generateLinearTicks as generateLinearTicksCanonical } from '../axis/computeAxisTicks';
import { clipXToCanvasCssPx } from './axisUtils';
import { finiteOrNull } from './dataPointUtils';

/**
 * Time constants for axis formatting decisions and nice tick steps.
 */
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_MONTH_APPROX = 30 * MS_PER_DAY;
const MS_PER_YEAR_APPROX = 365 * MS_PER_DAY;

/**
 * Ascending ladder of nice time tick steps (milliseconds).
 * Used by {@link generateTimeTicks} for epoch-aligned nice positions
 * (absolute multiples of each step from Unix epoch — not local midnights
 * or calendar month boundaries). Larger steps use approximate durations
 * (30d / 90d / 365d) so long-range views match format tiers.
 */
const TIME_TICK_STEPS_MS: readonly number[] = [
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  200,
  500,
  1_000,
  2_000,
  5_000,
  10_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
  900_000,
  1_800_000,
  3_600_000,
  7_200_000,
  10_800_000,
  21_600_000,
  43_200_000,
  86_400_000,
  2 * 86_400_000,
  7 * 86_400_000,
  14 * 86_400_000,
  30 * 86_400_000,
  90 * 86_400_000,
  365 * 86_400_000,
];

/**
 * Tick configuration constants.
 */
const MAX_TIME_X_TICK_COUNT = 9;
const MIN_TIME_X_TICK_COUNT = 1;
const MIN_X_LABEL_GAP_CSS_PX = 6;
export const DEFAULT_TICK_COUNT = 5;

/**
 * English month abbreviations for time axis labels.
 */
const MONTH_SHORT_EN: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Parses value as number or percentage string, returns null if invalid.
 * Used for pie chart center and radius configuration.
 *
 * @param value - Number or percentage string (e.g. "50%", "120", 120)
 * @param basis - Basis value for percentage calculation
 * @returns Parsed number or null if invalid
 */
const parseNumberOrPercent = (value: number | string, basis: number): number | null => {
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
const isPieRadiusTuple = (radius: PieRadius): radius is readonly [inner: number | string, outer: number | string] =>
  Array.isArray(radius);

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
 * Pads single-digit numbers with leading zero (used by time formatting).
 *
 * @param n - Number to pad
 * @returns Zero-padded string (minimum 2 digits)
 */
const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, '0');

/**
 * Pads milliseconds to 3 digits for `HH:mm:ss.SSS` labels.
 *
 * @param n - Milliseconds component (0–999)
 * @returns Zero-padded string (3 digits)
 */
const pad3 = (n: number): string => String(Math.trunc(n)).padStart(3, '0');

/**
 * Formats millisecond timestamps with adaptive precision based on visible range.
 * Format tiers (local timezone via `Date`):
 * - &lt; 2 s: HH:mm:ss.SSS
 * - &lt; 5 min: HH:mm:ss (covers deep zoom ~2–5 min without duplicate HH:mm)
 * - &lt; 1 day: HH:mm
 * - 1–7 days: MM/DD HH:mm
 * - 1–12 weeks (up to ~3 months): MM/DD
 * - 3–12 months: MMM DD
 * - &gt; 1 year: YYYY/MM
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
  const sec = d.getSeconds();
  const ms = d.getMilliseconds();

  if (visibleRangeMs < 2 * MS_PER_SECOND) {
    return `${pad2(hh)}:${pad2(min)}:${pad2(sec)}.${pad3(ms)}`;
  }
  // Seconds through ~5 min so dense 30s steps at deep zoom stay unique (#161).
  if (visibleRangeMs < 5 * MS_PER_MINUTE) {
    return `${pad2(hh)}:${pad2(min)}:${pad2(sec)}`;
  }
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
 * Chooses a nice time tick step (ms) from the ladder for the given visible range
 * and target tick count.
 *
 * Ideal step is `rangeMs / max(1, targetCount - 1)`; returns the smallest ladder
 * step that is ≥ ideal, or the largest ladder step if the range is huge.
 *
 * @param rangeMs - Visible domain width in milliseconds
 * @param targetCount - Desired approximate tick count
 * @returns Step size in milliseconds
 */
const chooseTimeTickStepMs = (rangeMs: number, targetCount: number): number => {
  if (!Number.isFinite(rangeMs) || rangeMs <= 0) {
    return TIME_TICK_STEPS_MS[0]!;
  }
  const n = Math.max(1, Math.floor(targetCount) - 1);
  const ideal = rangeMs / n;
  for (let i = 0; i < TIME_TICK_STEPS_MS.length; i++) {
    const step = TIME_TICK_STEPS_MS[i]!;
    if (step >= ideal) return step;
  }
  return TIME_TICK_STEPS_MS[TIME_TICK_STEPS_MS.length - 1]!;
};

/**
 * First epoch-aligned lattice point ≥ min for the given step, or null if none ≤ max.
 */
const firstLatticeTick = (min: number, max: number, step: number): number | null => {
  let t = Math.ceil(min / step) * step;
  if (t < min) t += step;
  return t <= max ? t : null;
};

/**
 * Emits up to {@link MAX_TIME_X_TICK_COUNT} ticks spanning `[first, max]` with
 * effective step `stride * baseStep`, without materializing the full lattice.
 */
const emitStridedLattice = (first: number, max: number, baseStep: number, fullCount: number): number[] => {
  const stride = Math.ceil(fullCount / MAX_TIME_X_TICK_COUNT);
  const effectiveStep = stride * baseStep;
  const ticks: number[] = [];
  for (let i = 0; ticks.length < MAX_TIME_X_TICK_COUNT; i++) {
    const v = first + i * effectiveStep;
    if (v > max) break;
    ticks.push(v);
  }
  return ticks;
};

/**
 * Emits ticks on nice time-step boundaries within `[domainMin, domainMax]`.
 * Does not force exactly `targetCount` ticks — nice steps produce ~target ± a few.
 * If a step would yield more than {@link MAX_TIME_X_TICK_COUNT} ticks, the next
 * larger ladder step is used. On the last ladder step, ticks are stride-sampled
 * across the full domain (not a truncated prefix).
 *
 * @param domainMin - Domain minimum (epoch-ms or any ms scale)
 * @param domainMax - Domain maximum
 * @param targetCount - Approximate desired tick count (used for step selection)
 * @returns Tick values in ascending order within the domain
 */
const generateTimeTicks = (domainMin: number, domainMax: number, targetCount: number): number[] => {
  if (!Number.isFinite(domainMin) || !Number.isFinite(domainMax)) return [];

  let min = domainMin;
  let max = domainMax;
  if (max < min) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  if (max === min) return [min];

  const range = max - min;
  let step = chooseTimeTickStepMs(range, targetCount);
  let stepIdx = TIME_TICK_STEPS_MS.indexOf(step);
  if (stepIdx < 0) stepIdx = 0;

  for (;;) {
    const first = firstLatticeTick(min, max, step);
    if (first == null) {
      // Range ≪ step: fall back to endpoints (max === min already returned above).
      return [min, max];
    }

    const isLastStep = stepIdx >= TIME_TICK_STEPS_MS.length - 1;

    // On the last ladder step, estimate full lattice count and stride-sample so
    // multi-year (or larger) domains span the window instead of clustering near min.
    if (isLastStep) {
      const fullCount = Math.floor((max - first) / step) + 1;
      if (fullCount <= MAX_TIME_X_TICK_COUNT) {
        const ticks: number[] = [];
        for (let i = 0; i < fullCount; i++) {
          ticks.push(first + i * step);
        }
        return ticks;
      }
      return emitStridedLattice(first, max, step, fullCount);
    }

    const ticks: number[] = [];
    let t = first;
    while (t <= max) {
      ticks.push(t);
      t += step;
      // Safety: stop pathological growth before enlarging step.
      if (ticks.length > MAX_TIME_X_TICK_COUNT + 2) break;
    }

    if (ticks.length <= MAX_TIME_X_TICK_COUNT) {
      return ticks;
    }

    stepIdx += 1;
    step = TIME_TICK_STEPS_MS[stepIdx]!;
  }
};

/**
 * Generates evenly-spaced tick values across domain.
 * Single implementation lives in `axis/computeAxisTicks` (re-exported here).
 */
export const generateLinearTicks = generateLinearTicksCanonical;

/**
 * Subsamples a nice tick set by keeping every `stride`-th value (1-based stride).
 * Used when adjacent adaptive targetCounts map to the same ladder step so density
 * can thin step-wise without waiting for the next larger nice step.
 */
const subsampleTicks = (ticks: readonly number[], stride: number): number[] => {
  if (stride <= 1) return ticks.slice();
  const out: number[] = [];
  for (let i = 0; i < ticks.length; i += stride) {
    out.push(ticks[i]!);
  }
  return out;
};

/**
 * Computes optimal tick count + values to avoid label overlap on time x-axis.
 * Uses nice time steps ({@link generateTimeTicks}) and text measurement to test
 * label widths. Tries target counts from MAX (9) down to MIN (1); when a candidate
 * set overlaps, also tries stride-2 / stride-3 subsamples of that nice set before
 * dropping further. Density control is therefore **step-wise** (ladder rung +
 * within-set subsample), not an exact linear tick count.
 *
 * @param params - Configuration object with axis, scale, canvas, and measurement settings
 * @returns Object with tickCount (actual tickValues.length) and tickValues
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
    const tickValues = generateTimeTicks(domainMin, domainMax, DEFAULT_TICK_COUNT);
    return {
      tickCount: tickValues.length > 0 ? tickValues.length : DEFAULT_TICK_COUNT,
      tickValues: tickValues.length > 0 ? tickValues : generateLinearTicks(domainMin, domainMax, DEFAULT_TICK_COUNT),
    };
  }

  // Ensure the measurement font matches the overlay labels.
  measureCtx.font = `${fontSize}px ${fontFamily}`;
  if (measureCache && measureCache.size > 2000) measureCache.clear();

  // Pre-construct the font part of the cache key to avoid repeated concatenation.
  const cacheKeyPrefix = measureCache ? `${fontSize}px ${fontFamily}@@` : null;

  const labelsFit = (tickValues: readonly number[]): boolean => {
    let prevRight = Number.NEGATIVE_INFINITY;
    const n = tickValues.length;

    for (let i = 0; i < n; i++) {
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

      const anchor: TextOverlayAnchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';

      const left = anchor === 'start' ? xCss : anchor === 'end' ? xCss - w : xCss - w * 0.5;
      const right = anchor === 'start' ? xCss + w : anchor === 'end' ? xCss : xCss + w * 0.5;

      if (left < prevRight + MIN_X_LABEL_GAP_CSS_PX) {
        return false;
      }
      prevRight = right;
    }
    return true;
  };

  // Skip identical nice sets produced by adjacent targetCounts (same ladder step).
  let lastSignature: string | null = null;

  for (let targetCount = MAX_TIME_X_TICK_COUNT; targetCount >= MIN_TIME_X_TICK_COUNT; targetCount--) {
    const baseTicks = generateTimeTicks(domainMin, domainMax, targetCount);
    if (baseTicks.length === 0) continue;

    const signature = baseTicks.join(',');
    if (signature === lastSignature) continue;
    lastSignature = signature;

    // Full nice set, then every 2nd / 3rd tick before the next ladder target.
    const maxStride = Math.max(1, baseTicks.length - 1);
    for (let stride = 1; stride <= maxStride && stride <= 3; stride++) {
      const tickValues = stride === 1 ? baseTicks : subsampleTicks(baseTicks, stride);
      if (tickValues.length === 0) continue;
      if (labelsFit(tickValues)) {
        return { tickCount: tickValues.length, tickValues };
      }
    }
  }

  const fallback = generateTimeTicks(domainMin, domainMax, MIN_TIME_X_TICK_COUNT);
  return {
    tickCount: fallback.length > 0 ? fallback.length : MIN_TIME_X_TICK_COUNT,
    tickValues: fallback.length > 0 ? fallback : generateLinearTicks(domainMin, domainMax, MIN_TIME_X_TICK_COUNT),
  };
};
