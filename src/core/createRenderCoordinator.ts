import type { ResolvedAreaSeriesConfig, ResolvedChartGPUOptions } from '../config/OptionResolver';
import type { DataPoint } from '../config/types';
import { createDataStore } from '../data/createDataStore';
import { createAxisRenderer } from '../renderers/createAxisRenderer';
import { createGridRenderer } from '../renderers/createGridRenderer';
import type { GridArea } from '../renderers/createGridRenderer';
import { createAreaRenderer } from '../renderers/createAreaRenderer';
import { createLineRenderer } from '../renderers/createLineRenderer';
import { createLinearScale } from '../utils/scales';
import type { LinearScale } from '../utils/scales';

export interface GPUContextLike {
  readonly device: GPUDevice | null;
  readonly canvas: HTMLCanvasElement | null;
  readonly canvasContext: GPUCanvasContext | null;
  readonly preferredFormat: GPUTextureFormat | null;
  readonly initialized: boolean;
}

export interface RenderCoordinator {
  setOptions(resolvedOptions: ResolvedChartGPUOptions): void;
  render(): void;
  dispose(): void;
}

type Bounds = Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

const DEFAULT_BACKGROUND_COLOR: GPUColor = { r: 0.1, g: 0.1, b: 0.15, a: 1.0 };

const assertUnreachable = (value: never): never => {
  // Intentionally minimal message: this is used for compile-time exhaustiveness.
  throw new Error(`RenderCoordinator: unreachable value: ${String(value)}`);
};

const isTupleDataPoint = (p: DataPoint): p is readonly [x: number, y: number] => Array.isArray(p);

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

export function createRenderCoordinator(gpuContext: GPUContextLike, options: ResolvedChartGPUOptions): RenderCoordinator {
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

  let disposed = false;
  let currentOptions: ResolvedChartGPUOptions = options;
  let lastSeriesCount = options.series.length;

  let dataStore = createDataStore(device);

  const gridRenderer = createGridRenderer(device, { targetFormat });
  const xAxisRenderer = createAxisRenderer(device, { targetFormat });
  const yAxisRenderer = createAxisRenderer(device, { targetFormat });

  const areaRenderers: Array<ReturnType<typeof createAreaRenderer>> = [];
  const lineRenderers: Array<ReturnType<typeof createLineRenderer>> = [];

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

  ensureAreaRendererCount(currentOptions.series.length);
  ensureLineRendererCount(currentOptions.series.length);

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('RenderCoordinator is disposed.');
  };

  const setOptions: RenderCoordinator['setOptions'] = (resolvedOptions) => {
    assertNotDisposed();
    currentOptions = resolvedOptions;

    const nextCount = resolvedOptions.series.length;
    ensureAreaRendererCount(nextCount);
    ensureLineRendererCount(nextCount);

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
      default:
        return assertUnreachable(series);
    }
  };

  const render: RenderCoordinator['render'] = () => {
    assertNotDisposed();
    if (!gpuContext.canvasContext || !gpuContext.canvas) return;

    const gridArea = computeGridArea(gpuContext, currentOptions);
    const { xScale, yScale } = computeScales(currentOptions, gridArea);

    gridRenderer.prepare(gridArea);
    xAxisRenderer.prepare(currentOptions.xAxis, xScale, 'x', gridArea);
    yAxisRenderer.prepare(currentOptions.yAxis, yScale, 'y', gridArea);

    const globalBounds = computeGlobalBounds(currentOptions.series);
    const defaultBaseline = currentOptions.yAxis.min ?? globalBounds.yMin;

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
        default:
          assertUnreachable(s);
      }
    }

    const textureView = gpuContext.canvasContext.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder({ label: 'renderCoordinator/commandEncoder' });

    const pass = encoder.beginRenderPass({
      label: 'renderCoordinator/renderPass',
      colorAttachments: [
        {
          view: textureView,
          clearValue: DEFAULT_BACKGROUND_COLOR,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    // Render order:
    // - grid first (background)
    // - area fills next (so they don't cover strokes/axes)
    // - line strokes next
    // - axes last (on top)
    gridRenderer.render(pass);

    for (let i = 0; i < currentOptions.series.length; i++) {
      if (shouldRenderArea(currentOptions.series[i])) {
        areaRenderers[i].render(pass);
      }
    }
    for (let i = 0; i < currentOptions.series.length; i++) {
      if (currentOptions.series[i].type === 'line') {
        lineRenderers[i].render(pass);
      }
    }

    xAxisRenderer.render(pass);
    yAxisRenderer.render(pass);

    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  const dispose: RenderCoordinator['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    for (let i = 0; i < areaRenderers.length; i++) {
      areaRenderers[i].dispose();
    }
    areaRenderers.length = 0;

    for (let i = 0; i < lineRenderers.length; i++) {
      lineRenderers[i].dispose();
    }
    lineRenderers.length = 0;

    gridRenderer.dispose();
    xAxisRenderer.dispose();
    yAxisRenderer.dispose();

    dataStore.dispose();
  };

  return { setOptions, render, dispose };
}

