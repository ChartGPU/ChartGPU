/**
 * 3D chart create path — isolated from the 2D ChartGPU instance body.
 * Invoked when `coordinateSystem: 'cartesian3d'`.
 */

import { GPUContext } from './core/GPUContext';
import { resolveOptionsForChart } from './config/OptionResolver';
import type { ResolvedChartGPUOptions } from './config/OptionResolver';
import type {
  CartesianSeriesData,
  Chart3DCameraOptions,
  ChartGPUOptions,
  OHLCDataPoint,
  PointCloud3DData,
  RenderMode,
} from './config/types';
import { createRenderCoordinator3D } from './core/renderCoordinator3d/createRenderCoordinator3D';
import type { RenderCoordinator3D } from './core/renderCoordinator3d/createRenderCoordinator3D';
import type { ResolvedCamera } from './core/3d/camera';
import type {
  ChartGPUCreateContext,
  ChartGPUInstance,
  ChartGPUEventName,
  ChartGPUEventCallback,
  ChartGPUCrosshairMoveCallback,
  ChartGPUZoomRangeChangeCallback,
  ChartGPUDeviceLostCallback,
  ChartGPUDataAppendCallback,
  ChartGPUHitTestResult,
} from './ChartGPU';
import { checkWebGPUSupport } from './utils/checkWebGPU';

type AnyCb =
  | ChartGPUEventCallback
  | ChartGPUCrosshairMoveCallback
  | ChartGPUZoomRangeChangeCallback
  | ChartGPUDeviceLostCallback
  | ChartGPUDataAppendCallback;

// Reuse the module-level registry from ChartGPU via a callback pattern would be ideal,
// but ChartGPU registers after return. We export a hook used by ChartGPU.create branch.

export type ChartGPU3DCreateResult = ChartGPUInstance & {
  readonly is3D: true;
  resetCamera(): void;
  setCamera(partial: Chart3DCameraOptions): void;
  getCamera(): ResolvedCamera;
};

export async function createChartGPU3D(
  container: HTMLElement,
  options: ChartGPUOptions,
  context: ChartGPUCreateContext | undefined,
  registerActive: (inst: { dispose(): void; disposed: boolean }) => void
): Promise<ChartGPUInstance> {
  if (!context) {
    const supportCheck = await checkWebGPUSupport();
    if (!supportCheck.supported) {
      const reason = supportCheck.reason || 'Unknown reason';
      throw new Error(
        `ChartGPU: WebGPU is not available.\n` +
          `Reason: ${reason}\n` +
          `Browser support: Chrome/Edge 113+, Safari 18+, Firefox not yet supported.`
      );
    }
  } else if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('ChartGPU: Shared device mode requires WebGPU globals (navigator.gpu).');
  }

  if (context?.pipelineCache && context.pipelineCache.device !== context.device) {
    throw new Error('ChartGPU: pipelineCache.device must match the GPUDevice in the creation context.');
  }

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const isSharedDevice = !!context;
  let disposed = false;
  let renderMode: RenderMode = options.renderMode ?? 'auto';
  let isRendering = false;
  let deviceIsLost = false;
  let gpuContext: GPUContext | null = null;
  let coordinator: RenderCoordinator3D | null = null;
  let dirty = true;
  let rafId: number | null = null;

  let currentOptions: ChartGPUOptions = options;
  let resolvedOptions: ResolvedChartGPUOptions = resolveOptionsForChart(currentOptions);

  const createTimeExplicitDpr: number | null = (() => {
    const dprOpt = options.devicePixelRatio;
    return typeof dprOpt === 'number' && Number.isFinite(dprOpt) && dprOpt > 0 ? dprOpt : null;
  })();

  const listeners: Record<string, Set<AnyCb>> = {
    click: new Set(),
    mouseover: new Set(),
    mouseout: new Set(),
    crosshairMove: new Set(),
    zoomRangeChange: new Set(),
    deviceLost: new Set(),
    dataAppend: new Set(),
  };

  const emit = (name: string, payload: unknown): void => {
    const set = listeners[name];
    if (!set) return;
    for (const cb of set) {
      try {
        (cb as (p: unknown) => void)(payload);
      } catch (err) {
        console.error('ChartGPU event listener error:', err);
      }
    }
  };

  const resolveResizeDpr = (): number => {
    if (createTimeExplicitDpr != null) return createTimeExplicitDpr;
    return (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  };

  let lastConfigured: { width: number; height: number; format: GPUTextureFormat } | null = null;

  const resizeInternal = (shouldRequestRender: boolean): void => {
    if (disposed) return;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const dpr = resolveResizeDpr();
    if (gpuContext) gpuContext.setDevicePixelRatio(dpr);
    const maxDimension = gpuContext?.device?.limits.maxTextureDimension2D ?? 8192;
    const width = Math.min(maxDimension, Math.max(1, Math.round(cssWidth * dpr)));
    const height = Math.min(maxDimension, Math.max(1, Math.round(cssHeight * dpr)));
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
      }
    }
    if (shouldRequestRender && (sizeChanged || didConfigure)) {
      requestRender();
    }
  };

  const doRender = (): void => {
    if (disposed || deviceIsLost || !coordinator) return;
    if (isRendering) return;
    isRendering = true;
    try {
      coordinator.render();
      dirty = false;
    } finally {
      isRendering = false;
    }
  };

  const requestRender = (): void => {
    if (disposed || deviceIsLost) return;
    dirty = true;
    if (renderMode !== 'auto') return;
    if (rafId != null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (dirty) doRender();
    });
  };

  const instance: ChartGPUInstance = {
    get options() {
      return currentOptions;
    },
    get disposed() {
      return disposed;
    },
    setOption(next: ChartGPUOptions) {
      if (disposed) return;
      const previousUser = currentOptions;
      const previousResolved = resolvedOptions;
      currentOptions = {
        ...currentOptions,
        ...next,
        series: next.series ?? currentOptions.series,
        coordinateSystem: 'cartesian3d',
      };
      if (next.coordinateSystem != null && next.coordinateSystem !== 'cartesian3d') {
        console.warn(
          "ChartGPU 3D: coordinateSystem cannot switch to 2D via setOption; keeping 'cartesian3d'. Dispose and recreate for 2D."
        );
      }
      resolvedOptions = resolveOptionsForChart(currentOptions, {
        previousResolved,
        previousUserOptions: previousUser,
      });
      coordinator?.setOptions(resolvedOptions);
      requestRender();
    },
    getHitTestStoreRebuildCount: () => 0,
    getHitTestSeriesPointCount: () => 0,
    appendData(seriesIndex, newPoints, opts?) {
      if (disposed || !coordinator) return;
      // Gate on resolved series type before append (indices are resolved-order after OptionResolver filter).
      const series = resolvedOptions.series[seriesIndex];
      if (!series || series.type !== 'pointCloud3d') {
        console.warn(
          'ChartGPU 3D: appendData is only supported for pointCloud3d at a resolved series index ' +
            `(got ${series?.type ?? 'missing'} at ${seriesIndex}). ` +
            'Modality-skipped series compact the resolved array — use the index after filtering. ' +
            'surface3d: replace data.y via setOption.'
        );
        return;
      }
      if (opts?.maxPoints != null) {
        console.warn(
          'ChartGPU 3D: appendData({ maxPoints }) is not supported for pointCloud3d in v1 (unbounded append); option ignored.'
        );
      }
      const result = coordinator.appendPointCloudData(seriesIndex, newPoints as PointCloud3DData);
      if (result && result.appended > 0) {
        emit('dataAppend', {
          seriesIndex,
          count: result.appended,
          xExtent: result.xExtent,
        });
      }
    },
    resize: () => resizeInternal(true),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      coordinator?.dispose();
      coordinator = null;
      if (gpuContext) {
        gpuContext.destroy();
        gpuContext = null;
      }
      if (canvas.parentElement === container) {
        container.removeChild(canvas);
      }
      for (const k of Object.keys(listeners)) listeners[k]!.clear();
    },
    on(eventName: ChartGPUEventName, callback: AnyCb) {
      listeners[eventName]?.add(callback);
    },
    off(eventName: ChartGPUEventName, callback: AnyCb) {
      listeners[eventName]?.delete(callback);
    },
    getInteractionX: () => null,
    setInteractionX() {
      /* no-op in 3D */
    },
    setCrosshairX() {
      /* no-op */
    },
    onInteractionXChange: () => () => {},
    getZoomRange: () => null,
    setZoomRange() {
      /* no-op — use setCamera / orbit */
    },
    getPerformanceMetrics: () => null,
    getPerformanceCapabilities: () => null,
    onPerformanceUpdate: () => () => {},
    hitTest(e: PointerEvent | MouseEvent): ChartGPUHitTestResult {
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const pick = coordinator?.pick(cssX, cssY, 12) ?? null;
      return {
        isInGrid: true,
        canvasX: cssX,
        canvasY: cssY,
        gridX: cssX,
        gridY: cssY,
        match: pick
          ? {
              kind: 'pointCloud3d',
              seriesIndex: pick.seriesIndex,
              dataIndex: pick.dataIndex,
              value: [pick.x, pick.y, pick.z],
              valueChannel: pick.value,
            }
          : null,
      };
    },
    getRenderMode: () => renderMode,
    setRenderMode(mode: RenderMode) {
      renderMode = mode;
      if (mode === 'auto' && dirty) requestRender();
    },
    renderFrame() {
      if (renderMode !== 'external') {
        return false;
      }
      if (!dirty) return false;
      doRender();
      return true;
    },
    needsRender: () => dirty,
    // 3D camera API (also attached below for typing)
    resetCamera() {
      coordinator?.resetCamera();
    },
    setCamera(partial: Chart3DCameraOptions) {
      coordinator?.setCamera(partial);
    },
    getCamera(): ResolvedCamera | null {
      return coordinator?.getCamera() ?? null;
    },
  } as ChartGPUInstance;

  try {
    resizeInternal(false);
    try {
      const dprOverride = createTimeExplicitDpr ?? undefined;
      const gpuContextOptions = context
        ? {
            device: context.device,
            adapter: context.adapter,
            ...(dprOverride != null ? { devicePixelRatio: dprOverride } : {}),
          }
        : dprOverride != null
          ? { devicePixelRatio: dprOverride }
          : undefined;
      gpuContext = await GPUContext.create(canvas, gpuContextOptions);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`ChartGPU: WebGPU is not available.\nReason: ${errorMessage}`);
    }

    gpuContext.device?.lost.then((info) => {
      deviceIsLost = true;
      if (disposed) return;
      if (info.reason !== 'destroyed') {
        console.warn('WebGPU device lost:', info);
      }
      if (isSharedDevice && info.reason !== 'destroyed') {
        emit('deviceLost', { reason: info.reason, message: info.message });
      }
      instance.dispose();
    });

    resizeInternal(false);

    coordinator = createRenderCoordinator3D(gpuContext, resolvedOptions, {
      onRequestRender: requestRender,
      pipelineCache: context?.pipelineCache,
    });

    if (renderMode === 'auto') requestRender();

    registerActive(instance);
    return instance;
  } catch (error) {
    instance.dispose();
    throw error;
  }
}

// silence unused type imports used only in append signature docs
void (0 as unknown as CartesianSeriesData);
void (0 as unknown as OHLCDataPoint);
