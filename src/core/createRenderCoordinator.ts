import type {
  ResolvedBarSeriesConfig,
  ResolvedCandlestickSeriesConfig,
  ResolvedChartGPUOptions,
  ResolvedPieSeriesConfig,
} from '../config/OptionResolver';
import type {
  AnimationConfig,
  AnnotationConfig,
  DataPoint,
  DataPointTuple,
  OHLCDataPoint,
  PieCenter,
  PieRadius,
} from '../config/types';
import { GPUContext, isHTMLCanvasElement as isHTMLCanvasElementGPU } from './GPUContext';
import { createDataStore } from '../data/createDataStore';
import { sampleSeriesDataPoints } from '../data/sampleSeries';
import { ohlcSample } from '../data/ohlcSample';
import {
  sliceVisibleRangeByX,
  sliceVisibleRangeByOHLC,
  isTupleOHLCDataPoint as isTupleOHLCDataPointImported,
} from './renderCoordinator/data/computeVisibleSlice';
import { 
  getPointCount, 
  getX, 
  getY, 
  getSize,
  computeRawBoundsFromCartesianData 
} from '../data/cartesianData';
import type { CartesianSeriesData } from '../config/types';
import { renderAxisLabels } from './renderCoordinator/render/renderAxisLabels';
import { renderAnnotationLabels } from './renderCoordinator/render/renderAnnotationLabels';
import { prepareOverlays } from './renderCoordinator/render/renderOverlays';
import { processAnnotations } from './renderCoordinator/annotations/processAnnotations';
import {
  prepareSeries,
  encodeScatterDensityCompute,
  renderSeries as renderSeriesPass,
  renderAboveSeriesAnnotations,
} from './renderCoordinator/render/renderSeries';
import { createAxisRenderer } from '../renderers/createAxisRenderer';
import { createGridRenderer } from '../renderers/createGridRenderer';
import type { GridArea } from '../renderers/createGridRenderer';
import { createRendererPool } from './renderCoordinator/renderers/rendererPool';
import { createTextureManager, ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT, MAIN_SCENE_MSAA_SAMPLE_COUNT } from './renderCoordinator/gpu/textureManager';
import { createCrosshairRenderer } from '../renderers/createCrosshairRenderer';
import { createHighlightRenderer } from '../renderers/createHighlightRenderer';
import { createReferenceLineRenderer } from '../renderers/createReferenceLineRenderer';
import type { ReferenceLineInstance } from '../renderers/createReferenceLineRenderer';
import { createAnnotationMarkerRenderer } from '../renderers/createAnnotationMarkerRenderer';
import type { AnnotationMarkerInstance } from '../renderers/createAnnotationMarkerRenderer';
import { createEventManager } from '../interaction/createEventManager';
import type { PipelineCache } from './PipelineCache';
import type { ChartGPUEventPayload } from '../interaction/createEventManager';
import { createInsideZoom } from '../interaction/createInsideZoom';
import { createZoomState } from '../interaction/createZoomState';
import type { ZoomRange, ZoomState } from '../interaction/createZoomState';
import { findNearestPoint } from '../interaction/findNearestPoint';
import { findPointsAtX } from '../interaction/findPointsAtX';
import { computeCandlestickBodyWidthRange, findCandlestick } from '../interaction/findCandlestick';
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
import type { ZoomChangeSourceKind } from '../ChartGPU';

export interface GPUContextLike {
  readonly device: GPUDevice | null;
  readonly canvas: HTMLCanvasElement | null;
  readonly canvasContext: GPUCanvasContext | null;
  readonly preferredFormat: GPUTextureFormat | null;
  readonly initialized: boolean;
  readonly devicePixelRatio?: number;
}

/** Type guard to check if canvas is HTMLCanvasElement (has DOM-specific properties). */
const isHTMLCanvasElement = isHTMLCanvasElementGPU;

/** Gets canvas CSS width - clientWidth for HTMLCanvasElement */
function getCanvasCssWidth(canvas: HTMLCanvasElement | null): number {
  if (!canvas) {
    return 0;
  }

  return canvas.clientWidth;
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
  canvas: HTMLCanvasElement | null,
): Readonly<{ width: number; height: number }> {
  if (!canvas) return { width: 0, height: 0 };
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // HTMLCanvasElement exposes `.width/.height` in device pixels.
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
  appendData(seriesIndex: number, newPoints: CartesianSeriesData | ReadonlyArray<OHLCDataPoint>): void;
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
  onZoomRangeChange(cb: (range: Readonly<{ start: number; end: number }>, sourceKind?: ZoomChangeSourceKind) => void): () => void;
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
   * Optional shared cache for shader modules + render pipelines (CGPU-PIPELINE-CACHE).
   * Opt-in only: if omitted, coordinator/renderers behave identically.
   */
  readonly pipelineCache?: PipelineCache;
}>;

type Bounds = Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_TICK_COUNT: number = 5;

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

/**
 * Mutable columnar cartesian data store (runtime).
 * - x, y: number[] - coordinate columns
 * - size?: (number|undefined)[] - optional size column (aligned with x/y when present)
 */
type MutableXYColumns = {
  x: number[];
  y: number[];
  size?: (number | undefined)[];
};

/**
 * Helper: Convert CartesianSeriesData to mutable columnar format for runtime storage.
 * Used for streaming appends without per-point allocations.
 */
const cartesianDataToMutableColumns = (data: CartesianSeriesData): MutableXYColumns => {
  const n = getPointCount(data);
  if (n === 0) return { x: [], y: [] };

  const x: number[] = new Array(n);
  const y: number[] = new Array(n);
  let hasSizeValues = false;
  let size: (number | undefined)[] | undefined;

  // Check if any point has a size value
  for (let i = 0; i < n; i++) {
    x[i] = getX(data, i);
    y[i] = getY(data, i);
    const s = getSize(data, i);
    if (s !== undefined) {
      hasSizeValues = true;
      if (!size) {
        // Backfill with undefined for prior points
        size = new Array(i);
      }
      size[i] = s;
    } else if (size) {
      size[i] = undefined;
    }
  }

  if (hasSizeValues && size) {
    return { x, y, size };
  }

  return { x, y };
};

/**
 * Extends existing bounds with new CartesianSeriesData.
 * Avoids per-point allocations for typed arrays by using direct accessors.
 */
const extendBoundsWithCartesianData = (bounds: Bounds | null, data: CartesianSeriesData): Bounds | null => {
  const newBounds = computeRawBoundsFromCartesianData(data);
  if (!newBounds) return bounds;
  if (!bounds) return newBounds;

  // Merge the two bounds
  let xMin = Math.min(bounds.xMin, newBounds.xMin);
  let xMax = Math.max(bounds.xMax, newBounds.xMax);
  let yMin = Math.min(bounds.yMin, newBounds.yMin);
  let yMax = Math.max(bounds.yMax, newBounds.yMax);

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

    // Cartesian series (line, area, bar, scatter): use CartesianSeriesData accessors
    const data = seriesConfig.data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const x = getX(data, i);
      const y = getY(data, i);
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
  // - devicePixelRatio for CSS-to-device conversion
  // This allows renderers to multiply margins by DPR and subtract from canvas dimensions

  const dpr = gpuContext.devicePixelRatio ?? 1;
  const devicePixelRatio = (Number.isFinite(dpr) && dpr > 0) ? dpr : 1;

  // Validate and sanitize canvas dimensions (device pixels)
  // Canvas dimensions should be set by GPUContext initialization/resize, but guard against edge cases:
  // - Race conditions during initialization
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
    devicePixelRatio,                 // Explicit DPR (validated above)
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

// Alias for imported function to maintain compatibility with existing code
const isTupleOHLCDataPoint = isTupleOHLCDataPointImported;

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
  readonly tickFormatter?: (value: number) => string | null;
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
    tickFormatter,
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
      const label = tickFormatter ? tickFormatter(v) : formatTimeTickValue(v, visibleRangeMs);
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

/**
 * Computes Y-axis domain bounds from the visible/rendered series data.
 * This avoids scanning the full raw dataset when yAxis.autoBounds === 'visible'.
 * 
 * Performance: O(n) where n = total points across all visible series data.
 * This is called only when renderSeries changes (zoom/pan/data updates), not per-frame.
 */
const computeVisibleYBounds = (series: ResolvedChartGPUOptions['series']): Bounds => {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    // Pie series are non-cartesian; they don't participate in y bounds.
    if (seriesConfig.type === 'pie') continue;

    // Candlestick series: scan low/high from visible data
    if (seriesConfig.type === 'candlestick') {
      const visibleOHLC = seriesConfig.data as ReadonlyArray<OHLCDataPoint>;
      for (let i = 0; i < visibleOHLC.length; i++) {
        const p = visibleOHLC[i]!;
        const low = isTupleOHLCDataPoint(p) ? p[3] : p.low;
        const high = isTupleOHLCDataPoint(p) ? p[4] : p.high;
        if (!Number.isFinite(low) || !Number.isFinite(high)) continue;

        // Use Math.min/max to handle inverted low/high gracefully
        const yLow = Math.min(low, high);
        const yHigh = Math.max(low, high);

        if (yLow < yMin) yMin = yLow;
        if (yHigh > yMax) yMax = yHigh;
      }
      continue;
    }

    // Cartesian series (line, area, bar, scatter): scan y from visible data
    const data = seriesConfig.data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const y = getY(data, i);
      if (!Number.isFinite(y)) continue;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  // Fallback for empty/invalid data: return safe default bounds
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
  }

  // Degenerate domain: add unit span to avoid zero-width range
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin: 0, xMax: 1, yMin, yMax };
};

const computeBaseYDomain = (
  options: ResolvedChartGPUOptions,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null,
  visibleBoundsOverride?: Bounds | null
): { readonly min: number; readonly max: number } => {
  // Explicit min/max ALWAYS take precedence over auto-bounds
  const explicitMin = finiteOrUndefined(options.yAxis.min);
  const explicitMax = finiteOrUndefined(options.yAxis.max);

  // If both min and max are explicit, use them directly (no auto-bounds needed)
  if (explicitMin !== undefined && explicitMax !== undefined) {
    return normalizeDomain(explicitMin, explicitMax);
  }

  // Determine which bounds to use based on autoBounds mode
  const autoBoundsMode = options.yAxis.autoBounds ?? 'visible';
  let bounds: Bounds;

  if (autoBoundsMode === 'visible' && visibleBoundsOverride) {
    // Use visible bounds from renderSeries (zoom-aware, computed from visible data only)
    bounds = visibleBoundsOverride;
  } else {
    // Use global bounds from full dataset (pre-zoom behavior, computed from all raw data)
    bounds = computeGlobalBounds(options.series, runtimeRawBoundsByIndex);
  }

  // Merge explicit bounds with computed bounds (partial override support)
  const yMin = explicitMin ?? bounds.yMin;
  const yMax = explicitMax ?? bounds.yMax;
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
  canvas: HTMLCanvasElement
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
    const data = seriesConfigs[s]!.data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const y = getY(data, i);
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
  gpuContext: GPUContext,
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
  const pipelineCache = callbacks?.pipelineCache;
  
  // DOM-dependent features (overlays, legends) require HTMLCanvasElement.
  const overlayContainer = isHTMLCanvasElement(gpuContext.canvas) ? gpuContext.canvas.parentElement : null;
  const axisLabelOverlay: TextOverlay | null = overlayContainer ? createTextOverlay(overlayContainer) : null;
  // Dedicated overlay for annotations (do not reuse axis label overlay).
  const annotationOverlay: TextOverlay | null = overlayContainer ? createTextOverlay(overlayContainer, { clip: true }) : null;

  const handleSeriesToggle = (seriesIndex: number, sliceIndex?: number): void => {
    if (disposed) return;

    const series = currentOptions.series;
    if (seriesIndex < 0 || seriesIndex >= series.length) return;

    const s = series[seriesIndex];
    if (!s) return;

    // Handle pie slice toggle
    if (sliceIndex !== undefined && s.type === 'pie') {
      const pieData = (s as ResolvedPieSeriesConfig).data;
      if (sliceIndex < 0 || sliceIndex >= pieData.length) return;

      const updatedData = pieData.map((slice, i) =>
        i === sliceIndex
          ? { ...slice, visible: slice.visible === false ? true : false }
          : slice
      );

      const updatedSeries = series.map((seriesItem, i) =>
        i === seriesIndex
          ? ({ ...seriesItem, data: updatedData } as typeof seriesItem)
          : seriesItem
      );

      setOptions({ ...currentOptions, series: updatedSeries });
      return;
    }

    // Toggle regular series visibility
    const updatedSeries = series.map((seriesItem, i) =>
      i === seriesIndex
        ? ({ ...seriesItem, visible: seriesItem.visible === false ? true : false } as typeof seriesItem)
        : seriesItem
    );

    // Update options with new series array
    setOptions({ ...currentOptions, series: updatedSeries });
  };

  const legend: Legend | null = overlayContainer && options.legend?.show!==false ? createLegend(overlayContainer, options.legend?.position, handleSeriesToggle) : null;
  // Text measurement for axis labels. Requires DOM context.
  const tickMeasureCtx: CanvasRenderingContext2D | null = (() => {
    if (typeof document === 'undefined') {
      // No DOM available (e.g., SSR or non-browser environment).
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

  const interpolateCartesianSeriesDataByIndex = (
    fromData: CartesianSeriesData,
    toData: CartesianSeriesData,
    n: number,
    t01: number,
    cache: DataPoint[] | null
  ): DataPoint[] | null => {
    if (n === 0) return cache ?? [];

    const out =
      cache && cache.length === n
        ? cache
        : (() => {
            const created: DataPoint[] = new Array(n);
            for (let i = 0; i < n; i++) {
              const x = getX(toData, i);
              created[i] = [x, 0] as const;
            }
            return created;
          })();

    const t = clamp01(t01);
    for (let i = 0; i < n; i++) {
      const xFrom = getX(fromData, i);
      const xTo = getX(toData, i);
      const yFrom = getY(fromData, i);
      const yTo = getY(toData, i);
      // Interpolate both x and y so scatter (and any series with shifting x) animates smoothly.
      // For series where x doesn't change (line, area, bar with fixed indices), lerp(x, x, t) = x.
      const x = Number.isFinite(xFrom) && Number.isFinite(xTo) ? lerp(xFrom, xTo, t) : xTo;
      const y = Number.isFinite(yFrom) && Number.isFinite(yTo) ? lerp(yFrom, yTo, t) : yTo;
      const p = out[i]!;
      if (isTupleDataPoint(p)) {
        (p as unknown as number[])[0] = x;
        (p as unknown as number[])[1] = y;
      } else {
        (p as any).x = x;
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
      // Data may be ReadonlyArray<DataPoint> OR MutableXYColumns (XYArraysData-compatible) at runtime,
      // so use getPointCount/getX/getY instead of .length / direct indexing.
      const aData = (a as unknown as { readonly data: CartesianSeriesData }).data;
      const bData = (b as unknown as { readonly data: CartesianSeriesData }).data;

      const aLen = getPointCount(aData);
      const bLen = getPointCount(bData);

      if (aLen !== bLen) {
        out[i] = b;
        continue;
      }
      if (bLen > MAX_ANIMATED_POINTS_PER_SERIES) {
        out[i] = b;
        continue;
      }

      const cache = caches?.cartesianDataBySeriesIndex[i] ?? null;
      const animatedData = interpolateCartesianSeriesDataByIndex(aData, bData, aLen, t01, cache);
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
  const warnedSamplingDefeatsFastPath = new Set<number>();

  // Coordinator-owned runtime series store.
  // - `runtimeRawDataByIndex[i]` owns mutable columnar data (MutableXYColumns) for cartesian series,
  //   or mutable OHLCDataPoint[] for candlestick series. Supports efficient streaming appends
  //   without per-point object allocations.
  // - `runtimeRawBoundsByIndex[i]` is incrementally updated to keep scale/bounds derivation cheap.
  let runtimeRawDataByIndex: Array<MutableXYColumns | OHLCDataPoint[] | null> = new Array(options.series.length).fill(null);
  let runtimeRawBoundsByIndex: Array<Bounds | null> = new Array(options.series.length).fill(null);

  // Baseline sampled series list derived from runtime raw data (used as the “full span” baseline).
  // Zoom-visible resampling is derived from this baseline + runtime raw as needed.
  let runtimeBaseSeries: ResolvedChartGPUOptions['series'] = currentOptions.series;

  // Zoom-aware sampled series list used for rendering + cartesian hit-testing.
  // Derived from `currentOptions.series` (which still includes baseline sampled `data`).
  let renderSeries: ResolvedChartGPUOptions['series'] = currentOptions.series;

  // Cache for visible y-bounds computed from renderSeries (for yAxis.autoBounds === 'visible').
  // Recomputed whenever renderSeries changes (zoom/pan/data updates).
  let cachedVisibleYBounds: Bounds | null = null;

  const shouldComputeVisibleYBounds = (opts: ResolvedChartGPUOptions): boolean => {
    const autoBoundsMode = opts.yAxis.autoBounds ?? 'visible';
    if (autoBoundsMode !== 'visible') return false;
    // If both bounds are explicit, auto-bounds (including visible) are never consulted.
    const explicitMin = finiteOrUndefined(opts.yAxis.min);
    const explicitMax = finiteOrUndefined(opts.yAxis.max);
    return !(explicitMin !== undefined && explicitMax !== undefined);
  };

  const recomputeCachedVisibleYBoundsIfNeeded = (): void => {
    if (shouldComputeVisibleYBounds(currentOptions)) {
      cachedVisibleYBounds = computeVisibleYBounds(renderSeries);
    } else {
      cachedVisibleYBounds = null;
    }
  };

  // Cache for sampled data with buffer zones - enables fast slicing during pan without resampling.
  interface SampledDataCache {
    data: CartesianSeriesData | ReadonlyArray<OHLCDataPoint>;
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

  // Zoom changes can fire multiple times per frame; slicing and visible-bounds recompute can be O(n).
  // Coalesce those updates to at most once per rendered frame.
  let sliceRenderSeriesDue = false;

  // Coalesced streaming appends (flushed at the start of `render()`).
  // Each entry is an array of batches (preserving original format to avoid per-point allocations).
  const pendingAppendByIndex = new Map<number, Array<CartesianSeriesData | ReadonlyArray<OHLCDataPoint>>>();

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

  // Helper functions for tooltip/legend management
  const showTooltipInternal = (x: number, y: number, content: string, _params: TooltipParams | TooltipParams[]) => {
    tooltip?.show(x, y, content);
  };

  const hideTooltipInternal = () => {
    tooltip?.hide();
  };

  const hideTooltip = () => {
    lastTooltipContent = null;
    lastTooltipX = null;
    lastTooltipY = null;
    hideTooltipInternal();
  };

  const updateLegend = (series: ResolvedChartGPUOptions['series'], theme: ResolvedChartGPUOptions['theme']) => {
    legend?.update(series, theme);
  };

  updateLegend(currentOptions.series, currentOptions.theme);

  let dataStore = createDataStore(device);

  const gridRenderer = createGridRenderer(device, { targetFormat, sampleCount: MAIN_SCENE_MSAA_SAMPLE_COUNT, pipelineCache });
  // Axis and crosshair renderers draw into the top overlay pass (swapchain, single-sample) — keep sampleCount: 1.
  const xAxisRenderer = createAxisRenderer(device, { targetFormat, pipelineCache });
  const yAxisRenderer = createAxisRenderer(device, { targetFormat, pipelineCache });
  const crosshairRenderer = createCrosshairRenderer(device, { targetFormat, pipelineCache });
  crosshairRenderer.setVisible(false);
  // Highlight renders into the top overlay pass (swapchain, single-sample) — keep sampleCount: 1.
  const highlightRenderer = createHighlightRenderer(device, { targetFormat, pipelineCache });
  highlightRenderer.setVisible(false);

  // MSAA for the *annotation overlay* (above-series) pass to reduce shimmer during zoom.
  // NOTE: In WebGPU, pipeline sampleCount must match the render pass attachment sampleCount.
  // The main scene renders into a 4x MSAA texture (resolved to a single-sample target), then:
  // - MSAA overlay pass: blit resolved main scene into an MSAA target + draw above-series annotations, resolve to swapchain
  // - Top overlay pass: draw crosshair/axes/highlight (single-sample) on top of the resolved swapchain
  // Below-series reference lines and annotation markers draw into the main MSAA pass.
  const referenceLineRenderer = createReferenceLineRenderer(device, { targetFormat, sampleCount: MAIN_SCENE_MSAA_SAMPLE_COUNT, pipelineCache });
  const annotationMarkerRenderer = createAnnotationMarkerRenderer(device, { targetFormat, sampleCount: MAIN_SCENE_MSAA_SAMPLE_COUNT, pipelineCache });
  const referenceLineRendererMsaa = createReferenceLineRenderer(device, {
    targetFormat,
    sampleCount: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT,
    pipelineCache,
  });
  const annotationMarkerRendererMsaa = createAnnotationMarkerRenderer(device, {
    targetFormat,
    sampleCount: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT,
    pipelineCache,
  });

  const textureManager = createTextureManager({ device, targetFormat, pipelineCache });

  const initialGridArea = computeGridArea(gpuContext, currentOptions);
  
  // Event manager requires HTMLCanvasElement (DOM events).
  const eventManager = isHTMLCanvasElement(gpuContext.canvas) 
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

    for (const [seriesIndex, batches] of pendingAppendByIndex) {
      if (batches.length === 0) continue;
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

        // Process each batch of OHLC data
        for (const batch of batches) {
          const ohlcPoints = batch as ReadonlyArray<OHLCDataPoint>;
          raw.push(...ohlcPoints);
          runtimeRawBoundsByIndex[seriesIndex] = extendBoundsWithOHLCDataPoints(
            runtimeRawBoundsByIndex[seriesIndex],
            ohlcPoints
          );
        }
      } else {
        // Handle other cartesian series (line, area, bar, scatter).
        let raw = runtimeRawDataByIndex[seriesIndex] as MutableXYColumns | null;
        if (!raw) {
          const seed = (s.rawData ?? s.data) as CartesianSeriesData;
          raw = cartesianDataToMutableColumns(seed);
          runtimeRawDataByIndex[seriesIndex] = raw;
          runtimeRawBoundsByIndex[seriesIndex] = s.rawBounds ?? computeRawBoundsFromCartesianData(seed);
        }

        // Optional fast-path: if the GPU buffer currently represents the full, unsampled line series,
        // we can append just the new points to the existing GPU buffer (no full re-upload).
        const canUseFastPath =
          s.type === 'line' && s.sampling === 'none' && isFullSpanZoomBefore && gpuSeriesKindByIndex[seriesIndex] === 'fullRawLine';

        // Process each batch of cartesian data
        for (const batch of batches) {
          const cartesianData = batch as CartesianSeriesData;

          if (canUseFastPath) {
            try {
              // Pass CartesianSeriesData directly to DataStore (avoids per-point allocations for typed arrays)
              dataStore.appendSeries(seriesIndex, cartesianData);
              appendedGpuThisFrame.add(seriesIndex);
            } catch {
              // If the DataStore has not been initialized for this index (or any other error occurs),
              // fall back to the normal full upload path later in render().
            }
          } else if (s.type === 'line' && s.sampling !== 'none' && !warnedSamplingDefeatsFastPath.has(seriesIndex)) {
            // Warn users that sampling defeats the incremental append optimization
            warnedSamplingDefeatsFastPath.add(seriesIndex);
            console.warn(
              `[ChartGPU] appendData() on series ${seriesIndex} with sampling='${s.sampling}' causes full buffer re-upload every frame. ` +
                `For optimal streaming performance, use sampling='none'. ` +
                `See docs/internal/INCREMENTAL_APPEND_OPTIMIZATION.md for details.`
            );
          }

          // Update runtime columnar storage (needed for resampling/slicing in non-fast-path cases).
          // Append each batch into MutableXYColumns using getPointCount/getX/getY/getSize accessors.
          const n = getPointCount(cartesianData);
          const rawLenBefore = raw.x.length;
          for (let i = 0; i < n; i++) {
            raw.x.push(getX(cartesianData, i));
            raw.y.push(getY(cartesianData, i));
            
            const sizeValue = getSize(cartesianData, i);
            // Maintain size alignment: if owned.size exists or new batch has any size, keep aligned
            if (sizeValue !== undefined) {
              if (!raw.size) {
                // Backfill undefined for prior points that didn't have size values
                raw.size = new Array(rawLenBefore + i);
              }
              raw.size.push(sizeValue);
            } else if (raw.size) {
              raw.size.push(undefined);
            }
          }

          // Update bounds using efficient CartesianSeriesData accessor
          runtimeRawBoundsByIndex[seriesIndex] = extendBoundsWithCartesianData(
            runtimeRawBoundsByIndex[seriesIndex],
            cartesianData
          );
        }
      }

      // Invalidate cache for this series since data has changed
      lastSampledData[seriesIndex] = null;
    }

    pendingAppendByIndex.clear();
    if (!didAppendAny) return false;

    // Dataset-aware zoom span constraints depend on raw point density.
    // When streaming appends add points, recompute and apply constraints so wheel+slider remain consistent.
    // Arm auto-scroll source kind before setSpanConstraints (clamping may emit onChange).
    if (canAutoScroll) pendingZoomSourceKind = 'auto-scroll';
    if (zoomState) {
      const constraints = computeEffectiveZoomSpanConstraints();
      const withConstraints = zoomState as unknown as {
        setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
      };
      withConstraints.setSpanConstraints?.(constraints.minSpan, constraints.maxSpan);
    }

    // Auto-scroll is applied only on append (not on `setOptions`).
    // Re-arm in case setSpanConstraints already triggered onChange and cleared.
    if (canAutoScroll && zoomRangeBefore && prevVisibleXDomain) {
      pendingZoomSourceKind = 'auto-scroll';
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
    // Fallback clear if no onChange fired (e.g. range unchanged).
    if (canAutoScroll) pendingZoomSourceKind = undefined;

    recomputeRuntimeBaseSeries();

    // If zoom is disabled or full-span, `renderSeries` is just the baseline.
    // (Zoom-visible resampling is handled by the unified flush when needed.)
    const zoomRangeAfter = zoomState?.getRange() ?? null;
    if (zoomRangeAfter == null || isFullSpanZoomRange(zoomRangeAfter)) {
      renderSeries = runtimeBaseSeries;
      // Recompute visible y-bounds from the baseline series
      recomputeCachedVisibleYBoundsIfNeeded();
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
        // Recompute visible y-bounds from the baseline series
        recomputeCachedVisibleYBoundsIfNeeded();
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
    canvas: HTMLCanvasElement,
    gridArea: GridArea
  ): { readonly plotWidthCss: number; readonly plotHeightCss: number } | null => {
    let canvasWidthCss: number;
    let canvasHeightCss: number;


    // HTMLCanvasElement: use getBoundingClientRect() for actual CSS dimensions
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    canvasWidthCss = rect.width;
    canvasHeightCss = rect.height;

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
    if (!canvas) return null;

    const plotSize = getPlotSizeCssPx(canvas, gridArea);
    if (!plotSize) return null;

    // IMPORTANT: grid-local CSS px ranges (0..plotWidth/Height), for interaction hit-testing.
    const xScale = createLinearScale().domain(domains.xDomain.min, domains.xDomain.max).range(0, plotSize.plotWidthCss);
    const yScale = createLinearScale().domain(domains.yDomain.min, domains.yDomain.max).range(plotSize.plotHeightCss, 0);

    const result = { xScale, yScale, plotWidthCss: plotSize.plotWidthCss, plotHeightCss: plotSize.plotHeightCss };

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

    // Iterate from last to first for correct z-ordering (last series drawn on top)
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      if (s.type !== 'pie') continue;
      // Skip invisible series (pie hit-testing should respect visibility)
      if (s.visible === false) continue;
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
    // Iterate from last to first for correct z-ordering (last series drawn on top)
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      if (s.type !== 'candlestick') continue;
      // Skip invisible series (candlestick hit-testing should respect visibility)
      if (s.visible === false) continue;

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
    requestRender();
  };

  const onMouseLeave = (_payload: ChartGPUEventPayload): void => {
    // Only clear interaction overlays for real pointer interaction.
    // If we're being driven by a sync-x, leaving the canvas shouldn't hide the overlays.
    if (pointerState.source !== 'mouse') return;

    pointerState = { ...pointerState, isInGrid: false, hasPointer: false };
    crosshairRenderer.setVisible(false);
    hideTooltip();
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
  let pendingZoomSourceKind: ZoomChangeSourceKind | undefined = undefined;
  const zoomRangeListeners = new Set<(range: Readonly<{ start: number; end: number }>, sourceKind?: ZoomChangeSourceKind) => void>();

  const emitZoomRange = (range: Readonly<{ start: number; end: number }>, sourceKind?: ZoomChangeSourceKind): void => {
    const snapshot = Array.from(zoomRangeListeners);
    for (const cb of snapshot) cb(range, sourceKind);
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

      // Cartesian series: runtime store is MutableXYColumns
      const rawCartesian =
        (runtimeRawDataByIndex[i] as MutableXYColumns | null) ??
        null;
      const pointCount = rawCartesian ? rawCartesian.x.length : getPointCount((s.rawData ?? s.data) as CartesianSeriesData);
      maxPoints = Math.max(maxPoints, pointCount);
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
        // Coalesce slicing (and visible-bounds recompute) to at most once per rendered frame.
        sliceRenderSeriesDue = true;
        // Immediate render for UI feedback (axes/crosshair/slider).
        requestRender();
        // Debounce resampling; the unified flush will do the work.
        scheduleZoomResample();
        // Capture source kind for this change; clear after emit so listeners see it.
        const sourceKind = pendingZoomSourceKind;
        emitZoomRange({ start: range.start, end: range.end }, sourceKind);
        pendingZoomSourceKind = undefined;
      });
    } else {
      const constraints = computeEffectiveZoomSpanConstraints();
      const withConstraints = zoomState as unknown as {
        setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
      };
      // If setSpanConstraints clamps the range (constraint violation), this is an internal adjustment
      // (not 'api' since this is driven by setOptions, not setZoomRange; not 'auto-scroll' since no append).
      // Leave sourceKind undefined (uncategorized).
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

      const raw = (s.rawData ?? s.data) as CartesianSeriesData;
      // Coordinator-owned: convert to mutable columnar format (streaming appends mutate this).
      const owned = cartesianDataToMutableColumns(raw);
      runtimeRawDataByIndex[i] = owned;
      runtimeRawBoundsByIndex[i] = s.rawBounds ?? computeRawBoundsFromCartesianData(raw);
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

      // Cartesian series: runtime store is MutableXYColumns (compatible with CartesianSeriesData at runtime)
      const rawCartesian: CartesianSeriesData =
        ((runtimeRawDataByIndex[i] as MutableXYColumns | null) as CartesianSeriesData) ?? 
        ((s.rawData ?? s.data) as CartesianSeriesData);
      const bounds = runtimeRawBoundsByIndex[i] ?? s.rawBounds ?? undefined;
      const baselineSampled = sampleSeriesDataPoints(rawCartesian, s.sampling, s.samplingThreshold);
      next[i] = { ...s, rawData: rawCartesian, rawBounds: bounds, data: baselineSampled };
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
      // Recompute visible y-bounds from the full baseline series
      recomputeCachedVisibleYBoundsIfNeeded();
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
            data: sliceVisibleRangeByOHLC(cache.data as ReadonlyArray<OHLCDataPoint>, visibleX.min, visibleX.max)
          };
        } else {
          next[i] = {
            ...baseline,
            data: sliceVisibleRangeByX(cache.data as CartesianSeriesData, visibleX.min, visibleX.max)
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
          data: sliceVisibleRangeByX(baseline.data as CartesianSeriesData, visibleX.min, visibleX.max)
        };
      }
    }

    renderSeries = next;
    // Recompute visible y-bounds from the sliced renderSeries
    recomputeCachedVisibleYBoundsIfNeeded();
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
          data: sampled,
          cachedRange: { min: bufferedMin, max: bufferedMax },
          timestamp: Date.now()
        };

        // Slice to actual visible range for renderSeries
        const visibleSampled = sliceVisibleRangeByOHLC(sampled, visibleX.min, visibleX.max);
        next[i] = { ...s, data: visibleSampled };
        continue;
      }

      // Cartesian series (line, area, bar, scatter).
      // Runtime store is MutableXYColumns (compatible with CartesianSeriesData at runtime)
      const rawCartesian: CartesianSeriesData =
        ((runtimeRawDataByIndex[i] as MutableXYColumns | null) as CartesianSeriesData) ?? 
        ((s.rawData ?? s.data) as CartesianSeriesData);
      // Slice to buffered range for sampling
      const bufferedRaw = sliceVisibleRangeByX(rawCartesian, bufferedMin, bufferedMax);

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
    // Recompute visible y-bounds from the updated renderSeries
    recomputeCachedVisibleYBoundsIfNeeded();
  }

  initRuntimeSeriesFromOptions();
  recomputeRuntimeBaseSeries();
  updateZoom();
  recomputeRenderSeries();
  lastSampledData = new Array(currentOptions.series.length).fill(null);

  const rendererPool = createRendererPool({ device, targetFormat, pipelineCache, sampleCount: MAIN_SCENE_MSAA_SAMPLE_COUNT });

  rendererPool.ensureAreaRendererCount(currentOptions.series.length);
  rendererPool.ensureLineRendererCount(currentOptions.series.length);
  rendererPool.ensureScatterRendererCount(currentOptions.series.length);
  rendererPool.ensureScatterDensityRendererCount(currentOptions.series.length);
  rendererPool.ensurePieRendererCount(currentOptions.series.length);
  rendererPool.ensureCandlestickRendererCount(currentOptions.series.length);

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
      const fromYBase = computeBaseYDomain(currentOptions, runtimeRawBoundsByIndex, cachedVisibleYBounds);
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

    if (likelyDataChanged) {
      // Series data or structure changed — full reset of runtime data state.
      runtimeBaseSeries = resolvedOptions.series;
      renderSeries = resolvedOptions.series;
      gpuSeriesKindByIndex = new Array(resolvedOptions.series.length).fill('unknown');
      lastSampledData = new Array(resolvedOptions.series.length).fill(null);
      cancelZoomResampleDebounce();
      zoomResampleDue = false;
      cancelScheduledFlush();
      initRuntimeSeriesFromOptions();
    }

    // Always refresh: annotations, themes, tooltip config, etc. may have changed.
    cachedVisibleYBounds = null;
    legend?.update(resolvedOptions.series, resolvedOptions.theme);
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
    rendererPool.ensureAreaRendererCount(nextCount);
    rendererPool.ensureLineRendererCount(nextCount);
    rendererPool.ensureScatterRendererCount(nextCount);
    rendererPool.ensureScatterDensityRendererCount(nextCount);
    rendererPool.ensurePieRendererCount(nextCount);
    rendererPool.ensureCandlestickRendererCount(nextCount);

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
      // Request a render to reflect the option changes immediately
      requestRender();
      return;
    }

    // Capture "to" snapshot after recompute.
    const toZoomRange = zoomState?.getRange() ?? null;
    const toXBase = computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
    const toXVisible = computeVisibleXDomain(toXBase, toZoomRange);
    const toYBase = computeBaseYDomain(currentOptions, runtimeRawBoundsByIndex, cachedVisibleYBounds);
    const toSeriesForTransition = renderSeries;

    const domainChanged = !isDomainEqual(fromSnapshot.xBaseDomain, toXBase) || !isDomainEqual(fromSnapshot.yBaseDomain, toYBase);

    const shouldAnimateUpdate = hasRenderedOnce && (domainChanged || likelyDataChanged);
    if (!shouldAnimateUpdate) {
      // Request a render even when not animating (e.g., theme changes, option updates)
      requestRender();
      return;
    }

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

    // Request initial render to kick off the animation.
    // Without this, the animation won't start until something else triggers a render
    // (e.g., pointer movement, which may not happen if the user is interacting with
    // UI overlays like the legend).
    requestRender();
  };

  const appendData: RenderCoordinator['appendData'] = (seriesIndex, newPoints) => {
    assertNotDisposed();
    if (!Number.isFinite(seriesIndex)) return;
    if (seriesIndex < 0 || seriesIndex >= currentOptions.series.length) return;
    if (!newPoints) return;

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

    // Check point count based on format (avoid assuming .length exists for all types)
    const pointCount = s.type === 'candlestick'
      ? (newPoints as ReadonlyArray<OHLCDataPoint>).length
      : getPointCount(newPoints as CartesianSeriesData);
    if (pointCount === 0) return;

    // Store batches in their original format to avoid per-point allocations for typed arrays.
    const existing = pendingAppendByIndex.get(seriesIndex);
    if (existing) {
      existing.push(newPoints);
    } else {
      pendingAppendByIndex.set(seriesIndex, [newPoints]);
    }

    // Coalesce appends + any required resampling + GPU streaming updates into a single flush.
    scheduleFlush();
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

    if (sliceRenderSeriesDue) {
      sliceRenderSeriesDue = false;
      sliceRenderSeriesToVisibleRange();
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
            case 'scatter': {
              // Cartesian series: use getPointCount for all CartesianSeriesData formats
              const dataLength = getPointCount(s.data as CartesianSeriesData);
              if (dataLength > 0) return true;
              break;
            }
            case 'candlestick': {
              const dataLength = (s.data as ReadonlyArray<OHLCDataPoint>).length;
              if (dataLength > 0) return true;
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
      : computeBaseYDomain(currentOptions, runtimeRawBoundsByIndex, cachedVisibleYBounds);
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
    // IMPORTANT: For GPU overlay annotations only, derive CSS size from device pixels to avoid
    // DOM `clientWidth/clientHeight` mismatch with the WebGPU render target size.
    const canvasCssForAnnotations = getCanvasCssSizeFromDevicePixels(canvas);
    const canvasCssWidthForAnnotations = canvasCssForAnnotations.width;
    const canvasCssHeightForAnnotations = canvasCssForAnnotations.height;

    const plotLeftCss = canvasCssWidthForAnnotations > 0 ? clipXToCanvasCssPx(plotClipRect.left, canvasCssWidthForAnnotations) : 0;
    const plotRightCss = canvasCssWidthForAnnotations > 0 ? clipXToCanvasCssPx(plotClipRect.right, canvasCssWidthForAnnotations) : 0;
    const plotTopCss = canvasCssHeightForAnnotations > 0 ? clipYToCanvasCssPx(plotClipRect.top, canvasCssHeightForAnnotations) : 0;
    const plotBottomCss = canvasCssHeightForAnnotations > 0 ? clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeightForAnnotations) : 0;
    const plotWidthCss = Math.max(0, plotRightCss - plotLeftCss);
    const plotHeightCss = Math.max(0, plotBottomCss - plotTopCss);

    // Process annotations (convert to GPU instances for rendering)
    const annotations: ReadonlyArray<AnnotationConfig> = hasCartesianSeries ? (currentOptions.annotations ?? []) : [];
    const annotationResult = processAnnotations({
      annotations,
      xScale,
      yScale,
      plotBounds: {
        leftCss: plotLeftCss,
        rightCss: plotRightCss,
        topCss: plotTopCss,
        bottomCss: plotBottomCss,
        widthCss: plotWidthCss,
        heightCss: plotHeightCss,
      },
      canvasCssWidth: canvasCssWidthForAnnotations,
      canvasCssHeight: canvasCssHeightForAnnotations,
      theme: currentOptions.theme,
    });

    // Extract annotation instances for GPU rendering
    const combinedReferenceLines: ReadonlyArray<ReferenceLineInstance> =
      annotationResult.linesBelow.length + annotationResult.linesAbove.length > 0
        ? [...annotationResult.linesBelow, ...annotationResult.linesAbove]
        : [];
    const combinedMarkers: ReadonlyArray<AnnotationMarkerInstance> =
      annotationResult.markersBelow.length + annotationResult.markersAbove.length > 0
        ? [...annotationResult.markersBelow, ...annotationResult.markersAbove]
        : [];
    const referenceLineBelowCount = annotationResult.linesBelow.length;
    const referenceLineAboveCount = annotationResult.linesAbove.length;
    const markerBelowCount = annotationResult.markersBelow.length;
    const markerAboveCount = annotationResult.markersAbove.length;

    // Story 6: compute an x tick count that prevents label overlap (time axis only).
    // IMPORTANT: compute in CSS px, since labels are DOM elements in CSS px.
    // Note: This requires HTMLCanvasElement for accurate CSS pixel measurement.
    const canvasCssWidth = getCanvasCssWidth(gpuContext.canvas);
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
        tickFormatter: currentOptions.xAxis.tickFormatter,
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

    // Prepare overlay renderers (grid, axes, crosshair, highlight)
    prepareOverlays(
      { gridRenderer, xAxisRenderer, yAxisRenderer, crosshairRenderer, highlightRenderer },
      {
        currentOptions,
        xScale,
        yScale,
        gridArea,
        xTickCount,
        hasCartesianSeries,
        effectivePointer,
        interactionScales,
        seriesForRender,
        withAlpha,
      }
    );

    // Tooltip: on hover, find matches and render tooltip near cursor.
    // Note: Tooltips require HTMLCanvasElement (DOM-specific positioning).
    if (effectivePointer.hasPointer && effectivePointer.isInGrid && currentOptions.tooltip?.show !== false) {
      const canvas = gpuContext.canvas;

      if (interactionScales && canvas && isHTMLCanvasElement(canvas)) {
        const formatter = currentOptions.tooltip?.formatter;
        const trigger = currentOptions.tooltip?.trigger ?? 'item';

        const containerX = canvas.offsetLeft + effectivePointer.x;
        const containerY = canvas.offsetTop + effectivePointer.y;

        if (effectivePointer.source === 'sync') {
          // Sync semantics:
          // - Tooltip should be driven by x only (no y).
          // - In 'axis' mode, show one entry per series nearest in x.
          // - In 'item' mode, pick a deterministic single entry (first matching series).
          // findPointsAtX handles visibility filtering internally and returns correct series indices
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
          // findPieSliceAtPointer handles visibility filtering internally and returns correct series indices
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
            // Hit-testing functions handle visibility filtering internally and return correct series indices
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
          // findPieSliceAtPointer handles visibility filtering internally and returns correct series indices
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
            // Hit-testing functions handle visibility filtering internally and return correct series indices
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

    // Compute maxRadiusCss for pie intro animation
    const plotSize = interactionScales ?? (canvas && isHTMLCanvasElement(canvas) ? getPlotSizeCssPx(canvas, gridArea) : null);
    const maxRadiusCss =
      plotSize && typeof plotSize.plotWidthCss === 'number' && typeof plotSize.plotHeightCss === 'number'
        ? 0.5 * Math.min(plotSize.plotWidthCss, plotSize.plotHeightCss)
        : 0;

    // Cache renderer pool state once per frame to avoid repeated object allocations.
    const poolState = rendererPool.getState();

    // Prepare all series renderers (area, line, bar, scatter, pie, candlestick)
    const seriesPreparation = prepareSeries(
      poolState,
      {
        currentOptions,
        seriesForRender,
        xScale,
        yScale,
        gridArea,
        dataStore,
        appendedGpuThisFrame,
        gpuSeriesKindByIndex,
        zoomState,
        visibleXDomain,
        introPhase,
        introProgress01,
        withAlpha,
        maxRadiusCss,
      }
    );

    const { visibleBarSeriesConfigs } = seriesPreparation;

    // Prepare bar renderer with animated scale if intro is running
    const introP = introPhase === 'running' ? clamp01(introProgress01) : 1;
    const yScaleForBars = introP < 1 ? createAnimatedBarYScale(yScale, plotClipRect, visibleBarSeriesConfigs, introP) : yScale;
    poolState.barRenderer.prepare(visibleBarSeriesConfigs, dataStore, xScale, yScaleForBars, gridArea);

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

    textureManager.ensureTextures(gridArea.canvasWidth, gridArea.canvasHeight);
    const texState = textureManager.getState();

    // Swapchain view for the resolved MSAA overlay pass and for the final (load) overlay pass.
    const swapchainView = gpuContext.canvasContext.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder({ label: 'renderCoordinator/commandEncoder' });
    const clearValue = parseCssColorToGPUColor(currentOptions.theme.backgroundColor, { r: 0, g: 0, b: 0, a: 1 });

    // Encode compute passes (scatter density) before the render pass.
    encodeScatterDensityCompute(
      poolState,
      seriesForRender,
      encoder
    );

    const mainPass = encoder.beginRenderPass({
      label: 'renderCoordinator/mainPass',
      colorAttachments: [
        {
          view: texState.mainColorView!,          // MSAA texture (4x)
          resolveTarget: texState.mainResolveView!, // single-sample resolve target
          clearValue,
          loadOp: 'clear',
          storeOp: 'discard',  // MSAA content discarded after resolve
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
    if (gridRenderer) {
      gridRenderer.render(mainPass);
    }

    // Render all series to the main pass with proper layering
    renderSeriesPass(
      poolState,
      { referenceLineRenderer, referenceLineRendererMsaa, annotationMarkerRenderer, annotationMarkerRendererMsaa },
      {
        hasCartesianSeries,
        gridArea,
        mainPass,
        plotScissor,
        introPhase,
        introProgress01,
        referenceLineBelowCount,
        markerBelowCount,
      },
      seriesPreparation
    );

    mainPass.end();

    // MSAA annotation overlay pass: blit main color → MSAA target, then draw above-series annotations.
    const overlayPass = encoder.beginRenderPass({
      label: 'renderCoordinator/annotationOverlayMsaaPass',
      colorAttachments: [
        {
          view: texState.overlayMsaaView!,
          resolveTarget: swapchainView,
          clearValue,
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
    });

    overlayPass.setPipeline(texState.overlayBlitPipeline);
    overlayPass.setBindGroup(0, texState.overlayBlitBindGroup!);
    overlayPass.draw(3);

    // Render above-series annotations to the overlay pass
    renderAboveSeriesAnnotations(
      { referenceLineRenderer, referenceLineRendererMsaa, annotationMarkerRenderer, annotationMarkerRendererMsaa },
      {
        hasCartesianSeries,
        gridArea,
        overlayPass,
        plotScissor,
        referenceLineBelowCount,
        referenceLineAboveCount,
        markerBelowCount,
        markerAboveCount,
      }
    );

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

    // Generate axis labels for DOM overlay
    renderAxisLabels(axisLabelOverlay, overlayContainer, {
      gpuContext,
      currentOptions,
      xScale,
      yScale,
      xTickValues,
      plotClipRect,
      visibleXRangeMs,
    });

    // Generate annotation labels (DOM overlay)
    renderAnnotationLabels(annotationOverlay, overlayContainer, {
      currentOptions,
      xScale,
      yScale,
      canvasCssWidthForAnnotations,
      canvasCssHeightForAnnotations,
      plotLeftCss,
      plotTopCss,
      plotWidthCss,
      plotHeightCss,
      canvas,
    });
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

    rendererPool.dispose();

    gridRenderer.dispose();
    xAxisRenderer.dispose();
    yAxisRenderer.dispose();
    referenceLineRenderer.dispose();
    annotationMarkerRenderer.dispose();
    referenceLineRendererMsaa.dispose();
    annotationMarkerRendererMsaa.dispose();

    textureManager.dispose();

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

