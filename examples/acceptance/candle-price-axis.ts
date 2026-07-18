/**
 * Acceptance: candle-primary layout defaults + priceLabel resolution.
 *
 * TypeScript-only (no WebGPU). Excluded from the library build via examples/.
 *
 * Covers:
 * - isCandlePrimaryChart predicate (series[0] only)
 * - Right Y + dual-Y-safe soft gutters (per-key undefined only)
 * - priceLabel auto-enable on candle-primary; opt-out with false
 * - Countdown requires finite intervalMs > 0
 * - Series element identity reuse does not re-resolve in-place priceLabel mutation
 * - AxisConfig.header passthrough
 *
 * Visual regression checklist (manual / browser examples):
 * 1. examples/candlestick — right price rail, badge + line at last close, header unit
 * 2. priceLabel: false — no badge/line
 * 3. Dual-Y volume left — left gutter room; badge on price series only
 * 4. examples/candlestick-streaming — countdown with stable nowMs across setOption
 *
 * Run: bun run acceptance:candle-price-axis
 *   or: tsx examples/acceptance/candle-price-axis.ts
 */

import {
  isCandlePrimaryChart,
  resolveOptions,
  resolvePriceLabel,
} from '../../src/config/OptionResolver';
import type {
  CandlestickSeriesConfig,
  OHLCDataPoint,
  ResolvedCandlestickPriceLabel,
} from '../../src/index';

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const assertEqual = <T>(label: string, actual: T, expected: T): void => {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
  );
};

const ohlc: OHLCDataPoint[] = [
  [1_700_000_000_000, 100, 105, 99, 106],
  [1_700_000_060_000, 105, 110, 104, 111],
];

const candleSeries = {
  type: 'candlestick' as const,
  data: ohlc,
};

console.log('[acceptance:candle-price-axis] isCandlePrimaryChart...');

assertEqual('empty options', isCandlePrimaryChart({}), false);
assertEqual('empty series', isCandlePrimaryChart({ series: [] }), false);
assertEqual(
  'first candlestick',
  isCandlePrimaryChart({ series: [candleSeries] }),
  true
);
assertEqual(
  'first line',
  isCandlePrimaryChart({
    series: [{ type: 'line', data: [[0, 1]] }, candleSeries],
  }),
  false
);

console.log('[acceptance:candle-price-axis] candle-primary Y + grid defaults...');

{
  const resolved = resolveOptions({ series: [candleSeries] });
  assertEqual('synthetic y position right', resolved.yAxes[0]!.position, 'right');
  assertEqual('left gutter single candle', resolved.grid.left, 20);
  assertEqual('right gutter candle', resolved.grid.right, 70);
  assertEqual('top unchanged', resolved.grid.top, 40);
  assertEqual('bottom unchanged', resolved.grid.bottom, 40);
}

{
  const resolved = resolveOptions({
    series: [candleSeries],
    yAxis: { type: 'value', position: 'left' },
  });
  assertEqual('explicit left wins', resolved.yAxes[0]!.position, 'left');
  assertEqual('left Y → left gutter 60', resolved.grid.left, 60);
  assertEqual('right still soft 70', resolved.grid.right, 70);
}

{
  const resolved = resolveOptions({
    series: [candleSeries],
    grid: { left: 80 },
  });
  assertEqual('user left kept', resolved.grid.left, 80);
  assertEqual('right soft default', resolved.grid.right, 70);
}

{
  const resolved = resolveOptions({
    series: [candleSeries],
    grid: { left: 0 },
  });
  assertEqual('grid.left 0 preserved (not missing)', resolved.grid.left, 0);
  assertEqual('right soft default with left 0', resolved.grid.right, 70);
}

{
  const resolved = resolveOptions({
    series: [
      { ...candleSeries, yAxis: 'price' },
      { type: 'bar', data: [[0, 10]], yAxis: 'vol' },
    ],
    axes: {
      y: [
        { id: 'price', type: 'value' },
        { id: 'vol', type: 'value' },
      ],
    },
  });
  assertEqual('dual-Y price right', resolved.yAxes[0]!.position, 'right');
  assertEqual('dual-Y vol left', resolved.yAxes[1]!.position, 'left');
  assertEqual('dual-Y left gutter 60', resolved.grid.left, 60);
  assertEqual('dual-Y right gutter 70', resolved.grid.right, 70);
}

{
  const resolved = resolveOptions({
    series: [{ type: 'line', data: [[0, 1], [1, 2]] }],
  });
  assertEqual('non-candle Y left', resolved.yAxes[0]!.position, 'left');
  assertEqual('non-candle left gutter', resolved.grid.left, 60);
  assertEqual('non-candle right gutter', resolved.grid.right, 20);
}

console.log('[acceptance:candle-price-axis] priceLabel resolve + attach...');

{
  const auto = resolvePriceLabel(undefined, { candlePrimary: true });
  assertEqual('auto candle show', auto.show, true);
  assertEqual('auto candle showLine', auto.showLine, true);
  assertEqual('auto candle no countdown', auto.showCountdown, false);

  const off = resolvePriceLabel(undefined, { candlePrimary: false });
  assertEqual('auto non-candle show', off.show, false);

  const forcedOff = resolvePriceLabel(false, { candlePrimary: true });
  assertEqual('false forces off', forcedOff.show, false);
  assertEqual('false forces showLine off', forcedOff.showLine, false);

  const withInterval = resolvePriceLabel({ intervalMs: 60_000 }, { candlePrimary: false });
  assertEqual('interval enables countdown', withInterval.showCountdown, true);
  assertEqual('intervalMs kept', withInterval.intervalMs, 60_000);

  const noCountdown = resolvePriceLabel(
    { intervalMs: 60_000, showCountdown: false },
    { candlePrimary: true }
  );
  assertEqual('explicit showCountdown false', noCountdown.showCountdown, false);

  const invalidInterval = resolvePriceLabel({ intervalMs: 0 }, { candlePrimary: true });
  assertEqual('intervalMs 0 rejected', invalidInterval.intervalMs, null);
  assertEqual('countdown off without interval', invalidInterval.showCountdown, false);
}

{
  const resolved = resolveOptions({ series: [candleSeries] });
  const s = resolved.series[0]!;
  assert(s.type === 'candlestick', 'expected candlestick series');
  if (s.type === 'candlestick') {
    assertEqual('attached auto show', s.priceLabel.show, true);
    assertEqual('attached auto showLine', s.priceLabel.showLine, true);
  }
}

{
  const resolved = resolveOptions({
    series: [{ ...candleSeries, priceLabel: false }],
  });
  const s = resolved.series[0]!;
  assert(s.type === 'candlestick', 'expected candlestick series');
  if (s.type === 'candlestick') {
    assertEqual('opt-out show', s.priceLabel.show, false);
    assertEqual('opt-out showLine', s.priceLabel.showLine, false);
  }
}

{
  const nowMs = (): number => 42;
  const resolved = resolveOptions({
    series: [
      {
        ...candleSeries,
        priceLabel: { intervalMs: 60_000, nowMs, showLine: false },
      },
    ],
  });
  const s = resolved.series[0]!;
  assert(s.type === 'candlestick', 'expected candlestick series');
  if (s.type === 'candlestick') {
    assertEqual('object show', s.priceLabel.show, true);
    assertEqual('object showLine false', s.priceLabel.showLine, false);
    assertEqual('object showCountdown', s.priceLabel.showCountdown, true);
    assert(s.priceLabel.nowMs === nowMs, 'nowMs identity preserved');
  }
}

console.log('[acceptance:candle-price-axis] series identity reuse...');

{
  const seriesEl: {
    type: 'candlestick';
    data: OHLCDataPoint[];
    priceLabel: boolean | CandlestickSeriesConfig['priceLabel'];
  } = {
    type: 'candlestick',
    data: ohlc,
    priceLabel: true,
  };
  const firstUser = { series: [seriesEl], yAxis: { min: 0, max: 200 } };
  const first = resolveOptions(firstUser);
  const firstPl = (first.series[0] as { priceLabel: ResolvedCandlestickPriceLabel }).priceLabel;
  assertEqual('first resolve show', firstPl.show, true);

  // In-place mutation under stable element identity — must NOT re-resolve.
  seriesEl.priceLabel = false;
  const second = resolveOptions(
    { series: [seriesEl], yAxis: { min: 0, max: 300 } },
    {
      previousResolved: first,
      previousUserOptions: firstUser,
      lastUserSeriesElements: [seriesEl],
    }
  );
  assert(second.series === first.series, 'expected wholesale series array reuse');
  assertEqual(
    'stale priceLabel after in-place mutation',
    (second.series[0] as { priceLabel: ResolvedCandlestickPriceLabel }).priceLabel.show,
    true
  );

  // New element identity re-resolves.
  const nextEl = { type: 'candlestick' as const, data: ohlc, priceLabel: false as const };
  const third = resolveOptions(
    { series: [nextEl], yAxis: { min: 0, max: 200 } },
    {
      previousResolved: first,
      previousUserOptions: firstUser,
      lastUserSeriesElements: [seriesEl],
    }
  );
  assert(third.series !== first.series, 'expected new resolved series array');
  const thirdS = third.series[0]!;
  assert(thirdS.type === 'candlestick', 'expected candlestick');
  if (thirdS.type === 'candlestick') {
    assertEqual('new identity opt-out', thirdS.priceLabel.show, false);
  }
}

console.log('[acceptance:candle-price-axis] AxisConfig.header...');

{
  const resolved = resolveOptions({
    series: [candleSeries],
    yAxis: { type: 'value', header: 'USDT' },
  });
  assertEqual('header passthrough', resolved.yAxes[0]!.header, 'USDT');
  assertEqual('header does not block right default', resolved.yAxes[0]!.position, 'right');
}

console.log('[acceptance:candle-price-axis] all checks passed.');
