import type {
  ResolvedCandlestickSeriesConfig,
  ResolvedChartGPUOptions,
  ResolvedPieSeriesConfig,
  ResolvedSeriesConfig,
} from '../../config/OptionResolver';
import type { AnnotationConfig, DataPoint, OHLCDataPoint } from '../../config/types';
import { GPUContext, isHTMLCanvasElement as isHTMLCanvasElementGPU } from '../GPUContext';
import { createDataStore } from '../../data/createDataStore';
import { isGpuDecimationEligible } from '../../data/gpuDecimationEligibility';
import { canRangedAppendLine, type DataStoreBufferKind } from './data/canRangedAppendLine';
import { buildRuntimeBaseSeries, buildSetOptionsReuseSeries, resolveZoomedSeriesEntry } from './data/seriesPipeline';
import { createAppendFlush, type AppendFlushDeps } from './data/appendFlush';
import { sliceVisibleRangeByX, sliceVisibleRangeByOHLC, isTupleOHLCDataPoint } from './data/computeVisibleSlice';
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
} from '../../data/cartesianData';
import { demoteStagingViewAfterRebindFailure } from './data/stagingThinPath';
import { normalizeMaxPoints, planMaxPointsWindow } from '../../data/maxPointsWindow';
import type { CartesianSeriesData } from '../../config/types';
import { renderAxisLabels, renderYAxisLabels } from './render/renderAxisLabels';
import { renderAnnotationLabels } from './render/renderAnnotationLabels';
import { prepareOverlays } from './render/renderOverlays';
import { createOverlayPrepareMemo, clearOverlayPrepareMemo } from './render/overlayPrepareMemo';
import { createFilterGapsCache } from './render/filterGapsCache';
import {
  didSeriesDataLikelyChange,
  shouldRecomputeBaselineSampling,
  patchSeriesPresentationKeepingSampledData,
  didRawBoundsModeChange,
} from './data/samplingDirty';
import { processAnnotations } from './annotations/processAnnotations';
import {
  prepareSeries,
  renderAboveSeriesAnnotations,
  hasDenseHairlineLines,
  renderDenseHairlineLines,
  planGpuFrame,
  encodeFrameComputePasses,
  encodeMainSeriesPass,
  framePlanIncludesDenseHairline,
  framePlanIncludesAnnotationOverlay,
  type LastSetSeriesCache,
} from './render/frameRender';
import { createAxisRenderer } from '../../renderers/createAxisRenderer';
import { createGridRenderer } from '../../renderers/createGridRenderer';
import type { GridArea } from '../../renderers/createGridRenderer';
import { createRendererPool, ensureRendererPoolsForSeries } from './renderers/rendererPool';
import { createTextureManager } from './gpu/textureManager';
import { enqueueDeviceSubmit, flushDeviceSubmit } from '../gpu/submitBatcher';
import {
  applyStickyAutoDomain,
  DEFAULT_STICKY_DOMAIN_HEADROOM,
  DEFAULT_STICKY_X_DOMAIN_HEADROOM,
  resolveStickyOrDataDomain,
  shouldApplyStickyAutoDomain,
  shouldSkipStickyAutoXDomain,
} from './zoom/stickyAutoDomain';
import { isFullSpanZoomRange as isFullSpanZoomRangeHelper, scanCartesianVisibleYBounds } from './zoom/visibleYBounds';
import { createCrosshairRenderer } from '../../renderers/createCrosshairRenderer';
import { createHighlightRenderer } from '../../renderers/createHighlightRenderer';
import { createReferenceLineRenderer } from '../../renderers/createReferenceLineRenderer';
import { createAnnotationMarkerRenderer } from '../../renderers/createAnnotationMarkerRenderer';
import { createEventManager } from '../../interaction/createEventManager';
import type { PipelineCache } from '../PipelineCache';
import type { ChartGPUEventPayload } from '../../interaction/createEventManager';
import { createInsideZoom } from '../../interaction/createInsideZoom';
import { createZoomState } from '../../interaction/createZoomState';
import type { ZoomRange, ZoomState } from '../../interaction/createZoomState';
import { findNearestPoint } from '../../interaction/findNearestPoint';
import { findPointsAtX } from '../../interaction/findPointsAtX';
import { computeCandlestickBodyWidthRange, findCandlestick } from '../../interaction/findCandlestick';
import { findPieSlice } from '../../interaction/findPieSlice';
import { createLinearScale } from '../../utils/scales';
import type { LinearScale } from '../../utils/scales';
import { parseCssColorToGPUColor } from '../../utils/colors';
import { createTextOverlay } from '../../components/createTextOverlay';
import type { TextOverlay } from '../../components/createTextOverlay';
import { createLegend } from '../../components/createLegend';
import type { Legend } from '../../components/createLegend';
import { createTooltip } from '../../components/createTooltip';
import type { Tooltip } from '../../components/createTooltip';
import type { TooltipParams } from '../../config/types';
import { formatTooltipAxis, formatTooltipItem } from '../../components/formatTooltip';
import { createAnimationController } from '../createAnimationController';
import type { AnimationId } from '../createAnimationController';
import { getEasing } from '../../utils/easing';
import type { EasingFunction } from '../../utils/easing';
import type { ZoomChangeSourceKind } from '../../ChartGPU';

// Canonical pure helpers (one-way cutover — do not re-define below)
import { getCanvasCssWidth, getCanvasCssHeight, getCanvasCssSizeFromDevicePixels } from './utils/canvasUtils';
import { finiteOrNull, finiteOrUndefined, getPointXY } from './utils/dataPointUtils';
/* dataPointUtils cutover */
import {
  computeGridArea,
  withAlpha,
  computePlotClipRect,
  clamp01,
  computePlotScissorDevicePx,
  clipXToCanvasCssPx,
  clipYToCanvasCssPx,
} from './utils/axisUtils';
import { extendBoundsWithOHLCDataPoints, normalizeDomain } from './utils/boundsComputation';
import {
  DEFAULT_TICK_COUNT as TIME_DEFAULT_TICK_COUNT,
  resolvePieCenterPlotCss,
  resolvePieRadiiCss,
  generateLinearTicks,
  computeAdaptiveTimeXAxisTicks,
} from './utils/timeAxisUtils';
import {
  resolveAnimationConfig as resolveAnimationConfigHelper,
  isDomainEqual,
  hasAnyDrawableMarks,
  createEasingWithDelay,
  interpolateCartesianData,
  interpolatePieData,
  computeNextIntroPhase,
  applyBarIntroProgress,
  lerpDomain,
  type AnySeriesConfig,
} from './animation/animationHelpers';
import { computeCandlestickTooltipAnchorFromMatch } from './ui/tooltipLegendHelpers';
const computeCandlestickTooltipAnchor = computeCandlestickTooltipAnchorFromMatch;
import { MAIN_SCENE_MSAA_SAMPLE_COUNT, ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT } from './gpu/textureManager';
import {
  createPointerState,
  updatePointerFromMouse,
  clearPointer,
  normalizeInteractionX,
  createInteractionXListeners,
  shouldUpdateInteractionX,
  computeEffectivePointer,
  gridToDomainX,
  type PointerState,
} from './interaction/interactionHelpers';
import {
  createTooltipCache,
  shouldUpdateTooltip,
  updateTooltipCache,
  clearTooltipCache,
  isOHLCDataPoint,
} from './ui/tooltipLegendHelpers';

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
    options?: Readonly<{ maxPoints?: number }>
  ): void;
  /**
   * Snapshot of coordinator-owned runtime series data for dual-store hit-test
   * resync (e.g. after tooltip re-enable following maxPoints dual-store skip).
   * Returns `null` when the series has no runtime columns yet.
   */
  getRuntimeSeriesData(seriesIndex: number): CartesianSeriesData | ReadonlyArray<OHLCDataPoint> | null;
  /** Runtime bounds for {@link getRuntimeSeriesData}, or `null`. */
  getRuntimeSeriesBounds(seriesIndex: number): Bounds | null;
  /**
   * Gets the current interaction x in domain units (or `null` when inactive).
   *
   * This is derived from pointer movement inside the plot grid and can also be driven
   * externally via `setInteractionX(...)` (e.g. chart sync).
   */
  getInteractionX(): number | null;
  /**
   * Drives the chart's crosshair + tooltip from a domain-space x value.
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
  onZoomRangeChange(
    cb: (range: Readonly<{ start: number; end: number }>, sourceKind?: ZoomChangeSourceKind) => void
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

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

/** FNV-1a offset / prime for compact axis-label DOM signatures (issue 11). */
const LABEL_SIG_FNV_OFFSET = 0x811c9dc5;
const LABEL_SIG_FNV_PRIME = 0x01000193;
/** Scratch view for hashing float64 bit patterns without per-tick allocations. */
const labelSigF64 = new Float64Array(1);
const labelSigU32 = new Uint32Array(labelSigF64.buffer);

const mixLabelSigUint = (h: number, v: number): number => Math.imul(h ^ (v >>> 0), LABEL_SIG_FNV_PRIME) >>> 0;

const mixLabelSigFloat = (h: number, f: number): number => {
  labelSigF64[0] = f;
  let next = mixLabelSigUint(h, labelSigU32[0]!);
  next = mixLabelSigUint(next, labelSigU32[1]!);
  return next;
};

// Story 5.17: CPU-side update interpolation can be expensive for very large series.
// We still animate domains for large series, but skip per-point y interpolation past this cap.
const MAX_ANIMATED_POINTS_PER_SERIES = 20_000;

/**
 * Brand for coordinator-owned MutableXYColumns. User-supplied `{ x, y }` arrays
 * must never be treated as owned — append would mutate the caller's buffers.
 */
const OWNED_XY_COLUMNS = Symbol.for('chartgpu.ownedMutableXYColumns');

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
const cartesianDataToMutableColumns = (data: CartesianSeriesData): MutableXYColumns => {
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

const computeGlobalXBounds = (
  series: ResolvedChartGPUOptions['series'],
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null
): { xMin: number; xMax: number } => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    if (seriesConfig.type === 'pie') continue;

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

    if (seriesConfig.type === 'candlestick') {
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
  series: ResolvedChartGPUOptions['series'],
  axisId: string,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null
): { yMin: number; yMax: number } => {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    if (seriesConfig.type === 'pie') continue;
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

    if (seriesConfig.type === 'candlestick') {
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

const computeBaseXDomain = (
  options: ResolvedChartGPUOptions,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null
): { readonly min: number; readonly max: number } => {
  // Short-circuit when both ends are explicit — avoids O(series) bounds aggregation
  // on full rewrite frames with fixed axes.
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
 * When `xWindow` is provided (zoomed GPU-decimation path that still holds full
 * raw on the series), only points with x in [min, max] contribute — O(n) but
 * correct for the visible window instead of global raw extrema.
 *
 * Performance: O(n) where n = total points across all series data.
 * Called when renderSeries / zoom changes, not every paint with stable zoom.
 */
const computeVisibleYBoundsForAxis = (
  series: ResolvedChartGPUOptions['series'],
  axisId: string,
  xWindow?: { readonly min: number; readonly max: number } | null
): { yMin: number; yMax: number } => {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  const filterX = xWindow != null && Number.isFinite(xWindow.min) && Number.isFinite(xWindow.max);
  const xMinW = filterX ? xWindow!.min : 0;
  const xMaxW = filterX ? xWindow!.max : 0;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    if (seriesConfig.type === 'pie') continue;
    if (seriesConfig.yAxis !== axisId) continue;

    if (seriesConfig.type === 'candlestick') {
      const visibleOHLC = seriesConfig.data as ReadonlyArray<OHLCDataPoint>;
      for (let i = 0; i < visibleOHLC.length; i++) {
        const p = visibleOHLC[i]!;
        const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
        if (filterX && Number.isFinite(timestamp) && (timestamp < xMinW || timestamp > xMaxW)) {
          continue;
        }
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

    const scanned = scanCartesianVisibleYBounds(seriesConfig.data as CartesianSeriesData, xWindow);
    if (scanned) {
      if (scanned.yMin < yMin) yMin = scanned.yMin;
      if (scanned.yMax > yMax) yMax = scanned.yMax;
    }
  }

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMin === Number.POSITIVE_INFINITY) {
    return { yMin: 0, yMax: 1 };
  }

  if (yMin === yMax) yMax = yMin + 1;

  return { yMin, yMax };
};

const computeBaseYDomainForAxis = (
  options: ResolvedChartGPUOptions,
  axisId: string,
  runtimeRawBoundsByIndex?: ReadonlyArray<Bounds | null> | null,
  visibleBoundsOverride?: { yMin: number; yMax: number } | null
): { readonly min: number; readonly max: number } => {
  const yAxisConfig = options.yAxes.find((ax) => ax.id === axisId) || options.yAxes[0]!;
  const explicitMin = finiteOrUndefined(yAxisConfig.min);
  const explicitMax = finiteOrUndefined(yAxisConfig.max);

  if (explicitMin !== undefined && explicitMax !== undefined) {
    return normalizeDomain(explicitMin, explicitMax);
  }

  const autoBoundsMode = yAxisConfig.autoBounds ?? 'visible';
  let bounds: { yMin: number; yMax: number };

  if (autoBoundsMode === 'visible' && visibleBoundsOverride) {
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
  zoomRange?: ZoomRange | null
): {
  readonly min: number;
  readonly max: number;
  readonly spanFraction: number;
} => {
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

// Intro phase machine lives in animationHelpers.computeNextIntroPhase (string-literal states).
type IntroPhase = 'pending' | 'running' | 'done';

/**
 * Computes container-local CSS pixel anchor coordinates for a candlestick tooltip.
 *
 * The anchor is positioned near the candle body center for stable tooltip positioning
 * even when the cursor is at the edge of the candlestick.
 *
 * Coordinate transformations:
 * 1. Domain values (timestamp, open, close) from CandlestickMatch
 * 2. xScale/yScale transform to grid-local CSS pixels
 * 3. Add gridArea offset to get canvas-local CSS pixels
 * 4. Add canvas offset to get container-local CSS pixels
 *
 * Returns null if any coordinate computation fails (non-finite values).
 */

const createAnimatedBarYScale = (
  baseYScale: LinearScale,
  plotClipRect: Readonly<{ top: number; bottom: number }>,
  progress01: number
): LinearScale => {
  const p = clamp01(progress01);
  if (p >= 1) return baseYScale;

  const yDomainA = baseYScale.invert(plotClipRect.bottom);
  const yDomainB = baseYScale.invert(plotClipRect.top);
  const yMin = Math.min(yDomainA, yDomainB);
  const yMax = Math.max(yDomainA, yDomainB);

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
      // Domain-space intro growth from zero-line (or domain min) via animationHelpers.
      const animated = applyBarIntroProgress(value, yMin, yMax, p);
      return baseYScale.scale(animated);
    },
    invert(pixel: number) {
      return baseYScale.invert(pixel);
    },
  };

  return wrapper;
};

const resolveAnimationConfig = (
  animation: ResolvedChartGPUOptions['animation']
): {
  readonly durationMs: number;
  readonly delayMs: number;
  readonly easing: EasingFunction;
} | null => {
  return resolveAnimationConfigHelper(animation, getEasing as (name: string) => EasingFunction);
};
const resolveIntroAnimationConfig = (animation: ResolvedChartGPUOptions['animation']) =>
  resolveAnimationConfig(animation);
const resolveUpdateAnimationConfig = (animation: ResolvedChartGPUOptions['animation']) =>
  resolveAnimationConfig(animation);

const DEFAULT_TICK_COUNT = TIME_DEFAULT_TICK_COUNT;

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
  // Match chart canvas DPR (multi-chart harness often forces 1; avoid sharper labels than plot).
  const overlayDpr =
    Number.isFinite(gpuContext.devicePixelRatio) && (gpuContext.devicePixelRatio as number) > 0
      ? (gpuContext.devicePixelRatio as number)
      : 1;

  // DOM-dependent features (overlays, legends) require HTMLCanvasElement.
  const overlayContainer = isHTMLCanvasElement(gpuContext.canvas) ? gpuContext.canvas.parentElement : null;
  const axisLabelOverlay: TextOverlay | null = overlayContainer
    ? createTextOverlay(overlayContainer, { devicePixelRatio: overlayDpr })
    : null;
  // Dedicated overlay for annotations (do not reuse axis label overlay).
  const annotationOverlay: TextOverlay | null = overlayContainer
    ? createTextOverlay(overlayContainer, { clip: true, devicePixelRatio: overlayDpr })
    : null;

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
        i === sliceIndex ? { ...slice, visible: slice.visible === false ? true : false } : slice
      );

      const updatedSeries = series.map((seriesItem, i) =>
        i === seriesIndex ? ({ ...seriesItem, data: updatedData } as typeof seriesItem) : seriesItem
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
        : seriesItem
    );

    // Update options with new series array
    setOptions({ ...currentOptions, series: updatedSeries });
  };

  const legend: Legend | null =
    overlayContainer && options.legend?.show !== false
      ? createLegend(overlayContainer, options.legend?.position, handleSeriesToggle)
      : null;
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
    readonly yBaseDomains: Map<string, { readonly min: number; readonly max: number }>;
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
    // n is precomputed length; modular helper re-counts and validates equality.
    void n;
    return interpolateCartesianData(fromData, toData, t01, cache);
  };

  const interpolatePieSeriesByIndex = (
    fromSeries: ResolvedPieSeriesConfig,
    toSeries: ResolvedPieSeriesConfig,
    t01: number,
    cache: ResolvedPieSeriesConfig['data'] | null
  ): ResolvedPieSeriesConfig => interpolatePieData(fromSeries, toSeries, t01, cache);

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
        const animated = interpolatePieSeriesByIndex(
          a as ResolvedPieSeriesConfig,
          b as ResolvedPieSeriesConfig,
          t01,
          cache
        );
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
    const yBaseDomains = new Map<string, { readonly min: number; readonly max: number }>();
    for (const ax of transition.from.series[0] ? currentOptions.yAxes : []) {
      const axId = ax.id!;
      const fromY = transition.from.yBaseDomains.get(axId) || { min: 0, max: 1 };
      const toY = transition.to.yBaseDomains.get(axId) || { min: 0, max: 1 };
      yBaseDomains.set(axId, lerpDomain(fromY, toY, t01));
    }
    const series = interpolateSeriesForUpdate(transition.from.series, transition.to.series, t01, null);
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
  let runtimeRawDataByIndex: Array<RuntimeCartesianData | OHLCDataPoint[] | null> = new Array(
    options.series.length
  ).fill(null);
  let runtimeRawBoundsByIndex: Array<Bounds | null> = new Array(options.series.length).fill(null);

  // Baseline sampled series from runtime raw (the "full span" baseline).
  // Zoom-visible resampling is derived from this baseline + runtime raw as needed.
  let runtimeBaseSeries: ResolvedChartGPUOptions['series'] = currentOptions.series;

  // Zoom-aware sampled series list used for rendering + cartesian hit-testing.
  // Derived from `currentOptions.series` (which still includes baseline sampled `data`).
  let renderSeries: ResolvedChartGPUOptions['series'] = currentOptions.series;

  // Cache for visible y-bounds computed from renderSeries (for yAxis.autoBounds === 'visible').
  // Recomputed whenever renderSeries changes (zoom/pan/data updates).
  let cachedVisibleYBoundsByAxis: Map<string, { yMin: number; yMax: number }> = new Map();

  /**
   * Sticky auto-range domains.
   * Y: ~10% growBy headroom amortizes overlay rebuild under amplitude noise.
   * X: headroom 0 so unbounded appendData stays full-width (non-zero pad caused
   * the ultimate-benchmark empty-right grow/reset loop). Cleared on full
   * setOption / explicit axis domains / autoScroll.
   */
  let stickyAutoXDomain: { min: number; max: number } | null = null;
  const stickyAutoYDomainByAxis = new Map<string, { min: number; max: number }>();

  /**
   * Base X domain used for zoom→visible window, sampling, and slice.
   * Must match paint's sticky / autoScroll / explicit-end gates so decimation
   * windows agree with GPU scales when sticky is active.
   *
   * - `mode: 'read'`: use existing sticky if active; do not mutate sticky state.
   * - `mode: 'paint'`: applyStickyAutoDomain / clear sticky when skipped or mid-transition.
   */
  function resolveBaseXDomain(
    mode: 'read' | 'paint',
    opts?: {
      dataXDomain?: { min: number; max: number };
      /** When true mid-transition: return data domain; clear sticky in paint mode. */
      updateTransitionActive?: boolean;
    }
  ): { min: number; max: number } {
    const dataXDomain = opts?.dataXDomain ?? computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);

    if (opts?.updateTransitionActive) {
      if (mode === 'paint') {
        stickyAutoXDomain = null;
      }
      return dataXDomain;
    }

    const xExplicitMin = finiteOrUndefined(currentOptions.xAxis.min);
    const xExplicitMax = finiteOrUndefined(currentOptions.xAxis.max);
    const skipSticky = shouldSkipStickyAutoXDomain(currentOptions.autoScroll, xExplicitMin, xExplicitMax);

    if (mode === 'paint') {
      if (skipSticky) {
        stickyAutoXDomain = null;
        return dataXDomain;
      }
      // X headroom must be 0 — see DEFAULT_STICKY_X_DOMAIN_HEADROOM.
      const next = applyStickyAutoDomain(dataXDomain, stickyAutoXDomain, DEFAULT_STICKY_X_DOMAIN_HEADROOM);
      stickyAutoXDomain = next;
      return next;
    }

    return resolveStickyOrDataDomain(dataXDomain, stickyAutoXDomain, { skipSticky });
  }

  const shouldComputeVisibleYBoundsForAxis = (opts: ResolvedChartGPUOptions, axisId: string): boolean => {
    const yAxisConfig = opts.yAxes.find((ax) => ax.id === axisId) || opts.yAxes[0]!;
    const autoBoundsMode = yAxisConfig.autoBounds ?? 'visible';
    if (autoBoundsMode !== 'visible') return false;
    const explicitMin = finiteOrUndefined(yAxisConfig.min);
    const explicitMax = finiteOrUndefined(yAxisConfig.max);
    return !(explicitMin !== undefined && explicitMax !== undefined);
  };

  const recomputeCachedVisibleYBoundsIfNeeded = (): void => {
    cachedVisibleYBoundsByAxis.clear();
    // Full-span / no zoom: "visible" equals the full dataset. Prefer O(1) raw
    // bounds (runtimeRawBoundsByIndex / series.rawBounds) instead of scanning
    // renderSeries. Critical for GPU-decimation + series-compression paths where
    // the series still holds full raw (100k→multi-M) and every append would
    // otherwise be an O(N) y-extrema walk.
    const zoomRange = zoomState?.getRange() ?? null;
    const fullSpan = isFullSpanZoomRangeHelper(zoomRange);
    const seriesForAxis = runtimeBaseSeries.length > 0 ? runtimeBaseSeries : currentOptions.series;

    // Zoomed: filter Y extrema to the visible X window (GPU-decimation series
    // keep full raw on the series; unfiltered scan would use off-window peaks).
    // Same sticky/autoScroll gates as paint so visible-Y matches drawn scales.
    let xWindow: { min: number; max: number } | null = null;
    if (!fullSpan && zoomRange) {
      const baseX = resolveBaseXDomain('read');
      const vis = computeVisibleXDomain(baseX, zoomRange);
      xWindow = { min: vis.min, max: vis.max };
    }

    for (const ax of currentOptions.yAxes) {
      if (!shouldComputeVisibleYBoundsForAxis(currentOptions, ax.id!)) continue;
      if (fullSpan) {
        cachedVisibleYBoundsByAxis.set(
          ax.id!,
          computeGlobalYBoundsForAxis(seriesForAxis, ax.id!, runtimeRawBoundsByIndex)
        );
      } else {
        cachedVisibleYBoundsByAxis.set(ax.id!, computeVisibleYBoundsForAxis(renderSeries, ax.id!, xWindow));
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
  // - fullRawLine: sampling=none; DataStore holds full raw (any zoom) — append-safe
  // - gpuDecimationRaw: GPU decimation active; buffer holds full raw for compute
  let gpuSeriesKindByIndex: DataStoreBufferKind[] = new Array(currentOptions.series.length).fill('unknown');
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
    overlayContainer && currentOptions.tooltip?.show !== false ? createTooltip(overlayContainer) : null;

  // Cache tooltip state to avoid unnecessary DOM updates
  const tooltipCache = createTooltipCache();

  // Throttle tooltip hit-testing to ~30 Hz (P0-4). Crosshair/highlight still track the
  // pointer every frame; only the expensive tooltip scan + DOM path is rate-limited.
  // A follow-up render is scheduled so the tooltip catches up after the window elapses.
  const TOOLTIP_HIT_TEST_THROTTLE_MS = 33;
  let lastTooltipHitTestMs = -Infinity;
  let pendingTooltipFollowupTimerId: ReturnType<typeof setTimeout> | null = null;

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
  const showTooltipInternal = (x: number, y: number, content: string, _params: TooltipParams | TooltipParams[]) => {
    tooltip?.show(x, y, content);
  };

  const hideTooltipInternal = () => {
    tooltip?.hide();
  };

  const hideTooltip = () => {
    clearTooltipCache(tooltipCache);
    hideTooltipInternal();
  };

  const updateLegend = (series: ResolvedChartGPUOptions['series'], theme: ResolvedChartGPUOptions['theme']) => {
    legend?.update(series, theme);
  };

  updateLegend(currentOptions.series, currentOptions.theme);

  let dataStore = createDataStore(device);

  /** DOM axis-label rebuild signature; skip clear+rebuild when unchanged. */
  let lastAxisLabelDomSignature = '';
  /**
   * Bumped on every setOptions so labelSig invalidates when tick formatters,
   * axis type, theme fonts, or other options that affect label content change.
   * Function identity cannot be stringified reliably.
   */
  let axisLabelContentEpoch = 0;

  // MSAA: default 4× (portable WebGPU max). `antialias: false` → sampleCount 1
  // for multi-chart dashboards / streaming grids (legal values are only 1|4).
  const msaaSampleCount: 1 | 4 = currentOptions.antialias === false ? 1 : MAIN_SCENE_MSAA_SAMPLE_COUNT;
  // Overlay pass (axes/crosshair/highlight/above-series annotations) shares the same rule.
  const overlayMsaaSampleCount: 1 | 4 = currentOptions.antialias === false ? 1 : ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT;

  const gridRenderer = createGridRenderer(device, {
    targetFormat,
    sampleCount: msaaSampleCount,
    pipelineCache,
  });
  // Axes / crosshair / highlight must match the overlay pass sampleCount.
  const xAxisRenderer = createAxisRenderer(device, {
    targetFormat,
    sampleCount: overlayMsaaSampleCount,
    pipelineCache,
  });
  const yAxisRenderers = new Map<string, ReturnType<typeof createAxisRenderer>>();
  const crosshairRenderer = createCrosshairRenderer(device, {
    targetFormat,
    sampleCount: overlayMsaaSampleCount,
    pipelineCache,
  });
  crosshairRenderer.setVisible(false);
  const highlightRenderer = createHighlightRenderer(device, {
    targetFormat,
    sampleCount: overlayMsaaSampleCount,
    pipelineCache,
  });
  highlightRenderer.setVisible(false);

  // Frame graph (WG-P1-5):
  // 1. Main MSAA → resolve (grid, series, below-series annotations)
  // 2. Overlay MSAA → resolve to swapchain (blit + above-series annotations +
  //    axes/crosshair/highlight) — skipped on direct-swapchain path when no hairline.
  // WebGPU only allows sampleCount 1 or 4. Below/above annotation layers keep
  // separate instances so prepare is layer-only (start at 0 per pass).
  const referenceLineRenderer = createReferenceLineRenderer(device, {
    targetFormat,
    sampleCount: msaaSampleCount,
    pipelineCache,
  });
  const annotationMarkerRenderer = createAnnotationMarkerRenderer(device, {
    targetFormat,
    sampleCount: msaaSampleCount,
    pipelineCache,
  });
  // Above-series annotations share the overlay MSAA sample count.
  const referenceLineRendererMsaa = createReferenceLineRenderer(device, {
    targetFormat,
    sampleCount: overlayMsaaSampleCount,
    pipelineCache,
  });
  const annotationMarkerRendererMsaa = createAnnotationMarkerRenderer(device, {
    targetFormat,
    sampleCount: overlayMsaaSampleCount,
    pipelineCache,
  });

  const textureManager = createTextureManager({
    device,
    targetFormat,
    pipelineCache,
    sampleCount: msaaSampleCount,
  });

  const initialGridArea = computeGridArea(gpuContext, currentOptions);

  // Event manager requires HTMLCanvasElement (DOM events).
  const eventManager = isHTMLCanvasElement(gpuContext.canvas)
    ? createEventManager(gpuContext.canvas, initialGridArea)
    : null;

  let pointerState: PointerState = createPointerState();

  // Interaction-x state (domain units). This drives chart sync.
  let interactionX: number | null = null;
  let interactionXSource: unknown = undefined;
  const interactionXListeners = createInteractionXListeners();

  // Cached interaction scales from the last render (used for pointer -> domain-x mapping).
  let lastInteractionScales: {
    readonly xScale: LinearScale;
    readonly yScales: Map<string, LinearScale>;
    readonly plotWidthCss: number;
    readonly plotHeightCss: number;
  } | null = null;

  const setInteractionXInternal = (nextX: number | null, source?: unknown): void => {
    const normalized = normalizeInteractionX(nextX);
    if (!shouldUpdateInteractionX(interactionX, interactionXSource, normalized, source)) return;
    interactionX = normalized;
    interactionXSource = source;
    interactionXListeners.emit(interactionX, interactionXSource);
  };

  const requestRender = (): void => {
    callbacks?.onRequestRender?.();
  };

  const isFullSpanZoomRange = (range: ZoomRange | null): boolean => isFullSpanZoomRangeHelper(range);

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

  // Append flush ownership: data/appendFlush.ts
  const flushPendingAppends = createAppendFlush(
    () =>
      ({
        pendingAppendByIndex,
        appendedGpuThisFrame,
        zoomState,
        currentOptions,
        dataStore,
        runtimeRawDataByIndex,
        runtimeRawBoundsByIndex,
        gpuSeriesKindByIndex,
        lastSetSeriesCache,
        filterGapsCache,
        lastSampledData,
        warnedSamplingDefeatsFastPath,
        recomputeRuntimeBaseSeries,
        recomputeCachedVisibleYBoundsIfNeeded,
        ensureMutableRuntimeColumns,
        isOwnedMutableColumns,
        brandOwnedColumns,
        computeBaseXDomain,
        computeVisibleXDomain,
        isFullSpanZoomRange,
        computeEffectiveZoomSpanConstraints,
        extendBoundsWithCartesianData,
        extendBoundsWithOHLCDataPoints,
        canRangedAppendLine,
        isGpuDecimationEligible,
        normalizeMaxPoints,
        planMaxPointsWindow,
        getPointCount,
        getX,
        getY,
        getSize,
        createRingXYColumns,
        appendIntoRingXY,
        dropPrefixXY,
        createStagingRingView,
        isRingXYColumns,
        isStagingRingView,
        demoteStagingViewAfterRebindFailure,
        computeRawBoundsFromCartesianData,
        get runtimeBaseSeries() {
          return runtimeBaseSeries;
        },
        set runtimeBaseSeries(v) {
          runtimeBaseSeries = v;
        },
        get renderSeries() {
          return renderSeries;
        },
        set renderSeries(v) {
          renderSeries = v;
        },
        get pendingZoomSourceKind() {
          return pendingZoomSourceKind;
        },
        set pendingZoomSourceKind(v) {
          pendingZoomSourceKind = v;
        },
      }) as AppendFlushDeps
  );

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
    }
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

    const xScale = createLinearScale().domain(domains.xDomain.min, domains.xDomain.max).range(0, plotSize.plotWidthCss);
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
    // isOHLCDataPoint: production use of tooltipLegendHelpers type guard
    if (!isOHLCDataPoint(point)) {
      return {
        seriesName: s?.name ?? '',
        seriesIndex,
        dataIndex,
        value: [0, 0, 0, 0, 0] as const,
        color: s?.color ?? '#888',
      };
    }
    if (isTupleOHLCDataPoint(point)) {
      return {
        seriesName: s?.name ?? '',
        seriesIndex,
        dataIndex,
        value: [point[0], point[1], point[2], point[3], point[4]] as const,
        color: s?.color ?? '#888',
      };
    }
    return {
      seriesName: s?.name ?? '',
      seriesIndex,
      dataIndex,
      value: [point.timestamp, point.open, point.close, point.low, point.high] as const,
      color: s?.color ?? '#888',
    };
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
  ): {
    params: TooltipParams;
    match: { point: OHLCDataPoint };
    seriesIndex: number;
  } | null => {
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
        interactionScales.yScales.get((s as any).yAxis || 'y')!,
        barWidthClip
      );
      if (!m) continue;

      const params = buildCandlestickTooltipParams(i, m.dataIndex, m.point);
      return { params, match: { point: m.point }, seriesIndex: i };
    }
    return null;
  };

  const onMouseMove = (payload: ChartGPUEventPayload): void => {
    pointerState = updatePointerFromMouse(payload.x, payload.y, payload.gridX, payload.gridY, payload.isInGrid);

    // If we're over the plot and we have recent interaction scales, update interaction-x in domain units.
    // (Best-effort; render() refreshes scales and overlays.)
    if (payload.isInGrid && lastInteractionScales) {
      const xDomain = lastInteractionScales.xScale.invert(payload.gridX);
      setInteractionXInternal(Number.isFinite(xDomain) ? xDomain : null, 'mouse');
    } else if (!payload.isInGrid) {
      // Clear interaction-x when leaving the plot (keeps synced charts from sticking).
      setInteractionXInternal(null, 'mouse');
    }

    crosshairRenderer.setVisible(payload.isInGrid);
    requestRender();
  };

  const onMouseLeave = (_payload: ChartGPUEventPayload): void => {
    // Only clear interaction overlays for real pointer interaction.
    // If we're being driven by a sync-x, leaving the canvas shouldn't hide the overlays.
    if (pointerState.source !== 'mouse') return;

    pointerState = clearPointer(pointerState);
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

  // Optional internal "inside zoom" (wheel zoom + drag pan).
  let zoomState: ZoomState | null = null;
  let insideZoom: ReturnType<typeof createInsideZoom> | null = null;
  let unsubscribeZoom: (() => void) | null = null;
  let lastOptionsZoomRange: Readonly<{ start: number; end: number }> | null = null;
  let pendingZoomSourceKind: ZoomChangeSourceKind | undefined = undefined;
  const zoomRangeListeners = new Set<
    (range: Readonly<{ start: number; end: number }>, sourceKind?: ZoomChangeSourceKind) => void
  >();

  const emitZoomRange = (range: Readonly<{ start: number; end: number }>, sourceKind?: ZoomChangeSourceKind): void => {
    const snapshot = Array.from(zoomRangeListeners);
    for (const cb of snapshot) cb(range, sourceKind);
  };

  const getZoomOptionsConfig = (
    opts: ResolvedChartGPUOptions
  ): {
    readonly start: number;
    readonly end: number;
    readonly hasInside: boolean;
  } | null => {
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
    const maxSpan = Number.isFinite(fromOptions.maxSpan as number) ? clampPercent(fromOptions.maxSpan as number) : 100;

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
    // Runtime data references are about to be regenerated; invalidate the per-frame
    // setSeries cache so the next render uploads the fresh references (P1-2).
    lastSetSeriesCache.clear();
    filterGapsCache.clear();

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
      // Full rewrite path: keep the raw data reference to avoid O(n) MutableXYColumns
      // allocations every setOption on full-rewrite frames. appendData promotes to
      // branded owned columns / ring on the first stream batch — never mutates the
      // caller's {x,y} arrays or DataPoint[] in place.
      runtimeRawDataByIndex[i] = raw;
      runtimeRawBoundsByIndex[i] = s.rawBounds ?? computeRawBoundsFromCartesianData(raw);
    }
  };

  /**
   * True when runtime storage is coordinator-owned MutableXYColumns (branded).
   * User-supplied `{ x, y }` from setOption is NOT owned and must be copied on append.
   */
  const isOwnedMutableColumns = (data: unknown): data is MutableXYColumns => {
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
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
    s: ResolvedSeriesConfig
  ): MutableXYColumns | RingXYColumns => {
    const existing = runtimeRawDataByIndex[seriesIndex];
    if (isRingXYColumns(existing)) return existing;
    if (isOwnedMutableColumns(existing)) return existing;
    // Staging views are zero-copy over DataStore; promote to capacity-preserving
    // ring columns when leaving thin path (GPU fast path ineligible / non-append
    // mutations that need owned Mutable/RingXY) so the next maxPoints append stays
    // O(append) modular — not linear → re-ring. Thin path is not tooltip-gated.
    if (isStagingRingView(existing)) {
      const ring = stagingRingViewToRingXYColumns(existing);
      runtimeRawDataByIndex[seriesIndex] = ring;
      if (runtimeRawBoundsByIndex[seriesIndex] == null) {
        runtimeRawBoundsByIndex[seriesIndex] = computeRawBoundsFromCartesianData(
          ring as unknown as CartesianSeriesData
        );
      }
      return ring;
    }
    const sAny = s as ResolvedSeriesConfig & {
      rawData?: CartesianSeriesData;
      rawBounds?: Bounds | null;
      data?: CartesianSeriesData;
    };
    const seed = (existing as CartesianSeriesData | null) ?? ((sAny.rawData ?? sAny.data) as CartesianSeriesData);
    const owned = cartesianDataToMutableColumns(seed);
    runtimeRawDataByIndex[seriesIndex] = owned;
    if (runtimeRawBoundsByIndex[seriesIndex] == null) {
      runtimeRawBoundsByIndex[seriesIndex] = sAny.rawBounds ?? computeRawBoundsFromCartesianData(seed);
    }
    return owned;
  };

  const recomputeRuntimeBaseSeries = (): void => {
    runtimeBaseSeries = buildRuntimeBaseSeries(currentOptions.series, runtimeRawDataByIndex, runtimeRawBoundsByIndex);
  };

  function sliceRenderSeriesToVisibleRange(): void {
    const zoomRange = zoomState?.getRange() ?? null;
    const baseXDomain = resolveBaseXDomain('read');
    const visibleX = computeVisibleXDomain(baseXDomain, zoomRange);

    // Fast path: no zoom or full span - use baseline directly
    // (shared 0.5%-tolerance predicate — see zoomHelpers.isFullSpanZoom).
    if (isFullSpanZoomRange(zoomRange)) {
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
      if (cache && visibleX.min >= cache.cachedRange.min && visibleX.max <= cache.cachedRange.max) {
        if (baseline.type === 'candlestick') {
          next[i] = {
            ...baseline,
            data: sliceVisibleRangeByOHLC(cache.data as ReadonlyArray<OHLCDataPoint>, visibleX.min, visibleX.max),
          };
        } else {
          next[i] = {
            ...baseline,
            data: sliceVisibleRangeByX(cache.data as CartesianSeriesData, visibleX.min, visibleX.max),
          };
        }
        continue;
      }

      // Strategy 2: Fallback to baseline sampled data
      if (baseline.type === 'candlestick') {
        next[i] = {
          ...baseline,
          data: sliceVisibleRangeByOHLC(baseline.data as ReadonlyArray<OHLCDataPoint>, visibleX.min, visibleX.max),
        };
      } else {
        next[i] = {
          ...baseline,
          data: sliceVisibleRangeByX(baseline.data as CartesianSeriesData, visibleX.min, visibleX.max),
        };
      }
    }

    renderSeries = next;
    // Recompute visible y-bounds from the sliced renderSeries
    recomputeCachedVisibleYBoundsIfNeeded();
  }

  function recomputeRenderSeries(): void {
    const zoomRange = zoomState?.getRange() ?? null;
    const baseXDomain = resolveBaseXDomain('read');
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
    const spanFracSafe = Math.max(1e-3, Math.min(1, visibleX.spanFraction));

    const next: ResolvedChartGPUOptions['series'][number][] = new Array(runtimeBaseSeries.length);

    for (let i = 0; i < runtimeBaseSeries.length; i++) {
      const s = runtimeBaseSeries[i]!;

      if (s.type === 'pie') {
        next[i] = s;
        continue;
      }

      // Fast path: no zoom window / full span. Use baseline resolved `data` (already sampled by resolver).
      if (isFullSpanZoomRange(zoomRange)) {
        next[i] = s;
        continue;
      }

      // Candlestick + cartesian: single pure zoomed resolver (seriesPipeline).
      if (
        s.type === 'candlestick' ||
        s.type === 'line' ||
        s.type === 'area' ||
        s.type === 'bar' ||
        s.type === 'scatter'
      ) {
        const result = resolveZoomedSeriesEntry({
          series: s,
          rawSlot: runtimeRawDataByIndex[i],
          bufferedMin,
          bufferedMax,
          visibleMin: visibleX.min,
          visibleMax: visibleX.max,
          spanFraction: spanFracSafe,
          sliceX: sliceVisibleRangeByX,
          sliceOHLC: sliceVisibleRangeByOHLC,
        });
        next[i] = result.series;
        if (result.cacheEntry) {
          lastSampledData[i] = {
            data: result.cacheEntry.data,
            cachedRange: result.cacheEntry.cachedRange,
            timestamp: Date.now(),
          };
        }
        continue;
      }

      next[i] = s;
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
    sampleCount: msaaSampleCount,
  });

  ensureRendererPoolsForSeries(rendererPool, currentOptions.series);

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
      const fromYBaseDomains = new Map<string, { min: number; max: number }>();
      for (const ax of currentOptions.yAxes) {
        fromYBaseDomains.set(
          ax.id!,
          computeBaseYDomainForAxis(
            currentOptions,
            ax.id!,
            runtimeRawBoundsByIndex,
            cachedVisibleYBoundsByAxis.get(ax.id!) ?? null
          )
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
    const likelyDataChanged = didSeriesDataLikelyChange(prevSeries, resolvedOptions.series);
    // P1-7: full baseline + zoom re-sample only when raw data or sampling config changes.
    // Theme/legend/color presentation updates reuse already-sampled series data.
    const needsBaselineResample = shouldRecomputeBaselineSampling(prevSeries, resolvedOptions.series);

    currentOptions = resolvedOptions;
    // Invalidate DOM axis-label skip-cache: formatters, axis type, theme fonts,
    // and other label-affecting options may have changed (functions not in sig).
    axisLabelContentEpoch++;

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
    cachedVisibleYBoundsByAxis.clear();
    // Drop sticky auto-range so setOption (axes-only y min/max, full rewrite)
    // does not keep a prior streaming headroom domain.
    stickyAutoXDomain = null;
    stickyAutoYDomainByAxis.clear();
    legend?.update(resolvedOptions.series, resolvedOptions.theme);
    if (needsBaselineResample) {
      // Sampling path may flip (e.g. line areaStyle on/off → GPU vs CPU). Retag
      // buffer kinds so append fast-path and prepareSeries do not keep a stale kind.
      if (!likelyDataChanged) {
        gpuSeriesKindByIndex = new Array(resolvedOptions.series.length).fill('unknown');
        lastSetSeriesCache.clear();
        filterGapsCache.clear();
        lastSampledData = new Array(resolvedOptions.series.length).fill(null);
        // Presentation-stable data: re-sample from runtime store (append path
        // also uses this via flush).
        recomputeRuntimeBaseSeries();
      } else {
        // Full data rewrite: OptionResolver already sampled `currentOptions.series`.
        // Do NOT re-run LTTB/OHLC here — that was a double O(n) on every
        // full-setOption frame. Align rawData/rawBounds with the runtime store only.
        runtimeBaseSeries = buildSetOptionsReuseSeries(
          currentOptions.series,
          runtimeRawDataByIndex,
          runtimeRawBoundsByIndex
        );
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
      const boundsModeChanged = didRawBoundsModeChange(prevSeries, resolvedOptions.series);
      if (boundsModeChanged) {
        for (let i = 0; i < resolvedOptions.series.length; i++) {
          const s = resolvedOptions.series[i]!;
          if (s.type === 'pie') continue;
          const mode = (s as { rawBoundsMode?: string }).rawBoundsMode;
          const rb = (s as { rawBounds?: Bounds | null }).rawBounds ?? null;
          if (mode === 'data' || mode === 'xDataYAxis') {
            // Prefer scanning runtime store (owned columns / ring / raw ref after
            // promote) so append-extended extrema survive axes-auto flip.
            const runtime = runtimeRawDataByIndex[i];
            if (runtime != null && s.type !== 'candlestick') {
              runtimeRawBoundsByIndex[i] =
                (computeRawBoundsFromCartesianData(runtime as CartesianSeriesData) as Bounds | null) ?? rb ?? null;
            } else if (s.type === 'candlestick') {
              const ohlc =
                (runtime as ReadonlyArray<OHLCDataPoint> | null) ??
                ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
              runtimeRawBoundsByIndex[i] = extendBoundsWithOHLCDataPoints(null, ohlc) ?? rb ?? null;
            } else {
              runtimeRawBoundsByIndex[i] = rb;
            }
          } else if (mode === 'synthetic' && rb) {
            // Axes fully explicit again — synthetic extents from resolver.
            runtimeRawBoundsByIndex[i] = rb;
          } else if (rb) {
            runtimeRawBoundsByIndex[i] = rb;
          }
        }
      }
      runtimeBaseSeries = patchSeriesPresentationKeepingSampledData(resolvedOptions.series, runtimeBaseSeries);
      renderSeries = patchSeriesPresentationKeepingSampledData(runtimeBaseSeries, renderSeries);
      // Keep series.rawBounds aligned with refreshed runtime bounds after mode flip.
      if (boundsModeChanged) {
        const stampRuntimeBounds = (series: ResolvedChartGPUOptions['series']): ResolvedChartGPUOptions['series'] =>
          series.map((s, i) => {
            if (s.type === 'pie') return s;
            const b = runtimeRawBoundsByIndex[i];
            return b ? ({ ...s, rawBounds: b } as typeof s) : s;
          }) as ResolvedChartGPUOptions['series'];
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
        clearTooltipCache(tooltipCache);
      }
      if (!shouldHaveTooltip && tooltip) {
        hideTooltip();
      }
    } else {
      hideTooltip();
    }

    const nextCount = resolvedOptions.series.length;
    // Type-aware pools: pure multi-line charts (group 1) only allocate line
    // renderers — not area/scatter/pie/candle/decimation × N (setup hang at 4k+).
    ensureRendererPoolsForSeries(rendererPool, resolvedOptions.series);

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
    const toYBaseDomains = new Map<string, { min: number; max: number }>();
    for (const ax of currentOptions.yAxes) {
      toYBaseDomains.set(
        ax.id!,
        computeBaseYDomainForAxis(
          currentOptions,
          ax.id!,
          runtimeRawBoundsByIndex,
          cachedVisibleYBoundsByAxis.get(ax.id!) ?? null
        )
      );
    }
    const toSeriesForTransition = renderSeries;

    // Compare primary axis domain for change detection
    const primaryAxisId = currentOptions.yAxes[0]?.id ?? 'y';
    const fromPrimaryY = fromSnapshot.yBaseDomains.get(primaryAxisId) ?? { min: 0, max: 1 };
    const toPrimaryY = toYBaseDomains.get(primaryAxisId) ?? { min: 0, max: 1 };
    const domainChanged = !isDomainEqual(fromSnapshot.xBaseDomain, toXBase) || !isDomainEqual(fromPrimaryY, toPrimaryY);

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
      }
    );
    updateAnimId = id;

    // Request initial render to kick off the animation.
    // Without this, the animation won't start until something else triggers a render
    // (e.g., pointer movement, which may not happen if the user is interacting with
    // UI overlays like the legend).
    requestRender();
  };

  const getRuntimeSeriesData: RenderCoordinator['getRuntimeSeriesData'] = (seriesIndex) => {
    assertNotDisposed();
    if (!Number.isFinite(seriesIndex)) return null;
    if (seriesIndex < 0 || seriesIndex >= currentOptions.series.length) return null;
    // Flush pending appends so the snapshot matches GPU / hit-test intent.
    if (pendingAppendByIndex.size > 0) {
      cancelScheduledFlush();
      executeFlush({ requestRenderAfter: false });
    }
    return (runtimeRawDataByIndex[seriesIndex] as CartesianSeriesData | ReadonlyArray<OHLCDataPoint> | null) ?? null;
  };

  const getRuntimeSeriesBounds: RenderCoordinator['getRuntimeSeriesBounds'] = (seriesIndex) => {
    assertNotDisposed();
    if (!Number.isFinite(seriesIndex)) return null;
    if (seriesIndex < 0 || seriesIndex >= currentOptions.series.length) return null;
    if (pendingAppendByIndex.size > 0) {
      cancelScheduledFlush();
      executeFlush({ requestRenderAfter: false });
    }
    return runtimeRawBoundsByIndex[seriesIndex] ?? null;
  };

  const appendData: RenderCoordinator['appendData'] = (seriesIndex, newPoints, options) => {
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
    const pointCount =
      s.type === 'candlestick'
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

      const hasDrawableSeriesMarks = hasAnyDrawableMarks(seriesForIntro as ReadonlyArray<AnySeriesConfig>);

      const nextIntro = computeNextIntroPhase(introPhase, hasDrawableSeriesMarks, !!introCfg, false);
      if (nextIntro === 'running' && introPhase === 'pending' && introCfg) {
        const totalMs = introCfg.delayMs + introCfg.durationMs;
        const easingWithDelay = createEasingWithDelay(introCfg.delayMs, introCfg.durationMs, introCfg.easing);

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
    const dataXDomain = updateTransition
      ? lerpDomain(updateTransition.from.xBaseDomain, updateTransition.to.xBaseDomain, updateP)
      : computeBaseXDomain(currentOptions, runtimeRawBoundsByIndex);
    // Sticky auto-range / autoScroll / mid-transition: shared with slice + resample
    // via resolveBaseXDomain so zoom-percent windows match GPU scales.
    const baseXDomain = resolveBaseXDomain('paint', {
      dataXDomain,
      updateTransitionActive: !!(updateTransition && updateP < 1),
    });
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
        stickyAutoYDomainByAxis.delete(axisId);
      } else {
        const dataDom = computeBaseYDomainForAxis(
          currentOptions,
          axisId,
          runtimeRawBoundsByIndex,
          cachedVisibleYBoundsByAxis.get(axisId) ?? null
        );
        const yExplicitMin = finiteOrUndefined(ax.min);
        const yExplicitMax = finiteOrUndefined(ax.max);
        // Any explicit end disables sticky so headroom cannot pad past a locked edge.
        if (!shouldApplyStickyAutoDomain(yExplicitMin, yExplicitMax)) {
          dom = dataDom;
          stickyAutoYDomainByAxis.delete(axisId);
        } else {
          const next = applyStickyAutoDomain(
            dataDom,
            stickyAutoYDomainByAxis.get(axisId) ?? null,
            DEFAULT_STICKY_DOMAIN_HEADROOM
          );
          stickyAutoYDomainByAxis.set(axisId, next);
          dom = next;
        }
      }
      currentYDomains.set(axisId, dom);
      currentYScales.set(
        axisId,
        createLinearScale().domain(dom.min, dom.max).range(plotClipRect.bottom, plotClipRect.top)
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
      canvasCssWidthForAnnotations > 0 ? clipXToCanvasCssPx(plotClipRect.left, canvasCssWidthForAnnotations) : 0;
    const plotRightCss =
      canvasCssWidthForAnnotations > 0 ? clipXToCanvasCssPx(plotClipRect.right, canvasCssWidthForAnnotations) : 0;
    const plotTopCss =
      canvasCssHeightForAnnotations > 0 ? clipYToCanvasCssPx(plotClipRect.top, canvasCssHeightForAnnotations) : 0;
    const plotBottomCss =
      canvasCssHeightForAnnotations > 0 ? clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeightForAnnotations) : 0;
    const plotWidthCss = Math.max(0, plotRightCss - plotLeftCss);
    const plotHeightCss = Math.max(0, plotBottomCss - plotTopCss);

    // Process annotations (convert to GPU instances for rendering)
    const annotations: ReadonlyArray<AnnotationConfig> = hasCartesianSeries ? (currentOptions.annotations ?? []) : [];
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

    // Annotation layers prepared separately for main (below) vs overlay (above) MSAA.
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
            updateInterpolationCaches
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
      const scatters = pool.scatterRenderers;
      for (let si = 0; si < scatters.length; si++) {
        scatters[si]!.invalidateGeometry();
      }
      // Candlestick domain instances are identity-cached (issue 1.3) — same
      // in-place interpolation contract as area/bar/scatter (review issue 2).
      const candles = pool.candlestickRenderers;
      for (let ci = 0; ci < candles.length; ci++) {
        candles[ci]!.invalidateGeometry();
      }
    }

    // Keep `interactionX` in sync with real pointer movement (domain units).
    if (pointerState.source === 'mouse' && pointerState.hasPointer && pointerState.isInGrid && interactionScales) {
      setInteractionXInternal(gridToDomainX(pointerState.gridX, interactionScales.xScale), 'mouse');
    }

    // Compute the effective interaction state:
    // - mouse: use the latest pointer event payload
    // - sync: derive a synthetic pointer position from `interactionX` (x only; y is arbitrary)
    const interactionScalesForHelpers = interactionScales
      ? {
          xScale: interactionScales.xScale,
          yScale: interactionScales.yScales.values().next().value ?? interactionScales.xScale,
          plotWidthCss: interactionScales.plotWidthCss,
          plotHeightCss: interactionScales.plotHeightCss,
        }
      : null;
    const effectivePointer: PointerState = computeEffectivePointer(
      pointerState,
      interactionX,
      interactionScalesForHelpers,
      {
        left: gridArea.left,
        top: gridArea.top,
        width: Math.max(
          0,
          gridArea.canvasWidth / Math.max(1e-6, gridArea.devicePixelRatio || 1) - gridArea.left - gridArea.right
        ),
        height: Math.max(
          0,
          gridArea.canvasHeight / Math.max(1e-6, gridArea.devicePixelRatio || 1) - gridArea.top - gridArea.bottom
        ),
      }
    );

    // P0-5: single findNearestPoint for highlight + item-mode tooltip.
    // Computed once when the real pointer is over the plot; shared via prepareOverlays.
    let sharedNearestMatch: ReturnType<typeof findNearestPoint> | undefined;
    if (
      effectivePointer.source === 'mouse' &&
      effectivePointer.hasPointer &&
      effectivePointer.isInGrid &&
      interactionScales
    ) {
      sharedNearestMatch = findNearestPoint(
        seriesForRender,
        effectivePointer.gridX,
        effectivePointer.gridY,
        interactionScales.xScale,
        interactionScales.yScales.values().next().value!
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
      }
    );

    // Tooltip: on hover, find matches and render tooltip near cursor.
    // Note: Tooltips require HTMLCanvasElement (DOM-specific positioning).
    const tooltipPointerActive =
      effectivePointer.hasPointer && effectivePointer.isInGrid && currentOptions.tooltip?.show !== false;

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
              if (content && shouldUpdateTooltip(tooltipCache, content, containerX, containerY)) {
                updateTooltipCache(tooltipCache, content, containerX, containerY);
                showTooltipInternal(containerX, containerY, content, paramsArray);
              } else if (!content) {
                hideTooltip();
              }
            } else {
              const m0 = matches[0];
              const params = buildTooltipParams(m0.seriesIndex, m0.dataIndex, m0.point);
              const content = formatter
                ? (formatter as (p: TooltipParams) => string)(params)
                : formatTooltipItem(params);
              if (content && shouldUpdateTooltip(tooltipCache, content, containerX, containerY)) {
                updateTooltipCache(tooltipCache, content, containerX, containerY);
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
              if (content && shouldUpdateTooltip(tooltipCache, content, containerX, containerY)) {
                updateTooltipCache(tooltipCache, content, containerX, containerY);
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
                      interactionScales.yScales,
                      gridArea,
                      canvas
                    );
                    const tooltipX = anchor?.x ?? containerX;
                    const tooltipY = anchor?.y ?? containerY;
                    if (shouldUpdateTooltip(tooltipCache, content, tooltipX, tooltipY)) {
                      updateTooltipCache(tooltipCache, content, tooltipX, tooltipY);
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
                      interactionScales.yScales,
                      gridArea,
                      canvas
                    );
                    if (anchor) {
                      tooltipX = anchor.x;
                      tooltipY = anchor.y;
                    }
                  }
                  if (shouldUpdateTooltip(tooltipCache, content, tooltipX, tooltipY)) {
                    updateTooltipCache(tooltipCache, content, tooltipX, tooltipY);
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
              if (content && shouldUpdateTooltip(tooltipCache, content, containerX, containerY)) {
                updateTooltipCache(tooltipCache, content, containerX, containerY);
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
                    interactionScales.yScales,
                    gridArea,
                    canvas
                  );
                  const tooltipX = anchor?.x ?? containerX;
                  const tooltipY = anchor?.y ?? containerY;
                  if (shouldUpdateTooltip(tooltipCache, content, tooltipX, tooltipY)) {
                    updateTooltipCache(tooltipCache, content, tooltipX, tooltipY);
                    showTooltipInternal(tooltipX, tooltipY, content, candlestickResult.params);
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
                const params = buildTooltipParams(match.seriesIndex, match.dataIndex, match.point);
                const content = formatter
                  ? (formatter as (p: TooltipParams) => string)(params)
                  : formatTooltipItem(params);
                if (content && shouldUpdateTooltip(tooltipCache, content, containerX, containerY)) {
                  updateTooltipCache(tooltipCache, content, containerX, containerY);
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
      interactionScales ?? (canvas && isHTMLCanvasElement(canvas) ? getPlotSizeCssPx(canvas, gridArea) : null);
    const maxRadiusCss =
      plotSize && typeof plotSize.plotWidthCss === 'number' && typeof plotSize.plotHeightCss === 'number'
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
    const introP = introPhase === 'running' ? clamp01(introProgress01) : 1;
    const yScaleForBars = introP < 1 ? createAnimatedBarYScale(yScale, plotClipRect, introP) : yScale;
    poolState.barRenderer.prepare(visibleBarSeriesConfigs, xScale, yScaleForBars, gridArea);

    // Prepare annotation GPU overlays for main vs overlay pipelines (both 4× MSAA).
    // Prepare each layer's list every frame (empty list clears prior-frame instances).
    // Render only when that layer's count > 0; draws start at 0 (not combined offsets).
    // Note: these renderers expect CANVAS-LOCAL CSS pixel coordinates.
    if (hasCartesianSeries) {
      referenceLineRenderer.prepare(gridArea, annotationResult.linesBelow);
      referenceLineRendererMsaa.prepare(gridArea, annotationResult.linesAbove);
      annotationMarkerRenderer.prepare({
        canvasWidth: gridArea.canvasWidth,
        canvasHeight: gridArea.canvasHeight,
        devicePixelRatio: gridArea.devicePixelRatio,
        instances: annotationResult.markersBelow,
      });
      annotationMarkerRendererMsaa.prepare({
        canvasWidth: gridArea.canvasWidth,
        canvasHeight: gridArea.canvasHeight,
        devicePixelRatio: gridArea.devicePixelRatio,
        instances: annotationResult.markersAbove,
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

    // Dense hairline (group 3 ≥25k) must draw sampleCount:1 on the resolved main
    // color *before* axes. That forces the 2-pass path (main→resolve→hairline→
    // overlay blit+UI). When no dense hairline is deferred, collapse to a single
    // 4× MSAA main pass that resolves straight to the swapchain and draws
    // above-series annotations + axes/crosshair/highlight in-pass.
    // Multi-chart dashboards (no hairline) avoid a full-screen blit + second
    // 4× MSAA target every frame — large FPS/memory win at high chart counts.
    // Legal sample counts remain 1|4 only (never 2).
    // Dense hairline only helps when main is 4× MSAA (avoids overdraw). With
    // sampleCount 1 (`antialias: false`), lines already draw in the main pass.
    // GPU pass graph owned by frameRender.planGpuFrame (not re-derived ad hoc).
    const framePlan = planGpuFrame({
      msaaSampleCount,
      hasDenseHairline: hasDenseHairlineLines(poolState, seriesPreparation),
    });
    const { useDirectSwapchainResolve, useSwapchainAsMainView, needResolveAndOverlay, needMainColor } = framePlan;
    // passOrder drives which optional passes run (dense hairline / overlay).
    const runDenseHairlinePass = framePlanIncludesDenseHairline(framePlan);
    const runAnnotationOverlayPass = framePlanIncludesAnnotationOverlay(framePlan);

    textureManager.ensureTextures(gridArea.canvasWidth, gridArea.canvasHeight, {
      needResolveAndOverlay,
      // Direct sampleCount-1 path needs no offscreen color target.
      needMainColor,
    });
    const texState = textureManager.getState();

    // Swapchain view for direct main resolve or for the overlay MSAA resolve target.
    const swapchainView = gpuContext.canvasContext.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder({
      label: 'renderCoordinator/commandEncoder',
    });
    const clearValue = parseCssColorToGPUColor(currentOptions.theme.backgroundColor, { r: 0, g: 0, b: 0, a: 1 });

    // Encode compute passes (scatter density + line decimation) — frameRender ownership.
    encodeFrameComputePasses(poolState, seriesForRender, encoder);

    const mainPass = encoder.beginRenderPass({
      label: useDirectSwapchainResolve ? 'renderCoordinator/mainPassDirect' : 'renderCoordinator/mainPass',
      colorAttachments: [
        useSwapchainAsMainView
          ? {
              view: swapchainView,
              clearValue,
              loadOp: 'clear',
              storeOp: 'store',
            }
          : {
              view: texState.mainColorView!, // MSAA (4×) main color
              resolveTarget: useDirectSwapchainResolve ? swapchainView : texState.mainResolveView!, // intermediate resolve for hairline/overlay path
              clearValue,
              loadOp: 'clear',
              storeOp: 'discard', // MSAA content discarded after resolve
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
    // - (direct path) above-series annotations + axes/highlight/crosshair last
    if (gridRenderer) {
      gridRenderer.render(mainPass);
    }

    // Series layers — frameRender.encodeMainSeriesPass.
    encodeMainSeriesPass(
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
      seriesPreparation
    );

    if (useDirectSwapchainResolve) {
      // Above-series annotations + UI into the same 4× MSAA main pass (sampleCount
      // matches ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT === MAIN_SCENE_MSAA_SAMPLE_COUNT).
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
          overlayPass: mainPass,
          plotScissor,
          referenceLineAboveCount,
          markerAboveCount,
        }
      );
      highlightRenderer.render(mainPass);
      if (hasCartesianSeries) {
        xAxisRenderer.render(mainPass);
        for (const r of yAxisRenderers.values()) {
          r.render(mainPass);
        }
      }
      crosshairRenderer.render(mainPass);
    }

    mainPass.end();

    // Optional passes follow framePlan.passOrder (denseHairline → annotationOverlay).
    if (runDenseHairlinePass || runAnnotationOverlayPass) {
      if (runDenseHairlinePass) {
        // Dense hairline lines (group 3 ≥25k): after main resolve, sampleCount:1 load-pass.
        const hairlinePass = encoder.beginRenderPass({
          label: 'renderCoordinator/denseHairlinePass',
          colorAttachments: [
            {
              view: texState.mainResolveView!,
              loadOp: 'load',
              storeOp: 'store',
            },
          ],
        });
        renderDenseHairlineLines(
          poolState,
          {
            gridArea,
            hairlinePass,
            plotScissor,
            introPhase,
            introProgress01,
          },
          seriesPreparation
        );
        hairlinePass.end();
      }

      if (runAnnotationOverlayPass) {
        // MSAA annotation overlay: blit resolved main → MSAA target, then above-series annotations + UI.
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
            referenceLineAboveCount,
            markerAboveCount,
          }
        );

        highlightRenderer.render(overlayPass);
        if (hasCartesianSeries) {
          xAxisRenderer.render(overlayPass);
          for (const r of yAxisRenderers.values()) {
            r.render(overlayPass);
          }
        }
        crosshairRenderer.render(overlayPass);

        overlayPass.end();
      }
    }

    // Multi-chart shared-device: coalesce N chart submits into one microtask batch.
    enqueueDeviceSubmit(device, encoder.finish());

    hasRenderedOnce = true;

    // DOM axis labels: clear+rebuild is expensive (multi-chart × N). Skip when
    // tick values, scale affines, plot clip, theme, and axis names are unchanged.
    // Scatter fixed-domain slots and axes-only mountain/column after ticks settle
    // hit this path every frame.
    //
    // Tick values + y domains are folded into a compact FNV-1a hash so we avoid
    // O(tickCount) string growth every frame while still invalidating when
    // computed y domains change with matching affine+count (issue 11).
    {
      let tickHash = LABEL_SIG_FNV_OFFSET >>> 0;
      tickHash = mixLabelSigUint(tickHash, xTickValues.length);
      for (let ti = 0; ti < xTickValues.length; ti++) {
        tickHash = mixLabelSigFloat(tickHash, xTickValues[ti]!);
      }
      for (const yAxisConfig of currentOptions.yAxes) {
        const axisId = yAxisConfig.id!;
        const yScaleForAxis = currentYScales.get(axisId);
        if (!yScaleForAxis) continue;
        const yTickCount = (yAxisConfig as { tickCount?: number }).tickCount ?? 5;
        const yDomain = currentYDomains.get(axisId);
        tickHash = mixLabelSigUint(tickHash, yTickCount);
        if (yDomain) {
          tickHash = mixLabelSigFloat(tickHash, yDomain.min);
          tickHash = mixLabelSigFloat(tickHash, yDomain.max);
        }
        // Explicit config ends (distinct from computed sticky/data domain).
        tickHash = mixLabelSigFloat(tickHash, yAxisConfig.min ?? Number.NaN);
        tickHash = mixLabelSigFloat(tickHash, yAxisConfig.max ?? Number.NaN);
      }

      let labelSig = `${plotClipRect.left},${plotClipRect.right},${plotClipRect.top},${plotClipRect.bottom}|`;
      labelSig += `${currentOptions.theme.fontSize}|${currentOptions.theme.textColor}|`;
      labelSig += `${currentOptions.theme.fontFamily ?? ''}|`;
      // epoch: setOptions bump covers tickFormatter identity / theme font changes.
      // xr / xt: time-axis formatting depends on visible range and axis type.
      labelSig += `epoch:${axisLabelContentEpoch}|xr:${visibleXRangeMs}|xt:${currentOptions.xAxis.type ?? ''}|`;
      labelSig += `x:${currentOptions.xAxis.name ?? ''}|`;
      labelSig += `th:${tickHash >>> 0}|`;
      labelSig += `xs:${xScale.scale(0)},${xScale.scale(1)}|`;
      for (const yAxisConfig of currentOptions.yAxes) {
        const axisId = yAxisConfig.id!;
        const yScaleForAxis = currentYScales.get(axisId);
        if (!yScaleForAxis) continue;
        const yTickCount = (yAxisConfig as { tickCount?: number }).tickCount ?? 5;
        labelSig += `y:${axisId}:${yAxisConfig.name ?? ''}:${yAxisConfig.position ?? 'left'}:`;
        labelSig += `${yScaleForAxis.scale(0)},${yScaleForAxis.scale(1)}:${yTickCount}|`;
        // Y axis type can affect tick formatting when present.
        labelSig += `yt:${(yAxisConfig as { type?: string }).type ?? ''};`;
      }
      if (labelSig !== lastAxisLabelDomSignature) {
        lastAxisLabelDomSignature = labelSig;
        renderAxisLabels(axisLabelOverlay, overlayContainer, {
          gpuContext,
          currentOptions,
          xScale,
          xTickValues,
          plotClipRect,
          visibleXRangeMs,
        });

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

  const dispose: RenderCoordinator['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    // Drain batched GPU submits BEFORE destroying textures/buffers. Otherwise a
    // microtask from the last renderFrame can submit CBs that reference freed RTs
    // (multi-chart shared-device is especially sensitive).
    try {
      flushDeviceSubmit(device);
    } catch {
      // best-effort — device may already be lost
    }

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
    cancelPendingTooltipFollowup();
    zoomResampleDue = false;

    pendingAppendByIndex.clear();
    lastSetSeriesCache.clear();
    filterGapsCache.clear();
    clearOverlayPrepareMemo(overlayPrepareMemo);
    stickyAutoXDomain = null;
    stickyAutoYDomainByAxis.clear();

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
    referenceLineRenderer.dispose();
    referenceLineRendererMsaa.dispose();
    annotationMarkerRenderer.dispose();
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

    // External interaction does not depend on y — treat as "sync" mode.
    pointerState = {
      ...pointerState,
      source: normalized === null ? 'mouse' : 'sync',
    };

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
      interactionXListeners.remove(callback);
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
