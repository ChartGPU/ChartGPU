import type {
  ResolvedAreaSeriesConfig,
  ResolvedBarSeriesConfig,
  ResolvedChartGPUOptions,
  ResolvedPieSeriesConfig,
} from '../config/OptionResolver';
import type { AnimationConfig, DataPoint, DataPointTuple, OHLCDataPoint, OHLCDataPointTuple, PieCenter, PieRadius } from '../config/types';
import { createDataStore } from '../data/createDataStore';
import { sampleSeriesDataPoints } from '../data/sampleSeries';
import { ohlcSample } from '../data/ohlcSample';
import { createAxisRenderer } from '../renderers/createAxisRenderer';
import { createGridRenderer } from '../renderers/createGridRenderer';
import type { GridArea } from '../renderers/createGridRenderer';
import { createAreaRenderer } from '../renderers/createAreaRenderer';
import { createLineRenderer } from '../renderers/createLineRenderer';
import { createBarRenderer } from '../renderers/createBarRenderer';
import { createScatterRenderer } from '../renderers/createScatterRenderer';
import { createPieRenderer } from '../renderers/createPieRenderer';
import { createCrosshairRenderer } from '../renderers/createCrosshairRenderer';
import type { CrosshairRenderOptions } from '../renderers/createCrosshairRenderer';
import { createHighlightRenderer } from '../renderers/createHighlightRenderer';
import type { HighlightPoint } from '../renderers/createHighlightRenderer';
import { createEventManager } from '../interaction/createEventManager';
import type { ChartGPUEventPayload } from '../interaction/createEventManager';
import { createInsideZoom } from '../interaction/createInsideZoom';
import { createZoomState } from '../interaction/createZoomState';
import type { ZoomRange, ZoomState } from '../interaction/createZoomState';
import { findNearestPoint } from '../interaction/findNearestPoint';
import { findPointsAtX } from '../interaction/findPointsAtX';
import { findPieSlice } from '../interaction/findPieSlice';
import { createLinearScale } from '../utils/scales';
import type { LinearScale } from '../utils/scales';
import { parseCssColorToGPUColor, parseCssColorToRgba01 } from '../utils/colors';
import { createTextOverlay } from '../components/createTextOverlay';
import type { TextOverlay, TextOverlayAnchor } from '../components/createTextOverlay';
import { createLegend } from '../components/createLegend';
import type { Legend } from '../components/createLegend';
import { createTooltip } from '../components/createTooltip';
import type { Tooltip } from '../components/createTooltip';
import type { TooltipParams } from '../config/types';
import { formatTooltipAxis, formatTooltipItem } from '../components/formatTooltip';
import { createAnimationController } from './createAnimationController';
import type { AnimationId } from './createAnimationController';
import { getEasing } from '../utils/easing';
import type { EasingFunction } from '../utils/easing';

export interface GPUContextLike {
  readonly device: GPUDevice | null;
  readonly canvas: HTMLCanvasElement | null;
  readonly canvasContext: GPUCanvasContext | null;
  readonly preferredFormat: GPUTextureFormat | null;
  readonly initialized: boolean;
}

export interface RenderCoordinator {
  setOptions(resolvedOptions: ResolvedChartGPUOptions): void;
  /**
   * Appends new points to a cartesian series’ runtime data without requiring a full `setOptions(...)`
   * resolver pass.
   *
   * Appends are coalesced and flushed once per render frame.
   */
  appendData(seriesIndex: number, newPoints: ReadonlyArray<DataPoint>): void;
  /**
   * Gets the current “interaction x” in domain units (or `null` when inactive).
   *
   * This is derived from pointer movement inside the plot grid and can also be driven
   * externally via `setInteractionX(...)` (e.g. chart sync).
   */
  getInteractionX(): number | null;
  /**
   * Drives the chart’s crosshair + tooltip from a domain-space x value.
   *
   * Passing `null` clears the interaction (hides crosshair/tooltip).
   */
  setInteractionX(x: number | null, source?: unknown): void;
  /**
   * Subscribes to interaction x changes (domain units).
   *
   * Returns an unsubscribe function.
   */
  onInteractionXChange(callback: (x: number | null, source?: unknown) => void): () => void;
  /**
   * Returns the current percent-space zoom window (or `null` when zoom is disabled).
   */
  getZoomRange(): Readonly<{ start: number; end: number }> | null;
  /**
   * Sets the percent-space zoom window.
   *
   * No-op when zoom is disabled.
   */
  setZoomRange(start: number, end: number): void;
  /**
   * Subscribes to zoom window changes (percent space).
   *
   * Returns an unsubscribe function.
   */
  onZoomRangeChange(cb: (range: Readonly<{ start: number; end: number }>) => void): () => void;
  render(): void;
  dispose(): void;
}

export type RenderCoordinatorCallbacks = Readonly<{
  /**
   * Optional hook for render-on-demand systems (like `ChartGPU`) to re-render when
   * interaction state changes (e.g. crosshair on pointer move).
   */
  readonly onRequestRender?: () => void;
}>;

type Bounds = Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_TICK_COUNT: number = 5;
const DEFAULT_TICK_LENGTH_CSS_PX: number = 6;
const LABEL_PADDING_CSS_PX = 4;
const DEFAULT_CROSSHAIR_LINE_WIDTH_CSS_PX = 1;
const DEFAULT_HIGHLIGHT_SIZE_CSS_PX = 4;

// Story 5.17: CPU-side update interpolation can be expensive for very large series.
// We still animate domains for large series, but skip per-point y interpolation past this cap.
const MAX_ANIMATED_POINTS_PER_SERIES = 20_000;

const assertUnreachable = (value: never): never => {
  // Intentionally minimal message: this is used for compile-time exhaustiveness.
  throw new Error(`RenderCoordinator: unreachable value: ${String(value)}`);
};

const isTupleDataPoint = (p: DataPoint): p is DataPointTuple => Array.isArray(p);

const getPointXY = (p: DataPoint): { readonly x: number; readonly y: number } => {
  if (isTupleDataPoint(p)) return { x: p[0], y: p[1] };
  return { x: p.x, y: p.y };
};

const computeRawBoundsFromData = (data: ReadonlyArray<DataPoint>): Bounds | null => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < data.length; i++) {
    const { x, y } = getPointXY(data[i]!);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return null;
  }

  // Keep bounds usable for downstream scale derivation.
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
};

const extendBoundsWithDataPoints = (bounds: Bounds | null, points: ReadonlyArray<DataPoint>): Bounds | null => {
  if (points.length === 0) return bounds;

  let b = bounds;
  if (!b) {
    // Try to seed from the appended points.
    const seeded = computeRawBoundsFromData(points);
    if (!seeded) return bounds;
    b = seeded;
  }

  let xMin = b.xMin;
  let xMax = b.xMax;
  let yMin = b.yMin;
  let yMax = b.yMax;

  for (let i = 0; i < points.length; i++) {
    const { x, y } = getPointXY(points[i]!);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  // Keep bounds usable for downstream scale derivation.
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
};

const computeGlobalBounds = (
  series: ResolvedChartGPUOptions['series'],
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null
): Bounds => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    // Pie series are non-cartesian; they don't participate in x/y bounds.
    if (seriesConfig.type === 'pie') continue;

    const runtimeBoundsCandidate = runtimeRawBoundsByIndex?.[s] ?? null;
    if (runtimeBoundsCandidate) {
      const b = runtimeBoundsCandidate;
      if (
        Number.isFinite(b.xMin) &&
        Number.isFinite(b.xMax) &&
        Number.isFinite(b.yMin) &&
        Number.isFinite(b.yMax)
      ) {
        if (b.xMin < xMin) xMin = b.xMin;
        if (b.xMax > xMax) xMax = b.xMax;
        if (b.yMin < yMin) yMin = b.yMin;
        if (b.yMax > yMax) yMax = b.yMax;
        continue;
      }
    }

    // Prefer precomputed bounds from the original (unsampled) data when available.
    // This ensures sampling cannot affect axis auto-bounds and avoids per-render O(n) scans.
    const rawBoundsCandidate = seriesConfig.rawBounds;
    if (rawBoundsCandidate) {
      const b = rawBoundsCandidate;
      if (
        Number.isFinite(b.xMin) &&
        Number.isFinite(b.xMax) &&
        Number.isFinite(b.yMin) &&
        Number.isFinite(b.yMax)
      ) {
        if (b.xMin < xMin) xMin = b.xMin;
        if (b.xMax > xMax) xMax = b.xMax;
        if (b.yMin < yMin) yMin = b.yMin;
        if (b.yMax > yMax) yMax = b.yMax;
        continue;
      }
    }

    // Candlestick series: bounds should be precomputed in OptionResolver from timestamp/low/high.
    // If we reach here, `rawBounds` was undefined; fall back to a raw OHLC scan so axes don't break.
    if (seriesConfig.type === 'candlestick') {
      const rawOHLC = (seriesConfig.rawData ?? seriesConfig.data) as ReadonlyArray<OHLCDataPoint>;
      for (let i = 0; i < rawOHLC.length; i++) {
        const p = rawOHLC[i]!;
        if (isTupleOHLCDataPoint(p)) {
          const timestamp = p[0];
          const low = p[3];
          const high = p[4];
          if (!Number.isFinite(timestamp) || !Number.isFinite(low) || !Number.isFinite(high)) continue;

          const yLow = Math.min(low, high);
          const yHigh = Math.max(low, high);

          if (timestamp < xMin) xMin = timestamp;
          if (timestamp > xMax) xMax = timestamp;
          if (yLow < yMin) yMin = yLow;
          if (yHigh > yMax) yMax = yHigh;
        } else {
          const timestamp = p.timestamp;
          const low = p.low;
          const high = p.high;
          if (!Number.isFinite(timestamp) || !Number.isFinite(low) || !Number.isFinite(high)) continue;

          const yLow = Math.min(low, high);
          const yHigh = Math.max(low, high);

          if (timestamp < xMin) xMin = timestamp;
          if (timestamp > xMax) xMax = timestamp;
          if (yLow < yMin) yMin = yLow;
          if (yHigh > yMax) yMax = yHigh;
        }
      }
      continue;
    }

    const data = seriesConfig.data;
    for (let i = 0; i < data.length; i++) {
      const { x, y } = getPointXY(data[i]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
  }

  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
}; 

const normalizeDomain = (
  minCandidate: number,
  maxCandidate: number
): { readonly min: number; readonly max: number } => {
  let min = minCandidate;
  let max = maxCandidate;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }

  if (min === max) {
    max = min + 1;
  } else if (min > max) {
    const t = min;
    min = max;
    max = t;
  }

  return { min, max };
};

const computeGridArea = (gpuContext: GPUContextLike, options: ResolvedChartGPUOptions): GridArea => {
  const canvas = gpuContext.canvas;
  if (!canvas) throw new Error('RenderCoordinator: gpuContext.canvas is required.');

  return {
    left: options.grid.left,
    right: options.grid.right,
    top: options.grid.top,
    bottom: options.grid.bottom,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  };
};

const rgba01ToCssRgba = (rgba: readonly [number, number, number, number]): string => {
  const r = Math.max(0, Math.min(255, Math.round(rgba[0] * 255)));
  const g = Math.max(0, Math.min(255, Math.round(rgba[1] * 255)));
  const b = Math.max(0, Math.min(255, Math.round(rgba[2] * 255)));
  const a = Math.max(0, Math.min(1, rgba[3]));
  return `rgba(${r},${g},${b},${a})`;
};

const withAlpha = (cssColor: string, alphaMultiplier: number): string => {
  const parsed = parseCssColorToRgba01(cssColor);
  if (!parsed) return cssColor;
  const a = Math.max(0, Math.min(1, parsed[3] * alphaMultiplier));
  return rgba01ToCssRgba([parsed[0], parsed[1], parsed[2], a]);
};

const computePlotClipRect = (
  gridArea: GridArea
): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } => {
  const { left, right, top, bottom, canvasWidth, canvasHeight } = gridArea;
  const dpr = window.devicePixelRatio || 1;

  const plotLeft = left * dpr;
  const plotRight = canvasWidth - right * dpr;
  const plotTop = top * dpr;
  const plotBottom = canvasHeight - bottom * dpr;

  const plotLeftClip = (plotLeft / canvasWidth) * 2.0 - 1.0;
  const plotRightClip = (plotRight / canvasWidth) * 2.0 - 1.0;
  const plotTopClip = 1.0 - (plotTop / canvasHeight) * 2.0; // flip Y
  const plotBottomClip = 1.0 - (plotBottom / canvasHeight) * 2.0; // flip Y

  return {
    left: plotLeftClip,
    right: plotRightClip,
    top: plotTopClip,
    bottom: plotBottomClip,
  };
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

const lerp = (a: number, b: number, t01: number): number => a + (b - a) * clamp01(t01);

const lerpDomain = (
  from: { readonly min: number; readonly max: number },
  to: { readonly min: number; readonly max: number },
  t01: number
): { readonly min: number; readonly max: number } => {
  return normalizeDomain(lerp(from.min, to.min, t01), lerp(from.max, to.max, t01));
};

const computePlotScissorDevicePx = (
  gridArea: GridArea
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } => {
  const dpr = window.devicePixelRatio || 1;
  const { canvasWidth, canvasHeight } = gridArea;

  const plotLeftDevice = gridArea.left * dpr;
  const plotRightDevice = canvasWidth - gridArea.right * dpr;
  const plotTopDevice = gridArea.top * dpr;
  const plotBottomDevice = canvasHeight - gridArea.bottom * dpr;

  const scissorX = clampInt(Math.floor(plotLeftDevice), 0, Math.max(0, canvasWidth));
  const scissorY = clampInt(Math.floor(plotTopDevice), 0, Math.max(0, canvasHeight));
  const scissorR = clampInt(Math.ceil(plotRightDevice), 0, Math.max(0, canvasWidth));
  const scissorB = clampInt(Math.ceil(plotBottomDevice), 0, Math.max(0, canvasHeight));
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
};

const clipXToCanvasCssPx = (xClip: number, canvasCssWidth: number): number => ((xClip + 1) / 2) * canvasCssWidth;
const clipYToCanvasCssPx = (yClip: number, canvasCssHeight: number): number => ((1 - yClip) / 2) * canvasCssHeight;

type TuplePoint = DataPointTuple;
type ObjectPoint = Readonly<{ x: number; y: number; size?: number }>;

const isTuplePoint = (p: DataPoint): p is TuplePoint => Array.isArray(p);
const isTupleDataArray = (data: ReadonlyArray<DataPoint>): data is ReadonlyArray<TuplePoint> =>
  data.length > 0 && isTuplePoint(data[0]!);

// Cache monotonicity checks to avoid O(n) scans on every zoom operation.
const monotonicXCache = new WeakMap<ReadonlyArray<DataPoint>, boolean>();

const isMonotonicNonDecreasingFiniteX = (data: ReadonlyArray<DataPoint>, isTuple: boolean): boolean => {
  const cached = monotonicXCache.get(data);
  if (cached !== undefined) return cached;

  let prevX = Number.NEGATIVE_INFINITY;

  if (isTuple) {
    const tupleData = data as ReadonlyArray<TuplePoint>;
    for (let i = 0; i < tupleData.length; i++) {
      const x = tupleData[i][0];
      if (!Number.isFinite(x)) {
        monotonicXCache.set(data, false);
        return false;
      }
      if (x < prevX) {
        monotonicXCache.set(data, false);
        return false;
      }
      prevX = x;
    }
    monotonicXCache.set(data, true);
    return true;
  }

  const objectData = data as ReadonlyArray<ObjectPoint>;
  for (let i = 0; i < objectData.length; i++) {
    const x = objectData[i].x;
    if (!Number.isFinite(x)) {
      monotonicXCache.set(data, false);
      return false;
    }
    if (x < prevX) {
      monotonicXCache.set(data, false);
      return false;
    }
    prevX = x;
  }
  monotonicXCache.set(data, true);
  return true;
};

const lowerBoundXTuple = (data: ReadonlyArray<TuplePoint>, xTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = data[mid][0];
    if (x < xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const upperBoundXTuple = (data: ReadonlyArray<TuplePoint>, xTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = data[mid][0];
    if (x <= xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const lowerBoundXObject = (data: ReadonlyArray<ObjectPoint>, xTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = data[mid].x;
    if (x < xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const upperBoundXObject = (data: ReadonlyArray<ObjectPoint>, xTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = data[mid].x;
    if (x <= xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const sliceVisibleRangeByX = (data: ReadonlyArray<DataPoint>, xMin: number, xMax: number): ReadonlyArray<DataPoint> => {
  const n = data.length;
  if (n === 0) return data;
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return data;

  const isTuple = isTupleDataArray(data);
  const canBinarySearch = isMonotonicNonDecreasingFiniteX(data, isTuple);

  if (canBinarySearch) {
    const lo = isTuple
      ? lowerBoundXTuple(data as ReadonlyArray<TuplePoint>, xMin)
      : lowerBoundXObject(data as ReadonlyArray<ObjectPoint>, xMin);
    const hi = isTuple
      ? upperBoundXTuple(data as ReadonlyArray<TuplePoint>, xMax)
      : upperBoundXObject(data as ReadonlyArray<ObjectPoint>, xMax);

    if (lo <= 0 && hi >= n) return data;
    if (hi <= lo) return [];
    return data.slice(lo, hi);
  }

  // Safe fallback: linear filter (preserves order, ignores non-finite x).
  const out: DataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = data[i]!;
    const { x } = getPointXY(p);
    if (!Number.isFinite(x)) continue;
    if (x >= xMin && x <= xMax) out.push(p);
  }
  return out;
};

function isTupleOHLCDataPoint(p: OHLCDataPoint): p is OHLCDataPointTuple {
  return Array.isArray(p);
}

// Cache monotonicity checks to avoid O(n) scans on every zoom operation.
const monotonicTimestampCache = new WeakMap<ReadonlyArray<OHLCDataPoint>, boolean>();

const isMonotonicNonDecreasingFiniteTimestamp = (data: ReadonlyArray<OHLCDataPoint>): boolean => {
  const cached = monotonicTimestampCache.get(data);
  if (cached !== undefined) return cached;

  let prevTimestamp = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < data.length; i++) {
    const p = data[i]!;
    const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
    if (!Number.isFinite(timestamp)) {
      monotonicTimestampCache.set(data, false);
      return false;
    }
    if (timestamp < prevTimestamp) {
      monotonicTimestampCache.set(data, false);
      return false;
    }
    prevTimestamp = timestamp;
  }
  monotonicTimestampCache.set(data, true);
  return true;
};

const lowerBoundTimestampTuple = (data: ReadonlyArray<OHLCDataPointTuple>, timestampTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid][0];
    if (timestamp < timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const upperBoundTimestampTuple = (data: ReadonlyArray<OHLCDataPointTuple>, timestampTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid][0];
    if (timestamp <= timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

type OHLCObjectPoint = Readonly<{ timestamp: number; open: number; close: number; low: number; high: number }>;

const lowerBoundTimestampObject = (data: ReadonlyArray<OHLCObjectPoint>, timestampTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid].timestamp;
    if (timestamp < timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const upperBoundTimestampObject = (data: ReadonlyArray<OHLCObjectPoint>, timestampTarget: number): number => {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid].timestamp;
    if (timestamp <= timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * Slices OHLC/candlestick data to the visible timestamp range [xMin, xMax].
 *
 * Uses binary search when timestamps are sorted ascending; otherwise falls back to linear scan.
 */
const sliceVisibleRangeByOHLC = (
  data: ReadonlyArray<OHLCDataPoint>,
  xMin: number,
  xMax: number
): ReadonlyArray<OHLCDataPoint> => {
  const n = data.length;
  if (n === 0) return data;
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return data;

  const canBinarySearch = isMonotonicNonDecreasingFiniteTimestamp(data);
  const isTuple = n > 0 && isTupleOHLCDataPoint(data[0]!);

  if (canBinarySearch) {
    const lo = isTuple
      ? lowerBoundTimestampTuple(data as ReadonlyArray<OHLCDataPointTuple>, xMin)
      : lowerBoundTimestampObject(data as ReadonlyArray<OHLCObjectPoint>, xMin);
    const hi = isTuple
      ? upperBoundTimestampTuple(data as ReadonlyArray<OHLCDataPointTuple>, xMax)
      : upperBoundTimestampObject(data as ReadonlyArray<OHLCObjectPoint>, xMax);

    if (lo <= 0 && hi >= n) return data;
    if (hi <= lo) return [];
    return data.slice(lo, hi);
  }

  // Safe fallback: linear filter (preserves order, ignores non-finite timestamp).
  const out: OHLCDataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = data[i]!;
    const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp >= xMin && timestamp <= xMax) out.push(p);
  }
  return out;
};

const parseNumberOrPercent = (value: number | string, basis: number): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const s = value.trim();
  if (s.length === 0) return null;

  if (s.endsWith('%')) {
    const pct = Number.parseFloat(s.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return (pct / 100) * basis;
  }

  // Be permissive: allow numeric strings like "120".
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const resolvePieCenterPlotCss = (
  center: PieCenter | undefined,
  plotWidthCss: number,
  plotHeightCss: number
): { readonly x: number; readonly y: number } => {
  const xRaw = center?.[0] ?? '50%';
  const yRaw = center?.[1] ?? '50%';

  const x = parseNumberOrPercent(xRaw, plotWidthCss);
  const y = parseNumberOrPercent(yRaw, plotHeightCss);

  return {
    x: Number.isFinite(x) ? x! : plotWidthCss * 0.5,
    y: Number.isFinite(y) ? y! : plotHeightCss * 0.5,
  };
};

const isPieRadiusTuple = (
  radius: PieRadius
): radius is readonly [inner: number | string, outer: number | string] => Array.isArray(radius);

const resolvePieRadiiCss = (
  radius: PieRadius | undefined,
  maxRadiusCss: number
): { readonly inner: number; readonly outer: number } => {
  // Default similar to common chart libs (mirrors `createPieRenderer.ts`).
  if (radius == null) return { inner: 0, outer: maxRadiusCss * 0.7 };

  if (isPieRadiusTuple(radius)) {
    const inner = parseNumberOrPercent(radius[0], maxRadiusCss);
    const outer = parseNumberOrPercent(radius[1], maxRadiusCss);
    const innerCss = Math.max(0, Number.isFinite(inner) ? inner! : 0);
    const outerCss = Math.max(innerCss, Number.isFinite(outer) ? outer! : maxRadiusCss * 0.7);
    return { inner: innerCss, outer: Math.min(maxRadiusCss, outerCss) };
  }

  const outer = parseNumberOrPercent(radius, maxRadiusCss);
  const outerCss = Math.max(0, Number.isFinite(outer) ? outer! : maxRadiusCss * 0.7);
  return { inner: 0, outer: Math.min(maxRadiusCss, outerCss) };
};

const DEFAULT_MAX_TICK_FRACTION_DIGITS = 6;

const computeMaxFractionDigitsFromStep = (tickStep: number, cap: number = DEFAULT_MAX_TICK_FRACTION_DIGITS): number => {
  const stepAbs = Math.abs(tickStep);
  if (!Number.isFinite(stepAbs) || stepAbs === 0) return 0;

  // Prefer “clean” decimal representations (e.g. 2.5, 0.25, 0.125) without relying on magnitude alone.
  // We accept floating-point noise and cap the search to keep formatting reasonable.
  for (let d = 0; d <= cap; d++) {
    const scaled = stepAbs * 10 ** d;
    const rounded = Math.round(scaled);
    const err = Math.abs(scaled - rounded);
    const tol = 1e-9 * Math.max(1, Math.abs(scaled));
    if (err <= tol) return d;
  }

  // Fallback for repeating decimals (e.g. 1/3): show a small number of digits based on magnitude.
  // The +1 nudges values like 0.333.. towards 2 decimals rather than 1.
  return Math.max(0, Math.min(cap, Math.ceil(-Math.log10(stepAbs)) + 1));
};

const createTickFormatter = (tickStep: number): Intl.NumberFormat => {
  const maximumFractionDigits = computeMaxFractionDigitsFromStep(tickStep);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits });
};

const formatTickValue = (nf: Intl.NumberFormat, v: number): string | null => {
  if (!Number.isFinite(v)) return null;
  // Avoid displaying "-0" from floating-point artifacts.
  const normalized = Math.abs(v) < 1e-12 ? 0 : v;
  const formatted = nf.format(normalized);
  // Guard against unexpected output like "NaN" even after the finite check (defensive).
  return formatted === 'NaN' ? null : formatted;
};

const computeBaseXDomain = (
  options: ResolvedChartGPUOptions,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null
): { readonly min: number; readonly max: number } => {
  const bounds = computeGlobalBounds(options.series, runtimeRawBoundsByIndex);
  const baseMin = options.xAxis.min ?? bounds.xMin;
  const baseMax = options.xAxis.max ?? bounds.xMax;
  return normalizeDomain(baseMin, baseMax);
};

const computeBaseYDomain = (
  options: ResolvedChartGPUOptions,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null
): { readonly min: number; readonly max: number } => {
  const bounds = computeGlobalBounds(options.series, runtimeRawBoundsByIndex);
  const yMin = options.yAxis.min ?? bounds.yMin;
  const yMax = options.yAxis.max ?? bounds.yMax;
  return normalizeDomain(yMin, yMax);
};

const computeVisibleXDomain = (
  baseXDomain: { readonly min: number; readonly max: number },
  zoomRange?: ZoomRange | null
): { readonly min: number; readonly max: number; readonly spanFraction: number } => {
  if (!zoomRange) return { ...baseXDomain, spanFraction: 1 };
  const span = baseXDomain.max - baseXDomain.min;
  if (!Number.isFinite(span) || span === 0) return { ...baseXDomain, spanFraction: 1 };

  const start = zoomRange.start;
  const end = zoomRange.end;
  const xMin = baseXDomain.min + (start / 100) * span;
  const xMax = baseXDomain.min + (end / 100) * span;
  const normalized = normalizeDomain(xMin, xMax);

  const fractionRaw = (end - start) / 100;
  const spanFraction = Number.isFinite(fractionRaw) ? Math.max(0, Math.min(1, fractionRaw)) : 1;
  return { min: normalized.min, max: normalized.max, spanFraction };
};

type IntroPhase = 'pending' | 'running' | 'done';

const resolveAnimationConfig = (
  animation: ResolvedChartGPUOptions['animation']
):
  | {
      readonly durationMs: number;
      readonly delayMs: number;
      readonly easing: EasingFunction;
    }
  | null => {
  if (animation === false || animation == null) return null;

  const cfg: AnimationConfig | null = animation === true ? {} : animation;
  if (!cfg) return null;

  const durationMsRaw = cfg.duration ?? 300;
  const delayMsRaw = cfg.delay ?? 0;

  const durationMs = Number.isFinite(durationMsRaw) ? Math.max(0, durationMsRaw) : 300;
  const delayMs = Number.isFinite(delayMsRaw) ? Math.max(0, delayMsRaw) : 0;

  return {
    durationMs,
    delayMs,
    easing: getEasing(cfg.easing),
  };
};

const resolveIntroAnimationConfig = (animation: ResolvedChartGPUOptions['animation']) => resolveAnimationConfig(animation);
const resolveUpdateAnimationConfig = (animation: ResolvedChartGPUOptions['animation']) => resolveAnimationConfig(animation);

const computeBaselineForBarsFromData = (seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>): number => {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < seriesConfigs.length; s++) {
    const data = seriesConfigs[s]!.data;
    for (let i = 0; i < data.length; i++) {
      const { y } = getPointXY(data[i]!);
      if (!Number.isFinite(y)) continue;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return 0;
  if (yMin <= 0 && 0 <= yMax) return 0;
  return Math.abs(yMin) < Math.abs(yMax) ? yMin : yMax;
};

const computeBaselineForBarsFromAxis = (
  seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
  yScale: LinearScale,
  plotClipRect: Readonly<{ top: number; bottom: number }>
): number => {
  const yDomainA = yScale.invert(plotClipRect.bottom);
  const yDomainB = yScale.invert(plotClipRect.top);
  const yMin = Math.min(yDomainA, yDomainB);
  const yMax = Math.max(yDomainA, yDomainB);

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return computeBaselineForBarsFromData(seriesConfigs);
  }

  if (yMin <= 0 && 0 <= yMax) return 0;
  if (yMin > 0) return yMin;
  if (yMax < 0) return yMax;
  return computeBaselineForBarsFromData(seriesConfigs);
};

const createAnimatedBarYScale = (
  baseYScale: LinearScale,
  plotClipRect: Readonly<{ top: number; bottom: number }>,
  barSeriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
  progress01: number
): LinearScale => {
  const p = clamp01(progress01);
  if (p >= 1) return baseYScale;

  const baselineDomain = computeBaselineForBarsFromAxis(barSeriesConfigs, baseYScale, plotClipRect);
  const baselineClip = baseYScale.scale(baselineDomain);

  const wrapper: LinearScale = {
    domain(min: number, max: number) {
      baseYScale.domain(min, max);
      return wrapper;
    },
    range(min: number, max: number) {
      baseYScale.range(min, max);
      return wrapper;
    },
    scale(value: number) {
      const v = baseYScale.scale(value);
      if (!Number.isFinite(v) || !Number.isFinite(baselineClip)) return v;
      return baselineClip + (v - baselineClip) * p;
    },
    invert(pixel: number) {
      return baseYScale.invert(pixel);
    },
  };

  return wrapper;
};

export function createRenderCoordinator(
  gpuContext: GPUContextLike,
  options: ResolvedChartGPUOptions,
  callbacks?: RenderCoordinatorCallbacks
): RenderCoordinator {
  if (!gpuContext.initialized) {
    throw new Error('RenderCoordinator: gpuContext must be initialized.');
  }
  const device = gpuContext.device;
  if (!device) {
    throw new Error('RenderCoordinator: gpuContext.device is required.');
  }
  if (!gpuContext.canvas) {
    throw new Error('RenderCoordinator: gpuContext.canvas is required.');
  }
  if (!gpuContext.canvasContext) {
    throw new Error('RenderCoordinator: gpuContext.canvasContext is required.');
  }

  const targetFormat = gpuContext.preferredFormat ?? DEFAULT_TARGET_FORMAT;
  const overlayContainer = gpuContext.canvas.parentElement;
  const overlay: TextOverlay | null = overlayContainer ? createTextOverlay(overlayContainer) : null;
  const legend: Legend | null = overlayContainer ? createLegend(overlayContainer, 'right') : null;

  let disposed = false;
  let currentOptions: ResolvedChartGPUOptions = options;
  let lastSeriesCount = options.series.length;

  // Story 5.16: initial-load intro animation (series marks only).
  let introPhase: IntroPhase = 'pending';
  let introProgress01 = 0;
  const introAnimController = createAnimationController();
  let introAnimId: AnimationId | null = null;

  // Story 5.17 (step 1): data update transition state (snapshots only; interpolation occurs later).
  type UpdateTransitionSnapshot = Readonly<{
    readonly xBaseDomain: { readonly min: number; readonly max: number };
    readonly xVisibleDomain: { readonly min: number; readonly max: number };
    readonly yBaseDomain: { readonly min: number; readonly max: number };
    readonly series: ResolvedChartGPUOptions['series'];
  }>;

  type UpdateTransition = Readonly<{
    readonly from: UpdateTransitionSnapshot;
    readonly to: UpdateTransitionSnapshot;
  }>;

  let hasRenderedOnce = false;
  const updateAnimController = createAnimationController();
  let updateAnimId: AnimationId | null = null;
  let updateProgress01 = 1;
  let updateTransition: UpdateTransition | null = null;

  type UpdateInterpolationCaches = Readonly<{
    readonly cartesianDataBySeriesIndex: Array<DataPoint[] | null>;
    readonly pieDataBySeriesIndex: Array<ResolvedPieSeriesConfig['data'] | null>;
  }>;

  const updateInterpolationCaches: UpdateInterpolationCaches = {
    cartesianDataBySeriesIndex: [],
    pieDataBySeriesIndex: [],
  };

  const resetUpdateInterpolationCaches = (): void => {
    updateInterpolationCaches.cartesianDataBySeriesIndex.length = 0;
    updateInterpolationCaches.pieDataBySeriesIndex.length = 0;
  };

  const interpolateCartesianSeriesDataByIndex = (
    fromData: ReadonlyArray<DataPoint>,
    toData: ReadonlyArray<DataPoint>,
    t01: number,
    cache: DataPoint[] | null
  ): DataPoint[] | null => {
    if (fromData.length !== toData.length) return null;
    const n = toData.length;
    if (n === 0) return cache ?? [];

    const out =
      cache && cache.length === n
        ? cache
        : (() => {
            const created: DataPoint[] = new Array(n);
            for (let i = 0; i < n; i++) {
              const pTo = toData[i]!;
              const { x } = getPointXY(pTo);
              const size = isTupleDataPoint(pTo) ? pTo[2] : (pTo as any)?.size;
              created[i] = isTupleDataPoint(pTo)
                ? (size == null ? ([x, 0] as const) : ([x, 0, size] as const))
                : (size == null ? ({ x, y: 0 } as const) : ({ x, y: 0, size } as const));
            }
            return created;
          })();

    const t = clamp01(t01);
    for (let i = 0; i < n; i++) {
      const yFrom = getPointXY(fromData[i]!).y;
      const yTo = getPointXY(toData[i]!).y;
      const y = Number.isFinite(yFrom) && Number.isFinite(yTo) ? lerp(yFrom, yTo, t) : yTo;
      const p = out[i]!;
      if (isTupleDataPoint(p)) {
        (p as unknown as number[])[1] = y;
      } else {
        (p as any).y = y;
      }
    }

    return out;
  };

  const interpolatePieSeriesByIndex = (
    fromSeries: ResolvedPieSeriesConfig,
    toSeries: ResolvedPieSeriesConfig,
    t01: number,
    cache: ResolvedPieSeriesConfig['data'] | null
  ): ResolvedPieSeriesConfig => {
    const fromData = fromSeries.data;
    const toData = toSeries.data;
    if (fromData.length !== toData.length) return toSeries;

    const n = toData.length;
    const out =
      cache && cache.length === n
        ? cache
        : (() => {
            const created: any[] = new Array(n);
            for (let i = 0; i < n; i++) {
              // Preserve name/color from "to"; patch value per frame.
              created[i] = { ...toData[i]!, value: 0 };
            }
            return created as ResolvedPieSeriesConfig['data'];
          })();

    const t = clamp01(t01);
    for (let i = 0; i < n; i++) {
      const vFrom = (fromData[i] as any)?.value;
      const vTo = (toData[i] as any)?.value;
      const next =
        typeof vFrom === 'number' && typeof vTo === 'number' && Number.isFinite(vFrom) && Number.isFinite(vTo)
          ? Math.max(0, lerp(vFrom, vTo, t))
          : typeof vTo === 'number' && Number.isFinite(vTo)
            ? vTo
            : 0;
      (out[i] as any).value = next;
    }

    return { ...toSeries, data: out };
  };

  const interpolateSeriesForUpdate = (
    fromSeries: ResolvedChartGPUOptions['series'],
    toSeries: ResolvedChartGPUOptions['series'],
    t01: number,
    caches: UpdateInterpolationCaches | null
  ): ResolvedChartGPUOptions['series'] => {
    if (fromSeries.length !== toSeries.length) return toSeries;

    const out: ResolvedChartGPUOptions['series'][number][] = new Array(toSeries.length);

    for (let i = 0; i < toSeries.length; i++) {
      const a = fromSeries[i]!;
      const b = toSeries[i]!;

      if (a.type !== b.type) {
        out[i] = b;
        continue;
      }

      if (b.type === 'pie') {
        const cache = caches?.pieDataBySeriesIndex[i] ?? null;
        const animated = interpolatePieSeriesByIndex(a as ResolvedPieSeriesConfig, b as ResolvedPieSeriesConfig, t01, cache);
        if (caches) caches.pieDataBySeriesIndex[i] = animated.data as any;
        out[i] = animated;
        continue;
      }

      // Cartesian series: interpolate y-values by index. Keep x from "to".
      const aAny = a as unknown as { readonly data: ReadonlyArray<DataPoint> };
      const bAny = b as unknown as { readonly data: ReadonlyArray<DataPoint> };
      const aData = aAny.data;
      const bData = bAny.data;

      if (aData.length !== bData.length) {
        out[i] = b;
        continue;
      }
      if (bData.length > MAX_ANIMATED_POINTS_PER_SERIES) {
        out[i] = b;
        continue;
      }

      const cache = caches?.cartesianDataBySeriesIndex[i] ?? null;
      const animatedData = interpolateCartesianSeriesDataByIndex(aData, bData, t01, cache);
      if (!animatedData) {
        out[i] = b;
        continue;
      }
      if (caches) caches.cartesianDataBySeriesIndex[i] = animatedData;

      out[i] = { ...(b as any), data: animatedData };
    }

    return out;
  };

  const computeUpdateSnapshotAtProgress = (
    transition: UpdateTransition,
    t01: number,
    zoomRange: ZoomRange | null
  ): UpdateTransitionSnapshot => {
    const xBase = lerpDomain(transition.from.xBaseDomain, transition.to.xBaseDomain, t01);
    const xVisible = computeVisibleXDomain(xBase, zoomRange);
    const yBase = lerpDomain(transition.from.yBaseDomain, transition.to.yBaseDomain, t01);
    const series = interpolateSeriesForUpdate(transition.from.series, transition.to.series, t01, null);
    return {
      xBaseDomain: xBase,
      xVisibleDomain: { min: xVisible.min, max: xVisible.max },
      yBaseDomain: yBase,
      series,
    };
  };

  // Prevent spamming console.warn for repeated misuse.
  const warnedPieAppendSeries = new Set<number>();
  const warnedCandlestickAppendSeries = new Set<number>();

  // Coordinator-owned runtime series store (cartesian only).
  // - `runtimeRawDataByIndex[i]` owns a mutable array for streaming appends.
  // - `runtimeRawBoundsByIndex[i]` tracks raw bounds for axis auto-bounds and zoom mapping.
  let runtimeRawDataByIndex: Array<DataPoint[] | OHLCDataPoint[] | null> = new Array(options.series.length).fill(null);
  let runtimeRawBoundsByIndex: Array<Bounds | null> = new Array(options.series.length).fill(null);

  // Baseline sampled series list derived from runtime raw data (used as the “full span” baseline).
  // Zoom-visible resampling is derived from this baseline + runtime raw as needed.
  let runtimeBaseSeries: ResolvedChartGPUOptions['series'] = currentOptions.series;

  // Zoom-aware sampled series list used for rendering + cartesian hit-testing.
  // Derived from `currentOptions.series` (which still includes baseline sampled `data`).
  let renderSeries: ResolvedChartGPUOptions['series'] = currentOptions.series;
  // Unified flush scheduler (appends + zoom-aware resampling + optional GPU streaming updates).
  let flushScheduled = false;
  let flushRafId: number | null = null;
  let flushTimeoutId: number | null = null;

  // Zoom changes are debounced to avoid churn while wheel/drag is active.
  // When the debounce fires, we mark resampling "due" and schedule a unified flush.
  let zoomResampleDebounceTimer: number | null = null;
  let zoomResampleDue = false;

  // Coalesced streaming appends (flushed at the start of `render()`).
  const pendingAppendByIndex = new Map<number, DataPoint[]>();

  // Tracks what the DataStore currently represents for each series index.
  // Used to decide whether `appendSeries(...)` is a correct fast-path.
  type GpuSeriesKind = 'unknown' | 'fullRawLine' | 'other';
  let gpuSeriesKindByIndex: GpuSeriesKind[] = new Array(currentOptions.series.length).fill('unknown');
  const appendedGpuThisFrame = new Set<number>();

  // Tooltip is a DOM overlay element; enable by default unless explicitly disabled.
  let tooltip: Tooltip | null =
    overlayContainer && currentOptions.tooltip?.show !== false ? createTooltip(overlayContainer) : null;

  legend?.update(currentOptions.series, currentOptions.theme);

  let dataStore = createDataStore(device);

  const gridRenderer = createGridRenderer(device, { targetFormat });
  const xAxisRenderer = createAxisRenderer(device, { targetFormat });
  const yAxisRenderer = createAxisRenderer(device, { targetFormat });
  const crosshairRenderer = createCrosshairRenderer(device, { targetFormat });
  crosshairRenderer.setVisible(false);
  const highlightRenderer = createHighlightRenderer(device, { targetFormat });
  highlightRenderer.setVisible(false);

  const initialGridArea = computeGridArea(gpuContext, currentOptions);
  const eventManager = createEventManager(gpuContext.canvas, initialGridArea);

  type PointerSource = 'mouse' | 'sync';

  type PointerState = Readonly<{
    source: PointerSource;
    x: number;
    y: number;
    gridX: number;
    gridY: number;
    isInGrid: boolean;
    hasPointer: boolean;
  }>;

  let pointerState: PointerState = {
    source: 'mouse',
    x: 0,
    y: 0,
    gridX: 0,
    gridY: 0,
    isInGrid: false,
    hasPointer: false,
  };

  // Interaction-x state (domain units). This drives chart sync.
  let interactionX: number | null = null;
  let interactionXSource: unknown = undefined;
  const interactionXListeners = new Set<(x: number | null, source?: unknown) => void>();

  // Cached interaction scales from the last render (used for pointer -> domain-x mapping).
  let lastInteractionScales:
    | {
        readonly xScale: LinearScale;
        readonly yScale: LinearScale;
        readonly plotWidthCss: number;
        readonly plotHeightCss: number;
      }
    | null = null;

  const emitInteractionX = (nextX: number | null, source?: unknown): void => {
    const snapshot = Array.from(interactionXListeners);
    for (const cb of snapshot) cb(nextX, source);
  };

  const setInteractionXInternal = (nextX: number | null, source?: unknown): void => {
    const normalized = nextX !== null && Number.isFinite(nextX) ? nextX : null;
    if (interactionX === normalized && interactionXSource === source) return;
    interactionX = normalized;
    interactionXSource = source;
    emitInteractionX(interactionX, interactionXSource);
  };

  const requestRender = (): void => {
    callbacks?.onRequestRender?.();
  };

  const isFullSpanZoomRange = (range: ZoomRange | null): boolean => {
    if (!range) return true;
    return (
      Number.isFinite(range.start) &&
      Number.isFinite(range.end) &&
      range.start <= 0 &&
      range.end >= 100
    );
  };

  const cancelScheduledFlush = (): void => {
    if (flushRafId !== null) {
      cancelAnimationFrame(flushRafId);
      flushRafId = null;
    }
    if (flushTimeoutId !== null) {
      clearTimeout(flushTimeoutId);
      flushTimeoutId = null;
    }
    flushScheduled = false;
  };

  const cancelZoomResampleDebounce = (): void => {
    if (zoomResampleDebounceTimer !== null) {
      clearTimeout(zoomResampleDebounceTimer);
      zoomResampleDebounceTimer = null;
    }
  };

  const flushPendingAppends = (): boolean => {
    if (pendingAppendByIndex.size === 0) return false;

    appendedGpuThisFrame.clear();

    const zoomRangeBefore = zoomState?.getRange() ?? null;
    const isFullSpanZoomBefore = isFullSpanZoomRange(zoomRangeBefore);
    const canAutoScroll =
      currentOptions.autoScroll === true &&
      zoomState != null &&
      currentOptions.xAxis.min == null &&
      currentOptions.xAxis.max == null;

    // Capture the pre-append visible domain so we can preserve it for “panned away” behavior.
    const prevBaseXDomain = computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
    const prevVisibleXDomain = zoomRangeBefore ? computeVisibleXDomain(prevBaseXDomain, zoomRangeBefore) : null;

    let didAppendAny = false;

    for (const [seriesIndex, points] of pendingAppendByIndex) {
      if (points.length === 0) continue;
      const s = currentOptions.series[seriesIndex];
      if (!s || s.type === 'pie' || s.type === 'candlestick') continue;
      didAppendAny = true;

      // Note: candlestick series are filtered out above, so this is always cartesian `DataPoint[]`.
      let raw = runtimeRawDataByIndex[seriesIndex] as DataPoint[] | null;
      if (!raw) {
        const seed = (s.rawData ?? s.data) as ReadonlyArray<DataPoint>;
        raw = seed.length === 0 ? [] : seed.slice();
        runtimeRawDataByIndex[seriesIndex] = raw;
        runtimeRawBoundsByIndex[seriesIndex] = s.rawBounds ?? computeRawBoundsFromData(raw);
      }

      // Optional fast-path: if the GPU buffer currently represents the full, unsampled line series,
      // we can append just the new points to the existing GPU buffer (no full re-upload).
      if (
        s.type === 'line' &&
        s.sampling === 'none' &&
        isFullSpanZoomBefore &&
        gpuSeriesKindByIndex[seriesIndex] === 'fullRawLine'
      ) {
        try {
          dataStore.appendSeries(seriesIndex, points);
          appendedGpuThisFrame.add(seriesIndex);
        } catch {
          // If the DataStore has not been initialized for this index (or any other error occurs),
          // fall back to the normal full upload path later in render().
        }
      }

      raw.push(...points);
      runtimeRawBoundsByIndex[seriesIndex] = extendBoundsWithDataPoints(runtimeRawBoundsByIndex[seriesIndex], points);
    }

    pendingAppendByIndex.clear();
    if (!didAppendAny) return false;

    // Auto-scroll is applied only on append (not on `setOptions`).
    if (canAutoScroll && zoomRangeBefore && prevVisibleXDomain) {
      const r = zoomRangeBefore;
      if (r.end >= 99.5) {
        const span = r.end - r.start;
        zoomState!.setRange(100 - span, 100);
      } else {
        const nextBaseXDomain = computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
        const span = nextBaseXDomain.max - nextBaseXDomain.min;
        if (Number.isFinite(span) && span > 0) {
          const nextStartRaw = ((prevVisibleXDomain.min - nextBaseXDomain.min) / span) * 100;
          const nextEndRaw = ((prevVisibleXDomain.max - nextBaseXDomain.min) / span) * 100;
          // Clamp defensively; ZoomState also clamps/orders internally.
          const nextStart = Math.max(0, Math.min(100, nextStartRaw));
          const nextEnd = Math.max(0, Math.min(100, nextEndRaw));
          zoomState!.setRange(nextStart, nextEnd);
        }
      }
    }

    recomputeRuntimeBaseSeries();

    // If zoom is disabled or full-span, `renderSeries` is just the baseline.
    // (Zoom-visible resampling is handled by the unified flush when needed.)
    const zoomRangeAfter = zoomState?.getRange() ?? null;
    if (zoomRangeAfter == null || isFullSpanZoomRange(zoomRangeAfter)) {
      renderSeries = runtimeBaseSeries;
    }

    return true;
  };

  const executeFlush = (options?: { readonly requestRenderAfter?: boolean }): void => {
    if (disposed) return;

    const requestRenderAfter = options?.requestRenderAfter ?? true;

    const didAppend = flushPendingAppends();

    const zoomRange = zoomState?.getRange() ?? null;
    const zoomIsFullSpan = isFullSpanZoomRange(zoomRange);
    const zoomActiveNotFullSpan = zoomRange != null && !zoomIsFullSpan;

    let didResample = false;

    // Zoom changes (debounced): apply on flush.
    if (zoomResampleDue) {
      zoomResampleDue = false;
      cancelZoomResampleDebounce();

      if (!zoomRange || zoomIsFullSpan) {
        renderSeries = runtimeBaseSeries;
      } else {
        recomputeRenderSeries();
      }
      didResample = true;
    } else if (didAppend && zoomActiveNotFullSpan) {
      // Appends during an active zoom window require resampling the visible range.
      // (Avoid doing this work when zoom is full-span or disabled.)
      zoomResampleDue = false;
      cancelZoomResampleDebounce();
      recomputeRenderSeries();
      didResample = true;
    }

    if ((didAppend || didResample) && requestRenderAfter) {
      requestRender();
    }
  };

  const scheduleFlush = (options?: { readonly immediate?: boolean }): void => {
    if (disposed) return;
    if (flushScheduled && !options?.immediate) return;

    // Cancel any previous schedule so we coalesce to exactly one pending flush.
    if (flushRafId !== null) {
      cancelAnimationFrame(flushRafId);
      flushRafId = null;
    }
    if (flushTimeoutId !== null) {
      clearTimeout(flushTimeoutId);
      flushTimeoutId = null;
    }

    flushScheduled = true;

    flushRafId = requestAnimationFrame(() => {
      flushRafId = null;
      if (disposed) {
        cancelScheduledFlush();
        return;
      }
      // rAF fired first: cancel the fallback timeout.
      if (flushTimeoutId !== null) {
        clearTimeout(flushTimeoutId);
        flushTimeoutId = null;
      }
      flushScheduled = false;
      executeFlush();
    });

    // Fallback: ensure we flush even if rAF is delayed (high-frequency streams > 60Hz).
    flushTimeoutId = window.setTimeout(() => {
      if (disposed) {
        cancelScheduledFlush();
        return;
      }
      if (!flushScheduled) return;

      if (flushRafId !== null) {
        cancelAnimationFrame(flushRafId);
        flushRafId = null;
      }
      flushScheduled = false;
      flushTimeoutId = null;
      executeFlush();
    }, 16);
  };

  const scheduleZoomResample = (): void => {
    if (disposed) return;

    cancelZoomResampleDebounce();
    zoomResampleDue = false;

    zoomResampleDebounceTimer = window.setTimeout(() => {
      zoomResampleDebounceTimer = null;
      if (disposed) return;
      zoomResampleDue = true;
      scheduleFlush();
    }, 100);
  };

  const getPlotSizeCssPx = (
    canvas: HTMLCanvasElement,
    gridArea: GridArea
  ): { readonly plotWidthCss: number; readonly plotHeightCss: number } | null => {
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;

    const plotWidthCss = rect.width - gridArea.left - gridArea.right;
    const plotHeightCss = rect.height - gridArea.top - gridArea.bottom;
    if (!(plotWidthCss > 0) || !(plotHeightCss > 0)) return null;

    return { plotWidthCss, plotHeightCss };
  };

  const computeInteractionScalesGridCssPx = (
    gridArea: GridArea,
    domains: { readonly xDomain: { readonly min: number; readonly max: number }; readonly yDomain: { readonly min: number; readonly max: number } }
  ):
    | {
        readonly xScale: LinearScale;
        readonly yScale: LinearScale;
        readonly plotWidthCss: number;
        readonly plotHeightCss: number;
      }
    | null => {
    const canvas = gpuContext.canvas;
    if (!canvas) return null;

    const plotSize = getPlotSizeCssPx(canvas, gridArea);
    if (!plotSize) return null;

    // IMPORTANT: grid-local CSS px ranges (0..plotWidth/Height), for interaction hit-testing.
    const xScale = createLinearScale().domain(domains.xDomain.min, domains.xDomain.max).range(0, plotSize.plotWidthCss);
    const yScale = createLinearScale().domain(domains.yDomain.min, domains.yDomain.max).range(plotSize.plotHeightCss, 0);

    return { xScale, yScale, plotWidthCss: plotSize.plotWidthCss, plotHeightCss: plotSize.plotHeightCss };
  };

  const buildTooltipParams = (seriesIndex: number, dataIndex: number, point: DataPoint): TooltipParams => {
    const s = currentOptions.series[seriesIndex];
    const { x, y } = getPointXY(point);
    return {
      seriesName: s?.name ?? '',
      seriesIndex,
      dataIndex,
      value: [x, y],
      color: s?.color ?? '#888',
    };
  };

  const onMouseMove = (payload: ChartGPUEventPayload): void => {
    pointerState = {
      source: 'mouse',
      x: payload.x,
      y: payload.y,
      gridX: payload.gridX,
      gridY: payload.gridY,
      isInGrid: payload.isInGrid,
      hasPointer: true,
    };

    // If we're over the plot and we have recent interaction scales, update interaction-x in domain units.
    // (Best-effort; render() refreshes scales and overlays.)
    if (payload.isInGrid && lastInteractionScales) {
      const xDomain = lastInteractionScales.xScale.invert(payload.gridX);
      setInteractionXInternal(Number.isFinite(xDomain) ? xDomain : null, 'mouse');
    } else if (!payload.isInGrid) {
      // Clear interaction-x when leaving the plot area (keeps synced charts from “sticking”).
      setInteractionXInternal(null, 'mouse');
    }

    crosshairRenderer.setVisible(payload.isInGrid);
    requestRender();
  };

  const onMouseLeave = (_payload: ChartGPUEventPayload): void => {
    // Only clear interaction overlays for real pointer interaction.
    // If we're being driven by a sync-x, leaving the canvas shouldn't hide the overlays.
    if (pointerState.source !== 'mouse') return;

    pointerState = { ...pointerState, isInGrid: false, hasPointer: false };
    crosshairRenderer.setVisible(false);
    tooltip?.hide();
    setInteractionXInternal(null, 'mouse');
    requestRender();
  };

  eventManager.on('mousemove', onMouseMove);
  eventManager.on('mouseleave', onMouseLeave);

  // Optional internal “inside zoom” (wheel zoom + drag pan).
  let zoomState: ZoomState | null = null;
  let insideZoom: ReturnType<typeof createInsideZoom> | null = null;
  let unsubscribeZoom: (() => void) | null = null;
  let lastOptionsZoomRange: Readonly<{ start: number; end: number }> | null = null;
  const zoomRangeListeners = new Set<(range: Readonly<{ start: number; end: number }>) => void>();

  const emitZoomRange = (range: Readonly<{ start: number; end: number }>): void => {
    const snapshot = Array.from(zoomRangeListeners);
    for (const cb of snapshot) cb(range);
  };

  const getZoomOptionsConfig = (
    opts: ResolvedChartGPUOptions
  ): { readonly start: number; readonly end: number; readonly hasInside: boolean } | null => {
    // Zoom is enabled when *either* inside or slider exists. A single shared percent-space
    // window is used for both.
    const insideCfg = opts.dataZoom?.find((z) => z?.type === 'inside');
    const sliderCfg = opts.dataZoom?.find((z) => z?.type === 'slider');
    const cfg = insideCfg ?? sliderCfg;
    if (!cfg) return null;
    const start = Number.isFinite(cfg.start) ? cfg.start! : 0;
    const end = Number.isFinite(cfg.end) ? cfg.end! : 100;
    return { start, end, hasInside: !!insideCfg };
  };

  const updateZoom = (): void => {
    const cfg = getZoomOptionsConfig(currentOptions);

    if (!cfg) {
      insideZoom?.dispose();
      insideZoom = null;
      unsubscribeZoom?.();
      unsubscribeZoom = null;
      zoomState = null;
      lastOptionsZoomRange = null;
      return;
    }

    if (!zoomState) {
      zoomState = createZoomState(cfg.start, cfg.end);
      lastOptionsZoomRange = { start: cfg.start, end: cfg.end };
      unsubscribeZoom = zoomState.onChange((range) => {
        // Immediate render for UI feedback (axes/crosshair/slider).
        requestRender();
        // Debounce resampling; the unified flush will do the work.
        scheduleZoomResample();
        // Ensure listeners get a stable readonly object.
        emitZoomRange({ start: range.start, end: range.end });
      });
    } else if (
      lastOptionsZoomRange == null ||
      lastOptionsZoomRange.start !== cfg.start ||
      lastOptionsZoomRange.end !== cfg.end
    ) {
      // Only apply option-provided start/end when:
      // - zoom is first created, or
      // - start/end actually changed in options
      zoomState.setRange(cfg.start, cfg.end);
      lastOptionsZoomRange = { start: cfg.start, end: cfg.end };
    }

    // Only enable inside zoom handler when `{ type: 'inside' }` exists.
    if (cfg.hasInside) {
      if (!insideZoom) {
        insideZoom = createInsideZoom(eventManager, zoomState);
        insideZoom.enable();
      }
    } else {
      insideZoom?.dispose();
      insideZoom = null;
    }
  };

  const initRuntimeSeriesFromOptions = (): void => {
    const count = currentOptions.series.length;
    runtimeRawDataByIndex = new Array(count).fill(null);
    runtimeRawBoundsByIndex = new Array(count).fill(null);
    pendingAppendByIndex.clear();

    for (let i = 0; i < count; i++) {
      const s = currentOptions.series[i]!;
      if (s.type === 'pie') continue;

      if (s.type === 'candlestick') {
        // Store candlestick raw OHLC data (not for streaming append, but for zoom-aware resampling).
        const rawOHLC = (s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>;
        const owned = rawOHLC.length === 0 ? [] : rawOHLC.slice();
        runtimeRawDataByIndex[i] = owned;
        runtimeRawBoundsByIndex[i] = s.rawBounds ?? null;
        continue;
      }

      const raw = (s.rawData ?? s.data) as ReadonlyArray<DataPoint>;
      // Coordinator-owned: copy into a mutable array (streaming appends mutate this).
      const owned = raw.length === 0 ? [] : raw.slice();
      runtimeRawDataByIndex[i] = owned;
      runtimeRawBoundsByIndex[i] = s.rawBounds ?? computeRawBoundsFromData(owned);
    }
  };

  const recomputeRuntimeBaseSeries = (): void => {
    const next: ResolvedChartGPUOptions['series'][number][] = new Array(currentOptions.series.length);
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (s.type === 'pie') {
        next[i] = s;
        continue;
      }

      if (s.type === 'candlestick') {
        const rawOHLC =
          (runtimeRawDataByIndex[i] as ReadonlyArray<OHLCDataPoint> | null) ??
          ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
        const bounds = runtimeRawBoundsByIndex[i] ?? s.rawBounds ?? undefined;
        const baselineSampled = s.sampling === 'ohlc' && rawOHLC.length > s.samplingThreshold
          ? ohlcSample(rawOHLC, s.samplingThreshold)
          : rawOHLC;
        next[i] = { ...s, rawData: rawOHLC, rawBounds: bounds, data: baselineSampled };
        continue;
      }

      const raw =
        (runtimeRawDataByIndex[i] as DataPoint[] | null) ?? ((s.rawData ?? s.data) as ReadonlyArray<DataPoint>);
      const bounds = runtimeRawBoundsByIndex[i] ?? s.rawBounds ?? undefined;
      const baselineSampled = sampleSeriesDataPoints(raw, s.sampling, s.samplingThreshold);
      next[i] = { ...s, rawData: raw, rawBounds: bounds, data: baselineSampled };
    }
    runtimeBaseSeries = next;
  };

  function recomputeRenderSeries(): void {
    const zoomRange = zoomState?.getRange() ?? null;
    const baseXDomain = computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
    const visibleX = computeVisibleXDomain(baseXDomain, zoomRange);

    // Sampling scale behavior:
    // - Use `samplingThreshold` as baseline at full span.
    // - As zoom span shrinks, raise the threshold so fewer points are dropped (more detail).
    // - Clamp to avoid huge allocations / pathological thresholds.
    const MIN_TARGET_POINTS = 2;
    const MAX_TARGET_POINTS_ABS = 200_000;
    const MAX_TARGET_MULTIPLIER = 32;
    const spanFracSafe = Math.max(1e-3, Math.min(1, visibleX.spanFraction));

    const next: ResolvedChartGPUOptions['series'][number][] = new Array(runtimeBaseSeries.length);

    for (let i = 0; i < runtimeBaseSeries.length; i++) {
      const s = runtimeBaseSeries[i]!;

      if (s.type === 'pie') {
        next[i] = s;
        continue;
      }

      // Fast path: no zoom window / full span. Use baseline resolved `data` (already sampled by resolver).
      const isFullSpan =
        zoomRange == null ||
        (Number.isFinite(zoomRange.start) &&
          Number.isFinite(zoomRange.end) &&
          zoomRange.start <= 0 &&
          zoomRange.end >= 100);
      if (isFullSpan) {
        next[i] = s;
        continue;
      }

      // Candlestick series: OHLC-specific slicing + sampling.
      if (s.type === 'candlestick') {
        const rawOHLC =
          (runtimeRawDataByIndex[i] as ReadonlyArray<OHLCDataPoint> | null) ??
          ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
        const visibleOHLC = sliceVisibleRangeByOHLC(rawOHLC, visibleX.min, visibleX.max);

        const sampling = s.sampling;
        const baseThreshold = s.samplingThreshold;

        const baseT = Number.isFinite(baseThreshold) ? Math.max(1, baseThreshold | 0) : 1;
        const maxTarget = Math.min(MAX_TARGET_POINTS_ABS, Math.max(MIN_TARGET_POINTS, baseT * MAX_TARGET_MULTIPLIER));
        const target = clampInt(Math.round(baseT / spanFracSafe), MIN_TARGET_POINTS, maxTarget);

        const sampled = sampling === 'ohlc' && visibleOHLC.length > target
          ? ohlcSample(visibleOHLC, target)
          : visibleOHLC;

        next[i] = { ...s, data: sampled };
        continue;
      }

      // Cartesian series (line, area, bar, scatter).
      const rawData =
        (runtimeRawDataByIndex[i] as DataPoint[] | null) ?? ((s.rawData ?? s.data) as ReadonlyArray<DataPoint>);
      const visibleRaw = sliceVisibleRangeByX(rawData, visibleX.min, visibleX.max);

      const sampling = s.sampling;
      const baseThreshold = s.samplingThreshold;

      const baseT = Number.isFinite(baseThreshold) ? Math.max(1, baseThreshold | 0) : 1;
      const maxTarget = Math.min(MAX_TARGET_POINTS_ABS, Math.max(MIN_TARGET_POINTS, baseT * MAX_TARGET_MULTIPLIER));
      const target = clampInt(Math.round(baseT / spanFracSafe), MIN_TARGET_POINTS, maxTarget);

      const sampled = sampleSeriesDataPoints(visibleRaw, sampling, target);
      next[i] = { ...s, data: sampled };
    }

    renderSeries = next;
  }

  updateZoom();
  initRuntimeSeriesFromOptions();
  recomputeRuntimeBaseSeries();
  recomputeRenderSeries();

  const areaRenderers: Array<ReturnType<typeof createAreaRenderer>> = [];
  const lineRenderers: Array<ReturnType<typeof createLineRenderer>> = [];
  const scatterRenderers: Array<ReturnType<typeof createScatterRenderer>> = [];
  const pieRenderers: Array<ReturnType<typeof createPieRenderer>> = [];
  const barRenderer = createBarRenderer(device, { targetFormat });

  const ensureAreaRendererCount = (count: number): void => {
    while (areaRenderers.length > count) {
      const r = areaRenderers.pop();
      r?.dispose();
    }
    while (areaRenderers.length < count) {
      areaRenderers.push(createAreaRenderer(device, { targetFormat }));
    }
  };

  const ensureLineRendererCount = (count: number): void => {
    while (lineRenderers.length > count) {
      const r = lineRenderers.pop();
      r?.dispose();
    }
    while (lineRenderers.length < count) {
      lineRenderers.push(createLineRenderer(device, { targetFormat }));
    }
  };

  const ensureScatterRendererCount = (count: number): void => {
    while (scatterRenderers.length > count) {
      const r = scatterRenderers.pop();
      r?.dispose();
    }
    while (scatterRenderers.length < count) {
      scatterRenderers.push(createScatterRenderer(device, { targetFormat }));
    }
  };

  const ensurePieRendererCount = (count: number): void => {
    while (pieRenderers.length > count) {
      const r = pieRenderers.pop();
      r?.dispose();
    }
    while (pieRenderers.length < count) {
      pieRenderers.push(createPieRenderer(device, { targetFormat }));
    }
  };

  ensureAreaRendererCount(currentOptions.series.length);
  ensureLineRendererCount(currentOptions.series.length);
  ensureScatterRendererCount(currentOptions.series.length);
  ensurePieRendererCount(currentOptions.series.length);

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('RenderCoordinator is disposed.');
  };

  const cancelUpdateTransition = (): void => {
    if (updateAnimId) {
      try {
        updateAnimController.cancel(updateAnimId);
      } catch {
        // best-effort
      }
    }
    updateAnimId = null;
    updateProgress01 = 1;
    updateTransition = null;
    resetUpdateInterpolationCaches();
  };

  const isDomainEqual = (a: { readonly min: number; readonly max: number }, b: { readonly min: number; readonly max: number }): boolean =>
    a.min === b.min && a.max === b.max;

  const didSeriesDataLikelyChange = (
    prev: ResolvedChartGPUOptions['series'],
    next: ResolvedChartGPUOptions['series']
  ): boolean => {
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i++) {
      const a = prev[i]!;
      const b = next[i]!;
      if (a.type !== b.type) return true;

      // Prefer cheap reference checks (good enough for eligibility gating).
      if (a.type === 'pie') {
        const aPie = a as ResolvedPieSeriesConfig;
        const bPie = b as ResolvedPieSeriesConfig;
        if (aPie.data !== bPie.data) return true;
        if (aPie.data.length !== bPie.data.length) return true;
      } else {
        const aAny = a as unknown as { readonly rawData?: ReadonlyArray<DataPoint>; readonly data: ReadonlyArray<DataPoint> };
        const bAny = b as unknown as { readonly rawData?: ReadonlyArray<DataPoint>; readonly data: ReadonlyArray<DataPoint> };
        const aRaw = (aAny.rawData ?? aAny.data) as ReadonlyArray<DataPoint>;
        const bRaw = (bAny.rawData ?? bAny.data) as ReadonlyArray<DataPoint>;
        if (aRaw !== bRaw) return true;
        if (aRaw.length !== bRaw.length) return true;
      }
    }
    return false;
  };

  const setOptions: RenderCoordinator['setOptions'] = (resolvedOptions) => {
    assertNotDisposed();

    // Capture "from" snapshot BEFORE overwriting coordinator state.
    const fromZoomRange = zoomState?.getRange() ?? null;
    const fromSnapshot: UpdateTransitionSnapshot = (() => {
      // Requirement (mid-flight updates): if a transition is running, rebase from the current blended state.
      if (updateTransition && updateAnimId) {
        try {
          updateAnimController.update(performance.now());
        } catch {
          // best-effort
        }
        return computeUpdateSnapshotAtProgress(updateTransition, updateProgress01, fromZoomRange);
      }

      const fromXBase = computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
      const fromXVisible = computeVisibleXDomain(fromXBase, fromZoomRange);
      const fromYBase = computeBaseYDomain(currentOptions, runtimeRawBoundsByIndex);
      return {
        xBaseDomain: fromXBase,
        xVisibleDomain: { min: fromXVisible.min, max: fromXVisible.max },
        yBaseDomain: fromYBase,
        series: renderSeries,
      };
    })();

    // Cancel any prior update transition AFTER capturing the rebased "from" snapshot.
    cancelUpdateTransition();
    const likelyDataChanged = didSeriesDataLikelyChange(currentOptions.series, resolvedOptions.series);

    currentOptions = resolvedOptions;
    runtimeBaseSeries = resolvedOptions.series;
    renderSeries = resolvedOptions.series;
    gpuSeriesKindByIndex = new Array(resolvedOptions.series.length).fill('unknown');
    legend?.update(resolvedOptions.series, resolvedOptions.theme);
    updateZoom();
    cancelZoomResampleDebounce();
    zoomResampleDue = false;
    cancelScheduledFlush();
    initRuntimeSeriesFromOptions();
    recomputeRuntimeBaseSeries();
    recomputeRenderSeries();

    // Tooltip enablement may change at runtime.
    if (overlayContainer) {
      const shouldHaveTooltip = currentOptions.tooltip?.show !== false;
      if (shouldHaveTooltip && !tooltip) tooltip = createTooltip(overlayContainer);
      if (!shouldHaveTooltip && tooltip) tooltip.hide();
    } else {
      tooltip?.hide();
    }

    const nextCount = resolvedOptions.series.length;
    ensureAreaRendererCount(nextCount);
    ensureLineRendererCount(nextCount);
    ensureScatterRendererCount(nextCount);
    ensurePieRendererCount(nextCount);

    // When the series count shrinks, explicitly destroy per-index GPU buffers for removed series.
    // This avoids recreating the entire DataStore and keeps existing buffers for retained indices.
    if (nextCount < lastSeriesCount) {
      for (let i = nextCount; i < lastSeriesCount; i++) {
        dataStore.removeSeries(i);
      }
    }
    lastSeriesCount = nextCount;

    // If animation is explicitly disabled mid-flight, stop the intro without scheduling more frames.
    if (currentOptions.animation === false && introPhase === 'running') {
      introAnimController.cancelAll();
      introAnimId = null;
      introPhase = 'done';
      introProgress01 = 1;
    }

    // If animation is explicitly disabled, ensure any running update transition is stopped.
    if (currentOptions.animation === false) {
      cancelUpdateTransition();
      return;
    }

    // Capture "to" snapshot after recompute.
    const toZoomRange = zoomState?.getRange() ?? null;
    const toXBase = computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
    const toXVisible = computeVisibleXDomain(toXBase, toZoomRange);
    const toYBase = computeBaseYDomain(currentOptions, runtimeRawBoundsByIndex);
    const toSeriesForTransition = renderSeries;

    const domainChanged = !isDomainEqual(fromSnapshot.xBaseDomain, toXBase) || !isDomainEqual(fromSnapshot.yBaseDomain, toYBase);

    const shouldAnimateUpdate = hasRenderedOnce && (domainChanged || likelyDataChanged);
    if (!shouldAnimateUpdate) return;

    const updateCfg = resolveUpdateAnimationConfig(currentOptions.animation);
    if (!updateCfg) return;

    updateTransition = {
      from: {
        xBaseDomain: fromSnapshot.xBaseDomain,
        xVisibleDomain: fromSnapshot.xVisibleDomain,
        yBaseDomain: fromSnapshot.yBaseDomain,
        series: fromSnapshot.series,
      },
      to: {
        xBaseDomain: toXBase,
        xVisibleDomain: { min: toXVisible.min, max: toXVisible.max },
        yBaseDomain: toYBase,
        series: toSeriesForTransition,
      },
    };
    resetUpdateInterpolationCaches();

    const totalMs = updateCfg.delayMs + updateCfg.durationMs;
    const easingWithDelay: EasingFunction = (t01) => {
      const t = clamp01(t01);
      if (!(totalMs > 0)) return 1;

      const elapsedMs = t * totalMs;
      if (elapsedMs <= updateCfg.delayMs) return 0;

      if (!(updateCfg.durationMs > 0)) return 1;
      const innerT = (elapsedMs - updateCfg.delayMs) / updateCfg.durationMs;
      return updateCfg.easing(innerT);
    };

    updateProgress01 = 0;
    const id = updateAnimController.animate(
      0,
      1,
      totalMs,
      easingWithDelay,
      (value) => {
        if (disposed || updateAnimId !== id) return;
        updateProgress01 = clamp01(value);
        // Render-on-demand: request frames only while the update transition is active.
        if (updateProgress01 < 1) requestRender();
      },
      () => {
        if (disposed || updateAnimId !== id) return;
        updateProgress01 = 1;
        updateTransition = null;
        updateAnimId = null;
        resetUpdateInterpolationCaches();
      }
    );
    updateAnimId = id;
  };

  const appendData: RenderCoordinator['appendData'] = (seriesIndex, newPoints) => {
    assertNotDisposed();
    if (!Number.isFinite(seriesIndex)) return;
    if (seriesIndex < 0 || seriesIndex >= currentOptions.series.length) return;
    if (!newPoints || newPoints.length === 0) return;

    const s = currentOptions.series[seriesIndex]!;
    if (s.type === 'pie') {
      // Pie series are non-cartesian and currently not supported by streaming append.
      if (!warnedPieAppendSeries.has(seriesIndex)) {
        warnedPieAppendSeries.add(seriesIndex);
        console.warn(
          `RenderCoordinator.appendData(${seriesIndex}, ...): pie series are not supported by streaming append.`
        );
      }
      return;
    }
    if (s.type === 'candlestick') {
      // Candlestick series are not yet implemented and currently not supported by streaming append.
      if (!warnedCandlestickAppendSeries.has(seriesIndex)) {
        warnedCandlestickAppendSeries.add(seriesIndex);
        console.warn(
          `RenderCoordinator.appendData(${seriesIndex}, ...): candlestick series are not yet implemented.`
        );
      }
      return;
    }

    const existing = pendingAppendByIndex.get(seriesIndex);
    if (existing) {
      existing.push(...newPoints);
    } else {
      // Copy into a mutable staging array so repeated appends coalesce without extra allocations.
      pendingAppendByIndex.set(seriesIndex, Array.from(newPoints));
    }

    // Coalesce appends + any required resampling + GPU streaming updates into a single flush.
    scheduleFlush();
  };

  const shouldRenderArea = (series: ResolvedChartGPUOptions['series'][number]): boolean => {
    switch (series.type) {
      case 'area':
        return true;
      case 'line':
        return series.areaStyle != null;
      case 'bar':
        return false;
      case 'scatter':
        return false;
      case 'pie':
        return false;
      case 'candlestick':
        return false;
      default:
        return assertUnreachable(series);
    }
  };

  const render: RenderCoordinator['render'] = () => {
    assertNotDisposed();
    if (!gpuContext.canvasContext || !gpuContext.canvas) return;

    // Safety: if a render is triggered for other reasons (e.g. pointer movement) while appends
    // are queued, flush them now so this frame draws up-to-date data. This avoids doing any work
    // when there are no appends.
    if (pendingAppendByIndex.size > 0 || zoomResampleDue) {
      cancelScheduledFlush();
      executeFlush({ requestRenderAfter: false });
    }

    const hasCartesianSeries = currentOptions.series.some((s) => s.type !== 'pie' && s.type !== 'candlestick');
    const seriesForIntro = renderSeries;

    // Story 5.16: start/update intro animation once we have drawable series marks.
    if (introPhase !== 'done') {
      const introCfg = resolveIntroAnimationConfig(currentOptions.animation);

      const hasDrawableSeriesMarks = (() => {
        for (let i = 0; i < seriesForIntro.length; i++) {
          const s = seriesForIntro[i]!;
          switch (s.type) {
            case 'pie': {
              // Pie renderer only emits slices with value > 0.
              if (s.data.some((it) => typeof it?.value === 'number' && Number.isFinite(it.value) && it.value > 0)) {
                return true;
              }
              break;
            }
            case 'line':
            case 'area':
            case 'bar':
            case 'scatter': {
              if (s.data.length > 0) return true;
              break;
            }
            case 'candlestick': {
              // Candlestick not yet implemented, skip (no drawable marks).
              break;
            }
            default:
              assertUnreachable(s);
          }
        }
        return false;
      })();

      if (introPhase === 'pending' && introCfg && hasDrawableSeriesMarks) {
        const totalMs = introCfg.delayMs + introCfg.durationMs;
        const easingWithDelay: EasingFunction = (t01) => {
          const t = clamp01(t01);
          if (!(totalMs > 0)) return 1;

          const elapsedMs = t * totalMs;
          if (elapsedMs <= introCfg.delayMs) return 0;

          if (!(introCfg.durationMs > 0)) return 1;
          const innerT = (elapsedMs - introCfg.delayMs) / introCfg.durationMs;
          return introCfg.easing(innerT);
        };

        introProgress01 = 0;
        introPhase = 'running';
        introAnimId = introAnimController.animate(
          0,
          1,
          totalMs,
          easingWithDelay,
          (value) => {
            if (disposed || introPhase !== 'running') return;
            introProgress01 = clamp01(value);
            // Render-on-demand: request frames only while the intro is active.
            if (introProgress01 < 1) requestRender();
          },
          () => {
            if (disposed) return;
            introPhase = 'done';
            introProgress01 = 1;
            introAnimId = null;
          }
        );
      }

      // Progress animations based on wall-clock time. This is cheap when no animations are active.
      introAnimController.update(performance.now());
    }

    // Story 5.17: progress update animation based on wall-clock time.
    // (Interpolation is applied below; this tick just advances progress.)
    if (updateTransition !== null && updateAnimId) {
      updateAnimController.update(performance.now());
    }

    const gridArea = computeGridArea(gpuContext, currentOptions);
    eventManager.updateGridArea(gridArea);
    const zoomRange = zoomState?.getRange() ?? null;

    const updateP = updateTransition ? clamp01(updateProgress01) : 1;
    const baseXDomain = updateTransition
      ? lerpDomain(updateTransition.from.xBaseDomain, updateTransition.to.xBaseDomain, updateP)
      : computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
    const yBaseDomain = updateTransition
      ? lerpDomain(updateTransition.from.yBaseDomain, updateTransition.to.yBaseDomain, updateP)
      : computeBaseYDomain(currentOptions, runtimeRawBoundsByIndex);
    const visibleXDomain = computeVisibleXDomain(baseXDomain, zoomRange);

    const plotClipRect = computePlotClipRect(gridArea);
    const plotScissor = computePlotScissorDevicePx(gridArea);

    const xScale = createLinearScale()
      .domain(visibleXDomain.min, visibleXDomain.max)
      .range(plotClipRect.left, plotClipRect.right);
    const yScale = createLinearScale().domain(yBaseDomain.min, yBaseDomain.max).range(plotClipRect.bottom, plotClipRect.top);

    const interactionScales = computeInteractionScalesGridCssPx(gridArea, {
      xDomain: { min: visibleXDomain.min, max: visibleXDomain.max },
      yDomain: yBaseDomain,
    });
    lastInteractionScales = interactionScales;

    // Story 5.17: during update transitions, render animated series snapshots.
    const seriesForRender =
      updateTransition && updateP < 1
        ? interpolateSeriesForUpdate(updateTransition.from.series, updateTransition.to.series, updateP, updateInterpolationCaches)
        : renderSeries;

    // Keep `interactionX` in sync with real pointer movement (domain units).
    if (
      pointerState.source === 'mouse' &&
      pointerState.hasPointer &&
      pointerState.isInGrid &&
      interactionScales
    ) {
      const xDomain = interactionScales.xScale.invert(pointerState.gridX);
      setInteractionXInternal(Number.isFinite(xDomain) ? xDomain : null, 'mouse');
    }

    // Compute the effective interaction state:
    // - mouse: use the latest pointer event payload
    // - sync: derive a synthetic pointer position from `interactionX` (x only; y is arbitrary)
    let effectivePointer: PointerState = pointerState;
    if (pointerState.source === 'sync') {
      if (interactionX === null || !interactionScales) {
        effectivePointer = { ...pointerState, hasPointer: false, isInGrid: false };
      } else {
        const gridX = interactionScales.xScale.scale(interactionX);
        const gridY = interactionScales.plotHeightCss * 0.5;
        const isInGrid =
          Number.isFinite(gridX) &&
          Number.isFinite(gridY) &&
          gridX >= 0 &&
          gridX <= interactionScales.plotWidthCss &&
          gridY >= 0 &&
          gridY <= interactionScales.plotHeightCss;

        effectivePointer = {
          source: 'sync',
          gridX: Number.isFinite(gridX) ? gridX : 0,
          gridY: Number.isFinite(gridY) ? gridY : 0,
          // Crosshair/tooltip expect CANVAS-LOCAL CSS px.
          x: gridArea.left + (Number.isFinite(gridX) ? gridX : 0),
          y: gridArea.top + (Number.isFinite(gridY) ? gridY : 0),
          isInGrid,
          hasPointer: isInGrid,
        };
      }
    }

    gridRenderer.prepare(gridArea, { color: currentOptions.theme.gridLineColor });
    if (hasCartesianSeries) {
      xAxisRenderer.prepare(
        currentOptions.xAxis,
        xScale,
        'x',
        gridArea,
        currentOptions.theme.axisLineColor,
        currentOptions.theme.axisTickColor
      );
      yAxisRenderer.prepare(
        currentOptions.yAxis,
        yScale,
        'y',
        gridArea,
        currentOptions.theme.axisLineColor,
        currentOptions.theme.axisTickColor
      );
    }

    // Crosshair prepare uses canvas-local CSS px (EventManager payload x/y) and current gridArea.
    if (effectivePointer.hasPointer && effectivePointer.isInGrid) {
      const crosshairOptions: CrosshairRenderOptions = {
        showX: true,
        // Sync has no meaningful y, so avoid horizontal line.
        showY: effectivePointer.source !== 'sync',
        color: withAlpha(currentOptions.theme.axisLineColor, 0.6),
        lineWidth: DEFAULT_CROSSHAIR_LINE_WIDTH_CSS_PX,
      };
      crosshairRenderer.prepare(effectivePointer.x, effectivePointer.y, gridArea, crosshairOptions);
      crosshairRenderer.setVisible(true);
    } else {
      crosshairRenderer.setVisible(false);
    }

    // Highlight: on hover, find nearest point and draw a ring highlight clipped to plot rect.
    if (effectivePointer.source === 'mouse' && effectivePointer.hasPointer && effectivePointer.isInGrid) {
      if (interactionScales) {
        const match = findNearestPoint(
          seriesForRender,
          effectivePointer.gridX,
          effectivePointer.gridY,
          interactionScales.xScale,
          interactionScales.yScale
        );

        if (match) {
          const { x, y } = getPointXY(match.point);
          const xGridCss = interactionScales.xScale.scale(x);
          const yGridCss = interactionScales.yScale.scale(y);

          if (Number.isFinite(xGridCss) && Number.isFinite(yGridCss)) {
            const dpr = window.devicePixelRatio || 1;
            const centerCssX = gridArea.left + xGridCss;
            const centerCssY = gridArea.top + yGridCss;

            const plotScissor = computePlotScissorDevicePx(gridArea);
            const point: HighlightPoint = {
              centerDeviceX: centerCssX * dpr,
              centerDeviceY: centerCssY * dpr,
              canvasWidth: gridArea.canvasWidth,
              canvasHeight: gridArea.canvasHeight,
              scissor: plotScissor,
            };

            const seriesColor = currentOptions.series[match.seriesIndex]?.color ?? '#888';
            highlightRenderer.prepare(point, seriesColor, DEFAULT_HIGHLIGHT_SIZE_CSS_PX);
            highlightRenderer.setVisible(true);
          } else {
            highlightRenderer.setVisible(false);
          }
        } else {
          highlightRenderer.setVisible(false);
        }
      } else {
        highlightRenderer.setVisible(false);
      }
    } else {
      highlightRenderer.setVisible(false);
    }

    // Tooltip: on hover, find matches and render tooltip near cursor.
    if (tooltip && effectivePointer.hasPointer && effectivePointer.isInGrid) {
      const canvas = gpuContext.canvas;

      if (interactionScales && canvas && currentOptions.tooltip?.show !== false) {
        const formatter = currentOptions.tooltip?.formatter;
        const trigger = currentOptions.tooltip?.trigger ?? 'item';

        const containerX = canvas.offsetLeft + effectivePointer.x;
        const containerY = canvas.offsetTop + effectivePointer.y;

        if (effectivePointer.source === 'sync') {
          // Sync semantics:
          // - Tooltip should be driven by x only (no y).
          // - In 'axis' mode, show one entry per series nearest in x.
          // - In 'item' mode, pick a deterministic single entry (first matching series).
          const matches = findPointsAtX(seriesForRender, effectivePointer.gridX, interactionScales.xScale);
          if (matches.length === 0) {
            tooltip.hide();
          } else if (trigger === 'axis') {
            const paramsArray = matches.map((m) => buildTooltipParams(m.seriesIndex, m.dataIndex, m.point));
            const content = formatter
              ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)(paramsArray)
              : formatTooltipAxis(paramsArray);
            if (content) tooltip.show(containerX, containerY, content);
            else tooltip.hide();
          } else {
            const m0 = matches[0];
            const params = buildTooltipParams(m0.seriesIndex, m0.dataIndex, m0.point);
            const content = formatter ? (formatter as (p: TooltipParams) => string)(params) : formatTooltipItem(params);
            if (content) tooltip.show(containerX, containerY, content);
            else tooltip.hide();
          }
        } else if (trigger === 'axis') {
          // Story 4.14: pie slice tooltip hit-testing (mouse only).
          // If the cursor is over a pie slice, prefer showing that slice tooltip.
          const pieMatch = (() => {
            const plotWidthCss = interactionScales.plotWidthCss;
            const plotHeightCss = interactionScales.plotHeightCss;
            const maxRadiusCss = 0.5 * Math.min(plotWidthCss, plotHeightCss);
            if (!(maxRadiusCss > 0)) return null;

            for (let i = currentOptions.series.length - 1; i >= 0; i--) {
              const s = seriesForRender[i];
              if (s.type !== 'pie') continue;
              const pieSeries = s as ResolvedPieSeriesConfig;
              const center = resolvePieCenterPlotCss(pieSeries.center, plotWidthCss, plotHeightCss);
              const radii = resolvePieRadiiCss(pieSeries.radius, maxRadiusCss);
              const m = findPieSlice(
                effectivePointer.gridX,
                effectivePointer.gridY,
                { seriesIndex: i, series: pieSeries },
                center,
                radii
              );
              if (m) return m;
            }
            return null;
          })();

          if (pieMatch) {
            const params: TooltipParams = {
              seriesName: pieMatch.slice.name,
              seriesIndex: pieMatch.seriesIndex,
              dataIndex: pieMatch.dataIndex,
              value: [0, pieMatch.slice.value],
              color: pieMatch.slice.color,
            };

            const content = formatter
              ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)([params])
              : formatTooltipItem(params);
            if (content) tooltip.show(containerX, containerY, content);
            else tooltip.hide();
          } else {
            const matches = findPointsAtX(seriesForRender, effectivePointer.gridX, interactionScales.xScale);
            if (matches.length === 0) {
              tooltip.hide();
            } else {
              const paramsArray = matches.map((m) => buildTooltipParams(m.seriesIndex, m.dataIndex, m.point));
              const content = formatter
                ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)(paramsArray)
                : formatTooltipAxis(paramsArray);
              if (content) tooltip.show(containerX, containerY, content);
              else tooltip.hide();
            }
          }
        } else {
          // Story 4.14: pie slice tooltip hit-testing (mouse only).
          // If the cursor is over a pie slice, prefer showing that slice tooltip.
          const pieMatch = (() => {
            const plotWidthCss = interactionScales.plotWidthCss;
            const plotHeightCss = interactionScales.plotHeightCss;
            const maxRadiusCss = 0.5 * Math.min(plotWidthCss, plotHeightCss);
            if (!(maxRadiusCss > 0)) return null;

            for (let i = currentOptions.series.length - 1; i >= 0; i--) {
              const s = seriesForRender[i];
              if (s.type !== 'pie') continue;
              const pieSeries = s as ResolvedPieSeriesConfig;
              const center = resolvePieCenterPlotCss(pieSeries.center, plotWidthCss, plotHeightCss);
              const radii = resolvePieRadiiCss(pieSeries.radius, maxRadiusCss);
              const m = findPieSlice(
                effectivePointer.gridX,
                effectivePointer.gridY,
                { seriesIndex: i, series: pieSeries },
                center,
                radii
              );
              if (m) return m;
            }
            return null;
          })();

          if (pieMatch) {
            const params: TooltipParams = {
              seriesName: pieMatch.slice.name,
              seriesIndex: pieMatch.seriesIndex,
              dataIndex: pieMatch.dataIndex,
              value: [0, pieMatch.slice.value],
              color: pieMatch.slice.color,
            };
            const content = formatter
              ? (formatter as (p: TooltipParams) => string)(params)
              : formatTooltipItem(params);
            if (content) tooltip.show(containerX, containerY, content);
            else tooltip.hide();
          } else {
            const match = findNearestPoint(
              seriesForRender,
              effectivePointer.gridX,
              effectivePointer.gridY,
              interactionScales.xScale,
              interactionScales.yScale
            );
            if (!match) {
              tooltip.hide();
            } else {
              const params = buildTooltipParams(match.seriesIndex, match.dataIndex, match.point);
              const content = formatter
                ? (formatter as (p: TooltipParams) => string)(params)
                : formatTooltipItem(params);
              if (content) tooltip.show(containerX, containerY, content);
              else tooltip.hide();
            }
          }
        }
      } else {
        tooltip.hide();
      }
    } else {
      tooltip?.hide();
    }

    const defaultBaseline = currentOptions.yAxis.min ?? yBaseDomain.min;
    const barSeriesConfigs: ResolvedBarSeriesConfig[] = [];

    const introP = introPhase === 'running' ? clamp01(introProgress01) : 1;

    for (let i = 0; i < seriesForRender.length; i++) {
      const s = seriesForRender[i];
      switch (s.type) {
        case 'area': {
          const baseline = s.baseline ?? defaultBaseline;
          areaRenderers[i].prepare(s, s.data, xScale, yScale, baseline);
          break;
        }
        case 'line': {
          // Always prepare the line stroke.
          // If we already appended into the DataStore this frame (fast-path), avoid a full re-upload.
          if (!appendedGpuThisFrame.has(i)) {
            dataStore.setSeries(i, s.data);
          }
          const buffer = dataStore.getSeriesBuffer(i);
          lineRenderers[i].prepare(s, buffer, xScale, yScale);

          // Track the GPU buffer kind for future append fast-path decisions.
          const zoomRange = zoomState?.getRange() ?? null;
          const isFullSpanZoom =
            zoomRange == null ||
            (Number.isFinite(zoomRange.start) &&
              Number.isFinite(zoomRange.end) &&
              zoomRange.start <= 0 &&
              zoomRange.end >= 100);
          if (isFullSpanZoom && s.sampling === 'none') {
            gpuSeriesKindByIndex[i] = 'fullRawLine';
          } else {
            gpuSeriesKindByIndex[i] = 'other';
          }

          // If `areaStyle` is provided on a line series, render a fill behind it.
          if (s.areaStyle) {
            const areaLike: ResolvedAreaSeriesConfig = {
              type: 'area',
              name: s.name,
              rawData: s.data,
              data: s.data,
              color: s.areaStyle.color,
              areaStyle: s.areaStyle,
              sampling: s.sampling,
              samplingThreshold: s.samplingThreshold,
            };

            areaRenderers[i].prepare(areaLike, areaLike.data, xScale, yScale, defaultBaseline);
          }

          break;
        }
        case 'bar': {
          barSeriesConfigs.push(s);
          break;
        }
        case 'scatter': {
          // Scatter renderer sets/resets its own scissor. Animate intro via alpha fade.
          const animated = introP < 1 ? ({ ...s, color: withAlpha(s.color, introP) } as const) : s;
          scatterRenderers[i].prepare(animated, s.data, xScale, yScale, gridArea);
          break;
        }
        case 'pie': {
          // Pie renderer sets/resets its own scissor. Animate intro via radius scale (CSS px).
          if (introP < 1) {
            const canvas = gpuContext.canvas;
            const plotWidthCss = interactionScales?.plotWidthCss ?? (canvas ? getPlotSizeCssPx(canvas, gridArea)?.plotWidthCss : null);
            const plotHeightCss =
              interactionScales?.plotHeightCss ?? (canvas ? getPlotSizeCssPx(canvas, gridArea)?.plotHeightCss : null);
            const maxRadiusCss =
              typeof plotWidthCss === 'number' && typeof plotHeightCss === 'number'
                ? 0.5 * Math.min(plotWidthCss, plotHeightCss)
                : 0;

            if (maxRadiusCss > 0) {
              const radiiCss = resolvePieRadiiCss(s.radius, maxRadiusCss);
              const inner = Math.max(0, radiiCss.inner) * introP;
              const outer = Math.max(inner, radiiCss.outer) * introP;
              const animated: ResolvedPieSeriesConfig = { ...s, radius: [inner, outer] as const };
              pieRenderers[i].prepare(animated, gridArea);
              break;
            }
          }
          pieRenderers[i].prepare(s, gridArea);
          break;
        }
        case 'candlestick': {
          // Candlestick series are not yet implemented; skip rendering.
          break;
        }
        default:
          assertUnreachable(s);
      }
    }

    // Bars are prepared once and rendered via a single instanced draw call.
    const yScaleForBars = introP < 1 ? createAnimatedBarYScale(yScale, plotClipRect, barSeriesConfigs, introP) : yScale;
    barRenderer.prepare(barSeriesConfigs, dataStore, xScale, yScaleForBars, gridArea);

    const textureView = gpuContext.canvasContext.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder({ label: 'renderCoordinator/commandEncoder' });
    const clearValue = parseCssColorToGPUColor(currentOptions.theme.backgroundColor, { r: 0, g: 0, b: 0, a: 1 });

    const pass = encoder.beginRenderPass({
      label: 'renderCoordinator/renderPass',
      colorAttachments: [
        {
          view: textureView,
          clearValue,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    // Render order:
    // - grid first (background)
    // - pies early (non-cartesian, visible behind cartesian series)
    // - area fills next (so they don't cover strokes/axes)
    // - bars next (fills)
    // - scatter next (points on top of fills, below strokes/overlays)
    // - line strokes next
    // - highlight next (on top of strokes)
    // - axes last (on top)
    gridRenderer.render(pass);

    for (let i = 0; i < seriesForRender.length; i++) {
      if (seriesForRender[i].type === 'pie') {
        pieRenderers[i].render(pass);
      }
    }

    for (let i = 0; i < seriesForRender.length; i++) {
      if (shouldRenderArea(seriesForRender[i])) {
        // Line/area intro reveal: left-to-right plot scissor.
        if (introP < 1) {
          const w = clampInt(Math.floor(plotScissor.w * introP), 0, plotScissor.w);
          if (w > 0 && plotScissor.h > 0) {
            pass.setScissorRect(plotScissor.x, plotScissor.y, w, plotScissor.h);
            areaRenderers[i].render(pass);
            pass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
          }
        } else {
          areaRenderers[i].render(pass);
        }
      }
    }
    barRenderer.render(pass);
    for (let i = 0; i < seriesForRender.length; i++) {
      if (seriesForRender[i].type === 'scatter') {
        scatterRenderers[i].render(pass);
      }
    }
    for (let i = 0; i < seriesForRender.length; i++) {
      if (seriesForRender[i].type === 'line') {
        // Line intro reveal: left-to-right plot scissor.
        if (introP < 1) {
          const w = clampInt(Math.floor(plotScissor.w * introP), 0, plotScissor.w);
          if (w > 0 && plotScissor.h > 0) {
            pass.setScissorRect(plotScissor.x, plotScissor.y, w, plotScissor.h);
            lineRenderers[i].render(pass);
            pass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
          }
        } else {
          lineRenderers[i].render(pass);
        }
      }
    }

    highlightRenderer.render(pass);
    if (hasCartesianSeries) {
      xAxisRenderer.render(pass);
      yAxisRenderer.render(pass);
    }
    crosshairRenderer.render(pass);

    pass.end();
    device.queue.submit([encoder.finish()]);

    hasRenderedOnce = true;

    if (overlay && overlayContainer) {
      const canvas = gpuContext.canvas;
      // IMPORTANT: overlay positioning must be done in *CSS pixels* and in the overlayContainer's
      // coordinate space (its padding box). Using   `canvas.width / dpr` + `getBoundingClientRect()`
      // deltas can drift under CSS scaling/zoom and misalign with container padding/border.
      const canvasCssWidth = canvas.clientWidth;
      const canvasCssHeight = canvas.clientHeight;
      if (canvasCssWidth <= 0 || canvasCssHeight <= 0) return;

      // Since the overlay is absolutely positioned relative to the canvas container,
      // `offsetLeft/offsetTop` match that coordinate space.
      const offsetX = canvas.offsetLeft;
      const offsetY = canvas.offsetTop;

      const plotLeftCss = clipXToCanvasCssPx(plotClipRect.left, canvasCssWidth);
      const plotRightCss = clipXToCanvasCssPx(plotClipRect.right, canvasCssWidth);
      const plotTopCss = clipYToCanvasCssPx(plotClipRect.top, canvasCssHeight);
      const plotBottomCss = clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeight);

      overlay.clear();
      if (!hasCartesianSeries) return;

      // Mirror tick generation logic from `createAxisRenderer` exactly (tick count and domain fallback).
      const xTickCount = DEFAULT_TICK_COUNT;
      const xTickLengthCssPx = currentOptions.xAxis.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
      const xDomainMin = currentOptions.xAxis.min ?? xScale.invert(plotClipRect.left);
      const xDomainMax = currentOptions.xAxis.max ?? xScale.invert(plotClipRect.right);
      const xTickStep = xTickCount === 1 ? 0 : (xDomainMax - xDomainMin) / (xTickCount - 1);
      const xFormatter = createTickFormatter(xTickStep);
      const xLabelY = plotBottomCss + xTickLengthCssPx + LABEL_PADDING_CSS_PX + currentOptions.theme.fontSize * 0.5;

      for (let i = 0; i < xTickCount; i++) {
        const t = xTickCount === 1 ? 0.5 : i / (xTickCount - 1);
        const v = xDomainMin + t * (xDomainMax - xDomainMin);
        const xClip = xScale.scale(v);
        const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);

        const anchor: TextOverlayAnchor = i === 0 ? 'start' : i === xTickCount - 1 ? 'end' : 'middle';
        const label = formatTickValue(xFormatter, v);
        if (label == null) continue;
        const span = overlay.addLabel(label, offsetX + xCss, offsetY + xLabelY, {
          fontSize: currentOptions.theme.fontSize,
          color: currentOptions.theme.textColor,
          anchor,
        });
        span.dir = 'auto';
        span.style.fontFamily = currentOptions.theme.fontFamily;
      }

      const yTickCount = DEFAULT_TICK_COUNT;
      const yTickLengthCssPx = currentOptions.yAxis.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
      const yDomainMin = currentOptions.yAxis.min ?? yScale.invert(plotClipRect.bottom);
      const yDomainMax = currentOptions.yAxis.max ?? yScale.invert(plotClipRect.top);
      const yTickStep = yTickCount === 1 ? 0 : (yDomainMax - yDomainMin) / (yTickCount - 1);
      const yFormatter = createTickFormatter(yTickStep);
      const yLabelX = plotLeftCss - yTickLengthCssPx - LABEL_PADDING_CSS_PX;
      const ySpans: HTMLSpanElement[] = [];

      for (let i = 0; i < yTickCount; i++) {
        const t = yTickCount === 1 ? 0.5 : i / (yTickCount - 1);
        const v = yDomainMin + t * (yDomainMax - yDomainMin);
        const yClip = yScale.scale(v);
        const yCss = clipYToCanvasCssPx(yClip, canvasCssHeight);

        const label = formatTickValue(yFormatter, v);
        if (label == null) continue;
        const span = overlay.addLabel(label, offsetX + yLabelX, offsetY + yCss, {
          fontSize: currentOptions.theme.fontSize,
          color: currentOptions.theme.textColor,
          anchor: 'end',
        });
        span.dir = 'auto';
        span.style.fontFamily = currentOptions.theme.fontFamily;
        ySpans.push(span);
      }

      const axisNameFontSize = Math.max(
        currentOptions.theme.fontSize + 1,
        Math.round(currentOptions.theme.fontSize * 1.15)
      );

      const xAxisName = currentOptions.xAxis.name?.trim() ?? '';
      if (xAxisName.length > 0) {
        const xCenter = (plotLeftCss + plotRightCss) / 2;
        const xTitleY =
          xLabelY + currentOptions.theme.fontSize * 0.5 + LABEL_PADDING_CSS_PX + axisNameFontSize * 0.5;
        const span = overlay.addLabel(xAxisName, offsetX + xCenter, offsetY + xTitleY, {
          fontSize: axisNameFontSize,
          color: currentOptions.theme.textColor,
          anchor: 'middle',
        });
        span.dir = 'auto';
        span.style.fontFamily = currentOptions.theme.fontFamily;
        span.style.fontWeight = '600';
      }

      const yAxisName = currentOptions.yAxis.name?.trim() ?? '';
      if (yAxisName.length > 0) {
        const maxTickLabelWidth =
          ySpans.length === 0
            ? 0
            : ySpans.reduce((max, s) => Math.max(max, s.getBoundingClientRect().width), 0);

        const yCenter = (plotTopCss + plotBottomCss) / 2;
        const yTickLabelLeft = yLabelX - maxTickLabelWidth;
        const yTitleX = yTickLabelLeft - LABEL_PADDING_CSS_PX - axisNameFontSize * 0.5;

        const span = overlay.addLabel(yAxisName, offsetX + yTitleX, offsetY + yCenter, {
          fontSize: axisNameFontSize,
          color: currentOptions.theme.textColor,
          anchor: 'middle',
          rotation: -90,
        });
        span.dir = 'auto';
        span.style.fontFamily = currentOptions.theme.fontFamily;
        span.style.fontWeight = '600';
      }
    }
  };

  const dispose: RenderCoordinator['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    // Story 5.16: stop intro animation and avoid further render requests.
    try {
      if (introAnimId) introAnimController.cancel(introAnimId);
      introAnimController.cancelAll();
    } catch {
      // best-effort
    }
    introAnimId = null;
    introPhase = 'done';
    introProgress01 = 1;

    // Story 5.17: stop update animation and avoid further render requests.
    try {
      if (updateAnimId) updateAnimController.cancel(updateAnimId);
      updateAnimController.cancelAll();
    } catch {
      // best-effort
    }
    updateAnimId = null;
    updateProgress01 = 1;
    updateTransition = null;

    cancelScheduledFlush();
    cancelZoomResampleDebounce();
    zoomResampleDue = false;

    pendingAppendByIndex.clear();

    insideZoom?.dispose();
    insideZoom = null;
    unsubscribeZoom?.();
    unsubscribeZoom = null;
    zoomState = null;
    lastOptionsZoomRange = null;
    zoomRangeListeners.clear();

    eventManager.dispose();
    crosshairRenderer.dispose();
    highlightRenderer.dispose();

    for (let i = 0; i < areaRenderers.length; i++) {
      areaRenderers[i].dispose();
    }
    areaRenderers.length = 0;

    for (let i = 0; i < lineRenderers.length; i++) {
      lineRenderers[i].dispose();
    }
    lineRenderers.length = 0;

    for (let i = 0; i < scatterRenderers.length; i++) {
      scatterRenderers[i].dispose();
    }
    scatterRenderers.length = 0;

    for (let i = 0; i < pieRenderers.length; i++) {
      pieRenderers[i].dispose();
    }
    pieRenderers.length = 0;

    barRenderer.dispose();

    gridRenderer.dispose();
    xAxisRenderer.dispose();
    yAxisRenderer.dispose();

    dataStore.dispose();

    // Dispose tooltip/legend before the text overlay (all touch container positioning).
    tooltip?.dispose();
    tooltip = null;
    legend?.dispose();
    overlay?.dispose();
  };

  const getInteractionX: RenderCoordinator['getInteractionX'] = () => interactionX;

  const setInteractionX: RenderCoordinator['setInteractionX'] = (x, source) => {
    assertNotDisposed();
    const normalized = x !== null && Number.isFinite(x) ? x : null;

    // External interaction should not depend on y, so we treat it as “sync” mode.
    pointerState = { ...pointerState, source: normalized === null ? 'mouse' : 'sync' };

    setInteractionXInternal(normalized, source);

    if (normalized === null && pointerState.hasPointer === false) {
      crosshairRenderer.setVisible(false);
      highlightRenderer.setVisible(false);
      tooltip?.hide();
    }
    requestRender();
  };

  const onInteractionXChange: RenderCoordinator['onInteractionXChange'] = (callback) => {
    assertNotDisposed();
    interactionXListeners.add(callback);
    return () => {
      interactionXListeners.delete(callback);
    };
  };

  const getZoomRange: RenderCoordinator['getZoomRange'] = () => {
    return zoomState?.getRange() ?? null;
  };

  const setZoomRange: RenderCoordinator['setZoomRange'] = (start, end) => {
    assertNotDisposed();
    if (!zoomState) return;
    zoomState.setRange(start, end);
    // onChange will requestRender + emit.
  };

  const onZoomRangeChange: RenderCoordinator['onZoomRangeChange'] = (cb) => {
    assertNotDisposed();
    zoomRangeListeners.add(cb);
    return () => {
      zoomRangeListeners.delete(cb);
    };
  };

  return {
    setOptions,
    appendData,
    getInteractionX,
    setInteractionX,
    onInteractionXChange,
    getZoomRange,
    setZoomRange,
    onZoomRangeChange,
    render,
    dispose,
  };
}

