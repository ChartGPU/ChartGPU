import { GPUContext } from './core/GPUContext';
import { createRenderCoordinator } from './core/createRenderCoordinator';
import type { RenderCoordinator } from './core/createRenderCoordinator';
import { resolveOptions } from './config/OptionResolver';
import type { ResolvedChartGPUOptions } from './config/OptionResolver';
import type { ChartGPUOptions } from './config/types';

export interface ChartGPUInstance {
  readonly options: Readonly<ChartGPUOptions>;
  readonly disposed: boolean;
  setOption(options: ChartGPUOptions): void;
  resize(): void;
  dispose(): void;
}

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

  let currentOptions: ChartGPUOptions = options;
  let resolvedOptions: ResolvedChartGPUOptions = {
    ...resolveOptions(currentOptions),
    tooltip: currentOptions.tooltip,
  };

  let scheduledRaf: number | null = null;
  let lastConfigured: { width: number; height: number; format: GPUTextureFormat } | null = null;

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

  const recreateCoordinator = (): void => {
    if (disposed) return;
    if (!gpuContext || !gpuContext.initialized) return;

    coordinator?.dispose();
    coordinator = createRenderCoordinator(gpuContext, resolvedOptions, { onRequestRender: requestRender });
    coordinatorTargetFormat = gpuContext.preferredFormat;
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

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    try {
      // Requirement: dispose order: cancel RAF, coordinator.dispose(), gpuContext.destroy(), remove canvas.
      cancelPendingFrame();
      coordinator?.dispose();
      coordinator = null;
      coordinatorTargetFormat = null;
      gpuContext?.destroy();
    } finally {
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

      // Requirement: setOption triggers a render (and thus series parsing/extent/scales update inside render).
      requestRender();
    },
    resize,
    dispose,
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

