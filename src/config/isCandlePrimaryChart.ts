import type { ChartGPUOptions } from './types';

/**
 * True iff `series[0]` exists and is type `'candlestick'`.
 *
 * Only the first series is considered. Overlay/indicator lines as `series[0]`
 * mean the chart is **not** candle-primary (consumers must set axis position /
 * gutters explicitly).
 */
export function isCandlePrimaryChart(user: ChartGPUOptions): boolean {
  const series = user.series ?? [];
  const first = series[0];
  return first != null && first.type === 'candlestick';
}
