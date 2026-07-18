import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isCandlePrimaryChart } from '../isCandlePrimaryChart';
import { resolvePriceLabel, type ResolvedCandlestickPriceLabel } from '../resolvePriceLabel';
import { resolveOptions } from '../OptionResolver';
import type { CandlestickSeriesConfig, OHLCDataPoint } from '../types';

const ohlc: OHLCDataPoint[] = [
  [1_700_000_000_000, 100, 105, 99, 106],
  [1_700_000_060_000, 105, 110, 104, 111],
];

const defaultsOn = (overrides: Partial<ResolvedCandlestickPriceLabel> = {}): ResolvedCandlestickPriceLabel => ({
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
  ...overrides,
});

const allOff = (): ResolvedCandlestickPriceLabel => ({
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
});

describe('isCandlePrimaryChart', () => {
  it('is true when series[0] is candlestick', () => {
    expect(
      isCandlePrimaryChart({
        series: [{ type: 'candlestick', data: ohlc }],
      })
    ).toBe(true);
  });

  it('is false when series[0] is line (even if later series is candlestick)', () => {
    expect(
      isCandlePrimaryChart({
        series: [
          { type: 'line', data: [[0, 1]] },
          { type: 'candlestick', data: ohlc },
        ],
      })
    ).toBe(false);
  });

  it('is false when series is empty or omitted', () => {
    expect(isCandlePrimaryChart({})).toBe(false);
    expect(isCandlePrimaryChart({ series: [] })).toBe(false);
  });
});

describe('resolvePriceLabel truth table', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('undefined + candlePrimary true → show/showLine true, no countdown', () => {
    expect(resolvePriceLabel(undefined, { candlePrimary: true })).toEqual(defaultsOn());
  });

  it('undefined + candlePrimary false → all off', () => {
    expect(resolvePriceLabel(undefined, { candlePrimary: false })).toEqual(allOff());
  });

  it('false → all off regardless of candlePrimary', () => {
    expect(resolvePriceLabel(false, { candlePrimary: true })).toEqual(allOff());
    expect(resolvePriceLabel(false, { candlePrimary: false })).toEqual(allOff());
  });

  it('true → show true + field defaults (no countdown without interval)', () => {
    expect(resolvePriceLabel(true, { candlePrimary: false })).toEqual(defaultsOn());
    expect(resolvePriceLabel(true, { candlePrimary: true })).toEqual(defaultsOn());
  });

  it('{} object implies enable', () => {
    expect(resolvePriceLabel({}, { candlePrimary: false })).toEqual(defaultsOn());
  });

  it('{ intervalMs: 60000 } enables countdown by default', () => {
    expect(resolvePriceLabel({ intervalMs: 60_000 }, { candlePrimary: false })).toEqual(
      defaultsOn({ intervalMs: 60_000, showCountdown: true })
    );
  });

  it('{ show: false, intervalMs } → show/line/countdown all off; interval still resolved', () => {
    // show false wins for line/countdown; intervalMs still normalizes when provided
    const resolved = resolvePriceLabel({ show: false, intervalMs: 60_000 }, { candlePrimary: true });
    expect(resolved.show).toBe(false);
    expect(resolved.showLine).toBe(false);
    expect(resolved.showCountdown).toBe(false);
    expect(resolved.intervalMs).toBe(60_000);
  });

  it('{ showLine: true } object ⇒ show true', () => {
    expect(resolvePriceLabel({ showLine: true }, { candlePrimary: false })).toEqual(defaultsOn({ showLine: true }));
  });

  it('{ show: true, showLine: false } keeps line off', () => {
    expect(resolvePriceLabel({ show: true, showLine: false }, { candlePrimary: false })).toEqual(
      defaultsOn({ showLine: false })
    );
  });

  it('{ showCountdown: true } without interval → showCountdown false + warn once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = resolvePriceLabel({ showCountdown: true }, { candlePrimary: false });
    const second = resolvePriceLabel({ showCountdown: true }, { candlePrimary: false });
    expect(first.showCountdown).toBe(false);
    expect(first.show).toBe(true);
    expect(second.showCountdown).toBe(false);
    // warn-once across module lifetime; at least one call in this process
    expect(warn.mock.calls.some((c) => String(c[0]).includes('showCountdown'))).toBe(true);
    warn.mockRestore();
  });

  it('{ intervalMs, showCountdown: false } respects explicit countdown off', () => {
    expect(resolvePriceLabel({ intervalMs: 60_000, showCountdown: false }, { candlePrimary: false })).toEqual(
      defaultsOn({ intervalMs: 60_000, showCountdown: false })
    );
  });

  it('rejects non-positive / non-finite intervalMs', () => {
    expect(resolvePriceLabel({ intervalMs: 0 }, { candlePrimary: false }).intervalMs).toBeNull();
    expect(resolvePriceLabel({ intervalMs: -1 }, { candlePrimary: false }).intervalMs).toBeNull();
    expect(resolvePriceLabel({ intervalMs: NaN }, { candlePrimary: false }).intervalMs).toBeNull();
    expect(resolvePriceLabel({ intervalMs: Number.POSITIVE_INFINITY }, { candlePrimary: false }).intervalMs).toBeNull();
  });

  it('passes through nowMs, formatter, colors; defaults outOfDomain/lineWidth', () => {
    const nowMs = () => 42;
    const formatter = (c: number) => `$${c}`;
    const resolved = resolvePriceLabel(
      {
        nowMs,
        formatter,
        color: '#fff',
        lineColor: '#0f0',
        lineWidth: 2,
        outOfDomain: 'hide',
      },
      { candlePrimary: false }
    );
    expect(resolved.nowMs).toBe(nowMs);
    expect(resolved.formatter).toBe(formatter);
    expect(resolved.color).toBe('#fff');
    expect(resolved.lineColor).toBe('#0f0');
    expect(resolved.lineWidth).toBe(2);
    expect(resolved.outOfDomain).toBe('hide');
  });

  it('invalid lineWidth falls back to 1; invalid outOfDomain falls back to clamp', () => {
    expect(resolvePriceLabel({ lineWidth: 0, outOfDomain: 'nope' as 'clamp' }, { candlePrimary: false })).toMatchObject(
      { lineWidth: 1, outOfDomain: 'clamp' }
    );
  });
});

describe('OptionResolver attaches resolved priceLabel (non-reuse path)', () => {
  it('candle-primary undefined priceLabel → show true', () => {
    const resolved = resolveOptions({
      series: [{ type: 'candlestick', data: ohlc }],
    });
    const s = resolved.series[0];
    expect(s.type).toBe('candlestick');
    if (s.type === 'candlestick') {
      expect(s.priceLabel.show).toBe(true);
      expect(s.priceLabel.showLine).toBe(true);
      expect(s.priceLabel.showCountdown).toBe(false);
    }
  });

  it('non-candle-primary candlestick series auto priceLabel is off', () => {
    const resolved = resolveOptions({
      series: [
        { type: 'line', data: [[0, 1]] },
        { type: 'candlestick', data: ohlc },
      ],
    });
    const s = resolved.series[1];
    expect(s.type).toBe('candlestick');
    if (s.type === 'candlestick') {
      expect(s.priceLabel.show).toBe(false);
    }
  });

  it('explicit false opts out on candle-primary', () => {
    const resolved = resolveOptions({
      series: [{ type: 'candlestick', data: ohlc, priceLabel: false }],
    });
    const s = resolved.series[0];
    if (s.type === 'candlestick') {
      expect(s.priceLabel).toEqual(allOff());
    }
  });

  it('object config is fully resolved (not raw passthrough)', () => {
    const nowMs = () => 99;
    const resolved = resolveOptions({
      series: [
        {
          type: 'candlestick',
          data: ohlc,
          priceLabel: { intervalMs: 60_000, nowMs, showLine: false },
        },
      ],
    });
    const s = resolved.series[0];
    if (s.type === 'candlestick') {
      expect(s.priceLabel).toEqual(
        defaultsOn({
          intervalMs: 60_000,
          showCountdown: true,
          nowMs,
          showLine: false,
        })
      );
    }
  });
});

describe('priceLabel series element identity reuse', () => {
  it('wholesale series reuse keeps prior resolved priceLabel when element identity is stable', () => {
    const seriesEl = {
      type: 'candlestick' as const,
      data: ohlc,
      priceLabel: true as boolean | CandlestickSeriesConfig['priceLabel'],
    };
    const firstUser = { series: [seriesEl], yAxis: { min: 0, max: 200 } };
    const first = resolveOptions(firstUser);
    expect((first.series[0] as { priceLabel: ResolvedCandlestickPriceLabel }).priceLabel.show).toBe(true);

    // In-place mutation under stable element (not a new identity) — should NOT re-resolve.
    (seriesEl as { priceLabel: boolean | CandlestickSeriesConfig['priceLabel'] }).priceLabel = false;

    const second = resolveOptions(
      { series: [seriesEl], yAxis: { min: 0, max: 300 } },
      {
        previousResolved: first,
        previousUserOptions: firstUser,
        lastUserSeriesElements: [seriesEl],
      }
    );
    expect(second.series).toBe(first.series);
    expect((second.series[0] as { priceLabel: ResolvedCandlestickPriceLabel }).priceLabel.show).toBe(true);
  });

  it('new series element identity re-resolves priceLabel', () => {
    const data = ohlc;
    const firstEl = { type: 'candlestick' as const, data, priceLabel: true as const };
    const firstUser = { series: [firstEl], yAxis: { min: 0, max: 200 } };
    const first = resolveOptions(firstUser);

    const nextEl = { type: 'candlestick' as const, data, priceLabel: false as const };
    const second = resolveOptions(
      { series: [nextEl], yAxis: { min: 0, max: 200 } },
      {
        previousResolved: first,
        previousUserOptions: firstUser,
        lastUserSeriesElements: [firstEl],
      }
    );
    expect(second.series).not.toBe(first.series);
    const s = second.series[0];
    expect(s.type).toBe('candlestick');
    if (s.type === 'candlestick') {
      expect(s.priceLabel.show).toBe(false);
    }
  });
});
