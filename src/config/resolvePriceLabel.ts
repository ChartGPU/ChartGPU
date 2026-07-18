import type { CandlestickPriceLabelConfig } from './types';

/**
 * Fully resolved last-price badge / line settings attached to each resolved
 * candlestick series (non-reuse OptionResolver path).
 */
export type ResolvedCandlestickPriceLabel = Readonly<{
  show: boolean;
  showLine: boolean;
  intervalMs: number | null;
  showCountdown: boolean;
  /** null → use `Date.now` at the countdown use site */
  nowMs: (() => number) | null;
  formatter: ((close: number) => string) | null;
  outOfDomain: 'clamp' | 'hide';
  color: string | null;
  lineColor: string | null;
  lineWidth: number;
}>;

export type ResolvePriceLabelContext = Readonly<{
  readonly candlePrimary: boolean;
}>;

const ALL_OFF: ResolvedCandlestickPriceLabel = Object.freeze({
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

let showCountdownWithoutIntervalWarned = false;

const warnShowCountdownNeedsInterval = (): void => {
  if (showCountdownWithoutIntervalWarned) return;
  showCountdownWithoutIntervalWarned = true;
  console.warn('[ChartGPU] priceLabel.showCountdown requires a finite intervalMs > 0; countdown disabled.');
};

const resolveIntervalMs = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
};

const resolveLineWidth = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return 1;
};

const resolveOptionalString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Resolve candlestick `priceLabel` sugar / config into a stable runtime shape.
 *
 * Truth table (locked):
 * 1. `undefined` → `show = candlePrimary`
 * 2. `false` → all off
 * 3. `true` → show true + field defaults
 * 4. object → `show = input.show ?? true`
 * 5. `showLine = input.showLine ?? show` (false when `!show`)
 * 6. `intervalMs` finite `> 0` else null
 * 7. `showCountdown = show && intervalMs != null && (input.showCountdown ?? true)`
 * 8. `outOfDomain` default `'clamp'`; `lineWidth` default `1`
 * 9. `nowMs` / `formatter` / colors pass through or null
 */
export function resolvePriceLabel(
  input: boolean | CandlestickPriceLabelConfig | undefined,
  ctx: ResolvePriceLabelContext
): ResolvedCandlestickPriceLabel {
  if (input === false) {
    return ALL_OFF;
  }

  if (input === undefined) {
    const show = ctx.candlePrimary;
    if (!show) return ALL_OFF;
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

  if (input === true) {
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

  // Object form
  const show = input.show ?? true;
  const intervalMs = resolveIntervalMs(input.intervalMs);
  const showLine = show ? (input.showLine ?? show) : false;

  if (show && input.showCountdown === true && intervalMs == null) {
    warnShowCountdownNeedsInterval();
  }

  const showCountdown = show && intervalMs != null && (input.showCountdown ?? true);

  const outOfDomain: 'clamp' | 'hide' = input.outOfDomain === 'hide' ? 'hide' : 'clamp';

  const nowMs = typeof input.nowMs === 'function' ? input.nowMs : null;
  const formatter = typeof input.formatter === 'function' ? input.formatter : null;

  return {
    show,
    showLine,
    intervalMs,
    showCountdown,
    nowMs,
    formatter,
    outOfDomain,
    color: resolveOptionalString(input.color),
    lineColor: resolveOptionalString(input.lineColor),
    lineWidth: resolveLineWidth(input.lineWidth),
  };
}
