import type { ChartGPUOptions } from './types';

/**
 * True iff `series[0]` exists and is type `'candlestick'`.
 *
 * Only rule: first series is candlestick. Overlay/indicator lines as `series[0]`
 * mean the chart is **not** candle-primary (user must set `position: 'right'`
 * and gutters explicitly).
 */
export function isCandlePrimaryChart(user: ChartGPUOptions): boolean {
  const series = user.series ?? [];
  const first = series[0];
  return first != null && first.type === 'candlestick';
}
