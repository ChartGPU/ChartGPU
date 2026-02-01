import { GPUContext } from './core/GPUContext';
import { createRenderCoordinator } from './core/createRenderCoordinator';
import type { RenderCoordinator } from './core/createRenderCoordinator';
import { resolveOptionsForChart } from './config/OptionResolver';
import type { ResolvedCandlestickSeriesConfig, ResolvedChartGPUOptions, ResolvedPieSeriesConfig } from './config/OptionResolver';
import type { ChartGPUOptions, DataPoint, DataPointTuple, OHLCDataPoint, OHLCDataPointTuple, PieCenter, PieRadius } from './config/types';
import { createDataZoomSlider } from './components/createDataZoomSlider';
import type { DataZoomSlider } from './components/createDataZoomSlider';
import type { ZoomRange, ZoomState } from './interaction/createZoomState';
import { computeCandlestickBodyWidthRange, findCandlestick } from './interaction/findCandlestick';
import { findNearestPoint } from './interaction/findNearestPoint';
import type { NearestPointMatch } from './interaction/findNearestPoint';
import { findPieSlice } from './interaction/findPieSlice';
import { createLinearScale } from './utils/scales';
import type { LinearScale } from './utils/scales';
import { checkWebGPUSupport } from './utils/checkWebGPU';
import type {
  PerformanceMetrics,
  PerformanceCapabilities,
  ExactFPS,
  Milliseconds,
  Bytes,
  FrameTimeStats,
  GPUTimingStats,
  MemoryStats,
  FrameDropStats,
} from './config/types';

/**
 * Circular buffer size for frame timestamps (120 frames = 2 seconds at 60fps).
 */
const FRAME_BUFFER_SIZE = 120;

/**
 * Expected frame time at 60fps (16.67ms).
 */
const EXPECTED_FRAME_TIME_MS = 1000 / 60;

/**
 * Frame drop threshold multiplier (1.5x expected frame time).
 */
const FRAME_DROP_THRESHOLD_MULTIPLIER = 1.5;

/**
 * Hit-test match for a chart element.
 */
export type ChartGPUHitTestMatch = Readonly<{
  readonly kind: 'cartesian' | 'candlestick' | 'pie';
  readonly seriesIndex: number;
  readonly dataIndex: number;
  readonly value: readonly [number, number];
}>;

/**
 * Result of a hit-test operation on a chart.
 */
export type ChartGPUHitTestResult = Readonly<{
  readonly isInGrid: boolean;
  readonly canvasX: number;
  readonly canvasY: number;
  readonly gridX: number;
  readonly gridY: number;
  readonly match: ChartGPUHitTestMatch | null;
}>;

export interface ChartGPUInstance {
  readonly options: Readonly<ChartGPUOptions>;
  readonly disposed: boolean;
  setOption(options: ChartGPUOptions): void;
  /**
   * Appends new points to a cartesian series at runtime (streaming).
   *
   * For candlestick series, pass `OHLCDataPoint[]`.
   * For other cartesian series (line, area, bar, scatter), pass `DataPoint[]`.
   * Pie series are non-cartesian and are not supported by streaming append.
   */
  appendData(seriesIndex: number, newPoints: DataPoint[] | OHLCDataPoint[]): void;
  resize(): void;
  dispose(): void;
  on(eventName: 'crosshairMove', callback: ChartGPUCrosshairMoveCallback): void;
  on(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void;
  off(eventName: 'crosshairMove', callback: ChartGPUCrosshairMoveCallback): void;
  off(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void;
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
   * Alias for `setInteractionX(...)` for chart sync semantics.
   */
  setCrosshairX(x: number | null, source?: unknown): void;
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
   * Gets the latest performance metrics.
   * Returns exact FPS and detailed frame statistics.
   * 
   * @returns Current performance metrics, or null if not available
   */
  getPerformanceMetrics(): Readonly<PerformanceMetrics> | null;
  /**
   * Gets the performance capabilities of the current environment.
   * Indicates which performance features are supported.
   * 
   * @returns Performance capabilities, or null if not initialized
   */
  getPerformanceCapabilities(): Readonly<PerformanceCapabilities> | null;
  /**
   * Registers a callback to be notified of performance metric updates.
   * Callback is invoked every frame with the latest metrics.
   * 
   * @param callback - Function to call with updated metrics
   * @returns Unsubscribe function to remove the callback
   */
  onPerformanceUpdate(callback: (metrics: Readonly<PerformanceMetrics>) => void): () => void;
  /**
   * Performs hit-testing on a pointer or mouse event.
   *
   * Returns coordinates and matched chart element (if any).
   * Accepts both `PointerEvent` (for hover/click) and `MouseEvent` (for contextmenu/right-click).
   *
   * @param e - Pointer or mouse event to test
   * @returns Hit-test result with coordinates and optional match
   */
  hitTest(e: PointerEvent | MouseEvent): ChartGPUHitTestResult;
}

// Type-only alias so callsites can write `ChartGPU[]` for chart instances (while `ChartGPU` the value
// remains the creation API exported from `src/index.ts`).
export type ChartGPU = ChartGPUInstance;

export type ChartGPUEventName = 'click' | 'mouseover' | 'mouseout' | 'crosshairMove';

export type ChartGPUEventPayload = Readonly<{
  readonly seriesIndex: number | null;
  readonly dataIndex: number | null;
  readonly value: readonly [number, number] | null;
  readonly seriesName: string | null;
  readonly event: PointerEvent;
}>;

export type ChartGPUCrosshairMovePayload = Readonly<{
  readonly x: number | null;
  readonly source?: unknown;
}>;

export type ChartGPUEventCallback = (payload: ChartGPUEventPayload) => void;

export type ChartGPUCrosshairMoveCallback = (payload: ChartGPUCrosshairMovePayload) => void;

type AnyChartGPUEventCallback = ChartGPUEventCallback | ChartGPUCrosshairMoveCallback;

type ListenerRegistry = Readonly<Record<ChartGPUEventName, Set<AnyChartGPUEventCallback>>>;

type TapCandidate = {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startTimeMs: number;
};

const DEFAULT_TAP_MAX_DISTANCE_CSS_PX = 6;
const DEFAULT_TAP_MAX_TIME_MS = 500;

type Bounds = Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;

const isTupleDataPoint = (p: DataPoint): p is DataPointTuple => Array.isArray(p);
const isTupleOHLCDataPoint = (p: OHLCDataPoint): p is OHLCDataPointTuple => Array.isArray(p);

const getPointXY = (p: DataPoint): { readonly x: number; readonly y: number } => {
  if (isTupleDataPoint(p)) return { x: p[0], y: p[1] };
  return { x: p.x, y: p.y };
};

const getOHLCTimestamp = (p: OHLCDataPoint): number => (isTupleOHLCDataPoint(p) ? p[0] : p.timestamp);
const getOHLCClose = (p: OHLCDataPoint): number => (isTupleOHLCDataPoint(p) ? p[2] : p.close);

const hasSliderDataZoom = (options: ChartGPUOptions): boolean => options.dataZoom?.some((z) => z?.type === 'slider') ?? false;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

type InteractionScalesCache = {
  rectWidthCss: number;
  rectHeightCss: number;
  plotWidthCss: number;
  plotHeightCss: number;
  xDomainMin: number;
  xDomainMax: number;
  yDomainMin: number;
  yDomainMax: number;
  xScale: LinearScale;
  yScale: LinearScale;
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
    const timestamp = getOHLCTimestamp(p);
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
    const seriesConfig = series[s]!;
    // Pie series are non-cartesian; they don't participate in x/y bounds.
    if (seriesConfig.type === 'pie') continue;

    // Prefer the chart-owned runtime bounds (kept up to date by appendData()).
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

    // Prefer resolver-provided bounds when available (avoids O(n) scans on initial setOption()).
    // (Resolved series types include `rawBounds` for cartesian series; keep this defensive.)
    const rawBoundsCandidate = (seriesConfig as unknown as { rawBounds?: Bounds | null }).rawBounds ?? null;
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

    const data = seriesConfig.data as ReadonlyArray<DataPoint>;
    for (let i = 0; i < data.length; i++) {
      const { x, y } = getPointXY(data[i]!);
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

type CartesianHitTestMatch = Readonly<{
  kind: 'cartesian';
  match: NearestPointMatch;
}>;

type PieHitTestMatch = Readonly<{
  kind: 'pie';
  seriesIndex: number;
  dataIndex: number;
  sliceValue: number;
}>;

type CandlestickHitTestMatch = Readonly<{
  kind: 'candlestick';
  seriesIndex: number;
  dataIndex: number;
  point: OHLCDataPoint;
}>;

type HitTestMatch = CartesianHitTestMatch | PieHitTestMatch | CandlestickHitTestMatch;

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

  // Be permissive: allow numeric strings like "120" even though the public type primarily documents percent strings.
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

const isPieRadiusTuple = (radius: PieRadius): radius is readonly [inner: number | string, outer: number | string] =>
  Array.isArray(radius);

const resolvePieRadiiCss = (
  radius: PieRadius | undefined,
  maxRadiusCss: number
): { readonly inner: number; readonly outer: number } => {
  // Default similar to common chart libs (mirrors `createPieRenderer.ts` and coordinator helpers).
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

export async function createChartGPU(
  container: HTMLElement,
  options: ChartGPUOptions
): Promise<ChartGPUInstance> {
  // Check WebGPU support before creating canvas or any resources
  const supportCheck = await checkWebGPUSupport();
  if (!supportCheck.supported) {
    const reason = supportCheck.reason || 'Unknown reason';
    throw new Error(
      `ChartGPU: WebGPU is not available.\n` +
      `Reason: ${reason}\n` +
      `Browser support: Chrome/Edge 113+, Safari 18+, Firefox not yet supported.\n` +
      `Resources:\n` +
      `  - MDN WebGPU API: https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API\n` +
      `  - Browser compatibility: https://caniuse.com/webgpu\n` +
      `  - WebGPU specification: https://www.w3.org/TR/webgpu/\n` +
      `  - Check your system: https://webgpureport.org/`
    );
  }

  const canvas = document.createElement('canvas');

  // Ensure the canvas participates in layout and can size via the container.
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  // Append before awaiting so it appears immediately and has measurable size.
  container.appendChild(canvas);

  let disposed = false;
  let gpuContext: GPUContext | null = null;
  let coordinator: RenderCoordinator | null = null;
  let coordinatorTargetFormat: GPUTextureFormat | null = null;
  let unsubscribeCoordinatorInteractionXChange: (() => void) | null = null;

  let dataZoomSliderHost: HTMLDivElement | null = null;
  let dataZoomSlider: DataZoomSlider | null = null;

  let currentOptions: ChartGPUOptions = options;
  let resolvedOptions: ResolvedChartGPUOptions = resolveOptionsForChart(currentOptions);

  // Chart-owned runtime series store for hit-testing only (cartesian only).
  // - `runtimeRawDataByIndex[i]` is a mutable array used to reflect streaming appends.
  // - `runtimeRawBoundsByIndex[i]` is incrementally updated to keep scale/bounds derivation cheap.
  let runtimeRawDataByIndex: Array<DataPoint[] | OHLCDataPoint[]> = new Array(resolvedOptions.series.length).fill(null).map(() => []);
  let runtimeRawBoundsByIndex: Array<Bounds | null> = new Array(resolvedOptions.series.length).fill(null);
  let runtimeHitTestSeriesCache: ResolvedChartGPUOptions['series'] | null = null;
  let runtimeHitTestSeriesVersion = 0;

  const initRuntimeHitTestStoreFromResolvedOptions = (): void => {
    runtimeRawDataByIndex = new Array(resolvedOptions.series.length).fill(null).map(() => []);
    runtimeRawBoundsByIndex = new Array(resolvedOptions.series.length).fill(null);
    runtimeHitTestSeriesCache = null;
    runtimeHitTestSeriesVersion++;

    for (let i = 0; i < resolvedOptions.series.length; i++) {
      const s = resolvedOptions.series[i]!;
      if (s.type === 'pie') continue;

      if (s.type === 'candlestick') {
        const raw = ((s as unknown as { rawData?: ReadonlyArray<OHLCDataPoint> }).rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>;
        runtimeRawDataByIndex[i] = raw.length === 0 ? [] : raw.slice();
        runtimeRawBoundsByIndex[i] = ((s as unknown as { rawBounds?: Bounds | null }).rawBounds ?? null);
      } else {
        const raw = ((s as unknown as { rawData?: ReadonlyArray<DataPoint> }).rawData ?? s.data) as ReadonlyArray<DataPoint>;
        runtimeRawDataByIndex[i] = raw.length === 0 ? [] : raw.slice();
        runtimeRawBoundsByIndex[i] = ((s as unknown as { rawBounds?: Bounds | null }).rawBounds ?? null) ?? computeRawBoundsFromData(raw);
      }
    }
  };

  const getRuntimeHitTestSeries = (): ResolvedChartGPUOptions['series'] => {
    if (runtimeHitTestSeriesCache) return runtimeHitTestSeriesCache;
    // Replace cartesian series `data` with chart-owned runtime data (pie series are unchanged).
    runtimeHitTestSeriesCache = resolvedOptions.series.map((s, i) => {
      if (s.type === 'pie') return s;
      if (s.type === 'candlestick') {
        return { ...s, data: runtimeRawDataByIndex[i] ?? (s.data as ReadonlyArray<OHLCDataPoint>) };
      }
      return { ...s, data: runtimeRawDataByIndex[i] ?? (s.data as ReadonlyArray<DataPoint>) };
    }) as ResolvedChartGPUOptions['series'];
    return runtimeHitTestSeriesCache;
  };

  initRuntimeHitTestStoreFromResolvedOptions();

  // Cache global bounds and interaction scales; avoids O(N) data scans per pointer move.
  let cachedGlobalBounds: Bounds = computeGlobalBounds(resolvedOptions.series, runtimeRawBoundsByIndex);
  let interactionScalesCache: InteractionScalesCache | null = null;

  const listeners: ListenerRegistry = {
    click: new Set<ChartGPUEventCallback>(),
    mouseover: new Set<ChartGPUEventCallback>(),
    mouseout: new Set<ChartGPUEventCallback>(),
    crosshairMove: new Set<ChartGPUCrosshairMoveCallback>(),
  };

  let tapCandidate: TapCandidate | null = null;
  let suppressNextLostPointerCaptureId: number | null = null;

  let hovered: HitTestMatch | null = null;

  // Prevent spamming console.warn for repeated misuse.
  const warnedPieAppendSeries = new Set<number>();

  let scheduledRaf: number | null = null;
  let lastConfigured: { width: number; height: number; format: GPUTextureFormat } | null = null;
  let isDirty = true;

  // Performance tracking state
  const frameTimestamps = new Float64Array(FRAME_BUFFER_SIZE);
  let frameTimestampIndex = 0;
  let frameTimestampCount = 0;
  let totalFrames = 0;
  let totalDroppedFrames = 0;
  let consecutiveDroppedFrames = 0;
  let lastDropTimestamp = 0;
  const startTime = performance.now();
  let lastFrameTime = 0;
  let lastCPUTime = 0;
  const performanceUpdateCallbacks = new Set<(metrics: Readonly<PerformanceMetrics>) => void>();

  const hasHoverListeners = (): boolean => listeners.mouseover.size > 0 || listeners.mouseout.size > 0;
  const hasClickListeners = (): boolean => listeners.click.size > 0;

  const cancelPendingFrame = (): void => {
    if (scheduledRaf === null) return;
    cancelAnimationFrame(scheduledRaf);
    scheduledRaf = null;
  };

  const requestRender = (): void => {
    if (disposed) return;
    isDirty = true;
    if (scheduledRaf !== null) return;

    scheduledRaf = requestAnimationFrame(() => {
      scheduledRaf = null;
      if (disposed) return;

      // Record frame timestamp BEFORE rendering
      const frameStartTime = performance.now();
      frameTimestamps[frameTimestampIndex] = frameStartTime;
      frameTimestampIndex = (frameTimestampIndex + 1) % FRAME_BUFFER_SIZE;
      if (frameTimestampCount < FRAME_BUFFER_SIZE) {
        frameTimestampCount++;
      }
      totalFrames++;

      // Frame drop detection (only after first frame)
      if (lastFrameTime > 0) {
        const deltaTime = frameStartTime - lastFrameTime;
        if (deltaTime > EXPECTED_FRAME_TIME_MS * FRAME_DROP_THRESHOLD_MULTIPLIER) {
          totalDroppedFrames++;
          consecutiveDroppedFrames++;
          lastDropTimestamp = frameStartTime;
        } else {
          // Reset consecutive counter on successful frame
          consecutiveDroppedFrames = 0;
        }
      }
      lastFrameTime = frameStartTime;

      // Requirement: on RAF tick, call resize() first.
      resizeInternal(false);
      
      if (isDirty) {
        isDirty = false;
        coordinator?.render();
      }

      const frameEndTime = performance.now();
      lastCPUTime = frameEndTime - frameStartTime;

      // Calculate and emit performance metrics
      const metrics = calculatePerformanceMetrics();
      for (const callback of performanceUpdateCallbacks) {
        try {
          callback(metrics);
        } catch (error) {
          console.error('Error in performance update callback:', error);
        }
      }
    });
  };

  const unbindCoordinatorInteractionXChange = (): void => {
    if (!unsubscribeCoordinatorInteractionXChange) return;
    try {
      unsubscribeCoordinatorInteractionXChange();
    } finally {
      unsubscribeCoordinatorInteractionXChange = null;
    }
  };

  const disposeDataZoomSlider = (): void => {
    dataZoomSlider?.dispose();
    dataZoomSlider = null;
  };

  const disposeDataZoomSliderHost = (): void => {
    dataZoomSliderHost?.remove();
    dataZoomSliderHost = null;
  };

  const disposeDataZoomUi = (): void => {
    disposeDataZoomSlider();
    disposeDataZoomSliderHost();
  };

  const DATA_ZOOM_SLIDER_HEIGHT_CSS_PX = 32;
  const DATA_ZOOM_SLIDER_MARGIN_TOP_CSS_PX = 8;
  const DATA_ZOOM_SLIDER_RESERVE_CSS_PX = DATA_ZOOM_SLIDER_HEIGHT_CSS_PX + DATA_ZOOM_SLIDER_MARGIN_TOP_CSS_PX;

  const ensureDataZoomSliderHost = (): HTMLDivElement => {
    if (dataZoomSliderHost) return dataZoomSliderHost;

    // Ensure the host's absolute positioning is anchored to the chart container.
    // If the container is already positioned, avoid overwriting user styles.
    try {
      const pos = window.getComputedStyle(container).position;
      if (pos === 'static') container.style.position = 'relative';
    } catch {
      // best-effort
    }

    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.left = '0';
    host.style.right = '0';
    host.style.bottom = '0';
    host.style.height = `${DATA_ZOOM_SLIDER_RESERVE_CSS_PX}px`;
    host.style.paddingTop = `${DATA_ZOOM_SLIDER_MARGIN_TOP_CSS_PX}px`;
    host.style.boxSizing = 'border-box';
    host.style.pointerEvents = 'auto';
    host.style.zIndex = '5';
    container.appendChild(host);
    dataZoomSliderHost = host;
    return host;
  };

  const computeZoomInOutAnchorRatio = (range: ZoomRange, center: number): number => {
    const span = range.end - range.start;
    if (!Number.isFinite(span) || span === 0) return 0.5;
    return clamp((center - range.start) / span, 0, 1);
  };

  const createCoordinatorZoomStateLike = (): ZoomState => {
    const getRange: ZoomState['getRange'] = () => coordinator?.getZoomRange() ?? { start: 0, end: 100 };
    const setRange: ZoomState['setRange'] = (start, end) => {
      coordinator?.setZoomRange(start, end);
    };
    const zoomIn: ZoomState['zoomIn'] = (center, factor) => {
      if (!Number.isFinite(center) || !Number.isFinite(factor) || factor <= 1) return;
      const r = coordinator?.getZoomRange();
      if (!r) return;
      const c = clamp(center, 0, 100);
      const ratio = computeZoomInOutAnchorRatio(r, c);
      const span = r.end - r.start;
      const nextSpan = span / factor;
      const nextStart = c - ratio * nextSpan;
      coordinator?.setZoomRange(nextStart, nextStart + nextSpan);
    };
    const zoomOut: ZoomState['zoomOut'] = (center, factor) => {
      if (!Number.isFinite(center) || !Number.isFinite(factor) || factor <= 1) return;
      const r = coordinator?.getZoomRange();
      if (!r) return;
      const c = clamp(center, 0, 100);
      const ratio = computeZoomInOutAnchorRatio(r, c);
      const span = r.end - r.start;
      const nextSpan = span * factor;
      const nextStart = c - ratio * nextSpan;
      coordinator?.setZoomRange(nextStart, nextStart + nextSpan);
    };
    const pan: ZoomState['pan'] = (delta) => {
      if (!Number.isFinite(delta)) return;
      const r = coordinator?.getZoomRange();
      if (!r) return;
      coordinator?.setZoomRange(r.start + delta, r.end + delta);
    };
    const onChange: ZoomState['onChange'] = (callback) => coordinator?.onZoomRangeChange(callback) ?? (() => {});

    return { getRange, setRange, zoomIn, zoomOut, pan, onChange };
  };

  const syncDataZoomUi = (): void => {
    const shouldHaveSlider = hasSliderDataZoom(currentOptions);
    if (!shouldHaveSlider) {
      disposeDataZoomUi();
      return;
    }

    // Slider requires a coordinator-backed zoom state.
    if (!coordinator) return;
    if (!coordinator.getZoomRange()) return;

    const host = ensureDataZoomSliderHost();
    if (!dataZoomSlider) {
      dataZoomSlider = createDataZoomSlider(host, createCoordinatorZoomStateLike(), {
        height: DATA_ZOOM_SLIDER_HEIGHT_CSS_PX,
        marginTop: 0, // host provides vertical spacing
      });
    }
    dataZoomSlider.update(resolvedOptions.theme);
  };

  const bindCoordinatorInteractionXChange = (): void => {
    unbindCoordinatorInteractionXChange();
    if (disposed) return;
    if (!coordinator) return;

    unsubscribeCoordinatorInteractionXChange = coordinator.onInteractionXChange((x, source) => {
      emit('crosshairMove', { x, source });
    });
  };

  const recreateCoordinator = (): void => {
    if (disposed) return;
    if (!gpuContext || !gpuContext.initialized) return;

    const prevZoomRange = coordinator?.getZoomRange() ?? null;

    unbindCoordinatorInteractionXChange();
    // Coordinator recreation invalidates zoom subscriptions; recreate the slider if present.
    disposeDataZoomSlider();
    coordinator?.dispose();
    coordinator = createRenderCoordinator(gpuContext, resolvedOptions, { onRequestRender: requestRender });
    coordinatorTargetFormat = gpuContext.preferredFormat;
    bindCoordinatorInteractionXChange();

    if (prevZoomRange) coordinator.setZoomRange(prevZoomRange.start, prevZoomRange.end);
    syncDataZoomUi();
  };

  const resizeInternal = (shouldRequestRenderAfterChanges: boolean): void => {
    if (disposed) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    const maxDimension = gpuContext?.device?.limits.maxTextureDimension2D ?? 8192;
    const width = Math.min(maxDimension, Math.max(1, Math.round(rect.width * dpr)));
    const height = Math.min(maxDimension, Math.max(1, Math.round(rect.height * dpr)));

    const sizeChanged = canvas.width !== width || canvas.height !== height;
    if (sizeChanged) {
      canvas.width = width;
      canvas.height = height;
    }

    const device = gpuContext?.device;
    const canvasContext = gpuContext?.canvasContext;
    const preferredFormat = gpuContext?.preferredFormat;

    let didConfigure = false;
    if (device && canvasContext && preferredFormat) {
      const shouldConfigure =
        sizeChanged ||
        !lastConfigured ||
        lastConfigured.width !== canvas.width ||
        lastConfigured.height !== canvas.height ||
        lastConfigured.format !== preferredFormat;

      if (shouldConfigure) {
        canvasContext.configure({
          device,
          format: preferredFormat,
          alphaMode: 'opaque',
        });
        lastConfigured = { width: canvas.width, height: canvas.height, format: preferredFormat };
        didConfigure = true;

        // Requirement: if the target format changes, recreate coordinator/pipelines.
        if (coordinator && coordinatorTargetFormat !== preferredFormat) {
          recreateCoordinator();
        }
      }
    }

    if (shouldRequestRenderAfterChanges && (sizeChanged || didConfigure)) {
      // Requirement: resize() requests a render after size/config changes.
      requestRender();
    }
  };

  const resize = (): void => resizeInternal(true);

  const getNearestPointFromPointerEvent = (
    e: PointerEvent
  ): { readonly match: HitTestMatch | null; readonly isInGrid: boolean } => {
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return { match: null, isInGrid: false };

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const plotLeftCss = resolvedOptions.grid.left;
    const plotTopCss = resolvedOptions.grid.top;
    const plotWidthCss = rect.width - resolvedOptions.grid.left - resolvedOptions.grid.right;
    const plotHeightCss = rect.height - resolvedOptions.grid.top - resolvedOptions.grid.bottom;
    if (!(plotWidthCss > 0) || !(plotHeightCss > 0)) return { match: null, isInGrid: false };

    const gridX = x - plotLeftCss;
    const gridY = y - plotTopCss;

    const isInGrid =
      gridX >= 0 &&
      gridX <= plotWidthCss &&
      gridY >= 0 &&
      gridY <= plotHeightCss;

    if (!isInGrid) return { match: null, isInGrid: false };

    const xMin = resolvedOptions.xAxis.min ?? cachedGlobalBounds.xMin;
    const xMax = resolvedOptions.xAxis.max ?? cachedGlobalBounds.xMax;
    const yMin = resolvedOptions.yAxis.min ?? cachedGlobalBounds.yMin;
    const yMax = resolvedOptions.yAxis.max ?? cachedGlobalBounds.yMax;

    // Make hit-testing zoom-aware (mirror coordinator percent->domain mapping).
    const baseXDomain = normalizeDomain(xMin, xMax);
    const zoomRange = coordinator?.getZoomRange() ?? null;
    const xDomain = (() => {
      if (!zoomRange) return baseXDomain;
      const span = baseXDomain.max - baseXDomain.min;
      if (!Number.isFinite(span) || span === 0) return baseXDomain;
      const start = zoomRange.start;
      const end = zoomRange.end;
      const zMin = baseXDomain.min + (start / 100) * span;
      const zMax = baseXDomain.min + (end / 100) * span;
      return normalizeDomain(zMin, zMax);
    })();
    const yDomain = normalizeDomain(yMin, yMax);

    // Cache hit-testing scales for identical (rect, grid, axis domain) inputs.
    const canReuseScales =
      interactionScalesCache !== null &&
      interactionScalesCache.rectWidthCss === rect.width &&
      interactionScalesCache.rectHeightCss === rect.height &&
      interactionScalesCache.plotWidthCss === plotWidthCss &&
      interactionScalesCache.plotHeightCss === plotHeightCss &&
      interactionScalesCache.xDomainMin === xDomain.min &&
      interactionScalesCache.xDomainMax === xDomain.max &&
      interactionScalesCache.yDomainMin === yDomain.min &&
      interactionScalesCache.yDomainMax === yDomain.max;

    if (!canReuseScales) {
      // IMPORTANT: grid-local CSS px ranges (0..plotWidth/Height), for interaction hit-testing.
      const xScale = createLinearScale().domain(xDomain.min, xDomain.max).range(0, plotWidthCss);
      const yScale = createLinearScale().domain(yDomain.min, yDomain.max).range(plotHeightCss, 0);
      interactionScalesCache = {
        rectWidthCss: rect.width,
        rectHeightCss: rect.height,
        plotWidthCss,
        plotHeightCss,
        xDomainMin: xDomain.min,
        xDomainMax: xDomain.max,
        yDomainMin: yDomain.min,
        yDomainMax: yDomain.max,
        xScale,
        yScale,
      };
    }

    // At this point, the cache must exist (either reused or created above).
    const scales = interactionScalesCache!;

    // Story 4.14: pie slice hit-testing (grid-local CSS px).
    const pieMatch = (() => {
      const maxRadiusCss = 0.5 * Math.min(plotWidthCss, plotHeightCss);
      if (!(maxRadiusCss > 0)) return null;

      // Prefer later series indices (deterministic and mirrors the coordinator tooltip logic).
      for (let i = resolvedOptions.series.length - 1; i >= 0; i--) {
        const s = resolvedOptions.series[i];
        if (s.type !== 'pie') continue;
        const pieSeries = s as ResolvedPieSeriesConfig;
        const center = resolvePieCenterPlotCss(pieSeries.center, plotWidthCss, plotHeightCss);
        const radii = resolvePieRadiiCss(pieSeries.radius, maxRadiusCss);
        const m = findPieSlice(gridX, gridY, { seriesIndex: i, series: pieSeries }, center, radii);
        if (!m) continue;

        const v = m.slice.value;
        return {
          kind: 'pie' as const,
          seriesIndex: m.seriesIndex,
          dataIndex: m.dataIndex,
          sliceValue: typeof v === 'number' && Number.isFinite(v) ? v : 0,
        };
      }
      return null;
    })();

    if (pieMatch) return { match: pieMatch, isInGrid: true };

    // Candlestick body hit-testing (grid-local CSS px), prefer later series indices.
    for (let i = resolvedOptions.series.length - 1; i >= 0; i--) {
      const s = resolvedOptions.series[i];
      if (s?.type !== 'candlestick') continue;

      const seriesCfg = s as ResolvedCandlestickSeriesConfig;
      const barWidthRange = computeCandlestickBodyWidthRange(seriesCfg, seriesCfg.data, scales.xScale, plotWidthCss);
      const m = findCandlestick([seriesCfg], gridX, gridY, scales.xScale, scales.yScale, barWidthRange);
      if (!m) continue;

      return {
        match: { kind: 'candlestick', seriesIndex: i, dataIndex: m.dataIndex, point: m.point },
        isInGrid: true,
      };
    }

    const cartesianMatch = findNearestPoint(
      getRuntimeHitTestSeries(),
      gridX,
      gridY,
      scales.xScale,
      scales.yScale
    );

    return {
      match: cartesianMatch ? ({ kind: 'cartesian', match: cartesianMatch } as const) : null,
      isInGrid: true,
    };
  };

  const calculateExactFPS = (): ExactFPS => {
    if (frameTimestampCount < 2) {
      return 0 as ExactFPS;
    }

    const startIndex = (frameTimestampIndex - frameTimestampCount + FRAME_BUFFER_SIZE) % FRAME_BUFFER_SIZE;
    
    let totalDelta = 0;
    for (let i = 1; i < frameTimestampCount; i++) {
      const prevIndex = (startIndex + i - 1) % FRAME_BUFFER_SIZE;
      const currIndex = (startIndex + i) % FRAME_BUFFER_SIZE;
      const delta = frameTimestamps[currIndex] - frameTimestamps[prevIndex];
      totalDelta += delta;
    }

    const avgFrameTime = totalDelta / (frameTimestampCount - 1);
    const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
    
    return fps as ExactFPS;
  };

  const calculateFrameTimeStats = (): FrameTimeStats => {
    if (frameTimestampCount < 2) {
      return {
        min: 0 as Milliseconds,
        max: 0 as Milliseconds,
        avg: 0 as Milliseconds,
        p50: 0 as Milliseconds,
        p95: 0 as Milliseconds,
        p99: 0 as Milliseconds,
      };
    }

    const startIndex = (frameTimestampIndex - frameTimestampCount + FRAME_BUFFER_SIZE) % FRAME_BUFFER_SIZE;
    
    const deltas = new Array<number>(frameTimestampCount - 1);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    
    for (let i = 1; i < frameTimestampCount; i++) {
      const prevIndex = (startIndex + i - 1) % FRAME_BUFFER_SIZE;
      const currIndex = (startIndex + i) % FRAME_BUFFER_SIZE;
      const delta = frameTimestamps[currIndex] - frameTimestamps[prevIndex];
      deltas[i - 1] = delta;
      
      if (delta < min) min = delta;
      if (delta > max) max = delta;
      sum += delta;
    }

    const avg = sum / deltas.length;

    // Sort for percentile calculations
    deltas.sort((a, b) => a - b);

    const p50Index = Math.floor(deltas.length * 0.50);
    const p95Index = Math.floor(deltas.length * 0.95);
    const p99Index = Math.floor(deltas.length * 0.99);

    return {
      min: min as Milliseconds,
      max: max as Milliseconds,
      avg: avg as Milliseconds,
      p50: deltas[p50Index] as Milliseconds,
      p95: deltas[p95Index] as Milliseconds,
      p99: deltas[p99Index] as Milliseconds,
    };
  };

  const calculatePerformanceMetrics = (): PerformanceMetrics => {
    const fps = calculateExactFPS();
    const frameTimeStats = calculateFrameTimeStats();
    
    const gpuTiming: GPUTimingStats = {
      enabled: false, // GPU timing not yet implemented for main thread
      cpuTime: lastCPUTime as Milliseconds,
      gpuTime: 0 as Milliseconds,
    };
    
    const memory: MemoryStats = {
      used: 0 as Bytes,
      peak: 0 as Bytes,
      allocated: 0 as Bytes,
    };
    
    const frameDrops: FrameDropStats = {
      totalDrops: totalDroppedFrames,
      consecutiveDrops: consecutiveDroppedFrames,
      lastDropTimestamp: lastDropTimestamp as Milliseconds,
    };
    
    const elapsedTime = performance.now() - startTime;
    
    return {
      fps,
      frameTimeStats,
      gpuTiming,
      memory,
      frameDrops,
      totalFrames,
      elapsedTime: elapsedTime as Milliseconds,
    };
  };

  const buildPayload = (match: HitTestMatch | null, event: PointerEvent): ChartGPUEventPayload => {
    if (!match) {
      return { seriesIndex: null, dataIndex: null, value: null, seriesName: null, event };
    }

    const seriesIndex = match.kind === 'cartesian' ? match.match.seriesIndex : match.seriesIndex;
    const dataIndex = match.kind === 'cartesian' ? match.match.dataIndex : match.dataIndex;

    const series = resolvedOptions.series[seriesIndex];
    const seriesNameRaw = series?.name ?? null;
    const seriesName = seriesNameRaw && seriesNameRaw.trim().length > 0 ? seriesNameRaw : null;

    if (match.kind === 'pie') {
      // Pie series are non-cartesian; expose slice value in y so consumers can read a numeric.
      return {
        seriesIndex,
        dataIndex,
        value: [0, match.sliceValue],
        seriesName,
        event,
      };
    }

    if (match.kind === 'candlestick') {
      const timestamp = getOHLCTimestamp(match.point);
      const close = getOHLCClose(match.point);
      return {
        seriesIndex,
        dataIndex,
        value: [timestamp, close],
        seriesName,
        event,
      };
    }

    const { x, y } = getPointXY(match.match.point);
    return {
      seriesIndex,
      dataIndex,
      value: [x, y],
      seriesName,
      event,
    };
  };

  const emit = (
    eventName: ChartGPUEventName,
    payload: ChartGPUEventPayload | ChartGPUCrosshairMovePayload
  ): void => {
    if (disposed) return;
    for (const cb of listeners[eventName]) (cb as (p: typeof payload) => void)(payload);
  };

  const setHovered = (next: HitTestMatch | null, event: PointerEvent): void => {
    const prev = hovered;
    hovered = next;

    if (prev === null && next === null) return;

    if (prev === null && next !== null) {
      emit('mouseover', buildPayload(next, event));
      return;
    }

    if (prev !== null && next === null) {
      emit('mouseout', buildPayload(prev, event));
      return;
    }

    if (prev === null || next === null) return;

    const prevSeriesIndex = prev.kind === 'cartesian' ? prev.match.seriesIndex : prev.seriesIndex;
    const prevDataIndex = prev.kind === 'cartesian' ? prev.match.dataIndex : prev.dataIndex;
    const nextSeriesIndex = next.kind === 'cartesian' ? next.match.seriesIndex : next.seriesIndex;
    const nextDataIndex = next.kind === 'cartesian' ? next.match.dataIndex : next.dataIndex;

    const samePoint = prevSeriesIndex === nextSeriesIndex && prevDataIndex === nextDataIndex;
    if (samePoint) return;

    emit('mouseout', buildPayload(prev, event));
    emit('mouseover', buildPayload(next, event));
  };

  const clearTapCandidateIfMatches = (e: PointerEvent): void => {
    if (!tapCandidate) return;
    if (!e.isPrimary) return;
    if (e.pointerId !== tapCandidate.pointerId) return;
    tapCandidate = null;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (disposed) return;
    if (!hasHoverListeners()) return;
    const { match, isInGrid } = getNearestPointFromPointerEvent(e);
    if (!isInGrid) {
      setHovered(null, e);
      return;
    }
    setHovered(match, e);
  };

  const onPointerLeave = (e: PointerEvent): void => {
    if (disposed) return;
    if (!hasHoverListeners() && !tapCandidate) return;
    clearTapCandidateIfMatches(e);
    setHovered(null, e);
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (disposed) return;
    if (!hasHoverListeners() && !tapCandidate) return;
    clearTapCandidateIfMatches(e);
    setHovered(null, e);
  };

  const onLostPointerCapture = (e: PointerEvent): void => {
    if (disposed) return;
    if (!hasHoverListeners() && !tapCandidate && suppressNextLostPointerCaptureId !== e.pointerId) return;
    if (suppressNextLostPointerCaptureId === e.pointerId) {
      suppressNextLostPointerCaptureId = null;
      return;
    }
    clearTapCandidateIfMatches(e);
    setHovered(null, e);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (disposed) return;
    if (!hasClickListeners()) return;
    if (!e.isPrimary) return;

    // For mouse, only allow left button.
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    tapCandidate = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTimeMs: e.timeStamp,
    };

    // Optional pointer capture improves reliability for touch/pen.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // best-effort
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (disposed) return;
    if (!hasClickListeners()) return;
    if (!e.isPrimary) return;
    if (!tapCandidate || e.pointerId !== tapCandidate.pointerId) return;

    const dt = e.timeStamp - tapCandidate.startTimeMs;
    const dx = e.clientX - tapCandidate.startClientX;
    const dy = e.clientY - tapCandidate.startClientY;
    const distSq = dx * dx + dy * dy;

    tapCandidate = null;

    // Release capture if we have it; suppress the resulting lostpointercapture.
    try {
      if (canvas.hasPointerCapture(e.pointerId)) {
        suppressNextLostPointerCaptureId = e.pointerId;
        canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // best-effort
    }

    const maxDist = DEFAULT_TAP_MAX_DISTANCE_CSS_PX;
    const isTap = dt <= DEFAULT_TAP_MAX_TIME_MS && distSq <= maxDist * maxDist;
    if (!isTap) return;

    const { match } = getNearestPointFromPointerEvent(e);
    emit('click', buildPayload(match, e));
  };

  canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('pointerleave', onPointerLeave, { passive: true });
  canvas.addEventListener('pointercancel', onPointerCancel, { passive: true });
  canvas.addEventListener('lostpointercapture', onLostPointerCapture, { passive: true });
  canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
  canvas.addEventListener('pointerup', onPointerUp, { passive: true });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    try {
      // Requirement: dispose order: cancel RAF, coordinator.dispose(), gpuContext.destroy(), remove canvas.
      cancelPendingFrame();
      disposeDataZoomUi();
      unbindCoordinatorInteractionXChange();
      coordinator?.dispose();
      coordinator = null;
      coordinatorTargetFormat = null;
      gpuContext?.destroy();
    } finally {
      tapCandidate = null;
      suppressNextLostPointerCaptureId = null;
      hovered = null;
      interactionScalesCache = null;

      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onLostPointerCapture);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);

      listeners.click.clear();
      listeners.mouseover.clear();
      listeners.mouseout.clear();
      listeners.crosshairMove.clear();

      gpuContext = null;
      canvas.remove();
    }
  };

  const instance: ChartGPUInstance = {
    get options() {
      return currentOptions;
    },
    get disposed() {
      return disposed;
    },
    setOption(nextOptions) {
      if (disposed) return;
      currentOptions = nextOptions;
      resolvedOptions = resolveOptionsForChart(nextOptions);
      coordinator?.setOptions(resolvedOptions);
      initRuntimeHitTestStoreFromResolvedOptions();
      cachedGlobalBounds = computeGlobalBounds(resolvedOptions.series, runtimeRawBoundsByIndex);
      interactionScalesCache = null;
      syncDataZoomUi();

      // Requirement: setOption triggers a render (and thus series parsing/extent/scales update inside render).
      requestRender();
    },
    appendData(seriesIndex, newPoints) {
      if (disposed) return;
      if (!Number.isFinite(seriesIndex)) return;
      if (seriesIndex < 0 || seriesIndex >= resolvedOptions.series.length) return;
      if (!newPoints || newPoints.length === 0) return;

      const s = resolvedOptions.series[seriesIndex]!;
      if (s.type === 'pie') {
        // Pie series are non-cartesian and currently not supported by streaming append.
        if (!warnedPieAppendSeries.has(seriesIndex)) {
          warnedPieAppendSeries.add(seriesIndex);
          console.warn(
            `ChartGPU.appendData(${seriesIndex}, ...): pie series are not supported by streaming append. Use setOption(...) to replace pie data.`
          );
        }
        return;
      }

      // Forward to coordinator (GPU buffers + render-state updates), then keep ChartGPU's
      // hit-testing runtime store in sync.
      coordinator?.appendData(seriesIndex, newPoints);

      if (s.type === 'candlestick') {
        // Handle candlestick series with OHLC data points.
        const owned = (runtimeRawDataByIndex[seriesIndex] ?? []) as OHLCDataPoint[];
        owned.push(...(newPoints as OHLCDataPoint[]));
        runtimeRawDataByIndex[seriesIndex] = owned;

        runtimeRawBoundsByIndex[seriesIndex] = extendBoundsWithOHLCDataPoints(
          runtimeRawBoundsByIndex[seriesIndex],
          newPoints as OHLCDataPoint[]
        );
      } else {
        // Handle other cartesian series (line, area, bar, scatter).
        const owned = (runtimeRawDataByIndex[seriesIndex] ?? []) as DataPoint[];
        owned.push(...(newPoints as DataPoint[]));
        runtimeRawDataByIndex[seriesIndex] = owned;

        runtimeRawBoundsByIndex[seriesIndex] = extendBoundsWithDataPoints(
          runtimeRawBoundsByIndex[seriesIndex],
          newPoints as DataPoint[]
        );
      }

      cachedGlobalBounds = computeGlobalBounds(resolvedOptions.series, runtimeRawBoundsByIndex);

      runtimeHitTestSeriesCache = null;
      runtimeHitTestSeriesVersion++;
      interactionScalesCache = null;

      // Ensure a render is scheduled (coalesced) like setOption does.
      requestRender();
    },
    resize,
    dispose,
    on(eventName, callback) {
      if (disposed) return;
      listeners[eventName].add(callback as AnyChartGPUEventCallback);
    },
    off(eventName, callback) {
      listeners[eventName].delete(callback as AnyChartGPUEventCallback);
    },
    getInteractionX() {
      if (disposed) return null;
      return coordinator?.getInteractionX() ?? null;
    },
    setInteractionX(x, source) {
      if (disposed) return;
      coordinator?.setInteractionX(x, source);
    },
    setCrosshairX(x, source) {
      if (disposed) return;
      coordinator?.setInteractionX(x, source);
    },
    onInteractionXChange(callback) {
      if (disposed) return () => {};
      return coordinator?.onInteractionXChange(callback) ?? (() => {});
    },
    getZoomRange() {
      if (disposed) return null;
      return coordinator?.getZoomRange() ?? null;
    },
    setZoomRange(start, end) {
      if (disposed) return;
      coordinator?.setZoomRange(start, end);
    },
    getPerformanceMetrics() {
      if (disposed) return null;
      return calculatePerformanceMetrics();
    },
    getPerformanceCapabilities() {
      if (disposed) return null;
      return {
        gpuTimingSupported: false, // Not yet implemented for main thread
        highResTimerSupported: typeof performance !== 'undefined' && typeof performance.now === 'function',
        performanceMetricsSupported: true,
      };
    },
    onPerformanceUpdate(callback) {
      if (disposed) return () => {};
      performanceUpdateCallbacks.add(callback);
      return () => {
        performanceUpdateCallbacks.delete(callback);
      };
    },
    hitTest(e) {
      const rect = canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Default result for cases where rect is invalid or disposed
      if (disposed || !(rect.width > 0) || !(rect.height > 0)) {
        return {
          isInGrid: false,
          canvasX,
          canvasY,
          gridX: 0,
          gridY: 0,
          match: null,
        };
      }

      const plotLeftCss = resolvedOptions.grid.left;
      const plotTopCss = resolvedOptions.grid.top;
      const plotWidthCss = rect.width - resolvedOptions.grid.left - resolvedOptions.grid.right;
      const plotHeightCss = rect.height - resolvedOptions.grid.top - resolvedOptions.grid.bottom;

      const gridX = canvasX - plotLeftCss;
      const gridY = canvasY - plotTopCss;

      // If plot dimensions are invalid, return coords but no match
      if (!(plotWidthCss > 0) || !(plotHeightCss > 0)) {
        return {
          isInGrid: false,
          canvasX,
          canvasY,
          gridX,
          gridY,
          match: null,
        };
      }

      const isInGrid =
        gridX >= 0 &&
        gridX <= plotWidthCss &&
        gridY >= 0 &&
        gridY <= plotHeightCss;

      // If outside grid, return early
      if (!isInGrid) {
        return {
          isInGrid: false,
          canvasX,
          canvasY,
          gridX,
          gridY,
          match: null,
        };
      }

      // Compute domain and scales for hit-testing
      const xMin = resolvedOptions.xAxis.min ?? cachedGlobalBounds.xMin;
      const xMax = resolvedOptions.xAxis.max ?? cachedGlobalBounds.xMax;
      const yMin = resolvedOptions.yAxis.min ?? cachedGlobalBounds.yMin;
      const yMax = resolvedOptions.yAxis.max ?? cachedGlobalBounds.yMax;

      const baseXDomain = normalizeDomain(xMin, xMax);
      const zoomRange = coordinator?.getZoomRange() ?? null;
      const xDomain = (() => {
        if (!zoomRange) return baseXDomain;
        const span = baseXDomain.max - baseXDomain.min;
        if (!Number.isFinite(span) || span === 0) return baseXDomain;
        const start = zoomRange.start;
        const end = zoomRange.end;
        const zMin = baseXDomain.min + (start / 100) * span;
        const zMax = baseXDomain.min + (end / 100) * span;
        return normalizeDomain(zMin, zMax);
      })();
      const yDomain = normalizeDomain(yMin, yMax);

      // Reuse or rebuild interaction scales cache
      const canReuseScales =
        interactionScalesCache !== null &&
        interactionScalesCache.rectWidthCss === rect.width &&
        interactionScalesCache.rectHeightCss === rect.height &&
        interactionScalesCache.plotWidthCss === plotWidthCss &&
        interactionScalesCache.plotHeightCss === plotHeightCss &&
        interactionScalesCache.xDomainMin === xDomain.min &&
        interactionScalesCache.xDomainMax === xDomain.max &&
        interactionScalesCache.yDomainMin === yDomain.min &&
        interactionScalesCache.yDomainMax === yDomain.max;

      if (!canReuseScales) {
        const xScale = createLinearScale().domain(xDomain.min, xDomain.max).range(0, plotWidthCss);
        const yScale = createLinearScale().domain(yDomain.min, yDomain.max).range(plotHeightCss, 0);
        interactionScalesCache = {
          rectWidthCss: rect.width,
          rectHeightCss: rect.height,
          plotWidthCss,
          plotHeightCss,
          xDomainMin: xDomain.min,
          xDomainMax: xDomain.max,
          yDomainMin: yDomain.min,
          yDomainMax: yDomain.max,
          xScale,
          yScale,
        };
      }

      const scales = interactionScalesCache!;

      // Pie slice hit-testing
      const pieMatch = (() => {
        const maxRadiusCss = 0.5 * Math.min(plotWidthCss, plotHeightCss);
        if (!(maxRadiusCss > 0)) return null;

        for (let i = resolvedOptions.series.length - 1; i >= 0; i--) {
          const s = resolvedOptions.series[i];
          if (s.type !== 'pie') continue;
          const pieSeries = s as ResolvedPieSeriesConfig;
          const center = resolvePieCenterPlotCss(pieSeries.center, plotWidthCss, plotHeightCss);
          const radii = resolvePieRadiiCss(pieSeries.radius, maxRadiusCss);
          const m = findPieSlice(gridX, gridY, { seriesIndex: i, series: pieSeries }, center, radii);
          if (!m) continue;

          const v = m.slice.value;
          return {
            kind: 'pie' as const,
            seriesIndex: m.seriesIndex,
            dataIndex: m.dataIndex,
            sliceValue: typeof v === 'number' && Number.isFinite(v) ? v : 0,
          };
        }
        return null;
      })();

      if (pieMatch) {
        return {
          isInGrid: true,
          canvasX,
          canvasY,
          gridX,
          gridY,
          match: {
            kind: 'pie',
            seriesIndex: pieMatch.seriesIndex,
            dataIndex: pieMatch.dataIndex,
            value: [0, pieMatch.sliceValue],
          },
        };
      }

      // Candlestick body hit-testing
      for (let i = resolvedOptions.series.length - 1; i >= 0; i--) {
        const s = resolvedOptions.series[i];
        if (s?.type !== 'candlestick') continue;

        const seriesCfg = s as ResolvedCandlestickSeriesConfig;
        const barWidthRange = computeCandlestickBodyWidthRange(seriesCfg, seriesCfg.data, scales.xScale, plotWidthCss);
        const m = findCandlestick([seriesCfg], gridX, gridY, scales.xScale, scales.yScale, barWidthRange);
        if (!m) continue;

        const timestamp = getOHLCTimestamp(m.point);
        const close = getOHLCClose(m.point);

        return {
          isInGrid: true,
          canvasX,
          canvasY,
          gridX,
          gridY,
          match: {
            kind: 'candlestick',
            seriesIndex: i,
            dataIndex: m.dataIndex,
            value: [timestamp, close],
          },
        };
      }

      // Cartesian nearest-point hit-testing
      const cartesianMatch = findNearestPoint(
        getRuntimeHitTestSeries(),
        gridX,
        gridY,
        scales.xScale,
        scales.yScale
      );

      if (cartesianMatch) {
        const { x, y } = getPointXY(cartesianMatch.point);
        return {
          isInGrid: true,
          canvasX,
          canvasY,
          gridX,
          gridY,
          match: {
            kind: 'cartesian',
            seriesIndex: cartesianMatch.seriesIndex,
            dataIndex: cartesianMatch.dataIndex,
            value: [x, y],
          },
        };
      }

      // Inside grid but no match
      return {
        isInGrid: true,
        canvasX,
        canvasY,
        gridX,
        gridY,
        match: null,
      };
    },
  };

  try {
    // Establish initial canvas backing size before WebGPU initialization.
    resizeInternal(false);

    // Try to create GPU context; wrap errors with detailed WebGPU unavailability message
    try {
      gpuContext = await GPUContext.create(canvas);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ChartGPU: WebGPU is not available.\n` +
        `Reason: ${errorMessage}\n` +
        `Browser support: Chrome/Edge 113+, Safari 18+, Firefox not yet supported.\n` +
        `Resources:\n` +
        `  - MDN WebGPU API: https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API\n` +
        `  - Browser compatibility: https://caniuse.com/webgpu\n` +
        `  - WebGPU specification: https://www.w3.org/TR/webgpu/\n` +
        `  - Check your system: https://webgpureport.org/`
      );
    }

    gpuContext.device?.lost.then((info) => {
      if (disposed) return;
      if (info.reason !== 'destroyed') {
        console.warn('WebGPU device lost:', info);
      }
      // Requirement: device loss routes through the same dispose path.
      dispose();
    });

    // Ensure canvas configuration matches the final measured size/format.
    resizeInternal(false);

    // Requirement: after GPUContext is initialized, create RenderCoordinator with resolved options.
    recreateCoordinator();

    // Mount data-zoom UI (if configured).
    syncDataZoomUi();

    // Kick an initial render.
    requestRender();
    return instance;
  } catch (error) {
    instance.dispose();
    throw error;
  }
}

export const ChartGPU = {
  create: createChartGPU,
};

