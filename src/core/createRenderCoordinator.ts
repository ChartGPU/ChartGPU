import type { ResolvedAreaSeriesConfig, ResolvedBarSeriesConfig, ResolvedChartGPUOptions } from '../config/OptionResolver';
import type { DataPoint, DataPointTuple } from '../config/types';
import { createDataStore } from '../data/createDataStore';
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
import { findNearestPoint } from '../interaction/findNearestPoint';
import { findPointsAtX } from '../interaction/findPointsAtX';
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

const assertUnreachable = (value: never): never => {
  // Intentionally minimal message: this is used for compile-time exhaustiveness.
  throw new Error(`RenderCoordinator: unreachable value: ${String(value)}`);
};

const isTupleDataPoint = (p: DataPoint): p is DataPointTuple => Array.isArray(p);

const getPointXY = (p: DataPoint): { readonly x: number; readonly y: number } => {
  if (isTupleDataPoint(p)) return { x: p[0], y: p[1] };
  return { x: p.x, y: p.y };
};

const computeGlobalBounds = (series: ResolvedChartGPUOptions['series']): Bounds => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const seriesConfig = series[s];
    // Pie series are non-cartesian; they don't participate in x/y bounds.
    if (seriesConfig.type === 'pie') continue;

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

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

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

const computeScales = (
  options: ResolvedChartGPUOptions,
  gridArea: GridArea
): { readonly xScale: LinearScale; readonly yScale: LinearScale } => {
  const clipRect = computePlotClipRect(gridArea);
  const bounds = computeGlobalBounds(options.series);

  const xMin = options.xAxis.min ?? bounds.xMin;
  const xMax = options.xAxis.max ?? bounds.xMax;
  const yMin = options.yAxis.min ?? bounds.yMin;
  const yMax = options.yAxis.max ?? bounds.yMax;

  const xDomain = normalizeDomain(xMin, xMax);
  const yDomain = normalizeDomain(yMin, yMax);

  const xScale = createLinearScale().domain(xDomain.min, xDomain.max).range(clipRect.left, clipRect.right);
  const yScale = createLinearScale().domain(yDomain.min, yDomain.max).range(clipRect.bottom, clipRect.top);

  return { xScale, yScale };
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
    gridArea: GridArea
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

    const bounds = computeGlobalBounds(currentOptions.series);

    const xMin = currentOptions.xAxis.min ?? bounds.xMin;
    const xMax = currentOptions.xAxis.max ?? bounds.xMax;
    const yMin = currentOptions.yAxis.min ?? bounds.yMin;
    const yMax = currentOptions.yAxis.max ?? bounds.yMax;

    const xDomain = normalizeDomain(xMin, xMax);
    const yDomain = normalizeDomain(yMin, yMax);

    // IMPORTANT: grid-local CSS px ranges (0..plotWidth/Height), for interaction hit-testing.
    const xScale = createLinearScale().domain(xDomain.min, xDomain.max).range(0, plotSize.plotWidthCss);
    const yScale = createLinearScale().domain(yDomain.min, yDomain.max).range(plotSize.plotHeightCss, 0);

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

  const setOptions: RenderCoordinator['setOptions'] = (resolvedOptions) => {
    assertNotDisposed();
    currentOptions = resolvedOptions;
    legend?.update(resolvedOptions.series, resolvedOptions.theme);

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
      default:
        return assertUnreachable(series);
    }
  };

  const render: RenderCoordinator['render'] = () => {
    assertNotDisposed();
    if (!gpuContext.canvasContext || !gpuContext.canvas) return;

    const gridArea = computeGridArea(gpuContext, currentOptions);
    eventManager.updateGridArea(gridArea);
    const { xScale, yScale } = computeScales(currentOptions, gridArea);
    const plotClipRect = computePlotClipRect(gridArea);

    const interactionScales = computeInteractionScalesGridCssPx(gridArea);
    lastInteractionScales = interactionScales;

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
          currentOptions.series,
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
          const matches = findPointsAtX(currentOptions.series, effectivePointer.gridX, interactionScales.xScale);
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
          const matches = findPointsAtX(currentOptions.series, effectivePointer.gridX, interactionScales.xScale);
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
        } else {
          const match = findNearestPoint(
            currentOptions.series,
            effectivePointer.gridX,
            effectivePointer.gridY,
            interactionScales.xScale,
            interactionScales.yScale
          );
          if (!match) {
            tooltip.hide();
          } else {
            const params = buildTooltipParams(match.seriesIndex, match.dataIndex, match.point);
            const content = formatter ? (formatter as (p: TooltipParams) => string)(params) : formatTooltipItem(params);
            if (content) tooltip.show(containerX, containerY, content);
            else tooltip.hide();
          }
        }
      } else {
        tooltip.hide();
      }
    } else {
      tooltip?.hide();
    }

    const globalBounds = computeGlobalBounds(currentOptions.series);
    const defaultBaseline = currentOptions.yAxis.min ?? globalBounds.yMin;
    const barSeriesConfigs: ResolvedBarSeriesConfig[] = [];

    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i];
      switch (s.type) {
        case 'area': {
          const baseline = s.baseline ?? defaultBaseline;
          areaRenderers[i].prepare(s, s.data, xScale, yScale, baseline);
          break;
        }
        case 'line': {
          // Always prepare the line stroke.
          dataStore.setSeries(i, s.data);
          const buffer = dataStore.getSeriesBuffer(i);
          lineRenderers[i].prepare(s, buffer, xScale, yScale);

          // If `areaStyle` is provided on a line series, render a fill behind it.
          if (s.areaStyle) {
            const areaLike: ResolvedAreaSeriesConfig = {
              type: 'area',
              name: s.name,
              data: s.data,
              color: s.color,
              areaStyle: s.areaStyle,
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
          scatterRenderers[i].prepare(s, s.data, xScale, yScale, gridArea);
          break;
        }
        case 'pie': {
          pieRenderers[i].prepare(s, gridArea);
          break;
        }
        default:
          assertUnreachable(s);
      }
    }

    // Bars are prepared once and rendered via a single instanced draw call.
    barRenderer.prepare(barSeriesConfigs, dataStore, xScale, yScale, gridArea);

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

    for (let i = 0; i < currentOptions.series.length; i++) {
      if (currentOptions.series[i].type === 'pie') {
        pieRenderers[i].render(pass);
      }
    }

    for (let i = 0; i < currentOptions.series.length; i++) {
      if (shouldRenderArea(currentOptions.series[i])) {
        areaRenderers[i].render(pass);
      }
    }
    barRenderer.render(pass);
    for (let i = 0; i < currentOptions.series.length; i++) {
      if (currentOptions.series[i].type === 'scatter') {
        scatterRenderers[i].render(pass);
      }
    }
    for (let i = 0; i < currentOptions.series.length; i++) {
      if (currentOptions.series[i].type === 'line') {
        lineRenderers[i].render(pass);
      }
    }

    highlightRenderer.render(pass);
    xAxisRenderer.render(pass);
    yAxisRenderer.render(pass);
    crosshairRenderer.render(pass);

    pass.end();
    device.queue.submit([encoder.finish()]);

    if (overlay && overlayContainer) {
      const canvas = gpuContext.canvas;
      // IMPORTANT: overlay positioning must be done in *CSS pixels* and in the overlayContainer's
      // coordinate space (its padding box). Using `canvas.width / dpr` + `getBoundingClientRect()`
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

  return { setOptions, getInteractionX, setInteractionX, onInteractionXChange, render, dispose };
}

