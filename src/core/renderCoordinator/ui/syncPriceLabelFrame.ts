/**
 * Frame-level DOM sync for the exchange-style last-price badge.
 *
 * Pure extract so createRenderCoordinatorImpl stays thin: ownership scan,
 * last-candle derivation from owned raw OHLC, clip→container-local coords,
 * OOD clamp/hide. No price line (PR4b). Countdown timer (PR5) is owned by
 * the coordinator; this module returns frame state so the timer can update
 * its closed-over barEndMs without calling requestRender.
 *
 * Must be called **every frame after scales/layout**, outside the axis-label
 * DOM signature skip block.
 *
 * @module syncPriceLabelFrame
 */

import type { PriceLabel } from '../../../components/createPriceLabel';
import type { AxisConfig, OHLCDataPoint } from '../../../config/types';
import type { ResolvedCandlestickSeriesConfig, ResolvedSeriesConfig } from '../../../config/OptionResolver';
import type { ContinuousScale } from '../../../utils/scales';
import { clipXToCanvasCssPx, clipYToCanvasCssPx } from '../utils/axisUtils';
import {
  formatPriceLabelValue,
  formatCountdown,
  remainingMsToBarClose,
  resolveLastCandleState,
  selectPriceLabelSeries,
  type LastCandleState,
  type PriceLabelOwnershipSeries,
} from './priceLabelHelpers';
import {
  priceLabelCountdownDesiredFromConfig,
  type PriceLabelCountdownDesired,
} from './createPriceLabelCountdownTimer';

const DEFAULT_TICK_LENGTH_CSS_PX = 6;
/** Gap past the tick mark to the badge anchor (design: tickLength + 2). */
const BADGE_AXIS_GAP_CSS_PX = 2;
const OOD_CLAMP_OPACITY = 0.85;
const DEFAULT_BADGE_TEXT_COLOR = '#ffffff';

type PlotClipRectClipSpace = Readonly<{
  left: number;
  right: number;
  top: number;
  bottom: number;
}>;

type SyncPriceLabelFrameArgs = Readonly<{
  /** Single badge instance; null when no overlay container (SSR / offscreen). */
  readonly priceLabelUi: PriceLabel | null;
  /** Resolved series (priceLabel attached on candlestick non-reuse path). */
  readonly series: ReadonlyArray<ResolvedSeriesConfig>;
  /**
   * Coordinator-owned raw OHLC slots (`runtimeRawDataByIndex`).
   * Badge uses `raw[raw.length - 1]` only — never sampled `series.data`.
   */
  readonly runtimeRawDataByIndex: ReadonlyArray<unknown>;
  /** Clip-space Y scales keyed by axis id (`currentYScales`). */
  readonly yScales: ReadonlyMap<string, ContinuousScale>;
  readonly yAxes: ReadonlyArray<AxisConfig>;
  /** Plot rect in WebGPU clip space (same as `computePlotClipRect`). */
  readonly plotClipRect: PlotClipRectClipSpace;
  /**
   * Canvas CSS size used for clip→canvas conversion.
   * Prefer device-pixel-derived size (annotation path) for Y consistency with the plot.
   */
  readonly canvasCssWidth: number;
  readonly canvasCssHeight: number;
  /** Canvas offset within overlay container (container-local = canvas-local + offset). */
  readonly offsetX: number;
  readonly offsetY: number;
  /**
   * Multi-badge ownership warn (at most once per call from selectPriceLabelSeries).
   * Coordinator should gate to one warn per chart lifetime.
   */
  readonly onWarn?: (message: string) => void;
}>;

/**
 * Countdown timer inputs derived during the frame sync.
 * Coordinator applies these to `createPriceLabelCountdownTimer` (DOM-only).
 */
type SyncPriceLabelFrameResult = Readonly<{
  readonly countdownDesired: PriceLabelCountdownDesired;
  /** Last bar end ms when known; null when no last candle / inactive. */
  readonly barEndMs: number | null;
}>;

const COUNTDOWN_OFF: SyncPriceLabelFrameResult = Object.freeze({
  countdownDesired: Object.freeze({
    active: false,
    intervalMs: null,
    nowMs: null,
  }),
  barEndMs: null,
});

/** Frame-time countdown text when showCountdown; timer ticks via setCountdown between frames. */
function frameCountdownText(
  last: LastCandleState,
  showCountdown: boolean,
  nowMs: (() => number) | null
): string | null {
  if (!showCountdown || last.barEndMs == null) return null;
  const now = typeof nowMs === 'function' ? nowMs() : Date.now();
  return formatCountdown(remainingMsToBarClose(last.barEndMs, now));
}

const HIDDEN_STATE = {
  visible: false,
  x: 0,
  y: 0,
  priceText: '',
  countdownText: null,
  background: '#000000',
  color: DEFAULT_BADGE_TEXT_COLOR,
  side: 'right' as const,
};

function hideBadge(ui: PriceLabel): void {
  ui.update(HIDDEN_STATE);
}

/**
 * Resolve countdown desired from the owning priceLabel series (config only).
 * Used by setOptions when a full frame has not run yet.
 */
export function resolvePriceLabelCountdownDesired(
  series: ReadonlyArray<ResolvedSeriesConfig>,
  options?: {
    readonly onWarn?: (message: string) => void;
  }
): PriceLabelCountdownDesired {
  const seriesIndex = selectPriceLabelSeries(series as ReadonlyArray<PriceLabelOwnershipSeries>, {
    candlePrimary: false,
    onWarn: options?.onWarn,
  });
  if (seriesIndex == null) {
    return COUNTDOWN_OFF.countdownDesired;
  }
  const seriesItem = series[seriesIndex];
  if (!seriesItem || !(seriesItem.type === 'candlestick' || seriesItem.type === 'ohlc')) {
    return COUNTDOWN_OFF.countdownDesired;
  }
  const candle = seriesItem as ResolvedCandlestickSeriesConfig;
  const pl = candle.priceLabel;
  if (!pl) return COUNTDOWN_OFF.countdownDesired;
  return priceLabelCountdownDesiredFromConfig({
    show: pl.show,
    showCountdown: pl.showCountdown,
    intervalMs: pl.intervalMs,
    nowMs: pl.nowMs,
  });
}

function countdownDesiredFromCandle(candle: ResolvedCandlestickSeriesConfig): PriceLabelCountdownDesired {
  const pl = candle.priceLabel;
  if (!pl) return COUNTDOWN_OFF.countdownDesired;
  return priceLabelCountdownDesiredFromConfig({
    show: pl.show,
    showCountdown: pl.showCountdown,
    intervalMs: pl.intervalMs,
    nowMs: pl.nowMs,
  });
}

/**
 * Sync the last-price badge DOM for the current frame.
 *
 * Hide paths: no UI, no owning series, missing raw/scale, non-finite close Y,
 * empty canvas, or out-of-domain with `outOfDomain: 'hide'`.
 *
 * @returns Countdown timer inputs (desired config + barEndMs). Always defined.
 */
export function syncPriceLabelFrame(args: SyncPriceLabelFrameArgs): SyncPriceLabelFrameResult {
  const ui = args.priceLabelUi;
  if (!ui) return COUNTDOWN_OFF;

  const {
    series,
    runtimeRawDataByIndex,
    yScales,
    yAxes,
    plotClipRect,
    canvasCssWidth,
    canvasCssHeight,
    offsetX,
    offsetY,
    onWarn,
  } = args;

  // Ownership: first visible candlestick with priceLabel.show (v1 one badge).
  // Resolved series already have `priceLabel.show`; candlePrimary only matters for raw/unresolved.
  const seriesIndex = selectPriceLabelSeries(series as ReadonlyArray<PriceLabelOwnershipSeries>, {
    candlePrimary: false,
    onWarn,
  });

  if (seriesIndex == null) {
    hideBadge(ui);
    return COUNTDOWN_OFF;
  }

  const seriesItem = series[seriesIndex];
  if (!seriesItem || !(seriesItem.type === 'candlestick' || seriesItem.type === 'ohlc')) {
    hideBadge(ui);
    return COUNTDOWN_OFF;
  }

  const candle = seriesItem as ResolvedCandlestickSeriesConfig;
  const priceLabel = candle.priceLabel;
  // Config-driven countdown desired (even when badge is temporarily hidden).
  const countdownDesired = countdownDesiredFromCandle(candle);

  if (!priceLabel?.show) {
    hideBadge(ui);
    return COUNTDOWN_OFF;
  }

  if (!(canvasCssWidth > 0) || !(canvasCssHeight > 0)) {
    hideBadge(ui);
    return { countdownDesired, barEndMs: null };
  }

  const yAxisId = candle.yAxis;
  const yScale = yScales.get(yAxisId);
  if (!yScale) {
    hideBadge(ui);
    return { countdownDesired, barEndMs: null };
  }

  const yAxisConfig = yAxes.find((ax) => (ax.id ?? 'y') === yAxisId) ?? yAxes[0] ?? null;
  const side: 'left' | 'right' = yAxisConfig?.position === 'right' ? 'right' : 'left';
  const tickLength =
    typeof yAxisConfig?.tickLength === 'number' &&
    Number.isFinite(yAxisConfig.tickLength) &&
    yAxisConfig.tickLength >= 0
      ? yAxisConfig.tickLength
      : DEFAULT_TICK_LENGTH_CSS_PX;

  const raw = runtimeRawDataByIndex[seriesIndex] as ReadonlyArray<OHLCDataPoint> | null | undefined;
  const last = resolveLastCandleState({
    seriesIndex,
    yAxisId,
    raw,
    upColor: candle.itemStyle.upColor,
    downColor: candle.itemStyle.downColor,
    intervalMs: priceLabel.intervalMs,
  });

  if (!last) {
    hideBadge(ui);
    return { countdownDesired, barEndMs: null };
  }

  const yClip = yScale.scale(last.close);
  if (!Number.isFinite(yClip)) {
    hideBadge(ui);
    return { countdownDesired, barEndMs: last.barEndMs };
  }

  const yCanvas = clipYToCanvasCssPx(yClip, canvasCssHeight);
  const plotTop = clipYToCanvasCssPx(plotClipRect.top, canvasCssHeight);
  const plotBottom = clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeight);
  const plotLeft = clipXToCanvasCssPx(plotClipRect.left, canvasCssWidth);
  const plotRight = clipXToCanvasCssPx(plotClipRect.right, canvasCssWidth);

  const domain = yScale.getDomain();
  const lo = Math.min(domain.min, domain.max);
  const hi = Math.max(domain.min, domain.max);
  const inDomain = last.close >= lo && last.close <= hi;

  if (!inDomain && priceLabel.outOfDomain === 'hide') {
    hideBadge(ui);
    // Timer still tracks bar end; badge hidden but countdown desired follows config.
    return { countdownDesired, barEndMs: last.barEndMs };
  }

  let yBadge = yCanvas;
  let opacity = 1;
  if (!inDomain) {
    // Clamp to plot edge + dim (K8 default).
    const edgeLo = Math.min(plotTop, plotBottom);
    const edgeHi = Math.max(plotTop, plotBottom);
    yBadge = Math.min(edgeHi, Math.max(edgeLo, yCanvas));
    opacity = OOD_CLAMP_OPACITY;
  }

  // side 'right' → badge left edge just outside plot right
  // side 'left'  → badge right edge just outside plot left
  const x =
    side === 'right'
      ? offsetX + plotRight + tickLength + BADGE_AXIS_GAP_CSS_PX
      : offsetX + plotLeft - tickLength - BADGE_AXIS_GAP_CSS_PX;
  const y = offsetY + yBadge;

  const priceText =
    typeof priceLabel.formatter === 'function' ? priceLabel.formatter(last.close) : formatPriceLabelValue(last.close);

  // Frame-synced countdown when enabled (keeps text fresh on data/zoom frames).
  // Between frames, createPriceLabelCountdownTimer ticks via setCountdown only.
  const countdownText = frameCountdownText(last, priceLabel.showCountdown, priceLabel.nowMs);

  ui.update({
    visible: true,
    x,
    y,
    priceText,
    countdownText,
    background: last.directionColor,
    color: priceLabel.color ?? DEFAULT_BADGE_TEXT_COLOR,
    side,
    opacity,
  });

  return { countdownDesired, barEndMs: last.barEndMs };
}
