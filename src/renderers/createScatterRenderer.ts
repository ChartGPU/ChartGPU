import scatterWgsl from '../shaders/scatter.wgsl?raw';
import type { ResolvedScatterSeriesConfig } from '../config/OptionResolver';
import type { DataPoint, DataPointTuple, ScatterPointTuple } from '../config/types';
import type { LinearScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import type { GridArea } from './createGridRenderer';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';

export interface ScatterRenderer {
  prepare(
    seriesConfig: ResolvedScatterSeriesConfig,
    data: ResolvedScatterSeriesConfig['data'],
    xScale: LinearScale,
    yScale: LinearScale,
    gridArea?: GridArea
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface ScatterRendererOptions {
  /**
   * Must match the canvas context format used for the render pass color attachment.
   * Usually this is `gpuContext.preferredFormat`.
   *
   * Defaults to `'bgra8unorm'` for backward compatibility.
   */
  readonly targetFormat?: GPUTextureFormat;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_SCATTER_RADIUS_CSS_PX = 4;
const INSTANCE_STRIDE_BYTES = 16; // center.xy, radiusPx, pad
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

const isTupleDataPoint = (point: DataPoint): point is DataPointTuple => Array.isArray(point);

const getPointXY = (point: DataPoint): { readonly x: number; readonly y: number } => {
  if (isTupleDataPoint(point)) return { x: point[0], y: point[1] };
  return { x: point.x, y: point.y };
};

const getPointSizeCssPx = (point: DataPoint): number | null => {
  if (isTupleDataPoint(point)) {
    const s = point[2];
    return typeof s === 'number' && Number.isFinite(s) ? s : null;
  }
  const s = point.size;
  return typeof s === 'number' && Number.isFinite(s) ? s : null;
};

const toScatterTuple = (point: DataPoint): ScatterPointTuple => {
  if (isTupleDataPoint(point)) return point;
  return [point.x, point.y, point.size] as const;
};

const computeDataBounds = (
  data: ReadonlyArray<DataPoint>
): { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number } => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < data.length; i++) {
    const { x, y } = getPointXY(data[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
  }

  // Avoid degenerate domains for affine derivation (handled later too, but keep stable samples).
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
};

const computeClipAffineFromScale = (
  scale: LinearScale,
  v0: number,
  v1: number
): { readonly a: number; readonly b: number } => {
  const p0 = scale.scale(v0);
  const p1 = scale.scale(v1);

  // If the domain sample is degenerate or non-finite, fall back to constant output.
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

const computePlotScissorDevicePx = (
  gridArea: GridArea
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } => {
  const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  const { canvasWidth, canvasHeight } = gridArea;

  const plotLeftDevice = gridArea.left * dpr;
  const plotRightDevice = canvasWidth - gridArea.right * dpr;
  const plotTopDevice = gridArea.top * dpr;
  const plotBottomDevice = canvasHeight - gridArea.bottom * dpr;

  const scissorX = clampInt(Math.floor(plotLeftDevice), 0, Math.max(0, canvasWidth));
  const scissorY = clampInt(Math.floor(plotTopDevice), 0, Math.max(0, canvasHeight));
  const scissorR = clampInt(Math.ceil(plotRightDevice), 0, Math.max(0, canvasWidth));
  const scissorB = clampInt(Math.ceil(plotBottomDevice), 0, Math.max(0, canvasHeight));
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
};

export function createScatterRenderer(device: GPUDevice, options?: ScatterRendererOptions): ScatterRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  // VSUniforms: mat4x4 (64) + viewportPx vec2 (8) + pad vec2 (8) = 80 bytes.
  const vsUniformBuffer = createUniformBuffer(device, 80, { label: 'scatterRenderer/vsUniforms' });
  const fsUniformBuffer = createUniformBuffer(device, 16, { label: 'scatterRenderer/fsUniforms' });

  // Reused CPU-side staging for uniform writes (avoid per-frame allocations).
  const vsUniformScratchBuffer = new ArrayBuffer(80);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);
  const fsUniformScratchF32 = new Float32Array(4);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBuffer } },
    ],
  });

  const pipeline = createRenderPipeline(device, {
    label: 'scatterRenderer/pipeline',
    bindGroupLayouts: [bindGroupLayout],
    vertex: {
      code: scatterWgsl,
      label: 'scatter.wgsl',
      buffers: [
        {
          arrayStride: INSTANCE_STRIDE_BYTES,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, format: 'float32x2', offset: 0 },
            { shaderLocation: 1, format: 'float32', offset: 8 },
          ],
        },
      ],
    },
    fragment: {
      code: scatterWgsl,
      label: 'scatter.wgsl',
      formats: targetFormat,
      // Standard alpha blending (circle AA uses alpha, and series color may be translucent).
      blend: {
        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: 1 },
  });

  let instanceBuffer: GPUBuffer | null = null;
  let instanceCount = 0;
  let cpuInstanceStagingBuffer = new ArrayBuffer(0);
  let cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);

  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let lastViewportPx: readonly [number, number] = [1, 1];
  let lastScissor: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null = null;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('ScatterRenderer is disposed.');
  };

  const ensureCpuInstanceCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuInstanceStagingF32.length) return;
    const nextFloats = Math.max(8, nextPow2(requiredFloats));
    cpuInstanceStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  };

  const writeVsUniforms = (
    ax: number,
    bx: number,
    ay: number,
    by: number,
    viewportW: number,
    viewportH: number
  ): void => {
    const w = Number.isFinite(viewportW) && viewportW > 0 ? viewportW : 1;
    const h = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : 1;

    writeTransformMat4F32(vsUniformScratchF32, ax, bx, ay, by);
    vsUniformScratchF32[16] = w;
    vsUniformScratchF32[17] = h;
    vsUniformScratchF32[18] = 0;
    vsUniformScratchF32[19] = 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);

    lastViewportPx = [w, h];
  };

  const prepare: ScatterRenderer['prepare'] = (seriesConfig, data, xScale, yScale, gridArea) => {
    assertNotDisposed();

    const { xMin, xMax, yMin, yMax } = computeDataBounds(data);
    const { a: ax, b: bx } = computeClipAffineFromScale(xScale, xMin, xMax);
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, yMin, yMax);

    if (gridArea) {
      lastCanvasWidth = gridArea.canvasWidth;
      lastCanvasHeight = gridArea.canvasHeight;
      writeVsUniforms(ax, bx, ay, by, gridArea.canvasWidth, gridArea.canvasHeight);
      lastScissor = computePlotScissorDevicePx(gridArea);
    } else {
      // Backward-compatible: keep rendering with the last known viewport (or safe default).
      writeVsUniforms(ax, bx, ay, by, lastViewportPx[0], lastViewportPx[1]);
      lastScissor = null;
    }

    const [r, g, b, a] = parseSeriesColorToRgba01(seriesConfig.color);
    fsUniformScratchF32[0] = r;
    fsUniformScratchF32[1] = g;
    fsUniformScratchF32[2] = b;
    fsUniformScratchF32[3] = clamp01(a);
    writeUniformBuffer(device, fsUniformBuffer, fsUniformScratchF32);

    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const hasValidDpr = dpr > 0 && Number.isFinite(dpr);

    const seriesSymbolSize = seriesConfig.symbolSize;
    const getSeriesSizeCssPx =
      typeof seriesSymbolSize === 'function'
        ? (point: DataPoint): number => {
            const v = seriesSymbolSize(toScatterTuple(point));
            return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_SCATTER_RADIUS_CSS_PX;
          }
        : typeof seriesSymbolSize === 'number' && Number.isFinite(seriesSymbolSize)
          ? (): number => seriesSymbolSize
          : (): number => DEFAULT_SCATTER_RADIUS_CSS_PX;

    ensureCpuInstanceCapacityFloats(data.length * INSTANCE_STRIDE_FLOATS);
    const f32 = cpuInstanceStagingF32;
    let outFloats = 0;

    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      const { x, y } = getPointXY(p);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const sizeCss = getPointSizeCssPx(p) ?? getSeriesSizeCssPx(p);
      const radiusCss = Number.isFinite(sizeCss) ? Math.max(0, sizeCss) : DEFAULT_SCATTER_RADIUS_CSS_PX;
      const radiusDevicePx = hasValidDpr ? radiusCss * dpr : radiusCss;
      if (!(radiusDevicePx > 0)) continue;

      f32[outFloats + 0] = x;
      f32[outFloats + 1] = y;
      f32[outFloats + 2] = radiusDevicePx;
      f32[outFloats + 3] = 0; // pad
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
        label: 'scatterRenderer/instanceBuffer',
        size: grownBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    if (instanceBuffer && instanceCount > 0) {
      device.queue.writeBuffer(instanceBuffer, 0, cpuInstanceStagingBuffer, 0, instanceCount * INSTANCE_STRIDE_BYTES);
    }
  };

  const render: ScatterRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (!instanceBuffer || instanceCount === 0) return;

    // Clip to plot area when available.
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(lastScissor.x, lastScissor.y, lastScissor.w, lastScissor.h);
    }

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, instanceBuffer);
    passEncoder.draw(6, instanceCount);

    // Reset scissor to full canvas to avoid impacting later renderers.
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    }
  };

  const dispose: ScatterRenderer['dispose'] = () => {
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
    try {
      fsUniformBuffer.destroy();
    } catch {
      // best-effort
    }

    lastCanvasWidth = 0;
    lastCanvasHeight = 0;
    lastViewportPx = [1, 1];
    lastScissor = null;
  };

  return { prepare, render, dispose };
}

