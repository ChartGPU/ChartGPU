import ohlcWgsl from '../shaders/ohlc.wgsl?raw';
import type { ResolvedOhlcSeriesConfig } from '../config/OptionResolver';
import type { OHLCDataPoint, OHLCDataPointTuple } from '../config/types';
import type { ContinuousScale } from '../utils/scales';
import type { GridArea } from './createGridRenderer';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { PipelineCache } from '../core/PipelineCache';
import { resolveUploadPolicy } from '../data/seriesResidency';
import { computeClipAffineFromContinuousScale, resolveLogProjection } from './packedXAffine';
import { resolveOhlcDirection, resolveOhlcTickLengthDomain } from './ohlcGeometry';

export interface OhlcRenderer {
  prepare(
    series: ResolvedOhlcSeriesConfig,
    data: ResolvedOhlcSeriesConfig['data'],
    xScale: ContinuousScale,
    yScale: ContinuousScale,
    gridArea: GridArea
  ): void;
  /**
   * Drop cached domain-space instance geometry so the next `prepare` re-packs.
   * Required when values mutate under a stable data array reference.
   */
  invalidateGeometry(): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface OhlcRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_STEM_WIDTH_CSS_PX = 1;
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
  const plotTopClip = 1.0 - (plotTop / canvasHeight) * 2.0;
  const plotBottomClip = 1.0 - (plotBottom / canvasHeight) * 2.0;

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
    const { timestamp } = getOHLC(data[i]!);
    if (Number.isFinite(timestamp)) timestamps.push(timestamp);
  }

  if (timestamps.length < 2) return 1;
  timestamps.sort((a, b) => a - b);

  let minStep = Number.POSITIVE_INFINITY;
  for (let i = 1; i < timestamps.length; i++) {
    const d = timestamps[i]! - timestamps[i - 1]!;
    if (d > 0 && d < minStep) minStep = d;
  }
  return Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
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

type OhlcGeometryCache = {
  readonly data: ResolvedOhlcSeriesConfig['data'];
  readonly dataLength: number;
  readonly lastTimestamp: number;
  readonly lastOpen: number;
  readonly lastClose: number;
  readonly lastLow: number;
  readonly lastHigh: number;
  readonly packingOrigin: number;
  readonly categoryStep: number;
  readonly bodyWidthDomain: number;
  readonly tickLengthDomain: number;
  readonly upColor: string;
  readonly downColor: string;
  readonly instanceCount: number;
};

/**
 * Last-bar OHLC fingerprint for geometry identity (candlestick parity).
 *
 * Contract: equal-N **in-place mutation of a middle bar** under a stable data
 * array ref is **not** detected — same as `createCandlestickRenderer`. Prefer a
 * new data array, `appendData`, or `invalidateGeometry()` (animation path already
 * invalidates OHLC renderers while update transitions run).
 */
const lastBarFingerprint = (
  data: ResolvedOhlcSeriesConfig['data']
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

const firstFiniteTimestamp = (data: ResolvedOhlcSeriesConfig['data']): number => {
  for (let i = 0; i < data.length; i++) {
    const { timestamp } = getOHLC(data[i]!);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
};

export function createOhlcRenderer(device: GPUDevice, options?: OhlcRendererOptions): OhlcRenderer {
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
    ],
  });

  // VSUniforms: mat4 (64) + stemWidth + tickThicknessY + logBaseX + logBaseY (16)
  // + logFlags + 3×u32 pad (16) = 96
  const vsUniformBuffer = createUniformBuffer(device, 96, {
    label: 'ohlcRenderer/vsUniforms',
  });
  const vsUniformScratchBuffer = new ArrayBuffer(96);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'ohlcRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: ohlcWgsl,
        label: 'ohlc.wgsl',
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
        code: ohlcWgsl,
        label: 'ohlc.wgsl',
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

  let geometryCache: OhlcGeometryCache | null = null;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('OhlcRenderer is disposed.');
  };

  const ensureCpuInstanceCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuInstanceStagingF32.length) return;
    const nextFloats = Math.max(8, nextPow2(requiredFloats));
    cpuInstanceStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  };

  const prepare: OhlcRenderer['prepare'] = (series, data, xScale, yScale, gridArea) => {
    assertNotDisposed();

    if (data.length === 0) {
      instanceCount = 0;
      geometryCache = null;
      return;
    }

    const plotSize = computePlotSizeCssPx(gridArea);
    if (!plotSize) {
      instanceCount = 0;
      geometryCache = null;
      return;
    }

    const plotClipRect = computePlotClipRect(gridArea);
    const clipPerCssX = plotSize.plotWidthCss > 0 ? plotClipRect.width / plotSize.plotWidthCss : 0;

    lastCanvasWidth = gridArea.canvasWidth;
    lastCanvasHeight = gridArea.canvasHeight;
    lastScissor = computePlotScissorDevicePx(gridArea);

    const categoryStep =
      geometryCache && geometryCache.data === data ? geometryCache.categoryStep : computeCategoryStep(data);

    const packingOrigin =
      xScale.kind === 'log'
        ? 0
        : geometryCache && geometryCache.data === data
          ? geometryCache.packingOrigin
          : firstFiniteTimestamp(data);
    let ax: number;
    let bxPacked: number;
    if (xScale.kind === 'log') {
      const aff = computeClipAffineFromContinuousScale(xScale);
      ax = aff.a;
      bxPacked = aff.b;
    } else {
      const xDelta = Number.isFinite(categoryStep) && categoryStep > 0 ? categoryStep : 1;
      const pX0 = xScale.scale(packingOrigin);
      const pX1 = xScale.scale(packingOrigin + xDelta);
      ax = Number.isFinite(pX0) && Number.isFinite(pX1) && xDelta !== 0 ? (pX1 - pX0) / xDelta : 0;
      bxPacked = Number.isFinite(pX0) ? pX0 : 0;
    }

    const { a: ay, b: by } = computeClipAffineFromContinuousScale(yScale);
    const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);

    const clipPerCssY = plotSize.plotHeightCss > 0 ? plotClipRect.height / plotSize.plotHeightCss : 0;

    const cssWidthToDomainX = (cssPx: number): number => {
      const widthClip = Math.max(0, cssPx) * clipPerCssX;
      if (!(widthClip > 0)) return 0;
      if (xScale.kind === 'log') {
        const { min, max } = xScale.getDomain();
        const mid = Math.sqrt(Math.max(min, Number.MIN_VALUE) * Math.max(max, Number.MIN_VALUE));
        const midClip = xScale.scale(mid);
        const lo = xScale.invert(midClip - widthClip * 0.5);
        const hi = xScale.invert(midClip + widthClip * 0.5);
        return Number.isFinite(lo) && Number.isFinite(hi) ? Math.abs(hi - lo) : 0;
      }
      const absAx = Math.abs(ax);
      return absAx > 1e-20 ? widthClip / absAx : 0;
    };

    /** CSS px height → domain Y (for open/close tick stroke thickness). */
    const cssHeightToDomainY = (cssPx: number): number => {
      const heightClip = Math.max(0, cssPx) * Math.abs(clipPerCssY);
      if (!(heightClip > 0)) return 0;
      if (yScale.kind === 'log') {
        const { min, max } = yScale.getDomain();
        const mid = Math.sqrt(Math.max(min, Number.MIN_VALUE) * Math.max(max, Number.MIN_VALUE));
        const midClip = yScale.scale(mid);
        const lo = yScale.invert(midClip - heightClip * 0.5);
        const hi = yScale.invert(midClip + heightClip * 0.5);
        return Number.isFinite(lo) && Number.isFinite(hi) ? Math.abs(hi - lo) : 0;
      }
      const absAy = Math.abs(ay);
      return absAy > 1e-20 ? heightClip / absAy : 0;
    };

    let bodyWidthDomain = 0;
    const rawBarWidth = series.barWidth;
    if (typeof rawBarWidth === 'number') {
      bodyWidthDomain = cssWidthToDomainX(rawBarWidth);
    } else if (typeof rawBarWidth === 'string') {
      const p = parsePercent(rawBarWidth);
      bodyWidthDomain = p == null ? 0 : categoryStep * clamp01(p);
    }
    const minWidthDomain = cssWidthToDomainX(series.barMinWidth);
    const maxWidthDomain = cssWidthToDomainX(series.barMaxWidth);
    bodyWidthDomain = Math.min(Math.max(bodyWidthDomain, minWidthDomain), maxWidthDomain);

    const stemWidthCss =
      typeof series.stemWidth === 'number' && Number.isFinite(series.stemWidth) && series.stemWidth > 0
        ? series.stemWidth
        : DEFAULT_STEM_WIDTH_CSS_PX;
    // Stem thickness: domain X. Tick thickness: domain Y (same CSS px, different scale).
    const stemWidthDomain = cssWidthToDomainX(stemWidthCss);
    const tickThicknessDomainY = cssHeightToDomainY(stemWidthCss);

    let tickLengthAsDomain: number | undefined;
    if (typeof series.tickLength === 'number' && Number.isFinite(series.tickLength)) {
      tickLengthAsDomain = cssWidthToDomainX(series.tickLength);
    }
    const tickLengthDomain = resolveOhlcTickLengthDomain({
      tickLength: series.tickLength,
      bodyWidthDomain,
      tickLengthAsDomain,
    });

    const upColorKey = series.itemStyle.upColor;
    const downColorKey = series.itemStyle.downColor;

    const lastFp = lastBarFingerprint(data);
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
      nearEqual(geometryCache.tickLengthDomain, tickLengthDomain) &&
      geometryCache.upColor === upColorKey &&
      geometryCache.downColor === downColorKey;
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

    const vsUniformScratchU32 = new Uint32Array(vsUniformScratchBuffer);
    const writeVsUniforms = (): void => {
      writeTransformMat4F32(vsUniformScratchF32, ax, bxPacked, ay, by);
      vsUniformScratchF32[16] = stemWidthDomain;
      vsUniformScratchF32[17] = tickThicknessDomainY;
      vsUniformScratchF32[18] = logBaseX;
      vsUniformScratchF32[19] = logBaseY;
      vsUniformScratchU32[20] = logFlags >>> 0;
      vsUniformScratchU32[21] = 0;
      vsUniformScratchU32[22] = 0;
      vsUniformScratchU32[23] = 0;
      writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
    };

    if (policy === 'skip' && geometryCache) {
      instanceCount = geometryCache.instanceCount;
      writeVsUniforms();
      return;
    }

    const upColor = parseSeriesColorToRgba01(upColorKey);
    const downColor = parseSeriesColorToRgba01(downColorKey);

    writeVsUniforms();

    ensureCpuInstanceCapacityFloats(data.length * INSTANCE_STRIDE_FLOATS);
    const f32 = cpuInstanceStagingF32;
    let outFloats = 0;

    for (let i = 0; i < data.length; i++) {
      const { timestamp, open, close, low, high } = getOHLC(data[i]!);
      if (
        !Number.isFinite(timestamp) ||
        !Number.isFinite(open) ||
        !Number.isFinite(close) ||
        !Number.isFinite(low) ||
        !Number.isFinite(high)
      ) {
        continue;
      }

      const isUp = resolveOhlcDirection(open, close) === 'up';
      const xPacked = timestamp - packingOrigin;
      const fillColor = isUp ? upColor : downColor;

      f32[outFloats + 0] = xPacked;
      f32[outFloats + 1] = open;
      f32[outFloats + 2] = close;
      f32[outFloats + 3] = low;
      f32[outFloats + 4] = high;
      f32[outFloats + 5] = tickLengthDomain;
      f32[outFloats + 6] = fillColor[0];
      f32[outFloats + 7] = fillColor[1];
      f32[outFloats + 8] = fillColor[2];
      f32[outFloats + 9] = fillColor[3];
      outFloats += INSTANCE_STRIDE_FLOATS;
    }

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
        label: 'ohlcRenderer/instanceBuffer',
        size: grownBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    if (instanceCount > 0) {
      device.queue.writeBuffer(instanceBuffer, 0, cpuInstanceStagingBuffer, 0, instanceCount * INSTANCE_STRIDE_BYTES);
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
      tickLengthDomain,
      upColor: upColorKey,
      downColor: downColorKey,
      instanceCount,
    };
  };

  const invalidateGeometry: OhlcRenderer['invalidateGeometry'] = () => {
    geometryCache = null;
  };

  const render: OhlcRenderer['render'] = (passEncoder) => {
    assertNotDisposed();

    if (!instanceBuffer || instanceCount === 0) return;

    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(lastScissor.x, lastScissor.y, lastScissor.w, lastScissor.h);
    }

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, instanceBuffer);
    passEncoder.draw(18, instanceCount);

    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    }
  };

  const dispose: OhlcRenderer['dispose'] = () => {
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

    lastCanvasWidth = 0;
    lastCanvasHeight = 0;
    lastScissor = null;
    geometryCache = null;
  };

  return { prepare, invalidateGeometry, render, dispose };
}
