import type {
  ResolvedAreaSeriesConfig,
  ResolvedBarSeriesConfig,
  ResolvedCandlestickSeriesConfig,
  ResolvedChartGPUOptions,
  ResolvedPieSeriesConfig,
} from '../config/OptionResolver';
import type {
  AnimationConfig,
  AnnotationConfig,
  AnnotationLabelData,
  AxisLabel,
  DataPoint,
  DataPointTuple,
  LegendItem,
  PointerEventData,
  OHLCDataPoint,
  OHLCDataPointTuple,
  PieCenter,
  PieRadius,
  TooltipData,
} from '../config/types';
import type { SupportedCanvas } from './GPUContext';
import { isHTMLCanvasElement as isHTMLCanvasElementGPU } from './GPUContext';
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
import { createScatterDensityRenderer } from '../renderers/createScatterDensityRenderer';
import { createPieRenderer } from '../renderers/createPieRenderer';
import { createCandlestickRenderer } from '../renderers/createCandlestickRenderer';
import { createCrosshairRenderer } from '../renderers/createCrosshairRenderer';
import type { CrosshairRenderOptions } from '../renderers/createCrosshairRenderer';
import { createHighlightRenderer } from '../renderers/createHighlightRenderer';
import type { HighlightPoint } from '../renderers/createHighlightRenderer';
import { createRenderPipeline } from '../renderers/rendererUtils';
import { createReferenceLineRenderer } from '../renderers/createReferenceLineRenderer';
import type { ReferenceLineInstance } from '../renderers/createReferenceLineRenderer';
import { createAnnotationMarkerRenderer } from '../renderers/createAnnotationMarkerRenderer';
import type { AnnotationMarkerInstance } from '../renderers/createAnnotationMarkerRenderer';
import { createEventManager } from '../interaction/createEventManager';
import type { ChartGPUEventPayload } from '../interaction/createEventManager';
import { createInsideZoom } from '../interaction/createInsideZoom';
import { createZoomState } from '../interaction/createZoomState';
import type { ZoomRange, ZoomState } from '../interaction/createZoomState';
import { findNearestPoint } from '../interaction/findNearestPoint';
import type { NearestPointMatch } from '../interaction/findNearestPoint';
import { findPointsAtX } from '../interaction/findPointsAtX';
import { computeCandlestickBodyWidthRange, findCandlestick } from '../interaction/findCandlestick';
import type { CandlestickMatch } from '../interaction/findCandlestick';
import { findPieSlice } from '../interaction/findPieSlice';
import type { PieSliceMatch } from '../interaction/findPieSlice';
import { createLinearScale } from '../utils/scales';
import type { LinearScale } from '../utils/scales';
import { parseCssColorToGPUColor, parseCssColorToRgba01 } from '../utils/colors';
import { createTextOverlay } from '../components/createTextOverlay';
import type { TextOverlay, TextOverlayAnchor } from '../components/createTextOverlay';
import { getAxisTitleFontSize, styleAxisLabelSpan } from '../utils/axisLabelStyling';
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
  readonly canvas: SupportedCanvas | null;
  readonly canvasContext: GPUCanvasContext | null;
  readonly preferredFormat: GPUTextureFormat | null;
  readonly initialized: boolean;
  readonly devicePixelRatio?: number;
}

/** Type guard to check if canvas is HTMLCanvasElement (has DOM-specific properties). */
const isHTMLCanvasElement = isHTMLCanvasElementGPU;

/** Gets canvas CSS width - clientWidth for HTMLCanvasElement, width/DPR for OffscreenCanvas. */
function getCanvasCssWidth(canvas: SupportedCanvas | null, devicePixelRatio: number = 1): number {
  if (!canvas) {
    return 0;
  }
  if (isHTMLCanvasElement(canvas)) {
    return canvas.clientWidth;
  }
  // OffscreenCanvas: width property is in device pixels. Convert to CSS pixels by dividing by DPR.
  return canvas.width / devicePixelRatio;
}

/** Gets canvas CSS height - clientHeight for HTMLCanvasElement, height/DPR for OffscreenCanvas. */
function getCanvasCssHeight(canvas: SupportedCanvas | null, devicePixelRatio: number = 1): number {
  if (!canvas) {
    return 0;
  }
  if (isHTMLCanvasElement(canvas)) {
    return canvas.clientHeight;
  }
  // OffscreenCanvas: height property is in device pixels. Convert to CSS pixels by dividing by DPR.
  return canvas.height / devicePixelRatio;
}

/**
 * Gets canvas CSS size derived strictly from device-pixel dimensions and DPR.
 *
 * This is intentionally different from `getCanvasCssWidth/Height(...)`:
 * - HTMLCanvasElement: `clientWidth/clientHeight` reflect DOM layout and can diverge (rounding, zoom, async resize)
 *   from the WebGPU render target size (`canvas.width/height` in device pixels).
 * - For GPU overlays that round-trip CSS↔device pixels in-shader, we must derive CSS size from
 *   `canvas.width/height` + DPR to keep transforms consistent with the render target.
 *
 * NOTE: Use this for GPU overlay coordinate conversion only (reference lines, markers).
 * Keep DOM overlays (labels/tooltips) using `clientWidth/clientHeight` for layout correctness.
 */
function getCanvasCssSizeFromDevicePixels(
  canvas: SupportedCanvas | null,
  devicePixelRatio: number
): Readonly<{ width: number; height: number }> {
  if (!canvas) return { width: 0, height: 0 };
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // Both HTMLCanvasElement and OffscreenCanvas expose `.width/.height` in device pixels.
  return { width: canvas.width / dpr, height: canvas.height / dpr };
}

export interface RenderCoordinator {
  setOptions(resolvedOptions: ResolvedChartGPUOptions): void;
  /**
   * Appends new points to a cartesian series’ runtime data without requiring a full `setOptions(...)`
   * resolver pass.
   *
   * Appends are coalesced and flushed once per render frame.
   */
  appendData(seriesIndex: number, newPoints: ReadonlyArray<DataPoint> | ReadonlyArray<OHLCDataPoint>): void;
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
  /**
   * Accepts a pointer event with pre-computed grid coordinates for worker thread event forwarding.
   * Only available when domOverlays is false.
   */
  handlePointerEvent(event: PointerEventData): void;
  render(): void;
  dispose(): void;
}

export type RenderCoordinatorCallbacks = Readonly<{
  /**
   * Optional hook for render-on-demand systems (like `ChartGPU`) to re-render when
   * interaction state changes (e.g. crosshair on pointer move).
   */
  readonly onRequestRender?: () => void;
  /**
   * When false, DOM overlays (tooltip, legend, text overlay, event manager) are disabled.
   * Instead, callbacks are used to emit data for external rendering.
   * Default: true (DOM overlays enabled).
   */
  readonly domOverlays?: boolean;
  /**
   * Called when tooltip data changes (only when domOverlays is false).
   * Receives tooltip data including content, params array, and position, or null when hidden.
   */
  readonly onTooltipUpdate?: (data: TooltipData | null) => void;
  /**
   * Called when legend items change (only when domOverlays is false).
   */
  readonly onLegendUpdate?: (items: ReadonlyArray<LegendItem>) => void;
  /**
   * Called when axis labels change (only when domOverlays is false).
   */
  readonly onAxisLabelsUpdate?: (xLabels: ReadonlyArray<AxisLabel>, yLabels: ReadonlyArray<AxisLabel>) => void;
  /**
   * Called when annotation labels change (only when domOverlays is false).
   *
   * Payload coordinates are canvas-local CSS pixels.
   */
  readonly onAnnotationsUpdate?: (labels: ReadonlyArray<AnnotationLabelData>) => void;
  /**
   * Called when hover state changes (only when domOverlays is false).
   */
  readonly onHoverChange?: (payload: ChartGPUEventPayload | null) => void;
  /**
   * Called when crosshair moves (only when domOverlays is false).
   * Receives canvas-local CSS pixel x coordinate, or null when crosshair is hidden.
   */
  readonly onCrosshairMove?: (x: number | null) => void;
  /**
   * Called when user taps/clicks (only when domOverlays is false).
   * Includes hit test result with seriesIndex, dataIndex, and value.
   * Main thread is responsible for tap detection; worker thread performs hit testing.
   */
  readonly onClickData?: (payload: {
    readonly x: number;
    readonly y: number;
    readonly gridX: number;
    readonly gridY: number;
    readonly isInGrid: boolean;
    readonly nearest: NearestPointMatch | null;
    readonly pieSlice: PieSliceMatch | null;
    readonly candlestick: CandlestickMatch | null;
  }) => void;
  /**
   * Called when GPU device is lost.
   */
  readonly onDeviceLost?: (reason: string) => void;
}>;

type Bounds = Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_TICK_COUNT: number = 5;
const DEFAULT_TICK_LENGTH_CSS_PX: number = 6;
const LABEL_PADDING_CSS_PX = 4;
const DEFAULT_CROSSHAIR_LINE_WIDTH_CSS_PX = 1;
const DEFAULT_HIGHLIGHT_SIZE_CSS_PX = 4;

// Story 6: time-axis label tiers + adaptive tick count (x-axis only).
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Approximate month/year thresholds (requirements are ms-range based, not calendar-aware).
const MS_PER_MONTH_APPROX = 30 * MS_PER_DAY;
const MS_PER_YEAR_APPROX = 365 * MS_PER_DAY;

const MAX_TIME_X_TICK_COUNT = 9;
const MIN_TIME_X_TICK_COUNT = 1;
const MIN_X_LABEL_GAP_CSS_PX = 6;

const finiteOrNull = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const finiteOrUndefined = (v: number | undefined): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

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

const extendBoundsWithOHLCDataPoints = (bounds: Bounds | null, points: ReadonlyArray<OHLCDataPoint>): Bounds | null => {
  if (points.length === 0) return bounds;

  let xMin = bounds?.xMin ?? Number.POSITIVE_INFINITY;
  let xMax = bounds?.xMax ?? Number.NEGATIVE_INFINITY;
  let yMin = bounds?.yMin ?? Number.POSITIVE_INFINITY;
  let yMax = bounds?.yMax ?? Number.NEGATIVE_INFINITY;

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
    const low = isTupleOHLCDataPoint(p) ? p[3] : p.low;
    const high = isTupleOHLCDataPoint(p) ? p[4] : p.high;

    if (!Number.isFinite(timestamp) || !Number.isFinite(low) || !Number.isFinite(high)) continue;
    if (timestamp < xMin) xMin = timestamp;
    if (timestamp > xMax) xMax = timestamp;
    if (low < yMin) yMin = low;
    if (high > yMax) yMax = high;
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return bounds;
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

  // GridArea uses:
  // - Margins (left, right, top, bottom) in CSS pixels
  // - Canvas dimensions (canvasWidth, canvasHeight) in DEVICE pixels
  // - devicePixelRatio for CSS-to-device conversion (worker-compatible)
  // This allows renderers to multiply margins by DPR and subtract from canvas dimensions

  const dpr = gpuContext.devicePixelRatio ?? 1;
  const devicePixelRatio = (Number.isFinite(dpr) && dpr > 0) ? dpr : 1;

  // Validate and sanitize canvas dimensions (device pixels)
  // Canvas dimensions should be set by GPUContext initialization/resize, but guard against edge cases:
  // - Race conditions during initialization
  // - Invalid dimensions from OffscreenCanvas in worker mode
  // - Canvas not yet sized (0 dimensions)
  const rawCanvasWidth = canvas.width;
  const rawCanvasHeight = canvas.height;
  
  if (!Number.isFinite(rawCanvasWidth) || !Number.isFinite(rawCanvasHeight)) {
    throw new Error(
      `RenderCoordinator: Invalid canvas dimensions: width=${rawCanvasWidth}, height=${rawCanvasHeight}. ` +
      `Canvas must be initialized with finite dimensions before rendering.`
    );
  }
  
  // Be resilient: charts may be mounted into 0-sized containers (e.g. display:none during init).
  // Renderers guard internally; clamping avoids hard crashes and allows future resize to recover.
  const canvasWidth = Math.max(1, Math.floor(rawCanvasWidth));
  const canvasHeight = Math.max(1, Math.floor(rawCanvasHeight));

  // Validate and sanitize grid margins (CSS pixels)
  // Grid margins come from resolved options and should be finite, but guard against edge cases
  const left = Number.isFinite(options.grid.left) ? options.grid.left : 0;
  const right = Number.isFinite(options.grid.right) ? options.grid.right : 0;
  const top = Number.isFinite(options.grid.top) ? options.grid.top : 0;
  const bottom = Number.isFinite(options.grid.bottom) ? options.grid.bottom : 0;

  // Ensure margins are non-negative (negative margins could cause rendering issues)
  const sanitizedLeft = Math.max(0, left);
  const sanitizedRight = Math.max(0, right);
  const sanitizedTop = Math.max(0, top);
  const sanitizedBottom = Math.max(0, bottom);

  return {
    left: sanitizedLeft,
    right: sanitizedRight,
    top: sanitizedTop,
    bottom: sanitizedBottom,
    canvasWidth,                      // Device pixels (clamped above)
    canvasHeight,                     // Device pixels (clamped above)
    devicePixelRatio,                 // Explicit DPR for worker compatibility (validated above)
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

/**
 * Estimates the maximum width of Y-axis tick labels in CSS pixels.
 * Used in worker mode where DOM measurement is not available.
 *
 * Uses a heuristic: ~0.6 * fontSize per character for typical numeric labels.
 * This is conservative and should prevent overlap in most cases.
 */
const estimateMaxYTickLabelWidth = (
  yLabels: ReadonlyArray<{ readonly text: string }>,
  fontSize: number
): number => {
  if (yLabels.length === 0) return 0;

  // Find the longest label text
  const maxChars = yLabels.reduce((max, label) => Math.max(max, label.text.length), 0);

  // Estimate width: ~0.6 * fontSize per character for typical monospace-ish numeric text
  // This is conservative to prevent overlap
  return Math.ceil(maxChars * fontSize * 0.6);
};

const computePlotClipRect = (
  gridArea: GridArea
): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } => {
  const { left, right, top, bottom, canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeft = left * devicePixelRatio;
  const plotRight = canvasWidth - right * devicePixelRatio;
  const plotTop = top * devicePixelRatio;
  const plotBottom = canvasHeight - bottom * devicePixelRatio;

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
  const { canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeftDevice = gridArea.left * devicePixelRatio;
  const plotRightDevice = canvasWidth - gridArea.right * devicePixelRatio;
  const plotTopDevice = gridArea.top * devicePixelRatio;
  const plotBottomDevice = canvasHeight - gridArea.bottom * devicePixelRatio;

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

const findVisibleRangeIndicesByX = (
  data: ReadonlyArray<DataPoint>,
  xMin: number,
  xMax: number
): { readonly start: number; readonly end: number } => {
  const n = data.length;
  if (n === 0) return { start: 0, end: 0 };
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return { start: 0, end: n };

  const isTuple = isTupleDataArray(data);
  const canBinarySearch = isMonotonicNonDecreasingFiniteX(data, isTuple);
  if (!canBinarySearch) {
    // Data is not monotonic by x; we can't represent the visible set as a contiguous index range.
    // Fall back to processing the full series for correctness.
    return { start: 0, end: n };
  }

  const start = isTuple
    ? lowerBoundXTuple(data as ReadonlyArray<TuplePoint>, xMin)
    : lowerBoundXObject(data as ReadonlyArray<ObjectPoint>, xMin);
  const end = isTuple
    ? upperBoundXTuple(data as ReadonlyArray<TuplePoint>, xMax)
    : upperBoundXObject(data as ReadonlyArray<ObjectPoint>, xMax);

  const s = clampInt(start, 0, n);
  const e = clampInt(end, 0, n);
  return e <= s ? { start: s, end: s } : { start: s, end: e };
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

const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, '0');

const MONTH_SHORT_EN: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const formatTimeTickValue = (timestampMs: number, visibleRangeMs: number): string | null => {
  if (!Number.isFinite(timestampMs)) return null;
  if (!Number.isFinite(visibleRangeMs) || visibleRangeMs < 0) visibleRangeMs = 0;

  const d = new Date(timestampMs);
  // Guard against out-of-range timestamps that produce an invalid Date.
  if (!Number.isFinite(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = d.getMonth() + 1; // 1-12
  const dd = d.getDate();
  const hh = d.getHours();
  const min = d.getMinutes();

  // Requirements (range in ms):
  // - < 1 day: HH:mm
  // - 1-7 days: MM/DD HH:mm
  // - 1-12 weeks (and up to ~3 months): MM/DD
  // - 3-12 months: MMM DD
  // - > 1 year: YYYY/MM
  if (visibleRangeMs < MS_PER_DAY) {
    return `${pad2(hh)}:${pad2(min)}`;
  }
  // Treat the 7-day boundary as inclusive for the “1–7 days” tier.
  if (visibleRangeMs <= 7 * MS_PER_DAY) {
    return `${pad2(mm)}/${pad2(dd)} ${pad2(hh)}:${pad2(min)}`;
  }
  // Keep short calendar dates until the visible range reaches ~3 months.
  // (This covers the 1–12 week requirement, plus the small 12w→3m gap.)
  if (visibleRangeMs < 3 * MS_PER_MONTH_APPROX) {
    return `${pad2(mm)}/${pad2(dd)}`;
  }
  if (visibleRangeMs <= MS_PER_YEAR_APPROX) {
    const mmm = MONTH_SHORT_EN[d.getMonth()] ?? pad2(mm);
    return `${mmm} ${pad2(dd)}`;
  }
  return `${yyyy}/${pad2(mm)}`;
};

const generateLinearTicks = (domainMin: number, domainMax: number, tickCount: number): number[] => {
  const count = Math.max(1, Math.floor(tickCount));
  const ticks: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    ticks[i] = domainMin + t * (domainMax - domainMin);
  }
  return ticks;
};

const computeAdaptiveTimeXAxisTicks = (params: {
  readonly axisMin: number | null;
  readonly axisMax: number | null;
  readonly xScale: LinearScale;
  readonly plotClipLeft: number;
  readonly plotClipRight: number;
  readonly canvasCssWidth: number;
  readonly visibleRangeMs: number;
  readonly measureCtx: CanvasRenderingContext2D | null;
  readonly measureCache?: Map<string, number>;
  readonly fontSize: number;
  readonly fontFamily: string;
}): { readonly tickCount: number; readonly tickValues: readonly number[] } => {
  const {
    axisMin,
    axisMax,
    xScale,
    plotClipLeft,
    plotClipRight,
    canvasCssWidth,
    visibleRangeMs,
    measureCtx,
    measureCache,
    fontSize,
    fontFamily,
  } = params;

  // Domain fallback matches `createAxisRenderer` (use explicit min/max when provided).
  const domainMin = finiteOrNull(axisMin) ?? xScale.invert(plotClipLeft);
  const domainMax = finiteOrNull(axisMax) ?? xScale.invert(plotClipRight);

  if (!measureCtx || canvasCssWidth <= 0) {
    return { tickCount: DEFAULT_TICK_COUNT, tickValues: generateLinearTicks(domainMin, domainMax, DEFAULT_TICK_COUNT) };
  }

  // Ensure the measurement font matches the overlay labels.
  measureCtx.font = `${fontSize}px ${fontFamily}`;
  if (measureCache && measureCache.size > 2000) measureCache.clear();

  // Pre-construct the font part of the cache key to avoid repeated concatenation.
  const cacheKeyPrefix = measureCache ? `${fontSize}px ${fontFamily}@@` : null;

  for (let tickCount = MAX_TIME_X_TICK_COUNT; tickCount >= MIN_TIME_X_TICK_COUNT; tickCount--) {
    const tickValues = generateLinearTicks(domainMin, domainMax, tickCount);

    // Compute label extents in *canvas-local CSS px* and ensure adjacent labels don't overlap.
    let prevRight = Number.NEGATIVE_INFINITY;
    let ok = true;

    for (let i = 0; i < tickValues.length; i++) {
      const v = tickValues[i]!;
      const label = formatTimeTickValue(v, visibleRangeMs);
      if (label == null) continue;

      const w = (() => {
        if (!cacheKeyPrefix) return measureCtx.measureText(label).width;
        const key = cacheKeyPrefix + label;
        const cached = measureCache!.get(key);
        if (cached != null) return cached;
        const measured = measureCtx.measureText(label).width;
        measureCache!.set(key, measured);
        return measured;
      })();
      const xClip = xScale.scale(v);
      const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);

      const anchor: TextOverlayAnchor =
        tickCount === 1 ? 'middle' : i === 0 ? 'start' : i === tickValues.length - 1 ? 'end' : 'middle';

      const left = anchor === 'start' ? xCss : anchor === 'end' ? xCss - w : xCss - w * 0.5;
      const right = anchor === 'start' ? xCss + w : anchor === 'end' ? xCss : xCss + w * 0.5;

      if (left < prevRight + MIN_X_LABEL_GAP_CSS_PX) {
        ok = false;
        break;
      }
      prevRight = right;
    }

    if (ok) {
      return { tickCount, tickValues };
    }
  }

  return { tickCount: MIN_TIME_X_TICK_COUNT, tickValues: generateLinearTicks(domainMin, domainMax, MIN_TIME_X_TICK_COUNT) };
};

const computeBaseXDomain = (
  options: ResolvedChartGPUOptions,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null
): { readonly min: number; readonly max: number } => {
  const bounds = computeGlobalBounds(options.series, runtimeRawBoundsByIndex);
  const baseMin = finiteOrUndefined(options.xAxis.min) ?? bounds.xMin;
  const baseMax = finiteOrUndefined(options.xAxis.max) ?? bounds.xMax;
  return normalizeDomain(baseMin, baseMax);
};

const computeBaseYDomain = (
  options: ResolvedChartGPUOptions,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null
): { readonly min: number; readonly max: number } => {
  const bounds = computeGlobalBounds(options.series, runtimeRawBoundsByIndex);
  const yMin = finiteOrUndefined(options.yAxis.min) ?? bounds.yMin;
  const yMax = finiteOrUndefined(options.yAxis.max) ?? bounds.yMax;
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

/**
 * Computes container-local CSS pixel anchor coordinates for a candlestick tooltip.
 *
 * The anchor is positioned near the candle body center for stable tooltip positioning
 * even when the cursor is at the edge of the candlestick.
 *
 * Coordinate transformations:
 * 1. Domain values (timestamp, open, close) from CandlestickMatch
 * 2. → xScale/yScale transform to grid-local CSS pixels
 * 3. → Add gridArea offset to get canvas-local CSS pixels
 * 4. → Add canvas offset to get container-local CSS pixels
 *
 * Returns null if any coordinate computation fails (non-finite values).
 */
const computeCandlestickTooltipAnchor = (
  match: { readonly point: OHLCDataPoint },
  xScale: LinearScale,
  yScale: LinearScale,
  gridArea: GridArea,
  canvas: HTMLCanvasElement | OffscreenCanvas
): Readonly<{ x: number; y: number }> | null => {
  const point = match.point;
  
  const timestamp = isTupleOHLCDataPoint(point) ? point[0] : point.timestamp;
  const open = isTupleOHLCDataPoint(point) ? point[1] : point.open;
  const close = isTupleOHLCDataPoint(point) ? point[2] : point.close;

  if (!Number.isFinite(timestamp) || !Number.isFinite(open) || !Number.isFinite(close)) {
    return null;
  }

  // Body center in domain space
  const bodyMidY = (open + close) / 2;

  // Transform to grid-local CSS pixels
  const xGridCss = xScale.scale(timestamp);
  const yGridCss = yScale.scale(bodyMidY);

  if (!Number.isFinite(xGridCss) || !Number.isFinite(yGridCss)) {
    return null;
  }

  // Convert to canvas-local CSS pixels
  const xCanvasCss = gridArea.left + xGridCss;
  const yCanvasCss = gridArea.top + yGridCss;

  // Convert to container-local CSS pixels
  // In worker mode (OffscreenCanvas), offsetLeft/offsetTop don't exist - return canvas-local coordinates
  const xContainerCss = isHTMLCanvasElement(canvas) ? canvas.offsetLeft + xCanvasCss : xCanvasCss;
  const yContainerCss = isHTMLCanvasElement(canvas) ? canvas.offsetTop + yCanvasCss : yCanvasCss;

  if (!Number.isFinite(xContainerCss) || !Number.isFinite(yContainerCss)) {
    return null;
  }

  return { x: xContainerCss, y: yContainerCss };
};

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

  // Listen for device loss and emit callback
  // Note: We don't call dispose() here to avoid double-cleanup if user calls dispose() in callback.
  // The coordinator is effectively non-functional after device loss until re-created.
  device.lost.then((info) => {
    callbacks?.onDeviceLost?.(info.message || info.reason || 'unknown');
  }).catch(() => {
    // Ignore errors in device.lost promise (can occur if device is destroyed before lost promise resolves)
  });

  const targetFormat = gpuContext.preferredFormat ?? DEFAULT_TARGET_FORMAT;
  
  // DOM-dependent features (overlays, legends) require HTMLCanvasElement and domOverlays !== false.
  // OffscreenCanvas is for rendering only.
  const domOverlaysEnabled = callbacks?.domOverlays !== false;
  const overlayContainer = domOverlaysEnabled && isHTMLCanvasElement(gpuContext.canvas) ? gpuContext.canvas.parentElement : null;
  const axisLabelOverlay: TextOverlay | null = overlayContainer ? createTextOverlay(overlayContainer) : null;
  // Dedicated overlay for annotations (do not reuse axis label overlay).
  const annotationOverlay: TextOverlay | null = overlayContainer ? createTextOverlay(overlayContainer) : null;
  const legend: Legend | null = overlayContainer ? createLegend(overlayContainer, 'right') : null;
  // Text measurement for axis labels. Only available in DOM contexts (not worker threads).
  const tickMeasureCtx: CanvasRenderingContext2D | null = (() => {
    if (typeof document === 'undefined') {
      // Worker thread: DOM not available.
      return null;
    }
    try {
      const c = document.createElement('canvas');
      return c.getContext('2d');
    } catch {
      return null;
    }
  })();
  const tickMeasureCache: Map<string, number> | null = tickMeasureCtx ? new Map() : null;

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

  // PERFORMANCE: Reusable arrays for annotation processing (avoid allocations per frame)
  const annotationLineBelow: ReferenceLineInstance[] = [];
  const annotationLineAbove: ReferenceLineInstance[] = [];
  const annotationMarkerBelow: AnnotationMarkerInstance[] = [];
  const annotationMarkerAbove: AnnotationMarkerInstance[] = [];

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

  // Cache for sampled data with buffer zones - enables fast slicing during pan without resampling.
  interface SampledDataCache {
    data: ReadonlyArray<DataPoint> | ReadonlyArray<OHLCDataPoint>;
    cachedRange: { min: number; max: number };
    timestamp: number;
  }
  let lastSampledData: Array<SampledDataCache | null> = [];

  // Unified flush scheduler (appends + zoom-aware resampling + optional GPU streaming updates).
  let flushScheduled = false;
  let flushRafId: number | null = null;
  let flushTimeoutId: number | null = null;

  // Zoom changes are debounced to avoid churn while wheel/drag is active.
  // When the debounce fires, we mark resampling "due" and schedule a unified flush.
  let zoomResampleDebounceTimer: number | null = null;
  let zoomResampleDue = false;

  // Coalesced streaming appends (flushed at the start of `render()`).
  const pendingAppendByIndex = new Map<number, Array<DataPoint | OHLCDataPoint>>();

  // Tracks what the DataStore currently represents for each series index.
  // Used to decide whether `appendSeries(...)` is a correct fast-path.
  type GpuSeriesKind = 'unknown' | 'fullRawLine' | 'other';
  let gpuSeriesKindByIndex: GpuSeriesKind[] = new Array(currentOptions.series.length).fill('unknown');
  const appendedGpuThisFrame = new Set<number>();

  // Tooltip is a DOM overlay element; enable by default unless explicitly disabled.
  let tooltip: Tooltip | null =
    overlayContainer && currentOptions.tooltip?.show !== false ? createTooltip(overlayContainer) : null;

  // Cache tooltip state to avoid unnecessary DOM updates
  let lastTooltipContent: string | null = null;
  let lastTooltipX: number | null = null;
  let lastTooltipY: number | null = null;

  // Helper functions for tooltip/legend/crosshair callbacks
  const showTooltipInternal = (x: number, y: number, content: string, params: TooltipParams | TooltipParams[]) => {
    tooltip?.show(x, y, content);
    if (!domOverlaysEnabled && callbacks?.onTooltipUpdate) {
      const paramsArray = Array.isArray(params) ? params : [params];
      callbacks.onTooltipUpdate({ content, params: paramsArray, x, y });
    }
  };

  const hideTooltipInternal = () => {
    tooltip?.hide();
    if (!domOverlaysEnabled && callbacks?.onTooltipUpdate) {
      callbacks.onTooltipUpdate(null);
    }
  };

  const hideTooltip = () => {
    lastTooltipContent = null;
    lastTooltipX = null;
    lastTooltipY = null;
    hideTooltipInternal();
  };

  const emitCrosshairCallback = (x: number | null) => {
    if (!domOverlaysEnabled && callbacks?.onCrosshairMove) {
      callbacks.onCrosshairMove(x);
    }
  };

  const emitHoverCallback = (payload: ChartGPUEventPayload | null) => {
    if (!domOverlaysEnabled && callbacks?.onHoverChange) {
      callbacks.onHoverChange(payload);
    }
  };

  const updateLegend = (series: ResolvedChartGPUOptions['series'], theme: ResolvedChartGPUOptions['theme']) => {
    legend?.update(series, theme);
    if (!domOverlaysEnabled && callbacks?.onLegendUpdate) {
      const items: LegendItem[] = series.map((s, idx) => ({
        name: s.name ?? '',
        color: s.color ?? '#888',
        seriesIndex: idx,
      }));
      callbacks.onLegendUpdate(items);
    }
  };

  updateLegend(currentOptions.series, currentOptions.theme);

  let dataStore = createDataStore(device);

  const gridRenderer = createGridRenderer(device, { targetFormat });
  const xAxisRenderer = createAxisRenderer(device, { targetFormat });
  const yAxisRenderer = createAxisRenderer(device, { targetFormat });
  const crosshairRenderer = createCrosshairRenderer(device, { targetFormat });
  crosshairRenderer.setVisible(false);
  const highlightRenderer = createHighlightRenderer(device, { targetFormat });
  highlightRenderer.setVisible(false);

  // MSAA for the *annotation overlay* (above-series) pass to reduce shimmer during zoom.
  // NOTE: In WebGPU, pipeline sampleCount must match the render pass attachment sampleCount.
  // To keep MSAA scoped, we render the main scene to an offscreen single-sample texture, then:
  // - MSAA overlay pass: blit main scene into an MSAA target + draw above-series annotations, resolve to swapchain
  // - Top overlay pass: draw crosshair/axes/highlight (single-sample) on top of the resolved swapchain
  const ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT = 4;

  const referenceLineRenderer = createReferenceLineRenderer(device, { targetFormat });
  const annotationMarkerRenderer = createAnnotationMarkerRenderer(device, { targetFormat });
  const referenceLineRendererMsaa = createReferenceLineRenderer(device, {
    targetFormat,
    sampleCount: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT,
  });
  const annotationMarkerRendererMsaa = createAnnotationMarkerRenderer(device, {
    targetFormat,
    sampleCount: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT,
  });

  // Offscreen main color + MSAA overlay targets (recreated on resize/DPR changes).
  let mainColorTexture: GPUTexture | null = null;
  let mainColorView: GPUTextureView | null = null;
  let overlayMsaaTexture: GPUTexture | null = null;
  let overlayMsaaView: GPUTextureView | null = null;
  let overlayTargetsWidth = 0;
  let overlayTargetsHeight = 0;
  let overlayTargetsFormat: GPUTextureFormat | null = null;

  const OVERLAY_BLIT_WGSL = `
struct VSOut { @builtin(position) pos: vec4f };

@vertex
fn vsMain(@builtin(vertex_index) i: u32) -> VSOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var o: VSOut;
  o.pos = vec4f(positions[i], 0.0, 1.0);
  return o;
}

// Using textureLoad (no filtering) for pixel-exact blit into the MSAA overlay pass.
@group(0) @binding(0) var srcTex: texture_2d<f32>;

@fragment
fn fsMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let xy = vec2<i32>(pos.xy);
  return textureLoad(srcTex, xy, 0);
}
`;

  const overlayBlitBindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } }],
  });

  const overlayBlitPipeline = createRenderPipeline(device, {
    label: 'renderCoordinator/overlayBlitPipeline',
    bindGroupLayouts: [overlayBlitBindGroupLayout],
    vertex: { code: OVERLAY_BLIT_WGSL, label: 'renderCoordinator/overlayBlit.wgsl' },
    fragment: { code: OVERLAY_BLIT_WGSL, label: 'renderCoordinator/overlayBlit.wgsl', formats: targetFormat },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT },
  });

  let overlayBlitBindGroup: GPUBindGroup | null = null;

  const destroyTexture = (tex: GPUTexture | null): void => {
    if (!tex) return;
    try {
      tex.destroy();
    } catch {
      // best-effort
    }
  };

  const ensureOverlayTargets = (canvasWidthDevicePx: number, canvasHeightDevicePx: number): void => {
    const w = Number.isFinite(canvasWidthDevicePx) ? Math.max(1, Math.floor(canvasWidthDevicePx)) : 1;
    const h = Number.isFinite(canvasHeightDevicePx) ? Math.max(1, Math.floor(canvasHeightDevicePx)) : 1;

    if (mainColorTexture && overlayMsaaTexture && overlayBlitBindGroup && overlayTargetsWidth === w && overlayTargetsHeight === h && overlayTargetsFormat === targetFormat) {
      return;
    }

    destroyTexture(mainColorTexture);
    destroyTexture(overlayMsaaTexture);

    mainColorTexture = device.createTexture({
      label: 'renderCoordinator/mainColorTexture',
      size: { width: w, height: h },
      format: targetFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    mainColorView = mainColorTexture.createView();

    overlayMsaaTexture = device.createTexture({
      label: 'renderCoordinator/annotationOverlayMsaaTexture',
      size: { width: w, height: h },
      sampleCount: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT,
      format: targetFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    overlayMsaaView = overlayMsaaTexture.createView();

    overlayBlitBindGroup = device.createBindGroup({
      label: 'renderCoordinator/overlayBlitBindGroup',
      layout: overlayBlitBindGroupLayout,
      entries: [{ binding: 0, resource: mainColorView }],
    });

    overlayTargetsWidth = w;
    overlayTargetsHeight = h;
    overlayTargetsFormat = targetFormat;
  };

  const initialGridArea = computeGridArea(gpuContext, currentOptions);
  
  // Event manager requires HTMLCanvasElement (DOM events) and domOverlays enabled.
  // OffscreenCanvas doesn't support interactive features.
  const eventManager = domOverlaysEnabled && isHTMLCanvasElement(gpuContext.canvas) 
    ? createEventManager(gpuContext.canvas, initialGridArea)
    : null;

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
      if (!s || s.type === 'pie') continue;
      didAppendAny = true;

      if (s.type === 'candlestick') {
        // Handle candlestick OHLC data.
        let raw = runtimeRawDataByIndex[seriesIndex] as OHLCDataPoint[] | null;
        if (!raw) {
          const seed = (s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>;
          raw = seed.length === 0 ? [] : seed.slice();
          runtimeRawDataByIndex[seriesIndex] = raw;
          runtimeRawBoundsByIndex[seriesIndex] = s.rawBounds ?? null;
        }

        const ohlcPoints = points as unknown as ReadonlyArray<OHLCDataPoint>;
        raw.push(...ohlcPoints);
        runtimeRawBoundsByIndex[seriesIndex] = extendBoundsWithOHLCDataPoints(
          runtimeRawBoundsByIndex[seriesIndex],
          ohlcPoints
        );
      } else {
        // Handle other cartesian series (line, area, bar, scatter).
        let raw = runtimeRawDataByIndex[seriesIndex] as DataPoint[] | null;
        if (!raw) {
          const seed = (s.rawData ?? s.data) as ReadonlyArray<DataPoint>;
          raw = seed.length === 0 ? [] : seed.slice();
          runtimeRawDataByIndex[seriesIndex] = raw;
          runtimeRawBoundsByIndex[seriesIndex] = s.rawBounds ?? computeRawBoundsFromData(raw);
        }

        const dataPoints = points as unknown as ReadonlyArray<DataPoint>;
        
        // Optional fast-path: if the GPU buffer currently represents the full, unsampled line series,
        // we can append just the new points to the existing GPU buffer (no full re-upload).
        if (
          s.type === 'line' &&
          s.sampling === 'none' &&
          isFullSpanZoomBefore &&
          gpuSeriesKindByIndex[seriesIndex] === 'fullRawLine'
        ) {
          try {
            dataStore.appendSeries(seriesIndex, dataPoints);
            appendedGpuThisFrame.add(seriesIndex);
          } catch {
            // If the DataStore has not been initialized for this index (or any other error occurs),
            // fall back to the normal full upload path later in render().
          }
        }

        raw.push(...dataPoints);
        runtimeRawBoundsByIndex[seriesIndex] = extendBoundsWithDataPoints(
          runtimeRawBoundsByIndex[seriesIndex],
          dataPoints
        );
      }

      // Invalidate cache for this series since data has changed
      lastSampledData[seriesIndex] = null;
    }

    pendingAppendByIndex.clear();
    if (!didAppendAny) return false;

    // Dataset-aware zoom span constraints depend on raw point density.
    // When streaming appends add points, recompute and apply constraints so wheel+slider remain consistent.
    if (zoomState) {
      const constraints = computeEffectiveZoomSpanConstraints();
      const withConstraints = zoomState as unknown as {
        setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
      };
      withConstraints.setSpanConstraints?.(constraints.minSpan, constraints.maxSpan);
    }

    // Auto-scroll is applied only on append (not on `setOptions`).
    if (canAutoScroll && zoomRangeBefore && prevVisibleXDomain) {
      const r = zoomRangeBefore;
      if (r.end >= 99.5) {
        const span = r.end - r.start;
        const anchored = zoomState! as unknown as {
          setRangeAnchored?: (start: number, end: number, anchor: 'start' | 'end' | 'center') => void;
        };
        // Keep end pinned when constraints clamp the span.
        if (anchored.setRangeAnchored) {
          anchored.setRangeAnchored(100 - span, 100, 'end');
        } else {
          zoomState!.setRange(100 - span, 100);
        }
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
    flushTimeoutId = (typeof self !== 'undefined' ? self : window).setTimeout(() => {
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

    zoomResampleDebounceTimer = (typeof self !== 'undefined' ? self : window).setTimeout(() => {
      zoomResampleDebounceTimer = null;
      if (disposed) return;
      zoomResampleDue = true;
      scheduleFlush();
    }, 100);
  };

  const getPlotSizeCssPx = (
    canvas: SupportedCanvas,
    gridArea: GridArea
  ): { readonly plotWidthCss: number; readonly plotHeightCss: number } | null => {
    let canvasWidthCss: number;
    let canvasHeightCss: number;

    if (isHTMLCanvasElement(canvas)) {
      // HTMLCanvasElement: use getBoundingClientRect() for actual CSS dimensions
      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return null;
      canvasWidthCss = rect.width;
      canvasHeightCss = rect.height;
    } else {
      // OffscreenCanvas: calculate CSS pixels from canvas dimensions divided by device pixel ratio
      const dpr = gpuContext.devicePixelRatio ?? 1.0;
      console.log('[getPlotSizeCssPx] OffscreenCanvas dimensions:', {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        dpr,
        calculatedCssWidth: canvas.width / dpr,
        calculatedCssHeight: canvas.height / dpr
      });
      canvasWidthCss = canvas.width / dpr;
      canvasHeightCss = canvas.height / dpr;
      if (!(canvasWidthCss > 0) || !(canvasHeightCss > 0)) return null;
    }

    const plotWidthCss = canvasWidthCss - gridArea.left - gridArea.right;
    const plotHeightCss = canvasHeightCss - gridArea.top - gridArea.bottom;
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
    // Support both HTMLCanvasElement and OffscreenCanvas for worker thread compatibility
    if (!canvas) return null;

    const plotSize = getPlotSizeCssPx(canvas, gridArea);
    if (!plotSize) return null;

    // IMPORTANT: grid-local CSS px ranges (0..plotWidth/Height), for interaction hit-testing.
    const xScale = createLinearScale().domain(domains.xDomain.min, domains.xDomain.max).range(0, plotSize.plotWidthCss);
    const yScale = createLinearScale().domain(domains.yDomain.min, domains.yDomain.max).range(plotSize.plotHeightCss, 0);

    const result = { xScale, yScale, plotWidthCss: plotSize.plotWidthCss, plotHeightCss: plotSize.plotHeightCss };
    console.log('[computeInteractionScalesGridCssPx] Computed interaction scales:', {
      canvasType: isHTMLCanvasElement(canvas) ? 'HTMLCanvasElement' : 'OffscreenCanvas',
      plotWidthCss: result.plotWidthCss,
      plotHeightCss: result.plotHeightCss,
      xDomain: domains.xDomain,
      yDomain: domains.yDomain,
      xRange: [0, plotSize.plotWidthCss],
      yRange: [plotSize.plotHeightCss, 0]
    });

    return result;
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

  const buildCandlestickTooltipParams = (
    seriesIndex: number,
    dataIndex: number,
    point: OHLCDataPoint
  ): TooltipParams => {
    const s = currentOptions.series[seriesIndex];
    if (isTupleOHLCDataPoint(point)) {
      return {
        seriesName: s?.name ?? '',
        seriesIndex,
        dataIndex,
        value: [point[0], point[1], point[2], point[3], point[4]] as const,
        color: s?.color ?? '#888',
      };
    } else {
      return {
        seriesName: s?.name ?? '',
        seriesIndex,
        dataIndex,
        value: [point.timestamp, point.open, point.close, point.low, point.high] as const,
        color: s?.color ?? '#888',
      };
    }
  };

  // Helper: Find pie slice at pointer position (extracted to avoid duplication)
  const findPieSliceAtPointer = (
    series: ResolvedChartGPUOptions['series'],
    gridX: number,
    gridY: number,
    plotWidthCss: number,
    plotHeightCss: number
  ): ReturnType<typeof findPieSlice> | null => {
    const maxRadiusCss = 0.5 * Math.min(plotWidthCss, plotHeightCss);
    if (!(maxRadiusCss > 0)) return null;

    for (let i = currentOptions.series.length - 1; i >= 0; i--) {
      const s = series[i];
      if (s.type !== 'pie') continue;
      const pieSeries = s as ResolvedPieSeriesConfig;
      const center = resolvePieCenterPlotCss(pieSeries.center, plotWidthCss, plotHeightCss);
      const radii = resolvePieRadiiCss(pieSeries.radius, maxRadiusCss);
      const m = findPieSlice(gridX, gridY, { seriesIndex: i, series: pieSeries }, center, radii);
      if (m) return m;
    }
    return null;
  };

  // Helper: Find candlestick match at pointer position (hoisted to avoid closure allocation)
  const findCandlestickAtPointer = (
    series: ResolvedChartGPUOptions['series'],
    gridX: number,
    gridY: number,
    interactionScales: NonNullable<ReturnType<typeof computeInteractionScalesGridCssPx>>
  ): { params: TooltipParams; match: { point: OHLCDataPoint }; seriesIndex: number } | null => {
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      if (s.type !== 'candlestick') continue;

      const cs = s as ResolvedCandlestickSeriesConfig;
      const barWidthClip = computeCandlestickBodyWidthRange(
        cs,
        cs.data,
        interactionScales.xScale,
        interactionScales.plotWidthCss
      );

      const m = findCandlestick(
        [cs],
        gridX,
        gridY,
        interactionScales.xScale,
        interactionScales.yScale,
        barWidthClip
      );
      if (!m) continue;

      const params = buildCandlestickTooltipParams(i, m.dataIndex, m.point);
      return { params, match: { point: m.point }, seriesIndex: i };
    }
    return null;
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
    emitCrosshairCallback(payload.isInGrid ? payload.x : null);
    emitHoverCallback(payload.isInGrid ? payload : null);
    requestRender();
  };

  const onMouseLeave = (_payload: ChartGPUEventPayload): void => {
    // Only clear interaction overlays for real pointer interaction.
    // If we're being driven by a sync-x, leaving the canvas shouldn't hide the overlays.
    if (pointerState.source !== 'mouse') return;

    pointerState = { ...pointerState, isInGrid: false, hasPointer: false };
    crosshairRenderer.setVisible(false);
    hideTooltip();
    emitCrosshairCallback(null);
    emitHoverCallback(null);
    setInteractionXInternal(null, 'mouse');
    requestRender();
  };

  // Register event listeners only if event manager is available (HTMLCanvasElement).
  if (eventManager) {
    eventManager.on('mousemove', onMouseMove);
    eventManager.on('mouseleave', onMouseLeave);
  }

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

  const clampPercent = (v: number): number => Math.min(100, Math.max(0, v));

  const getZoomSpanConstraintsFromOptions = (
    opts: ResolvedChartGPUOptions
  ): { readonly minSpan?: number; readonly maxSpan?: number } => {
    let minSpan: number | null = null;
    let maxSpan: number | null = null;

    const list = opts.dataZoom ?? [];
    for (const z of list) {
      if (!z) continue;
      if (z.type !== 'inside' && z.type !== 'slider') continue;

      if (Number.isFinite(z.minSpan as number)) {
        const v = clampPercent(z.minSpan as number);
        minSpan = minSpan == null ? v : Math.max(minSpan, v);
      }
      if (Number.isFinite(z.maxSpan as number)) {
        const v = clampPercent(z.maxSpan as number);
        maxSpan = maxSpan == null ? v : Math.min(maxSpan, v);
      }
    }

    return { minSpan: minSpan ?? undefined, maxSpan: maxSpan ?? undefined };
  };

  const computeDatasetAwareDefaultMinSpan = (): number | null => {
    // Dataset-aware defaults only apply to numeric/time x domains (category is discrete UI-driven).
    if (currentOptions.xAxis.type === 'category') return null;

    let maxPoints = 0;
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (s.type === 'pie') continue;
      if (s.type === 'candlestick') {
        const raw =
          (runtimeRawDataByIndex[i] as ReadonlyArray<OHLCDataPoint> | null) ??
          ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
        maxPoints = Math.max(maxPoints, raw.length);
        continue;
      }

      const raw =
        (runtimeRawDataByIndex[i] as ReadonlyArray<DataPoint> | null) ??
        ((s.rawData ?? s.data) as ReadonlyArray<DataPoint>);
      maxPoints = Math.max(maxPoints, raw.length);
    }

    if (maxPoints < 2) return null;
    const v = 100 / (maxPoints - 1);
    return Number.isFinite(v) ? clampPercent(v) : null;
  };

  const computeEffectiveZoomSpanConstraints = (): { readonly minSpan: number; readonly maxSpan: number } => {
    const fromOptions = getZoomSpanConstraintsFromOptions(currentOptions);
    const datasetMin = computeDatasetAwareDefaultMinSpan();

    // Preserve legacy behavior when no constraints (and no dataset signal) are available.
    // The coordinator will typically override this with datasetMin when the data supports it.
    const minSpan = Number.isFinite(fromOptions.minSpan as number)
      ? clampPercent(fromOptions.minSpan as number)
      : datasetMin ?? 0.5;
    const maxSpan = Number.isFinite(fromOptions.maxSpan as number)
      ? clampPercent(fromOptions.maxSpan as number)
      : 100;

    return { minSpan, maxSpan };
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
      const constraints = computeEffectiveZoomSpanConstraints();
      zoomState = createZoomState(cfg.start, cfg.end, constraints);
      lastOptionsZoomRange = { start: cfg.start, end: cfg.end };
      unsubscribeZoom = zoomState.onChange((range) => {
        // Slice cached data immediately for smooth panning
        sliceRenderSeriesToVisibleRange();
        // Immediate render for UI feedback (axes/crosshair/slider).
        requestRender();
        // Debounce resampling; the unified flush will do the work.
        scheduleZoomResample();
        // Ensure listeners get a stable readonly object.
        emitZoomRange({ start: range.start, end: range.end });
      });
    } else {
      const constraints = computeEffectiveZoomSpanConstraints();
      const withConstraints = zoomState as unknown as {
        setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
      };
      withConstraints.setSpanConstraints?.(constraints.minSpan, constraints.maxSpan);

      if (
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
    }

    // Only enable inside zoom handler when `{ type: 'inside' }` exists.
    // Requires event manager (HTMLCanvasElement only).
    if (cfg.hasInside && eventManager) {
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

  function sliceRenderSeriesToVisibleRange(): void {
    const zoomRange = zoomState?.getRange() ?? null;
    const baseXDomain = computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
    const visibleX = computeVisibleXDomain(baseXDomain, zoomRange);

    // Fast path: no zoom or full span - use baseline directly
    const isFullSpan =
      zoomRange == null ||
      (Number.isFinite(zoomRange.start) &&
        Number.isFinite(zoomRange.end) &&
        zoomRange.start <= 0 &&
        zoomRange.end >= 100);
    
    if (isFullSpan) {
      renderSeries = runtimeBaseSeries;
      return;
    }

    const next: ResolvedChartGPUOptions['series'][number][] = new Array(runtimeBaseSeries.length);

    for (let i = 0; i < runtimeBaseSeries.length; i++) {
      const baseline = runtimeBaseSeries[i]!;
      
      // Pie charts don't need slicing
      if (baseline.type === 'pie') {
        next[i] = baseline;
        continue;
      }

      const cache = lastSampledData[i];
      
      // Strategy 1: Use cache if it covers visible range
      if (cache && 
          visibleX.min >= cache.cachedRange.min && 
          visibleX.max <= cache.cachedRange.max) {
        
        if (baseline.type === 'candlestick') {
          next[i] = {
            ...baseline,
            data: sliceVisibleRangeByOHLC(cache.data as unknown as ReadonlyArray<OHLCDataPoint>, visibleX.min, visibleX.max)
          };
        } else {
          next[i] = {
            ...baseline,
            data: sliceVisibleRangeByX(cache.data as unknown as ReadonlyArray<DataPoint>, visibleX.min, visibleX.max)
          };
        }
        continue;
      }
      
      // Strategy 2: Fallback to baseline sampled data
      if (baseline.type === 'candlestick') {
        next[i] = {
          ...baseline,
          data: sliceVisibleRangeByOHLC(baseline.data as ReadonlyArray<OHLCDataPoint>, visibleX.min, visibleX.max)
        };
      } else {
        next[i] = {
          ...baseline,
          data: sliceVisibleRangeByX(baseline.data as ReadonlyArray<DataPoint>, visibleX.min, visibleX.max)
        };
      }
    }

    renderSeries = next;
  }

  function recomputeRenderSeries(): void {
    const zoomRange = zoomState?.getRange() ?? null;
    const baseXDomain = computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
    const visibleX = computeVisibleXDomain(baseXDomain, zoomRange);

    // Add buffer zone (±10% beyond visible range) for caching
    const bufferFactor = 0.1;
    const visibleSpan = visibleX.max - visibleX.min;
    const bufferSize = visibleSpan * bufferFactor;
    const bufferedMin = visibleX.min - bufferSize;
    const bufferedMax = visibleX.max + bufferSize;

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
        // Slice to buffered range for sampling
        const bufferedOHLC = sliceVisibleRangeByOHLC(rawOHLC, bufferedMin, bufferedMax);

        const sampling = s.sampling;
        const baseThreshold = s.samplingThreshold;

        const baseT = Number.isFinite(baseThreshold) ? Math.max(1, baseThreshold | 0) : 1;
        const maxTarget = Math.min(MAX_TARGET_POINTS_ABS, Math.max(MIN_TARGET_POINTS, baseT * MAX_TARGET_MULTIPLIER));
        const target = clampInt(Math.round(baseT / spanFracSafe), MIN_TARGET_POINTS, maxTarget);

        const sampled = sampling === 'ohlc' && bufferedOHLC.length > target
          ? ohlcSample(bufferedOHLC, target)
          : bufferedOHLC;

        // Store sampled data in cache with buffered range
        lastSampledData[i] = {
          data: sampled as unknown as ReadonlyArray<DataPoint>,
          cachedRange: { min: bufferedMin, max: bufferedMax },
          timestamp: Date.now()
        };

        // Slice to actual visible range for renderSeries
        const visibleSampled = sliceVisibleRangeByOHLC(sampled, visibleX.min, visibleX.max);
        next[i] = { ...s, data: visibleSampled };
        continue;
      }

      // Cartesian series (line, area, bar, scatter).
      const rawData =
        (runtimeRawDataByIndex[i] as DataPoint[] | null) ?? ((s.rawData ?? s.data) as ReadonlyArray<DataPoint>);
      // Slice to buffered range for sampling
      const bufferedRaw = sliceVisibleRangeByX(rawData, bufferedMin, bufferedMax);

      const sampling = s.sampling;
      const baseThreshold = s.samplingThreshold;

      const baseT = Number.isFinite(baseThreshold) ? Math.max(1, baseThreshold | 0) : 1;
      const maxTarget = Math.min(MAX_TARGET_POINTS_ABS, Math.max(MIN_TARGET_POINTS, baseT * MAX_TARGET_MULTIPLIER));
      const target = clampInt(Math.round(baseT / spanFracSafe), MIN_TARGET_POINTS, maxTarget);

      const sampled = sampleSeriesDataPoints(bufferedRaw, sampling, target);

      // Store sampled data in cache with buffered range
      lastSampledData[i] = {
        data: sampled,
        cachedRange: { min: bufferedMin, max: bufferedMax },
        timestamp: Date.now()
      };

      // Slice to actual visible range for renderSeries
      const visibleSampled = sliceVisibleRangeByX(sampled, visibleX.min, visibleX.max);
      next[i] = { ...s, data: visibleSampled };
    }

    renderSeries = next;
  }

  initRuntimeSeriesFromOptions();
  recomputeRuntimeBaseSeries();
  updateZoom();
  recomputeRenderSeries();
  lastSampledData = new Array(currentOptions.series.length).fill(null);

  const areaRenderers: Array<ReturnType<typeof createAreaRenderer>> = [];
  const lineRenderers: Array<ReturnType<typeof createLineRenderer>> = [];
  const scatterRenderers: Array<ReturnType<typeof createScatterRenderer>> = [];
  const scatterDensityRenderers: Array<ReturnType<typeof createScatterDensityRenderer>> = [];
  const pieRenderers: Array<ReturnType<typeof createPieRenderer>> = [];
  const candlestickRenderers: Array<ReturnType<typeof createCandlestickRenderer>> = [];
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

  const ensureScatterDensityRendererCount = (count: number): void => {
    while (scatterDensityRenderers.length > count) {
      const r = scatterDensityRenderers.pop();
      r?.dispose();
    }
    while (scatterDensityRenderers.length < count) {
      scatterDensityRenderers.push(createScatterDensityRenderer(device, { targetFormat }));
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

  const ensureCandlestickRendererCount = (count: number): void => {
    while (candlestickRenderers.length > count) {
      const r = candlestickRenderers.pop();
      r?.dispose();
    }
    while (candlestickRenderers.length < count) {
      candlestickRenderers.push(createCandlestickRenderer(device, { targetFormat }));
    }
  };

  ensureAreaRendererCount(currentOptions.series.length);
  ensureLineRendererCount(currentOptions.series.length);
  ensureScatterRendererCount(currentOptions.series.length);
  ensureScatterDensityRendererCount(currentOptions.series.length);
  ensurePieRendererCount(currentOptions.series.length);
  ensureCandlestickRendererCount(currentOptions.series.length);

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
    lastSampledData = new Array(resolvedOptions.series.length).fill(null);
    legend?.update(resolvedOptions.series, resolvedOptions.theme);
    cancelZoomResampleDebounce();
    zoomResampleDue = false;
    cancelScheduledFlush();
    initRuntimeSeriesFromOptions();
    recomputeRuntimeBaseSeries();
    updateZoom();
    recomputeRenderSeries();

    // Tooltip enablement may change at runtime.
    if (overlayContainer) {
      const shouldHaveTooltip = currentOptions.tooltip?.show !== false;
      if (shouldHaveTooltip && !tooltip) {
        tooltip = createTooltip(overlayContainer);
        lastTooltipContent = null;
        lastTooltipX = null;
        lastTooltipY = null;
      }
      if (!shouldHaveTooltip && tooltip) {
        hideTooltip();
      }
        } else {
          hideTooltip();
        }

    const nextCount = resolvedOptions.series.length;
    ensureAreaRendererCount(nextCount);
    ensureLineRendererCount(nextCount);
    ensureScatterRendererCount(nextCount);
    ensureScatterDensityRendererCount(nextCount);
    ensurePieRendererCount(nextCount);
    ensureCandlestickRendererCount(nextCount);

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

    const existing = pendingAppendByIndex.get(seriesIndex);
    if (existing) {
      existing.push(...(newPoints as Array<DataPoint | OHLCDataPoint>));
    } else {
      // Copy into a mutable staging array so repeated appends coalesce without extra allocations.
      pendingAppendByIndex.set(seriesIndex, Array.from(newPoints as Array<DataPoint | OHLCDataPoint>));
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

    const hasCartesianSeries = currentOptions.series.some((s) => s.type !== 'pie');
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
            case 'scatter':
            case 'candlestick': {
              if (s.data.length > 0) return true;
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
    eventManager?.updateGridArea(gridArea);
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

    // PERFORMANCE: Cache canvas CSS dimensions (used for both GPU overlays and label processing)
    // Annotations (GPU overlays) are specified in data-space and converted to CANVAS-LOCAL CSS pixels.
    const canvas = gpuContext.canvas;
    // IMPORTANT: use the same DPR as the GPU render path (gridArea) to keep CSS↔device conversions stable.
    const canvasDprForAnnotations = gridArea.devicePixelRatio;
    // IMPORTANT: For GPU overlay annotations only, derive CSS size from device pixels to avoid
    // DOM `clientWidth/clientHeight` mismatch with the WebGPU render target size.
    const canvasCssForAnnotations = getCanvasCssSizeFromDevicePixels(canvas, canvasDprForAnnotations);
    const canvasCssWidthForAnnotations = canvasCssForAnnotations.width;
    const canvasCssHeightForAnnotations = canvasCssForAnnotations.height;

    const plotLeftCss = canvasCssWidthForAnnotations > 0 ? clipXToCanvasCssPx(plotClipRect.left, canvasCssWidthForAnnotations) : 0;
    const plotRightCss = canvasCssWidthForAnnotations > 0 ? clipXToCanvasCssPx(plotClipRect.right, canvasCssWidthForAnnotations) : 0;
    const plotTopCss = canvasCssHeightForAnnotations > 0 ? clipYToCanvasCssPx(plotClipRect.top, canvasCssHeightForAnnotations) : 0;
    const plotBottomCss = canvasCssHeightForAnnotations > 0 ? clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeightForAnnotations) : 0;
    const plotWidthCss = Math.max(0, plotRightCss - plotLeftCss);
    const plotHeightCss = Math.max(0, plotBottomCss - plotTopCss);

    const resolveAnnotationRgba = (color: string | undefined, opacity: number | undefined): readonly [number, number, number, number] => {
      const base =
        parseCssColorToRgba01(color ?? currentOptions.theme.textColor) ??
        parseCssColorToRgba01(currentOptions.theme.textColor) ??
        ([1, 1, 1, 1] as const);
      const o = opacity == null ? 1 : clamp01(opacity);
      return [clamp01(base[0]), clamp01(base[1]), clamp01(base[2]), clamp01(base[3] * o)] as const;
    };

    const annotations: ReadonlyArray<AnnotationConfig> = hasCartesianSeries ? (currentOptions.annotations ?? []) : [];

    // PERFORMANCE: Reuse arrays from previous frame (clear and reuse to avoid allocations)
    annotationLineBelow.length = 0;
    annotationLineAbove.length = 0;
    annotationMarkerBelow.length = 0;
    annotationMarkerAbove.length = 0;

    // PERFORMANCE: Early exit if no annotations or invalid canvas dimensions
    if (annotations.length > 0 && canvasCssWidthForAnnotations > 0 && canvasCssHeightForAnnotations > 0 && plotWidthCss > 0 && plotHeightCss > 0) {
      for (let i = 0; i < annotations.length; i++) {
        const a = annotations[i]!;
        const layer = a.layer ?? 'aboveSeries';
        const targetLines = layer === 'belowSeries' ? annotationLineBelow : annotationLineAbove;
        const targetMarkers = layer === 'belowSeries' ? annotationMarkerBelow : annotationMarkerAbove;

        const styleColor = a.style?.color;
        const styleOpacity = a.style?.opacity;
        const lineWidth = typeof a.style?.lineWidth === 'number' && Number.isFinite(a.style.lineWidth) ? Math.max(0, a.style.lineWidth) : 1;
        const lineDash = a.style?.lineDash;
        const rgba = resolveAnnotationRgba(styleColor, styleOpacity);

        switch (a.type) {
          case 'lineX': {
            const xClip = xScale.scale(a.x);
            const xCss = clipXToCanvasCssPx(xClip, canvasCssWidthForAnnotations);
            if (!Number.isFinite(xCss)) break;
            targetLines.push({
              axis: 'vertical',
              positionCssPx: xCss,
              lineWidth,
              lineDash,
              rgba,
            });
            break;
          }
          case 'lineY': {
            const yClip = yScale.scale(a.y);
            const yCss = clipYToCanvasCssPx(yClip, canvasCssHeightForAnnotations);
            if (!Number.isFinite(yCss)) break;
            targetLines.push({
              axis: 'horizontal',
              positionCssPx: yCss,
              lineWidth,
              lineDash,
              rgba,
            });
            break;
          }
          case 'point': {
            const xClip = xScale.scale(a.x);
            const yClip = yScale.scale(a.y);
            const xCss = clipXToCanvasCssPx(xClip, canvasCssWidthForAnnotations);
            const yCss = clipYToCanvasCssPx(yClip, canvasCssHeightForAnnotations);
            if (!Number.isFinite(xCss) || !Number.isFinite(yCss)) break;

            const markerSize =
              typeof a.marker?.size === 'number' && Number.isFinite(a.marker.size) ? Math.max(1, a.marker.size) : 6;
            const markerColor = a.marker?.style?.color ?? a.style?.color;
            const markerOpacity = a.marker?.style?.opacity ?? a.style?.opacity;
            const fillRgba = resolveAnnotationRgba(markerColor, markerOpacity);

            targetMarkers.push({
              xCssPx: xCss,
              yCssPx: yCss,
              sizeCssPx: markerSize,
              fillRgba,
            });
            break;
          }
          case 'text': {
            // Text annotations are handled via DOM overlays / callbacks (labels), not GPU.
            break;
          }
          default:
            assertUnreachable(a);
        }
      }
    }

    // PERFORMANCE: Use array references directly instead of spreading (avoids allocation)
    const combinedReferenceLines: ReadonlyArray<ReferenceLineInstance> =
      annotationLineBelow.length + annotationLineAbove.length > 0 ? [...annotationLineBelow, ...annotationLineAbove] : [];
    const combinedMarkers: ReadonlyArray<AnnotationMarkerInstance> =
      annotationMarkerBelow.length + annotationMarkerAbove.length > 0 ? [...annotationMarkerBelow, ...annotationMarkerAbove] : [];
    const referenceLineBelowCount = annotationLineBelow.length;
    const referenceLineAboveCount = annotationLineAbove.length;
    const markerBelowCount = annotationMarkerBelow.length;
    const markerAboveCount = annotationMarkerAbove.length;

    // Story 6: compute an x tick count that prevents label overlap (time axis only).
    // IMPORTANT: compute in CSS px, since labels are DOM elements in CSS px.
    // Note: This requires HTMLCanvasElement for accurate CSS pixel measurement.
    const dpr = gridArea.devicePixelRatio;
    const canvasCssWidth = gpuContext.canvas ? getCanvasCssWidth(gpuContext.canvas, dpr) : 0;
    const visibleXRangeMs = Math.abs(visibleXDomain.max - visibleXDomain.min);

    let xTickCount = DEFAULT_TICK_COUNT;
    let xTickValues: readonly number[] = [];
    if (currentOptions.xAxis.type === 'time') {
      const computed = computeAdaptiveTimeXAxisTicks({
        axisMin: finiteOrNull(currentOptions.xAxis.min),
        axisMax: finiteOrNull(currentOptions.xAxis.max),
        xScale,
        plotClipLeft: plotClipRect.left,
        plotClipRight: plotClipRect.right,
        canvasCssWidth,
        visibleRangeMs: visibleXRangeMs,
        measureCtx: tickMeasureCtx,
        measureCache: tickMeasureCache ?? undefined,
        fontSize: currentOptions.theme.fontSize,
        fontFamily: currentOptions.theme.fontFamily || 'sans-serif',
      });
      xTickCount = computed.tickCount;
      xTickValues = computed.tickValues;
    } else {
      // Keep existing behavior for non-time x axes.
      const domainMin = finiteOrUndefined(currentOptions.xAxis.min) ?? xScale.invert(plotClipRect.left);
      const domainMax = finiteOrUndefined(currentOptions.xAxis.max) ?? xScale.invert(plotClipRect.right);
      xTickValues = generateLinearTicks(domainMin, domainMax, xTickCount);
    }

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
        currentOptions.theme.axisTickColor,
        xTickCount
      );
      yAxisRenderer.prepare(
        currentOptions.yAxis,
        yScale,
        'y',
        gridArea,
        currentOptions.theme.axisLineColor,
        currentOptions.theme.axisTickColor,
        DEFAULT_TICK_COUNT
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
      emitCrosshairCallback(effectivePointer.x);
    } else {
      crosshairRenderer.setVisible(false);
      emitCrosshairCallback(null);
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
            const centerCssX = gridArea.left + xGridCss;
            const centerCssY = gridArea.top + yGridCss;

            const plotScissor = computePlotScissorDevicePx(gridArea);
            const point: HighlightPoint = {
              centerDeviceX: centerCssX * gridArea.devicePixelRatio,
              centerDeviceY: centerCssY * gridArea.devicePixelRatio,
              devicePixelRatio: gridArea.devicePixelRatio,
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
    // Note: Tooltips require HTMLCanvasElement (DOM-specific positioning) for DOM rendering.
    // However, in worker mode (!domOverlaysEnabled), we still need to run hit-testing and callbacks.
    if (effectivePointer.hasPointer && effectivePointer.isInGrid && currentOptions.tooltip?.show !== false) {
      const canvas = gpuContext.canvas;

      console.log('[Tooltip block] State check:', {
        hasInteractionScales: !!interactionScales,
        domOverlaysEnabled,
        hasCanvas: !!canvas,
        canvasType: canvas ? (isHTMLCanvasElement(canvas) ? 'HTMLCanvasElement' : 'OffscreenCanvas') : 'null',
        interactionScales: interactionScales ? {
          plotWidthCss: interactionScales.plotWidthCss,
          plotHeightCss: interactionScales.plotHeightCss
        } : null
      });

      if (interactionScales && (!domOverlaysEnabled || (canvas && isHTMLCanvasElement(canvas)))) {
        const formatter = currentOptions.tooltip?.formatter;
        const trigger = currentOptions.tooltip?.trigger ?? 'item';

        // In worker mode (OffscreenCanvas), offsetLeft/offsetTop don't exist
        // Use effectivePointer coordinates directly as they're already in container-local CSS pixels
        const containerX = isHTMLCanvasElement(canvas) ? canvas.offsetLeft + effectivePointer.x : effectivePointer.x;
        const containerY = isHTMLCanvasElement(canvas) ? canvas.offsetTop + effectivePointer.y : effectivePointer.y;

        if (effectivePointer.source === 'sync') {
          // Sync semantics:
          // - Tooltip should be driven by x only (no y).
          // - In 'axis' mode, show one entry per series nearest in x.
          // - In 'item' mode, pick a deterministic single entry (first matching series).
          const matches = findPointsAtX(seriesForRender, effectivePointer.gridX, interactionScales.xScale);
          if (matches.length === 0) {
            hideTooltip();
          } else if (trigger === 'axis') {
            const paramsArray = matches.map((m) => buildTooltipParams(m.seriesIndex, m.dataIndex, m.point));
            const content = formatter
              ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)(paramsArray)
              : formatTooltipAxis(paramsArray);
            if (content && (content !== lastTooltipContent || containerX !== lastTooltipX || containerY !== lastTooltipY)) {
              lastTooltipContent = content;
              lastTooltipX = containerX;
              lastTooltipY = containerY;
              showTooltipInternal(containerX, containerY, content, paramsArray);
            } else if (!content) {
              hideTooltip();
            }
          } else {
            const m0 = matches[0];
            const params = buildTooltipParams(m0.seriesIndex, m0.dataIndex, m0.point);
            const content = formatter ? (formatter as (p: TooltipParams) => string)(params) : formatTooltipItem(params);
            if (content && (content !== lastTooltipContent || containerX !== lastTooltipX || containerY !== lastTooltipY)) {
              lastTooltipContent = content;
              lastTooltipX = containerX;
              lastTooltipY = containerY;
              showTooltipInternal(containerX, containerY, content, params);
            } else if (!content) {
              hideTooltip();
            }
          }
        } else if (trigger === 'axis') {
          // Story 4.14: pie slice tooltip hit-testing (mouse only).
          // If the cursor is over a pie slice, prefer showing that slice tooltip.
          const pieMatch = findPieSliceAtPointer(
            seriesForRender,
            effectivePointer.gridX,
            effectivePointer.gridY,
            interactionScales.plotWidthCss,
            interactionScales.plotHeightCss
          );

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
            if (content && (content !== lastTooltipContent || containerX !== lastTooltipX || containerY !== lastTooltipY)) {
              lastTooltipContent = content;
              lastTooltipX = containerX;
              lastTooltipY = containerY;
              showTooltipInternal(containerX, containerY, content, [params]);
            } else if (!content) {
              hideTooltip();
            }
          } else {
            // Candlestick body hit-testing (mouse, axis trigger): include only when inside candle body.
            const candlestickResult = findCandlestickAtPointer(
              seriesForRender,
              effectivePointer.gridX,
              effectivePointer.gridY,
              interactionScales
            );

            const matches = findPointsAtX(seriesForRender, effectivePointer.gridX, interactionScales.xScale);
            if (matches.length === 0) {
              if (candlestickResult) {
                const paramsArray = [candlestickResult.params];
                const content = formatter
                  ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)(paramsArray)
                  : formatTooltipAxis(paramsArray);
                if (content) {
                  // Use candlestick anchor for tooltip positioning
                  const anchor = computeCandlestickTooltipAnchor(
                    candlestickResult.match,
                    interactionScales.xScale,
                    interactionScales.yScale,
                    gridArea,
                    canvas
                  );
                  const tooltipX = anchor?.x ?? containerX;
                  const tooltipY = anchor?.y ?? containerY;
                  if (content !== lastTooltipContent || tooltipX !== lastTooltipX || tooltipY !== lastTooltipY) {
                    lastTooltipContent = content;
                    lastTooltipX = tooltipX;
                    lastTooltipY = tooltipY;
                    showTooltipInternal(tooltipX, tooltipY, content, paramsArray);
                  }
                } else {
                  hideTooltip();
                }
              } else {
                hideTooltip();
              }
            } else {
              const paramsArray = matches.map((m) => buildTooltipParams(m.seriesIndex, m.dataIndex, m.point));
              if (candlestickResult) paramsArray.push(candlestickResult.params);
              const content = formatter
                ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)(paramsArray)
                : formatTooltipAxis(paramsArray);
              if (content) {
                // Use candlestick anchor if candlestick is present in tooltip
                let tooltipX = containerX;
                let tooltipY = containerY;
                if (candlestickResult) {
                  const anchor = computeCandlestickTooltipAnchor(
                    candlestickResult.match,
                    interactionScales.xScale,
                    interactionScales.yScale,
                    gridArea,
                    canvas
                  );
                  if (anchor) {
                    tooltipX = anchor.x;
                    tooltipY = anchor.y;
                  }
                }
                if (content !== lastTooltipContent || tooltipX !== lastTooltipX || tooltipY !== lastTooltipY) {
                  lastTooltipContent = content;
                  lastTooltipX = tooltipX;
                  lastTooltipY = tooltipY;
                  showTooltipInternal(tooltipX, tooltipY, content, paramsArray);
                }
              } else {
                hideTooltip();
              }
            }
          }
        } else {
          // Story 4.14: pie slice tooltip hit-testing (mouse only).
          // If the cursor is over a pie slice, prefer showing that slice tooltip.
          const pieMatch = findPieSliceAtPointer(
            seriesForRender,
            effectivePointer.gridX,
            effectivePointer.gridY,
            interactionScales.plotWidthCss,
            interactionScales.plotHeightCss
          );

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
            if (content && (content !== lastTooltipContent || containerX !== lastTooltipX || containerY !== lastTooltipY)) {
              lastTooltipContent = content;
              lastTooltipX = containerX;
              lastTooltipY = containerY;
              showTooltipInternal(containerX, containerY, content, params);
            } else if (!content) {
              hideTooltip();
            }
          } else {
            // Candlestick body hit-testing (mouse, item trigger): prefer candle body over nearest-point logic.
            const candlestickResult = findCandlestickAtPointer(
              seriesForRender,
              effectivePointer.gridX,
              effectivePointer.gridY,
              interactionScales
            );
            if (candlestickResult) {
              const content = formatter
                ? (formatter as (p: TooltipParams) => string)(candlestickResult.params)
                : formatTooltipItem(candlestickResult.params);
              if (content) {
                // Use candlestick anchor for tooltip positioning
                const anchor = computeCandlestickTooltipAnchor(
                  candlestickResult.match,
                  interactionScales.xScale,
                  interactionScales.yScale,
                  gridArea,
                  canvas
                );
                const tooltipX = anchor?.x ?? containerX;
                const tooltipY = anchor?.y ?? containerY;
                if (content !== lastTooltipContent || tooltipX !== lastTooltipX || tooltipY !== lastTooltipY) {
                  lastTooltipContent = content;
                  lastTooltipX = tooltipX;
                  lastTooltipY = tooltipY;
                  showTooltipInternal(tooltipX, tooltipY, content, candlestickResult.params);
                }
              } else {
                hideTooltip();
              }
              return;
            }

            const match = findNearestPoint(
              seriesForRender,
              effectivePointer.gridX,
              effectivePointer.gridY,
              interactionScales.xScale,
              interactionScales.yScale
            );
            if (!match) {
              hideTooltip();
            } else {
              const params = buildTooltipParams(match.seriesIndex, match.dataIndex, match.point);
              const content = formatter
                ? (formatter as (p: TooltipParams) => string)(params)
                : formatTooltipItem(params);
              if (content && (content !== lastTooltipContent || containerX !== lastTooltipX || containerY !== lastTooltipY)) {
                lastTooltipContent = content;
                lastTooltipX = containerX;
                lastTooltipY = containerY;
                showTooltipInternal(containerX, containerY, content, params);
              } else if (!content) {
                hideTooltip();
              }
            }
          }
        }
            } else {
              hideTooltip();
            }
        } else {
          hideTooltip();
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
          // For time axes (epoch-ms), subtract an x-origin before packing to Float32 to avoid precision loss
          // (Float32 ulp at ~1e12 is ~2e5), which can manifest as stroke shimmer during zoom.
          const xOffset = (() => {
            if (currentOptions.xAxis.type !== 'time') return 0;
            const d = s.data;
            for (let k = 0; k < d.length; k++) {
              const p = d[k]!;
              const x = isTupleDataPoint(p) ? p[0] : p.x;
              if (Number.isFinite(x)) return x;
            }
            return 0;
          })();
          if (!appendedGpuThisFrame.has(i)) {
            dataStore.setSeries(i, s.data, { xOffset });
          }
          const buffer = dataStore.getSeriesBuffer(i);
          lineRenderers[i].prepare(s, buffer, xScale, yScale, xOffset);

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
          if (s.mode === 'density') {
            // Density mode bins raw (unsampled) data for correctness, but limits compute to the visible
            // range when x is monotonic.
            const rawData = s.rawData ?? s.data;
            const visible = findVisibleRangeIndicesByX(rawData, visibleXDomain.min, visibleXDomain.max);

            // Upload full raw data for compute. DataStore hashing makes this a cheap no-op when unchanged.
            if (!appendedGpuThisFrame.has(i)) {
              dataStore.setSeries(i, rawData);
            }
            const buffer = dataStore.getSeriesBuffer(i);
            const pointCount = dataStore.getSeriesPointCount(i);

            scatterDensityRenderers[i].prepare(
              s,
              buffer,
              pointCount,
              visible.start,
              visible.end,
              xScale,
              yScale,
              gridArea,
              s.rawBounds
            );
            // Density mode keeps its own compute path; treat as non-fast-path for append heuristics.
            gpuSeriesKindByIndex[i] = 'other';
          } else {
            const animated = introP < 1 ? ({ ...s, color: withAlpha(s.color, introP) } as const) : s;
            scatterRenderers[i].prepare(animated, s.data, xScale, yScale, gridArea);
          }
          break;
        }
        case 'pie': {
          // Pie renderer sets/resets its own scissor. Animate intro via radius scale (CSS px).
          if (introP < 1) {
            const canvas = gpuContext.canvas;
            const plotWidthCss = interactionScales?.plotWidthCss ?? (canvas && isHTMLCanvasElement(canvas) ? getPlotSizeCssPx(canvas, gridArea)?.plotWidthCss : null);
            const plotHeightCss =
              interactionScales?.plotHeightCss ?? (canvas && isHTMLCanvasElement(canvas) ? getPlotSizeCssPx(canvas, gridArea)?.plotHeightCss : null);
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
          // Candlestick renderer handles clipping internally, no intro animation for now.
          candlestickRenderers[i].prepare(s, s.data, xScale, yScale, gridArea, currentOptions.theme.backgroundColor);
          break;
        }
        default:
          assertUnreachable(s);
      }
    }

    // Bars are prepared once and rendered via a single instanced draw call.
    const yScaleForBars = introP < 1 ? createAnimatedBarYScale(yScale, plotClipRect, barSeriesConfigs, introP) : yScale;
    barRenderer.prepare(barSeriesConfigs, dataStore, xScale, yScaleForBars, gridArea);

    // Prepare annotation GPU overlays (reference lines + point markers).
    // Note: these renderers expect CANVAS-LOCAL CSS pixel coordinates; the coordinator owns
    // data-space → canvas-space conversion and plot scissor state.
    if (hasCartesianSeries) {
      referenceLineRenderer.prepare(gridArea, combinedReferenceLines);
      referenceLineRendererMsaa.prepare(gridArea, combinedReferenceLines);
      annotationMarkerRenderer.prepare({
        canvasWidth: gridArea.canvasWidth,
        canvasHeight: gridArea.canvasHeight,
        devicePixelRatio: gridArea.devicePixelRatio,
        instances: combinedMarkers,
      });
      annotationMarkerRendererMsaa.prepare({
        canvasWidth: gridArea.canvasWidth,
        canvasHeight: gridArea.canvasHeight,
        devicePixelRatio: gridArea.devicePixelRatio,
        instances: combinedMarkers,
      });
    } else {
      // Ensure prior frame instances don't persist visually if series mode changes.
      referenceLineRenderer.prepare(gridArea, []);
      referenceLineRendererMsaa.prepare(gridArea, []);
      annotationMarkerRenderer.prepare({
        canvasWidth: gridArea.canvasWidth,
        canvasHeight: gridArea.canvasHeight,
        devicePixelRatio: gridArea.devicePixelRatio,
        instances: [],
      });
      annotationMarkerRendererMsaa.prepare({
        canvasWidth: gridArea.canvasWidth,
        canvasHeight: gridArea.canvasHeight,
        devicePixelRatio: gridArea.devicePixelRatio,
        instances: [],
      });
    }

    // Ensure offscreen + MSAA overlay targets match current device-pixel canvas size.
    ensureOverlayTargets(gridArea.canvasWidth, gridArea.canvasHeight);

    // Swapchain view for the resolved MSAA overlay pass and for the final (load) overlay pass.
    const swapchainView = gpuContext.canvasContext.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder({ label: 'renderCoordinator/commandEncoder' });
    const clearValue = parseCssColorToGPUColor(currentOptions.theme.backgroundColor, { r: 0, g: 0, b: 0, a: 1 });

    // Encode compute passes (scatter density) before the render pass.
    for (let i = 0; i < seriesForRender.length; i++) {
      const s = seriesForRender[i];
      if (s.type === 'scatter' && s.mode === 'density') {
        scatterDensityRenderers[i].encodeCompute(encoder);
      }
    }

    const mainPass = encoder.beginRenderPass({
      label: 'renderCoordinator/mainPass',
      colorAttachments: [
        {
          // Render main scene to an offscreen single-sampled texture so the annotation overlay can
          // be MSAA'd and resolved into the swapchain without losing the already-rendered content.
          view: mainColorView!,
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
    gridRenderer.render(mainPass);

    for (let i = 0; i < seriesForRender.length; i++) {
      if (seriesForRender[i].type === 'pie') {
        pieRenderers[i].render(mainPass);
      }
    }

    // Annotations (below series): clipped to plot scissor.
    if (hasCartesianSeries && plotScissor.w > 0 && plotScissor.h > 0) {
      const hasBelow = referenceLineBelowCount > 0 || markerBelowCount > 0;
      if (hasBelow) {
        mainPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
        if (referenceLineBelowCount > 0) {
          referenceLineRenderer.render(mainPass, 0, referenceLineBelowCount);
        }
        if (markerBelowCount > 0) {
          annotationMarkerRenderer.render(mainPass, 0, markerBelowCount);
        }
        mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
      }
    }

    for (let i = 0; i < seriesForRender.length; i++) {
      if (shouldRenderArea(seriesForRender[i])) {
        // Line/area intro reveal: left-to-right plot scissor.
        if (introP < 1) {
          const w = clampInt(Math.floor(plotScissor.w * introP), 0, plotScissor.w);
          if (w > 0 && plotScissor.h > 0) {
            mainPass.setScissorRect(plotScissor.x, plotScissor.y, w, plotScissor.h);
            areaRenderers[i].render(mainPass);
            mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
          }
        } else {
          mainPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
          areaRenderers[i].render(mainPass);
          mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
        }
      }
    }
    // Clip bars to the plot grid (mirrors area/line scissor usage).
    if (plotScissor.w > 0 && plotScissor.h > 0) {
      mainPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
      barRenderer.render(mainPass);
      mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
    }
    for (let i = 0; i < seriesForRender.length; i++) {
      if (seriesForRender[i].type === 'candlestick') {
        candlestickRenderers[i].render(mainPass);
      }
    }
    for (let i = 0; i < seriesForRender.length; i++) {
      const s = seriesForRender[i];
      if (s.type !== 'scatter') continue;
      if (s.mode === 'density') {
        scatterDensityRenderers[i].render(mainPass);
      } else {
        scatterRenderers[i].render(mainPass);
      }
    }
    for (let i = 0; i < seriesForRender.length; i++) {
      if (seriesForRender[i].type === 'line') {
        // Line intro reveal: left-to-right plot scissor.
        if (introP < 1) {
          const w = clampInt(Math.floor(plotScissor.w * introP), 0, plotScissor.w);
          if (w > 0 && plotScissor.h > 0) {
            mainPass.setScissorRect(plotScissor.x, plotScissor.y, w, plotScissor.h);
            lineRenderers[i].render(mainPass);
            mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
          }
        } else {
          mainPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
          lineRenderers[i].render(mainPass);
          mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
        }
      }
    }

    mainPass.end();

    // MSAA annotation overlay pass: blit main color → MSAA target, then draw above-series annotations.
    const overlayPass = encoder.beginRenderPass({
      label: 'renderCoordinator/annotationOverlayMsaaPass',
      colorAttachments: [
        {
          view: overlayMsaaView!,
          resolveTarget: swapchainView,
          clearValue,
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
    });

    overlayPass.setPipeline(overlayBlitPipeline);
    overlayPass.setBindGroup(0, overlayBlitBindGroup!);
    overlayPass.draw(3);

    // Annotations (above series): reference lines then markers, clipped to plot scissor.
    if (hasCartesianSeries && plotScissor.w > 0 && plotScissor.h > 0) {
      const hasAbove = referenceLineAboveCount > 0 || markerAboveCount > 0;
      if (hasAbove) {
        const firstLine = referenceLineBelowCount;
        const firstMarker = markerBelowCount;
        overlayPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
        if (referenceLineAboveCount > 0) {
          referenceLineRendererMsaa.render(overlayPass, firstLine, referenceLineAboveCount);
        }
        if (markerAboveCount > 0) {
          annotationMarkerRendererMsaa.render(overlayPass, firstMarker, markerAboveCount);
        }
        overlayPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
      }
    }

    overlayPass.end();

    // Top overlays (single-sample): axes, highlights, crosshair.
    const topOverlayPass = encoder.beginRenderPass({
      label: 'renderCoordinator/topOverlayPass',
      colorAttachments: [
        {
          view: swapchainView,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });

    highlightRenderer.render(topOverlayPass);
    if (hasCartesianSeries) {
      xAxisRenderer.render(topOverlayPass);
      yAxisRenderer.render(topOverlayPass);
    }
    crosshairRenderer.render(topOverlayPass);

    topOverlayPass.end();
    device.queue.submit([encoder.finish()]);

    hasRenderedOnce = true;

    // Generate axis labels for DOM overlay (main thread) or callback (worker mode)
    const shouldGenerateAxisLabels = hasCartesianSeries && (
      (axisLabelOverlay && overlayContainer) ||  // DOM mode with overlay
      (!domOverlaysEnabled && callbacks?.onAxisLabelsUpdate)  // Worker mode with callback
    );

    if (shouldGenerateAxisLabels) {
      const canvas = gpuContext.canvas;

      // Get canvas dimensions (works for both HTMLCanvasElement and OffscreenCanvas)
      const canvasCssWidth = getCanvasCssWidth(canvas, gpuContext.devicePixelRatio ?? 1);
      const canvasCssHeight = getCanvasCssHeight(canvas, gpuContext.devicePixelRatio ?? 1);
      if (canvasCssWidth <= 0 || canvasCssHeight <= 0) return;

      // Calculate offsets (only for DOM mode with HTMLCanvasElement)
      // In worker mode (OffscreenCanvas), offsets are 0 since there's no offsetLeft/offsetTop
      const offsetX = isHTMLCanvasElement(canvas) ? canvas.offsetLeft : 0;
      const offsetY = isHTMLCanvasElement(canvas) ? canvas.offsetTop : 0;

      const plotLeftCss = clipXToCanvasCssPx(plotClipRect.left, canvasCssWidth);
      const plotRightCss = clipXToCanvasCssPx(plotClipRect.right, canvasCssWidth);
      const plotTopCss = clipYToCanvasCssPx(plotClipRect.top, canvasCssHeight);
      const plotBottomCss = clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeight);

      // Clear axis label overlay if it exists
      axisLabelOverlay?.clear();

      // Collect axis labels for callback emission
      const collectedXLabels: AxisLabel[] = [];
      const collectedYLabels: AxisLabel[] = [];

      const xTickLengthCssPx = currentOptions.xAxis.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
      const xLabelY = plotBottomCss + xTickLengthCssPx + LABEL_PADDING_CSS_PX + currentOptions.theme.fontSize * 0.5;
      const isTimeXAxis = currentOptions.xAxis.type === 'time';
      const xFormatter = (() => {
        if (isTimeXAxis) return null;
        const xDomainMin = finiteOrUndefined(currentOptions.xAxis.min) ?? xScale.invert(plotClipRect.left);
        const xDomainMax = finiteOrUndefined(currentOptions.xAxis.max) ?? xScale.invert(plotClipRect.right);
        const xTickStep = xTickCount === 1 ? 0 : (xDomainMax - xDomainMin) / (xTickCount - 1);
        return createTickFormatter(xTickStep);
      })();

      for (let i = 0; i < xTickValues.length; i++) {
        const v = xTickValues[i]!;
        const xClip = xScale.scale(v);
        const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);

        const anchor: TextOverlayAnchor =
          xTickValues.length === 1 ? 'middle' : i === 0 ? 'start' : i === xTickValues.length - 1 ? 'end' : 'middle';
        const label = isTimeXAxis ? formatTimeTickValue(v, visibleXRangeMs) : formatTickValue(xFormatter!, v);
        if (label == null) continue;

        // Collect label data for callback (worker mode)
        const axisLabel: AxisLabel = { axis: 'x', text: label, x: offsetX + xCss, y: offsetY + xLabelY, anchor, isTitle: false };
        collectedXLabels.push(axisLabel);

        // Add to DOM overlay if it exists (main thread mode)
        if (axisLabelOverlay) {
          const span = axisLabelOverlay.addLabel(label, offsetX + xCss, offsetY + xLabelY, {
            fontSize: currentOptions.theme.fontSize,
            color: currentOptions.theme.textColor,
            anchor,
          });
          styleAxisLabelSpan(span, axisLabel, currentOptions.theme);
        }
      }

      const yTickCount = DEFAULT_TICK_COUNT;
      const yTickLengthCssPx = currentOptions.yAxis.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
      const yDomainMin = finiteOrUndefined(currentOptions.yAxis.min) ?? yScale.invert(plotClipRect.bottom);
      const yDomainMax = finiteOrUndefined(currentOptions.yAxis.max) ?? yScale.invert(plotClipRect.top);
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

        // Collect label data for callback (worker mode)
        const axisLabel: AxisLabel = { axis: 'y', text: label, x: offsetX + yLabelX, y: offsetY + yCss, anchor: 'end', isTitle: false };
        collectedYLabels.push(axisLabel);

        // Add to DOM overlay if it exists (main thread mode)
        if (axisLabelOverlay) {
          const span = axisLabelOverlay.addLabel(label, offsetX + yLabelX, offsetY + yCss, {
            fontSize: currentOptions.theme.fontSize,
            color: currentOptions.theme.textColor,
            anchor: 'end',
          });
          styleAxisLabelSpan(span, axisLabel, currentOptions.theme);
          ySpans.push(span);
        }
      }

      const axisNameFontSize = getAxisTitleFontSize(currentOptions.theme.fontSize);

      const xAxisName = currentOptions.xAxis.name?.trim() ?? '';
      if (xAxisName.length > 0) {
        const xCenter = (plotLeftCss + plotRightCss) / 2;
        // Center title vertically between the tick labels and the zoom slider (when present).
        // The zoom slider is an absolute-positioned overlay at the bottom of the canvas. We reserve
        // additional `grid.bottom` space so tick labels stay visible above it.
        //
        // xLabelY is the vertical center of the tick labels; add half font size to approximate the
        // tick-label "bottom edge" and then center the axis title within the remaining space.
        const xTickLabelsBottom = xLabelY + currentOptions.theme.fontSize * 0.5;
        const hasSliderZoom = currentOptions.dataZoom?.some((z) => z?.type === 'slider') ?? false;
        const sliderTrackHeightCssPx = 32; // Keep in sync with ChartGPU/createDataZoomSlider defaults.
        const bottomLimitCss = hasSliderZoom ? canvasCssHeight - sliderTrackHeightCssPx : canvasCssHeight;
        const xTitleY = (xTickLabelsBottom + bottomLimitCss) / 2;

        // Collect label data for callback (worker mode)
        const axisLabel: AxisLabel = { axis: 'x', text: xAxisName, x: offsetX + xCenter, y: offsetY + xTitleY, anchor: 'middle', isTitle: true };
        collectedXLabels.push(axisLabel);

        // Add to DOM overlay if it exists (main thread mode)
        if (axisLabelOverlay) {
          const span = axisLabelOverlay.addLabel(xAxisName, offsetX + xCenter, offsetY + xTitleY, {
            fontSize: axisNameFontSize,
            color: currentOptions.theme.textColor,
            anchor: 'middle',
          });
          styleAxisLabelSpan(span, axisLabel, currentOptions.theme);
        }
      }

      const yAxisName = currentOptions.yAxis.name?.trim() ?? '';
      if (yAxisName.length > 0) {
        // In DOM mode: measure actual rendered label widths
        // In worker mode: estimate based on character count and font size
        const maxTickLabelWidth =
          ySpans.length === 0
            ? estimateMaxYTickLabelWidth(collectedYLabels, currentOptions.theme.fontSize)
            : ySpans.reduce((max, s) => Math.max(max, s.getBoundingClientRect().width), 0);

        const yCenter = (plotTopCss + plotBottomCss) / 2;
        const yTickLabelLeft = yLabelX - maxTickLabelWidth;
        const yTitleX = yTickLabelLeft - LABEL_PADDING_CSS_PX - axisNameFontSize * 0.5;

        // Collect label data for callback (worker mode)
        const axisLabel: AxisLabel = { axis: 'y', text: yAxisName, x: offsetX + yTitleX, y: offsetY + yCenter, anchor: 'middle', rotation: -90, isTitle: true };
        collectedYLabels.push(axisLabel);

        // Add to DOM overlay if it exists (main thread mode)
        if (axisLabelOverlay) {
          const span = axisLabelOverlay.addLabel(yAxisName, offsetX + yTitleX, offsetY + yCenter, {
            fontSize: axisNameFontSize,
            color: currentOptions.theme.textColor,
            anchor: 'middle',
            rotation: -90,
          });
          styleAxisLabelSpan(span, axisLabel, currentOptions.theme);
        }
      }

      // Emit axis labels callback when DOM overlays are disabled (worker mode)
      if (!domOverlaysEnabled && callbacks?.onAxisLabelsUpdate) {
        callbacks.onAxisLabelsUpdate(collectedXLabels, collectedYLabels);
      }
    }

    // Generate annotation labels (DOM overlay in main-thread mode, callback in worker mode).
    // PERFORMANCE: Reuse cached canvas dimensions from GPU overlay processing above
    const shouldUpdateAnnotationLabels = hasCartesianSeries && (
      (annotationOverlay && overlayContainer) ||
      (!domOverlaysEnabled && callbacks?.onAnnotationsUpdate)
    );

    if (shouldUpdateAnnotationLabels) {
      // PERFORMANCE: Reuse canvasCssWidthForAnnotations and canvasCssHeightForAnnotations computed above
      if (
        canvas &&
        canvasCssWidthForAnnotations > 0 &&
        canvasCssHeightForAnnotations > 0 &&
        plotWidthCss > 0 &&
        plotHeightCss > 0
      ) {
        const offsetX = isHTMLCanvasElement(canvas) ? canvas.offsetLeft : 0;
        const offsetY = isHTMLCanvasElement(canvas) ? canvas.offsetTop : 0;

        annotationOverlay?.clear();

        const toCssRgba = (color: string, opacity01: number): string => {
          const base = parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);
          const a = clamp01(base[3] * clamp01(opacity01));
          const r = Math.round(clamp01(base[0]) * 255);
          const g = Math.round(clamp01(base[1]) * 255);
          const b = Math.round(clamp01(base[2]) * 255);
          return `rgba(${r}, ${g}, ${b}, ${a})`;
        };

        const formatNumber = (n: number, decimals?: number): string => {
          if (!Number.isFinite(n)) return '';
          if (decimals == null) return String(n);
          const d = Math.min(20, Math.max(0, Math.floor(decimals)));
          return n.toFixed(d);
        };

        // PERFORMANCE: Cache regex pattern (compiled once per render, reused for all templates)
        const templateRegex = /\{(x|y|value|name)\}/g;
        const renderTemplate = (
          template: string,
          values: Readonly<{ x?: number; y?: number; value?: number; name?: string }>,
          decimals?: number
        ): string => {
          // PERFORMANCE: Reset regex lastIndex to ensure consistent behavior
          templateRegex.lastIndex = 0;
          return template.replace(templateRegex, (_m, key) => {
            if (key === 'name') return values.name ?? '';
            const v = (values as any)[key] as number | undefined;
            return v == null ? '' : formatNumber(v, decimals);
          });
        };

        const mapAnchor = (anchor: 'start' | 'center' | 'end' | undefined): TextOverlayAnchor => {
          switch (anchor) {
            case 'center':
              return 'middle';
            case 'end':
              return 'end';
            case 'start':
            default:
              return 'start';
          }
        };

        // PERFORMANCE: Skip label processing if no annotations
        const annotations = currentOptions.annotations ?? [];
        if (annotations.length === 0) {
          if (!domOverlaysEnabled && callbacks?.onAnnotationsUpdate) {
            callbacks.onAnnotationsUpdate([]);
          }
        } else {
          const labelsOut: AnnotationLabelData[] = [];

          for (let i = 0; i < annotations.length; i++) {
            const a = annotations[i]!;

            const labelCfg = a.label;
            const wantsLabel = labelCfg != null || a.type === 'text';
            if (!wantsLabel) continue;

          // Compute anchor point (canvas-local CSS px).
          let anchorXCss: number | null = null;
          let anchorYCss: number | null = null;
          let values: { x?: number; y?: number; value?: number; name?: string } = { name: a.id ?? '' };

          switch (a.type) {
            case 'lineX': {
              const xClip = xScale.scale(a.x);
              const xCss = clipXToCanvasCssPx(xClip, canvasCssWidthForAnnotations);
              anchorXCss = xCss;
              anchorYCss = plotTopCss;
              values = { ...values, x: a.x, value: a.x };
              break;
            }
            case 'lineY': {
              const yClip = yScale.scale(a.y);
              const yCss = clipYToCanvasCssPx(yClip, canvasCssHeightForAnnotations);
              anchorXCss = plotLeftCss;
              anchorYCss = yCss;
              values = { ...values, y: a.y, value: a.y };
              break;
            }
            case 'point': {
              const xClip = xScale.scale(a.x);
              const yClip = yScale.scale(a.y);
              const xCss = clipXToCanvasCssPx(xClip, canvasCssWidthForAnnotations);
              const yCss = clipYToCanvasCssPx(yClip, canvasCssHeightForAnnotations);
              anchorXCss = xCss;
              anchorYCss = yCss;
              values = { ...values, x: a.x, y: a.y, value: a.y };
              break;
            }
            case 'text': {
              if (a.position.space === 'data') {
                const xClip = xScale.scale(a.position.x);
                const yClip = yScale.scale(a.position.y);
                const xCss = clipXToCanvasCssPx(xClip, canvasCssWidthForAnnotations);
                const yCss = clipYToCanvasCssPx(yClip, canvasCssHeightForAnnotations);
                anchorXCss = xCss;
                anchorYCss = yCss;
                values = { ...values, x: a.position.x, y: a.position.y, value: a.position.y };
              } else {
                const xCss = plotLeftCss + a.position.x * plotWidthCss;
                const yCss = plotTopCss + a.position.y * plotHeightCss;
                anchorXCss = xCss;
                anchorYCss = yCss;
                values = { ...values, x: a.position.x, y: a.position.y, value: a.position.y };
              }
              break;
            }
            default:
              assertUnreachable(a);
          }

          if (anchorXCss == null || anchorYCss == null || !Number.isFinite(anchorXCss) || !Number.isFinite(anchorYCss)) {
            continue;
          }

          const dx = labelCfg?.offset?.[0] ?? 0;
          const dy = labelCfg?.offset?.[1] ?? 0;
          const x = anchorXCss + dx;
          const y = anchorYCss + dy;

          // Label text selection (explicit > template > defaults).
          const text =
            labelCfg?.text ??
            (labelCfg?.template
              ? renderTemplate(labelCfg.template, values, labelCfg.decimals)
              : labelCfg
                ? (() => {
                    const defaultTemplate =
                      a.type === 'lineX'
                        ? 'x={x}'
                        : a.type === 'lineY'
                          ? 'y={y}'
                          : a.type === 'point'
                            ? '({x}, {y})'
                            : a.type === 'text'
                              ? a.text
                              : '';
                    return defaultTemplate.includes('{')
                      ? renderTemplate(defaultTemplate, values, labelCfg.decimals)
                      : defaultTemplate;
                  })()
                : a.type === 'text'
                  ? a.text
                  : '');

          const trimmed = typeof text === 'string' ? text.trim() : '';
          if (trimmed.length === 0) continue;

          const anchor = mapAnchor(labelCfg?.anchor);
          const color = a.style?.color ?? currentOptions.theme.textColor;
          const fontSize = currentOptions.theme.fontSize;

          const bg = labelCfg?.background;
          const bgColor =
            bg?.color != null ? toCssRgba(bg.color, bg.opacity ?? 1) : undefined;
          const padding = (() => {
            const p = bg?.padding;
            if (typeof p === 'number' && Number.isFinite(p)) return [p, p, p, p] as const;
            if (Array.isArray(p) && p.length === 4 && p.every((n) => typeof n === 'number' && Number.isFinite(n))) {
              return [p[0], p[1], p[2], p[3]] as const;
            }
            return bg ? ([2, 4, 2, 4] as const) : undefined;
          })();
          const borderRadius =
            typeof bg?.borderRadius === 'number' && Number.isFinite(bg.borderRadius) ? bg.borderRadius : undefined;

          const labelData: AnnotationLabelData = {
            text: trimmed,
            x: offsetX + x,
            y: offsetY + y,
            anchor,
            color,
            fontSize,
            ...(bgColor
              ? {
                  background: {
                    backgroundColor: bgColor,
                    ...(padding ? { padding } : {}),
                    ...(borderRadius != null ? { borderRadius } : {}),
                  },
                }
              : {}),
          };

          labelsOut.push(labelData);

            if (annotationOverlay) {
              const span = annotationOverlay.addLabel(trimmed, labelData.x, labelData.y, {
                fontSize,
                color,
                anchor,
              });
              if (labelData.background) {
                span.style.backgroundColor = labelData.background.backgroundColor;
                span.style.display = 'inline-block';
                span.style.boxSizing = 'border-box';
                if (labelData.background.padding) {
                  const [t, r, b, l] = labelData.background.padding;
                  span.style.padding = `${t}px ${r}px ${b}px ${l}px`;
                }
                if (labelData.background.borderRadius != null) {
                  span.style.borderRadius = `${labelData.background.borderRadius}px`;
                }
              }
            }
          }

          if (!domOverlaysEnabled && callbacks?.onAnnotationsUpdate) {
            callbacks.onAnnotationsUpdate(labelsOut);
          }
        }
      } else {
        annotationOverlay?.clear();
        if (!domOverlaysEnabled && callbacks?.onAnnotationsUpdate) {
          callbacks.onAnnotationsUpdate([]);
        }
      }
    }
  };

  const handlePointerEvent: RenderCoordinator['handlePointerEvent'] = (event) => {
    assertNotDisposed();
    if (domOverlaysEnabled) {
      // When DOM overlays are enabled, ignore handlePointerEvent (use native DOM events instead)
      return;
    }

    const canvas = gpuContext.canvas;
    if (!canvas) return;

    // Validate event coordinates (guard against NaN/Infinity from worker thread serialization issues)
    if (
      !Number.isFinite(event.x) ||
      !Number.isFinite(event.y) ||
      !Number.isFinite(event.gridX) ||
      !Number.isFinite(event.gridY) ||
      !Number.isFinite(event.plotWidthCss) ||
      !Number.isFinite(event.plotHeightCss)
    ) {
      return;
    }

    // Use pre-computed grid coordinates from event
    const { type, x, y, gridX, gridY, plotWidthCss, plotHeightCss, isInGrid } = event;

    if (type === 'leave') {
      pointerState = { ...pointerState, isInGrid: false, hasPointer: false };
      crosshairRenderer.setVisible(false);
      lastTooltipContent = null;
      lastTooltipX = null;
      lastTooltipY = null;
      
      hideTooltipInternal();
      emitCrosshairCallback(null);
      emitHoverCallback(null);
      
      setInteractionXInternal(null, 'mouse');
      requestRender();
      return;
    }

    if (type === 'move') {
      // Update pointer state for hover/crosshair
      pointerState = {
        source: 'mouse',
        x,
        y,
        gridX,
        gridY,
        isInGrid,
        hasPointer: true,
      };

      requestRender();
      return;
    }

    if (type === 'click') {
      // Perform hit testing for click events
      if (!callbacks?.onClickData) return;

      let nearest: NearestPointMatch | null = null;
      let pieSlice: PieSliceMatch | null = null;
      let candlestick: CandlestickMatch | null = null;

      // Use cached interaction scales and render series from last render
      if (isInGrid && lastInteractionScales) {
        // Pie slice hit testing
        pieSlice = findPieSliceAtPointer(
          renderSeries,
          gridX,
          gridY,
          plotWidthCss,
          plotHeightCss
        );

        // Candlestick hit testing
        if (!pieSlice) {
          const candlestickResult = findCandlestickAtPointer(
            renderSeries,
            gridX,
            gridY,
            lastInteractionScales
          );
          if (candlestickResult) {
            candlestick = {
              seriesIndex: candlestickResult.seriesIndex,
              dataIndex: candlestickResult.params.dataIndex,
              point: candlestickResult.match.point,
            };
          }
        }

        // Nearest point hit testing
        if (!pieSlice && !candlestick) {
          nearest = findNearestPoint(
            renderSeries,
            gridX,
            gridY,
            lastInteractionScales.xScale,
            lastInteractionScales.yScale,
            20 // maxDistance in CSS pixels
          );
        }
      }

      callbacks.onClickData({
        x,
        y,
        gridX,
        gridY,
        isInGrid,
        nearest,
        pieSlice,
        candlestick,
      });
      return;
    }

    if (type === 'wheel') {
      // Handle mouse wheel zoom (only when inside grid and zoom is enabled)
      if (!isInGrid || !zoomState) return;
      
      const deltaX = event.deltaX ?? 0;
      const deltaY = event.deltaY ?? 0;
      const deltaMode = event.deltaMode ?? 0;
      
      // Normalize delta to CSS pixels
      const normalizeWheelDelta = (delta: number, basis: number): number => {
        if (!Number.isFinite(delta) || delta === 0) return 0;
        
        switch (deltaMode) {
          case 1: // DOM_DELTA_LINE
            return delta * 16;
          case 2: // DOM_DELTA_PAGE
            return delta * (Number.isFinite(basis) && basis > 0 ? basis : 800);
          default: // DOM_DELTA_PIXEL
            return delta;
        }
      };
      
      const deltaYCss = normalizeWheelDelta(deltaY, plotHeightCss);
      const deltaXCss = normalizeWheelDelta(deltaX, plotWidthCss);
      
      // Check if horizontal scroll is dominant (pan operation)
      if (Math.abs(deltaXCss) > Math.abs(deltaYCss) && deltaXCss !== 0) {
        const { start, end } = zoomState.getRange();
        const span = end - start;
        if (!Number.isFinite(span) || span === 0) return;
        
        // Convert horizontal scroll delta to percent pan
        // Positive deltaX = scroll right = pan right (show earlier data)
        const deltaPct = (deltaXCss / plotWidthCss) * span;
        if (!Number.isFinite(deltaPct) || deltaPct === 0) return;
        
        zoomState.pan(deltaPct);
        return;
      }
      
      // Vertical scroll zoom logic
      if (deltaYCss === 0) return;
      
      // Calculate zoom factor from wheel delta
      // Positive delta = scroll down = zoom out; negative = zoom in
      const abs = Math.abs(deltaYCss);
      if (!Number.isFinite(abs) || abs === 0) return;
      
      // Cap extreme deltas (some devices can emit huge values)
      const capped = Math.min(abs, 200);
      const sensitivity = 0.002;
      const factor = Math.exp(capped * sensitivity);
      
      if (!(factor > 1)) return;
      
      const { start, end } = zoomState.getRange();
      const span = end - start;
      if (!Number.isFinite(span) || span === 0) return;
      
      // Calculate zoom center based on pointer position in plot
      const r = Math.min(1, Math.max(0, gridX / plotWidthCss));
      const centerPct = Math.min(100, Math.max(0, start + r * span));
      
      // Apply zoom
      if (deltaYCss < 0) {
        zoomState.zoomIn(centerPct, factor);
      } else {
        zoomState.zoomOut(centerPct, factor);
      }
      
      requestRender();
      return;
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

    eventManager?.dispose();
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

    for (let i = 0; i < candlestickRenderers.length; i++) {
      candlestickRenderers[i].dispose();
    }
    candlestickRenderers.length = 0;

    barRenderer.dispose();

    gridRenderer.dispose();
    xAxisRenderer.dispose();
    yAxisRenderer.dispose();
    referenceLineRenderer.dispose();
    annotationMarkerRenderer.dispose();
    referenceLineRendererMsaa.dispose();
    annotationMarkerRendererMsaa.dispose();

    destroyTexture(mainColorTexture);
    destroyTexture(overlayMsaaTexture);
    mainColorTexture = null;
    mainColorView = null;
    overlayMsaaTexture = null;
    overlayMsaaView = null;
    overlayBlitBindGroup = null;

    dataStore.dispose();

    // Dispose tooltip/legend before the text overlay (all touch container positioning).
    tooltip?.dispose();
    tooltip = null;
    legend?.dispose();
    axisLabelOverlay?.dispose();
    annotationOverlay?.dispose();
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
      hideTooltipInternal();
      emitCrosshairCallback(null);
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
    handlePointerEvent,
    render,
    dispose,
  };
}

