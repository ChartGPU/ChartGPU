import type { ChartGPUOptions, SeriesType } from './types';

/**
 * Finance OHLC family series types that share candlestick data / sampling /
 * priceLabel / append infrastructure.
 */
export type FinanceOhlcSeriesType = 'candlestick' | 'ohlc';

/** True when `type` is candlestick or thin OHLC bars. */
export function isFinanceOhlcSeriesType(type: string | undefined | null): type is FinanceOhlcSeriesType {
  return type === 'candlestick' || type === 'ohlc';
}

/**
 * Narrows a series object to finance OHLC family (`candlestick` | `ohlc`).
 * Prefer this over `isFinanceOhlcSeriesType(s.type)` when you need property access
 * under the discriminant (TypeScript does not re-narrow `s` from a type-string guard alone).
 */
export function isFinanceOhlcSeries<T extends { readonly type: string }>(
  s: T | null | undefined
): s is T & { readonly type: FinanceOhlcSeriesType } {
  return s != null && isFinanceOhlcSeriesType(s.type);
}

/**
 * True iff `series[0]` exists and is type `'candlestick'` or `'ohlc'`.
 *
 * Only the first series is considered. Overlay/indicator lines as `series[0]`
 * mean the chart is **not** finance-primary (consumers must set axis position /
 * gutters explicitly).
 *
 * Name kept as `isCandlePrimaryChart` for API stability; behavior includes OHLC bars.
 */
export function isCandlePrimaryChart(user: ChartGPUOptions): boolean {
  const series = user.series ?? [];
  const first = series[0];
  return first != null && isFinanceOhlcSeriesType(first.type as SeriesType);
}
