import areaWgsl from '../shaders/area.wgsl?raw';
import areaStackedWgsl from '../shaders/areaStacked.wgsl?raw';
import type { ResolvedAreaSeriesConfig } from '../config/OptionResolver';
import type { CartesianSeriesData } from '../config/types';
import type { ContinuousScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import {
  getPointCount,
  getX,
  getY,
  computeRawBoundsFromCartesianData,
  isStagingRingView,
  isRingXYColumns,
} from '../data/cartesianData';
import type { PipelineCache } from '../core/PipelineCache';
import {
  computeClipAffineFromContinuousScale,
  computeClipAffineFromScale,
  computePackedXAffineFromScale,
  resolveLogProjection,
} from './packedXAffine';
import { resolveAreaDrawPolicy } from './areaDrawPolicy';

/**
 * Optional stacked mountain geometry: per-point floor (yBottom) and ceiling (yTop).
 * When set, AreaRenderer private-packs AreaPoint stride-4 and ignores shared storageBuffer
 * (composition baselines cannot share the line vec2 layout).
 */
export type AreaStackGeometry = Readonly<{
  /** Per-point floor in data space. Length must equal point count. */
  yBottom: ArrayLike<number>;
  /**
   * Per-point top in data space. When omitted, uses series y as top
   * (yTop = yBottom + contribution already applied by caller into data.y).
   */
  yTop?: ArrayLike<number>;
}>;

/** Optional draw-only LOD inputs for multi-M mountain fill (`performance.lod`). */
export type AreaDrawLodOptions = Readonly<{
  /** Plot width in device pixels (scissor). Drives max drawn segments. */
  readonly plotWidthDevicePx?: number;
  /**
   * When true (`performance.lod: 'strict'`), always draw full N−1 segments.
   */
  readonly forceStandardDraw?: boolean;
}>;

export interface AreaRenderer {
  prepare(
    seriesConfig: ResolvedAreaSeriesConfig,
    data: CartesianSeriesData,
    xScale: ContinuousScale,
    yScale: ContinuousScale,
    baseline?: number,
    /**
     * Optional shared storage buffer (line / GPU decimation output). When set,
     * skips private pack+upload and binds this buffer (issue 1.4 step 3).
     * Ignored when `stackGeometry` is provided (stacked path always private-packs).
     */
    storageBuffer?: GPUBuffer,
    /**
     * Point count for `storageBuffer` (required when buffer is external /
     * decimated — length is not reflected in `data`).
     */
    pointCountOverride?: number,
    /**
     * X-origin subtracted during packing (time-axis Float32). Clip affine
     * samples near this origin: clipX = ax * x' + scale(xOffset).
     */
    xOffset?: number,
    /**
     * Stacked mountain per-point yBottom / yTop. Forces private pack + stacked pipeline.
     */
    stackGeometry?: AreaStackGeometry,
    /**
     * Dense fill LOD under `performance.lod: 'auto'` (draw-only; residency unchanged).
     */
    drawLod?: AreaDrawLodOptions
  ): void;
  /**
   * Drop cached domain-space geometry so the next `prepare` re-packs vertices.
   *
   * Required when values mutate under a stable data array reference (update-transition
   * interpolation reuses one array and mutates in place — same rule as
   * `lastSetSeriesCache.clear()` in the coordinator).
   */
  invalidateGeometry(): void;
  /**
   * Draw into the **main** MSAA pass. Dense LOD fills may no-op here and draw via
   * {@link renderDense} into the post-resolve sampleCount:1 pass.
   */
  render(passEncoder: GPURenderPassEncoder): void;
  /**
   * True when the last prepare deferred dense fill out of the 4× MSAA main pass.
   */
  isDenseDeferred(): boolean;
  /**
   * Draw dense LOD fill into a **sampleCount:1** load-pass on the resolved main color.
   * No-op when the last prepare did not defer.
   */
  renderDense(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface AreaRendererOptions {
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

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const parseSeriesColorToRgba01 = (color: string): Rgba => parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

const writeTransformMat4F32 = (out: Float32Array, ax: number, bx: number, ay: number, by: number): void => {
  out[0] = ax;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = ay;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;
  out[12] = bx;
  out[13] = by;
  out[14] = 0;
  out[15] = 1;
};

/**
 * Pack N domain points into staging (not expanded geometry). Shader expands
 * each segment `i → i+1` into a baseline trapezoid via instance_index + vertex_index
 * (issue 1.4 storage layout; issue #153 per-segment gap discard).
 * Null / non-finite points are written as NaN so the VS dual-endpoint check can
 * collapse only gap-spanning segments (matches packXYInto / line.wgsl).
 */
function packAreaPointsInto(out: Float32Array, data: CartesianSeriesData, pointCount: number): void {
  for (let i = 0; i < pointCount; i++) {
    const x = getX(data, i);
    const y = getY(data, i);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      out[i * 2] = Number.NaN;
      out[i * 2 + 1] = Number.NaN;
    } else {
      out[i * 2] = x;
      out[i * 2 + 1] = y;
    }
  }
}

/**
 * Pack a dense-LOD subsample into `out` (stride-4 floats unused — vec2 layout).
 * Always includes the final sample so the mountain ends on the last point.
 * Returns the packed point count (draw segments = return − 1).
 *
 * When `xOffset` is non-zero, stores x′ = x − xOffset (matches DataStore pack /
 * packed-origin clip affine on the storage-share path).
 */
function packLodAreaPointsInto(
  out: Float32Array,
  data: CartesianSeriesData,
  pointCount: number,
  stride: number,
  xOffset = 0
): number {
  if (pointCount < 2) return pointCount;
  const last = pointCount - 1;
  const step = Math.max(1, stride | 0);
  let o = 0;
  for (let i = 0; i < last; i += step) {
    const x = getX(data, i);
    const y = getY(data, i);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      out[o * 2] = Number.NaN;
      out[o * 2 + 1] = Number.NaN;
    } else {
      out[o * 2] = xOffset !== 0 ? x - xOffset : x;
      out[o * 2 + 1] = y;
    }
    o++;
  }
  // Always pin the last sample.
  const xL = getX(data, last);
  const yL = getY(data, last);
  if (!Number.isFinite(xL) || !Number.isFinite(yL)) {
    out[o * 2] = Number.NaN;
    out[o * 2 + 1] = Number.NaN;
  } else {
    out[o * 2] = xOffset !== 0 ? xL - xOffset : xL;
    out[o * 2 + 1] = yL;
  }
  o++;
  return o;
}

/** Pack AreaPoint {x, yTop, yBottom, pad} stride-4 for stacked mountain fill. */
function packStackedAreaPointsInto(
  out: Float32Array,
  data: CartesianSeriesData,
  pointCount: number,
  yBottom: ArrayLike<number>,
  yTop: ArrayLike<number> | undefined
): void {
  for (let i = 0; i < pointCount; i++) {
    const x = getX(data, i);
    const yRaw = getY(data, i);
    const top = yTop != null ? yTop[i]! : yRaw;
    const bot = yBottom[i]!;
    const base = i * 4;
    if (!Number.isFinite(x) || !Number.isFinite(top) || !Number.isFinite(bot)) {
      out[base] = Number.NaN;
      out[base + 1] = Number.NaN;
      out[base + 2] = Number.NaN;
      out[base + 3] = 0;
    } else {
      out[base] = x;
      out[base + 1] = top;
      out[base + 2] = bot;
      out[base + 3] = 0;
    }
  }
}

export function createAreaRenderer(device: GPUDevice, options?: AreaRendererOptions): AreaRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw) ? Math.max(1, Math.floor(sampleCountRaw)) : 1;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      },
    ],
  });

  // VSUniforms: mat4 (64) + baseline/logBaseX/logBaseY/logFlags (16)
  // + lodStride/lastPointIndex/pad (16) = 96.
  const vsUniformBuffer = createUniformBuffer(device, 96, {
    label: 'areaRenderer/vsUniforms',
  });
  const fsUniformBuffer = createUniformBuffer(device, 16, {
    label: 'areaRenderer/fsUniforms',
  });

  const vsUniformScratchBuffer = new ArrayBuffer(96);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);
  const fsUniformScratchF32 = new Float32Array(4);

  const blendState = {
    color: {
      operation: 'add' as const,
      srcFactor: 'src-alpha' as const,
      dstFactor: 'one-minus-src-alpha' as const,
    },
    alpha: {
      operation: 'add' as const,
      srcFactor: 'one' as const,
      dstFactor: 'one-minus-src-alpha' as const,
    },
  };

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'areaRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: areaWgsl,
        label: 'area.wgsl',
        // No vertex buffers — points come from storage (binding 2).
      },
      fragment: {
        code: areaWgsl,
        label: 'area.wgsl',
        formats: targetFormat,
        blend: blendState,
      },
      // Instanced triangle-list: 6 verts × (N-1) segments (matches line AA path).
      // Per-segment topology allows dual-endpoint NaN discard without strip fans (#153).
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  const pipelineStacked = createRenderPipeline(
    device,
    {
      label: 'areaRenderer/pipelineStacked',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: areaStackedWgsl,
        label: 'areaStacked.wgsl',
      },
      fragment: {
        code: areaStackedWgsl,
        label: 'areaStacked.wgsl',
        formats: targetFormat,
        blend: blendState,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  // Dense LOD post-resolve path: sampleCount **1** (never 2). Avoids 4× MSAA
  // overdraw on multi-M mountain fill under performance.lod auto.
  const pipelineDenseSS1 =
    sampleCount > 1
      ? createRenderPipeline(
          device,
          {
            label: 'areaRenderer/pipelineDenseSS1',
            bindGroupLayouts: [bindGroupLayout],
            vertex: {
              code: areaWgsl,
              label: 'area.wgsl',
            },
            fragment: {
              code: areaWgsl,
              label: 'area.wgsl',
              formats: targetFormat,
              blend: blendState,
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            multisample: { count: 1 },
          },
          pipelineCache
        )
      : null;
  const pipelineStackedDenseSS1 =
    sampleCount > 1
      ? createRenderPipeline(
          device,
          {
            label: 'areaRenderer/pipelineStackedDenseSS1',
            bindGroupLayouts: [bindGroupLayout],
            vertex: {
              code: areaStackedWgsl,
              label: 'areaStacked.wgsl',
            },
            fragment: {
              code: areaStackedWgsl,
              label: 'areaStacked.wgsl',
              formats: targetFormat,
              blend: blendState,
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            multisample: { count: 1 },
          },
          pipelineCache
        )
      : null;

  /** Private storage buffer for pure-area series (not shared with line). */
  let privateBuffer: GPUBuffer | null = null;
  /** Bound storage for draw (private or external). */
  let boundDataBuffer: GPUBuffer | null = null;
  let currentBindGroup: GPUBindGroup | null = null;
  /** Logical point count (resident samples). */
  let pointCount = 0;
  /** Drawn segment instances (may be ≪ N−1 under dense LOD). */
  let drawSegmentCount = 0;
  let drawLodStride = 1;
  let drawLastPointIndex = 0;
  /** Dense LOD + main MSAA → defer fill to post-resolve sampleCount:1. */
  let deferDenseToPostResolve = false;
  /**
   * Compact draw buffer for dense LOD (pixel-budget subsample). Identity-cached
   * by data ref + stride + N so axes-only frames skip re-pack (group 8 multi-M).
   */
  let lodCompactPointCount = 0;
  let lodCompactStride = 0;
  let lodCompactDataRef: CartesianSeriesData | null = null;
  let lodCompactSourceN = 0;
  let lodCompactXOffset = Number.NaN;
  /** Last full (non-compact) private pack length for identity re-pack on append. */
  let lastFullPackN = -1;
  // Geometry identity: reuse private pack when data ref stable (axes-only).
  let boundDataRef: CartesianSeriesData | null = null;
  /** Stack geometry identity — invalidate when peer baselines change under same data ref. */
  let boundStackYBottomRef: ArrayLike<number> | null = null;
  let boundStackYTopRef: ArrayLike<number> | null = null;
  let useStackedPipeline = false;
  let cachedBounds: {
    readonly xMin: number;
    readonly xMax: number;
    readonly yMin: number;
    readonly yMax: number;
  } | null = null;

  // Reusable CPU staging + geometric GPU capacity (issue 1.4 steps 1–2).
  let cpuStaging = new Float32Array(0);

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('AreaRenderer is disposed.');
  };

  const ensureCpuStaging = (requiredFloats: number): void => {
    if (requiredFloats <= cpuStaging.length) return;
    const next = Math.max(8, nextPow2(requiredFloats));
    cpuStaging = new Float32Array(next);
  };

  const ensurePrivateBuffer = (requiredBytes: number): void => {
    const need = Math.max(4, requiredBytes);
    if (privateBuffer && privateBuffer.size >= need) return;
    const grown = Math.max(Math.max(4, nextPow2(need)), privateBuffer ? privateBuffer.size : 0);
    if (privateBuffer) {
      try {
        privateBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    privateBuffer = device.createBuffer({
      label: 'areaRenderer/privatePoints',
      size: grown,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  };

  const bindStorage = (buffer: GPUBuffer): void => {
    if (currentBindGroup && boundDataBuffer === buffer) return;
    currentBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: vsUniformBuffer } },
        { binding: 1, resource: { buffer: fsUniformBuffer } },
        { binding: 2, resource: { buffer } },
      ],
    });
    boundDataBuffer = buffer;
  };

  // Issue 2.5: skip uniform writes when affine/color/baseline/log/lod unchanged.
  let lastAx = Number.NaN;
  let lastBx = Number.NaN;
  let lastAy = Number.NaN;
  let lastBy = Number.NaN;
  let lastBaseline = Number.NaN;
  let lastLogFlags = 0;
  let lastLogBaseX = Number.NaN;
  let lastLogBaseY = Number.NaN;
  let lastLodStride = -1;
  let lastLastPointIndex = -1;
  let lastFsR = Number.NaN;
  let lastFsG = Number.NaN;
  let lastFsB = Number.NaN;
  let lastFsA = Number.NaN;
  const vsUniformScratchU32 = new Uint32Array(vsUniformScratchBuffer);

  const writeVsUniforms = (
    ax: number,
    bx: number,
    ay: number,
    by: number,
    baseline: number,
    logFlags: number,
    logBaseX: number,
    logBaseY: number,
    lodStride: number,
    lastPointIndex: number
  ): void => {
    const dirty =
      lastAx !== ax ||
      lastBx !== bx ||
      lastAy !== ay ||
      lastBy !== by ||
      lastBaseline !== baseline ||
      lastLogFlags !== logFlags ||
      lastLogBaseX !== logBaseX ||
      lastLogBaseY !== logBaseY ||
      lastLodStride !== lodStride ||
      lastLastPointIndex !== lastPointIndex;
    if (!dirty) return;
    writeTransformMat4F32(vsUniformScratchF32, ax, bx, ay, by);
    vsUniformScratchF32[16] = baseline;
    vsUniformScratchF32[17] = logBaseX;
    vsUniformScratchF32[18] = logBaseY;
    vsUniformScratchU32[19] = logFlags >>> 0;
    vsUniformScratchU32[20] = lodStride >>> 0;
    vsUniformScratchU32[21] = lastPointIndex >>> 0;
    vsUniformScratchU32[22] = 0;
    vsUniformScratchU32[23] = 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
    lastAx = ax;
    lastBx = bx;
    lastAy = ay;
    lastBy = by;
    lastBaseline = baseline;
    lastLogFlags = logFlags;
    lastLogBaseX = logBaseX;
    lastLogBaseY = logBaseY;
    lastLodStride = lodStride;
    lastLastPointIndex = lastPointIndex;
  };

  const applyDrawLod = (n: number, drawLod?: AreaDrawLodOptions): void => {
    const pol = resolveAreaDrawPolicy({
      pointCount: n,
      plotWidthDevicePx: drawLod?.plotWidthDevicePx,
      forceStandard: drawLod?.forceStandardDraw === true,
    });
    drawLodStride = pol.stride;
    drawSegmentCount = pol.drawSegmentCount;
    drawLastPointIndex = pol.lastPointIndex;
    // Defer only when dense LOD is active, main is 4× MSAA, and SS1 pipelines exist.
    // sampleCount 1 already draws in main (multi-chart antialias:false).
    deferDenseToPostResolve = pol.policy === 'denseLod' && sampleCount > 1 && pipelineDenseSS1 != null;
  };

  /**
   * When dense LOD is active, pack a compact subsample into the private buffer and
   * draw with stride 1 (better GPU cache than binding multi-M storage + VS stride).
   * Returns true when compact path is bound and draw uniforms should use stride 1.
   */
  const tryBindCompactLod = (data: CartesianSeriesData, n: number, xOffset: number): boolean => {
    if (drawLodStride <= 1 || n < 2) return false;
    // Ring/staging mutates under stable identity — keep full + VS stride.
    if (isStagingRingView(data) || isRingXYColumns(data)) return false;

    const cacheHit =
      lodCompactDataRef === data &&
      lodCompactSourceN === n &&
      lodCompactStride === drawLodStride &&
      lodCompactXOffset === xOffset &&
      lodCompactPointCount >= 2 &&
      privateBuffer != null;

    if (!cacheHit) {
      const maxLodPts = drawSegmentCount + 1;
      ensureCpuStaging(Math.max(maxLodPts, 8) * 2);
      const packed = packLodAreaPointsInto(cpuStaging, data, n, drawLodStride, xOffset);
      const requiredBytes = Math.max(4, packed * 8);
      ensurePrivateBuffer(requiredBytes);
      if (packed > 0 && privateBuffer) {
        device.queue.writeBuffer(privateBuffer, 0, cpuStaging.buffer, cpuStaging.byteOffset, packed * 8);
      }
      lodCompactPointCount = packed;
      lodCompactStride = drawLodStride;
      lodCompactDataRef = data;
      lodCompactSourceN = n;
      lodCompactXOffset = xOffset;
    }

    if (!privateBuffer || lodCompactPointCount < 2) return false;
    bindStorage(privateBuffer);
    // Compact buffer is chronological with unit stride.
    drawLodStride = 1;
    drawLastPointIndex = lodCompactPointCount - 1;
    drawSegmentCount = lodCompactPointCount - 1;
    return true;
  };

  const prepare: AreaRenderer['prepare'] = (
    seriesConfig,
    data,
    xScale,
    yScale,
    baseline,
    storageBuffer,
    pointCountOverride,
    xOffset = 0,
    stackGeometry,
    drawLod
  ) => {
    assertNotDisposed();

    // Stacked mountain: always private-pack AreaPoint {x,yTop,yBottom,pad}; never share line buffer.
    if (stackGeometry) {
      useStackedPipeline = true;
      const n = getPointCount(data);
      const ringOrStaging = isStagingRingView(data) || isRingXYColumns(data);
      const stackDirty =
        boundDataRef !== data ||
        n !== pointCount ||
        ringOrStaging ||
        boundStackYBottomRef !== stackGeometry.yBottom ||
        boundStackYTopRef !== (stackGeometry.yTop ?? null);
      if (stackDirty) {
        ensureCpuStaging(n * 4);
        packStackedAreaPointsInto(cpuStaging, data, n, stackGeometry.yBottom, stackGeometry.yTop);
        const requiredBytes = Math.max(4, n * 16);
        ensurePrivateBuffer(requiredBytes);
        if (n > 0 && privateBuffer) {
          device.queue.writeBuffer(privateBuffer, 0, cpuStaging.buffer, cpuStaging.byteOffset, n * 16);
        }
        pointCount = n;
        boundDataRef = data;
        boundStackYBottomRef = stackGeometry.yBottom;
        boundStackYTopRef = stackGeometry.yTop ?? null;

        // Bounds: include yBottom + yTop extremes for affine (prefer series rawBounds when present).
        const fromSeries = (seriesConfig as { readonly rawBounds?: typeof cachedBounds }).rawBounds;
        if (fromSeries) {
          cachedBounds = fromSeries;
        } else {
          let xMin = Number.POSITIVE_INFINITY;
          let xMax = Number.NEGATIVE_INFINITY;
          let yMin = Number.POSITIVE_INFINITY;
          let yMax = Number.NEGATIVE_INFINITY;
          for (let i = 0; i < n; i++) {
            const x = getX(data, i);
            const top = stackGeometry.yTop != null ? stackGeometry.yTop[i]! : getY(data, i);
            const bot = stackGeometry.yBottom[i]!;
            if (!Number.isFinite(x) || !Number.isFinite(top) || !Number.isFinite(bot)) continue;
            if (x < xMin) xMin = x;
            if (x > xMax) xMax = x;
            const lo = Math.min(bot, top);
            const hi = Math.max(bot, top);
            if (lo < yMin) yMin = lo;
            if (hi > yMax) yMax = hi;
          }
          if (Number.isFinite(xMin) && Number.isFinite(yMin)) {
            if (xMin === xMax) xMax = xMin + 1;
            if (yMin === yMax) yMax = yMin + 1;
            cachedBounds = { xMin, xMax, yMin, yMax };
          } else {
            cachedBounds = null;
          }
        }
      }

      if (privateBuffer) {
        bindStorage(privateBuffer);
      }

      applyDrawLod(pointCount, drawLod);
      // Stacked keeps full AreaPoint buffer + VS stride (compact pack is vec2-only).

      const { xMin, xMax, yMin, yMax } = cachedBounds ?? {
        xMin: 0,
        xMax: 1,
        yMin: 0,
        yMax: 1,
      };
      const { a: ax, b: bx } =
        xScale.kind === 'log'
          ? computeClipAffineFromContinuousScale(xScale)
          : computeClipAffineFromScale(xScale, xMin, xMax);
      const { a: ay, b: by } =
        yScale.kind === 'log'
          ? computeClipAffineFromContinuousScale(yScale)
          : computeClipAffineFromScale(yScale, yMin, yMax);
      const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);
      // Scalar baseline unused in stacked VS; keep uniform slot filled for dirty gate.
      writeVsUniforms(ax, bx, ay, by, 0, logFlags, logBaseX, logBaseY, drawLodStride, drawLastPointIndex);
    } else if (storageBuffer) {
      useStackedPipeline = false;
      boundStackYBottomRef = null;
      boundStackYTopRef = null;
      // Shared line / decimation path — no private pack (issue 1.4 step 3) unless
      // dense LOD builds a compact draw buffer (group 8 multi-M mountain).
      // Require explicit point count: drawing raw N from a shorter decimation
      // buffer is undefined (review issue 8).
      if (typeof pointCountOverride !== 'number' || !Number.isFinite(pointCountOverride) || pointCountOverride < 0) {
        throw new Error(
          'AreaRenderer.prepare(storageBuffer): pointCountOverride must be a finite non-negative number.'
        );
      }
      pointCount = Math.floor(pointCountOverride);
      boundDataRef = null; // external ownership of full residency
      applyDrawLod(pointCount, drawLod);
      // Dense multi-M: prefer compact draw buffer (pixel budget) so the GPU does not
      // keep a multi-M storage binding hot on the fill path. Falls back to full
      // storage + VS stride when compact pack is unavailable (ring/staging).
      // Compact pack is identity-cached; axes-only frames are free after first hit.
      if (!tryBindCompactLod(data, pointCount, xOffset)) {
        bindStorage(storageBuffer);
      }

      // Packed-origin X affine (stable for epoch-ms); Y continuous (log-aware).
      // Compact pack uses the same xOffset convention as DataStore / storage share.
      const { a: ax, b: bxPacked } = computePackedXAffineFromScale(xScale, xOffset);
      const { a: ay, b: by } = computeClipAffineFromContinuousScale(yScale);
      const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);
      // Log Y: default baseline is domain min (positive), not 0.
      // Non-positive caller baselines are treated as unset on log (fill-to-zero invalid).
      const defaultBaseline = yScale.kind === 'log' ? yScale.getDomain().min : 0;
      const baselineValue =
        yScale.kind === 'log'
          ? Number.isFinite(baseline ?? Number.NaN) && (baseline as number) > 0
            ? (baseline as number)
            : defaultBaseline
          : Number.isFinite(baseline ?? Number.NaN)
            ? (baseline as number)
            : defaultBaseline;
      writeVsUniforms(
        ax,
        bxPacked,
        ay,
        by,
        baselineValue,
        logFlags,
        logBaseX,
        logBaseY,
        drawLodStride,
        drawLastPointIndex
      );
    } else {
      useStackedPipeline = false;
      boundStackYBottomRef = null;
      boundStackYTopRef = null;
      // Private pack path with identity cache + pow2 growth.
      // Also re-pack when length changes under a stable ref (streaming append grows
      // owned XY columns in place; modular-ring fallback path uses this branch).
      // Staging/ring views reuse object identity with constant count while
      // start/staging floats mutate — always re-pack those (FIFO after wrap).
      // Dense LOD: pack only the compact subsample (skip full multi-M private upload).
      const n = getPointCount(data);
      const ringOrStaging = isStagingRingView(data) || isRingXYColumns(data);
      pointCount = n;
      applyDrawLod(pointCount, drawLod);

      const usedCompact = !ringOrStaging && tryBindCompactLod(data, n, 0);
      if (!usedCompact) {
        // Full private pack (standard / ring / leaving compact path).
        // Re-pack when data identity, length (streaming append), or path mode changes.
        if (boundDataRef !== data || lastFullPackN !== n || lodCompactPointCount > 0 || ringOrStaging) {
          ensureCpuStaging(n * 2);
          packAreaPointsInto(cpuStaging, data, n);
          const requiredBytes = Math.max(4, n * 8);
          ensurePrivateBuffer(requiredBytes);
          if (n > 0 && privateBuffer) {
            device.queue.writeBuffer(privateBuffer, 0, cpuStaging.buffer, cpuStaging.byteOffset, n * 8);
          }
          boundDataRef = data;
          lastFullPackN = n;
          lodCompactPointCount = 0;
          lodCompactDataRef = null;
          lodCompactSourceN = 0;
          lodCompactStride = 0;
          const fromSeries = (seriesConfig as { readonly rawBounds?: typeof cachedBounds }).rawBounds;
          cachedBounds = fromSeries ?? computeRawBoundsFromCartesianData(data) ?? null;
        }
        if (privateBuffer) {
          bindStorage(privateBuffer);
        }
      } else {
        boundDataRef = data;
        lastFullPackN = -1;
        const fromSeries = (seriesConfig as { readonly rawBounds?: typeof cachedBounds }).rawBounds;
        if (fromSeries) {
          cachedBounds = fromSeries;
        } else if (!cachedBounds) {
          cachedBounds = computeRawBoundsFromCartesianData(data) ?? null;
        }
      }

      const { xMin, xMax, yMin, yMax } = cachedBounds ?? {
        xMin: 0,
        xMax: 1,
        yMin: 0,
        yMax: 1,
      };
      // Log axes: affine in transformed space. Linear: sample domain endpoints (parity).
      const { a: ax, b: bx } =
        xScale.kind === 'log'
          ? computeClipAffineFromContinuousScale(xScale)
          : computeClipAffineFromScale(xScale, xMin, xMax);
      const { a: ay, b: by } =
        yScale.kind === 'log'
          ? computeClipAffineFromContinuousScale(yScale)
          : computeClipAffineFromScale(yScale, yMin, yMax);
      const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);
      const fallbackBaseline = yScale.kind === 'log' ? yScale.getDomain().min : Number.isFinite(yMin) ? yMin : 0;
      // Log Y: non-positive baseline is unset (same guard as storageBuffer path).
      const baselineValue =
        yScale.kind === 'log'
          ? Number.isFinite(baseline ?? Number.NaN) && (baseline as number) > 0
            ? (baseline as number)
            : fallbackBaseline
          : Number.isFinite(baseline ?? Number.NaN)
            ? (baseline as number)
            : fallbackBaseline;
      writeVsUniforms(ax, bx, ay, by, baselineValue, logFlags, logBaseX, logBaseY, drawLodStride, drawLastPointIndex);
    }

    const [r, g, b, a] = parseSeriesColorToRgba01(seriesConfig.areaStyle.color);
    const opacity = clamp01(seriesConfig.areaStyle.opacity);
    const fa = clamp01(a * opacity);
    if (lastFsR !== r || lastFsG !== g || lastFsB !== b || lastFsA !== fa) {
      fsUniformScratchF32[0] = r;
      fsUniformScratchF32[1] = g;
      fsUniformScratchF32[2] = b;
      fsUniformScratchF32[3] = fa;
      writeUniformBuffer(device, fsUniformBuffer, fsUniformScratchF32);
      lastFsR = r;
      lastFsG = g;
      lastFsB = b;
      lastFsA = fa;
    }
  };

  const invalidateGeometry: AreaRenderer['invalidateGeometry'] = () => {
    boundDataRef = null;
    boundStackYBottomRef = null;
    boundStackYTopRef = null;
    cachedBounds = null;
    lodCompactPointCount = 0;
    lodCompactDataRef = null;
    lodCompactSourceN = 0;
    lodCompactStride = 0;
    lodCompactXOffset = Number.NaN;
    lastFullPackN = -1;
  };

  const render: AreaRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    // Need ≥2 points → ≥1 segment instance for a non-empty fill.
    if (!currentBindGroup || pointCount < 2 || drawSegmentCount < 1) return;
    // Dense LOD deferred to post-resolve sampleCount:1 (see renderDense).
    if (deferDenseToPostResolve) return;

    passEncoder.setPipeline(useStackedPipeline ? pipelineStacked : pipeline);
    passEncoder.setBindGroup(0, currentBindGroup);
    // 6 vertices per instance (trapezoid); drawSegmentCount may be ≪ N−1 under dense LOD.
    passEncoder.draw(6, drawSegmentCount);
  };

  const isDenseDeferred: AreaRenderer['isDenseDeferred'] = () => {
    assertNotDisposed();
    return deferDenseToPostResolve && currentBindGroup != null && pointCount >= 2 && drawSegmentCount >= 1;
  };

  const renderDense: AreaRenderer['renderDense'] = (passEncoder) => {
    assertNotDisposed();
    if (!isDenseDeferred() || !currentBindGroup) return;
    const ss1 = useStackedPipeline ? pipelineStackedDenseSS1 : pipelineDenseSS1;
    if (!ss1) return;
    passEncoder.setPipeline(ss1);
    passEncoder.setBindGroup(0, currentBindGroup);
    passEncoder.draw(6, drawSegmentCount);
  };

  const dispose: AreaRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;
    boundDataRef = null;
    boundStackYBottomRef = null;
    boundStackYTopRef = null;
    cachedBounds = null;
    currentBindGroup = null;
    boundDataBuffer = null;
    pointCount = 0;
    drawSegmentCount = 0;
    drawLodStride = 1;
    drawLastPointIndex = 0;
    deferDenseToPostResolve = false;
    lodCompactPointCount = 0;
    lodCompactDataRef = null;
    lodCompactSourceN = 0;
    lodCompactStride = 0;
    lodCompactXOffset = Number.NaN;
    lastFullPackN = -1;
    cpuStaging = new Float32Array(0);

    if (privateBuffer) {
      try {
        privateBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    privateBuffer = null;

    try {
      vsUniformBuffer.destroy();
    } catch {
      // best-effort
    }
    try {
      fsUniformBuffer.destroy();
    } catch {
      // best-effort
    }
  };

  return { prepare, invalidateGeometry, render, isDenseDeferred, renderDense, dispose };
}
