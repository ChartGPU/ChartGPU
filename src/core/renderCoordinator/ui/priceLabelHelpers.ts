/**
 * Pure helpers for the exchange-style last-price badge (priceLabel).
 *
 * Config resolution (`resolvePriceLabel`, types) lives in `src/config/` — single
 * source of truth. This module owns last-candle derivation, ownership scan,
 * default price/countdown formatters used by the coordinator frame sync.
 *
 * @module priceLabelHelpers
 */

import type { OHLCDataPoint, OHLCDataPointTuple, CandlestickPriceLabelConfig } from '../../../config/types';
import type { ResolvedCandlestickPriceLabel } from '../../../config/resolvePriceLabel';
import { isTupleOHLCDataPoint } from '../utils/dataPointUtils';

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
  if (!(s.type === 'candlestick' || s.type === 'ohlc')) return false;
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
