import candlestickWgsl from '../shaders/candlestick.wgsl?raw';
import type { ResolvedCandlestickSeriesConfig } from '../config/OptionResolver';
import type { OHLCDataPoint, OHLCDataPointTuple } from '../config/types';
import type { LinearScale } from '../utils/scales';
import type { GridArea } from './createGridRenderer';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { PipelineCache } from '../core/PipelineCache';

export interface CandlestickRenderer {
  prepare(
    series: ResolvedCandlestickSeriesConfig,
    data: ResolvedCandlestickSeriesConfig['data'],
    xScale: LinearScale,
    yScale: LinearScale,
    gridArea: GridArea,
    backgroundColor?: string
  ): void;
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

const parseSeriesColorToRgba01 = (color: string): Rgba =>
  parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

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
): { readonly timestamp: number; readonly open: number; readonly close: number; readonly low: number; readonly high: number } => {
  if (isTupleDataPoint(p)) {
    return { timestamp: p[0], open: p[1], close: p[2], low: p[3], high: p[4] };
  }
  return { timestamp: p.timestamp, open: p.open, close: p.close, low: p.low, high: p.high };
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
): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly width: number; readonly height: number } => {
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
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } => {
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

const computeCategoryWidthClip = (
  xScale: LinearScale,
  categoryStep: number,
  plotClipRect: Readonly<{ width: number }>,
  fallbackCategoryCount: number
): number => {
  if (Number.isFinite(categoryStep) && categoryStep > 0) {
    const x0 = 0;
    const p0 = xScale.scale(x0);
    const p1 = xScale.scale(x0 + categoryStep);
    const w = Math.abs(p1 - p0);
    if (Number.isFinite(w) && w > 0) return w;
  }

  const clipWidth = Math.abs(plotClipRect.width);
  if (!(clipWidth > 0)) return 0;
  const n = Math.max(1, Math.floor(fallbackCategoryCount));
  return clipWidth / n;
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

export function createCandlestickRenderer(device: GPUDevice, options?: CandlestickRendererOptions): CandlestickRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  });

  // VSUniforms: mat4x4 (64 bytes) + wickWidthClip f32 (4 bytes) + pad (12 bytes) = 80 bytes
  const vsUniformBuffer = createUniformBuffer(device, 80, { label: 'candlestickRenderer/vsUniforms' });
  writeUniformBuffer(device, vsUniformBuffer, createIdentityMat4Buffer()); // Default to identity

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

  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let lastScissor: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null = null;

  // Hollow mode state
  let hollowMode = false;
  let hollowInstanceBuffer: GPUBuffer | null = null;
  let hollowInstanceCount = 0;
  let cpuHollowStagingBuffer = new ArrayBuffer(0);
  let cpuHollowStagingF32 = new Float32Array(cpuHollowStagingBuffer);

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
      return;
    }

    const plotSize = computePlotSizeCssPx(gridArea);
    if (!plotSize) {
      instanceCount = 0;
      hollowInstanceCount = 0;
      return;
    }

    const plotClipRect = computePlotClipRect(gridArea);
    const clipPerCssX = plotSize.plotWidthCss > 0 ? plotClipRect.width / plotSize.plotWidthCss : 0;

    lastCanvasWidth = gridArea.canvasWidth;
    lastCanvasHeight = gridArea.canvasHeight;
    lastScissor = computePlotScissorDevicePx(gridArea);

    // Compute category step and width
    const categoryStep = computeCategoryStep(data);
    const categoryWidthClip = computeCategoryWidthClip(xScale, categoryStep, plotClipRect, data.length);

    // Compute body width in clip space
    let bodyWidthClip = 0;
    const rawBarWidth = series.barWidth;
    if (typeof rawBarWidth === 'number') {
      bodyWidthClip = Math.max(0, rawBarWidth) * clipPerCssX;
    } else if (typeof rawBarWidth === 'string') {
      const p = parsePercent(rawBarWidth);
      bodyWidthClip = p == null ? 0 : categoryWidthClip * clamp01(p);
    }

    // Apply min/max width constraints (CSS pixels converted to clip space)
    const minWidthClip = series.barMinWidth * clipPerCssX;
    const maxWidthClip = series.barMaxWidth * clipPerCssX;
    bodyWidthClip = Math.min(Math.max(bodyWidthClip, minWidthClip), maxWidthClip);

    // Compute wick width in clip space (default 1px CSS)
    const wickWidthCssPx = series.itemStyle.borderWidth ?? DEFAULT_WICK_WIDTH_CSS_PX;
    const wickWidthClip = Math.max(0, wickWidthCssPx) * clipPerCssX;

    // Write VS uniforms (identity transform + wick width)
    vsUniformScratchF32.set([
      1, 0, 0, 0, // col0
      0, 1, 0, 0, // col1
      0, 0, 1, 0, // col2
      0, 0, 0, 1, // col3
      wickWidthClip,
      0,
      0,
      0,
    ]);
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);

    // Parse colors
    const upColor = parseSeriesColorToRgba01(series.itemStyle.upColor);
    const downColor = parseSeriesColorToRgba01(series.itemStyle.downColor);
    const upBorderColor = parseSeriesColorToRgba01(series.itemStyle.upBorderColor);
    const downBorderColor = parseSeriesColorToRgba01(series.itemStyle.downBorderColor);
    const bgColor = backgroundColor ? parseSeriesColorToRgba01(backgroundColor) : ([0, 0, 0, 1] as const);

    hollowMode = series.style === 'hollow';

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
      if (!Number.isFinite(timestamp) || !Number.isFinite(open) || !Number.isFinite(close) || !Number.isFinite(low) || !Number.isFinite(high)) {
        continue;
      }

      const xClip = xScale.scale(timestamp);
      const openClip = yScale.scale(open);
      const closeClip = yScale.scale(close);
      const lowClip = yScale.scale(low);
      const highClip = yScale.scale(high);

      if (!Number.isFinite(xClip) || !Number.isFinite(openClip) || !Number.isFinite(closeClip) || !Number.isFinite(lowClip) || !Number.isFinite(highClip)) {
        continue;
      }

      const isUp = close > open;

      if (hollowMode) {
        // Pass 1: Draw all candles with border colors (body + wicks)
        const borderColor = isUp ? upBorderColor : downBorderColor;
        f32[outFloats + 0] = xClip;
        f32[outFloats + 1] = openClip;
        f32[outFloats + 2] = closeClip;
        f32[outFloats + 3] = lowClip;
        f32[outFloats + 4] = highClip;
        f32[outFloats + 5] = bodyWidthClip;
        f32[outFloats + 6] = borderColor[0];
        f32[outFloats + 7] = borderColor[1];
        f32[outFloats + 8] = borderColor[2];
        f32[outFloats + 9] = borderColor[3];
        outFloats += INSTANCE_STRIDE_FLOATS;

        // Pass 2: For UP candles only, draw body inset with background color to punch out interior
        if (isUp) {
          const borderWidthClip = series.itemStyle.borderWidth * clipPerCssX;
          const insetBodyWidthClip = Math.max(0, bodyWidthClip - 2 * borderWidthClip);

          hollowF32[hollowOutFloats + 0] = xClip;
          hollowF32[hollowOutFloats + 1] = openClip;
          hollowF32[hollowOutFloats + 2] = closeClip;
          hollowF32[hollowOutFloats + 3] = lowClip; // Not used for body-only draw, but keep for consistency
          hollowF32[hollowOutFloats + 4] = highClip; // Not used for body-only draw
          hollowF32[hollowOutFloats + 5] = insetBodyWidthClip;
          hollowF32[hollowOutFloats + 6] = bgColor[0];
          hollowF32[hollowOutFloats + 7] = bgColor[1];
          hollowF32[hollowOutFloats + 8] = bgColor[2];
          hollowF32[hollowOutFloats + 9] = bgColor[3];
          hollowOutFloats += INSTANCE_STRIDE_FLOATS;
        }
      } else {
        // Classic mode: draw candles with fill colors
        const fillColor = isUp ? upColor : downColor;
        f32[outFloats + 0] = xClip;
        f32[outFloats + 1] = openClip;
        f32[outFloats + 2] = closeClip;
        f32[outFloats + 3] = lowClip;
        f32[outFloats + 4] = highClip;
        f32[outFloats + 5] = bodyWidthClip;
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
        const grownBytes = Math.max(Math.max(4, nextPow2(hollowRequiredBytes)), hollowInstanceBuffer ? hollowInstanceBuffer.size : 0);
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
      device.queue.writeBuffer(hollowInstanceBuffer, 0, cpuHollowStagingBuffer, 0, hollowInstanceCount * INSTANCE_STRIDE_BYTES);
    }
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
  };

  return { prepare, render, dispose };
}
