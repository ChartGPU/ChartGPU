/**
 * Pure helpers for the exchange-style last-price badge (priceLabel).
 *
 * Isolated from the render coordinator for unit testing and for OptionResolver
 * (PR3) / DOM sync (PR4a). Types here are the source of truth until PR3 mirrors
 * them onto CandlestickSeriesConfig / package exports.
 *
 * @module priceLabelHelpers
 */

import type { OHLCDataPoint, OHLCDataPointTuple } from '../../../config/types';
import { isTupleOHLCDataPoint } from '../utils/dataPointUtils';

// ---------------------------------------------------------------------------
// Config types (mirrored onto public API in PR3)
// ---------------------------------------------------------------------------

/**
 * Series-level last-price badge / line configuration (user input).
 */
export interface CandlestickPriceLabelConfig {
  /**
   * Show the last-price badge on the series' Y-axis rail.
   * When omitted inside an object form, treated as `true`.
   */
  readonly show?: boolean;

  /**
   * Draw a horizontal line at last close across the plot.
   * Default: same as resolved `show`.
   */
  readonly showLine?: boolean;

  /**
   * Candle period in ms for countdown secondary line.
   * Required for countdown; when omitted, price-only badge.
   */
  readonly intervalMs?: number;

  /**
   * Show countdown under price when `intervalMs` is set and bar end is known.
   * Default: `true` if `intervalMs` is finite and > 0, else `false`.
   */
  readonly showCountdown?: boolean;

  /**
   * Clock for countdown remaining time. Default at use site: `() => Date.now()`.
   */
  readonly nowMs?: () => number;

  /**
   * Format last close for the badge. Default: {@link formatPriceLabelValue}.
   * Never piped through axis tickFormatter or tooltip HTML builders.
   */
  readonly formatter?: (close: number) => string;

  /**
   * Out-of-domain behavior when last close is outside the current Y domain.
   * - `'clamp'`: pin badge to nearest plot edge, opacity 0.85 (default)
   * - `'hide'`: hide badge and price line
   */
  readonly outOfDomain?: 'clamp' | 'hide';

  /** Override badge text color (default `#ffffff`). */
  readonly color?: string;

  /**
   * Override **line** color only (default: direction color).
   * Badge background is always direction color.
   */
  readonly lineColor?: string;

  /** Line stroke width in CSS px (default: 1). */
  readonly lineWidth?: number;
}

export type ResolvedCandlestickPriceLabel = Readonly<{
  show: boolean;
  showLine: boolean;
  intervalMs: number | null;
  showCountdown: boolean;
  nowMs: (() => number) | null;
  formatter: ((close: number) => string) | null;
  outOfDomain: 'clamp' | 'hide';
  color: string | null;
  lineColor: string | null;
  lineWidth: number;
}>;

export type LastCandleState = Readonly<{
  seriesIndex: number;
  yAxisId: string;
  open: number;
  close: number;
  timestamp: number;
  /**
   * Badge direction: close >= open (flat counts as up per design).
   * Note: candlestick renderer body fill still uses strict close > open;
   * flat body height is zero so the visual difference is negligible.
   */
  isUp: boolean;
  upColor: string;
  downColor: string;
  directionColor: string;
  /** timestamp + intervalMs when interval set; else null. */
  barEndMs: number | null;
}>;

/** Minimal series shape for ownership scan (resolved or raw). */
export type PriceLabelOwnershipSeries = Readonly<{
  type: string;
  visible?: boolean;
  /**
   * Resolved `{ show }`, boolean sugar, full config object, or undefined
   * (undefined + candlePrimary → treated as show when scanning ownership).
   */
  priceLabel?: boolean | CandlestickPriceLabelConfig | Pick<ResolvedCandlestickPriceLabel, 'show'> | null;
}>;

const RESOLVED_OFF: ResolvedCandlestickPriceLabel = Object.freeze({
  show: false,
  showLine: false,
  intervalMs: null,
  showCountdown: false,
  nowMs: null,
  formatter: null,
  outOfDomain: 'clamp' as const,
  color: null,
  lineColor: null,
  lineWidth: 1,
});

function normalizeIntervalMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeLineWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Resolve series `priceLabel` input to a fully-specified config.
 *
 * Truth table (design rev 4):
 * | Input | candlePrimary | show | showLine | showCountdown |
 * |-------|---------------|------|----------|---------------|
 * | undefined | true | true | true | false |
 * | undefined | false | false | false | false |
 * | false | * | false | false | false |
 * | true | * | true | true | false |
 * | {} | * | true | true | false |
 * | { intervalMs: N } | * | true | true | true |
 * | { show: false, ... } | * | false | false | false |
 * | { showLine: true } | * | true | true | false |
 * | { show: true, showLine: false } | * | true | false | false |
 * | { showCountdown: true } no interval | * | true | true | **false** (+ warn) |
 * | { intervalMs, showCountdown: false } | * | true | true | false |
 */
export function resolvePriceLabel(
  input: boolean | CandlestickPriceLabelConfig | undefined,
  ctx: { readonly candlePrimary: boolean },
  options?: { readonly onWarn?: (message: string) => void }
): ResolvedCandlestickPriceLabel {
  if (input === false) {
    return RESOLVED_OFF;
  }

  if (input === undefined) {
    if (!ctx.candlePrimary) return RESOLVED_OFF;
    return {
      show: true,
      showLine: true,
      intervalMs: null,
      showCountdown: false,
      nowMs: null,
      formatter: null,
      outOfDomain: 'clamp',
      color: null,
      lineColor: null,
      lineWidth: 1,
    };
  }

  const obj: CandlestickPriceLabelConfig = input === true ? {} : input;
  const show = obj.show ?? true;

  if (!show) {
    return RESOLVED_OFF;
  }

  const intervalMs = normalizeIntervalMs(obj.intervalMs);

  if (obj.showCountdown === true && intervalMs == null) {
    options?.onWarn?.('ChartGPU: priceLabel.showCountdown requires a finite intervalMs > 0; countdown disabled.');
  }

  // showCountdown = show && intervalMs != null && (input.showCountdown ?? true)
  const showCountdown = intervalMs != null && (obj.showCountdown ?? true);
  const showLine = obj.showLine ?? show;

  return {
    show,
    showLine,
    intervalMs,
    showCountdown,
    nowMs: typeof obj.nowMs === 'function' ? obj.nowMs : null,
    formatter: typeof obj.formatter === 'function' ? obj.formatter : null,
    outOfDomain: obj.outOfDomain === 'hide' ? 'hide' : 'clamp',
    color: typeof obj.color === 'string' ? obj.color : null,
    lineColor: typeof obj.lineColor === 'string' ? obj.lineColor : null,
    lineWidth: normalizeLineWidth(obj.lineWidth),
  };
}

/**
 * Default badge number formatter (K12).
 * Plain string only — more precision than sparse axis ticks; never HTML.
 */
export function formatPriceLabelValue(close: number): string {
  if (!Number.isFinite(close)) return '';
  // Normalize -0 for display stability.
  const value = Object.is(close, -0) ? 0 : close;
  const abs = Math.abs(value);
  if (abs >= 1000) {
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  if (abs >= 1) {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString('en-US', { maximumSignificantDigits: 6 });
}

/**
 * Format remaining bar time as `HH:MM:SS` (always three fields).
 * Past end / non-finite → `00:00:00`.
 */
export function formatCountdown(remainingMs: number): string {
  const ms = Math.max(0, Math.floor(Number.isFinite(remainingMs) ? remainingMs : 0));
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Remaining ms until bar close; clamped at 0.
 */
export function remainingMsToBarClose(barEndMs: number | null | undefined, nowMs: number): number {
  if (barEndMs == null || !Number.isFinite(barEndMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, barEndMs - nowMs);
}

function readLastOhlc(point: OHLCDataPoint): Readonly<{ timestamp: number; open: number; close: number }> {
  if (isTupleOHLCDataPoint(point)) {
    const t = point as OHLCDataPointTuple;
    return { timestamp: t[0], open: t[1], close: t[2] };
  }
  return { timestamp: point.timestamp, open: point.open, close: point.close };
}

/**
 * Derive last-candle state from coordinator-owned raw OHLC.
 *
 * Data source (locked):
 * - Only `runtimeRawDataByIndex[seriesIndex]` (never sampled `series.data`)
 * - Always `raw[raw.length - 1]`
 * - Empty / non-finite open or close → null (hide badge + line)
 */
export function resolveLastCandleState(args: {
  readonly seriesIndex: number;
  readonly yAxisId: string;
  readonly raw: ReadonlyArray<OHLCDataPoint> | null | undefined;
  readonly upColor: string;
  readonly downColor: string;
  readonly intervalMs: number | null;
}): LastCandleState | null {
  const raw = args.raw;
  if (raw == null || raw.length === 0) return null;

  const last = raw[raw.length - 1]!;
  const { timestamp, open, close } = readLastOhlc(last);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return null;

  const isUp = close >= open;
  const directionColor = isUp ? args.upColor : args.downColor;
  const intervalMs = args.intervalMs;
  const barEndMs = intervalMs != null && Number.isFinite(timestamp) ? timestamp + intervalMs : null;

  return {
    seriesIndex: args.seriesIndex,
    yAxisId: args.yAxisId,
    open,
    close,
    timestamp: Number.isFinite(timestamp) ? timestamp : Number.NaN,
    isUp,
    upColor: args.upColor,
    downColor: args.downColor,
    directionColor,
    barEndMs,
  };
}

function seriesShowPriceLabel(s: PriceLabelOwnershipSeries, candlePrimary: boolean): boolean {
  if (s.type !== 'candlestick') return false;
  if (s.visible === false) return false;

  const pl = s.priceLabel;
  if (pl === false || pl === null) return false;
  if (pl === true) return true;
  if (pl === undefined) {
    // Unresolved auto: only candle-primary charts enable badge by default.
    return candlePrimary;
  }
  // Object / resolved: show defaults true when omitted (object presence enables).
  if (typeof pl === 'object') {
    return pl.show ?? true;
  }
  return false;
}

/**
 * Ownership (v1 — one badge per chart): first visible candlestick series with
 * resolved/raw `priceLabel.show` wins. Later candidates are ignored with at most
 * one warn per call (design: “one warn”).
 */
export function selectPriceLabelSeries(
  series: ReadonlyArray<PriceLabelOwnershipSeries>,
  options?: {
    readonly candlePrimary?: boolean;
    readonly onWarn?: (message: string) => void;
  }
): number | null {
  const candlePrimary = options?.candlePrimary ?? false;
  let winner: number | null = null;
  let warnedExtra = false;

  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    if (!seriesShowPriceLabel(s, candlePrimary)) continue;

    if (winner == null) {
      winner = i;
      continue;
    }

    // Single warn per call regardless of how many extras qualify.
    if (!warnedExtra) {
      warnedExtra = true;
      options?.onWarn?.('ChartGPU: multiple candlestick series have priceLabel.show; only the first is used (v1).');
    }
  }

  return winner;
}
