import errorBarWgsl from '../shaders/errorBar.wgsl?raw';
import type { ResolvedErrorBarSeriesConfig } from '../config/OptionResolver';
import type { ErrorBarHlcArraysData, ErrorBarSeriesData } from '../config/types';
import type { ContinuousScale } from '../utils/scales';
import type { GridArea } from './createGridRenderer';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { PipelineCache } from '../core/PipelineCache';
import { resolveUploadPolicy } from '../data/seriesResidency';
import { computeClipAffineFromContinuousScale, resolveLogProjection } from './packedXAffine';
import {
  computeErrorBarCategoryStep,
  getErrorBarLength,
  getErrorBarPoint,
  isErrorBarSampleDrawable,
} from '../data/errorBarData';
import { resolveErrorBarCapLengthDomain } from './errorBarGeometry';

export interface ErrorBarRenderer {
  prepare(
    series: ResolvedErrorBarSeriesConfig,
    data: ErrorBarSeriesData,
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

export interface ErrorBarRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_BORDER_WIDTH_CSS = 1.5;
/** Instance: x,y,high,low + rgba = 8 floats = 32 bytes */
const INSTANCE_STRIDE_BYTES = 32;
const INSTANCE_STRIDE_FLOATS = INSTANCE_STRIDE_BYTES / 4;
/** VSUniforms: mat4(64) + 4 f32(16) + 2 f32 log + flags + pad = 96 */
const VS_UNIFORM_BYTES = 96;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

const parseSeriesColorToRgba01 = (color: string, opacity: number): Rgba => {
  const base = parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);
  const a = clamp01(base[3] * clamp01(opacity));
  return [base[0], base[1], base[2], a];
};

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
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

type ErrorBarGeometryCache = {
  readonly data: ErrorBarSeriesData;
  readonly dataLength: number;
  readonly lastX: number;
  readonly lastY: number;
  readonly lastHigh: number;
  readonly lastLow: number;
  readonly packingOrigin: number;
  readonly categoryStep: number;
  /**
   * Cap width config identity (CSS px number or percent string) — not domain-converted length.
   * Domain length is recomputed into uniforms on zoom without re-upload.
   */
  readonly capWidthKey: number | string;
  readonly color: string;
  readonly opacity: number;
  readonly borderWidth: number;
  readonly errorMode: string;
  readonly direction: string;
  readonly drawWhiskers: boolean;
  readonly drawConnector: boolean;
  readonly showCenter: boolean;
  readonly symbolSize: number;
  readonly instanceCount: number;
};

const lastBarFingerprint = (
  data: ErrorBarSeriesData
): { readonly x: number; readonly y: number; readonly high: number; readonly low: number } => {
  const n = getErrorBarLength(data);
  if (n === 0) {
    return { x: Number.NaN, y: Number.NaN, high: Number.NaN, low: Number.NaN };
  }
  const p = getErrorBarPoint(data, n - 1);
  if (!p) return { x: Number.NaN, y: Number.NaN, high: Number.NaN, low: Number.NaN };
  return { x: p.x, y: p.y, high: p.high, low: p.low };
};

const firstFiniteX = (data: ErrorBarSeriesData): number => {
  const n = getErrorBarLength(data);
  for (let i = 0; i < n; i++) {
    const p = getErrorBarPoint(data, i);
    if (p && Number.isFinite(p.x)) return p.x;
  }
  return 0;
};

function errorModeBits(mode: ResolvedErrorBarSeriesConfig['errorMode']): number {
  if (mode === 'high') return 1;
  if (mode === 'low') return 2;
  return 0;
}

/**
 * Functional-first GPU error-bar renderer (instanced stems + caps).
 */
export function createErrorBarRenderer(device: GPUDevice, options?: ErrorBarRendererOptions): ErrorBarRenderer {
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

  const vsUniformBuffer = createUniformBuffer(device, VS_UNIFORM_BYTES, {
    label: 'errorBarRenderer/vsUniforms',
  });
  const vsUniformScratchBuffer = new ArrayBuffer(VS_UNIFORM_BYTES);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'errorBarRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: errorBarWgsl,
        label: 'errorBar.wgsl',
        buffers: [
          {
            arrayStride: INSTANCE_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, format: 'float32', offset: 0 },
              { shaderLocation: 1, format: 'float32', offset: 4 },
              { shaderLocation: 2, format: 'float32', offset: 8 },
              { shaderLocation: 3, format: 'float32', offset: 12 },
              { shaderLocation: 4, format: 'float32x4', offset: 16 },
            ],
          },
        ],
      },
      fragment: {
        code: errorBarWgsl,
        label: 'errorBar.wgsl',
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

  let geometryCache: ErrorBarGeometryCache | null = null;
  /** Last prepare rewrote instance buffer (for dirty-gate tests). */
  let didRewritePointsLastPrepare = false;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('ErrorBarRenderer is disposed.');
  };

  const ensureCpuInstanceCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuInstanceStagingF32.length) return;
    const nextFloats = Math.max(8, nextPow2(requiredFloats));
    cpuInstanceStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  };

  const prepare: ErrorBarRenderer['prepare'] = (series, data, xScale, yScale, gridArea) => {
    assertNotDisposed();

    const n = getErrorBarLength(data);
    if (n === 0) {
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
    const clipPerCssY = plotSize.plotHeightCss > 0 ? plotClipRect.height / plotSize.plotHeightCss : 0;

    lastCanvasWidth = gridArea.canvasWidth;
    lastCanvasHeight = gridArea.canvasHeight;
    lastScissor = computePlotScissorDevicePx(gridArea);

    const horizontal = series.direction === 'horizontal';
    // Cap % uses category step along the category axis (Δx vertical, Δy horizontal).
    const categoryStep =
      geometryCache && geometryCache.data === data && geometryCache.direction === series.direction
        ? geometryCache.categoryStep
        : computeErrorBarCategoryStep(data, series.direction);
    // X affine probe step must stay in domain X even when caps use Δy for horizontal.
    const xProbeStep = horizontal ? computeErrorBarCategoryStep(data, 'vertical') : categoryStep;

    const packingOrigin =
      xScale.kind === 'log'
        ? 0
        : geometryCache && geometryCache.data === data
          ? geometryCache.packingOrigin
          : firstFiniteX(data);

    let ax: number;
    let bxPacked: number;
    if (xScale.kind === 'log') {
      const aff = computeClipAffineFromContinuousScale(xScale);
      ax = aff.a;
      bxPacked = aff.b;
    } else {
      const xDelta = Number.isFinite(xProbeStep) && xProbeStep > 0 ? xProbeStep : 1;
      const pX0 = xScale.scale(packingOrigin);
      const pX1 = xScale.scale(packingOrigin + xDelta);
      ax = Number.isFinite(pX0) && Number.isFinite(pX1) && xDelta !== 0 ? (pX1 - pX0) / xDelta : 0;
      bxPacked = Number.isFinite(pX0) ? pX0 : 0;
    }

    const { a: ay, b: by } = computeClipAffineFromContinuousScale(yScale);
    const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);

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

    const borderW =
      typeof series.itemStyle.borderWidth === 'number' &&
      Number.isFinite(series.itemStyle.borderWidth) &&
      series.itemStyle.borderWidth > 0
        ? series.itemStyle.borderWidth
        : DEFAULT_BORDER_WIDTH_CSS;

    // Stem thickness: cross-axis of stem direction. Cap thickness: along stem axis.
    const stemWidthDomain = horizontal ? cssHeightToDomainY(borderW) : cssWidthToDomainX(borderW);
    const capThicknessDomain = horizontal ? cssWidthToDomainX(borderW) : cssHeightToDomainY(borderW);

    let capWidthAsDomain: number | undefined;
    if (typeof series.capWidth === 'number' && Number.isFinite(series.capWidth)) {
      // CSS-px cap length: convert to domain along the cap axis (X vertical, Y horizontal).
      capWidthAsDomain = horizontal ? cssHeightToDomainY(series.capWidth) : cssWidthToDomainX(series.capWidth);
    }
    const capFullDomain = resolveErrorBarCapLengthDomain({
      capWidth: series.capWidth,
      categoryStep,
      capWidthAsDomain,
    });
    const capHalfLengthDomain = capFullDomain * 0.5;
    const capWidthKey: number | string = series.capWidth ?? '40%';

    // Center marker: square using max of X/Y CSS→domain for stable size.
    const symbolCss =
      typeof series.symbolSize === 'number' && Number.isFinite(series.symbolSize) && series.symbolSize > 0
        ? series.symbolSize
        : 6;
    const symbolHalfDomain = Math.max(cssWidthToDomainX(symbolCss), cssHeightToDomainY(symbolCss)) * 0.5;

    const colorKey = series.itemStyle.color;
    const opacity = series.itemStyle.opacity;
    const lastFp = lastBarFingerprint(data);

    // Geometry identity: data + style + packing. Cap width keyed as CSS/config (not domain)
    // so pure zoom recomputes uniforms only (Issue 10).
    const geometryHit =
      geometryCache != null &&
      instanceBuffer != null &&
      geometryCache.data === data &&
      geometryCache.dataLength === n &&
      nearEqual(geometryCache.lastX, lastFp.x) &&
      nearEqual(geometryCache.lastY, lastFp.y) &&
      nearEqual(geometryCache.lastHigh, lastFp.high) &&
      nearEqual(geometryCache.lastLow, lastFp.low) &&
      nearEqual(geometryCache.packingOrigin, packingOrigin) &&
      nearEqual(geometryCache.categoryStep, categoryStep) &&
      geometryCache.capWidthKey === capWidthKey &&
      geometryCache.color === colorKey &&
      nearEqual(geometryCache.opacity, opacity) &&
      nearEqual(geometryCache.borderWidth, borderW) &&
      geometryCache.errorMode === series.errorMode &&
      geometryCache.direction === series.direction &&
      geometryCache.drawWhiskers === series.drawWhiskers &&
      geometryCache.drawConnector === series.drawConnector &&
      geometryCache.showCenter === series.showCenter &&
      nearEqual(geometryCache.symbolSize, symbolCss);

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

    let drawFlags = errorModeBits(series.errorMode);
    if (series.drawWhiskers) drawFlags |= 4;
    if (series.drawConnector) drawFlags |= 8;
    if (series.showCenter) drawFlags |= 16;
    if (horizontal) drawFlags |= 32;

    const vsUniformScratchU32 = new Uint32Array(vsUniformScratchBuffer);
    const writeVsUniforms = (): void => {
      writeTransformMat4F32(vsUniformScratchF32, ax, bxPacked, ay, by);
      vsUniformScratchF32[16] = stemWidthDomain;
      vsUniformScratchF32[17] = capThicknessDomain;
      vsUniformScratchF32[18] = capHalfLengthDomain;
      vsUniformScratchF32[19] = symbolHalfDomain;
      vsUniformScratchF32[20] = logBaseX;
      vsUniformScratchF32[21] = logBaseY;
      vsUniformScratchU32[22] = logFlags >>> 0;
      vsUniformScratchU32[23] = drawFlags >>> 0;
      writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
    };

    if (policy === 'skip' && geometryCache) {
      instanceCount = geometryCache.instanceCount;
      didRewritePointsLastPrepare = false;
      writeVsUniforms();
      return;
    }

    didRewritePointsLastPrepare = true;
    const fillColor = parseSeriesColorToRgba01(colorKey, opacity);
    writeVsUniforms();

    ensureCpuInstanceCapacityFloats(n * INSTANCE_STRIDE_FLOATS);
    const f32 = cpuInstanceStagingF32;
    let outFloats = 0;

    for (let i = 0; i < n; i++) {
      const p = getErrorBarPoint(data, i);
      if (!isErrorBarSampleDrawable(p, series.errorMode)) continue;

      // Relative domain X for packing origin (f32 epoch safety). Vertical: only center x.
      // Horizontal: high/low are absolute X endpoints — pack relative to origin too (Issue 2).
      const xPacked = p.x - packingOrigin;
      const highPacked = horizontal ? p.high - packingOrigin : p.high;
      const lowPacked = horizontal ? p.low - packingOrigin : p.low;
      f32[outFloats + 0] = xPacked;
      f32[outFloats + 1] = p.y;
      f32[outFloats + 2] = highPacked;
      f32[outFloats + 3] = lowPacked;
      f32[outFloats + 4] = fillColor[0];
      f32[outFloats + 5] = fillColor[1];
      f32[outFloats + 6] = fillColor[2];
      f32[outFloats + 7] = fillColor[3];
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
        label: 'errorBarRenderer/instanceBuffer',
        size: grownBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    if (instanceCount > 0) {
      device.queue.writeBuffer(instanceBuffer, 0, cpuInstanceStagingBuffer, 0, instanceCount * INSTANCE_STRIDE_BYTES);
    }

    geometryCache = {
      data,
      dataLength: n,
      lastX: lastFp.x,
      lastY: lastFp.y,
      lastHigh: lastFp.high,
      lastLow: lastFp.low,
      packingOrigin,
      categoryStep,
      capWidthKey,
      color: colorKey,
      opacity,
      borderWidth: borderW,
      errorMode: series.errorMode,
      direction: series.direction,
      drawWhiskers: series.drawWhiskers,
      drawConnector: series.drawConnector,
      showCenter: series.showCenter,
      symbolSize: symbolCss,
      instanceCount,
    };
  };

  const invalidateGeometry: ErrorBarRenderer['invalidateGeometry'] = () => {
    geometryCache = null;
  };

  /** @internal Dirty-gate tests — true when last prepare rewrote instance buffer. */
  const didRewritePointsLastPrepareFn = (): boolean => didRewritePointsLastPrepare;

  const render: ErrorBarRenderer['render'] = (passEncoder) => {
    assertNotDisposed();

    if (!instanceBuffer || instanceCount === 0) return;

    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(lastScissor.x, lastScissor.y, lastScissor.w, lastScissor.h);
    }

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, instanceBuffer);
    passEncoder.draw(24, instanceCount);

    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    }
  };

  const dispose: ErrorBarRenderer['dispose'] = () => {
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

  return {
    prepare,
    invalidateGeometry,
    render,
    dispose,
    // Test/diagnostic hook (not part of public ErrorBarRenderer surface in types, but present on instance)
    didRewritePointsLastPrepare: didRewritePointsLastPrepareFn,
  } as ErrorBarRenderer & { didRewritePointsLastPrepare(): boolean };
}

// Re-export for tests that inspect packing stride
export const ERROR_BAR_INSTANCE_STRIDE_BYTES = INSTANCE_STRIDE_BYTES;
export type { ErrorBarHlcArraysData };
