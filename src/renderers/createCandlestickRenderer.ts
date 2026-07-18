import candlestickWgsl from '../shaders/candlestick.wgsl?raw';
import type { ResolvedCandlestickSeriesConfig } from '../config/OptionResolver';
import type { OHLCDataPoint, OHLCDataPointTuple } from '../config/types';
import type { LinearScale } from '../utils/scales';
import type { GridArea } from './createGridRenderer';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { PipelineCache } from '../core/PipelineCache';
import { resolveUploadPolicy } from '../data/seriesResidency';

export interface CandlestickRenderer {
  prepare(
    series: ResolvedCandlestickSeriesConfig,
    data: ResolvedCandlestickSeriesConfig['data'],
    xScale: LinearScale,
    yScale: LinearScale,
    gridArea: GridArea,
    backgroundColor?: string
  ): void;
  /**
   * Drop cached domain-space instance geometry so the next `prepare` re-packs.
   * Required when values mutate under a stable data array reference.
   */
  invalidateGeometry(): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface CandlestickRendererOptions {
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
const DEFAULT_WICK_WIDTH_CSS_PX = 1;
const INSTANCE_STRIDE_BYTES = 40; // 6 floats + vec4 color
const INSTANCE_STRIDE_FLOATS = INSTANCE_STRIDE_BYTES / 4;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

const parseSeriesColorToRgba01 = (color: string): Rgba => parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

const parsePercent = (value: string): number | null => {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
  if (!m) return null;
  const p = Number(m[1]) / 100;
  return Number.isFinite(p) ? p : null;
};

const isTupleDataPoint = (p: OHLCDataPoint): p is OHLCDataPointTuple => Array.isArray(p);

const getOHLC = (
  p: OHLCDataPoint
): {
  readonly timestamp: number;
  readonly open: number;
  readonly close: number;
  readonly low: number;
  readonly high: number;
} => {
  if (isTupleDataPoint(p)) {
    return { timestamp: p[0], open: p[1], close: p[2], low: p[3], high: p[4] };
  }
  return {
    timestamp: p.timestamp,
    open: p.open,
    close: p.close,
    low: p.low,
    high: p.high,
  };
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
  readonly width: number;
  readonly height: number;
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
    width: plotRightClip - plotLeftClip,
    height: plotTopClip - plotBottomClip,
  };
};

const computePlotScissorDevicePx = (
  gridArea: GridArea
): {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
} => {
  const { canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeftDevice = gridArea.left * devicePixelRatio;
  const plotRightDevice = canvasWidth - gridArea.right * devicePixelRatio;
  const plotTopDevice = gridArea.top * devicePixelRatio;
  const plotBottomDevice = canvasHeight - gridArea.bottom * devicePixelRatio;

  const scissorX = clampInt(Math.floor(plotLeftDevice), 0, Math.max(0, canvasWidth));
  const scissorY = clampInt(Math.floor(plotTopDevice), 0, Math.max(0, canvasHeight));
  const scissorR = clampInt(Math.ceil(plotRightDevice), 0, Math.max(0, canvasWidth));
  const scissorB = clampInt(Math.ceil(plotBottomDevice), 0, Math.max(0, canvasHeight));
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
};

const computeCategoryStep = (data: ReadonlyArray<OHLCDataPoint>): number => {
  const timestamps: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const { timestamp } = getOHLC(data[i]);
    if (Number.isFinite(timestamp)) timestamps.push(timestamp);
  }

  if (timestamps.length < 2) return 1;
  timestamps.sort((a, b) => a - b);

  let minStep = Number.POSITIVE_INFINITY;
  for (let i = 1; i < timestamps.length; i++) {
    const d = timestamps[i] - timestamps[i - 1];
    if (d > 0 && d < minStep) minStep = d;
  }
  return Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
};

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

const nearEqual = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

type CandleGeometryCache = {
  readonly data: ResolvedCandlestickSeriesConfig['data'];
  /**
   * Source array length. Streaming `appendData` mutates the coordinator-owned
   * OHLC array in place (stable ref + growing length). Identity skip must miss
   * when length changes or new candles never reach the instance buffer.
   */
  readonly dataLength: number;
  /**
   * Last candle OHLC fingerprint for equal-N in-place updates (forming candle
   * via setOption on a stable data array). Axes-only prepares keep the same
   * values so the skip still hits.
   */
  readonly lastTimestamp: number;
  readonly lastOpen: number;
  readonly lastClose: number;
  readonly lastLow: number;
  readonly lastHigh: number;
  /**
   * Absolute domain origin subtracted from each instance `x` before Float32
   * upload. Large time-axis timestamps (ms epoch) lose spacing as f32; packing
   * relative to this origin keeps candle x separable. VS transform bakes it
   * back via `bx' = bx + ax * packingOrigin`.
   */
  readonly packingOrigin: number;
  readonly categoryStep: number;
  readonly bodyWidthDomain: number;
  readonly hollowBorderDomain: number;
  readonly hollowMode: boolean;
  readonly upColor: string;
  readonly downColor: string;
  readonly upBorderColor: string;
  readonly downBorderColor: string;
  readonly backgroundColor: string | undefined;
  readonly instanceCount: number;
  readonly hollowInstanceCount: number;
};

/** Last candle OHLC for geometry-cache content fingerprint (or NaNs when empty). */
const lastCandleFingerprint = (
  data: ResolvedCandlestickSeriesConfig['data']
): {
  readonly timestamp: number;
  readonly open: number;
  readonly close: number;
  readonly low: number;
  readonly high: number;
} => {
  if (data.length === 0) {
    return {
      timestamp: Number.NaN,
      open: Number.NaN,
      close: Number.NaN,
      low: Number.NaN,
      high: Number.NaN,
    };
  }
  return getOHLC(data[data.length - 1]!);
};

/** First finite OHLC timestamp — packing origin for f32 domain x. */
const firstFiniteTimestamp = (data: ResolvedCandlestickSeriesConfig['data']): number => {
  for (let i = 0; i < data.length; i++) {
    const { timestamp } = getOHLC(data[i]);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
};

export function createCandlestickRenderer(
  device: GPUDevice,
  options?: CandlestickRendererOptions
): CandlestickRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
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
    ],
  });

  // VSUniforms: mat4x4 transform (64) + wickWidth (domain units) f32 + pad (12) = 80
  const vsUniformBuffer = createUniformBuffer(device, 80, {
    label: 'candlestickRenderer/vsUniforms',
  });
  const vsUniformScratchBuffer = new ArrayBuffer(80);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'candlestickRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: candlestickWgsl,
        label: 'candlestick.wgsl',
        buffers: [
          {
            arrayStride: INSTANCE_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, format: 'float32', offset: 0 },
              { shaderLocation: 1, format: 'float32', offset: 4 },
              { shaderLocation: 2, format: 'float32', offset: 8 },
              { shaderLocation: 3, format: 'float32', offset: 12 },
              { shaderLocation: 4, format: 'float32', offset: 16 },
              { shaderLocation: 5, format: 'float32', offset: 20 },
              { shaderLocation: 6, format: 'float32x4', offset: 24 },
            ],
          },
        ],
      },
      fragment: {
        code: candlestickWgsl,
        label: 'candlestick.wgsl',
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

  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let lastScissor: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  } | null = null;

  // Hollow mode state
  let hollowMode = false;
  let hollowInstanceBuffer: GPUBuffer | null = null;
  let hollowInstanceCount = 0;
  let cpuHollowStagingBuffer = new ArrayBuffer(0);
  let cpuHollowStagingF32 = new Float32Array(cpuHollowStagingBuffer);

  // Domain-space geometry identity cache (issue 1.3).
  let geometryCache: CandleGeometryCache | null = null;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('CandlestickRenderer is disposed.');
  };

  const ensureCpuInstanceCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuInstanceStagingF32.length) return;
    const nextFloats = Math.max(8, nextPow2(requiredFloats));
    cpuInstanceStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  };

  const ensureCpuHollowCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuHollowStagingF32.length) return;
    const nextFloats = Math.max(8, nextPow2(requiredFloats));
    cpuHollowStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuHollowStagingF32 = new Float32Array(cpuHollowStagingBuffer);
  };

  const prepare: CandlestickRenderer['prepare'] = (series, data, xScale, yScale, gridArea, backgroundColor) => {
    assertNotDisposed();

    if (data.length === 0) {
      instanceCount = 0;
      hollowInstanceCount = 0;
      geometryCache = null;
      return;
    }

    const plotSize = computePlotSizeCssPx(gridArea);
    if (!plotSize) {
      instanceCount = 0;
      hollowInstanceCount = 0;
      geometryCache = null;
      return;
    }

    const plotClipRect = computePlotClipRect(gridArea);
    const clipPerCssX = plotSize.plotWidthCss > 0 ? plotClipRect.width / plotSize.plotWidthCss : 0;

    lastCanvasWidth = gridArea.canvasWidth;
    lastCanvasHeight = gridArea.canvasHeight;
    lastScissor = computePlotScissorDevicePx(gridArea);

    hollowMode = series.style === 'hollow';

    // Reuse categoryStep on identity hit to skip O(n) sort.
    const categoryStep =
      geometryCache && geometryCache.data === data ? geometryCache.categoryStep : computeCategoryStep(data);

    // Pack x as (timestamp - packingOrigin) for f32-safe time axes.
    // Affine MUST be sampled near packingOrigin — computeClipAffineFromScale(0,1)
    // loses digits when domain is ~1e12 epoch-ms; bx + ax*origin then fails to cancel.
    const packingOrigin =
      geometryCache && geometryCache.data === data ? geometryCache.packingOrigin : firstFiniteTimestamp(data);
    const xDelta = Number.isFinite(categoryStep) && categoryStep > 0 ? categoryStep : 1;
    const pX0 = xScale.scale(packingOrigin);
    const pX1 = xScale.scale(packingOrigin + xDelta);
    const ax = Number.isFinite(pX0) && Number.isFinite(pX1) && xDelta !== 0 ? (pX1 - pX0) / xDelta : 0;
    // clipX = ax * x_packed + pX0
    const bxPacked = Number.isFinite(pX0) ? pX0 : 0;

    // Y prices are typically O(1e2)–O(1e6); sampling (0,1) stays stable.
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, 0, 1);
    const absAx = Math.abs(ax);
    const domainPerCssX = absAx > 1e-20 ? clipPerCssX / absAx : 0;

    // Body width in domain units (percent of category is zoom-invariant).
    let bodyWidthDomain = 0;
    const rawBarWidth = series.barWidth;
    if (typeof rawBarWidth === 'number') {
      bodyWidthDomain = Math.max(0, rawBarWidth) * domainPerCssX;
    } else if (typeof rawBarWidth === 'string') {
      const p = parsePercent(rawBarWidth);
      bodyWidthDomain = p == null ? 0 : categoryStep * clamp01(p);
    }
    const minWidthDomain = series.barMinWidth * domainPerCssX;
    const maxWidthDomain = series.barMaxWidth * domainPerCssX;
    bodyWidthDomain = Math.min(Math.max(bodyWidthDomain, minWidthDomain), maxWidthDomain);

    const wickWidthCssPx = series.itemStyle.borderWidth ?? DEFAULT_WICK_WIDTH_CSS_PX;
    const wickWidthDomain = Math.max(0, wickWidthCssPx) * domainPerCssX;
    const hollowBorderDomain = hollowMode ? Math.max(0, series.itemStyle.borderWidth * domainPerCssX) : 0;

    const upColorKey = series.itemStyle.upColor;
    const downColorKey = series.itemStyle.downColor;
    const upBorderKey = series.itemStyle.upBorderColor;
    const downBorderKey = series.itemStyle.downBorderColor;

    // Geometry identity skip: same data ref + domain layout → no instance rewrite.
    // Also require stable length and last-candle OHLC so streaming append
    // (in-place push) and forming-candle setOption (mutate last bar) re-upload.
    // Policy verb shared via seriesResidency (issue 3.4 / 1.3).
    const lastFp = lastCandleFingerprint(data);
    const geometryHit =
      geometryCache != null &&
      instanceBuffer != null &&
      geometryCache.data === data &&
      geometryCache.dataLength === data.length &&
      nearEqual(geometryCache.lastTimestamp, lastFp.timestamp) &&
      nearEqual(geometryCache.lastOpen, lastFp.open) &&
      nearEqual(geometryCache.lastClose, lastFp.close) &&
      nearEqual(geometryCache.lastLow, lastFp.low) &&
      nearEqual(geometryCache.lastHigh, lastFp.high) &&
      nearEqual(geometryCache.packingOrigin, packingOrigin) &&
      nearEqual(geometryCache.categoryStep, categoryStep) &&
      nearEqual(geometryCache.bodyWidthDomain, bodyWidthDomain) &&
      nearEqual(geometryCache.hollowBorderDomain, hollowBorderDomain) &&
      geometryCache.hollowMode === hollowMode &&
      geometryCache.upColor === upColorKey &&
      geometryCache.downColor === downColorKey &&
      geometryCache.upBorderColor === upBorderKey &&
      geometryCache.downBorderColor === downBorderKey &&
      geometryCache.backgroundColor === backgroundColor;
    const policy = resolveUploadPolicy({
      residency: {
        kind: 'privateInstance',
        gpuBuffer: instanceBuffer,
        pointCount: geometryCache?.instanceCount ?? 0,
        contentVersion: 0,
        lastRef: geometryCache?.data ?? null,
      },
      dataRef: data,
      geometryCacheHit: geometryHit,
      appendedThisFrame: false,
      needsGrowth: false,
    });

    const writeVsUniforms = (): void => {
      writeTransformMat4F32(vsUniformScratchF32, ax, bxPacked, ay, by);
      vsUniformScratchF32[16] = wickWidthDomain;
      vsUniformScratchF32[17] = 0;
      vsUniformScratchF32[18] = 0;
      vsUniformScratchF32[19] = 0;
      writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
    };

    if (policy === 'skip' && geometryCache) {
      instanceCount = geometryCache.instanceCount;
      hollowInstanceCount = geometryCache.hollowInstanceCount;
      writeVsUniforms();
      return;
    }

    // Parse colors
    const upColor = parseSeriesColorToRgba01(upColorKey);
    const downColor = parseSeriesColorToRgba01(downColorKey);
    const upBorderColor = parseSeriesColorToRgba01(upBorderKey);
    const downBorderColor = parseSeriesColorToRgba01(downBorderKey);
    const bgColor = backgroundColor ? parseSeriesColorToRgba01(backgroundColor) : ([0, 0, 0, 1] as const);

    writeVsUniforms();

    ensureCpuInstanceCapacityFloats(data.length * INSTANCE_STRIDE_FLOATS);
    const f32 = cpuInstanceStagingF32;
    let outFloats = 0;

    if (hollowMode) {
      ensureCpuHollowCapacityFloats(data.length * INSTANCE_STRIDE_FLOATS);
    }
    const hollowF32 = cpuHollowStagingF32;
    let hollowOutFloats = 0;

    for (let i = 0; i < data.length; i++) {
      const { timestamp, open, close, low, high } = getOHLC(data[i]);
      if (
        !Number.isFinite(timestamp) ||
        !Number.isFinite(open) ||
        !Number.isFinite(close) ||
        !Number.isFinite(low) ||
        !Number.isFinite(high)
      ) {
        continue;
      }

      const isUp = close > open;
      // Domain-relative x (issue 1.3 + f32 time-axis precision).
      const xPacked = timestamp - packingOrigin;

      if (hollowMode) {
        // Domain-space pack; VS transform maps to clip (issue 1.3).
        const borderColor = isUp ? upBorderColor : downBorderColor;
        f32[outFloats + 0] = xPacked;
        f32[outFloats + 1] = open;
        f32[outFloats + 2] = close;
        f32[outFloats + 3] = low;
        f32[outFloats + 4] = high;
        f32[outFloats + 5] = bodyWidthDomain;
        f32[outFloats + 6] = borderColor[0];
        f32[outFloats + 7] = borderColor[1];
        f32[outFloats + 8] = borderColor[2];
        f32[outFloats + 9] = borderColor[3];
        outFloats += INSTANCE_STRIDE_FLOATS;

        if (isUp) {
          const insetBodyWidthDomain = Math.max(0, bodyWidthDomain - 2 * hollowBorderDomain);

          hollowF32[hollowOutFloats + 0] = xPacked;
          hollowF32[hollowOutFloats + 1] = open;
          hollowF32[hollowOutFloats + 2] = close;
          hollowF32[hollowOutFloats + 3] = low;
          hollowF32[hollowOutFloats + 4] = high;
          hollowF32[hollowOutFloats + 5] = insetBodyWidthDomain;
          hollowF32[hollowOutFloats + 6] = bgColor[0];
          hollowF32[hollowOutFloats + 7] = bgColor[1];
          hollowF32[hollowOutFloats + 8] = bgColor[2];
          hollowF32[hollowOutFloats + 9] = bgColor[3];
          hollowOutFloats += INSTANCE_STRIDE_FLOATS;
        }
      } else {
        const fillColor = isUp ? upColor : downColor;
        f32[outFloats + 0] = xPacked;
        f32[outFloats + 1] = open;
        f32[outFloats + 2] = close;
        f32[outFloats + 3] = low;
        f32[outFloats + 4] = high;
        f32[outFloats + 5] = bodyWidthDomain;
        f32[outFloats + 6] = fillColor[0];
        f32[outFloats + 7] = fillColor[1];
        f32[outFloats + 8] = fillColor[2];
        f32[outFloats + 9] = fillColor[3];
        outFloats += INSTANCE_STRIDE_FLOATS;
      }
    }

    instanceCount = outFloats / INSTANCE_STRIDE_FLOATS;
    hollowInstanceCount = hollowOutFloats / INSTANCE_STRIDE_FLOATS;

    // Upload primary instance buffer
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
        label: 'candlestickRenderer/instanceBuffer',
        size: grownBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    if (instanceCount > 0) {
      device.queue.writeBuffer(instanceBuffer, 0, cpuInstanceStagingBuffer, 0, instanceCount * INSTANCE_STRIDE_BYTES);
    }

    // Upload hollow mode buffer (second pass)
    if (hollowMode && hollowInstanceCount > 0) {
      const hollowRequiredBytes = Math.max(4, hollowInstanceCount * INSTANCE_STRIDE_BYTES);
      if (!hollowInstanceBuffer || hollowInstanceBuffer.size < hollowRequiredBytes) {
        const grownBytes = Math.max(
          Math.max(4, nextPow2(hollowRequiredBytes)),
          hollowInstanceBuffer ? hollowInstanceBuffer.size : 0
        );
        if (hollowInstanceBuffer) {
          try {
            hollowInstanceBuffer.destroy();
          } catch {
            // best-effort
          }
        }
        hollowInstanceBuffer = device.createBuffer({
          label: 'candlestickRenderer/hollowInstanceBuffer',
          size: grownBytes,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }
      device.queue.writeBuffer(
        hollowInstanceBuffer,
        0,
        cpuHollowStagingBuffer,
        0,
        hollowInstanceCount * INSTANCE_STRIDE_BYTES
      );
    }

    geometryCache = {
      data,
      dataLength: data.length,
      lastTimestamp: lastFp.timestamp,
      lastOpen: lastFp.open,
      lastClose: lastFp.close,
      lastLow: lastFp.low,
      lastHigh: lastFp.high,
      packingOrigin,
      categoryStep,
      bodyWidthDomain,
      hollowBorderDomain,
      hollowMode,
      upColor: upColorKey,
      downColor: downColorKey,
      upBorderColor: upBorderKey,
      downBorderColor: downBorderKey,
      backgroundColor,
      instanceCount,
      hollowInstanceCount,
    };
  };

  const invalidateGeometry: CandlestickRenderer['invalidateGeometry'] = () => {
    geometryCache = null;
  };

  const render: CandlestickRenderer['render'] = (passEncoder) => {
    assertNotDisposed();

    if (!instanceBuffer || instanceCount === 0) return;

    // Apply scissor rect to clip to plot area
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(lastScissor.x, lastScissor.y, lastScissor.w, lastScissor.h);
    }

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);

    // Pass 1: Draw all candles (18 vertices per instance)
    passEncoder.setVertexBuffer(0, instanceBuffer);
    passEncoder.draw(18, instanceCount);

    // Pass 2: For hollow mode, draw body-only punch-out for UP candles
    if (hollowMode && hollowInstanceBuffer && hollowInstanceCount > 0) {
      passEncoder.setVertexBuffer(0, hollowInstanceBuffer);
      // Draw only body vertices (0-5) by drawing 6 vertices per instance
      passEncoder.draw(6, hollowInstanceCount);
    }

    // Reset scissor to full canvas
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    }
  };

  const dispose: CandlestickRenderer['dispose'] = () => {
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

    if (hollowInstanceBuffer) {
      try {
        hollowInstanceBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    hollowInstanceBuffer = null;
    hollowInstanceCount = 0;

    try {
      vsUniformBuffer.destroy();
    } catch {
      // best-effort
    }

    lastCanvasWidth = 0;
    lastCanvasHeight = 0;
    lastScissor = null;
    geometryCache = null;
  };

  return { prepare, invalidateGeometry, render, dispose };
}
