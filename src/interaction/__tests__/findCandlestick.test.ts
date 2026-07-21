import { describe, it, expect } from 'vitest';
import { createLinearScale } from '../../utils/scales';
import { computeCandlestickBodyWidthRange, findCandlestick, type FinanceOhlcHitSeriesConfig } from '../findCandlestick';
import type { OHLCDataPoint } from '../../config/types';

/**
 * Single bar: open=50, close=60, low=40, high=70 at x=100.
 * Body (open/close) y range [50,60]; stem (low/high) [40,70].
 */
const data: ReadonlyArray<OHLCDataPoint> = [[100, 50, 60, 40, 70]];

const seriesCfg: FinanceOhlcHitSeriesConfig = {
  type: 'ohlc',
  data,
  rawData: data,
  color: '#0f0',
  barWidth: 20, // CSS px range units when scales map 1:1
  barMinWidth: 1,
  barMaxWidth: 100,
  stemWidth: 1,
  tickLength: '45%',
  itemStyle: {
    upColor: '#0f0',
    downColor: '#f00',
    upBorderColor: '#0a0',
    downBorderColor: '#a00',
    borderWidth: 1,
  },
  sampling: 'none',
  samplingThreshold: 5000,
  priceLabel: {
    show: false,
    showLine: false,
    intervalMs: null,
    showCountdown: false,
    nowMs: null,
    formatter: null,
    outOfDomain: 'clamp',
    color: null,
    lineColor: null,
    lineWidth: 1,
  },
  yAxis: 'y',
  visible: true,
} as FinanceOhlcHitSeriesConfig;

// Identity domain→range so scale(v)=v for easy anchor math.
const xScale = createLinearScale({ domain: { min: 0, max: 200 }, range: { min: 0, max: 200 } });
const yScale = createLinearScale({ domain: { min: 0, max: 100 }, range: { min: 0, max: 100 } });

describe('findCandlestick yHitMode', () => {
  it('openClose hits inside open–close body', () => {
    const m = findCandlestick([seriesCfg], 100, 55, xScale, yScale, 20, { yHitMode: 'openClose' });
    expect(m).not.toBeNull();
    expect(m!.dataIndex).toBe(0);
    expect(m!.point).toBe(data[0]);
  });

  it('openClose misses on stem outside body (high wick region)', () => {
    // y=65 is between body top (60) and high (70) — wick only
    const m = findCandlestick([seriesCfg], 100, 65, xScale, yScale, 20, { yHitMode: 'openClose' });
    expect(m).toBeNull();
  });

  it('openClose misses on stem outside body (low wick region)', () => {
    const m = findCandlestick([seriesCfg], 100, 45, xScale, yScale, 20, { yHitMode: 'openClose' });
    expect(m).toBeNull();
  });

  it('lowHigh hits stem outside open–close (OHLC bars)', () => {
    const highWick = findCandlestick([seriesCfg], 100, 65, xScale, yScale, 20, { yHitMode: 'lowHigh' });
    expect(highWick).not.toBeNull();
    expect(highWick!.dataIndex).toBe(0);

    const lowWick = findCandlestick([seriesCfg], 100, 45, xScale, yScale, 20, { yHitMode: 'lowHigh' });
    expect(lowWick).not.toBeNull();
  });

  it('lowHigh hits doji-style body range when open===close but stem has range', () => {
    const doji: ReadonlyArray<OHLCDataPoint> = [[100, 50, 50, 40, 70]];
    const cfg = { ...seriesCfg, data: doji, rawData: doji } as FinanceOhlcHitSeriesConfig;
    // openClose: open===close → zero-height body still includes y=open
    const body = findCandlestick([cfg], 100, 50, xScale, yScale, 20, { yHitMode: 'openClose' });
    expect(body).not.toBeNull();
    // openClose misses wick
    expect(findCandlestick([cfg], 100, 65, xScale, yScale, 20, { yHitMode: 'openClose' })).toBeNull();
    // lowHigh hits wick — doji bars remain hittable via stem
    expect(findCandlestick([cfg], 100, 65, xScale, yScale, 20, { yHitMode: 'lowHigh' })).not.toBeNull();
  });

  it('rejects non-finite cursor / zero bar width', () => {
    expect(findCandlestick([seriesCfg], Number.NaN, 55, xScale, yScale, 20)).toBeNull();
    expect(findCandlestick([seriesCfg], 100, Number.NaN, xScale, yScale, 20)).toBeNull();
    expect(findCandlestick([seriesCfg], 100, 55, xScale, yScale, 0)).toBeNull();
    expect(findCandlestick([seriesCfg], 100, 55, xScale, yScale, -1)).toBeNull();
  });

  it('misses when x is outside half bar width', () => {
    // halfW=10 → center 100, x=120 is outside
    expect(findCandlestick([seriesCfg], 120, 55, xScale, yScale, 20, { yHitMode: 'lowHigh' })).toBeNull();
  });

  it('defaults to openClose when yHitMode omitted', () => {
    expect(findCandlestick([seriesCfg], 100, 65, xScale, yScale, 20)).toBeNull();
    expect(findCandlestick([seriesCfg], 100, 55, xScale, yScale, 20)).not.toBeNull();
  });
});

describe('computeCandlestickBodyWidthRange finance family', () => {
  it('accepts ohlc-shaped config without cast gymnastics', () => {
    const w = computeCandlestickBodyWidthRange(seriesCfg, data, xScale, 200);
    expect(w).toBeGreaterThan(0);
    expect(Number.isFinite(w)).toBe(true);
  });
});

describe('kind mapping contract (caller responsibility)', () => {
  it('documents that findCandlestick returns OHLC fields; kind is assigned by caller type', () => {
    const m = findCandlestick([seriesCfg], 100, 65, xScale, yScale, 20, { yHitMode: 'lowHigh' });
    expect(m).not.toBeNull();
    // Call sites map series.type → kind: 'ohlc' | 'candlestick'
    const kind = seriesCfg.type === 'ohlc' ? 'ohlc' : 'candlestick';
    expect(kind).toBe('ohlc');
    const point = m!.point;
    expect(Array.isArray(point) ? point[3] : point.low).toBe(40);
    expect(Array.isArray(point) ? point[4] : point.high).toBe(70);
  });
});
