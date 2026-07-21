import type { ResolvedCandlestickSeriesConfig, ResolvedOhlcSeriesConfig } from '../config/OptionResolver';
import type { OHLCDataPoint, OHLCDataPointTuple } from '../config/types';
import type { LinearScale } from '../utils/scales';

export interface CandlestickMatch {
  seriesIndex: number;
  dataIndex: number;
  point: OHLCDataPoint;
}

/**
 * Shared bar-width fields for candlestick and thin OHLC bar series
 * (finance family — same `barWidth` / min / max contract).
 */
export type FinanceBarWidthSeriesConfig = Pick<
  ResolvedCandlestickSeriesConfig | ResolvedOhlcSeriesConfig,
  'barWidth' | 'barMinWidth' | 'barMaxWidth'
>;

/** Finance series accepted by findCandlestick / body-width helpers. */
export type FinanceOhlcHitSeriesConfig =
  | ResolvedCandlestickSeriesConfig
  | ResolvedOhlcSeriesConfig
  | (FinanceBarWidthSeriesConfig & { readonly data: ReadonlyArray<OHLCDataPoint> });

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const parsePercent = (value: string): number | null => {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
  if (!m) return null;
  const p = Number(m[1]) / 100;
  return Number.isFinite(p) ? p : null;
};

const isTupleDataPoint = (p: OHLCDataPoint): p is OHLCDataPointTuple => Array.isArray(p);

const getTimestamp = (p: OHLCDataPoint): number => (isTupleDataPoint(p) ? p[0] : p.timestamp);
const getOpen = (p: OHLCDataPoint): number => (isTupleDataPoint(p) ? p[1] : p.open);
const getClose = (p: OHLCDataPoint): number => (isTupleDataPoint(p) ? p[2] : p.close);
const getLow = (p: OHLCDataPoint): number => (isTupleDataPoint(p) ? p[3] : p.low);
const getHigh = (p: OHLCDataPoint): number => (isTupleDataPoint(p) ? p[4] : p.high);

/** Y hit region: candle body (open/close) or full OHLC stem (low/high). */
export type OhlcYHitMode = 'openClose' | 'lowHigh';

const categoryStepCache = new WeakMap<ReadonlyArray<OHLCDataPoint>, number>();

const computeCategoryStep = (data: ReadonlyArray<OHLCDataPoint>): number => {
  const cached = categoryStepCache.get(data);
  if (cached !== undefined) return cached;

  const timestamps: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const t = getTimestamp(data[i]);
    if (Number.isFinite(t)) timestamps.push(t);
  }

  if (timestamps.length < 2) return 1;
  timestamps.sort((a, b) => a - b);

  let minStep = Number.POSITIVE_INFINITY;
  for (let i = 1; i < timestamps.length; i++) {
    const d = timestamps[i] - timestamps[i - 1];
    if (d > 0 && d < minStep) minStep = d;
  }
  const step = Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
  categoryStepCache.set(data, step);
  return step;
};

/**
 * Computes finance bar category width in xScale **range-space** units.
 *
 * Notes:
 * - Mirrors candlestick / OHLC renderer bar width semantics, but stays in range units
 *   (CSS pixels in ChartGPU interaction usage).
 * - No DPR conversions are applied here.
 * - Same helper for `type: 'candlestick'` and `type: 'ohlc'`.
 */
export function computeCandlestickBodyWidthRange(
  series: FinanceBarWidthSeriesConfig,
  data: ReadonlyArray<OHLCDataPoint>,
  xScale: LinearScale,
  plotWidthFallback?: number
): number {
  if (data.length === 0) return 0;

  const categoryStep = computeCategoryStep(data);

  // Prefer deriving category width from a domain step via xScale.scale(t0 + step) - xScale.scale(t0).
  let categoryWidthRange = 0;
  if (Number.isFinite(categoryStep) && categoryStep > 0) {
    let t0: number | null = null;
    for (let i = 0; i < data.length; i++) {
      const t = getTimestamp(data[i]);
      if (Number.isFinite(t)) {
        t0 = t;
        break;
      }
    }

    if (t0 != null) {
      const p0 = xScale.scale(t0);
      const p1 = xScale.scale(t0 + categoryStep);
      const w = Math.abs(p1 - p0);
      if (Number.isFinite(w) && w > 0) categoryWidthRange = w;
    }
  }

  // Fallback: approximate based on plot width and data length.
  if (!(categoryWidthRange > 0) || !Number.isFinite(categoryWidthRange)) {
    const plotW = Number.isFinite(plotWidthFallback ?? Number.NaN) ? (plotWidthFallback as number) : 0;
    categoryWidthRange = plotW / Math.max(1, data.length);
  }

  // barWidth semantics:
  // - number: width in range units
  // - percent string: percent of category width in range units
  let width = 0;
  const rawBarWidth = series.barWidth;
  if (typeof rawBarWidth === 'number') {
    width = Number.isFinite(rawBarWidth) ? Math.max(0, rawBarWidth) : 0;
  } else if (typeof rawBarWidth === 'string') {
    const p = parsePercent(rawBarWidth);
    width = p == null ? 0 : categoryWidthRange * clamp01(p);
  }

  // Clamp by min/max width (in CSS px; our range-space is CSS px in interaction usage).
  const minW = Number.isFinite(series.barMinWidth) ? Math.max(0, series.barMinWidth) : 0;
  const maxWCandidate = Number.isFinite(series.barMaxWidth)
    ? Math.max(0, series.barMaxWidth)
    : Number.POSITIVE_INFINITY;
  const maxW = Math.max(minW, maxWCandidate);
  width = Math.min(Math.max(width, minW), maxW);

  return Number.isFinite(width) ? width : 0;
}

const monotonicTimestampCache = new WeakMap<ReadonlyArray<OHLCDataPoint>, boolean>();

const isMonotonicNonDecreasingFiniteTimestamps = (data: ReadonlyArray<OHLCDataPoint>): boolean => {
  const cached = monotonicTimestampCache.get(data);
  if (cached !== undefined) return cached;

  let prev = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const t = getTimestamp(data[i]);
    if (!Number.isFinite(t)) {
      monotonicTimestampCache.set(data, false);
      return false;
    }
    if (t < prev) {
      monotonicTimestampCache.set(data, false);
      return false;
    }
    prev = t;
  }
  monotonicTimestampCache.set(data, true);
  return true;
};

const lowerBoundByTimestamp = (data: ReadonlyArray<OHLCDataPoint>, xTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const t = getTimestamp(data[mid]);
    if (t < xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * Finds a finance bar (candlestick or thin OHLC) under the given cursor position.
 *
 * Coordinate system contract:
 * - `x`/`y` MUST be in the same units as `xScale`/`yScale` **range-space**
 *   (ChartGPU interaction uses grid-local CSS pixels).
 *
 * Hit-test semantics (both modes require `abs(x - xCenter) <= barWidth / 2`):
 * - **`yHitMode: 'openClose'`** (default — candlestick / ChartGPU candle hitTest):
 *   body-only; Y between scaled open and close (wicks ignored).
 * - **`yHitMode: 'lowHigh'`** (OHLC bars — tooltip + ChartGPU.hitTest):
 *   stem range; Y between scaled low and high (open/close ticks still hit when inside stem).
 *
 * Call sites:
 * - Candlestick tooltips / candle hitTest → `'openClose'`
 * - OHLC tooltips (`findCandlestickAtPointer`) / OHLC hitTest → `'lowHigh'`
 *
 * Performance:
 * - Per-series lower-bound binary search on timestamp, then scans left/right while x-distance alone can still hit.
 * - If timestamps are not monotonic non-decreasing finite numbers, falls back to an O(n) scan for correctness.
 *
 * Edge cases:
 * - Skips non-finite timestamps / required Y fields for the active mode.
 * - If `barWidthClip` is non-finite or <= 0, returns null.
 * - Returns the closest in x (min abs dx) among hits; ties broken by smaller `dataIndex` (then smaller `seriesIndex`).
 */
export function findCandlestick(
  series: ReadonlyArray<FinanceOhlcHitSeriesConfig>,
  x: number,
  y: number,
  xScale: LinearScale,
  yScale: LinearScale,
  barWidthClip: number,
  options?: { readonly yHitMode?: OhlcYHitMode }
): CandlestickMatch | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(barWidthClip) || !(barWidthClip > 0)) return null;

  const xTarget = xScale.invert(x);
  if (!Number.isFinite(xTarget)) return null;

  const halfW = barWidthClip / 2;
  const yHitMode: OhlcYHitMode = options?.yHitMode === 'lowHigh' ? 'lowHigh' : 'openClose';

  let best: CandlestickMatch | null = null;
  let bestDx = Number.POSITIVE_INFINITY;

  const tryUpdate = (seriesIndex: number, dataIndex: number, point: OHLCDataPoint, dx: number): void => {
    if (!Number.isFinite(dx)) return;
    if (dx < bestDx) {
      bestDx = dx;
      best = { seriesIndex, dataIndex, point };
      return;
    }
    if (dx === bestDx && best) {
      if (dataIndex < best.dataIndex) {
        best = { seriesIndex, dataIndex, point };
      } else if (dataIndex === best.dataIndex && seriesIndex < best.seriesIndex) {
        best = { seriesIndex, dataIndex, point };
      }
    }
  };

  const isBodyHitAt = (p: OHLCDataPoint): boolean => {
    if (yHitMode === 'lowHigh') {
      const low = getLow(p);
      const high = getHigh(p);
      if (!Number.isFinite(low) || !Number.isFinite(high)) return false;
      const yLow = yScale.scale(low);
      const yHigh = yScale.scale(high);
      if (!Number.isFinite(yLow) || !Number.isFinite(yHigh)) return false;
      const yMin = Math.min(yLow, yHigh);
      const yMax = Math.max(yLow, yHigh);
      return y >= yMin && y <= yMax;
    }

    const open = getOpen(p);
    const close = getClose(p);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return false;

    const yOpen = yScale.scale(open);
    const yClose = yScale.scale(close);
    if (!Number.isFinite(yOpen) || !Number.isFinite(yClose)) return false;

    const yMin = Math.min(yOpen, yClose);
    const yMax = Math.max(yOpen, yClose);
    return y >= yMin && y <= yMax;
  };

  for (let s = 0; s < series.length; s++) {
    const cfg = series[s];
    const data = cfg.data;
    const n = data.length;
    if (n === 0) continue;

    const monotonic = isMonotonicNonDecreasingFiniteTimestamps(data);

    if (!monotonic) {
      // Fallback O(n) scan for correctness.
      for (let i = 0; i < n; i++) {
        const p = data[i];
        const t = getTimestamp(p);
        if (!Number.isFinite(t)) continue;
        const xCenter = xScale.scale(t);
        if (!Number.isFinite(xCenter)) continue;

        const dx = Math.abs(x - xCenter);
        if (dx > halfW) continue;
        if (!isBodyHitAt(p)) continue;

        tryUpdate(s, i, p, dx);
      }
      continue;
    }

    const insertionIndex = lowerBoundByTimestamp(data, xTarget);

    // Scan left while xCenter can still be within [x - halfW, x + halfW].
    for (let i = insertionIndex - 1; i >= 0; i--) {
      const p = data[i];
      const t = getTimestamp(p);
      const xCenter = xScale.scale(t);
      if (!Number.isFinite(xCenter)) continue;
      if (xCenter < x - halfW) break;

      const dx = Math.abs(x - xCenter);
      if (dx > halfW) continue;
      if (!isBodyHitAt(p)) continue;

      tryUpdate(s, i, p, dx);
    }

    // Scan right while xCenter can still be within [x - halfW, x + halfW].
    for (let i = insertionIndex; i < n; i++) {
      const p = data[i];
      const t = getTimestamp(p);
      const xCenter = xScale.scale(t);
      if (!Number.isFinite(xCenter)) continue;
      if (xCenter > x + halfW) break;

      const dx = Math.abs(x - xCenter);
      if (dx > halfW) continue;
      if (!isBodyHitAt(p)) continue;

      tryUpdate(s, i, p, dx);
    }
  }

  return best;
}
