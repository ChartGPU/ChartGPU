/**
 * Series Rendering Utilities
 *
 * Prepares and renders all chart series types (area, line, bar, scatter, candlestick, pie).
 * Handles intro animations, GPU buffer management, and multi-pass rendering with proper layering.
 *
 * @module renderSeries
 */

import type { ResolvedChartGPUOptions, ResolvedSeriesConfig, ResolvedBarSeriesConfig, ResolvedAreaSeriesConfig, ResolvedPieSeriesConfig } from '../../../config/OptionResolver';
import type { DataPoint } from '../../../config/types';
import type { LinearScale } from '../../../utils/scales';
import type { GridArea } from '../../../renderers/createGridRenderer';
import type { LineRenderer } from '../../../renderers/createLineRenderer';
import type { AreaRenderer } from '../../../renderers/createAreaRenderer';
import type { BarRenderer } from '../../../renderers/createBarRenderer';
import type { ScatterRenderer } from '../../../renderers/createScatterRenderer';
import type { ScatterDensityRenderer } from '../../../renderers/createScatterDensityRenderer';
import type { PieRenderer } from '../../../renderers/createPieRenderer';
import type { CandlestickRenderer } from '../../../renderers/createCandlestickRenderer';
import type { ReferenceLineRenderer } from '../../../renderers/createReferenceLineRenderer';
import type { AnnotationMarkerRenderer } from '../../../renderers/createAnnotationMarkerRenderer';
import type { DataStore } from '../../../data/createDataStore';
import { isTupleDataPoint } from '../utils/dataPointUtils';
import { clampInt } from '../utils/canvasUtils';
import { clamp01 } from '../animation/animationHelpers';
import { findVisibleRangeIndicesByX } from '../data/computeVisibleSlice';
import { resolvePieRadiiCss } from '../utils/timeAxisUtils';

export interface SeriesRenderers {
  lineRenderers: LineRenderer[];
  areaRenderers: AreaRenderer[];
  barRenderer: BarRenderer;
  scatterRenderers: ScatterRenderer[];
  scatterDensityRenderers: ScatterDensityRenderer[];
  pieRenderers: PieRenderer[];
  candlestickRenderers: CandlestickRenderer[];
}

export interface AnnotationRenderers {
  referenceLineRenderer: ReferenceLineRenderer;
  referenceLineRendererMsaa: ReferenceLineRenderer;
  annotationMarkerRenderer: AnnotationMarkerRenderer;
  annotationMarkerRendererMsaa: AnnotationMarkerRenderer;
}

export interface SeriesPrepareContext {
  currentOptions: ResolvedChartGPUOptions;
  seriesForRender: ReadonlyArray<ResolvedSeriesConfig>;
  xScale: LinearScale;
  yScale: LinearScale;
  gridArea: GridArea;
  dataStore: DataStore;
  appendedGpuThisFrame: Set<number>;
  gpuSeriesKindByIndex: Array<'fullRawLine' | 'other' | 'unknown'>;
  zoomState: { getRange(): { start: number; end: number } | null } | null;
  visibleXDomain: { min: number; max: number };
  introPhase: 'pending' | 'running' | 'done';
  introProgress01: number;
  withAlpha: (color: string, alpha: number) => string;
  maxRadiusCss: number;
}

export interface SeriesRenderContext {
  hasCartesianSeries: boolean;
  gridArea: GridArea;
  mainPass: GPURenderPassEncoder;
  plotScissor: { x: number; y: number; w: number; h: number };
  introPhase: 'pending' | 'running' | 'done';
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
  visibleSeriesForRender: ReadonlyArray<{ series: ResolvedSeriesConfig; originalIndex: number }>;
  barSeriesConfigs: ResolvedBarSeriesConfig[];
  visibleBarSeriesConfigs: ResolvedBarSeriesConfig[];
}

/**
 * Helper: determines if an area should be rendered for a series.
 * Line series with areaStyle should render as area.
 */
function shouldRenderArea(series: ResolvedSeriesConfig): boolean {
  return series.type === 'area' || (series.type === 'line' && !!series.areaStyle);
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
  context: SeriesPrepareContext
): SeriesPreparationResult {
  const {
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
  } = context;

  const defaultBaseline = currentOptions.yAxis.min ?? (currentOptions.yAxis.min ?? 0);
  const barSeriesConfigs: ResolvedBarSeriesConfig[] = [];

  const introP = introPhase === 'running' ? clamp01(introProgress01) : 1;

  // Preparation loop: prepare ALL series (including hidden) to maintain correct indices
  for (let i = 0; i < seriesForRender.length; i++) {
    const s = seriesForRender[i];
    switch (s.type) {
      case 'area': {
        const baseline = s.baseline ?? defaultBaseline;
        // TODO(step 2): normalize CartesianSeriesData to ReadonlyArray<DataPoint>
        renderers.areaRenderers[i].prepare(s, s.data as ReadonlyArray<DataPoint>, xScale, yScale, baseline);
        break;
      }
      case 'line': {
        // Always prepare the line stroke.
        // If we already appended into the DataStore this frame (fast-path), avoid a full re-upload.
        // For time axes (epoch-ms), subtract an x-origin before packing to Float32 to avoid precision loss
        // (Float32 ulp at ~1e12 is ~2e5), which can manifest as stroke shimmer during zoom.
        const xOffset = (() => {
          if (currentOptions.xAxis.type !== 'time') return 0;
          // TODO(step 2): normalize CartesianSeriesData to ReadonlyArray<DataPoint>
          const d = s.data as ReadonlyArray<DataPoint>;
          for (let k = 0; k < d.length; k++) {
            const p = d[k]!
            const x = isTupleDataPoint(p) ? p[0] : p.x;
            if (Number.isFinite(x)) return x;
          }
          return 0;
        })();
        if (!appendedGpuThisFrame.has(i)) {
          // TODO(step 2): normalize CartesianSeriesData to ReadonlyArray<DataPoint>
          dataStore.setSeries(i, s.data as ReadonlyArray<DataPoint>, { xOffset });
        }
        const buffer = dataStore.getSeriesBuffer(i);
        renderers.lineRenderers[i].prepare(s, buffer, xScale, yScale, xOffset);

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

          // TODO(step 2): normalize CartesianSeriesData to ReadonlyArray<DataPoint>
          renderers.areaRenderers[i].prepare(areaLike, areaLike.data as ReadonlyArray<DataPoint>, xScale, yScale, defaultBaseline);
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
          // TODO(step 2): normalize CartesianSeriesData to ReadonlyArray<DataPoint>
          const rawData = (s.rawData ?? s.data) as ReadonlyArray<DataPoint>;
          const visible = findVisibleRangeIndicesByX(rawData, visibleXDomain.min, visibleXDomain.max);

          // Upload full raw data for compute. DataStore hashing makes this a cheap no-op when unchanged.
          if (!appendedGpuThisFrame.has(i)) {
            dataStore.setSeries(i, rawData);
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
            yScale,
            gridArea,
            s.rawBounds
          );
          // Density mode keeps its own compute path; treat as non-fast-path for append heuristics.
          gpuSeriesKindByIndex[i] = 'other';
        } else {
          const animated = introP < 1 ? ({ ...s, color: withAlpha(s.color, introP) } as const) : s;
          // TODO(step 2): normalize CartesianSeriesData to ReadonlyArray<DataPoint>
          renderers.scatterRenderers[i].prepare(animated, s.data as ReadonlyArray<DataPoint>, xScale, yScale, gridArea);
        }
        break;
      }
      case 'pie': {
        // Pie renderer sets/resets its own scissor. Animate intro via radius scale (CSS px).
        if (introP < 1 && maxRadiusCss > 0) {
          const radiiCss = resolvePieRadiiCss(s.radius, maxRadiusCss);
          const inner = Math.max(0, radiiCss.inner) * introP;
          const outer = Math.max(inner, radiiCss.outer) * introP;
          const animated: ResolvedPieSeriesConfig = { ...s, radius: [inner, outer] as const };
          renderers.pieRenderers[i].prepare(animated, gridArea);
          break;
        }
        renderers.pieRenderers[i].prepare(s, gridArea);
        break;
      }
      case 'candlestick': {
        // Candlestick renderer handles clipping internally, no intro animation for now.
        renderers.candlestickRenderers[i].prepare(s, s.data, xScale, yScale, gridArea, currentOptions.theme.backgroundColor);
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
  const visibleBarSeriesConfigs = barSeriesConfigs.filter(s => s.visible !== false);

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
  encoder: GPUCommandEncoder
): void {
  for (let i = 0; i < seriesForRender.length; i++) {
    const s = seriesForRender[i];
    if (s.visible !== false && s.type === 'scatter' && s.mode === 'density') {
      renderers.scatterDensityRenderers[i].encodeCompute(encoder);
    }
  }
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
  prepResult: SeriesPreparationResult
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
  const introP = introPhase === 'running' ? clamp01(introProgress01) : 1;

  // Render pies first (non-cartesian, visible behind cartesian series)
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (series.type === 'pie') {
      renderers.pieRenderers[originalIndex].render(mainPass);
    }
  }

  // Annotations (below series): clipped to plot scissor.
  if (hasCartesianSeries && plotScissor.w > 0 && plotScissor.h > 0) {
    const hasBelow = referenceLineBelowCount > 0 || markerBelowCount > 0;
    if (hasBelow) {
      mainPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
      if (referenceLineBelowCount > 0) {
        annotationRenderers.referenceLineRenderer.render(mainPass, 0, referenceLineBelowCount);
      }
      if (markerBelowCount > 0) {
        annotationRenderers.annotationMarkerRenderer.render(mainPass, 0, markerBelowCount);
      }
      mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
    }
  }

  // Render area fills
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (shouldRenderArea(series)) {
      // Line/area intro reveal: left-to-right plot scissor.
      if (introP < 1) {
        const w = clampInt(Math.floor(plotScissor.w * introP), 0, plotScissor.w);
        if (w > 0 && plotScissor.h > 0) {
          mainPass.setScissorRect(plotScissor.x, plotScissor.y, w, plotScissor.h);
          renderers.areaRenderers[originalIndex].render(mainPass);
          mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
        }
      } else {
        mainPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
        renderers.areaRenderers[originalIndex].render(mainPass);
        mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
      }
    }
  }

  // Clip bars to the plot grid (mirrors area/line scissor usage).
  if (plotScissor.w > 0 && plotScissor.h > 0) {
    mainPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
    renderers.barRenderer.render(mainPass);
    mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
  }

  // Render candlesticks
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (series.type === 'candlestick') {
      renderers.candlestickRenderers[originalIndex].render(mainPass);
    }
  }

  // Render scatter points
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (series.type !== 'scatter') continue;
    if (series.mode === 'density') {
      renderers.scatterDensityRenderers[originalIndex].render(mainPass);
    } else {
      renderers.scatterRenderers[originalIndex].render(mainPass);
    }
  }

  // Render line strokes
  for (let idx = 0; idx < visibleSeriesForRender.length; idx++) {
    const { series, originalIndex } = visibleSeriesForRender[idx];
    if (series.type === 'line') {
      // Line intro reveal: left-to-right plot scissor.
      if (introP < 1) {
        const w = clampInt(Math.floor(plotScissor.w * introP), 0, plotScissor.w);
        if (w > 0 && plotScissor.h > 0) {
          mainPass.setScissorRect(plotScissor.x, plotScissor.y, w, plotScissor.h);
          renderers.lineRenderers[originalIndex].render(mainPass);
          mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
        }
      } else {
        mainPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
        renderers.lineRenderers[originalIndex].render(mainPass);
        mainPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
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
  context: AboveSeriesAnnotationContext
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
      overlayPass.setScissorRect(plotScissor.x, plotScissor.y, plotScissor.w, plotScissor.h);
      if (referenceLineAboveCount > 0) {
        annotationRenderers.referenceLineRendererMsaa.render(overlayPass, firstLine, referenceLineAboveCount);
      }
      if (markerAboveCount > 0) {
        annotationRenderers.annotationMarkerRendererMsaa.render(overlayPass, firstMarker, markerAboveCount);
      }
      overlayPass.setScissorRect(0, 0, gridArea.canvasWidth, gridArea.canvasHeight);
    }
  }
}
