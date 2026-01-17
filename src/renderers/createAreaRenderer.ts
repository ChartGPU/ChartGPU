import areaWgsl from '../shaders/area.wgsl?raw';
import type { ResolvedAreaSeriesConfig } from '../config/OptionResolver';
import type { LinearScale } from '../utils/scales';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';

export interface AreaRenderer {
  prepare(
    seriesConfig: ResolvedAreaSeriesConfig,
    data: ResolvedAreaSeriesConfig['data'],
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
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const parseHexNibble = (hex: string): number => {
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0;
};

const parseHexByte = (hex: string): number => {
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0;
};

const parseHexColorToRgba = (color: string): Rgba => {
  const c = color.trim();
  if (!c.startsWith('#')) return [0, 0, 0, 1];

  const hex = c.slice(1);

  // #rgb
  if (hex.length === 3) {
    const r = parseHexNibble(hex[0]);
    const g = parseHexNibble(hex[1]);
    const b = parseHexNibble(hex[2]);
    return [(r * 17) / 255, (g * 17) / 255, (b * 17) / 255, 1];
  }

  // #rgba
  if (hex.length === 4) {
    const r = parseHexNibble(hex[0]);
    const g = parseHexNibble(hex[1]);
    const b = parseHexNibble(hex[2]);
    const a = parseHexNibble(hex[3]);
    return [(r * 17) / 255, (g * 17) / 255, (b * 17) / 255, (a * 17) / 255];
  }

  // #rrggbb
  if (hex.length === 6) {
    const r = parseHexByte(hex.slice(0, 2));
    const g = parseHexByte(hex.slice(2, 4));
    const b = parseHexByte(hex.slice(4, 6));
    return [r / 255, g / 255, b / 255, 1];
  }

  // #rrggbbaa
  if (hex.length === 8) {
    const r = parseHexByte(hex.slice(0, 2));
    const g = parseHexByte(hex.slice(2, 4));
    const b = parseHexByte(hex.slice(4, 6));
    const a = parseHexByte(hex.slice(6, 8));
    return [r / 255, g / 255, b / 255, a / 255];
  }

  return [0, 0, 0, 1];
};

const isTupleDataPoint = (point: ResolvedAreaSeriesConfig['data'][number]): point is readonly [x: number, y: number] =>
  Array.isArray(point);

const getPointXY = (
  point: ResolvedAreaSeriesConfig['data'][number]
): { readonly x: number; readonly y: number } => {
  if (isTupleDataPoint(point)) return { x: point[0], y: point[1] };
  return { x: point.x, y: point.y };
};

const computeDataBounds = (
  data: ResolvedAreaSeriesConfig['data']
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

const createVsUniformBuffer = (transformMat4: ArrayBuffer, baseline: number): ArrayBuffer => {
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
  const buffer = new ArrayBuffer(96);
  const f32 = new Float32Array(buffer);
  f32.set(new Float32Array(transformMat4), 0);
  f32[16] = baseline;
  return buffer;
};

const createAreaVertices = (data: ResolvedAreaSeriesConfig['data']): Float32Array => {
  // Triangle-strip expects duplicated vertices:
  // p0,p0,p1,p1,... and WGSL uses vertex_index parity to swap y to baseline for odd indices.
  const n = data.length;
  const out = new Float32Array(n * 2 * 2); // n * 2 vertices * vec2<f32>

  let idx = 0;
  for (let i = 0; i < n; i++) {
    const { x, y } = getPointXY(data[i]);
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

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 96, { label: 'areaRenderer/vsUniforms' });
  const fsUniformBuffer = createUniformBuffer(device, 16, { label: 'areaRenderer/fsUniforms' });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBuffer } },
    ],
  });

  const pipeline = createRenderPipeline(device, {
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
  });

  let vertexBuffer: GPUBuffer | null = null;
  let vertexCount = 0;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('AreaRenderer is disposed.');
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

    const { xMin, xMax, yMin, yMax } = computeDataBounds(data);
    const { a: ax, b: bx } = computeClipAffineFromScale(xScale, xMin, xMax);
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, yMin, yMax);

    const baselineValue =
      Number.isFinite(baseline ?? Number.NaN) ? (baseline as number) : Number.isFinite(yMin) ? yMin : 0;

    const transformBuffer = createTransformMat4Buffer(ax, bx, ay, by);
    writeUniformBuffer(device, vsUniformBuffer, createVsUniformBuffer(transformBuffer, baselineValue));

    const [r, g, b, a] = parseHexColorToRgba(seriesConfig.color);
    const opacity = clamp01(seriesConfig.areaStyle.opacity);
    const colorBuffer = new ArrayBuffer(4 * 4);
    new Float32Array(colorBuffer).set([r, g, b, clamp01(a * opacity)]);
    writeUniformBuffer(device, fsUniformBuffer, colorBuffer);
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

