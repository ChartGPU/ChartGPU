import lineWgsl from '../shaders/line.wgsl?raw';
import type { ResolvedLineSeriesConfig } from '../config/OptionResolver';
import type { DataPointTuple } from '../config/types';
import type { LinearScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';

export interface LineRenderer {
  prepare(seriesConfig: ResolvedLineSeriesConfig, dataBuffer: GPUBuffer, xScale: LinearScale, yScale: LinearScale): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface LineRendererOptions {
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

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const parseSeriesColorToRgba01 = (color: string): Rgba =>
  parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const isTupleDataPoint = (
  point: ResolvedLineSeriesConfig['data'][number]
): point is DataPointTuple => Array.isArray(point);

const getPointXY = (point: ResolvedLineSeriesConfig['data'][number]): { readonly x: number; readonly y: number } => {
  if (isTupleDataPoint(point)) return { x: point[0], y: point[1] };
  return { x: point.x, y: point.y };
};

const computeDataBounds = (
  data: ResolvedLineSeriesConfig['data']
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

const createTransformMat4Buffer = (ax: number, bx: number, ay: number, by: number): ArrayBuffer => {
  // Column-major mat4x4 for: clip = M * vec4(x, y, 0, 1)
  //
  // Note: We allocate an explicit `ArrayBuffer` so it typechecks cleanly with
  // `@webgpu/types` (avoids `ArrayBufferLike`/`SharedArrayBuffer` issues).
  const buffer = new ArrayBuffer(16 * 4);
  new Float32Array(buffer).set([
    ax,
    0,
    0,
    0, // col0
    0,
    ay,
    0,
    0, // col1
    0,
    0,
    1,
    0, // col2
    bx,
    by,
    0,
    1, // col3
  ]);
  return buffer;
};

export function createLineRenderer(device: GPUDevice, options?: LineRendererOptions): LineRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 64, { label: 'lineRenderer/vsUniforms' });
  const fsUniformBuffer = createUniformBuffer(device, 16, { label: 'lineRenderer/fsUniforms' });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBuffer } },
    ],
  });

  const pipeline = createRenderPipeline(device, {
    label: 'lineRenderer/pipeline',
    bindGroupLayouts: [bindGroupLayout],
    vertex: {
      code: lineWgsl,
      label: 'line.wgsl',
      buffers: [
        {
          arrayStride: 8,
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, format: 'float32x2', offset: 0 }],
        },
      ],
    },
    fragment: {
      code: lineWgsl,
      label: 'line.wgsl',
      formats: targetFormat,
      // Enable standard alpha blending so per-series `lineStyle.opacity` behaves
      // correctly against an opaque cleared background.
      blend: {
        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    },
    primitive: { topology: 'line-strip', cullMode: 'none' },
    multisample: { count: 1 },
  });

  let currentVertexBuffer: GPUBuffer | null = null;
  let currentVertexCount = 0;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('LineRenderer is disposed.');
  };

  const prepare: LineRenderer['prepare'] = (seriesConfig, dataBuffer, xScale, yScale) => {
    assertNotDisposed();

    currentVertexBuffer = dataBuffer;
    currentVertexCount = seriesConfig.data.length;

    const { xMin, xMax, yMin, yMax } = computeDataBounds(seriesConfig.data);
    const { a: ax, b: bx } = computeClipAffineFromScale(xScale, xMin, xMax);
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, yMin, yMax);

    const transformBuffer = createTransformMat4Buffer(ax, bx, ay, by);
    writeUniformBuffer(device, vsUniformBuffer, transformBuffer);

    const [r, g, b, a] = parseSeriesColorToRgba01(seriesConfig.color);
    const opacity = clamp01(seriesConfig.lineStyle.opacity);
    const colorBuffer = new ArrayBuffer(4 * 4);
    new Float32Array(colorBuffer).set([r, g, b, clamp01(a * opacity)]);
    writeUniformBuffer(device, fsUniformBuffer, colorBuffer);
  };

  const render: LineRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (!currentVertexBuffer || currentVertexCount < 2) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, currentVertexBuffer);
    passEncoder.draw(currentVertexCount);
  };

  const dispose: LineRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    currentVertexBuffer = null;
    currentVertexCount = 0;

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

  return { prepare, render, dispose };
}
