/**
 * Impulse / stem series GPU renderer.
 *
 * One vertical stem per sample from baseline → y, optional center marker at (x, y).
 * Reuses errorBar.wgsl instance layout (x, y, high, low, rgba) with:
 * - high = y, low = baseline, errorMode both, vertical, connector on, whiskers off
 * - showCenter when series.showMarker
 *
 * Stem thickness in CSS px → domain X (error-bar / OHLC lesson).
 */

import errorBarWgsl from '../shaders/errorBar.wgsl?raw';
import type { ResolvedImpulseSeriesConfig } from '../config/OptionResolver';
import type { CartesianSeriesData } from '../config/types';
import type { ContinuousScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { PipelineCache } from '../core/PipelineCache';
import { resolveUploadPolicy } from '../data/seriesResidency';
import { computeClipAffineFromContinuousScale, resolveLogProjection } from './packedXAffine';
import { getPointCount, getX, getY } from '../data/cartesianData';
import type { GridArea } from './createGridRenderer';

export interface ImpulseRenderer {
  prepare(
    series: ResolvedImpulseSeriesConfig,
    data: CartesianSeriesData,
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

export interface ImpulseRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_STEM_WIDTH_CSS = 2;
/** Instance: x,y,high,low + rgba = 8 floats = 32 bytes (same as errorBar). */
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

type ImpulseGeometryCache = {
  readonly data: CartesianSeriesData;
  readonly dataLength: number;
  readonly lastX: number;
  readonly lastY: number;
  readonly packingOrigin: number;
  readonly color: string;
  readonly opacity: number;
  readonly borderWidth: number;
  readonly baseline: number;
  readonly showMarker: boolean;
  readonly symbolSize: number;
  readonly instanceCount: number;
};

const lastSampleFingerprint = (data: CartesianSeriesData): { readonly x: number; readonly y: number } => {
  const n = getPointCount(data);
  if (n === 0) return { x: Number.NaN, y: Number.NaN };
  return { x: getX(data, n - 1), y: getY(data, n - 1) };
};

const firstFiniteX = (data: CartesianSeriesData): number => {
  const n = getPointCount(data);
  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    if (Number.isFinite(x)) return x;
  }
  return 0;
};

/**
 * errorBar.wgsl drawFlags for impulse: connector on, whiskers off, vertical,
 * optional center marker (showCenter bit).
 * Exported for unit tests (must stay whisker-free).
 */
export function impulseDrawFlags(showMarker: boolean): number {
  // bit3 drawConnector | bit4 showCenter
  return showMarker ? 8 | 16 : 8;
}

/**
 * Geometry dirty gate fingerprints last sample only (same class as errorBar).
 * Mid-buffer in-place mutation under a stable array reference will not re-pack
 * unless {@link ImpulseRenderer.invalidateGeometry} is called (animation path does).
 */

/**
 * Functional-first GPU impulse renderer (instanced stems + optional markers).
 */
export function createImpulseRenderer(device: GPUDevice, options?: ImpulseRendererOptions): ImpulseRenderer {
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
    label: 'impulseRenderer/vsUniforms',
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
      label: 'impulseRenderer/pipeline',
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

  let geometryCache: ImpulseGeometryCache | null = null;
  let didRewritePointsLastPrepare = false;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('ImpulseRenderer is disposed.');
  };

  const ensureCpuInstanceCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuInstanceStagingF32.length) return;
    const nextFloats = Math.max(8, nextPow2(requiredFloats));
    cpuInstanceStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  };

  const prepare: ImpulseRenderer['prepare'] = (series, data, xScale, yScale, gridArea) => {
    assertNotDisposed();

    const n = getPointCount(data);
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
      const pX0 = xScale.scale(packingOrigin);
      const pX1 = xScale.scale(packingOrigin + 1);
      ax = Number.isFinite(pX0) && Number.isFinite(pX1) ? pX1 - pX0 : 0;
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
      typeof series.lineStyle.width === 'number' &&
      Number.isFinite(series.lineStyle.width) &&
      series.lineStyle.width > 0
        ? series.lineStyle.width
        : DEFAULT_STEM_WIDTH_CSS;

    const stemWidthDomain = cssWidthToDomainX(borderW);
    // Cap thickness unused (whiskers off); keep a positive value for shader safety.
    const capThicknessDomain = cssHeightToDomainY(borderW);
    const capHalfLengthDomain = 0;

    const symbolCss =
      typeof series.symbolSize === 'number' && Number.isFinite(series.symbolSize) && series.symbolSize > 0
        ? series.symbolSize
        : 6;
    const symbolHalfDomain = Math.max(cssWidthToDomainX(symbolCss), cssHeightToDomainY(symbolCss)) * 0.5;

    const colorKey = series.lineStyle.color;
    const opacity = series.lineStyle.opacity;
    const baseline = Number.isFinite(series.baseline) ? series.baseline : 0;
    const showMarker = series.showMarker !== false;
    const lastFp = lastSampleFingerprint(data);

    const geometryHit =
      geometryCache != null &&
      instanceBuffer != null &&
      geometryCache.data === data &&
      geometryCache.dataLength === n &&
      nearEqual(geometryCache.lastX, lastFp.x) &&
      nearEqual(geometryCache.lastY, lastFp.y) &&
      nearEqual(geometryCache.packingOrigin, packingOrigin) &&
      geometryCache.color === colorKey &&
      nearEqual(geometryCache.opacity, opacity) &&
      nearEqual(geometryCache.borderWidth, borderW) &&
      nearEqual(geometryCache.baseline, baseline) &&
      geometryCache.showMarker === showMarker &&
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

    // errorBar.wgsl flags: errorMode both (0), drawWhiskers off, drawConnector on,
    // showCenter = showMarker, vertical.
    const drawFlags = impulseDrawFlags(showMarker);

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

    const ZERO_EPS = 1e-15;
    for (let i = 0; i < n; i++) {
      const x = getX(data, i);
      const y = getY(data, i);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      // D4: skip zero-length stems when marker is off (no draw). With marker on we still
      // pack so the center marker instance draws (stem is degenerate zero-height quad —
      // errorBar.wgsl drawFlags are uniform, not per-instance).
      const zeroLength = Math.abs(y - baseline) <= ZERO_EPS;
      if (zeroLength && !showMarker) continue;

      // high=y, low=baseline → stem baseline↔y; marker at y when showCenter.
      const xPacked = x - packingOrigin;
      f32[outFloats + 0] = xPacked;
      f32[outFloats + 1] = y;
      f32[outFloats + 2] = y;
      f32[outFloats + 3] = baseline;
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
        label: 'impulseRenderer/instanceBuffer',
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
      packingOrigin,
      color: colorKey,
      opacity,
      borderWidth: borderW,
      baseline,
      showMarker,
      symbolSize: symbolCss,
      instanceCount,
    };
  };

  const invalidateGeometry: ImpulseRenderer['invalidateGeometry'] = () => {
    geometryCache = null;
  };

  const didRewritePointsLastPrepareFn = (): boolean => didRewritePointsLastPrepare;

  const render: ImpulseRenderer['render'] = (passEncoder) => {
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

  const dispose: ImpulseRenderer['dispose'] = () => {
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
    didRewritePointsLastPrepare: didRewritePointsLastPrepareFn,
  } as ImpulseRenderer & { didRewritePointsLastPrepare(): boolean };
}

export const IMPULSE_INSTANCE_STRIDE_BYTES = INSTANCE_STRIDE_BYTES;
