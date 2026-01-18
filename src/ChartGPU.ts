import { GPUContext } from './core/GPUContext';
import { createRenderCoordinator } from './core/createRenderCoordinator';
import type { RenderCoordinator } from './core/createRenderCoordinator';
import { resolveOptions } from './config/OptionResolver';
import type { ResolvedChartGPUOptions } from './config/OptionResolver';
import type { ChartGPUOptions, DataPoint, DataPointTuple } from './config/types';
import { findNearestPoint } from './interaction/findNearestPoint';
import type { NearestPointMatch } from './interaction/findNearestPoint';
import { createLinearScale } from './utils/scales';
import type { LinearScale } from './utils/scales';

export interface ChartGPUInstance {
  readonly options: Readonly<ChartGPUOptions>;
  readonly disposed: boolean;
  setOption(options: ChartGPUOptions): void;
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

const getPointXY = (p: DataPoint): { readonly x: number; readonly y: number } => {
  if (isTupleDataPoint(p)) return { x: p[0], y: p[1] };
  return { x: p.x, y: p.y };
};

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

const computeGlobalBounds = (series: ResolvedChartGPUOptions['series']): Bounds => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < series.length; s++) {
    const data = series[s].data;
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

export async function createChartGPU(
  container: HTMLElement,
  options: ChartGPUOptions
): Promise<ChartGPUInstance> {
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

  let currentOptions: ChartGPUOptions = options;
  let resolvedOptions: ResolvedChartGPUOptions = {
    ...resolveOptions(currentOptions),
    tooltip: currentOptions.tooltip,
  };

  // Cache global bounds and interaction scales; avoids O(N) data scans per pointer move.
  let cachedGlobalBounds: Bounds = computeGlobalBounds(resolvedOptions.series);
  let interactionScalesCache: InteractionScalesCache | null = null;

  const listeners: ListenerRegistry = {
    click: new Set<ChartGPUEventCallback>(),
    mouseover: new Set<ChartGPUEventCallback>(),
    mouseout: new Set<ChartGPUEventCallback>(),
    crosshairMove: new Set<ChartGPUCrosshairMoveCallback>(),
  };

  let tapCandidate: TapCandidate | null = null;
  let suppressNextLostPointerCaptureId: number | null = null;

  let hovered: NearestPointMatch | null = null;

  let scheduledRaf: number | null = null;
  let lastConfigured: { width: number; height: number; format: GPUTextureFormat } | null = null;

  const hasHoverListeners = (): boolean => listeners.mouseover.size > 0 || listeners.mouseout.size > 0;
  const hasClickListeners = (): boolean => listeners.click.size > 0;

  const cancelPendingFrame = (): void => {
    if (scheduledRaf === null) return;
    cancelAnimationFrame(scheduledRaf);
    scheduledRaf = null;
  };

  const requestRender = (): void => {
    if (disposed) return;
    if (scheduledRaf !== null) return;

    scheduledRaf = requestAnimationFrame(() => {
      scheduledRaf = null;
      if (disposed) return;

      // Requirement: on RAF tick, call resize() first.
      resizeInternal(false);
      coordinator?.render();
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

    unbindCoordinatorInteractionXChange();
    coordinator?.dispose();
    coordinator = createRenderCoordinator(gpuContext, resolvedOptions, { onRequestRender: requestRender });
    coordinatorTargetFormat = gpuContext.preferredFormat;
    bindCoordinatorInteractionXChange();
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
  ): { readonly match: NearestPointMatch | null; readonly isInGrid: boolean } => {
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

    const xDomain = normalizeDomain(xMin, xMax);
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

    const match = findNearestPoint(
      resolvedOptions.series,
      gridX,
      gridY,
      scales.xScale,
      scales.yScale
    );
    return { match, isInGrid: true };
  };

  const buildPayload = (match: NearestPointMatch | null, event: PointerEvent): ChartGPUEventPayload => {
    if (!match) {
      return { seriesIndex: null, dataIndex: null, value: null, seriesName: null, event };
    }

    const series = resolvedOptions.series[match.seriesIndex];
    const seriesNameRaw = series?.name ?? null;
    const seriesName = seriesNameRaw && seriesNameRaw.trim().length > 0 ? seriesNameRaw : null;
    const { x, y } = getPointXY(match.point);

    return {
      seriesIndex: match.seriesIndex,
      dataIndex: match.dataIndex,
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

  const setHovered = (next: NearestPointMatch | null, event: PointerEvent): void => {
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

    const samePoint =
      prev.seriesIndex === next.seriesIndex && prev.dataIndex === next.dataIndex;
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
      resolvedOptions = { ...resolveOptions(nextOptions), tooltip: nextOptions.tooltip };
      coordinator?.setOptions(resolvedOptions);
      cachedGlobalBounds = computeGlobalBounds(resolvedOptions.series);
      interactionScalesCache = null;

      // Requirement: setOption triggers a render (and thus series parsing/extent/scales update inside render).
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
  };

  try {
    // Establish initial canvas backing size before WebGPU initialization.
    resizeInternal(false);

    gpuContext = await GPUContext.create(canvas);
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

