/**
 * Pure priceLabel helpers — last candle, formatters, ownership.
 * Config resolvePriceLabel truth table lives in config/__tests__/resolvePriceLabel.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import type { CandlestickPriceLabelConfig, OHLCDataPoint } from '../../../../config/types';
import {
  resolveLastCandleState,
  formatPriceLabelValue,
  formatCountdown,
  remainingMsToBarClose,
  selectPriceLabelSeries,
  type PriceLabelOwnershipSeries,
} from '../priceLabelHelpers';

// ---------------------------------------------------------------------------
// formatPriceLabelValue
// ---------------------------------------------------------------------------

describe('formatPriceLabelValue', () => {
  it('returns empty string for non-finite', () => {
    expect(formatPriceLabelValue(NaN)).toBe('');
    expect(formatPriceLabelValue(Infinity)).toBe('');
    expect(formatPriceLabelValue(-Infinity)).toBe('');
  });

  it('formats abs >= 1000 with up to 2 fraction digits', () => {
    expect(formatPriceLabelValue(1234.567)).toBe('1,234.57');
    expect(formatPriceLabelValue(1000)).toBe('1,000');
  });

  it('formats abs >= 1 with exactly 2 fraction digits', () => {
    expect(formatPriceLabelValue(42)).toBe('42.00');
    expect(formatPriceLabelValue(1.5)).toBe('1.50');
  });

  it('formats abs < 1 with significant digits', () => {
    const s = formatPriceLabelValue(0.000123456);
    expect(s.length).toBeGreaterThan(0);
    expect(Number(s)).toBeCloseTo(0.000123456, 6);
  });

  it('normalizes -0 to 0 (not "-0")', () => {
    const s = formatPriceLabelValue(-0);
    expect(s).not.toMatch(/-/);
    expect(Number(s)).toBe(0);
  });

  it('formats negative prices with a leading minus', () => {
    expect(formatPriceLabelValue(-42)).toBe('-42.00');
    expect(formatPriceLabelValue(-1234.5)).toBe('-1,234.5');
    const small = formatPriceLabelValue(-0.00123);
    expect(small.startsWith('-')).toBe(true);
    expect(Number(small)).toBeCloseTo(-0.00123, 5);
  });
});

// ---------------------------------------------------------------------------
// formatCountdown / remainingMsToBarClose
// ---------------------------------------------------------------------------

describe('formatCountdown', () => {
  it('formats HH:MM:SS', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(1_000)).toBe('00:00:01');
    expect(formatCountdown(61_000)).toBe('00:01:01');
    expect(formatCountdown(3_661_000)).toBe('01:01:01');
  });

  it('clamps negative and non-finite to 00:00:00', () => {
    expect(formatCountdown(-500)).toBe('00:00:00');
    expect(formatCountdown(NaN)).toBe('00:00:00');
  });

  it('floors partial seconds', () => {
    expect(formatCountdown(1_999)).toBe('00:00:01');
  });
});

describe('remainingMsToBarClose', () => {
  it('returns clamped remaining', () => {
    expect(remainingMsToBarClose(1_000, 200)).toBe(800);
    expect(remainingMsToBarClose(1_000, 2_000)).toBe(0);
  });

  it('returns 0 for null / non-finite', () => {
    expect(remainingMsToBarClose(null, 100)).toBe(0);
    expect(remainingMsToBarClose(undefined, 100)).toBe(0);
    expect(remainingMsToBarClose(NaN, 100)).toBe(0);
    expect(remainingMsToBarClose(1_000, NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveLastCandleState
// ---------------------------------------------------------------------------

describe('resolveLastCandleState', () => {
  const base = {
    seriesIndex: 0,
    yAxisId: 'price',
    upColor: '#22c55e',
    downColor: '#ef4444',
    intervalMs: null as number | null,
  };

  it('returns null for empty / missing raw', () => {
    expect(resolveLastCandleState({ ...base, raw: [] })).toBe(null);
    expect(resolveLastCandleState({ ...base, raw: null })).toBe(null);
    expect(resolveLastCandleState({ ...base, raw: undefined })).toBe(null);
  });

  it('uses last index of tuple OHLC (never first)', () => {
    const raw: OHLCDataPoint[] = [
      [1_000, 10, 11, 9, 12],
      [2_000, 11, 10, 9, 12], // down candle at end
    ];
    const s = resolveLastCandleState({ ...base, raw });
    expect(s).not.toBe(null);
    expect(s!.timestamp).toBe(2_000);
    expect(s!.open).toBe(11);
    expect(s!.close).toBe(10);
    expect(s!.isUp).toBe(false);
    expect(s!.directionColor).toBe('#ef4444');
  });

  it('supports object OHLC format', () => {
    const raw: OHLCDataPoint[] = [{ timestamp: 5_000, open: 100, close: 105, low: 99, high: 106 }];
    const s = resolveLastCandleState({ ...base, raw });
    expect(s!.open).toBe(100);
    expect(s!.close).toBe(105);
    expect(s!.isUp).toBe(true);
    expect(s!.directionColor).toBe('#22c55e');
  });

  it('flat candle (close === open) counts as up', () => {
    const raw: OHLCDataPoint[] = [[1, 50, 50, 49, 51]];
    const s = resolveLastCandleState({ ...base, raw });
    expect(s!.isUp).toBe(true);
    expect(s!.directionColor).toBe('#22c55e');
  });

  it('returns null when open or close is non-finite', () => {
    expect(resolveLastCandleState({ ...base, raw: [[1, NaN, 2, 0, 3]] })).toBe(null);
    expect(resolveLastCandleState({ ...base, raw: [[1, 1, Infinity, 0, 3]] })).toBe(null);
  });

  it('sets barEndMs = timestamp + intervalMs when interval set', () => {
    const raw: OHLCDataPoint[] = [[10_000, 1, 2, 0.5, 2.5]];
    const s = resolveLastCandleState({ ...base, raw, intervalMs: 60_000 });
    expect(s!.barEndMs).toBe(70_000);
  });

  it('barEndMs is null without interval', () => {
    const raw: OHLCDataPoint[] = [[10_000, 1, 2, 0.5, 2.5]];
    const s = resolveLastCandleState({ ...base, raw, intervalMs: null });
    expect(s!.barEndMs).toBe(null);
  });

  it('never uses earlier candles when raw grows (forming bar / append)', () => {
    const raw: OHLCDataPoint[] = [
      [1_000, 1, 1.1, 0.9, 1.2],
      [2_000, 1.1, 1.05, 1.0, 1.15],
    ];
    // Mutate last candle in place (forming bar path)
    (raw as OHLCDataPoint[]).push([3_000, 1.05, 1.2, 1.04, 1.22]);
    const s = resolveLastCandleState({ ...base, raw });
    expect(s!.timestamp).toBe(3_000);
    expect(s!.close).toBe(1.2);
    expect(s!.isUp).toBe(true);
  });

  it('non-finite timestamp + valid open/close still returns state; barEndMs null', () => {
    const raw: OHLCDataPoint[] = [[NaN, 10, 11, 9, 12]];
    const s = resolveLastCandleState({ ...base, raw, intervalMs: 60_000 });
    expect(s).not.toBe(null);
    expect(s!.open).toBe(10);
    expect(s!.close).toBe(11);
    expect(s!.isUp).toBe(true);
    expect(Number.isNaN(s!.timestamp)).toBe(true);
    // Cannot compute bar end without a finite open timestamp
    expect(s!.barEndMs).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// selectPriceLabelSeries ownership
// ---------------------------------------------------------------------------

describe('selectPriceLabelSeries', () => {
  it('returns null for empty series', () => {
    expect(selectPriceLabelSeries([])).toBe(null);
  });

  it('skips non-candlestick series', () => {
    const series: PriceLabelOwnershipSeries[] = [
      { type: 'line', priceLabel: true },
      { type: 'candlestick', priceLabel: { show: true } },
    ];
    expect(selectPriceLabelSeries(series)).toBe(1);
  });

  it('accepts ohlc series for priceLabel ownership', () => {
    const series: PriceLabelOwnershipSeries[] = [
      { type: 'line', priceLabel: true },
      { type: 'ohlc', priceLabel: { show: true } },
    ];
    expect(selectPriceLabelSeries(series)).toBe(1);
  });

  it('skips visible: false and may pick later candle', () => {
    const series: PriceLabelOwnershipSeries[] = [
      { type: 'candlestick', visible: false, priceLabel: { show: true } },
      { type: 'candlestick', priceLabel: { show: true } },
    ];
    expect(selectPriceLabelSeries(series)).toBe(1);
  });

  it('first show:true wins; warns on second', () => {
    const onWarn = vi.fn();
    const series: PriceLabelOwnershipSeries[] = [
      { type: 'candlestick', priceLabel: { show: true } },
      { type: 'candlestick', priceLabel: { show: true } },
    ];
    expect(selectPriceLabelSeries(series, { onWarn })).toBe(0);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it('warns only once when three+ series qualify (design: one warn)', () => {
    const onWarn = vi.fn();
    const series: PriceLabelOwnershipSeries[] = [
      { type: 'candlestick', priceLabel: { show: true } },
      { type: 'candlestick', priceLabel: { show: true } },
      { type: 'candlestick', priceLabel: { show: true } },
    ];
    expect(selectPriceLabelSeries(series, { onWarn })).toBe(0);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it('show: false does not win; next candidate can', () => {
    const series: PriceLabelOwnershipSeries[] = [
      { type: 'candlestick', priceLabel: { show: false } },
      { type: 'candlestick', priceLabel: { show: true } },
    ];
    expect(selectPriceLabelSeries(series)).toBe(1);
  });

  it('priceLabel: false never wins', () => {
    const series: PriceLabelOwnershipSeries[] = [
      { type: 'candlestick', priceLabel: false },
      { type: 'candlestick', priceLabel: true },
    ];
    expect(selectPriceLabelSeries(series)).toBe(1);
  });

  it('undefined priceLabel + candlePrimary → first candle wins', () => {
    const series: PriceLabelOwnershipSeries[] = [
      { type: 'line' },
      { type: 'candlestick' }, // undefined priceLabel
    ];
    expect(selectPriceLabelSeries(series, { candlePrimary: true })).toBe(1);
    expect(selectPriceLabelSeries(series, { candlePrimary: false })).toBe(null);
  });

  it('object without show ⇒ enable (object presence)', () => {
    const series: PriceLabelOwnershipSeries[] = [
      { type: 'candlestick', priceLabel: { intervalMs: 60_000 } as CandlestickPriceLabelConfig },
    ];
    expect(selectPriceLabelSeries(series)).toBe(0);
  });

  it('returns null when no candle has show', () => {
    const series: PriceLabelOwnershipSeries[] = [{ type: 'candlestick', priceLabel: { show: false } }, { type: 'bar' }];
    expect(selectPriceLabelSeries(series, { candlePrimary: true })).toBe(null);
  });
});
