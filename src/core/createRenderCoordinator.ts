import type {
  ResolvedBarSeriesConfig,
  ResolvedCandlestickSeriesConfig,
  ResolvedChartGPUOptions,
  ResolvedPieSeriesConfig,
  ResolvedSeriesConfig,
} from "../config/OptionResolver";
import type {
  AnimationConfig,
  AnnotationConfig,
  DataPoint,
  DataPointTuple,
  OHLCDataPoint,
  PieCenter,
  PieRadius,
} from "../config/types";
import {
  GPUContext,
  isHTMLCanvasElement as isHTMLCanvasElementGPU,
} from "./GPUContext";
import { createDataStore } from "../data/createDataStore";
import { sampleSeriesDataPoints } from "../data/sampleSeries";
import { isGpuDecimationEligible } from "../data/gpuDecimationEligibility";
import { ohlcSample } from "../data/ohlcSample";
import {
  sliceVisibleRangeByX,
  sliceVisibleRangeByOHLC,
  isTupleOHLCDataPoint as isTupleOHLCDataPointImported,
} from "./renderCoordinator/data/computeVisibleSlice";
import {
  getPointCount,
  getX,
  getY,
  getSize,
  computeRawBoundsFromCartesianData,
  dropPrefixXY,
  appendIntoRingXY,
  createRingXYColumns,
  isRingXYColumns,
  isStagingRingView,
  createStagingRingView,
  stagingRingViewToRingXYColumns,
  type CoordinatorCartesianData,
  type RingXYColumns,
  type StagingRingView,
} from "../data/cartesianData";
import {
  demoteStagingViewAfterRebindFailure,
  isStagingThinPathEligible,
} from "./renderCoordinator/data/stagingThinPath";
import {
  normalizeMaxPoints,
  planMaxPointsWindow,
} from "../data/maxPointsWindow";
import type { CartesianSeriesData } from "../config/types";
import { renderAxisLabels, renderYAxisLabels } from "./renderCoordinator/render/renderAxisLabels";
import { renderAnnotationLabels } from "./renderCoordinator/render/renderAnnotationLabels";
import { prepareOverlays } from "./renderCoordinator/render/renderOverlays";
import {
  createOverlayPrepareMemo,
  clearOverlayPrepareMemo,
} from "./renderCoordinator/render/overlayPrepareMemo";
import {
  createFilterGapsCache,
} from "./renderCoordinator/render/filterGapsCache";
import {
  didSeriesDataLikelyChange,
  shouldRecomputeBaselineSampling,
  patchSeriesPresentationKeepingSampledData,
  didRawBoundsModeChange,
} from "./renderCoordinator/data/samplingDirty";
import { processAnnotations } from "./renderCoordinator/annotations/processAnnotations";
import {
  prepareSeries,
  encodeScatterDensityCompute,
  encodeDecimationCompute,
  renderSeries as renderSeriesPass,
  renderAboveSeriesAnnotations,
  type LastSetSeriesCache,
} from "./renderCoordinator/render/renderSeries";
import { createAxisRenderer } from "../renderers/createAxisRenderer";
import { createGridRenderer } from "../renderers/createGridRenderer";
import type { GridArea } from "../renderers/createGridRenderer";
import { createRendererPool } from "./renderCoordinator/renderers/rendererPool";
import {
  createTextureManager,
  ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT,
  MAIN_SCENE_MSAA_SAMPLE_COUNT,
} from "./renderCoordinator/gpu/textureManager";
import { createCrosshairRenderer } from "../renderers/createCrosshairRenderer";
import { createHighlightRenderer } from "../renderers/createHighlightRenderer";
import { createReferenceLineRenderer } from "../renderers/createReferenceLineRenderer";
import type { ReferenceLineInstance } from "../renderers/createReferenceLineRenderer";
import { createAnnotationMarkerRenderer } from "../renderers/createAnnotationMarkerRenderer";
import type { AnnotationMarkerInstance } from "../renderers/createAnnotationMarkerRenderer";
import { createEventManager } from "../interaction/createEventManager";
import type { PipelineCache } from "./PipelineCache";
import type { ChartGPUEventPayload } from "../interaction/createEventManager";
import { createInsideZoom } from "../interaction/createInsideZoom";
import { createZoomState } from "../interaction/createZoomState";
import type { ZoomRange, ZoomState } from "../interaction/createZoomState";
import { findNearestPoint } from "../interaction/findNearestPoint";
import { findPointsAtX } from "../interaction/findPointsAtX";
import {
  computeCandlestickBodyWidthRange,
  findCandlestick,
} from "../interaction/findCandlestick";
import { findPieSlice } from "../interaction/findPieSlice";
import { createLinearScale } from "../utils/scales";
import type { LinearScale } from "../utils/scales";
import {
  parseCssColorToGPUColor,
  parseCssColorToRgba01,
} from "../utils/colors";
import { createTextOverlay } from "../components/createTextOverlay";
import type {
  TextOverlay,
  TextOverlayAnchor,
} from "../components/createTextOverlay";
import { createLegend } from "../components/createLegend";
import type { Legend } from "../components/createLegend";
import { createTooltip } from "../components/createTooltip";
import type { Tooltip } from "../components/createTooltip";
import type { TooltipParams } from "../config/types";
import {
  formatTooltipAxis,
  formatTooltipItem,
} from "../components/formatTooltip";
import { createAnimationController } from "./createAnimationController";
import type { AnimationId } from "./createAnimationController";
import { getEasing } from "../utils/easing";
import type { EasingFunction } from "../utils/easing";
import type { ZoomChangeSourceKind } from "../ChartGPU";

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

/** Gets canvas CSS height - clientHeight for HTMLCanvasElement */
function getCanvasCssHeight(canvas: HTMLCanvasElement | null): number {
  if (!canvas) {
    return 0;
  }
  return canvas.clientHeight;
}

/**
 * Gets canvas CSS size derived strictly from device-pixel dimensions and DPR.
 *
 * This is intentionally different from `getCanvasCssWidth/Height(...)`:
 * - HTMLCanvasElement: `clientWidth/clientHeight` reflect DOM layout and can diverge (rounding, zoom, async resize)
 *   from the WebGPU render target size (`canvas.width/height` in device pixels).
 * - For GPU overlays that round-trip CSSÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âdevice pixels in-shader, we must derive CSS size from
 *   `canvas.width/height` + DPR to keep transforms consistent with the render target.
 *
 * NOTE: Use this for GPU overlay coordinate conversion only (reference lines, markers).
 * Keep DOM overlays (labels/tooltips) using `clientWidth/clientHeight` for layout correctness.
 */
function getCanvasCssSizeFromDevicePixels(
  canvas: HTMLCanvasElement | null,
): Readonly<{ width: number; height: number }> {
  if (!canvas) return { width: 0, height: 0 };
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  // HTMLCanvasElement exposes `.width/.height` in device pixels.
  return { width: canvas.width / dpr, height: canvas.height / dpr };
}

export interface RenderCoordinator {
  setOptions(resolvedOptions: ResolvedChartGPUOptions): void;
  /**
   * Appends new points to a cartesian series' runtime data without requiring a full
   * `setOptions(...)` resolver pass.
   *
   * Appends are coalesced and flushed once per render frame.
   *
   * When `options.maxPoints` is set (opt-in **per call**, not sticky series state),
   * applies the shared fixed-capacity **ring** policy (`planMaxPointsWindow`):
   * - if the new batch alone is ≥ `maxPoints`, keep only that batch’s tail
   *   (strict replace; previous points discarded);
   * - else fill up to `maxPoints`, then drop oldest on each overflow
   *   (GPU path uses modular ring writes — no full retained-window rewrite).
   * Peak retained length is **`maxPoints`**. Prefer this over sliding-window
   * full `setOption` for high-rate streaming.
   */
  appendData(
    seriesIndex: number,
    newPoints: CartesianSeriesData | ReadonlyArray<OHLCDataPoint>,
    options?: Readonly<{ maxPoints?: number }>,
  ): void;
  /**
   * Snapshot of coordinator-owned runtime series data for dual-store hit-test
   * resync (e.g. after tooltip re-enable following maxPoints dual-store skip).
   * Returns `null` when the series has no runtime columns yet.
   */
  getRuntimeSeriesData(
    seriesIndex: number,
  ): CartesianSeriesData | ReadonlyArray<OHLCDataPoint> | null;
  /** Runtime bounds for {@link getRuntimeSeriesData}, or `null`. */
  getRuntimeSeriesBounds(seriesIndex: number): Bounds | null;
  /**
   * Gets the current ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œinteraction xÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â in domain units (or `null` when inactive).
   *
   * This is derived from pointer movement inside the plot grid and can also be driven
   * externally via `setInteractionX(...)` (e.g. chart sync).
   */
  getInteractionX(): number | null;
  /**
   * Drives the chartÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢s crosshair + tooltip from a domain-space x value.
   *
   * Passing `null` clears the interaction (hides crosshair/tooltip).
   */
  setInteractionX(x: number | null, source?: unknown): void;
  /**
   * Subscribes to interaction x changes (domain units).
   *
   * Returns an unsubscribe function.
   */
  onInteractionXChange(
    callback: (x: number | null, source?: unknown) => void,
  ): () => void;
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
  onZoomRangeChange(
    cb: (
      range: Readonly<{ start: number; end: number }>,
      sourceKind?: ZoomChangeSourceKind,
    ) => void,
  ): () => void;
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

type Bounds = Readonly<{
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}>;

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = "bgra8unorm";
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
  typeof v === "number" && Number.isFinite(v) ? v : null;

const finiteOrUndefined = (v: number | undefined): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

// Story 5.17: CPU-side update interpolation can be expensive for very large series.
// We still animate domains for large series, but skip per-point y interpolation past this cap.
const MAX_ANIMATED_POINTS_PER_SERIES = 20_000;

const assertUnreachable = (value: never): never => {
  // Intentionally minimal message: this is used for compile-time exhaustiveness.
  throw new Error(`RenderCoordinator: unreachable value: ${String(value)}`);
};

const isTupleDataPoint = (p: DataPoint): p is DataPointTuple =>
  Array.isArray(p);

const getPointXY = (
  p: DataPoint,
): { readonly x: number; readonly y: number } => {
  if (isTupleDataPoint(p)) return { x: p[0], y: p[1] };
  return { x: p.x, y: p.y };
};

/**
 * Brand for coordinator-owned MutableXYColumns. User-supplied `{ x, y }` arrays
 * must never be treated as owned — append would mutate the caller's buffers.
 */
const OWNED_XY_COLUMNS = Symbol.for("chartgpu.ownedMutableXYColumns");

/**
 * Mutable columnar cartesian data store (runtime).
 * - x, y: number[] - coordinate columns
 * - size?: (number|undefined)[] - optional size column (aligned with x/y when present)
 * - Brand: only columns created by the coordinator carry OWNED_XY_COLUMNS.
 */
type MutableXYColumns = {
  x: number[];
  y: number[];
  size?: (number | undefined)[];
  [OWNED_XY_COLUMNS]?: true;
};

/** Runtime cartesian slot: owned columns, ring, staging view, or raw setOption ref. */
type RuntimeCartesianData = MutableXYColumns | CoordinatorCartesianData;

const brandOwnedColumns = (cols: MutableXYColumns): MutableXYColumns => {
  cols[OWNED_XY_COLUMNS] = true;
  return cols;
};

/**
 * Helper: Convert CartesianSeriesData to mutable columnar format for runtime storage.
 * Used for streaming appends without per-point allocations. Always returns a
 * **branded owned** copy — never the caller's arrays.
 */
const cartesianDataToMutableColumns = (
  data: CartesianSeriesData,
): MutableXYColumns => {
  const n = getPointCount(data);
  if (n === 0) return brandOwnedColumns({ x: [], y: [] });

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
    return brandOwnedColumns({ x, y, size });
  }

  return brandOwnedColumns({ x, y });
};

/**
 * Extends existing bounds with new CartesianSeriesData.
 * Avoids per-point allocations for typed arrays by using direct accessors.
 */
const extendBoundsWithCartesianData = (
  bounds: Bounds | null,
  data: CartesianSeriesData,
): Bounds | null => {
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

const extendBoundsWithOHLCDataPoints = (
  bounds: Bounds | null,
  points: ReadonlyArray<OHLCDataPoint>,
): Bounds | null => {
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

    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(low) ||
      !Number.isFinite(high)
    )
      continue;
    if (timestamp < xMin) xMin = timestamp;
    if (timestamp > xMax) xMax = timestamp;
    if (low < yMin) yMin = low;
    if (high > yMax) yMax = high;
  }

  if (
    !Number.isFinite(xMin) ||
    !Number.isFinite(xMax) ||
    !Number.isFinite(yMin) ||
    !Number.isFinite(yMax)
  ) {
    return bounds;
  }

  // Keep bounds usable for downstream scale derivation.
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
};

const computeGlobalXBounds = (
  series: ResolvedChartGPUOptions["series"],
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null,
): { xMin: number; xMax: number } => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    if (seriesConfig.type === "pie") continue;

    const runtimeBoundsCandidate = runtimeRawBoundsByIndex?.[s] ?? null;
    if (runtimeBoundsCandidate) {
      const b = runtimeBoundsCandidate;
      if (Number.isFinite(b.xMin) && Number.isFinite(b.xMax)) {
        if (b.xMin < xMin) xMin = b.xMin;
        if (b.xMax > xMax) xMax = b.xMax;
        continue;
      }
    }

    const rawBoundsCandidate = seriesConfig.rawBounds;
    if (rawBoundsCandidate) {
      const b = rawBoundsCandidate;
      if (Number.isFinite(b.xMin) && Number.isFinite(b.xMax)) {
        if (b.xMin < xMin) xMin = b.xMin;
        if (b.xMax > xMax) xMax = b.xMax;
        continue;
      }
    }

    if (seriesConfig.type === "candlestick") {
      const rawOHLC = (seriesConfig.rawData ?? seriesConfig.data) as ReadonlyArray<OHLCDataPoint>;
      for (let i = 0; i < rawOHLC.length; i++) {
        const p = rawOHLC[i]!;
        const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
        if (!Number.isFinite(timestamp)) continue;
        if (timestamp < xMin) xMin = timestamp;
        if (timestamp > xMax) xMax = timestamp;
      }
      continue;
    }

    const data = seriesConfig.data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const x = getX(data, i);
      if (!Number.isFinite(x)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) {
    return { xMin: 0, xMax: 1 };
  }
  if (xMin === xMax) xMax = xMin + 1;
  return { xMin, xMax };
};

const computeGlobalYBoundsForAxis = (
  series: ResolvedChartGPUOptions["series"],
  axisId: string,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null,
): { yMin: number; yMax: number } => {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    if (seriesConfig.type === "pie") continue;
    if (seriesConfig.yAxis !== axisId) continue;

    const runtimeBoundsCandidate = runtimeRawBoundsByIndex?.[s] ?? null;
    if (runtimeBoundsCandidate) {
      const b = runtimeBoundsCandidate;
      if (Number.isFinite(b.yMin) && Number.isFinite(b.yMax)) {
        if (b.yMin < yMin) yMin = b.yMin;
        if (b.yMax > yMax) yMax = b.yMax;
        continue;
      }
    }

    const rawBoundsCandidate = seriesConfig.rawBounds;
    if (rawBoundsCandidate) {
      const b = rawBoundsCandidate;
      if (Number.isFinite(b.yMin) && Number.isFinite(b.yMax)) {
        if (b.yMin < yMin) yMin = b.yMin;
        if (b.yMax > yMax) yMax = b.yMax;
        continue;
      }
    }

    if (seriesConfig.type === "candlestick") {
      const rawOHLC = (seriesConfig.rawData ?? seriesConfig.data) as ReadonlyArray<OHLCDataPoint>;
      for (let i = 0; i < rawOHLC.length; i++) {
        const p = rawOHLC[i]!;
        const low = isTupleOHLCDataPoint(p) ? p[3] : p.low;
        const high = isTupleOHLCDataPoint(p) ? p[4] : p.high;
        if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
        const yLow = Math.min(low, high);
        const yHigh = Math.max(low, high);
        if (yLow < yMin) yMin = yLow;
        if (yHigh > yMax) yMax = yHigh;
      }
      continue;
    }

    const data = seriesConfig.data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const y = getY(data, i);
      if (!Number.isFinite(y)) continue;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { yMin: 0, yMax: 1 };
  }
  if (yMin === yMax) yMax = yMin + 1;
  return { yMin, yMax };
};

const normalizeDomain = (
  minCandidate: number,
  maxCandidate: number,
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

const computeGridArea = (
  gpuContext: GPUContextLike,
  options: ResolvedChartGPUOptions,
): GridArea => {
  const canvas = gpuContext.canvas;
  if (!canvas)
    throw new Error("RenderCoordinator: gpuContext.canvas is required.");

  // GridArea uses:
  // - Margins (left, right, top, bottom) in CSS pixels
  // - Canvas dimensions (canvasWidth, canvasHeight) in DEVICE pixels
  // - devicePixelRatio for CSS-to-device conversion
  // This allows renderers to multiply margins by DPR and subtract from canvas dimensions

  const dpr = gpuContext.devicePixelRatio ?? 1;
  const devicePixelRatio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

  // Validate and sanitize canvas dimensions (device pixels)
  // Canvas dimensions should be set by GPUContext initialization/resize, but guard against edge cases:
  // - Race conditions during initialization
  // - Canvas not yet sized (0 dimensions)
  const rawCanvasWidth = canvas.width;
  const rawCanvasHeight = canvas.height;

  if (!Number.isFinite(rawCanvasWidth) || !Number.isFinite(rawCanvasHeight)) {
    throw new Error(
      `RenderCoordinator: Invalid canvas dimensions: width=${rawCanvasWidth}, height=${rawCanvasHeight}. ` +
        `Canvas must be initialized with finite dimensions before rendering.`,
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
    canvasWidth, // Device pixels (clamped above)
    canvasHeight, // Device pixels (clamped above)
    devicePixelRatio, // Explicit DPR (validated above)
  };
};

const rgba01ToCssRgba = (
  rgba: readonly [number, number, number, number],
): string => {
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
  gridArea: GridArea,
): {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
} => {
  const {
    left,
    right,
    top,
    bottom,
    canvasWidth,
    canvasHeight,
    devicePixelRatio,
  } = gridArea;

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
const clampInt = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v | 0));

const lerp = (a: number, b: number, t01: number): number =>
  a + (b - a) * clamp01(t01);

const lerpDomain = (
  from: { readonly min: number; readonly max: number },
  to: { readonly min: number; readonly max: number },
  t01: number,
): { readonly min: number; readonly max: number } => {
  return normalizeDomain(
    lerp(from.min, to.min, t01),
    lerp(from.max, to.max, t01),
  );
};

const computePlotScissorDevicePx = (
  gridArea: GridArea,
): {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
} => {
  const { canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeftDevice = gridArea.left * devicePixelRatio;
  const plotRightDevice = canvasWidth - gridArea.right * devicePixelRatio;
  const plotTopDevice = gridArea.top * devicePixelRatio;
  const plotBottomDevice = canvasHeight - gridArea.bottom * devicePixelRatio;

  const scissorX = clampInt(
    Math.floor(plotLeftDevice),
    0,
    Math.max(0, canvasWidth),
  );
  const scissorY = clampInt(
    Math.floor(plotTopDevice),
    0,
    Math.max(0, canvasHeight),
  );
  const scissorR = clampInt(
    Math.ceil(plotRightDevice),
    0,
    Math.max(0, canvasWidth),
  );
  const scissorB = clampInt(
    Math.ceil(plotBottomDevice),
    0,
    Math.max(0, canvasHeight),
  );
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
};

const clipXToCanvasCssPx = (xClip: number, canvasCssWidth: number): number =>
  ((xClip + 1) / 2) * canvasCssWidth;
const clipYToCanvasCssPx = (yClip: number, canvasCssHeight: number): number =>
  ((1 - yClip) / 2) * canvasCssHeight;

// Alias for imported function to maintain compatibility with existing code
const isTupleOHLCDataPoint = isTupleOHLCDataPointImported;

const parseNumberOrPercent = (
  value: number | string,
  basis: number,
): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const s = value.trim();
  if (s.length === 0) return null;

  if (s.endsWith("%")) {
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
  plotHeightCss: number,
): { readonly x: number; readonly y: number } => {
  const xRaw = center?.[0] ?? "50%";
  const yRaw = center?.[1] ?? "50%";

  const x = parseNumberOrPercent(xRaw, plotWidthCss);
  const y = parseNumberOrPercent(yRaw, plotHeightCss);

  return {
    x: Number.isFinite(x) ? x! : plotWidthCss * 0.5,
    y: Number.isFinite(y) ? y! : plotHeightCss * 0.5,
  };
};

const isPieRadiusTuple = (
  radius: PieRadius,
): radius is readonly [inner: number | string, outer: number | string] =>
  Array.isArray(radius);

const resolvePieRadiiCss = (
  radius: PieRadius | undefined,
  maxRadiusCss: number,
): { readonly inner: number; readonly outer: number } => {
  // Default similar to common chart libs (mirrors `createPieRenderer.ts`).
  if (radius == null) return { inner: 0, outer: maxRadiusCss * 0.7 };

  if (isPieRadiusTuple(radius)) {
    const inner = parseNumberOrPercent(radius[0], maxRadiusCss);
    const outer = parseNumberOrPercent(radius[1], maxRadiusCss);
    const innerCss = Math.max(0, Number.isFinite(inner) ? inner! : 0);
    const outerCss = Math.max(
      innerCss,
      Number.isFinite(outer) ? outer! : maxRadiusCss * 0.7,
    );
    return { inner: innerCss, outer: Math.min(maxRadiusCss, outerCss) };
  }

  const outer = parseNumberOrPercent(radius, maxRadiusCss);
  const outerCss = Math.max(
    0,
    Number.isFinite(outer) ? outer! : maxRadiusCss * 0.7,
  );
  return { inner: 0, outer: Math.min(maxRadiusCss, outerCss) };
};

const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, "0");

const MONTH_SHORT_EN: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const formatTimeTickValue = (
  timestampMs: number,
  visibleRangeMs: number,
): string | null => {
  if (!Number.isFinite(timestampMs)) return null;
  if (!Number.isFinite(visibleRangeMs) || visibleRangeMs < 0)
    visibleRangeMs = 0;

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
  // Treat the 7-day boundary as inclusive for the ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ1ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“7 daysÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â tier.
  if (visibleRangeMs <= 7 * MS_PER_DAY) {
    return `${pad2(mm)}/${pad2(dd)} ${pad2(hh)}:${pad2(min)}`;
  }
  // Keep short calendar dates until the visible range reaches ~3 months.
  // (This covers the 1ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“12 week requirement, plus the small 12wÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢3m gap.)
  if (visibleRangeMs < 3 * MS_PER_MONTH_APPROX) {
    return `${pad2(mm)}/${pad2(dd)}`;
  }
  if (visibleRangeMs <= MS_PER_YEAR_APPROX) {
    const mmm = MONTH_SHORT_EN[d.getMonth()] ?? pad2(mm);
    return `${mmm} ${pad2(dd)}`;
  }
  return `${yyyy}/${pad2(mm)}`;
};

const generateLinearTicks = (
  domainMin: number,
  domainMax: number,
  tickCount: number,
): number[] => {
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
    return {
      tickCount: DEFAULT_TICK_COUNT,
      tickValues: generateLinearTicks(domainMin, domainMax, DEFAULT_TICK_COUNT),
    };
  }

  // Ensure the measurement font matches the overlay labels.
  measureCtx.font = `${fontSize}px ${fontFamily}`;
  if (measureCache && measureCache.size > 2000) measureCache.clear();

  // Pre-construct the font part of the cache key to avoid repeated concatenation.
  const cacheKeyPrefix = measureCache ? `${fontSize}px ${fontFamily}@@` : null;

  for (
    let tickCount = MAX_TIME_X_TICK_COUNT;
    tickCount >= MIN_TIME_X_TICK_COUNT;
    tickCount--
  ) {
    const tickValues = generateLinearTicks(domainMin, domainMax, tickCount);

    // Compute label extents in *canvas-local CSS px* and ensure adjacent labels don't overlap.
    let prevRight = Number.NEGATIVE_INFINITY;
    let ok = true;

    for (let i = 0; i < tickValues.length; i++) {
      const v = tickValues[i]!;
      const label = tickFormatter
        ? tickFormatter(v)
        : formatTimeTickValue(v, visibleRangeMs);
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
        tickCount === 1
          ? "middle"
          : i === 0
            ? "start"
            : i === tickValues.length - 1
              ? "end"
              : "middle";

      const left =
        anchor === "start"
          ? xCss
          : anchor === "end"
            ? xCss - w
            : xCss - w * 0.5;
      const right =
        anchor === "start"
          ? xCss + w
          : anchor === "end"
            ? xCss
            : xCss + w * 0.5;

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

  return {
    tickCount: MIN_TIME_X_TICK_COUNT,
    tickValues: generateLinearTicks(
      domainMin,
      domainMax,
      MIN_TIME_X_TICK_COUNT,
    ),
  };
};

const computeBaseXDomain = (
  options: ResolvedChartGPUOptions,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null,
): { readonly min: number; readonly max: number } => {
  // Short-circuit when both ends are explicit — avoids O(series) bounds aggregation
  // on full rewrite frames with fixed axes (SciChart groups 2/3).
  const explicitMin = finiteOrUndefined(options.xAxis.min);
  const explicitMax = finiteOrUndefined(options.xAxis.max);
  if (explicitMin !== undefined && explicitMax !== undefined) {
    return normalizeDomain(explicitMin, explicitMax);
  }
  const bounds = computeGlobalXBounds(options.series, runtimeRawBoundsByIndex);
  const baseMin = explicitMin ?? bounds.xMin;
  const baseMax = explicitMax ?? bounds.xMax;
  return normalizeDomain(baseMin, baseMax);
};

/**
 * Computes Y-axis domain bounds from the visible/rendered series data.
 * This avoids scanning the full raw dataset when yAxis.autoBounds === 'visible'.
 *
 * Performance: O(n) where n = total points across all visible series data.
 * This is called only when renderSeries changes (zoom/pan/data updates), not per-frame.
 */
const computeVisibleYBoundsForAxis = (
  series: ResolvedChartGPUOptions["series"],
  axisId: string,
): { yMin: number; yMax: number } => {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    if (seriesConfig.type === "pie") continue;
    if (seriesConfig.yAxis !== axisId) continue;

    if (seriesConfig.type === "candlestick") {
      const visibleOHLC = seriesConfig.data as ReadonlyArray<OHLCDataPoint>;
      for (let i = 0; i < visibleOHLC.length; i++) {
        const p = visibleOHLC[i]!;
        const low = isTupleOHLCDataPoint(p) ? p[3] : p.low;
        const high = isTupleOHLCDataPoint(p) ? p[4] : p.high;
        if (!Number.isFinite(low) || !Number.isFinite(high)) continue;

        const yLow = Math.min(low, high);
        const yHigh = Math.max(low, high);

        if (yLow < yMin) yMin = yLow;
        if (yHigh > yMax) yMax = yHigh;
      }
      continue;
    }

    const data = seriesConfig.data as CartesianSeriesData;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const y = getY(data, i);
      if (!Number.isFinite(y)) continue;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { yMin: 0, yMax: 1 };
  }

  if (yMin === yMax) yMax = yMin + 1;

  return { yMin, yMax };
};

const computeBaseYDomainForAxis = (
  options: ResolvedChartGPUOptions,
  axisId: string,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null,
  visibleBoundsOverride?: { yMin: number; yMax: number } | null,
): { readonly min: number; readonly max: number } => {
  const yAxisConfig = options.yAxes.find((ax) => ax.id === axisId) || options.yAxes[0]!;
  const explicitMin = finiteOrUndefined(yAxisConfig.min);
  const explicitMax = finiteOrUndefined(yAxisConfig.max);

  if (explicitMin !== undefined && explicitMax !== undefined) {
    return normalizeDomain(explicitMin, explicitMax);
  }

  const autoBoundsMode = yAxisConfig.autoBounds ?? "visible";
  let bounds: { yMin: number; yMax: number };

  if (autoBoundsMode === "visible" && visibleBoundsOverride) {
    bounds = visibleBoundsOverride;
  } else {
    bounds = computeGlobalYBoundsForAxis(options.series, axisId, runtimeRawBoundsByIndex);
  }

  const yMin = explicitMin ?? bounds.yMin;
  const yMax = explicitMax ?? bounds.yMax;
  return normalizeDomain(yMin, yMax);
};

const computeVisibleXDomain = (
  baseXDomain: { readonly min: number; readonly max: number },
  zoomRange?: ZoomRange | null,
): {
  readonly min: number;
  readonly max: number;
  readonly spanFraction: number;
} => {
  if (!zoomRange) return { ...baseXDomain, spanFraction: 1 };
  const span = baseXDomain.max - baseXDomain.min;
  if (!Number.isFinite(span) || span === 0)
    return { ...baseXDomain, spanFraction: 1 };

  const start = zoomRange.start;
  const end = zoomRange.end;
  const xMin = baseXDomain.min + (start / 100) * span;
  const xMax = baseXDomain.min + (end / 100) * span;
  const normalized = normalizeDomain(xMin, xMax);

  const fractionRaw = (end - start) / 100;
  const spanFraction = Number.isFinite(fractionRaw)
    ? Math.max(0, Math.min(1, fractionRaw))
    : 1;
  return { min: normalized.min, max: normalized.max, spanFraction };
};

type IntroPhase = "pending" | "running" | "done";

const resolveAnimationConfig = (
  animation: ResolvedChartGPUOptions["animation"],
): {
  readonly durationMs: number;
  readonly delayMs: number;
  readonly easing: EasingFunction;
} | null => {
  if (animation === false || animation == null) return null;

  const cfg: AnimationConfig | null = animation === true ? {} : animation;
  if (!cfg) return null;

  const durationMsRaw = cfg.duration ?? 300;
  const delayMsRaw = cfg.delay ?? 0;

  const durationMs = Number.isFinite(durationMsRaw)
    ? Math.max(0, durationMsRaw)
    : 300;
  const delayMs = Number.isFinite(delayMsRaw) ? Math.max(0, delayMsRaw) : 0;

  return {
    durationMs,
    delayMs,
    easing: getEasing(cfg.easing),
  };
};

const resolveIntroAnimationConfig = (
  animation: ResolvedChartGPUOptions["animation"],
) => resolveAnimationConfig(animation);
const resolveUpdateAnimationConfig = (
  animation: ResolvedChartGPUOptions["animation"],
) => resolveAnimationConfig(animation);

/**
 * Computes container-local CSS pixel anchor coordinates for a candlestick tooltip.
 *
 * The anchor is positioned near the candle body center for stable tooltip positioning
 * even when the cursor is at the edge of the candlestick.
 *
 * Coordinate transformations:
 * 1. Domain values (timestamp, open, close) from CandlestickMatch
 * 2. ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ xScale/yScale transform to grid-local CSS pixels
 * 3. ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Add gridArea offset to get canvas-local CSS pixels
 * 4. ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Add canvas offset to get container-local CSS pixels
 *
 * Returns null if any coordinate computation fails (non-finite values).
 */
const computeCandlestickTooltipAnchor = (
  match: { readonly point: OHLCDataPoint },
  xScale: LinearScale,
  yScales: Map<string, LinearScale>,
  gridArea: GridArea,
  canvas: HTMLCanvasElement,
): Readonly<{ x: number; y: number }> | null => {
  const point = match.point;

  const timestamp = isTupleOHLCDataPoint(point) ? point[0] : point.timestamp;
  const open = isTupleOHLCDataPoint(point) ? point[1] : point.open;
  const close = isTupleOHLCDataPoint(point) ? point[2] : point.close;

  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(open) ||
    !Number.isFinite(close)
  ) {
    return null;
  }

  // Body center in domain space
  const bodyMidY = (open + close) / 2;

  // Transform to grid-local CSS pixels
  const xGridCss = xScale.scale(timestamp);
  const yScale = yScales.values().next().value;
  const yGridCss = yScale ? yScale.scale(bodyMidY) : 0;

  if (!Number.isFinite(xGridCss) || !Number.isFinite(yGridCss)) {
    return null;
  }

  // Convert to canvas-local CSS pixels
  const xCanvasCss = gridArea.left + xGridCss;
  const yCanvasCss = gridArea.top + yGridCss;

  // Convert to container-local CSS pixels
  const xContainerCss = isHTMLCanvasElement(canvas)
    ? canvas.offsetLeft + xCanvasCss
    : xCanvasCss;
  const yContainerCss = isHTMLCanvasElement(canvas)
    ? canvas.offsetTop + yCanvasCss
    : yCanvasCss;

  if (!Number.isFinite(xContainerCss) || !Number.isFinite(yContainerCss)) {
    return null;
  }

  return { x: xContainerCss, y: yContainerCss };
};

const computeBaselineForBarsFromData = (
  seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
): number => {
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
  plotClipRect: Readonly<{ top: number; bottom: number }>,
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
  progress01: number,
): LinearScale => {
  const p = clamp01(progress01);
  if (p >= 1) return baseYScale;

  const baselineDomain = computeBaselineForBarsFromAxis(
    barSeriesConfigs,
    baseYScale,
    plotClipRect,
  );
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
  callbacks?: RenderCoordinatorCallbacks,
): RenderCoordinator {
  if (!gpuContext.initialized) {
    throw new Error("RenderCoordinator: gpuContext must be initialized.");
  }
  const device = gpuContext.device;
  if (!device) {
    throw new Error("RenderCoordinator: gpuContext.device is required.");
  }
  if (!gpuContext.canvas) {
    throw new Error("RenderCoordinator: gpuContext.canvas is required.");
  }
  if (!gpuContext.canvasContext) {
    throw new Error("RenderCoordinator: gpuContext.canvasContext is required.");
  }

  const targetFormat = gpuContext.preferredFormat ?? DEFAULT_TARGET_FORMAT;
  const pipelineCache = callbacks?.pipelineCache;

  // DOM-dependent features (overlays, legends) require HTMLCanvasElement.
  const overlayContainer = isHTMLCanvasElement(gpuContext.canvas)
    ? gpuContext.canvas.parentElement
    : null;
  const axisLabelOverlay: TextOverlay | null = overlayContainer
    ? createTextOverlay(overlayContainer)
    : null;
  // Dedicated overlay for annotations (do not reuse axis label overlay).
  const annotationOverlay: TextOverlay | null = overlayContainer
    ? createTextOverlay(overlayContainer, { clip: true })
    : null;

  const handleSeriesToggle = (
    seriesIndex: number,
    sliceIndex?: number,
  ): void => {
    if (disposed) return;

    const series = currentOptions.series;
    if (seriesIndex < 0 || seriesIndex >= series.length) return;

    const s = series[seriesIndex];
    if (!s) return;

    // Handle pie slice toggle
    if (sliceIndex !== undefined && s.type === "pie") {
      const pieData = (s as ResolvedPieSeriesConfig).data;
      if (sliceIndex < 0 || sliceIndex >= pieData.length) return;

      const updatedData = pieData.map((slice, i) =>
        i === sliceIndex
          ? { ...slice, visible: slice.visible === false ? true : false }
          : slice,
      );

      const updatedSeries = series.map((seriesItem, i) =>
        i === seriesIndex
          ? ({ ...seriesItem, data: updatedData } as typeof seriesItem)
          : seriesItem,
      );

      setOptions({ ...currentOptions, series: updatedSeries });
      return;
    }

    // Toggle regular series visibility
    const updatedSeries = series.map((seriesItem, i) =>
      i === seriesIndex
        ? ({
            ...seriesItem,
            visible: seriesItem.visible === false ? true : false,
          } as typeof seriesItem)
        : seriesItem,
    );

    // Update options with new series array
    setOptions({ ...currentOptions, series: updatedSeries });
  };

  const legend: Legend | null =
    overlayContainer && options.legend?.show !== false
      ? createLegend(
          overlayContainer,
          options.legend?.position,
          handleSeriesToggle,
        )
      : null;
  // Text measurement for axis labels. Requires DOM context.
  const tickMeasureCtx: CanvasRenderingContext2D | null = (() => {
    if (typeof document === "undefined") {
      // No DOM available (e.g., SSR or non-browser environment).
      return null;
    }
    try {
      const c = document.createElement("canvas");
      return c.getContext("2d");
    } catch {
      return null;
    }
  })();
  const tickMeasureCache: Map<string, number> | null = tickMeasureCtx
    ? new Map()
    : null;

  let disposed = false;
  let currentOptions: ResolvedChartGPUOptions = options;
  let lastSeriesCount = options.series.length;

  // Story 5.16: initial-load intro animation (series marks only).
  let introPhase: IntroPhase = "pending";
  let introProgress01 = 0;
  const introAnimController = createAnimationController();
  let introAnimId: AnimationId | null = null;

  // Story 5.17 (step 1): data update transition state (snapshots only; interpolation occurs later).
  type UpdateTransitionSnapshot = Readonly<{
    readonly xBaseDomain: { readonly min: number; readonly max: number };
    readonly xVisibleDomain: { readonly min: number; readonly max: number };
    readonly yBaseDomains: Map<string, { readonly min: number; readonly max: number }>;
    readonly series: ResolvedChartGPUOptions["series"];
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
    readonly pieDataBySeriesIndex: Array<
      ResolvedPieSeriesConfig["data"] | null
    >;
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
    cache: DataPoint[] | null,
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
      const x =
        Number.isFinite(xFrom) && Number.isFinite(xTo)
          ? lerp(xFrom, xTo, t)
          : xTo;
      const y =
        Number.isFinite(yFrom) && Number.isFinite(yTo)
          ? lerp(yFrom, yTo, t)
          : yTo;
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
    cache: ResolvedPieSeriesConfig["data"] | null,
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
            return created as ResolvedPieSeriesConfig["data"];
          })();

    const t = clamp01(t01);
    for (let i = 0; i < n; i++) {
      const vFrom = (fromData[i] as any)?.value;
      const vTo = (toData[i] as any)?.value;
      const next =
        typeof vFrom === "number" &&
        typeof vTo === "number" &&
        Number.isFinite(vFrom) &&
        Number.isFinite(vTo)
          ? Math.max(0, lerp(vFrom, vTo, t))
          : typeof vTo === "number" && Number.isFinite(vTo)
            ? vTo
            : 0;
      (out[i] as any).value = next;
    }

    return { ...toSeries, data: out };
  };

  const interpolateSeriesForUpdate = (
    fromSeries: ResolvedChartGPUOptions["series"],
    toSeries: ResolvedChartGPUOptions["series"],
    t01: number,
    caches: UpdateInterpolationCaches | null,
  ): ResolvedChartGPUOptions["series"] => {
    if (fromSeries.length !== toSeries.length) return toSeries;

    const out: ResolvedChartGPUOptions["series"][number][] = new Array(
      toSeries.length,
    );

    for (let i = 0; i < toSeries.length; i++) {
      const a = fromSeries[i]!;
      const b = toSeries[i]!;

      if (a.type !== b.type) {
        out[i] = b;
        continue;
      }

      if (b.type === "pie") {
        const cache = caches?.pieDataBySeriesIndex[i] ?? null;
        const animated = interpolatePieSeriesByIndex(
          a as ResolvedPieSeriesConfig,
          b as ResolvedPieSeriesConfig,
          t01,
          cache,
        );
        if (caches) caches.pieDataBySeriesIndex[i] = animated.data as any;
        out[i] = animated;
        continue;
      }

      // Cartesian series: interpolate y-values by index. Keep x from "to".
      // Data may be ReadonlyArray<DataPoint> OR MutableXYColumns (XYArraysData-compatible) at runtime,
      // so use getPointCount/getX/getY instead of .length / direct indexing.
      const aData = (a as unknown as { readonly data: CartesianSeriesData })
        .data;
      const bData = (b as unknown as { readonly data: CartesianSeriesData })
        .data;

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
      const animatedData = interpolateCartesianSeriesDataByIndex(
        aData,
        bData,
        aLen,
        t01,
        cache,
      );
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
    zoomRange: ZoomRange | null,
  ): UpdateTransitionSnapshot => {
    const xBase = lerpDomain(
      transition.from.xBaseDomain,
      transition.to.xBaseDomain,
      t01,
    );
    const xVisible = computeVisibleXDomain(xBase, zoomRange);
    const yBaseDomains = new Map<string, { readonly min: number; readonly max: number }>();
    for (const ax of transition.from.series[0] ? currentOptions.yAxes : []) {
        const axId = ax.id!;
        const fromY = transition.from.yBaseDomains.get(axId) || { min: 0, max: 1 };
        const toY = transition.to.yBaseDomains.get(axId) || { min: 0, max: 1 };
        yBaseDomains.set(axId, lerpDomain(fromY, toY, t01));
    }
    const series = interpolateSeriesForUpdate(
      transition.from.series,
      transition.to.series,
      t01,
      null,
    );
    return {
      xBaseDomain: xBase,
      xVisibleDomain: { min: xVisible.min, max: xVisible.max },
      yBaseDomains,
      series,
    };
  };

  // Prevent spamming console.warn for repeated misuse.
  const warnedPieAppendSeries = new Set<number>();
  const warnedSamplingDefeatsFastPath = new Set<number>();

  // Coordinator runtime series store.
  // - Cartesian: branded MutableXYColumns (owned), RingXYColumns (FIFO), or a raw
  //   setOption data ref (DataPoint[] / user XYArrays — never mutated in place).
  // - Candlestick: mutable OHLCDataPoint[].
  // - `runtimeRawBoundsByIndex[i]` is incrementally updated to keep scale/bounds derivation cheap.
  let runtimeRawDataByIndex: Array<
    RuntimeCartesianData | OHLCDataPoint[] | null
  > = new Array(options.series.length).fill(null);
  let runtimeRawBoundsByIndex: Array<Bounds | null> = new Array(
    options.series.length,
  ).fill(null);

  // Baseline sampled series list derived from runtime raw data (used as the ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œfull spanÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â baseline).
  // Zoom-visible resampling is derived from this baseline + runtime raw as needed.
  let runtimeBaseSeries: ResolvedChartGPUOptions["series"] =
    currentOptions.series;

  // Zoom-aware sampled series list used for rendering + cartesian hit-testing.
  // Derived from `currentOptions.series` (which still includes baseline sampled `data`).
  let renderSeries: ResolvedChartGPUOptions["series"] = currentOptions.series;

  // Cache for visible y-bounds computed from renderSeries (for yAxis.autoBounds === 'visible').
  // Recomputed whenever renderSeries changes (zoom/pan/data updates).
  let cachedVisibleYBoundsByAxis: Map<string, { yMin: number; yMax: number }> = new Map();

  const shouldComputeVisibleYBoundsForAxis = (
    opts: ResolvedChartGPUOptions,
    axisId: string,
  ): boolean => {
    const yAxisConfig = opts.yAxes.find((ax) => ax.id === axisId) || opts.yAxes[0]!;
    const autoBoundsMode = yAxisConfig.autoBounds ?? "visible";
    if (autoBoundsMode !== "visible") return false;
    const explicitMin = finiteOrUndefined(yAxisConfig.min);
    const explicitMax = finiteOrUndefined(yAxisConfig.max);
    return !(explicitMin !== undefined && explicitMax !== undefined);
  };

  const recomputeCachedVisibleYBoundsIfNeeded = (): void => {
    cachedVisibleYBoundsByAxis.clear();
    for (const ax of currentOptions.yAxes) {
      if (shouldComputeVisibleYBoundsForAxis(currentOptions, ax.id!)) {
        cachedVisibleYBoundsByAxis.set(ax.id!, computeVisibleYBoundsForAxis(renderSeries, ax.id!));
      }
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
  // Each entry is an array of batches with optional per-call maxPoints (must stay
  // in sync with ChartGPU hit-test store which applies maxPoints per call).
  type PendingAppendBatch = {
    readonly points: CartesianSeriesData | ReadonlyArray<OHLCDataPoint>;
    readonly maxPoints?: number;
  };
  const pendingAppendByIndex = new Map<number, PendingAppendBatch[]>();

  // Tracks what the DataStore currently represents for each series index.
  // Used to decide whether `appendSeries(...)` is a correct fast-path.
  // - fullRawLine: sampling=none, full-span zoom, raw buffer
  // - gpuDecimationRaw: GPU decimation active; buffer holds full raw for compute
  type GpuSeriesKind = "unknown" | "fullRawLine" | "gpuDecimationRaw" | "other";
  let gpuSeriesKindByIndex: GpuSeriesKind[] = new Array(
    currentOptions.series.length,
  ).fill("unknown");
  const appendedGpuThisFrame = new Set<number>();

  // P1-2: skip DataStore.setSeries pack+hash when the same data ref + xOffset is re-uploaded.
  // Must be cleared while update-animation interpolates (mutates values under a stable ref).
  const lastSetSeriesCache: LastSetSeriesCache = new Map();

  // P2-12: reuse filterGaps output while series data ref is stable (connectNulls).
  // Cleared with lastSetSeriesCache when data mutates under a stable ref.
  const filterGapsCache = createFilterGapsCache();

  // P1-6: skip grid/axis prepare when layout, counts, colors, and scale affines are unchanged.
  const overlayPrepareMemo = createOverlayPrepareMemo();

  // Tooltip is a DOM overlay element; enable by default unless explicitly disabled.
  let tooltip: Tooltip | null =
    overlayContainer && currentOptions.tooltip?.show !== false
      ? createTooltip(overlayContainer)
      : null;

  // Cache tooltip state to avoid unnecessary DOM updates
  let lastTooltipContent: string | null = null;
  let lastTooltipX: number | null = null;
  let lastTooltipY: number | null = null;

  // Throttle tooltip hit-testing to ~30 Hz (P0-4). Crosshair/highlight still track the
  // pointer every frame; only the expensive tooltip scan + DOM path is rate-limited.
  // A follow-up render is scheduled so the tooltip catches up after the window elapses.
  const TOOLTIP_HIT_TEST_THROTTLE_MS = 33;
  let lastTooltipHitTestMs = -Infinity;
  let pendingTooltipFollowupTimerId: ReturnType<typeof setTimeout> | null =
    null;

  const cancelPendingTooltipFollowup = (): void => {
    if (pendingTooltipFollowupTimerId !== null) {
      clearTimeout(pendingTooltipFollowupTimerId);
      pendingTooltipFollowupTimerId = null;
    }
  };

  const schedulePendingTooltipFollowup = (delayMs: number): void => {
    if (pendingTooltipFollowupTimerId !== null) return;
    const wait = Math.max(0, delayMs);
    pendingTooltipFollowupTimerId = setTimeout(() => {
      pendingTooltipFollowupTimerId = null;
      requestRender();
    }, wait);
  };

  // Helper functions for tooltip/legend management
  const showTooltipInternal = (
    x: number,
    y: number,
    content: string,
    _params: TooltipParams | TooltipParams[],
  ) => {
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

  const updateLegend = (
    series: ResolvedChartGPUOptions["series"],
    theme: ResolvedChartGPUOptions["theme"],
  ) => {
    legend?.update(series, theme);
  };

  updateLegend(currentOptions.series, currentOptions.theme);

  let dataStore = createDataStore(device);

  const gridRenderer = createGridRenderer(device, {
    targetFormat,
    sampleCount: MAIN_SCENE_MSAA_SAMPLE_COUNT,
    pipelineCache,
  });
  // Axes / crosshair / highlight draw into the annotation overlay MSAA pass
  // (WG-P1-5 Phase 4b): sampleCount must match ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT.
  const xAxisRenderer = createAxisRenderer(device, {
    targetFormat,
    sampleCount: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT,
    pipelineCache,
  });
  const yAxisRenderers = new Map<string, ReturnType<typeof createAxisRenderer>>();
  const crosshairRenderer = createCrosshairRenderer(device, {
    targetFormat,
    sampleCount: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT,
    pipelineCache,
  });
  crosshairRenderer.setVisible(false);
  const highlightRenderer = createHighlightRenderer(device, {
    targetFormat,
    sampleCount: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT,
    pipelineCache,
  });
  highlightRenderer.setVisible(false);

  // Frame graph (WG-P1-5):
  // 1. Main 4× MSAA → resolve (grid, series, below-series annotations)
  // 2. Overlay 4× MSAA → resolve to swapchain (blit + above-series annotations +
  //    axes/crosshair/highlight). No third single-sample top overlay pass.
  // Below/above annotation pipelines share sampleCount 4 (WG-P2-1): one renderer
  // each; prepared once; drawn into main (below) or overlay (above) as needed.
  const referenceLineRenderer = createReferenceLineRenderer(device, {
    targetFormat,
    sampleCount: MAIN_SCENE_MSAA_SAMPLE_COUNT,
    pipelineCache,
  });
  const annotationMarkerRenderer = createAnnotationMarkerRenderer(device, {
    targetFormat,
    sampleCount: MAIN_SCENE_MSAA_SAMPLE_COUNT,
    pipelineCache,
  });
  // Alias MSAA slots to the same instances (both passes use sampleCount 4).
  const referenceLineRendererMsaa = referenceLineRenderer;
  const annotationMarkerRendererMsaa = annotationMarkerRenderer;

  const textureManager = createTextureManager({
    device,
    targetFormat,
    pipelineCache,
  });

  const initialGridArea = computeGridArea(gpuContext, currentOptions);

  // Event manager requires HTMLCanvasElement (DOM events).
  const eventManager = isHTMLCanvasElement(gpuContext.canvas)
    ? createEventManager(gpuContext.canvas, initialGridArea)
    : null;

  type PointerSource = "mouse" | "sync";

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
    source: "mouse",
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
  const interactionXListeners = new Set<
    (x: number | null, source?: unknown) => void
  >();

  // Cached interaction scales from the last render (used for pointer -> domain-x mapping).
  let lastInteractionScales: {
    readonly xScale: LinearScale;
    readonly yScales: Map<string, LinearScale>;
    readonly plotWidthCss: number;
    readonly plotHeightCss: number;
  } | null = null;

  const emitInteractionX = (nextX: number | null, source?: unknown): void => {
    const snapshot = Array.from(interactionXListeners);
    for (const cb of snapshot) cb(nextX, source);
  };

  const setInteractionXInternal = (
    nextX: number | null,
    source?: unknown,
  ): void => {
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

    // Capture the pre-append visible domain so we can preserve it for ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œpanned awayÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â behavior.
    const prevBaseXDomain = computeBaseXDomain(
      currentOptions,
      runtimeRawBoundsByIndex,
    );
    const prevVisibleXDomain = zoomRangeBefore
      ? computeVisibleXDomain(prevBaseXDomain, zoomRangeBefore)
      : null;

    let didAppendAny = false;

    for (const [seriesIndex, batches] of pendingAppendByIndex) {
      if (batches.length === 0) continue;
      const s = currentOptions.series[seriesIndex];
      if (!s || s.type === "pie") continue;
      didAppendAny = true;

      if (s.type === "candlestick") {
        // Handle candlestick OHLC data.
        let raw = runtimeRawDataByIndex[seriesIndex] as OHLCDataPoint[] | null;
        if (!raw) {
          const seed = (s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>;
          raw = seed.length === 0 ? [] : seed.slice();
          runtimeRawDataByIndex[seriesIndex] = raw;
          runtimeRawBoundsByIndex[seriesIndex] = s.rawBounds ?? null;
        }

        let didWindow = false;
        for (const batch of batches) {
          const ohlcPoints = batch.points as ReadonlyArray<OHLCDataPoint>;
          const maxPoints = normalizeMaxPoints(batch.maxPoints);
          const prevLen = raw.length;
          const plan = planMaxPointsWindow(
            prevLen,
            ohlcPoints.length,
            maxPoints,
          );
          if (plan.dropPrevCount > 0) {
            raw.splice(0, plan.dropPrevCount);
            didWindow = true;
          }
          if (plan.keepNewCount > 0) {
            const start = plan.newSrcOffset;
            const end = start + plan.keepNewCount;
            for (let i = start; i < end; i++) {
              raw.push(ohlcPoints[i]!);
            }
          }
          if (!plan.didWindow) {
            runtimeRawBoundsByIndex[seriesIndex] =
              extendBoundsWithOHLCDataPoints(
                runtimeRawBoundsByIndex[seriesIndex],
                ohlcPoints,
              );
          } else {
            didWindow = true;
          }
        }
        if (didWindow) {
          // Windowing can invalidate prior y/x extrema — full rescan.
          runtimeRawBoundsByIndex[seriesIndex] =
            extendBoundsWithOHLCDataPoints(null, raw);
        }
      } else {
        // Handle other cartesian series (line, area, bar, scatter).
        // Optional fast-path: append just the new points when the DataStore buffer
        // holds full raw line data (sampling='none' full-span, or GPU decimation raw).
        const kind = gpuSeriesKindByIndex[seriesIndex];
        const isGpuDecimationActive = kind === "gpuDecimationRaw";
        const existingRuntime =
          runtimeRawDataByIndex[seriesIndex] as CartesianSeriesData | null;
        const isGpuDecimationEligibleNow =
          s.type === "line" &&
          isGpuDecimationEligible(
            s,
            existingRuntime ??
              ((s.rawData ?? s.data) as CartesianSeriesData),
          );
        const canUseFastPath =
          s.type === "line" &&
          (kind === "fullRawLine" ||
            isGpuDecimationActive ||
            // First frames before prepare tags kind, but eligibility already known.
            (kind === "unknown" && isGpuDecimationEligibleNow)) &&
          // fullRawLine still requires full-span + sampling none; GPU path works at any zoom.
          (isGpuDecimationActive ||
            isGpuDecimationEligibleNow ||
            (s.sampling === "none" && isFullSpanZoomBefore));

        // Thin path = tooltip off + maxPoints + GPU append fast path: bind
        // coordinator raw to DataStore staging (zero-copy) instead of dual-packing
        // into RingXYColumns every frame. ChartGPU hit-test dual-store is skipped
        // under the same tooltip-off + maxPoints contract.
        let hasMaxPointsInFlush = false;
        for (const batch of batches) {
          if (normalizeMaxPoints(batch.maxPoints) != null) {
            hasMaxPointsInFlush = true;
            break;
          }
        }
        const useStagingThinPath = isStagingThinPathEligible(
          canUseFastPath,
          hasMaxPointsInFlush,
          currentOptions.tooltip?.show,
        );

        // setOption rewrite may store a raw DataPoint[] ref — promote before mutate
        // (unless thin path will replace the slot with a staging view).
        let raw: MutableXYColumns | RingXYColumns | StagingRingView | null =
          null;
        if (!useStagingThinPath) {
          raw = ensureMutableRuntimeColumns(seriesIndex, s);
        } else if (isStagingRingView(existingRuntime)) {
          raw = existingRuntime;
        } else if (isRingXYColumns(existingRuntime)) {
          raw = existingRuntime;
        }

        let didWindow = false;
        for (const batch of batches) {
          const cartesianData = batch.points as CartesianSeriesData;
          const maxPoints = normalizeMaxPoints(batch.maxPoints);
          const appendGpuOptions =
            maxPoints != null ? ({ maxPoints } as const) : undefined;

          // prevLen for planMaxPointsWindow: staging view / ring / linear / DataStore.
          let prevLen = 0;
          if (isStagingRingView(raw)) {
            prevLen = raw.count;
          } else if (isRingXYColumns(raw)) {
            prevLen = raw.count;
          } else if (raw != null && isOwnedMutableColumns(raw)) {
            prevLen = (raw as MutableXYColumns).x.length;
          } else {
            try {
              prevLen = dataStore.getSeriesPointCount(seriesIndex);
            } catch {
              prevLen = existingRuntime
                ? getPointCount(existingRuntime)
                : 0;
            }
          }

          if (canUseFastPath) {
            try {
              // Pass CartesianSeriesData directly to DataStore (avoids per-point allocations).
              // Shared planMaxPointsWindow policy keeps GPU length in sync with columns below.
              dataStore.appendSeries(
                seriesIndex,
                cartesianData,
                appendGpuOptions,
              );
              appendedGpuThisFrame.add(seriesIndex);
            } catch {
              // If the DataStore has not been initialized for this index (or any other error occurs),
              // fall back to the normal full upload path later in render().
            }
          } else if (
            s.type === "line" &&
            s.sampling !== "none" &&
            !isGpuDecimationEligibleNow &&
            !warnedSamplingDefeatsFastPath.has(seriesIndex)
          ) {
            // Warn users that sampling defeats the incremental append optimization
            warnedSamplingDefeatsFastPath.add(seriesIndex);
            console.warn(
              `[ChartGPU] appendData() on series ${seriesIndex} with sampling='${s.sampling}' causes full buffer re-upload every frame. ` +
                `For optimal streaming performance, use sampling='none' or rely on GPU decimation for auto/lttb/min/max. ` +
                `See docs/internal/INCREMENTAL_APPEND_OPTIMIZATION.md for details.`,
            );
          }

          // Thin path: after GPU modular append, point coordinator raw at staging
          // (no RingXYColumns pack). Bounds from O(1) endpoints + new-batch y.
          if (
            useStagingThinPath &&
            maxPoints != null &&
            appendedGpuThisFrame.has(seriesIndex)
          ) {
            const n = getPointCount(cartesianData);
            const plan = planMaxPointsWindow(prevLen, n, maxPoints);
            try {
              const layout = dataStore.getSeriesRingLayout(seriesIndex);
              const staging = dataStore.getSeriesStagingBuffer(seriesIndex);
              const count = dataStore.getSeriesPointCount(seriesIndex);
              const xOffset = dataStore.getSeriesXOffset(seriesIndex);
              const prevView = isStagingRingView(raw) ? raw : null;
              raw = createStagingRingView(
                staging,
                layout.start,
                layout.capacity,
                count,
                xOffset,
                prevView,
              );
              runtimeRawDataByIndex[seriesIndex] = raw;

              // O(1) x endpoints + incremental y (never shrinks on drop — same
              // conservative product policy as RingXYColumns path).
              const x0 = getX(raw as unknown as CartesianSeriesData, 0);
              const x1 = getX(
                raw as unknown as CartesianSeriesData,
                Math.max(0, count - 1),
              );
              const prevB = runtimeRawBoundsByIndex[seriesIndex];
              let yMin = prevB?.yMin ?? Number.POSITIVE_INFINITY;
              let yMax = prevB?.yMax ?? Number.NEGATIVE_INFINITY;
              const end = plan.newSrcOffset + plan.keepNewCount;
              for (let i = plan.newSrcOffset; i < end; i++) {
                const y = getY(cartesianData, i);
                if (Number.isFinite(y)) {
                  if (y < yMin) yMin = y;
                  if (y > yMax) yMax = y;
                }
              }
              if (
                Number.isFinite(x0) &&
                Number.isFinite(x1) &&
                Number.isFinite(yMin) &&
                Number.isFinite(yMax)
              ) {
                let xMin = x0;
                let xMax = x1;
                if (xMin === xMax) xMax = xMin + 1;
                if (yMin === yMax) yMax = yMin + 1;
                runtimeRawBoundsByIndex[seriesIndex] = {
                  xMin,
                  xMax,
                  yMin,
                  yMax,
                };
              } else if (plan.didWindow) {
                didWindow = true;
              }
            } catch {
              // DataStore not ready or rebind failed after append — demote any
              // stale StagingRingView so fallthrough dual-pack can re-sync.
              raw = demoteStagingViewAfterRebindFailure(raw);
            }
            if (isStagingRingView(raw)) {
              continue;
            }
          }

          // Full column path (tooltip on, or thin path unavailable).
          if (raw == null || isStagingRingView(raw)) {
            raw = ensureMutableRuntimeColumns(seriesIndex, s);
          }

          // Update runtime columnar storage with the same window policy as DataStore.
          const n = getPointCount(cartesianData);
          let plan = planMaxPointsWindow(prevLen, n, maxPoints);

          // Leave-ring or capacity mismatch: demote RingXY → chronological linear
          // so we match DataStore rebuild (linearize + ringStart=0).
          if (isRingXYColumns(raw)) {
            const capMismatch =
              plan.isRing &&
              plan.ringCapacity > 0 &&
              raw.capacity !== plan.ringCapacity;
            if (!plan.isRing || capMismatch) {
              const demoted = brandOwnedColumns({
                x: [] as number[],
                y: [] as number[],
              });
              const count = raw.count;
              for (let i = 0; i < count; i++) {
                demoted.x.push(
                  getX(raw as unknown as CartesianSeriesData, i),
                );
                demoted.y.push(
                  getY(raw as unknown as CartesianSeriesData, i),
                );
              }
              raw = demoted;
              runtimeRawDataByIndex[seriesIndex] = demoted;
              prevLen = demoted.x.length;
              plan = planMaxPointsWindow(prevLen, n, maxPoints);
            }
          }

          // Promote to modular ring when maxPoints is active so steady-state
          // FIFO is O(append) on CPU columns (no O(n) dropPrefix every frame).
          if (
            plan.isRing &&
            plan.ringCapacity > 0 &&
            !isRingXYColumns(raw)
          ) {
            const linear = raw as MutableXYColumns;
            const ring = createRingXYColumns(plan.ringCapacity);
            // Tail of linear matches planMaxPointsWindow drop semantics when
            // prevCount > capacity (keep last min(prev, cap) before packing new).
            const seedCount = Math.min(linear.x.length, plan.ringCapacity);
            const seedStart = Math.max(0, linear.x.length - seedCount);
            for (let i = 0; i < seedCount; i++) {
              ring.x[i] = linear.x[seedStart + i]!;
              ring.y[i] = linear.y[seedStart + i]!;
            }
            ring.count = seedCount;
            ring.start = 0;
            raw = ring;
            runtimeRawDataByIndex[seriesIndex] = ring;
            // Re-plan against the ring's current length (may have trimmed seed).
            const plan2 = planMaxPointsWindow(ring.count, n, maxPoints);
            appendIntoRingXY(
              ring,
              cartesianData,
              plan2.newSrcOffset,
              plan2.keepNewCount,
              plan2.dropPrevCount,
            );
            if (plan2.didWindow) {
              // Promote+window: cheap endpoint bounds (same as steady ring path).
              // Note: y-range never shrinks on drop (O(1) conservative); x uses ends.
              const x0 = getX(ring as unknown as CartesianSeriesData, 0);
              const x1 = getX(
                ring as unknown as CartesianSeriesData,
                ring.count - 1,
              );
              const prevB = runtimeRawBoundsByIndex[seriesIndex];
              let yMin = prevB?.yMin ?? Number.POSITIVE_INFINITY;
              let yMax = prevB?.yMax ?? Number.NEGATIVE_INFINITY;
              const end = plan2.newSrcOffset + plan2.keepNewCount;
              for (let i = plan2.newSrcOffset; i < end; i++) {
                const y = getY(cartesianData, i);
                if (Number.isFinite(y)) {
                  if (y < yMin) yMin = y;
                  if (y > yMax) yMax = y;
                }
              }
              if (
                Number.isFinite(x0) &&
                Number.isFinite(x1) &&
                Number.isFinite(yMin) &&
                Number.isFinite(yMax)
              ) {
                let xMin = x0;
                let xMax = x1;
                if (xMin === xMax) xMax = xMin + 1;
                if (yMin === yMax) yMax = yMin + 1;
                runtimeRawBoundsByIndex[seriesIndex] = {
                  xMin,
                  xMax,
                  yMin,
                  yMax,
                };
              } else {
                didWindow = true;
              }
            } else {
              runtimeRawBoundsByIndex[seriesIndex] =
                extendBoundsWithCartesianData(
                  runtimeRawBoundsByIndex[seriesIndex],
                  cartesianData,
                );
            }
            continue;
          }

          if (isRingXYColumns(raw)) {
            appendIntoRingXY(
              raw,
              cartesianData,
              plan.newSrcOffset,
              plan.keepNewCount,
              plan.dropPrevCount,
            );
            if (plan.didWindow) {
              // O(1) endpoint bounds for ring (avoid O(n) full rescan every wrap frame).
              // y-range never shrinks when peaks leave the window (intentionally
              // conservative product behavior for high-rate FIFO). x uses
              // chronological ends of the retained ring.
              const prevB = runtimeRawBoundsByIndex[seriesIndex];
              const x0 = getX(raw as unknown as CartesianSeriesData, 0);
              const x1 = getX(
                raw as unknown as CartesianSeriesData,
                raw.count - 1,
              );
              let yMin = prevB?.yMin ?? Number.POSITIVE_INFINITY;
              let yMax = prevB?.yMax ?? Number.NEGATIVE_INFINITY;
              const end = plan.newSrcOffset + plan.keepNewCount;
              for (let i = plan.newSrcOffset; i < end; i++) {
                const y = getY(cartesianData, i);
                if (Number.isFinite(y)) {
                  if (y < yMin) yMin = y;
                  if (y > yMax) yMax = y;
                }
              }
              if (
                Number.isFinite(x0) &&
                Number.isFinite(x1) &&
                Number.isFinite(yMin) &&
                Number.isFinite(yMax)
              ) {
                let xMin = x0;
                let xMax = x1;
                if (xMin === xMax) xMax = xMin + 1;
                if (yMin === yMax) yMax = yMin + 1;
                runtimeRawBoundsByIndex[seriesIndex] = {
                  xMin,
                  xMax,
                  yMin,
                  yMax,
                };
              } else {
                didWindow = true; // fall through to full rescan below
              }
            } else {
              runtimeRawBoundsByIndex[seriesIndex] =
                extendBoundsWithCartesianData(
                  runtimeRawBoundsByIndex[seriesIndex],
                  cartesianData,
                );
            }
            continue;
          }

          // Linear MutableXYColumns path (unbounded append or demoted ring).
          const linear = raw as MutableXYColumns;
          if (plan.dropPrevCount > 0) {
            dropPrefixXY(
              linear.x,
              linear.y,
              plan.dropPrevCount,
              linear.size,
            );
            didWindow = true;
          }
          const rawLenBefore = linear.x.length;
          const end = plan.newSrcOffset + plan.keepNewCount;
          for (let i = plan.newSrcOffset; i < end; i++) {
            linear.x.push(getX(cartesianData, i));
            linear.y.push(getY(cartesianData, i));

            const sizeValue = getSize(cartesianData, i);
            if (sizeValue !== undefined) {
              if (!linear.size) {
                linear.size = new Array(rawLenBefore + (i - plan.newSrcOffset));
              }
              linear.size.push(sizeValue);
            } else if (linear.size) {
              linear.size.push(undefined);
            }
          }

          if (!plan.didWindow) {
            runtimeRawBoundsByIndex[seriesIndex] =
              extendBoundsWithCartesianData(
                runtimeRawBoundsByIndex[seriesIndex],
                cartesianData,
              );
          } else {
            didWindow = true;
          }
        }

        if (didWindow) {
          // Dropping a prefix can invalidate xMin / y extrema — rescan retained window.
          runtimeRawBoundsByIndex[seriesIndex] =
            computeRawBoundsFromCartesianData(raw as CartesianSeriesData);
        }
      }

      // Invalidate cache for this series since data has changed.
      // MutableXYColumns grow under a stable ref — clear setSeries + filterGaps
      // caches so prepare does not reuse pre-append results (P1-2 / P2-12).
      lastSampledData[seriesIndex] = null;
      lastSetSeriesCache.delete(seriesIndex);
      filterGapsCache.delete(seriesIndex);
    }

    pendingAppendByIndex.clear();
    if (!didAppendAny) return false;

    // Dataset-aware zoom span constraints depend on raw point density.
    // When streaming appends add points, recompute and apply constraints so wheel+slider remain consistent.
    // Arm auto-scroll source kind before setSpanConstraints (clamping may emit onChange).
    if (canAutoScroll) pendingZoomSourceKind = "auto-scroll";
    if (zoomState) {
      const constraints = computeEffectiveZoomSpanConstraints();
      const withConstraints = zoomState as unknown as {
        setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
      };
      withConstraints.setSpanConstraints?.(
        constraints.minSpan,
        constraints.maxSpan,
      );
    }

    // Auto-scroll is applied only on append (not on `setOptions`).
    // Re-arm in case setSpanConstraints already triggered onChange and cleared.
    if (canAutoScroll && zoomRangeBefore && prevVisibleXDomain) {
      pendingZoomSourceKind = "auto-scroll";
      const r = zoomRangeBefore;
      if (r.end >= 99.5) {
        const span = r.end - r.start;
        const anchored = zoomState! as unknown as {
          setRangeAnchored?: (
            start: number,
            end: number,
            anchor: "start" | "end" | "center",
          ) => void;
        };
        // Keep end pinned when constraints clamp the span.
        if (anchored.setRangeAnchored) {
          anchored.setRangeAnchored(100 - span, 100, "end");
        } else {
          zoomState!.setRange(100 - span, 100);
        }
      } else {
        const nextBaseXDomain = computeBaseXDomain(
          currentOptions,
          runtimeRawBoundsByIndex,
        );
        const span = nextBaseXDomain.max - nextBaseXDomain.min;
        if (Number.isFinite(span) && span > 0) {
          const nextStartRaw =
            ((prevVisibleXDomain.min - nextBaseXDomain.min) / span) * 100;
          const nextEndRaw =
            ((prevVisibleXDomain.max - nextBaseXDomain.min) / span) * 100;
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

  const executeFlush = (options?: {
    readonly requestRenderAfter?: boolean;
  }): void => {
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
    flushTimeoutId = (typeof self !== "undefined" ? self : window).setTimeout(
      () => {
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
      },
      16,
    );
  };

  const scheduleZoomResample = (): void => {
    if (disposed) return;

    cancelZoomResampleDebounce();
    zoomResampleDue = false;

    zoomResampleDebounceTimer = (
      typeof self !== "undefined" ? self : window
    ).setTimeout(() => {
      zoomResampleDebounceTimer = null;
      if (disposed) return;
      zoomResampleDue = true;
      scheduleFlush();
    }, 100);
  };

  const getPlotSizeCssPx = (
    canvas: HTMLCanvasElement,
    gridArea: GridArea,
  ): {
    readonly plotWidthCss: number;
    readonly plotHeightCss: number;
  } | null => {
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
    domains: {
      readonly xDomain: { readonly min: number; readonly max: number };
      readonly yDomains: Map<string, { readonly min: number; readonly max: number }>;
    },
  ): {
    readonly xScale: LinearScale;
    readonly yScales: Map<string, LinearScale>;
    readonly plotWidthCss: number;
    readonly plotHeightCss: number;
  } | null => {
    const canvas = gpuContext.canvas;
    if (!canvas) return null;

    const plotSize = getPlotSizeCssPx(canvas, gridArea);
    if (!plotSize) return null;

    const xScale = createLinearScale()
      .domain(domains.xDomain.min, domains.xDomain.max)
      .range(0, plotSize.plotWidthCss);
    const yScales = new Map<string, LinearScale>();
    for (const [id, dom] of domains.yDomains) {
      yScales.set(id, createLinearScale().domain(dom.min, dom.max).range(plotSize.plotHeightCss, 0));
    }

    return {
      xScale,
      yScales,
      plotWidthCss: plotSize.plotWidthCss,
      plotHeightCss: plotSize.plotHeightCss,
    };
  };

  const buildTooltipParams = (
    seriesIndex: number,
    dataIndex: number,
    point: DataPoint,
  ): TooltipParams => {
    const s = currentOptions.series[seriesIndex];
    const { x, y } = getPointXY(point);
    return {
      seriesName: s?.name ?? "",
      seriesIndex,
      dataIndex,
      value: [x, y],
      color: s?.color ?? "#888",
    };
  };

  const buildCandlestickTooltipParams = (
    seriesIndex: number,
    dataIndex: number,
    point: OHLCDataPoint,
  ): TooltipParams => {
    const s = currentOptions.series[seriesIndex];
    if (isTupleOHLCDataPoint(point)) {
      return {
        seriesName: s?.name ?? "",
        seriesIndex,
        dataIndex,
        value: [point[0], point[1], point[2], point[3], point[4]] as const,
        color: s?.color ?? "#888",
      };
    } else {
      return {
        seriesName: s?.name ?? "",
        seriesIndex,
        dataIndex,
        value: [
          point.timestamp,
          point.open,
          point.close,
          point.low,
          point.high,
        ] as const,
        color: s?.color ?? "#888",
      };
    }
  };

  // Helper: Find pie slice at pointer position (extracted to avoid duplication)
  const findPieSliceAtPointer = (
    series: ResolvedChartGPUOptions["series"],
    gridX: number,
    gridY: number,
    plotWidthCss: number,
    plotHeightCss: number,
  ): ReturnType<typeof findPieSlice> | null => {
    const maxRadiusCss = 0.5 * Math.min(plotWidthCss, plotHeightCss);
    if (!(maxRadiusCss > 0)) return null;

    // Iterate from last to first for correct z-ordering (last series drawn on top)
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      if (s.type !== "pie") continue;
      // Skip invisible series (pie hit-testing should respect visibility)
      if (s.visible === false) continue;
      const pieSeries = s as ResolvedPieSeriesConfig;
      const center = resolvePieCenterPlotCss(
        pieSeries.center,
        plotWidthCss,
        plotHeightCss,
      );
      const radii = resolvePieRadiiCss(pieSeries.radius, maxRadiusCss);
      const m = findPieSlice(
        gridX,
        gridY,
        { seriesIndex: i, series: pieSeries },
        center,
        radii,
      );
      if (m) return m;
    }
    return null;
  };

  // Helper: Find candlestick match at pointer position (hoisted to avoid closure allocation)
  const findCandlestickAtPointer = (
    series: ResolvedChartGPUOptions["series"],
    gridX: number,
    gridY: number,
    interactionScales: NonNullable<
      ReturnType<typeof computeInteractionScalesGridCssPx>
    >,
  ): {
    params: TooltipParams;
    match: { point: OHLCDataPoint };
    seriesIndex: number;
  } | null => {
    // Iterate from last to first for correct z-ordering (last series drawn on top)
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      if (s.type !== "candlestick") continue;
      // Skip invisible series (candlestick hit-testing should respect visibility)
      if (s.visible === false) continue;

      const cs = s as ResolvedCandlestickSeriesConfig;
      const barWidthClip = computeCandlestickBodyWidthRange(
        cs,
        cs.data,
            interactionScales.xScale,
            interactionScales.plotWidthCss,
          );
          
          const m = findCandlestick(
            [cs],
            gridX,
            gridY,
            interactionScales.xScale,
            interactionScales.yScales.get((s as any).yAxis || "y")!,
            barWidthClip,
          );
      if (!m) continue;

      const params = buildCandlestickTooltipParams(i, m.dataIndex, m.point);
      return { params, match: { point: m.point }, seriesIndex: i };
    }
    return null;
  };

  const onMouseMove = (payload: ChartGPUEventPayload): void => {
    pointerState = {
      source: "mouse",
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
      setInteractionXInternal(
        Number.isFinite(xDomain) ? xDomain : null,
        "mouse",
      );
    } else if (!payload.isInGrid) {
      // Clear interaction-x when leaving the plot area (keeps synced charts from ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œstickingÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â).
      setInteractionXInternal(null, "mouse");
    }

    crosshairRenderer.setVisible(payload.isInGrid);
    requestRender();
  };

  const onMouseLeave = (_payload: ChartGPUEventPayload): void => {
    // Only clear interaction overlays for real pointer interaction.
    // If we're being driven by a sync-x, leaving the canvas shouldn't hide the overlays.
    if (pointerState.source !== "mouse") return;

    pointerState = { ...pointerState, isInGrid: false, hasPointer: false };
    crosshairRenderer.setVisible(false);
    hideTooltip();
    setInteractionXInternal(null, "mouse");
    requestRender();
  };

  // Register event listeners only if event manager is available (HTMLCanvasElement).
  if (eventManager) {
    eventManager.on("mousemove", onMouseMove);
    eventManager.on("mouseleave", onMouseLeave);
  }

  // Optional internal ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œinside zoomÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â (wheel zoom + drag pan).
  let zoomState: ZoomState | null = null;
  let insideZoom: ReturnType<typeof createInsideZoom> | null = null;
  let unsubscribeZoom: (() => void) | null = null;
  let lastOptionsZoomRange: Readonly<{ start: number; end: number }> | null =
    null;
  let pendingZoomSourceKind: ZoomChangeSourceKind | undefined = undefined;
  const zoomRangeListeners = new Set<
    (
      range: Readonly<{ start: number; end: number }>,
      sourceKind?: ZoomChangeSourceKind,
    ) => void
  >();

  const emitZoomRange = (
    range: Readonly<{ start: number; end: number }>,
    sourceKind?: ZoomChangeSourceKind,
  ): void => {
    const snapshot = Array.from(zoomRangeListeners);
    for (const cb of snapshot) cb(range, sourceKind);
  };

  const getZoomOptionsConfig = (
    opts: ResolvedChartGPUOptions,
  ): {
    readonly start: number;
    readonly end: number;
    readonly hasInside: boolean;
  } | null => {
    // Zoom is enabled when *either* inside or slider exists. A single shared percent-space
    // window is used for both.
    const insideCfg = opts.dataZoom?.find((z) => z?.type === "inside");
    const sliderCfg = opts.dataZoom?.find((z) => z?.type === "slider");
    const cfg = insideCfg ?? sliderCfg;
    if (!cfg) return null;
    const start = Number.isFinite(cfg.start) ? cfg.start! : 0;
    const end = Number.isFinite(cfg.end) ? cfg.end! : 100;
    return { start, end, hasInside: !!insideCfg };
  };

  const clampPercent = (v: number): number => Math.min(100, Math.max(0, v));

  const getZoomSpanConstraintsFromOptions = (
    opts: ResolvedChartGPUOptions,
  ): { readonly minSpan?: number; readonly maxSpan?: number } => {
    let minSpan: number | null = null;
    let maxSpan: number | null = null;

    const list = opts.dataZoom ?? [];
    for (const z of list) {
      if (!z) continue;
      if (z.type !== "inside" && z.type !== "slider") continue;

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
    if (currentOptions.xAxis.type === "category") return null;

    let maxPoints = 0;
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (s.type === "pie") continue;
      if (s.type === "candlestick") {
        const raw =
          (runtimeRawDataByIndex[i] as ReadonlyArray<OHLCDataPoint> | null) ??
          ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
        maxPoints = Math.max(maxPoints, raw.length);
        continue;
      }

      // Cartesian series: runtime store is MutableXYColumns or RingXYColumns
      const rawCartesian = runtimeRawDataByIndex[i];
      const pointCount = rawCartesian
        ? getPointCount(rawCartesian as CartesianSeriesData)
        : getPointCount((s.rawData ?? s.data) as CartesianSeriesData);
      maxPoints = Math.max(maxPoints, pointCount);
    }

    if (maxPoints < 2) return null;
    const v = 100 / (maxPoints - 1);
    return Number.isFinite(v) ? clampPercent(v) : null;
  };

  const computeEffectiveZoomSpanConstraints = (): {
    readonly minSpan: number;
    readonly maxSpan: number;
  } => {
    const fromOptions = getZoomSpanConstraintsFromOptions(currentOptions);
    const datasetMin = computeDatasetAwareDefaultMinSpan();

    // Preserve legacy behavior when no constraints (and no dataset signal) are available.
    // The coordinator will typically override this with datasetMin when the data supports it.
    const minSpan = Number.isFinite(fromOptions.minSpan as number)
      ? clampPercent(fromOptions.minSpan as number)
      : (datasetMin ?? 0.5);
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
      withConstraints.setSpanConstraints?.(
        constraints.minSpan,
        constraints.maxSpan,
      );

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
    // Runtime data references are about to be regenerated; invalidate the per-frame
    // setSeries cache so the next render uploads the fresh references (P1-2).
    lastSetSeriesCache.clear();
    filterGapsCache.clear();

    for (let i = 0; i < count; i++) {
      const s = currentOptions.series[i]!;
      if (s.type === "pie") continue;

      if (s.type === "candlestick") {
        // Store candlestick raw OHLC data (not for streaming append, but for zoom-aware resampling).
        const rawOHLC = (s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>;
        const owned = rawOHLC.length === 0 ? [] : rawOHLC.slice();
        runtimeRawDataByIndex[i] = owned;
        runtimeRawBoundsByIndex[i] = s.rawBounds ?? null;
        continue;
      }

      const raw = (s.rawData ?? s.data) as CartesianSeriesData;
      // Full rewrite path: keep the raw data reference to avoid O(n) MutableXYColumns
      // allocations every setOption (SciChart groups 2/3/4). appendData promotes to
      // branded owned columns / ring on the first stream batch — never mutates the
      // caller's {x,y} arrays or DataPoint[] in place.
      runtimeRawDataByIndex[i] = raw;
      runtimeRawBoundsByIndex[i] =
        s.rawBounds ?? computeRawBoundsFromCartesianData(raw);
    }
  };

  /**
   * True when runtime storage is coordinator-owned MutableXYColumns (branded).
   * User-supplied `{ x, y }` from setOption is NOT owned and must be copied on append.
   */
  const isOwnedMutableColumns = (
    data: unknown,
  ): data is MutableXYColumns => {
    if (data == null || typeof data !== "object" || Array.isArray(data)) {
      return false;
    }
    if (isRingXYColumns(data)) return false;
    return (data as MutableXYColumns)[OWNED_XY_COLUMNS] === true;
  };

  /**
   * Ensure cartesian runtime storage is MutableXYColumns or RingXYColumns before
   * streaming append mutates it. setOption may have stored a raw DataPoint[] or
   * user XYArrays ref — always copy into branded owned columns first.
   */
  const ensureMutableRuntimeColumns = (
    seriesIndex: number,
    s: ResolvedSeriesConfig,
  ): MutableXYColumns | RingXYColumns => {
    const existing = runtimeRawDataByIndex[seriesIndex];
    if (isRingXYColumns(existing)) return existing;
    if (isOwnedMutableColumns(existing)) return existing;
    // Staging views are zero-copy over DataStore; promote to capacity-preserving
    // ring columns when leaving thin path (tooltip on / non-fast-path append)
    // so the next maxPoints append stays O(append) modular — not linear → re-ring.
    if (isStagingRingView(existing)) {
      const ring = stagingRingViewToRingXYColumns(existing);
      runtimeRawDataByIndex[seriesIndex] = ring;
      if (runtimeRawBoundsByIndex[seriesIndex] == null) {
        runtimeRawBoundsByIndex[seriesIndex] =
          computeRawBoundsFromCartesianData(
            ring as unknown as CartesianSeriesData,
          );
      }
      return ring;
    }
    const sAny = s as ResolvedSeriesConfig & {
      rawData?: CartesianSeriesData;
      rawBounds?: Bounds | null;
      data?: CartesianSeriesData;
    };
    const seed =
      (existing as CartesianSeriesData | null) ??
      ((sAny.rawData ?? sAny.data) as CartesianSeriesData);
    const owned = cartesianDataToMutableColumns(seed);
    runtimeRawDataByIndex[seriesIndex] = owned;
    if (runtimeRawBoundsByIndex[seriesIndex] == null) {
      runtimeRawBoundsByIndex[seriesIndex] =
        sAny.rawBounds ?? computeRawBoundsFromCartesianData(seed);
    }
    return owned;
  };

  const recomputeRuntimeBaseSeries = (): void => {
    const next: ResolvedChartGPUOptions["series"][number][] = new Array(
      currentOptions.series.length,
    );
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (s.type === "pie") {
        next[i] = s;
        continue;
      }

      if (s.type === "candlestick") {
        const rawOHLC =
          (runtimeRawDataByIndex[i] as ReadonlyArray<OHLCDataPoint> | null) ??
          ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
        const bounds = runtimeRawBoundsByIndex[i] ?? s.rawBounds ?? undefined;
        const baselineSampled =
          s.sampling === "ohlc" && rawOHLC.length > s.samplingThreshold
            ? ohlcSample(rawOHLC, s.samplingThreshold)
            : rawOHLC;
        next[i] = {
          ...s,
          rawData: rawOHLC,
          rawBounds: bounds,
          data: baselineSampled,
        };
        continue;
      }

      // Cartesian series: runtime store is MutableXYColumns (compatible with CartesianSeriesData at runtime)
      const rawCartesian: CartesianSeriesData =
        (runtimeRawDataByIndex[
          i
        ] as MutableXYColumns | null as CartesianSeriesData) ??
        ((s.rawData ?? s.data) as CartesianSeriesData);
      const bounds = runtimeRawBoundsByIndex[i] ?? s.rawBounds ?? undefined;
      // GPU decimation: keep raw on the series; prepareSeries uploads raw and
      // runs compute. CPU path still samples for display.
      const baselineSampled = isGpuDecimationEligible(s, rawCartesian)
        ? rawCartesian
        : sampleSeriesDataPoints(
            rawCartesian,
            s.sampling,
            s.samplingThreshold,
          );
      next[i] = {
        ...s,
        rawData: rawCartesian,
        rawBounds: bounds,
        data: baselineSampled,
      };
    }
    runtimeBaseSeries = next;
  };

  function sliceRenderSeriesToVisibleRange(): void {
    const zoomRange = zoomState?.getRange() ?? null;
    const baseXDomain = computeBaseXDomain(
      currentOptions,
      runtimeRawBoundsByIndex,
    );
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

    const next: ResolvedChartGPUOptions["series"][number][] = new Array(
      runtimeBaseSeries.length,
    );

    for (let i = 0; i < runtimeBaseSeries.length; i++) {
      const baseline = runtimeBaseSeries[i]!;

      // Pie charts don't need slicing
      if (baseline.type === "pie") {
        next[i] = baseline;
        continue;
      }

      const cache = lastSampledData[i];

      // Strategy 1: Use cache if it covers visible range
      if (
        cache &&
        visibleX.min >= cache.cachedRange.min &&
        visibleX.max <= cache.cachedRange.max
      ) {
        if (baseline.type === "candlestick") {
          next[i] = {
            ...baseline,
            data: sliceVisibleRangeByOHLC(
              cache.data as ReadonlyArray<OHLCDataPoint>,
              visibleX.min,
              visibleX.max,
            ),
          };
        } else {
          next[i] = {
            ...baseline,
            data: sliceVisibleRangeByX(
              cache.data as CartesianSeriesData,
              visibleX.min,
              visibleX.max,
            ),
          };
        }
        continue;
      }

      // Strategy 2: Fallback to baseline sampled data
      if (baseline.type === "candlestick") {
        next[i] = {
          ...baseline,
          data: sliceVisibleRangeByOHLC(
            baseline.data as ReadonlyArray<OHLCDataPoint>,
            visibleX.min,
            visibleX.max,
          ),
        };
      } else {
        next[i] = {
          ...baseline,
          data: sliceVisibleRangeByX(
            baseline.data as CartesianSeriesData,
            visibleX.min,
            visibleX.max,
          ),
        };
      }
    }

    renderSeries = next;
    // Recompute visible y-bounds from the sliced renderSeries
    recomputeCachedVisibleYBoundsIfNeeded();
  }

  function recomputeRenderSeries(): void {
    const zoomRange = zoomState?.getRange() ?? null;
    const baseXDomain = computeBaseXDomain(
      currentOptions,
      runtimeRawBoundsByIndex,
    );
    const visibleX = computeVisibleXDomain(baseXDomain, zoomRange);

    // Add buffer zone (ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â±10% beyond visible range) for caching
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

    const next: ResolvedChartGPUOptions["series"][number][] = new Array(
      runtimeBaseSeries.length,
    );

    for (let i = 0; i < runtimeBaseSeries.length; i++) {
      const s = runtimeBaseSeries[i]!;

      if (s.type === "pie") {
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
      if (s.type === "candlestick") {
        const rawOHLC =
          (runtimeRawDataByIndex[i] as ReadonlyArray<OHLCDataPoint> | null) ??
          ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
        // Slice to buffered range for sampling
        const bufferedOHLC = sliceVisibleRangeByOHLC(
          rawOHLC,
          bufferedMin,
          bufferedMax,
        );

        const sampling = s.sampling;
        const baseThreshold = s.samplingThreshold;

        const baseT = Number.isFinite(baseThreshold)
          ? Math.max(1, baseThreshold | 0)
          : 1;
        const maxTarget = Math.min(
          MAX_TARGET_POINTS_ABS,
          Math.max(MIN_TARGET_POINTS, baseT * MAX_TARGET_MULTIPLIER),
        );
        const target = clampInt(
          Math.round(baseT / spanFracSafe),
          MIN_TARGET_POINTS,
          maxTarget,
        );

        const sampled =
          sampling === "ohlc" && bufferedOHLC.length > target
            ? ohlcSample(bufferedOHLC, target)
            : bufferedOHLC;

        // Store sampled data in cache with buffered range
        lastSampledData[i] = {
          data: sampled,
          cachedRange: { min: bufferedMin, max: bufferedMax },
          timestamp: Date.now(),
        };

        // Slice to actual visible range for renderSeries
        const visibleSampled = sliceVisibleRangeByOHLC(
          sampled,
          visibleX.min,
          visibleX.max,
        );
        next[i] = { ...s, data: visibleSampled };
        continue;
      }

      // Cartesian series (line, area, bar, scatter).
      // Runtime store is MutableXYColumns (compatible with CartesianSeriesData at runtime)
      const rawCartesian: CartesianSeriesData =
        (runtimeRawDataByIndex[
          i
        ] as MutableXYColumns | null as CartesianSeriesData) ??
        ((s.rawData ?? s.data) as CartesianSeriesData);
      // Slice to buffered range for sampling
      const bufferedRaw = sliceVisibleRangeByX(
        rawCartesian,
        bufferedMin,
        bufferedMax,
      );

      const sampling = s.sampling;
      const baseThreshold = s.samplingThreshold;

      const baseT = Number.isFinite(baseThreshold)
        ? Math.max(1, baseThreshold | 0)
        : 1;
      const maxTarget = Math.min(
        MAX_TARGET_POINTS_ABS,
        Math.max(MIN_TARGET_POINTS, baseT * MAX_TARGET_MULTIPLIER),
      );
      const target = clampInt(
        Math.round(baseT / spanFracSafe),
        MIN_TARGET_POINTS,
        maxTarget,
      );

      // GPU decimation: keep full raw (not a zoom-sliced sample). The compute
      // shader scopes work via visibleStart/visibleEnd uniforms in prepareSeries.
      if (isGpuDecimationEligible(s, bufferedRaw)) {
        next[i] = {
          ...s,
          rawData: rawCartesian,
          data: rawCartesian,
        };
        continue;
      }

      const sampled = sampleSeriesDataPoints(bufferedRaw, sampling, target);

      // Store sampled data in cache with buffered range
      lastSampledData[i] = {
        data: sampled,
        cachedRange: { min: bufferedMin, max: bufferedMax },
        timestamp: Date.now(),
      };

      // Slice to actual visible range for renderSeries
      const visibleSampled = sliceVisibleRangeByX(
        sampled,
        visibleX.min,
        visibleX.max,
      );
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

  const rendererPool = createRendererPool({
    device,
    targetFormat,
    pipelineCache,
    sampleCount: MAIN_SCENE_MSAA_SAMPLE_COUNT,
  });

  rendererPool.ensureAreaRendererCount(currentOptions.series.length);
  rendererPool.ensureLineRendererCount(currentOptions.series.length);
  rendererPool.ensureDecimationComputeCount(currentOptions.series.length);
  rendererPool.ensureScatterRendererCount(currentOptions.series.length);
  rendererPool.ensureScatterDensityRendererCount(currentOptions.series.length);
  rendererPool.ensurePieRendererCount(currentOptions.series.length);
  rendererPool.ensureCandlestickRendererCount(currentOptions.series.length);

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error("RenderCoordinator is disposed.");
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

  const isDomainEqual = (
    a: { readonly min: number; readonly max: number },
    b: { readonly min: number; readonly max: number },
  ): boolean => a.min === b.min && a.max === b.max;

  const setOptions: RenderCoordinator["setOptions"] = (resolvedOptions) => {
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
        return computeUpdateSnapshotAtProgress(
          updateTransition,
          updateProgress01,
          fromZoomRange,
        );
      }

      const fromXBase = computeBaseXDomain(
        currentOptions,
        runtimeRawBoundsByIndex,
      );
      const fromXVisible = computeVisibleXDomain(fromXBase, fromZoomRange);
      const fromYBaseDomains = new Map<string, { min: number; max: number }>();
      for (const ax of currentOptions.yAxes) {
        fromYBaseDomains.set(
          ax.id!,
          computeBaseYDomainForAxis(
            currentOptions,
            ax.id!,
            runtimeRawBoundsByIndex,
            cachedVisibleYBoundsByAxis.get(ax.id!) ?? null,
          ),
        );
      }
      return {
        xBaseDomain: fromXBase,
        xVisibleDomain: { min: fromXVisible.min, max: fromXVisible.max },
        yBaseDomains: fromYBaseDomains,
        series: renderSeries,
      };
    })();

    // Cancel any prior update transition AFTER capturing the rebased "from" snapshot.
    cancelUpdateTransition();
    const prevSeries = currentOptions.series;
    const likelyDataChanged = didSeriesDataLikelyChange(
      prevSeries,
      resolvedOptions.series,
    );
    // P1-7: full baseline + zoom re-sample only when raw data or sampling config changes.
    // Theme/legend/color presentation updates reuse already-sampled series data.
    const needsBaselineResample = shouldRecomputeBaselineSampling(
      prevSeries,
      resolvedOptions.series,
    );

    currentOptions = resolvedOptions;

    if (likelyDataChanged) {
      // Series data or structure changed — full reset of runtime data state.
      runtimeBaseSeries = resolvedOptions.series;
      renderSeries = resolvedOptions.series;
      gpuSeriesKindByIndex = new Array(resolvedOptions.series.length).fill(
        "unknown",
      );
      lastSampledData = new Array(resolvedOptions.series.length).fill(null);
      cancelZoomResampleDebounce();
      zoomResampleDue = false;
      cancelScheduledFlush();
      initRuntimeSeriesFromOptions();
    }

    // Always refresh: annotations, themes, tooltip config, etc. may have changed.
    cachedVisibleYBoundsByAxis.clear();
    legend?.update(resolvedOptions.series, resolvedOptions.theme);
    if (needsBaselineResample) {
      // Sampling path may flip (e.g. line areaStyle on/off → GPU vs CPU). Retag
      // buffer kinds so append fast-path and prepareSeries do not keep a stale kind.
      if (!likelyDataChanged) {
        gpuSeriesKindByIndex = new Array(resolvedOptions.series.length).fill(
          "unknown",
        );
        lastSetSeriesCache.clear();
        filterGapsCache.clear();
        lastSampledData = new Array(resolvedOptions.series.length).fill(null);
        // Presentation-stable data: re-sample from runtime store (append path
        // also uses this via flush).
        recomputeRuntimeBaseSeries();
      } else {
        // Full data rewrite: OptionResolver already sampled `currentOptions.series`.
        // Do NOT re-run LTTB/OHLC here — that was a double O(n) on every SciChart
        // full-setOption frame. Align rawData/rawBounds with the runtime store only.
        runtimeBaseSeries = currentOptions.series.map((s, i) => {
          if (s.type === "pie") return s;
          if (s.type === "candlestick") {
            const rawOHLC =
              (runtimeRawDataByIndex[i] as ReadonlyArray<OHLCDataPoint> | null) ??
              ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
            return {
              ...s,
              rawData: rawOHLC,
              rawBounds: runtimeRawBoundsByIndex[i] ?? s.rawBounds ?? undefined,
            };
          }
          const rawCartesian: CartesianSeriesData =
            (runtimeRawDataByIndex[i] as MutableXYColumns | null as
              | CartesianSeriesData
              | null) ?? ((s.rawData ?? s.data) as CartesianSeriesData);
          const bounds =
            runtimeRawBoundsByIndex[i] ?? s.rawBounds ?? undefined;
          // GPU decimation wants raw on the series (prepareSeries runs compute).
          if (isGpuDecimationEligible(s, rawCartesian)) {
            return {
              ...s,
              rawData: rawCartesian,
              rawBounds: bounds,
              data: rawCartesian,
            };
          }
          return {
            ...s,
            rawData: rawCartesian,
            rawBounds: bounds,
            // keep s.data — already sampled by OptionResolver
          };
        }) as ResolvedChartGPUOptions["series"];
      }
      updateZoom();
      recomputeRenderSeries();
    } else {
      // Presentation-only: patch series metadata (colors, names, styles) onto the
      // already-sampled baseline and render series without re-running LTTB.
      // When rawBoundsMode flips (axes explicit → auto under same data ref):
      // recompute runtimeRawBoundsByIndex from **owned runtime columns** when
      // present (includes appendData extrema) — same as ChartGPU hit-test —
      // not only resolver seed rawBounds (which omit appends).
      const boundsModeChanged = didRawBoundsModeChange(
        prevSeries,
        resolvedOptions.series,
      );
      if (boundsModeChanged) {
        for (let i = 0; i < resolvedOptions.series.length; i++) {
          const s = resolvedOptions.series[i]!;
          if (s.type === "pie") continue;
          const mode = (s as { rawBoundsMode?: string }).rawBoundsMode;
          const rb = (s as { rawBounds?: Bounds | null }).rawBounds ?? null;
          if (mode === "data" || mode === "xDataYAxis") {
            // Prefer scanning runtime store (owned columns / ring / raw ref after
            // promote) so append-extended extrema survive axes-auto flip.
            const runtime = runtimeRawDataByIndex[i];
            if (runtime != null && s.type !== "candlestick") {
              runtimeRawBoundsByIndex[i] =
                (computeRawBoundsFromCartesianData(
                  runtime as CartesianSeriesData,
                ) as Bounds | null) ??
                rb ??
                null;
            } else if (s.type === "candlestick") {
              const ohlc =
                (runtime as ReadonlyArray<OHLCDataPoint> | null) ??
                ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
              runtimeRawBoundsByIndex[i] =
                extendBoundsWithOHLCDataPoints(null, ohlc) ?? rb ?? null;
            } else {
              runtimeRawBoundsByIndex[i] = rb;
            }
          } else if (mode === "synthetic" && rb) {
            // Axes fully explicit again — synthetic extents from resolver.
            runtimeRawBoundsByIndex[i] = rb;
          } else if (rb) {
            runtimeRawBoundsByIndex[i] = rb;
          }
        }
      }
      runtimeBaseSeries = patchSeriesPresentationKeepingSampledData(
        resolvedOptions.series,
        runtimeBaseSeries,
      );
      renderSeries = patchSeriesPresentationKeepingSampledData(
        runtimeBaseSeries,
        renderSeries,
      );
      // Keep series.rawBounds aligned with refreshed runtime bounds after mode flip.
      if (boundsModeChanged) {
        const stampRuntimeBounds = (
          series: ResolvedChartGPUOptions["series"],
        ): ResolvedChartGPUOptions["series"] =>
          series.map((s, i) => {
            if (s.type === "pie") return s;
            const b = runtimeRawBoundsByIndex[i];
            return b
              ? ({ ...s, rawBounds: b } as typeof s)
              : s;
          }) as ResolvedChartGPUOptions["series"];
        runtimeBaseSeries = stampRuntimeBounds(runtimeBaseSeries);
        renderSeries = stampRuntimeBounds(renderSeries);
      }
      updateZoom();
      // Rebuild after the unconditional clear above. Without this, default
      // autoBounds: "visible" falls back to global Y until the next zoom
      // resample — and toYBaseDomains can disagree with fromSnapshot,
      // spuriously starting a domain-change animation on theme-only updates.
      recomputeCachedVisibleYBoundsIfNeeded();
    }

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
    rendererPool.ensureDecimationComputeCount(nextCount);
    rendererPool.ensureScatterRendererCount(nextCount);
    rendererPool.ensureScatterDensityRendererCount(nextCount);
    rendererPool.ensurePieRendererCount(nextCount);
    rendererPool.ensureCandlestickRendererCount(nextCount);

    // When the series count shrinks, explicitly destroy per-index GPU buffers for removed series.
    // This avoids recreating the entire DataStore and keeps existing buffers for retained indices.
    if (nextCount < lastSeriesCount) {
      for (let i = nextCount; i < lastSeriesCount; i++) {
        dataStore.removeSeries(i);
        lastSetSeriesCache.delete(i);
        filterGapsCache.delete(i);
      }
    }
    lastSeriesCount = nextCount;

    // If animation is explicitly disabled mid-flight, stop the intro without scheduling more frames.
    if (currentOptions.animation === false && introPhase === "running") {
      introAnimController.cancelAll();
      introAnimId = null;
      introPhase = "done";
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
    const toYBaseDomains = new Map<string, { min: number; max: number }>();
    for (const ax of currentOptions.yAxes) {
      toYBaseDomains.set(
        ax.id!,
        computeBaseYDomainForAxis(
          currentOptions,
          ax.id!,
          runtimeRawBoundsByIndex,
          cachedVisibleYBoundsByAxis.get(ax.id!) ?? null,
        ),
      );
    }
    const toSeriesForTransition = renderSeries;

    // Compare primary axis domain for change detection
    const primaryAxisId = currentOptions.yAxes[0]?.id ?? "y";
    const fromPrimaryY = fromSnapshot.yBaseDomains.get(primaryAxisId) ?? { min: 0, max: 1 };
    const toPrimaryY = toYBaseDomains.get(primaryAxisId) ?? { min: 0, max: 1 };
    const domainChanged =
      !isDomainEqual(fromSnapshot.xBaseDomain, toXBase) ||
      !isDomainEqual(fromPrimaryY, toPrimaryY);

    const shouldAnimateUpdate =
      hasRenderedOnce && (domainChanged || likelyDataChanged);
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
        yBaseDomains: fromSnapshot.yBaseDomains,
        series: fromSnapshot.series,
      },
      to: {
        xBaseDomain: toXBase,
        xVisibleDomain: { min: toXVisible.min, max: toXVisible.max },
        yBaseDomains: toYBaseDomains,
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
      },
    );
    updateAnimId = id;

    // Request initial render to kick off the animation.
    // Without this, the animation won't start until something else triggers a render
    // (e.g., pointer movement, which may not happen if the user is interacting with
    // UI overlays like the legend).
    requestRender();
  };

  const getRuntimeSeriesData: RenderCoordinator["getRuntimeSeriesData"] = (
    seriesIndex,
  ) => {
    assertNotDisposed();
    if (!Number.isFinite(seriesIndex)) return null;
    if (seriesIndex < 0 || seriesIndex >= currentOptions.series.length)
      return null;
    // Flush pending appends so the snapshot matches GPU / hit-test intent.
    if (pendingAppendByIndex.size > 0) {
      cancelScheduledFlush();
      executeFlush({ requestRenderAfter: false });
    }
    return (runtimeRawDataByIndex[seriesIndex] as
      | CartesianSeriesData
      | ReadonlyArray<OHLCDataPoint>
      | null) ?? null;
  };

  const getRuntimeSeriesBounds: RenderCoordinator["getRuntimeSeriesBounds"] = (
    seriesIndex,
  ) => {
    assertNotDisposed();
    if (!Number.isFinite(seriesIndex)) return null;
    if (seriesIndex < 0 || seriesIndex >= currentOptions.series.length)
      return null;
    if (pendingAppendByIndex.size > 0) {
      cancelScheduledFlush();
      executeFlush({ requestRenderAfter: false });
    }
    return runtimeRawBoundsByIndex[seriesIndex] ?? null;
  };

  const appendData: RenderCoordinator["appendData"] = (
    seriesIndex,
    newPoints,
    options,
  ) => {
    assertNotDisposed();
    if (!Number.isFinite(seriesIndex)) return;
    if (seriesIndex < 0 || seriesIndex >= currentOptions.series.length) return;
    if (!newPoints) return;

    const s = currentOptions.series[seriesIndex]!;
    if (s.type === "pie") {
      // Pie series are non-cartesian and currently not supported by streaming append.
      if (!warnedPieAppendSeries.has(seriesIndex)) {
        warnedPieAppendSeries.add(seriesIndex);
        console.warn(
          `RenderCoordinator.appendData(${seriesIndex}, ...): pie series are not supported by streaming append.`,
        );
      }
      return;
    }

    // Check point count based on format (avoid assuming .length exists for all types)
    const pointCount =
      s.type === "candlestick"
        ? (newPoints as ReadonlyArray<OHLCDataPoint>).length
        : getPointCount(newPoints as CartesianSeriesData);
    if (pointCount === 0) return;

    // Store batches with per-call maxPoints so coalesced flushes match ChartGPU hit-test.
    const maxPoints = normalizeMaxPoints(options?.maxPoints);
    const entry: PendingAppendBatch = {
      points: newPoints,
      ...(maxPoints != null ? { maxPoints } : {}),
    };
    const existing = pendingAppendByIndex.get(seriesIndex);
    if (existing) {
      existing.push(entry);
    } else {
      pendingAppendByIndex.set(seriesIndex, [entry]);
    }

    // Coalesce appends + any required resampling + GPU streaming updates into a single flush.
    scheduleFlush();
  };

  const render: RenderCoordinator["render"] = () => {
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

    const hasCartesianSeries = currentOptions.series.some(
      (s) => s.type !== "pie",
    );
    const seriesForIntro = renderSeries;

    // Story 5.16: start/update intro animation once we have drawable series marks.
    if (introPhase !== "done") {
      const introCfg = resolveIntroAnimationConfig(currentOptions.animation);

      const hasDrawableSeriesMarks = (() => {
        for (let i = 0; i < seriesForIntro.length; i++) {
          const s = seriesForIntro[i]!;
          switch (s.type) {
            case "pie": {
              // Pie renderer only emits slices with value > 0.
              if (
                s.data.some(
                  (it) =>
                    typeof it?.value === "number" &&
                    Number.isFinite(it.value) &&
                    it.value > 0,
                )
              ) {
                return true;
              }
              break;
            }
            case "line":
            case "area":
            case "bar":
            case "scatter": {
              // Cartesian series: use getPointCount for all CartesianSeriesData formats
              const dataLength = getPointCount(s.data as CartesianSeriesData);
              if (dataLength > 0) return true;
              break;
            }
            case "candlestick": {
              const dataLength = (s.data as ReadonlyArray<OHLCDataPoint>)
                .length;
              if (dataLength > 0) return true;
              break;
            }
            default:
              assertUnreachable(s);
          }
        }
        return false;
      })();

      if (introPhase === "pending" && introCfg && hasDrawableSeriesMarks) {
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
        introPhase = "running";
        introAnimId = introAnimController.animate(
          0,
          1,
          totalMs,
          easingWithDelay,
          (value) => {
            if (disposed || introPhase !== "running") return;
            introProgress01 = clamp01(value);
            // Render-on-demand: request frames only while the intro is active.
            if (introProgress01 < 1) requestRender();
          },
          () => {
            if (disposed) return;
            introPhase = "done";
            introProgress01 = 1;
            introAnimId = null;
          },
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
      ? lerpDomain(
          updateTransition.from.xBaseDomain,
          updateTransition.to.xBaseDomain,
          updateP,
        )
      : computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
    const visibleXDomain = computeVisibleXDomain(baseXDomain, zoomRange);

    const plotClipRect = computePlotClipRect(gridArea);
    const plotScissor = computePlotScissorDevicePx(gridArea);

    const xScale = createLinearScale()
      .domain(visibleXDomain.min, visibleXDomain.max)
      .range(plotClipRect.left, plotClipRect.right);

    // Compute per-axis y domains (with transition interpolation if active)
    const currentYScales = new Map<string, LinearScale>();
    const currentYDomains = new Map<string, { readonly min: number; readonly max: number }>();
    for (const ax of currentOptions.yAxes) {
      const axisId = ax.id!;
      let dom: { min: number; max: number };
      if (updateTransition && updateP < 1) {
        const fromY = updateTransition.from.yBaseDomains.get(axisId) ?? { min: 0, max: 1 };
        const toY = updateTransition.to.yBaseDomains.get(axisId) ?? { min: 0, max: 1 };
        dom = lerpDomain(fromY, toY, updateP);
      } else {
        dom = computeBaseYDomainForAxis(
          currentOptions,
          axisId,
          runtimeRawBoundsByIndex,
          cachedVisibleYBoundsByAxis.get(axisId) ?? null,
        );
      }
      currentYDomains.set(axisId, dom);
      currentYScales.set(
        axisId,
        createLinearScale()
          .domain(dom.min, dom.max)
          .range(plotClipRect.bottom, plotClipRect.top),
      );
    }
    // Primary y scale (for bars, highlight, single-axis usage)
    const yScale = currentYScales.values().next().value!;

    // PERFORMANCE: Cache canvas CSS dimensions (used for both GPU overlays and label processing)
    // Annotations (GPU overlays) are specified in data-space and converted to CANVAS-LOCAL CSS pixels.
    const canvas = gpuContext.canvas;
    // IMPORTANT: For GPU overlay annotations only, derive CSS size from device pixels to avoid
    // DOM `clientWidth/clientHeight` mismatch with the WebGPU render target size.
    const canvasCssForAnnotations = getCanvasCssSizeFromDevicePixels(canvas);
    const canvasCssWidthForAnnotations = canvasCssForAnnotations.width;
    const canvasCssHeightForAnnotations = canvasCssForAnnotations.height;

    const plotLeftCss =
      canvasCssWidthForAnnotations > 0
        ? clipXToCanvasCssPx(plotClipRect.left, canvasCssWidthForAnnotations)
        : 0;
    const plotRightCss =
      canvasCssWidthForAnnotations > 0
        ? clipXToCanvasCssPx(plotClipRect.right, canvasCssWidthForAnnotations)
        : 0;
    const plotTopCss =
      canvasCssHeightForAnnotations > 0
        ? clipYToCanvasCssPx(plotClipRect.top, canvasCssHeightForAnnotations)
        : 0;
    const plotBottomCss =
      canvasCssHeightForAnnotations > 0
        ? clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeightForAnnotations)
        : 0;
    const plotWidthCss = Math.max(0, plotRightCss - plotLeftCss);
    const plotHeightCss = Math.max(0, plotBottomCss - plotTopCss);

    // Process annotations (convert to GPU instances for rendering)
    const annotations: ReadonlyArray<AnnotationConfig> = hasCartesianSeries
      ? (currentOptions.annotations ?? [])
      : [];
    const annotationResult = processAnnotations({
      annotations,
      xScale,
      yScales: currentYScales,
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
      annotationResult.linesBelow.length + annotationResult.linesAbove.length >
      0
        ? [...annotationResult.linesBelow, ...annotationResult.linesAbove]
        : [];
    const combinedMarkers: ReadonlyArray<AnnotationMarkerInstance> =
      annotationResult.markersBelow.length +
        annotationResult.markersAbove.length >
      0
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
    if (currentOptions.xAxis.type === "time") {
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
        fontFamily: currentOptions.theme.fontFamily || "sans-serif",
        tickFormatter: currentOptions.xAxis.tickFormatter,
      });
      xTickCount = computed.tickCount;
      xTickValues = computed.tickValues;
    } else {
      // Keep existing behavior for non-time x axes.
      const domainMin =
        finiteOrUndefined(currentOptions.xAxis.min) ??
        xScale.invert(plotClipRect.left);
      const domainMax =
        finiteOrUndefined(currentOptions.xAxis.max) ??
        xScale.invert(plotClipRect.right);
      xTickValues = generateLinearTicks(domainMin, domainMax, xTickCount);
    }

    const interactionScales = computeInteractionScalesGridCssPx(gridArea, {
      xDomain: { min: visibleXDomain.min, max: visibleXDomain.max },
      yDomains: currentYDomains,
    });
    lastInteractionScales = interactionScales;

    // Story 5.17: during update transitions, render animated series snapshots.
    const seriesForRender =
      updateTransition && updateP < 1
        ? interpolateSeriesForUpdate(
            updateTransition.from.series,
            updateTransition.to.series,
            updateP,
            updateInterpolationCaches,
          )
        : renderSeries;

    // The interpolation cache reuses the same array reference across frames (mutating
    // values in-place). setSeriesIfChanged short-circuits on reference identity, so clear
    // the cache every animation frame so GPU uploads are not silently skipped (P1-2).
    // Same for filterGaps (P2-12): in-place mutation under a stable ref must re-filter.
    // Same for area/bar geometry: domain-space verts/instances are cached by data identity.
    if (updateTransition && updateP < 1) {
      lastSetSeriesCache.clear();
      filterGapsCache.clear();
      const pool = rendererPool.getState();
      const areas = pool.areaRenderers;
      for (let ai = 0; ai < areas.length; ai++) {
        areas[ai]!.invalidateGeometry();
      }
      pool.barRenderer.invalidateGeometry();
    }

    // Keep `interactionX` in sync with real pointer movement (domain units).
    if (
      pointerState.source === "mouse" &&
      pointerState.hasPointer &&
      pointerState.isInGrid &&
      interactionScales
    ) {
      const xDomain = interactionScales.xScale.invert(pointerState.gridX);
      setInteractionXInternal(
        Number.isFinite(xDomain) ? xDomain : null,
        "mouse",
      );
    }

    // Compute the effective interaction state:
    // - mouse: use the latest pointer event payload
    // - sync: derive a synthetic pointer position from `interactionX` (x only; y is arbitrary)
    let effectivePointer: PointerState = pointerState;
    if (pointerState.source === "sync") {
      if (interactionX === null || !interactionScales) {
        effectivePointer = {
          ...pointerState,
          hasPointer: false,
          isInGrid: false,
        };
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
          source: "sync",
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

    // P0-5: single findNearestPoint for highlight + item-mode tooltip.
    // Computed once when the real pointer is over the plot; shared via prepareOverlays.
    let sharedNearestMatch: ReturnType<typeof findNearestPoint> | undefined;
    if (
      effectivePointer.source === "mouse" &&
      effectivePointer.hasPointer &&
      effectivePointer.isInGrid &&
      interactionScales
    ) {
      sharedNearestMatch = findNearestPoint(
        seriesForRender,
        effectivePointer.gridX,
        effectivePointer.gridY,
        interactionScales.xScale,
        interactionScales.yScales.values().next().value!,
      );
    } else {
      sharedNearestMatch = null;
    }

    // Prepare overlay renderers (grid, axes, crosshair, highlight)
    prepareOverlays(
      {
        gridRenderer,
        xAxisRenderer,
        yAxisRenderers,
        crosshairRenderer,
        highlightRenderer,
      },
      {
        currentOptions,
        xScale,
        yScales: currentYScales,
        gridArea,
        xTickCount,
        hasCartesianSeries,
        effectivePointer,
        interactionScales,
        seriesForRender,
        withAlpha,
        nearestMatch: sharedNearestMatch,
        overlayPrepareMemo,
      },
    );

    // Tooltip: on hover, find matches and render tooltip near cursor.
    // Note: Tooltips require HTMLCanvasElement (DOM-specific positioning).
    const tooltipPointerActive =
      effectivePointer.hasPointer &&
      effectivePointer.isInGrid &&
      currentOptions.tooltip?.show !== false;

    // Throttle gate (P0-4): suppress hit-testing within TOOLTIP_HIT_TEST_THROTTLE_MS of
    // the previous computation. When suppressed, leave the existing tooltip alone and
    // schedule a follow-up render. Hides (pointer leaving the grid) are not throttled.
    let tooltipHitTestAllowed = true;
    if (tooltipPointerActive) {
      const now = performance.now();
      const elapsed = now - lastTooltipHitTestMs;
      if (elapsed < TOOLTIP_HIT_TEST_THROTTLE_MS) {
        tooltipHitTestAllowed = false;
        schedulePendingTooltipFollowup(TOOLTIP_HIT_TEST_THROTTLE_MS - elapsed);
      } else {
        lastTooltipHitTestMs = now;
        cancelPendingTooltipFollowup();
      }
    } else {
      cancelPendingTooltipFollowup();
    }

    if (tooltipPointerActive) {
     if (tooltipHitTestAllowed) {
      const canvas = gpuContext.canvas;

      if (interactionScales && canvas && isHTMLCanvasElement(canvas)) {
        const formatter = currentOptions.tooltip?.formatter;
        const trigger = currentOptions.tooltip?.trigger ?? "item";

        const containerX = canvas.offsetLeft + effectivePointer.x;
        const containerY = canvas.offsetTop + effectivePointer.y;

        if (effectivePointer.source === "sync") {
          // Sync semantics:
          // - Tooltip should be driven by x only (no y).
          // - In 'axis' mode, show one entry per series nearest in x.
          // - In 'item' mode, pick a deterministic single entry (first matching series).
          // findPointsAtX handles visibility filtering internally and returns correct series indices
          const matches = findPointsAtX(
            seriesForRender,
            effectivePointer.gridX,
            interactionScales.xScale,
          );
          if (matches.length === 0) {
            hideTooltip();
          } else if (trigger === "axis") {
            const paramsArray = matches.map((m) =>
              buildTooltipParams(m.seriesIndex, m.dataIndex, m.point),
            );
            const content = formatter
              ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)(
                  paramsArray,
                )
              : formatTooltipAxis(paramsArray);
            if (
              content &&
              (content !== lastTooltipContent ||
                containerX !== lastTooltipX ||
                containerY !== lastTooltipY)
            ) {
              lastTooltipContent = content;
              lastTooltipX = containerX;
              lastTooltipY = containerY;
              showTooltipInternal(containerX, containerY, content, paramsArray);
            } else if (!content) {
              hideTooltip();
            }
          } else {
            const m0 = matches[0];
            const params = buildTooltipParams(
              m0.seriesIndex,
              m0.dataIndex,
              m0.point,
            );
            const content = formatter
              ? (formatter as (p: TooltipParams) => string)(params)
              : formatTooltipItem(params);
            if (
              content &&
              (content !== lastTooltipContent ||
                containerX !== lastTooltipX ||
                containerY !== lastTooltipY)
            ) {
              lastTooltipContent = content;
              lastTooltipX = containerX;
              lastTooltipY = containerY;
              showTooltipInternal(containerX, containerY, content, params);
            } else if (!content) {
              hideTooltip();
            }
          }
        } else if (trigger === "axis") {
          // Story 4.14: pie slice tooltip hit-testing (mouse only).
          // If the cursor is over a pie slice, prefer showing that slice tooltip.
          // findPieSliceAtPointer handles visibility filtering internally and returns correct series indices
          const pieMatch = findPieSliceAtPointer(
            seriesForRender,
            effectivePointer.gridX,
            effectivePointer.gridY,
            interactionScales.plotWidthCss,
            interactionScales.plotHeightCss,
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
              ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)([
                  params,
                ])
              : formatTooltipItem(params);
            if (
              content &&
              (content !== lastTooltipContent ||
                containerX !== lastTooltipX ||
                containerY !== lastTooltipY)
            ) {
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
              interactionScales,
            );

            const matches = findPointsAtX(
              seriesForRender,
              effectivePointer.gridX,
              interactionScales.xScale,
            );
            if (matches.length === 0) {
              if (candlestickResult) {
                const paramsArray = [candlestickResult.params];
                const content = formatter
                  ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)(
                      paramsArray,
                    )
                  : formatTooltipAxis(paramsArray);
                if (content) {
                  // Use candlestick anchor for tooltip positioning
                  const anchor = computeCandlestickTooltipAnchor(
                    candlestickResult.match,
                    interactionScales.xScale,
                    interactionScales.yScales,
                    gridArea,
                    canvas,
                  );
                  const tooltipX = anchor?.x ?? containerX;
                  const tooltipY = anchor?.y ?? containerY;
                  if (
                    content !== lastTooltipContent ||
                    tooltipX !== lastTooltipX ||
                    tooltipY !== lastTooltipY
                  ) {
                    lastTooltipContent = content;
                    lastTooltipX = tooltipX;
                    lastTooltipY = tooltipY;
                    showTooltipInternal(
                      tooltipX,
                      tooltipY,
                      content,
                      paramsArray,
                    );
                  }
                } else {
                  hideTooltip();
                }
              } else {
                hideTooltip();
              }
            } else {
              const paramsArray = matches.map((m) =>
                buildTooltipParams(m.seriesIndex, m.dataIndex, m.point),
              );
              if (candlestickResult) paramsArray.push(candlestickResult.params);
              const content = formatter
                ? (formatter as (p: ReadonlyArray<TooltipParams>) => string)(
                    paramsArray,
                  )
                : formatTooltipAxis(paramsArray);
              if (content) {
                // Use candlestick anchor if candlestick is present in tooltip
                let tooltipX = containerX;
                let tooltipY = containerY;
                if (candlestickResult) {
                  const anchor = computeCandlestickTooltipAnchor(
                    candlestickResult.match,
                    interactionScales.xScale,
                    interactionScales.yScales,
                    gridArea,
                    canvas,
                  );
                  if (anchor) {
                    tooltipX = anchor.x;
                    tooltipY = anchor.y;
                  }
                }
                if (
                  content !== lastTooltipContent ||
                  tooltipX !== lastTooltipX ||
                  tooltipY !== lastTooltipY
                ) {
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
            interactionScales.plotHeightCss,
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
            if (
              content &&
              (content !== lastTooltipContent ||
                containerX !== lastTooltipX ||
                containerY !== lastTooltipY)
            ) {
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
              interactionScales,
            );
            if (candlestickResult) {
              const content = formatter
                ? (formatter as (p: TooltipParams) => string)(
                    candlestickResult.params,
                  )
                : formatTooltipItem(candlestickResult.params);
              if (content) {
                // Use candlestick anchor for tooltip positioning
                const anchor = computeCandlestickTooltipAnchor(
                  candlestickResult.match,
                  interactionScales.xScale,
                  interactionScales.yScales,
                  gridArea,
                  canvas,
                );
                const tooltipX = anchor?.x ?? containerX;
                const tooltipY = anchor?.y ?? containerY;
                if (
                  content !== lastTooltipContent ||
                  tooltipX !== lastTooltipX ||
                  tooltipY !== lastTooltipY
                ) {
                  lastTooltipContent = content;
                  lastTooltipX = tooltipX;
                  lastTooltipY = tooltipY;
                  showTooltipInternal(
                    tooltipX,
                    tooltipY,
                    content,
                    candlestickResult.params,
                  );
                }
              } else {
                hideTooltip();
              }
              return;
            }

            // Reuse the shared nearest-point match from above (P0-5).
            const match = sharedNearestMatch ?? null;
            if (!match) {
              hideTooltip();
            } else {
              const params = buildTooltipParams(
                match.seriesIndex,
                match.dataIndex,
                match.point,
              );
              const content = formatter
                ? (formatter as (p: TooltipParams) => string)(params)
                : formatTooltipItem(params);
              if (
                content &&
                (content !== lastTooltipContent ||
                  containerX !== lastTooltipX ||
                  containerY !== lastTooltipY)
              ) {
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
     }
     // else: throttled — leave existing tooltip; follow-up render is scheduled above.
    } else {
      hideTooltip();
    }

    // Compute maxRadiusCss for pie intro animation
    const plotSize =
      interactionScales ??
      (canvas && isHTMLCanvasElement(canvas)
        ? getPlotSizeCssPx(canvas, gridArea)
        : null);
    const maxRadiusCss =
      plotSize &&
      typeof plotSize.plotWidthCss === "number" &&
      typeof plotSize.plotHeightCss === "number"
        ? 0.5 * Math.min(plotSize.plotWidthCss, plotSize.plotHeightCss)
        : 0;

    // Cache renderer pool state once per frame to avoid repeated object allocations.
    const poolState = rendererPool.getState();

    // Prepare all series renderers (area, line, bar, scatter, pie, candlestick)
    const seriesPreparation = prepareSeries(poolState, {
      currentOptions,
      seriesForRender,
      xScale,
      yScales: currentYScales,
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
      lastSetSeriesCache,
      filterGapsCache,
    });
    // One-frame skip only: StagingRingView safety is isStagingRingView in
    // setSeriesIfChanged, not this set. Clear so partial multi-series flushes
    // cannot leave idle series looking "protected" across frames.
    appendedGpuThisFrame.clear();

    const { visibleBarSeriesConfigs } = seriesPreparation;

    // Prepare bar renderer with animated scale if intro is running
    const introP = introPhase === "running" ? clamp01(introProgress01) : 1;
    const yScaleForBars =
      introP < 1
        ? createAnimatedBarYScale(
            yScale,
            plotClipRect,
            visibleBarSeriesConfigs,
            introP,
          )
        : yScale;
    poolState.barRenderer.prepare(
      visibleBarSeriesConfigs,
      dataStore,
      xScale,
      yScaleForBars,
      gridArea,
    );

    // Prepare annotation GPU overlays once (WG-P2-1: single sampleCount-4 instance
    // used for both main below-series and overlay above-series draws).
    // Note: these renderers expect CANVAS-LOCAL CSS pixel coordinates; the coordinator owns
    // data-space → canvas-space conversion and plot scissor state.
    if (hasCartesianSeries) {
      referenceLineRenderer.prepare(gridArea, combinedReferenceLines);
      annotationMarkerRenderer.prepare({
        canvasWidth: gridArea.canvasWidth,
        canvasHeight: gridArea.canvasHeight,
        devicePixelRatio: gridArea.devicePixelRatio,
        instances: combinedMarkers,
      });
    } else {
      // Ensure prior frame instances don't persist visually if series mode changes.
      referenceLineRenderer.prepare(gridArea, []);
      annotationMarkerRenderer.prepare({
        canvasWidth: gridArea.canvasWidth,
        canvasHeight: gridArea.canvasHeight,
        devicePixelRatio: gridArea.devicePixelRatio,
        instances: [],
      });
    }

    textureManager.ensureTextures(gridArea.canvasWidth, gridArea.canvasHeight);
    const texState = textureManager.getState();

    // Swapchain view for the resolved MSAA overlay pass and for the final (load) overlay pass.
    const swapchainView = gpuContext.canvasContext
      .getCurrentTexture()
      .createView();
    const encoder = device.createCommandEncoder({
      label: "renderCoordinator/commandEncoder",
    });
    const clearValue = parseCssColorToGPUColor(
      currentOptions.theme.backgroundColor,
      { r: 0, g: 0, b: 0, a: 1 },
    );

    // Encode compute passes (scatter density + line decimation) before the render pass.
    encodeScatterDensityCompute(poolState, seriesForRender, encoder);
    encodeDecimationCompute(poolState, seriesForRender, encoder);

    const mainPass = encoder.beginRenderPass({
      label: "renderCoordinator/mainPass",
      colorAttachments: [
        {
          view: texState.mainColorView!, // MSAA texture (4x)
          resolveTarget: texState.mainResolveView!, // single-sample resolve target
          clearValue,
          loadOp: "clear",
          storeOp: "discard", // MSAA content discarded after resolve
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
      {
        referenceLineRenderer,
        referenceLineRendererMsaa,
        annotationMarkerRenderer,
        annotationMarkerRendererMsaa,
      },
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
      seriesPreparation,
    );

    mainPass.end();

    // MSAA annotation overlay pass: blit main color ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ MSAA target, then draw above-series annotations.
    const overlayPass = encoder.beginRenderPass({
      label: "renderCoordinator/annotationOverlayMsaaPass",
      colorAttachments: [
        {
          view: texState.overlayMsaaView!,
          resolveTarget: swapchainView,
          clearValue,
          loadOp: "clear",
          storeOp: "discard",
        },
      ],
    });

    overlayPass.setPipeline(texState.overlayBlitPipeline);
    overlayPass.setBindGroup(0, texState.overlayBlitBindGroup!);
    overlayPass.draw(3);

    // Render above-series annotations to the overlay pass
    renderAboveSeriesAnnotations(
      {
        referenceLineRenderer,
        referenceLineRendererMsaa,
        annotationMarkerRenderer,
        annotationMarkerRendererMsaa,
      },
      {
        hasCartesianSeries,
        gridArea,
        overlayPass,
        plotScissor,
        referenceLineBelowCount,
        referenceLineAboveCount,
        markerBelowCount,
        markerAboveCount,
      },
    );

    // Axes / highlight / crosshair in the same 4× overlay pass (WG-P1-5).
    // Drawn after above-series annotations so UI stays on top within the pass.
    highlightRenderer.render(overlayPass);
    if (hasCartesianSeries) {
      xAxisRenderer.render(overlayPass);
      for (const r of yAxisRenderers.values()) {
        r.render(overlayPass);
      }
    }
    crosshairRenderer.render(overlayPass);

    overlayPass.end();
    device.queue.submit([encoder.finish()]);

    hasRenderedOnce = true;

    // Generate axis labels for DOM overlay
    renderAxisLabels(axisLabelOverlay, overlayContainer, {
      gpuContext,
      currentOptions,
      xScale,
      xTickValues,
      plotClipRect,
      visibleXRangeMs,
    });

    // Generate Y-axis labels for each axis
    const canvas2 = gpuContext.canvas as HTMLCanvasElement | null;
    if (canvas2) {
      const canvasCssW = getCanvasCssWidth(canvas2);
      const canvasCssH = getCanvasCssHeight(canvas2);
      const offX = canvas2.offsetLeft || 0;
      const offY = canvas2.offsetTop || 0;
      for (const yAxisConfig of currentOptions.yAxes) {
        const axisId = yAxisConfig.id!;
        const yScaleForAxis = currentYScales.get(axisId);
        if (!yScaleForAxis) continue;
        renderYAxisLabels({
          axisLabelOverlay,
          overlayContainer,
          yAxisConfig,
          yScale: yScaleForAxis,
          plotClipRect,
          canvasCssWidth: canvasCssW,
          canvasCssHeight: canvasCssH,
          offsetX: offX,
          offsetY: offY,
          theme: currentOptions.theme,
        });
      }
    }

    // Generate annotation labels (DOM overlay)
    renderAnnotationLabels(annotationOverlay, overlayContainer, {
      currentOptions,
      xScale,
      yScales: currentYScales,
      canvasCssWidthForAnnotations,
      canvasCssHeightForAnnotations,
      plotLeftCss,
      plotTopCss,
      plotWidthCss,
      plotHeightCss,
      canvas,
    });
  };

  const dispose: RenderCoordinator["dispose"] = () => {
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
    introPhase = "done";
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
    cancelPendingTooltipFollowup();
    zoomResampleDue = false;

    pendingAppendByIndex.clear();
    lastSetSeriesCache.clear();
    filterGapsCache.clear();
    clearOverlayPrepareMemo(overlayPrepareMemo);

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
    for (const r of yAxisRenderers.values()) r.dispose();
yAxisRenderers.clear();
    // Single instances (Msaa aliases point at the same objects — dispose once).
    referenceLineRenderer.dispose();
    annotationMarkerRenderer.dispose();

    textureManager.dispose();

    dataStore.dispose();

    // Dispose tooltip/legend before the text overlay (all touch container positioning).
    tooltip?.dispose();
    tooltip = null;
    legend?.dispose();
    axisLabelOverlay?.dispose();
    annotationOverlay?.dispose();
  };

  const getInteractionX: RenderCoordinator["getInteractionX"] = () =>
    interactionX;

  const setInteractionX: RenderCoordinator["setInteractionX"] = (x, source) => {
    assertNotDisposed();
    const normalized = x !== null && Number.isFinite(x) ? x : null;

    // External interaction should not depend on y, so we treat it as ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œsyncÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â mode.
    pointerState = {
      ...pointerState,
      source: normalized === null ? "mouse" : "sync",
    };

    setInteractionXInternal(normalized, source);

    if (normalized === null && pointerState.hasPointer === false) {
      crosshairRenderer.setVisible(false);
      highlightRenderer.setVisible(false);
      hideTooltipInternal();
    }
    requestRender();
  };

  const onInteractionXChange: RenderCoordinator["onInteractionXChange"] = (
    callback,
  ) => {
    assertNotDisposed();
    interactionXListeners.add(callback);
    return () => {
      interactionXListeners.delete(callback);
    };
  };

  const getZoomRange: RenderCoordinator["getZoomRange"] = () => {
    return zoomState?.getRange() ?? null;
  };

  const setZoomRange: RenderCoordinator["setZoomRange"] = (start, end) => {
    assertNotDisposed();
    if (!zoomState) return;
    zoomState.setRange(start, end);
    // onChange will requestRender + emit.
  };

  const onZoomRangeChange: RenderCoordinator["onZoomRangeChange"] = (cb) => {
    assertNotDisposed();
    zoomRangeListeners.add(cb);
    return () => {
      zoomRangeListeners.delete(cb);
    };
  };

  return {
    setOptions,
    appendData,
    getRuntimeSeriesData,
    getRuntimeSeriesBounds,
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
