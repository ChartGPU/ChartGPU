/**
 * Series Rendering Utilities
 *
 * Prepares and renders all chart series types (area, line, bar, scatter, candlestick, pie).
 * Handles intro animations, GPU buffer management, and multi-pass rendering with proper layering.
 *
 * @module renderSeries
 */

import type {
  ResolvedChartGPUOptions,
  ResolvedSeriesConfig,
  ResolvedBarSeriesConfig,
  ResolvedAreaSeriesConfig,
  ResolvedPieSeriesConfig,
} from "../../../config/OptionResolver";
import type { DataPoint } from "../../../config/types";
import type { LinearScale } from "../../../utils/scales";
import type { GridArea } from "../../../renderers/createGridRenderer";
import type { LineRenderer } from "../../../renderers/createLineRenderer";
import type { AreaRenderer } from "../../../renderers/createAreaRenderer";
import type { BarRenderer } from "../../../renderers/createBarRenderer";
import type { ScatterRenderer } from "../../../renderers/createScatterRenderer";
import type { ScatterDensityRenderer } from "../../../renderers/createScatterDensityRenderer";
import type { PieRenderer } from "../../../renderers/createPieRenderer";
import type { CandlestickRenderer } from "../../../renderers/createCandlestickRenderer";
import type { ReferenceLineRenderer } from "../../../renderers/createReferenceLineRenderer";
import type { AnnotationMarkerRenderer } from "../../../renderers/createAnnotationMarkerRenderer";
import type { DecimationCompute } from "../../../renderers/createDecimationCompute";
import type { DataStore } from "../../../data/createDataStore";
import {
  isGpuDecimationEligible,
  mapSamplingToDecimationAlgorithm,
} from "../../../data/gpuDecimationEligibility";
import { clampInt } from "../utils/canvasUtils";
import { clamp01 } from "../animation/animationHelpers";
import { findVisibleRangeIndicesByX } from "../data/computeVisibleSlice";
import { resolvePieRadiiCss } from "../utils/timeAxisUtils";
import {
  getPointCount,
  getX,
  isStagingRingView,
} from "../../../data/cartesianData";
import {
  type FilterGapsCache,
  getFilteredGapsCached,
} from "./filterGapsCache";

export interface SeriesRenderers {
  readonly lineRenderers: ReadonlyArray<LineRenderer>;
  readonly areaRenderers: ReadonlyArray<AreaRenderer>;
  readonly barRenderer: BarRenderer;
  readonly scatterRenderers: ReadonlyArray<ScatterRenderer>;
  readonly scatterDensityRenderers: ReadonlyArray<ScatterDensityRenderer>;
  readonly pieRenderers: ReadonlyArray<PieRenderer>;
  readonly candlestickRenderers: ReadonlyArray<CandlestickRenderer>;
  /** 1:1 with lineRenderers; unused slots are no-ops until prepared. */
  readonly decimationComputes: ReadonlyArray<DecimationCompute>;
}

export interface AnnotationRenderers {
  referenceLineRenderer: ReferenceLineRenderer;
  referenceLineRendererMsaa: ReferenceLineRenderer;
  annotationMarkerRenderer: AnnotationMarkerRenderer;
  annotationMarkerRendererMsaa: AnnotationMarkerRenderer;
}

/**
 * Per-series cache of the last `(data ref, xOffset)` passed to `dataStore.setSeries()`.
 * When both match the previous frame, `setSeries` is skipped entirely — avoiding the
 * O(n) pack + hash that would otherwise run before the content-hash early-return.
 * (P1-2)
 */
export type LastSetSeriesCache = Map<
  number,
  Readonly<{ data: unknown; xOffset: number }>
>;

export interface SeriesPrepareContext {
  currentOptions: ResolvedChartGPUOptions;
  seriesForRender: ReadonlyArray<ResolvedSeriesConfig>;
  xScale: LinearScale;
  yScales: Map<string, LinearScale>;
  gridArea: GridArea;
  dataStore: DataStore;
  appendedGpuThisFrame: Set<number>;
  gpuSeriesKindByIndex: Array<
    "fullRawLine" | "gpuDecimationRaw" | "other" | "unknown"
  >;
  zoomState: { getRange(): { start: number; end: number } | null } | null;
  visibleXDomain: { min: number; max: number };
  introPhase: "pending" | "running" | "done";
  introProgress01: number;
  withAlpha: (color: string, alpha: number) => string;
  maxRadiusCss: number;
  /**
   * Persistent cache of the last `setSeries()` data reference + xOffset per series index.
   * Caller owns the Map and must clear it when update animations mutate data in-place
   * under a stable array reference.
   */
  lastSetSeriesCache: LastSetSeriesCache;
  /**
   * Persistent cache of filterGaps results for connectNulls series (P2-12).
   * Caller owns the Map and must clear it with lastSetSeriesCache when data mutates
   * under a stable reference.
   */
  filterGapsCache: FilterGapsCache;
}

export interface SeriesRenderContext {
  hasCartesianSeries: boolean;
  gridArea: GridArea;
  mainPass: GPURenderPassEncoder;
  plotScissor: { x: number; y: number; w: number; h: number };
  introPhase: "pending" | "running" | "done";
  introProgress01: number;
  referenceLineBelowCount: number;
  markerBelowCount: number;
}

export interface AboveSeriesAnnotationContext {
  hasCartesianSeries: boolean;
  gridArea: GridArea;
  overlayPass: GPURenderPassEncoder;
  plotScissor: { x: number; y: number; w: number; h: number };
  referenceLineBelowCount: number;
  referenceLineAboveCount: number;
  markerBelowCount: number;
  markerAboveCount: number;
}

export interface SeriesPreparationResult {
  visibleSeriesForRender: ReadonlyArray<{
    series: ResolvedSeriesConfig;
    originalIndex: number;
  }>;
  barSeriesConfigs: ResolvedBarSeriesConfig[];
  visibleBarSeriesConfigs: ResolvedBarSeriesConfig[];
}

/**
 * Helper: determines if an area should be rendered for a series.
 * Line series with areaStyle should render as area.
 */
function shouldRenderArea(series: ResolvedSeriesConfig): boolean {
  return (
    series.type === "area" || (series.type === "line" && !!series.areaStyle)
  );
}

/**
 * Prepares all series renderers with current frame data.
 *
 * This loop prepares ALL series (including hidden) to maintain correct renderer indices.
 * Visibility filtering happens after preparation for rendering.
 *
 * @param renderers - Series renderer instances
 * @param context - Preparation context with scales, options, and state
 * @returns Preparation result with visibility-filtered series arrays
 */
export function prepareSeries(
  renderers: SeriesRenderers,
  context: SeriesPrepareContext,
): SeriesPreparationResult {
  const {
    currentOptions,
    seriesForRender,
    xScale,
    yScales,
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
  } = context;

  // Helper: get the y-scale for a series by its yAxis binding
  const getYScale = (s: ResolvedSeriesConfig): LinearScale => {
    const axisId = (s as any).yAxis || "y";
    return yScales.get(axisId) ?? yScales.values().next().value!;
  };

  /**
   * Calls `dataStore.setSeries` only when the `(data, xOffset)` pair changed from the
   * previous frame (P1-2). Skips pack+hash when the same array reference is re-used
   * (steady-state static / hover frames).
   *
   * Never setSeries a `StagingRingView`: staging already aliases DataStore modular
   * layout. setSeries always repacks linearly (ringStart=0, ringCapacity=0) and
   * would desync the view's modular start/capacity from GPU content.
   */
  const setSeriesIfChanged = (
    seriesIndex: number,
    data: unknown,
    options?: Readonly<{ xOffset?: number }>,
  ): void => {
    if (isStagingRingView(data)) {
      return;
    }
    const xOffset = options?.xOffset ?? 0;
    const cached = lastSetSeriesCache.get(seriesIndex);
    if (cached && cached.data === data && cached.xOffset === xOffset) {
      return;
    }
    dataStore.setSeries(
      seriesIndex,
      data as ReadonlyArray<DataPoint>,
      options,
    );
    lastSetSeriesCache.set(seriesIndex, { data, xOffset });
  };

  const defaultBaseline =
    currentOptions.yAxes[0]?.min ?? 0;
  const barSeriesConfigs: ResolvedBarSeriesConfig[] = [];

  const introP = introPhase === "running" ? clamp01(introProgress01) : 1;

  // Preparation loop: prepare ALL series (including hidden) to maintain correct indices
  for (let i = 0; i < seriesForRender.length; i++) {
    const s = seriesForRender[i];
    switch (s.type) {
      case "area": {
        const baseline = s.baseline ?? defaultBaseline;
        // When connectNulls is true, strip null/NaN gap entries so the area draws through gaps.
        // Cached by data ref identity (P2-12) so static frames do not re-allocate.
        const areaData = s.connectNulls
          ? getFilteredGapsCached(filterGapsCache, i, s.data)
          : s.data;
        renderers.areaRenderers[i].prepare(
          s,
          areaData,
          xScale,
          getYScale(s),
          baseline,
        );
        break;
      }
      case "line": {
        // GPU compute-shader decimation (P0-2 / Stretch S1) vs CPU path.
        // Eligibility is a pure predicate; see `isGpuDecimationEligible`.
        const rawDataForGpu = s.rawData;
        const gpuEligible = isGpuDecimationEligible(s, rawDataForGpu);

        if (gpuEligible) {
          // Time-axis packing origin: first finite domain x only establishes a
          // *new* setSeries pack. When GPU already holds packed floats (staging
          // alias, append this frame, or existing series), use DataStore's fixed
          // origin — after FIFO drops the original oldest, chronological getX(0)
          // is a newer timestamp and must NOT be used as the line affine offset.
          const domainFirstX = (() => {
            if (currentOptions.xAxis.type !== "time") return 0;
            const count = getPointCount(rawDataForGpu);
            for (let k = 0; k < count; k++) {
              const x = getX(rawDataForGpu, k);
              if (Number.isFinite(x)) return x;
            }
            return 0;
          })();
          const packingXOffset = isStagingRingView(rawDataForGpu)
            ? rawDataForGpu.xOffset
            : domainFirstX;

          if (!appendedGpuThisFrame.has(i)) {
            setSeriesIfChanged(i, rawDataForGpu, { xOffset: packingXOffset });
          }

          const xOffset = (() => {
            if (currentOptions.xAxis.type !== "time") return 0;
            if (isStagingRingView(rawDataForGpu)) {
              return rawDataForGpu.xOffset;
            }
            try {
              return dataStore.getSeriesXOffset(i);
            } catch {
              return packingXOffset;
            }
          })();

          const rawBuffer = dataStore.getSeriesBuffer(i);
          const rawPointCount = dataStore.getSeriesPointCount(i);

          const fallbackTarget = Math.max(
            2,
            Math.floor(Math.max(1, gridArea.canvasWidth) * 2),
          );
          const rawTarget = Number.isFinite(s.samplingThreshold)
            ? Math.max(2, s.samplingThreshold | 0)
            : fallbackTarget;
          const targetBuckets = Math.min(
            rawTarget,
            Math.max(2, rawPointCount),
          );

          // Prefer visible-range binary search on coordinator raw (including
          // RingXYColumns / StagingRingView — getX is chronological). Full-range
          // only when raw is unavailable (should not happen on the GPU-eligible
          // path). Decimation maps logical indices via modular ringStart/ringCapacity.
          const ringLayout = dataStore.getSeriesRingLayout(i);
          const visible =
            rawDataForGpu != null
              ? findVisibleRangeIndicesByX(
                  rawDataForGpu,
                  visibleXDomain.min,
                  visibleXDomain.max,
                )
              : { start: 0, end: rawPointCount };

          const algorithm = mapSamplingToDecimationAlgorithm(s.sampling);

          if (rawPointCount <= targetBuckets || algorithm === null) {
            renderers.lineRenderers[i].prepare(
              s,
              rawBuffer,
              xScale,
              getYScale(s),
              xOffset,
              gridArea.devicePixelRatio,
              gridArea.canvasWidth,
              gridArea.canvasHeight,
              rawPointCount,
            );
            gpuSeriesKindByIndex[i] = "gpuDecimationRaw";
          } else {
            const outputPointCount = renderers.decimationComputes[i].prepare({
              algorithm,
              rawBuffer,
              rawPointCount,
              visibleStart: visible.start,
              visibleEnd: visible.end,
              targetBuckets,
              // DataStore hash changes when floats rewrite into the same buffer
              // at the same N (animation / equal-length replace) — WG-P0-2.
              contentVersion: dataStore.getSeriesContentHash(i),
              // Modular ring FIFO: logical → physical index in decimation.wgsl.
              ringStart: ringLayout.start,
              ringCapacity: ringLayout.capacity,
            });
            const decimatedBuffer =
              renderers.decimationComputes[i].getOutputBuffer();

            renderers.lineRenderers[i].prepare(
              s,
              decimatedBuffer,
              xScale,
              getYScale(s),
              // Decimation preserves DataStore packing (x - xOffset). Fold the
              // same origin back into the line clip affine as the non-decimated path.
              xOffset,
              gridArea.devicePixelRatio,
              gridArea.canvasWidth,
              gridArea.canvasHeight,
              outputPointCount,
            );
            gpuSeriesKindByIndex[i] = "gpuDecimationRaw";
          }

          break;
        }

        // ─── CPU-sampled path (null-gap, 'none', 'average', areaStyle, etc.) ───
        // If we already appended into the DataStore this frame (fast-path), avoid a full re-upload.
        // For time axes (epoch-ms), subtract an x-origin before packing to Float32 to avoid precision loss
        // (Float32 ulp at ~1e12 is ~2e5), which can manifest as stroke shimmer during zoom.
        // When connectNulls is true, strip null/NaN gap entries so the line draws through gaps.
        // Cached by data ref identity (P2-12) so static frames do not re-allocate.
        const uploadData = s.connectNulls
          ? getFilteredGapsCached(filterGapsCache, i, s.data)
          : s.data;
        const domainFirstX = (() => {
          if (currentOptions.xAxis.type !== "time") return 0;
          const d = uploadData;
          const count = getPointCount(d);
          for (let k = 0; k < count; k++) {
            const x = getX(d, k);
            if (Number.isFinite(x)) return x;
          }
          return 0;
        })();
        // Staging / GPU-backed: packing origin is fixed on DataStore; domain-first
        // would drift after maxPoints FIFO drops the original oldest sample.
        const packingXOffset = isStagingRingView(uploadData)
          ? uploadData.xOffset
          : domainFirstX;
        if (!appendedGpuThisFrame.has(i)) {
          setSeriesIfChanged(i, uploadData, { xOffset: packingXOffset });
        }
        const xOffset = (() => {
          if (currentOptions.xAxis.type !== "time") return 0;
          if (isStagingRingView(uploadData)) {
            return uploadData.xOffset;
          }
          // Prefer store origin when series already exists (append fast path /
          // setSeries skip). After setSeries, getSeriesXOffset matches packing.
          try {
            return dataStore.getSeriesXOffset(i);
          } catch {
            return packingXOffset;
          }
        })();
        const buffer = dataStore.getSeriesBuffer(i);
        // Pass filtered data to the renderer so point count matches the GPU buffer.
        const lineSeriesForRenderer =
          uploadData !== s.data ? { ...s, data: uploadData } : s;
        renderers.lineRenderers[i].prepare(
          lineSeriesForRenderer,
          buffer,
          xScale,
          getYScale(s),
          xOffset,
          gridArea.devicePixelRatio,
          gridArea.canvasWidth,
          gridArea.canvasHeight,
        );

        // Track the GPU buffer kind for future append fast-path decisions.
        const zoomRange = zoomState?.getRange() ?? null;
        const isFullSpanZoom =
          zoomRange == null ||
          (Number.isFinite(zoomRange.start) &&
            Number.isFinite(zoomRange.end) &&
            zoomRange.start <= 0 &&
            zoomRange.end >= 100);
        if (isFullSpanZoom && s.sampling === "none") {
          gpuSeriesKindByIndex[i] = "fullRawLine";
        } else {
          gpuSeriesKindByIndex[i] = "other";
        }

        // If `areaStyle` is provided on a line series, render a fill behind it.
        if (s.areaStyle) {
          const areaLike: ResolvedAreaSeriesConfig = {
            type: "area",
            name: s.name,
            rawData: s.data,
            data: uploadData,
            color: s.areaStyle.color,
            areaStyle: s.areaStyle,
            sampling: s.sampling,
            samplingThreshold: s.samplingThreshold,
            connectNulls: s.connectNulls,
            yAxis: (s as any).yAxis ?? "y",
            // Forward resolver bounds so AreaRenderer can skip O(n) bounds scan.
            rawBounds: (s as { rawBounds?: ResolvedAreaSeriesConfig["rawBounds"] })
              .rawBounds,
          };

          renderers.areaRenderers[i].prepare(
            areaLike,
            areaLike.data,
            xScale,
            getYScale(s),
            defaultBaseline,
          );
        }

        break;
      }
      case "bar": {
        barSeriesConfigs.push(s);
        break;
      }
      case "scatter": {
        // Scatter renderer sets/resets its own scissor. Animate intro via alpha fade.
        if (s.mode === "density") {
          // Density mode bins raw (unsampled) data for correctness, but limits compute to the visible
          // range when x is monotonic.
          const rawData = (s.rawData ?? s.data) as ReadonlyArray<DataPoint>;
          const visible = findVisibleRangeIndicesByX(
            rawData,
            visibleXDomain.min,
            visibleXDomain.max,
          );

          // Upload full raw data for compute. Skip pack+hash when data ref is unchanged (P1-2).
          if (!appendedGpuThisFrame.has(i)) {
            setSeriesIfChanged(i, rawData);
          }
          const buffer = dataStore.getSeriesBuffer(i);
          const pointCount = dataStore.getSeriesPointCount(i);

          renderers.scatterDensityRenderers[i].prepare(
            s,
            buffer,
            pointCount,
            visible.start,
            visible.end,
            xScale,
            getYScale(s),
            gridArea,
            s.rawBounds,
          );
          // Density mode keeps its own compute path; treat as non-fast-path for append heuristics.
          gpuSeriesKindByIndex[i] = "other";
        } else {
          const animated =
            introP < 1
              ? ({ ...s, color: withAlpha(s.color, introP) } as const)
              : s;
          renderers.scatterRenderers[i].prepare(
            animated,
            s.data,
            xScale,
            getYScale(s),
            gridArea,
          );
        }
        break;
      }
      case "pie": {
        // Pie renderer sets/resets its own scissor. Animate intro via radius scale (CSS px).
        if (introP < 1 && maxRadiusCss > 0) {
          const radiiCss = resolvePieRadiiCss(s.radius, maxRadiusCss);
          const inner = Math.max(0, radiiCss.inner) * introP;
          const outer = Math.max(inner, radiiCss.outer) * introP;
          const animated: ResolvedPieSeriesConfig = {
            ...s,
            radius: [inner, outer] as const,
          };
          renderers.pieRenderers[i].prepare(animated, gridArea);
          break;
        }
        renderers.pieRenderers[i].prepare(s, gridArea);
        break;
      }
      case "candlestick": {
        // Candlestick renderer handles clipping internally, no intro animation for now.
        renderers.candlestickRenderers[i].prepare(
          s,
          s.data,
          xScale,
          getYScale(s),
          gridArea,
          currentOptions.theme.backgroundColor,
        );
        break;
      }
      default: {
        // Exhaustive check for unhandled series types
        const _exhaustive: never = s;
        throw new Error(`Unhandled series type: ${(_exhaustive as any).type}`);
      }
    }
  }

  // Filter series by visibility for rendering (after preparation)
  const visibleSeriesForRender = seriesForRender
    .map((s, i) => ({ series: s, originalIndex: i }))
    .filter(({ series }) => series.visible !== false);

  // Bars are collected but prepared separately by coordinator (needs yScaleForBars which depends on visibleBarSeriesConfigs)
  const visibleBarSeriesConfigs = barSeriesConfigs.filter(
    (s) => s.visible !== false,
  );

  return {
    visibleSeriesForRender,
    barSeriesConfigs,
    visibleBarSeriesConfigs,
  };
}

/**
 * Encodes scatter density compute passes before rendering.
 *
 * Must be called before beginRenderPass() for the main pass.
 *
 * @param renderers - Series renderer instances
 * @param seriesForRender - All series configurations
 * @param encoder - Command encoder for compute passes
 */
export function encodeScatterDensityCompute(
  renderers: SeriesRenderers,
  seriesForRender: ReadonlyArray<ResolvedSeriesConfig>,
  encoder: GPUCommandEncoder,
): void {
  for (let i = 0; i < seriesForRender.length; i++) {
    const s = seriesForRender[i];
    if (s.visible !== false && s.type === "scatter" && s.mode === "density") {
      renderers.scatterDensityRenderers[i].encodeCompute(encoder);
    }
  }
}

/**
 * Encodes GPU compute-shader decimation before rendering (P0-2).
 *
 * Batches all dirty series into a **single** compute pass (bind-group / pipeline
 * switches only). Safe to call unconditionally — each instance is dirty-gated
 * and no-ops when no eligible `prepare()` ran this frame.
 */
export function encodeDecimationCompute(
  renderers: SeriesRenderers,
  seriesForRender: ReadonlyArray<ResolvedSeriesConfig>,
  encoder: GPUCommandEncoder,
): void {
  let pass: GPUComputePassEncoder | null = null;
  for (let i = 0; i < seriesForRender.length; i++) {
    const s = seriesForRender[i];
    if (s.visible === false || s.type !== "line") continue;
    const compute = renderers.decimationComputes[i];
    if (!compute.needsEncode()) continue;
    if (pass == null) {
      pass = encoder.beginComputePass({
        label: "decimationCompute/batchPass",
      });
    }
    compute.encodeCompute(encoder, pass);
  }
  pass?.end();
}

/**
 * Renders all series to the main render pass with proper layering.
 *
 * Render order (from back to front):
 * 1. Pies (non-cartesian, behind cartesian series)
 * 2. Annotations below series (reference lines, markers)
 * 3. Area fills
 * 4. Bars
 * 5. Candlesticks
 * 6. Scatter points
 * 7. Line strokes
 *
 * @param renderers - Series renderer instances
 * @param annotationRenderers - Annotation renderer instances
 * @param context - Render pass context with pass encoders and state
 */
export function renderSeries(
  renderers: SeriesRenderers,
  annotationRenderers: AnnotationRenderers,
  context: SeriesRenderContext,
  prepResult: SeriesPreparationResult,
): void {
  const {
    hasCartesianSeries,
    gridArea,
    mainPass,
    plotScissor,
    introPhase,
    introProgress01,
    referenceLineBelowCount,
    markerBelowCount,
  } = context;

  const { visibleSeriesForRender } = prepResult;
  const introP = introPhase === "running" ? clamp01(introProgress01) : 1;

  // Render pies first (non-cartesian, visible behind cartesian series)
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (series.type === "pie") {
      renderers.pieRenderers[originalIndex].render(mainPass);
    }
  }

  // Annotations (below series): clipped to plot scissor.
  if (hasCartesianSeries && plotScissor.w > 0 && plotScissor.h > 0) {
    const hasBelow = referenceLineBelowCount > 0 || markerBelowCount > 0;
    if (hasBelow) {
      mainPass.setScissorRect(
        plotScissor.x,
        plotScissor.y,
        plotScissor.w,
        plotScissor.h,
      );
      if (referenceLineBelowCount > 0) {
        annotationRenderers.referenceLineRenderer.render(
          mainPass,
          0,
          referenceLineBelowCount,
        );
      }
      if (markerBelowCount > 0) {
        annotationRenderers.annotationMarkerRenderer.render(
          mainPass,
          0,
          markerBelowCount,
        );
      }
      mainPass.setScissorRect(
        0,
        0,
        gridArea.canvasWidth,
        gridArea.canvasHeight,
      );
    }
  }

  // Render area fills
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (shouldRenderArea(series)) {
      // Line/area intro reveal: left-to-right plot scissor.
      if (introP < 1) {
        const w = clampInt(
          Math.floor(plotScissor.w * introP),
          0,
          plotScissor.w,
        );
        if (w > 0 && plotScissor.h > 0) {
          mainPass.setScissorRect(
            plotScissor.x,
            plotScissor.y,
            w,
            plotScissor.h,
          );
          renderers.areaRenderers[originalIndex].render(mainPass);
          mainPass.setScissorRect(
            0,
            0,
            gridArea.canvasWidth,
            gridArea.canvasHeight,
          );
        }
      } else {
        mainPass.setScissorRect(
          plotScissor.x,
          plotScissor.y,
          plotScissor.w,
          plotScissor.h,
        );
        renderers.areaRenderers[originalIndex].render(mainPass);
        mainPass.setScissorRect(
          0,
          0,
          gridArea.canvasWidth,
          gridArea.canvasHeight,
        );
      }
    }
  }

  // Clip bars to the plot grid (mirrors area/line scissor usage).
  if (plotScissor.w > 0 && plotScissor.h > 0) {
    mainPass.setScissorRect(
      plotScissor.x,
      plotScissor.y,
      plotScissor.w,
      plotScissor.h,
    );
    renderers.barRenderer.render(mainPass);
    mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
  }

  // Render candlesticks
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (series.type === "candlestick") {
      renderers.candlestickRenderers[originalIndex].render(mainPass);
    }
  }

  // Render scatter points
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (series.type !== "scatter") continue;
    if (series.mode === "density") {
      renderers.scatterDensityRenderers[originalIndex].render(mainPass);
    } else {
      renderers.scatterRenderers[originalIndex].render(mainPass);
    }
  }

  // Render line strokes
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (series.type === "line") {
      // Line intro reveal: left-to-right plot scissor.
      if (introP < 1) {
        const w = clampInt(
          Math.floor(plotScissor.w * introP),
          0,
          plotScissor.w,
        );
        if (w > 0 && plotScissor.h > 0) {
          mainPass.setScissorRect(
            plotScissor.x,
            plotScissor.y,
            w,
            plotScissor.h,
          );
          renderers.lineRenderers[originalIndex].render(mainPass);
          mainPass.setScissorRect(
            0,
            0,
            gridArea.canvasWidth,
            gridArea.canvasHeight,
          );
        }
      } else {
        mainPass.setScissorRect(
          plotScissor.x,
          plotScissor.y,
          plotScissor.w,
          plotScissor.h,
        );
        renderers.lineRenderers[originalIndex].render(mainPass);
        mainPass.setScissorRect(
          0,
          0,
          gridArea.canvasWidth,
          gridArea.canvasHeight,
        );
      }
    }
  }
}

/**
 * Renders above-series annotations to the MSAA overlay pass.
 *
 * Must be called during the MSAA overlay pass (after blit).
 *
 * @param annotationRenderers - Annotation renderer instances
 * @param context - Render pass context with overlay pass and state
 */
export function renderAboveSeriesAnnotations(
  annotationRenderers: AnnotationRenderers,
  context: AboveSeriesAnnotationContext,
): void {
  const {
    hasCartesianSeries,
    gridArea,
    overlayPass,
    plotScissor,
    referenceLineBelowCount,
    referenceLineAboveCount,
    markerBelowCount,
    markerAboveCount,
  } = context;

  // Annotations (above series): reference lines then markers, clipped to plot scissor.
  if (hasCartesianSeries && plotScissor.w > 0 && plotScissor.h > 0) {
    const hasAbove = referenceLineAboveCount > 0 || markerAboveCount > 0;
    if (hasAbove) {
      const firstLine = referenceLineBelowCount;
      const firstMarker = markerBelowCount;
      overlayPass.setScissorRect(
        plotScissor.x,
        plotScissor.y,
        plotScissor.w,
        plotScissor.h,
      );
      if (referenceLineAboveCount > 0) {
        annotationRenderers.referenceLineRendererMsaa.render(
          overlayPass,
          firstLine,
          referenceLineAboveCount,
        );
      }
      if (markerAboveCount > 0) {
        annotationRenderers.annotationMarkerRendererMsaa.render(
          overlayPass,
          firstMarker,
          markerAboveCount,
        );
      }
      overlayPass.setScissorRect(
        0,
        0,
        gridArea.canvasWidth,
        gridArea.canvasHeight,
      );
    }
  }
}
