import barWgsl from '../shaders/bar.wgsl?raw';
import type { ResolvedBarSeriesConfig } from '../config/OptionResolver';
import type { LinearScale } from '../utils/scales';
import type { GridArea } from './createGridRenderer';
import { parseCssColorToRgba01 } from '../utils/colors';
import type { DataStore } from '../data/createDataStore';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { getPointCount, getX, getY } from '../data/cartesianData';
import { bucketStackedXKey } from '../utils/barStackKey';
import type { PipelineCache } from '../core/PipelineCache';

export interface BarRenderer {
  prepare(
    seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
    dataStore: DataStore,
    xScale: LinearScale,
    yScale: LinearScale,
    gridArea: GridArea
  ): void;
  /**
   * Drop cached domain-space instance geometry so the next `prepare` re-packs.
   *
   * Required when values mutate under a stable data array reference (update-transition
   * interpolation reuses one array and mutates in place — same rule as
   * `lastSetSeriesCache.clear()` / area `invalidateGeometry()` in the coordinator).
   */
  invalidateGeometry(): void;
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
   * Multisample count for the render pipeline.
   *
   * Must match the render pass color attachment sampleCount.
   * Defaults to 1 (no MSAA).
   */
  readonly sampleCount?: number;
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
const parseSeriesColorToRgba01 = (color: string): Rgba => parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

/** Linear scale → clip affine: clip = a * domain + b (sample at v0, v1). */
const computeClipAffineFromScale = (
  scale: LinearScale,
  v0: number,
  v1: number
): { readonly a: number; readonly b: number } => {
  const p0 = scale.scale(v0);
  const p1 = scale.scale(v1);

  if (!Number.isFinite(v0) || !Number.isFinite(v1) || v0 === v1 || !Number.isFinite(p0) || !Number.isFinite(p1)) {
    return { a: 0, b: Number.isFinite(p0) ? p0 : 0 };
  }

  const a = (p1 - p0) / (v1 - v0);
  const b = p0 - a * v0;
  return { a: Number.isFinite(a) ? a : 0, b: Number.isFinite(b) ? b : 0 };
};

const writeTransformMat4F32 = (out: Float32Array, ax: number, bx: number, ay: number, by: number): void => {
  // Column-major mat4x4 for: clip = M * vec4(x, y, 0, 1)
  out[0] = ax;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0; // col0
  out[4] = 0;
  out[5] = ay;
  out[6] = 0;
  out[7] = 0; // col1
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0; // col2
  out[12] = bx;
  out[13] = by;
  out[14] = 0;
  out[15] = 1; // col3
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

const computePlotSizeCssPx = (
  gridArea: GridArea
): { readonly plotWidthCss: number; readonly plotHeightCss: number } | null => {
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
): {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
} => {
  const { left, right, top, bottom, canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeft = left * devicePixelRatio;
  const plotRight = canvasWidth - right * devicePixelRatio;
  const plotTop = top * devicePixelRatio;
  const plotBottom = canvasHeight - bottom * devicePixelRatio;

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

/**
 * Identity + layout signature for domain-space instance geometry.
 * Pure y-scale range changes that leave baselineDomain and domain bar widths
 * unchanged must NOT force a rebuild (axes-only SciChart column path).
 */
type GeometryCacheKey = {
  readonly seriesCount: number;
  readonly dataRefs: readonly unknown[];
  readonly dataLengths: readonly number[];
  readonly colors: readonly string[];
  readonly stacks: readonly string[];
  readonly barWidth: number | string | undefined;
  readonly barGap: number | undefined;
  readonly barCategoryGap: number | undefined;
  readonly baselineDomain: number;
  /**
   * Domain bar width after layout. For %/auto this is scale-independent.
   * For px barWidth it depends on x affine / plot size — compared each prepare.
   */
  readonly barWidthDomain: number;
  readonly categoryStep: number;
  readonly clusterCount: number;
  /** Sign of x-scale slope (+1 / -1); multi-series cluster offsets flip under reversed x. */
  readonly xDir: number;
  readonly instanceCount: number;
};

const nearEqualDomain = (a: number, b: number): boolean => {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
};

export function createBarRenderer(device: GPUDevice, options?: BarRendererOptions): BarRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw) ? Math.max(1, Math.floor(sampleCountRaw)) : 1;
  const pipelineCache = options?.pipelineCache;

  // WebGPU default maxBufferSize is 256 MiB. Bar instances are 32 B each; nextPow2
  // growth of a 10M-point column series would request 512 MiB → GPUValidationError
  // on Chrome/Metal (SciChart suite group 5 last row). Cap allocation + pack density.
  const maxBufferSizeRaw = device.limits?.maxBufferSize;
  const maxBufferSize =
    typeof maxBufferSizeRaw === 'number' && Number.isFinite(maxBufferSizeRaw) && maxBufferSizeRaw > 0
      ? maxBufferSizeRaw
      : 256 * 1024 * 1024;
  const maxInstancesByBuffer = Math.max(1, Math.floor(maxBufferSize / INSTANCE_STRIDE_BYTES));

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      },
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 64, {
    label: 'barRenderer/vsUniforms',
  });
  // Domain → clip affine written every prepare (not identity).
  const vsUniformScratchBuffer = new ArrayBuffer(64);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
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
          color: {
            operation: 'add',
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
          },
          alpha: {
            operation: 'add',
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha',
          },
        },
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  let instanceBuffer: GPUBuffer | null = null;
  let instanceCount = 0;
  let cpuInstanceStagingBuffer = new ArrayBuffer(0);
  let cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  const categoryXScratch: number[] = [];
  let geometryCache: GeometryCacheKey | null = null;

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

  // Issue 2.5: skip VS uniform write when affine unchanged.
  let lastAx = Number.NaN;
  let lastBx = Number.NaN;
  let lastAy = Number.NaN;
  let lastBy = Number.NaN;

  const writeVsUniforms = (ax: number, bx: number, ay: number, by: number): void => {
    if (lastAx === ax && lastBx === bx && lastAy === ay && lastBy === by) {
      return;
    }
    writeTransformMat4F32(vsUniformScratchF32, ax, bx, ay, by);
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
    lastAx = ax;
    lastBx = bx;
    lastAy = ay;
    lastBy = by;
  };

  /**
   * Minimum positive adjacent X gap across series (category width).
   *
   * At multi-million points a full collect+sort is O(N log N) and allocates a
   * huge scratch array — deadly for the SciChart suite 5M/10M column rows.
   * Prefer O(N) consecutive deltas (correct for ascending/time-series data);
   * only fall back to a bounded sort sample when a series is non-monotonic.
   */
  const computeBarCategoryStep = (seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>): number => {
    let minStep = Number.POSITIVE_INFINITY;
    let finiteCount = 0;
    let needsFullSortSample = false;

    for (let s = 0; s < seriesConfigs.length; s++) {
      const data = seriesConfigs[s].data;
      const count = getPointCount(data);
      let prev = Number.NaN;
      for (let i = 0; i < count; i++) {
        const x = getX(data, i);
        if (!Number.isFinite(x)) continue;
        finiteCount++;
        if (Number.isFinite(prev)) {
          const d = x - prev;
          if (d > 0 && d < minStep) minStep = d;
          else if (d < 0) needsFullSortSample = true;
        }
        prev = x;
      }
    }

    if (finiteCount < 2) return 1;

    if (!needsFullSortSample) {
      return Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
    }

    // Non-monotonic series: estimate min gap from a bounded sorted sample.
    categoryXScratch.length = 0;
    const sampleCap = 50_000;
    let seen = 0;
    for (let s = 0; s < seriesConfigs.length; s++) {
      const data = seriesConfigs[s].data;
      const count = getPointCount(data);
      const stride = count > sampleCap ? Math.ceil(count / sampleCap) : 1;
      for (let i = 0; i < count && categoryXScratch.length < sampleCap; i += stride) {
        const x = getX(data, i);
        if (Number.isFinite(x)) {
          categoryXScratch.push(x);
          seen++;
        }
      }
    }
    if (categoryXScratch.length < 2) {
      return Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
    }
    categoryXScratch.sort((a, b) => a - b);
    for (let i = 1; i < categoryXScratch.length; i++) {
      const d = categoryXScratch[i]! - categoryXScratch[i - 1]!;
      if (d > 0 && d < minStep) minStep = d;
    }
    void seen;
    return Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
  };

  const computeSharedBarLayout = (
    seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>
  ): {
    readonly barWidth?: number | string;
    readonly barGap?: number;
    readonly barCategoryGap?: number;
  } => {
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

  /**
   * Domain-space category / cluster layout widths.
   * % and auto widths are linear in categoryStep (scale-independent).
   * Numeric (CSS-px) widths convert via current x affine + plot CSS size.
   */
  const computeDomainBarLayout = (
    categoryStep: number,
    layout: {
      readonly barWidth?: number | string;
      readonly barGap?: number;
      readonly barCategoryGap?: number;
    },
    clusterCount: number,
    xScale: LinearScale,
    plotSize: { readonly plotWidthCss: number },
    plotClipRect: Readonly<{ left: number; right: number }>,
    fallbackCategoryCount: number
  ): {
    readonly barWidthDomain: number;
    readonly gapDomain: number;
    readonly clusterWidthDomain: number;
  } => {
    const barGap = clamp01(layout.barGap ?? DEFAULT_BAR_GAP);
    const barCategoryGap = clamp01(layout.barCategoryGap ?? DEFAULT_BAR_CATEGORY_GAP);

    // Category width in domain units (prefer data step; fall back to visible span / n).
    let categoryWidthDomain = 0;
    if (Number.isFinite(categoryStep) && categoryStep > 0) {
      categoryWidthDomain = categoryStep;
    } else {
      const xDomainA = xScale.invert(plotClipRect.left);
      const xDomainB = xScale.invert(plotClipRect.right);
      const span = Math.abs(xDomainB - xDomainA);
      const n = Math.max(1, Math.floor(fallbackCategoryCount));
      categoryWidthDomain = span > 0 ? span / n : 1;
    }

    const categoryInnerWidthDomain = Math.max(0, categoryWidthDomain * (1 - barCategoryGap));
    const denom = clusterCount + Math.max(0, clusterCount - 1) * barGap;
    const maxBarWidthDomain = denom > 0 ? categoryInnerWidthDomain / denom : 0;

    let barWidthDomain = 0;
    const rawBarWidth = layout.barWidth;
    if (typeof rawBarWidth === 'number') {
      // CSS-px width → domain via current x scale (not linear under pure zoom alone).
      const plotClipWidth = plotClipRect.right - plotClipRect.left;
      const clipPerCssX = plotSize.plotWidthCss > 0 ? plotClipWidth / plotSize.plotWidthCss : 0;
      const { a: ax } = computeClipAffineFromScale(xScale, 0, 1);
      const absAx = Math.abs(ax);
      const widthClip = Math.max(0, rawBarWidth) * clipPerCssX;
      barWidthDomain = absAx > 0 && Number.isFinite(absAx) ? widthClip / absAx : 0;
      barWidthDomain = Math.min(barWidthDomain, maxBarWidthDomain);
    } else if (typeof rawBarWidth === 'string') {
      const p = parsePercent(rawBarWidth);
      barWidthDomain = p == null ? 0 : maxBarWidthDomain * clamp01(p);
    }

    if (!(barWidthDomain > 0)) {
      // Auto-width: max per-bar width that still avoids overlap.
      barWidthDomain = maxBarWidthDomain;
    }

    const gapDomain = barWidthDomain * barGap;
    const clusterWidthDomain = clusterCount * barWidthDomain + Math.max(0, clusterCount - 1) * gapDomain;

    return { barWidthDomain, gapDomain, clusterWidthDomain };
  };

  const seriesIdentityMatches = (
    seriesConfigs: ReadonlyArray<ResolvedBarSeriesConfig>,
    cache: GeometryCacheKey
  ): boolean => {
    if (seriesConfigs.length !== cache.seriesCount) return false;
    for (let i = 0; i < seriesConfigs.length; i++) {
      const s = seriesConfigs[i];
      if (s.data !== cache.dataRefs[i]) return false;
      if (getPointCount(s.data) !== cache.dataLengths[i]) return false;
      if (s.color !== cache.colors[i]) return false;
      if (normalizeStackId(s.stack) !== cache.stacks[i]) return false;
    }
    return true;
  };

  const prepare: BarRenderer['prepare'] = (seriesConfigs, _dataStore, xScale, yScale, gridArea) => {
    assertNotDisposed();
    // dataStore reserved for future shared residency; bars pack privately today.

    const clearGeometry = (): void => {
      instanceCount = 0;
      geometryCache = null;
      if (instanceBuffer) {
        try {
          instanceBuffer.destroy();
        } catch {
          // best-effort
        }
        instanceBuffer = null;
      }
    };

    if (seriesConfigs.length === 0) {
      // Drop GPU instance buffer on empty prepare (no lingering draw capacity).
      clearGeometry();
      return;
    }

    const plotSize = computePlotSizeCssPx(gridArea);
    if (!plotSize) {
      clearGeometry();
      return;
    }

    const plotClipRect = computePlotClipRect(gridArea);

    // Domain → clip affine always (yMin/yMax-only setOption updates uniforms only).
    // Sample at (0, 1) like line renderer — works for any linear scale including
    // intro-animated bar y-scale wrappers (still affine toward baseline).
    const { a: ax, b: bx } = computeClipAffineFromScale(xScale, 0, 1);
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, 0, 1);
    writeVsUniforms(ax, bx, ay, by);
    // Cluster offsets are applied in domain then transformed; flip order under reversed x
    // so clip-space series order matches the pre-domain-pack layout.
    const xDir = ax < 0 ? -1 : 1;

    // Cluster slots (O(series)):
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

    const layout = computeSharedBarLayout(seriesConfigs);
    // Axis-aware baseline; require a finite mapped clip value (pathological scales).
    let baselineDomain = computeBaselineForBarsFromAxis(seriesConfigs, yScale, plotClipRect);
    let baselineClip = yScale.scale(baselineDomain);
    if (!Number.isFinite(baselineDomain) || !Number.isFinite(baselineClip)) {
      baselineDomain = computeBaselineForBarsFromData(seriesConfigs);
      baselineClip = yScale.scale(baselineDomain);
    }
    if (!Number.isFinite(baselineDomain) || !Number.isFinite(baselineClip)) {
      baselineDomain = 0;
      baselineClip = yScale.scale(0);
    }
    if (!Number.isFinite(baselineDomain) || !Number.isFinite(baselineClip)) {
      clearGeometry();
      return;
    }

    const identityMatches = geometryCache != null && seriesIdentityMatches(seriesConfigs, geometryCache);

    // Fast path: reuse domain instance buffer when data identity + domain layout match.
    // Do not recompute categoryStep (O(n)) on a cache hit.
    if (geometryCache && instanceBuffer && identityMatches) {
      const sameLayoutOptions =
        geometryCache.barWidth === layout.barWidth &&
        geometryCache.barGap === layout.barGap &&
        geometryCache.barCategoryGap === layout.barCategoryGap &&
        geometryCache.clusterCount === clusterCount &&
        geometryCache.baselineDomain === baselineDomain &&
        geometryCache.xDir === xDir;

      if (sameLayoutOptions) {
        // For px widths, domain bar width tracks x-scale / plot size — recompute O(1).
        let barWidthDomainOk = true;
        if (typeof layout.barWidth === 'number') {
          const domainLayout = computeDomainBarLayout(
            geometryCache.categoryStep,
            layout,
            clusterCount,
            xScale,
            plotSize,
            plotClipRect,
            1
          );
          barWidthDomainOk = nearEqualDomain(domainLayout.barWidthDomain, geometryCache.barWidthDomain);
        }
        if (barWidthDomainOk) {
          instanceCount = geometryCache.instanceCount;
          return;
        }
      }
    }

    // Full rebuild path.
    let fallbackCategoryCount = 1;
    for (let s = 0; s < seriesConfigs.length; s++) {
      const dataLength = getPointCount(seriesConfigs[s].data);
      fallbackCategoryCount = Math.max(fallbackCategoryCount, Math.floor(dataLength));
    }

    // Reuse categoryStep when data identity matches prior cache (skip O(n) sort).
    const categoryStep =
      geometryCache && identityMatches ? geometryCache.categoryStep : computeBarCategoryStep(seriesConfigs);

    const { barWidthDomain, gapDomain, clusterWidthDomain } = computeDomainBarLayout(
      categoryStep,
      layout,
      clusterCount,
      xScale,
      plotSize,
      plotClipRect,
      fallbackCategoryCount
    );

    // Density stride: when N×32B would exceed maxBufferSize (10M columns → 320MB
    // raw, 512MB after nextPow2), keep ≤ maxInstancesByBuffer and widen bars so
    // the silhouette still fills the plot (SciChart suite group 5 last row).
    //
    // Per-series fair budgets: a shared global packCap + sequential fill can fully
    // drop trailing series (sum-of-counts stride + early break). Give each series
    // at least floor(maxInstances / seriesCount) slots and stride independently.
    // Stacked series sharing a stackId still use one x-stride (max count in stack)
    // so segment indices stay aligned.
    const seriesCountForPack = Math.max(1, seriesConfigs.length);
    const perSeriesCap = Math.max(1, Math.floor(maxInstancesByBuffer / seriesCountForPack));
    const packCap = Math.min(maxInstancesByBuffer, seriesCountForPack * perSeriesCap);

    const seriesPointCounts: number[] = new Array(seriesConfigs.length);
    const stackMaxCount = new Map<string, number>();
    for (let s = 0; s < seriesConfigs.length; s++) {
      const count = Math.max(0, getPointCount(seriesConfigs[s].data));
      seriesPointCounts[s] = count;
      const stackId = normalizeStackId(seriesConfigs[s].stack);
      if (stackId !== '') {
        const prev = stackMaxCount.get(stackId) ?? 0;
        if (count > prev) stackMaxCount.set(stackId, count);
      }
    }

    const densityStrides: number[] = new Array(seriesConfigs.length);
    for (let s = 0; s < seriesConfigs.length; s++) {
      const stackId = normalizeStackId(seriesConfigs[s].stack);
      const countForStride =
        stackId !== '' ? (stackMaxCount.get(stackId) ?? seriesPointCounts[s]!) : seriesPointCounts[s]!;
      densityStrides[s] = countForStride > perSeriesCap ? Math.ceil(countForStride / perSeriesCap) : 1;
    }

    ensureCpuInstanceCapacityFloats(packCap * INSTANCE_STRIDE_FLOATS);
    const f32 = cpuInstanceStagingF32;
    let outFloats = 0;
    const maxOutFloats = packCap * INSTANCE_STRIDE_FLOATS;

    // Per-stack, per-x running sums in domain units (supports negative stacking too).
    const stackSumsByStackId = new Map<string, Map<number, { posSum: number; negSum: number }>>();

    const dataRefs: unknown[] = new Array(seriesConfigs.length);
    const dataLengths: number[] = new Array(seriesConfigs.length);
    const colors: string[] = new Array(seriesConfigs.length);
    const stacks: string[] = new Array(seriesConfigs.length);

    for (let seriesIndex = 0; seriesIndex < seriesConfigs.length; seriesIndex++) {
      const series = seriesConfigs[seriesIndex];
      const data = series.data;
      dataRefs[seriesIndex] = data;
      dataLengths[seriesIndex] = seriesPointCounts[seriesIndex]!;
      colors[seriesIndex] = series.color;
      const stackId = normalizeStackId(series.stack);
      stacks[seriesIndex] = stackId;

      const [r, g, b, a] = parseSeriesColorToRgba01(series.color);
      const clusterIndex = clusterIndexBySeries[seriesIndex] ?? 0;

      const count = seriesPointCounts[seriesIndex]!;
      const densityStride = densityStrides[seriesIndex]!;
      // Widen this series' bars by its density stride (stacked peers share stride).
      const packBarWidthDomain = barWidthDomain * densityStride;
      const packGapDomain = gapDomain * densityStride;
      const packClusterWidthDomain = clusterWidthDomain * densityStride;
      // Independent per-series budget — do not let earlier series consume the global pack.
      const seriesMaxOutFloats = Math.min(
        maxOutFloats,
        outFloats + perSeriesCap * INSTANCE_STRIDE_FLOATS
      );

      for (let i = 0; i < count; i += densityStride) {
        if (outFloats >= seriesMaxOutFloats) break;

        const x = getX(data, i);
        const y = getY(data, i);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

        // Cluster is always centered on domain x (left = x - CW/2 + slot*idx).
        // Under reversed x (xDir < 0), mirror slot index so series 0 stays left
        // in clip without shifting the single-series center (idx stays 0).
        const effectiveClusterIndex = xDir < 0 ? clusterCount - 1 - clusterIndex : clusterIndex;
        const left =
          x - packClusterWidthDomain / 2 + effectiveClusterIndex * (packBarWidthDomain + packGapDomain);

        let baseDomain = baselineDomain;
        let heightDomain = 0;

        if (stackId !== '') {
          let sumsForX = stackSumsByStackId.get(stackId);
          if (!sumsForX) {
            sumsForX = new Map<number, { posSum: number; negSum: number }>();
            stackSumsByStackId.set(stackId, sumsForX);
          }

          // Shared with hit-test via utils/barStackKey (domain category step first).
          const xKey = bucketStackedXKey(0, 0, x, categoryStep);

          let sums = sumsForX.get(xKey);
          if (!sums) {
            sums = { posSum: baselineDomain, negSum: baselineDomain };
            sumsForX.set(xKey, sums);
          }

          // Stack upward for y>=0, downward for y<0 (domain units).
          let segmentBase: number;
          let segmentTop: number;
          if (y >= 0) {
            segmentBase = sums.posSum;
            segmentTop = segmentBase + y;
            sums.posSum = segmentTop;
          } else {
            segmentBase = sums.negSum;
            segmentTop = segmentBase + y;
            sums.negSum = segmentTop;
          }

          baseDomain = segmentBase;
          heightDomain = segmentTop - segmentBase;
        } else {
          heightDomain = y - baselineDomain;
        }

        f32[outFloats + 0] = left;
        f32[outFloats + 1] = baseDomain;
        f32[outFloats + 2] = packBarWidthDomain;
        f32[outFloats + 3] = heightDomain;
        f32[outFloats + 4] = r;
        f32[outFloats + 5] = g;
        f32[outFloats + 6] = b;
        f32[outFloats + 7] = a;
        outFloats += INSTANCE_STRIDE_FLOATS;
      }
    }

    // If we skipped invalid points, resize the effective instance count.
    instanceCount = outFloats / INSTANCE_STRIDE_FLOATS;
    // Hard cap: never write more instances than fit in maxBufferSize.
    if (instanceCount > maxInstancesByBuffer) {
      instanceCount = maxInstancesByBuffer;
    }
    const requiredBytes = Math.max(4, instanceCount * INSTANCE_STRIDE_BYTES);

    if (!instanceBuffer || instanceBuffer.size < requiredBytes) {
      // Prefer geometric growth, but never exceed maxBufferSize (createBuffer
      // validation). When nextPow2 would overshoot, fall back to exact required.
      let grownBytes = Math.max(Math.max(4, nextPow2(requiredBytes)), instanceBuffer ? instanceBuffer.size : 0);
      if (grownBytes > maxBufferSize) {
        grownBytes = Math.min(maxBufferSize, Math.max(4, requiredBytes));
      }
      // Align size to 4 bytes (WebGPU writeBuffer / buffer size rule).
      grownBytes = Math.max(4, Math.ceil(grownBytes / 4) * 4);
      if (grownBytes > maxBufferSize) {
        grownBytes = Math.floor(maxBufferSize / 4) * 4;
      }
      if (instanceCount * INSTANCE_STRIDE_BYTES > grownBytes) {
        instanceCount = Math.floor(grownBytes / INSTANCE_STRIDE_BYTES);
      }
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

    geometryCache = {
      seriesCount: seriesConfigs.length,
      dataRefs,
      dataLengths,
      colors,
      stacks,
      barWidth: layout.barWidth,
      barGap: layout.barGap,
      barCategoryGap: layout.barCategoryGap,
      baselineDomain,
      barWidthDomain,
      categoryStep,
      clusterCount,
      xDir,
      instanceCount,
    };
  };

  const invalidateGeometry: BarRenderer['invalidateGeometry'] = () => {
    // Keep GPU buffers; only clear identity so prepare re-packs domain instances.
    geometryCache = null;
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
    geometryCache = null;

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

  return { prepare, invalidateGeometry, render, dispose };
}
