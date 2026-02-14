import areaWgsl from '../shaders/area.wgsl?raw';
import type { ResolvedAreaSeriesConfig } from '../config/OptionResolver';
import type { CartesianSeriesData } from '../config/types';
import type { LinearScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { getPointCount, getX, getY, computeRawBoundsFromCartesianData } from '../data/cartesianData';
import type { PipelineCache } from '../core/PipelineCache';

export interface AreaRenderer {
  prepare(
    seriesConfig: ResolvedAreaSeriesConfig,
    data: CartesianSeriesData,
    xScale: LinearScale,
    yScale: LinearScale,
    baseline?: number
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
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
   * Optional shared cache for shader modules + render pipelines.
   */
  readonly pipelineCache?: PipelineCache;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const parseSeriesColorToRgba01 = (color: string): Rgba =>
  parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);


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

const createAreaVertices = (data: CartesianSeriesData): Float32Array => {
  // Triangle-strip expects duplicated vertices:
  // p0,p0,p1,p1,... and WGSL uses vertex_index parity to swap y to baseline for odd indices.
  const n = getPointCount(data);
  const out = new Float32Array(n * 2 * 2); // n * 2 vertices * vec2<f32>

  let idx = 0;
  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    const y = getY(data, i);
    out[idx++] = x;
    out[idx++] = y;
    out[idx++] = x;
    out[idx++] = y;
  }

  return out;
};

export function createAreaRenderer(device: GPUDevice, options?: AreaRendererOptions): AreaRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 96, { label: 'areaRenderer/vsUniforms' });
  const fsUniformBuffer = createUniformBuffer(device, 16, { label: 'areaRenderer/fsUniforms' });

  // Reused CPU-side staging for uniform writes (avoid per-frame allocations).
  const vsUniformScratchBuffer = new ArrayBuffer(96);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);
  const fsUniformScratchF32 = new Float32Array(4);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBuffer } },
    ],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'areaRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: areaWgsl,
        label: 'area.wgsl',
        buffers: [
          {
            arrayStride: 8,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, format: 'float32x2', offset: 0 }],
          },
        ],
      },
      fragment: {
        code: areaWgsl,
        label: 'area.wgsl',
        formats: targetFormat,
        // Enable standard alpha blending so `areaStyle.opacity` behaves correctly.
        blend: {
          color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
      },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      multisample: { count: 1 },
    },
    pipelineCache
  );

  let vertexBuffer: GPUBuffer | null = null;
  let vertexCount = 0;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('AreaRenderer is disposed.');
  };

  const writeVsUniforms = (ax: number, bx: number, ay: number, by: number, baseline: number): void => {
    // VSUniforms:
    // - mat4x4<f32> (64 bytes)
    // - baseline: f32 (4 bytes)
    // - (implicit padding to next 16B boundary) (12 bytes)
    // - _pad0: vec3<f32> (occupies 16 bytes in a uniform buffer)
    // Total: 96 bytes.
    //
    // Layout details (uniform address space):
    // - transform at byte offset 0
    // - baseline at byte offset 64 (f32[16])
    // - _pad0 at byte offset 80 (f32[20..22]) with trailing 4B padding
    writeTransformMat4F32(vsUniformScratchF32, ax, bx, ay, by);
    vsUniformScratchF32[16] = baseline;
    vsUniformScratchF32[17] = 0;
    vsUniformScratchF32[18] = 0;
    vsUniformScratchF32[19] = 0;
    vsUniformScratchF32[20] = 0;
    vsUniformScratchF32[21] = 0;
    vsUniformScratchF32[22] = 0;
    vsUniformScratchF32[23] = 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
  };

  const prepare: AreaRenderer['prepare'] = (seriesConfig, data, xScale, yScale, baseline) => {
    assertNotDisposed();

    const vertices = createAreaVertices(data);
    const requiredSize = vertices.byteLength;
    const bufferSize = Math.max(4, requiredSize);

    if (!vertexBuffer || vertexBuffer.size < bufferSize) {
      if (vertexBuffer) {
        try {
          vertexBuffer.destroy();
        } catch {
          // best-effort
        }
      }
      vertexBuffer = device.createBuffer({
        label: 'areaRenderer/vertexBuffer',
        size: bufferSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    if (vertices.byteLength > 0) {
      device.queue.writeBuffer(vertexBuffer, 0, vertices.buffer, 0, vertices.byteLength);
    }
    vertexCount = vertices.length / 2;

    const bounds = computeRawBoundsFromCartesianData(data);
    const { xMin, xMax, yMin, yMax } = bounds ?? { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    const { a: ax, b: bx } = computeClipAffineFromScale(xScale, xMin, xMax);
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, yMin, yMax);

    const baselineValue =
      Number.isFinite(baseline ?? Number.NaN) ? (baseline as number) : Number.isFinite(yMin) ? yMin : 0;

    writeVsUniforms(ax, bx, ay, by, baselineValue);

    // Use the resolved fill color from areaStyle.color (not seriesConfig.color).
    const [r, g, b, a] = parseSeriesColorToRgba01(seriesConfig.areaStyle.color);
    const opacity = clamp01(seriesConfig.areaStyle.opacity);
    fsUniformScratchF32[0] = r;
    fsUniformScratchF32[1] = g;
    fsUniformScratchF32[2] = b;
    fsUniformScratchF32[3] = clamp01(a * opacity);
    writeUniformBuffer(device, fsUniformBuffer, fsUniformScratchF32);
  };

  const render: AreaRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (!vertexBuffer || vertexCount < 4) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, vertexBuffer);
    passEncoder.draw(vertexCount);
  };

  const dispose: AreaRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    if (vertexBuffer) {
      try {
        vertexBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    vertexBuffer = null;
    vertexCount = 0;

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

