import barWgsl from '../shaders/bar.wgsl?raw';
import type { ResolvedBarSeriesConfig } from '../config/OptionResolver';
import type { LinearScale } from '../utils/scales';
import type { GridArea } from './createGridRenderer';
import { parseCssColorToRgba01 } from '../utils/colors';
import type { DataStore } from '../data/createDataStore';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { getPointCount, getX, getY } from '../data/cartesianData';
import type { PipelineCache } from '../core/PipelineCache';

export interface BarRenderer {
  prepare(
    seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
    dataStore: DataStore,
    xScale: LinearScale,
    yScale: LinearScale,
    gridArea: GridArea
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface BarRendererOptions {
  /**
   * Must match the canvas context format used for the render pass color attachment.
   * Usually this is `gpuContext.preferredFormat`.
   *
   * Defaults to `'bgra8unorm'` for backward compatibility.
   */
  readonly targetFormat?: GPUTextureFormat;
  /**
   * Optional shared cache for shader modules + render pipelines.
   */
  readonly pipelineCache?: PipelineCache;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_BAR_GAP = 0.01; // Minimal gap between bars within a group (was 0.1)
const DEFAULT_BAR_CATEGORY_GAP = 0.2;
const INSTANCE_STRIDE_BYTES = 32; // rect vec4 + color vec4
const INSTANCE_STRIDE_FLOATS = INSTANCE_STRIDE_BYTES / 4;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const parseSeriesColorToRgba01 = (color: string): Rgba =>
  parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

const createIdentityMat4Buffer = (): ArrayBuffer => {
  // Column-major identity mat4x4
  const buffer = new ArrayBuffer(16 * 4);
  new Float32Array(buffer).set([
    1, 0, 0, 0, // col0
    0, 1, 0, 0, // col1
    0, 0, 1, 0, // col2
    0, 0, 0, 1, // col3
  ]);
  return buffer;
};

const parsePercent = (value: string): number | null => {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
  if (!m) return null;
  const p = Number(m[1]) / 100;
  return Number.isFinite(p) ? p : null;
};

const normalizeStackId = (stack: unknown): string => {
  if (typeof stack !== 'string') return '';
  const trimmed = stack.trim();
  return trimmed.length > 0 ? trimmed : '';
};

const computePlotSizeCssPx = (gridArea: GridArea): { readonly plotWidthCss: number; readonly plotHeightCss: number } | null => {
  const dpr = gridArea.devicePixelRatio;
  if (!(dpr > 0)) return null;
  const canvasCssWidth = gridArea.canvasWidth / dpr;
  const canvasCssHeight = gridArea.canvasHeight / dpr;
  const plotWidthCss = canvasCssWidth - gridArea.left - gridArea.right;
  const plotHeightCss = canvasCssHeight - gridArea.top - gridArea.bottom;
  if (!(plotWidthCss > 0) || !(plotHeightCss > 0)) return null;
  return { plotWidthCss, plotHeightCss };
};

const computePlotClipRect = (
  gridArea: GridArea
): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } => {
  const { left, right, top, bottom, canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeft = left * devicePixelRatio;
  const plotRight = canvasWidth - right * devicePixelRatio;
  const plotTop = top * devicePixelRatio;
  const plotBottom = canvasHeight - bottom * devicePixelRatio;

  const plotLeftClip = (plotLeft / canvasWidth) * 2.0 - 1.0;
  const plotRightClip = (plotRight / canvasWidth) * 2.0 - 1.0;
  const plotTopClip = 1.0 - (plotTop / canvasHeight) * 2.0; // flip Y
  const plotBottomClip = 1.0 - (plotBottom / canvasHeight) * 2.0; // flip Y

  return { left: plotLeftClip, right: plotRightClip, top: plotTopClip, bottom: plotBottomClip };
};

const computeCategoryWidthClip = (
  xScale: LinearScale,
  categoryStep: number,
  plotClipRect: Readonly<{ left: number; right: number }>,
  fallbackCategoryCount: number
): number => {
  if (Number.isFinite(categoryStep) && categoryStep > 0) {
    const x0 = 0;
    const p0 = xScale.scale(x0);
    const p1 = xScale.scale(x0 + categoryStep);
    const w = Math.abs(p1 - p0);
    if (Number.isFinite(w) && w > 0) return w;
  }

  const clipWidth = Math.abs(plotClipRect.right - plotClipRect.left);
  if (!(clipWidth > 0)) return 0;
  const n = Math.max(1, Math.floor(fallbackCategoryCount));
  return clipWidth / n;
};

export function createBarRenderer(device: GPUDevice, options?: BarRendererOptions): BarRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 64, { label: 'barRenderer/vsUniforms' });
  // Default to identity: we upload rects in clip-space.
  writeUniformBuffer(device, vsUniformBuffer, createIdentityMat4Buffer());

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
    ],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'barRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: barWgsl,
        label: 'bar.wgsl',
        buffers: [
          {
            arrayStride: INSTANCE_STRIDE_BYTES, // rect vec4 + color vec4
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, format: 'float32x4', offset: 0 },
              { shaderLocation: 1, format: 'float32x4', offset: 16 },
            ],
          },
        ],
      },
      fragment: {
        code: barWgsl,
        label: 'bar.wgsl',
        formats: targetFormat,
        blend: {
          color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: 1 },
    },
    pipelineCache
  );

  let instanceBuffer: GPUBuffer | null = null;
  let instanceCount = 0;
  let cpuInstanceStagingBuffer = new ArrayBuffer(0);
  let cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  const categoryXScratch: number[] = [];

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('BarRenderer is disposed.');
  };

  const ensureCpuInstanceCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuInstanceStagingF32.length) return;
    // Grow geometrically (power-of-two) to reduce churn.
    const nextFloats = Math.max(8, nextPow2(requiredFloats));
    cpuInstanceStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  };

  const computeBarCategoryStep = (seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>): number => {
    categoryXScratch.length = 0;
    for (let s = 0; s < seriesConfigs.length; s++) {
      const data = seriesConfigs[s].data;
      const count = getPointCount(data);
      for (let i = 0; i < count; i++) {
        const x = getX(data, i);
        if (Number.isFinite(x)) categoryXScratch.push(x);
      }
    }

    if (categoryXScratch.length < 2) return 1;
    categoryXScratch.sort((a, b) => a - b);

    let minStep = Number.POSITIVE_INFINITY;
    for (let i = 1; i < categoryXScratch.length; i++) {
      const d = categoryXScratch[i] - categoryXScratch[i - 1];
      if (d > 0 && d < minStep) minStep = d;
    }
    return Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
  };

  const computeSharedBarLayout = (
    seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>
  ): { readonly barWidth?: number | string; readonly barGap?: number; readonly barCategoryGap?: number } => {
    let barWidth: number | string | undefined = undefined;
    let barGap: number | undefined = undefined;
    let barCategoryGap: number | undefined = undefined;

    for (let i = 0; i < seriesConfigs.length; i++) {
      const s = seriesConfigs[i];
      if (barWidth === undefined && s.barWidth !== undefined) barWidth = s.barWidth;
      if (barGap === undefined && s.barGap !== undefined) barGap = s.barGap;
      if (barCategoryGap === undefined && s.barCategoryGap !== undefined) barCategoryGap = s.barCategoryGap;
    }

    return { barWidth, barGap, barCategoryGap };
  };

  const computeBaselineForBarsFromData = (seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>): number => {
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;

    for (let s = 0; s < seriesConfigs.length; s++) {
      const data = seriesConfigs[s].data;
      const count = getPointCount(data);
      for (let i = 0; i < count; i++) {
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
    plotClipRect: Readonly<{ top: number; bottom: number }>
  ): number => {
    // Determine the visible y-domain from the yScale + plot clip rect (clip-space).
    const yDomainA = yScale.invert(plotClipRect.bottom);
    const yDomainB = yScale.invert(plotClipRect.top);
    const yMin = Math.min(yDomainA, yDomainB);
    const yMax = Math.max(yDomainA, yDomainB);

    // If scale/range is degenerate, fall back.
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      return computeBaselineForBarsFromData(seriesConfigs);
    }

    if (yMin <= 0 && 0 <= yMax) return 0;
    if (yMin > 0) return yMin;
    if (yMax < 0) return yMax;

    // Should be unreachable with finite min/max, but keep a safe fallback.
    return computeBaselineForBarsFromData(seriesConfigs);
  };

  const prepare: BarRenderer['prepare'] = (seriesConfigs, dataStore, xScale, yScale, gridArea) => {
    assertNotDisposed();
    void dataStore;

    if (seriesConfigs.length === 0) {
      instanceCount = 0;
      return;
    }

    const plotSize = computePlotSizeCssPx(gridArea);
    if (!plotSize) {
      instanceCount = 0;
      return;
    }

    const plotClipRect = computePlotClipRect(gridArea);
    const plotClipWidth = plotClipRect.right - plotClipRect.left;
    const plotClipHeight = plotClipRect.top - plotClipRect.bottom;
    const clipPerCssX = plotSize.plotWidthCss > 0 ? plotClipWidth / plotSize.plotWidthCss : 0;
    void plotClipHeight; // reserved for future y-size conversions (e.g. border radius)

    // Cluster slots:
    // - Each unique non-empty stackId gets a single cluster slot.
    // - Each unstacked series gets its own cluster slot.
    const stackIdToClusterIndex = new Map<string, number>();
    const clusterIndexBySeries: number[] = new Array(seriesConfigs.length);
    let clusterCount = 0;
    for (let i = 0; i < seriesConfigs.length; i++) {
      const stackId = normalizeStackId(seriesConfigs[i].stack);
      if (stackId !== '') {
        const existing = stackIdToClusterIndex.get(stackId);
        if (existing !== undefined) {
          clusterIndexBySeries[i] = existing;
        } else {
          const idx = clusterCount++;
          stackIdToClusterIndex.set(stackId, idx);
          clusterIndexBySeries[i] = idx;
        }
      } else {
        clusterIndexBySeries[i] = clusterCount++;
      }
    }
    clusterCount = Math.max(1, clusterCount);

    const categoryStep = computeBarCategoryStep(seriesConfigs);
    const layout = computeSharedBarLayout(seriesConfigs);
    const barGap = clamp01(layout.barGap ?? DEFAULT_BAR_GAP);
    const barCategoryGap = clamp01(layout.barCategoryGap ?? DEFAULT_BAR_CATEGORY_GAP);

    let fallbackCategoryCount = 1;
    for (let s = 0; s < seriesConfigs.length; s++) {
      const dataLength = getPointCount(seriesConfigs[s].data);
      fallbackCategoryCount = Math.max(fallbackCategoryCount, Math.floor(dataLength));
    }

    const categoryWidthClip = computeCategoryWidthClip(xScale, categoryStep, plotClipRect, fallbackCategoryCount);
    const categoryInnerWidthClip = Math.max(0, categoryWidthClip * (1 - barCategoryGap));

    const denom = clusterCount + Math.max(0, clusterCount - 1) * barGap;
    const maxBarWidthClip = denom > 0 ? categoryInnerWidthClip / denom : 0;

    let barWidthClip = 0;
    const rawBarWidth = layout.barWidth;
    if (typeof rawBarWidth === 'number') {
      barWidthClip = Math.max(0, rawBarWidth) * clipPerCssX;
      barWidthClip = Math.min(barWidthClip, maxBarWidthClip);
    } else if (typeof rawBarWidth === 'string') {
      const p = parsePercent(rawBarWidth);
      barWidthClip = p == null ? 0 : maxBarWidthClip * clamp01(p);
    }

    if (!(barWidthClip > 0)) {
      // Auto-width: max per-bar width that still avoids overlap (given clusterCount and barGap).
      barWidthClip = maxBarWidthClip;
    }

    const gapClip = barWidthClip * barGap;
    const clusterWidthClip = clusterCount * barWidthClip + Math.max(0, clusterCount - 1) * gapClip;

    let baselineDomain = computeBaselineForBarsFromAxis(seriesConfigs, yScale, plotClipRect);
    let baselineClip = yScale.scale(baselineDomain);
    if (!Number.isFinite(baselineClip)) {
      // Fallback for pathological scales: revert to data-derived baseline, then 0.
      const fallbackBaselineDomain = computeBaselineForBarsFromData(seriesConfigs);
      baselineDomain = fallbackBaselineDomain;
      baselineClip = yScale.scale(fallbackBaselineDomain);
      if (!Number.isFinite(baselineClip)) {
        baselineDomain = 0;
        baselineClip = yScale.scale(0);
      }
      if (!Number.isFinite(baselineClip)) {
        instanceCount = 0;
        return;
      }
    }

    let maxBars = 0;
    for (let s = 0; s < seriesConfigs.length; s++) {
      maxBars += Math.max(0, getPointCount(seriesConfigs[s].data));
    }

    ensureCpuInstanceCapacityFloats(maxBars * INSTANCE_STRIDE_FLOATS);
    const f32 = cpuInstanceStagingF32;
    let outFloats = 0;

    // Per-stack, per-x running sums in domain units (supports negative stacking too).
    const stackSumsByStackId = new Map<string, Map<number, { posSum: number; negSum: number }>>();

    for (let seriesIndex = 0; seriesIndex < seriesConfigs.length; seriesIndex++) {
      const series = seriesConfigs[seriesIndex];
      const data = series.data;
      const [r, g, b, a] = parseSeriesColorToRgba01(series.color);
      const stackId = normalizeStackId(series.stack);
      const clusterIndex = clusterIndexBySeries[seriesIndex] ?? 0;

      const count = getPointCount(data);
      for (let i = 0; i < count; i++) {
        const x = getX(data, i);
        const y = getY(data, i);
        const xClipCenter = xScale.scale(x);
        if (!Number.isFinite(xClipCenter) || !Number.isFinite(y)) continue;

        const left = xClipCenter - clusterWidthClip / 2 + clusterIndex * (barWidthClip + gapClip);

        let baseClip = baselineClip;
        let height = 0;

        if (stackId !== '') {
          let sumsForX = stackSumsByStackId.get(stackId);
          if (!sumsForX) {
            sumsForX = new Map<number, { posSum: number; negSum: number }>();
            stackSumsByStackId.set(stackId, sumsForX);
          }

          // NOTE: Never key stacks by raw `x` (float equality is fragile). Instead, compute a stable
          // integer "category" key so visually-equivalent bars stack together even with tiny noise.
          let xKey: number;
          if (Number.isFinite(categoryWidthClip) && categoryWidthClip > 0 && Number.isFinite(xClipCenter)) {
            xKey = Math.round((xClipCenter - plotClipRect.left) / categoryWidthClip);
          } else if (Number.isFinite(categoryStep) && categoryStep > 0) {
            xKey = Math.round(x / categoryStep);
          } else {
            // Last-resort: stable-ish quantization in domain space.
            xKey = Math.round(x * 1e6);
          }

          let sums = sumsForX.get(xKey);
          if (!sums) {
            sums = { posSum: baselineDomain, negSum: baselineDomain };
            sumsForX.set(xKey, sums);
          }

          // Stack upward for y>=0, downward for y<0 (domain units).
          let baseDomain: number;
          let topDomain: number;
          if (y >= 0) {
            baseDomain = sums.posSum;
            topDomain = baseDomain + y;
            sums.posSum = topDomain;
          } else {
            baseDomain = sums.negSum;
            topDomain = baseDomain + y;
            sums.negSum = topDomain;
          }

          const bClip = yScale.scale(baseDomain);
          const tClip = yScale.scale(topDomain);
          if (!Number.isFinite(bClip) || !Number.isFinite(tClip)) continue;
          baseClip = bClip;
          height = tClip - bClip;
        } else {
          const yClip = yScale.scale(y);
          if (!Number.isFinite(yClip)) continue;
          height = yClip - baselineClip;
        }

        f32[outFloats + 0] = left;
        f32[outFloats + 1] = baseClip;
        f32[outFloats + 2] = barWidthClip;
        f32[outFloats + 3] = height;
        f32[outFloats + 4] = r;
        f32[outFloats + 5] = g;
        f32[outFloats + 6] = b;
        f32[outFloats + 7] = a;
        outFloats += INSTANCE_STRIDE_FLOATS;
      }
    }

    // If we skipped invalid points, resize the effective instance count.
    instanceCount = outFloats / INSTANCE_STRIDE_FLOATS;
    const requiredBytes = Math.max(4, instanceCount * INSTANCE_STRIDE_BYTES);

    if (!instanceBuffer || instanceBuffer.size < requiredBytes) {
      const grownBytes = Math.max(Math.max(4, nextPow2(requiredBytes)), instanceBuffer ? instanceBuffer.size : 0);
      if (instanceBuffer) {
        try {
          instanceBuffer.destroy();
        } catch {
          // best-effort
        }
      }
      instanceBuffer = device.createBuffer({
        label: 'barRenderer/instanceBuffer',
        size: grownBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    if (instanceCount > 0) {
      device.queue.writeBuffer(instanceBuffer, 0, cpuInstanceStagingBuffer, 0, instanceCount * INSTANCE_STRIDE_BYTES);
    }
  };

  const render: BarRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (!instanceBuffer || instanceCount === 0) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, instanceBuffer);
    passEncoder.draw(6, instanceCount);
  };

  const dispose: BarRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    if (instanceBuffer) {
      try {
        instanceBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    instanceBuffer = null;
    instanceCount = 0;

    try {
      vsUniformBuffer.destroy();
    } catch {
      // best-effort
    }
  };

  return { prepare, render, dispose };
}

