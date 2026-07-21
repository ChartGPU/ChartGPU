/**
 * 3D axes: AABB edge box + wall/floor grids + tick marks (line-list GPU).
 * Numeric labels / titles: GPU atlas or DOM (see createAxes3DGpuLabelsRenderer / axes3dLabels).
 */

import axisBoxWgsl from '../shaders/axisBox3d.wgsl?raw';
import type { AABB } from '../core/3d/aabb';
import type { Mat4 } from '../core/3d/mat4';
import type { PipelineCache } from '../core/PipelineCache';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { generateNiceAxisTicks3D, resolveAxisDomain3D } from '../core/3d/axisTicks3d';
import type { ResolvedAxes3D } from '../config/OptionResolver';

export type Axes3DTickPlan = Readonly<{
  readonly xTicks: readonly number[];
  readonly yTicks: readonly number[];
  readonly zTicks: readonly number[];
  readonly xDomain: Readonly<{ min: number; max: number }>;
  readonly yDomain: Readonly<{ min: number; max: number }>;
  readonly zDomain: Readonly<{ min: number; max: number }>;
}>;

export interface AxisBox3DRenderer {
  /**
   * Prepare box / grid / ticks for the scene AABB and axes options.
   * Returns the tick plan used for GPU/DOM axis labels.
   */
  prepare(
    aabb: AABB,
    viewProj: Mat4,
    colorRgba: readonly [number, number, number, number],
    axes: ResolvedAxes3D,
    gridColorRgba?: readonly [number, number, number, number]
  ): Axes3DTickPlan;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface AxisBox3DRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
}

const VS_UNIFORM_SIZE = 80; // mat4 + vec4

const depthStencil: GPUDepthStencilState = {
  format: 'depth24plus',
  depthWriteEnabled: false,
  depthCompare: 'less-equal',
};

const TICK_FRAC = 0.03; // tick length as fraction of axis span

/** Build line-list positions (xyz float triples) for box + optional grid + ticks. */
export function buildAxes3DLines(aabb: AABB, axes: ResolvedAxes3D, plan: Axes3DTickPlan): Float32Array {
  const [x0, y0, z0] = aabb.min;
  const [x1, y1, z1] = aabb.max;
  const parts: number[] = [];

  const pushLine = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
    parts.push(ax, ay, az, bx, by, bz);
  };

  if (axes.showBox) {
    // 12 edges
    pushLine(x0, y0, z0, x1, y0, z0);
    pushLine(x1, y0, z0, x1, y1, z0);
    pushLine(x1, y1, z0, x0, y1, z0);
    pushLine(x0, y1, z0, x0, y0, z0);
    pushLine(x0, y0, z1, x1, y0, z1);
    pushLine(x1, y0, z1, x1, y1, z1);
    pushLine(x1, y1, z1, x0, y1, z1);
    pushLine(x0, y1, z1, x0, y0, z1);
    pushLine(x0, y0, z0, x0, y0, z1);
    pushLine(x1, y0, z0, x1, y0, z1);
    pushLine(x1, y1, z0, x1, y1, z1);
    pushLine(x0, y1, z0, x0, y1, z1);
  }

  if (axes.showGrid) {
    // Floor (y = y0): X and Z lines
    if (axes.x.visible) {
      for (const xv of plan.xTicks) {
        if (xv < Math.min(x0, x1) - 1e-9 || xv > Math.max(x0, x1) + 1e-9) continue;
        pushLine(xv, y0, z0, xv, y0, z1);
      }
    }
    if (axes.z.visible) {
      for (const zv of plan.zTicks) {
        if (zv < Math.min(z0, z1) - 1e-9 || zv > Math.max(z0, z1) + 1e-9) continue;
        pushLine(x0, y0, zv, x1, y0, zv);
      }
    }
    // Back wall (z = z0): X and Y
    if (axes.x.visible) {
      for (const xv of plan.xTicks) {
        if (xv < Math.min(x0, x1) - 1e-9 || xv > Math.max(x0, x1) + 1e-9) continue;
        pushLine(xv, y0, z0, xv, y1, z0);
      }
    }
    if (axes.y.visible) {
      for (const yv of plan.yTicks) {
        if (yv < Math.min(y0, y1) - 1e-9 || yv > Math.max(y0, y1) + 1e-9) continue;
        pushLine(x0, yv, z0, x1, yv, z0);
      }
    }
    // Side wall (x = x0): Z and Y
    if (axes.z.visible) {
      for (const zv of plan.zTicks) {
        if (zv < Math.min(z0, z1) - 1e-9 || zv > Math.max(z0, z1) + 1e-9) continue;
        pushLine(x0, y0, zv, x0, y1, zv);
      }
    }
    if (axes.y.visible) {
      for (const yv of plan.yTicks) {
        if (yv < Math.min(y0, y1) - 1e-9 || yv > Math.max(y0, y1) + 1e-9) continue;
        pushLine(x0, yv, z0, x0, yv, z1);
      }
    }
  }

  // Tick marks slightly outside the box on the three far edges from origin of min corner
  const sx = Math.abs(x1 - x0) || 1;
  const sy = Math.abs(y1 - y0) || 1;
  const sz = Math.abs(z1 - z0) || 1;
  const tx = sx * TICK_FRAC;
  const ty = sy * TICK_FRAC;
  const tz = sz * TICK_FRAC;

  if (axes.x.visible) {
    for (const xv of plan.xTicks) {
      pushLine(xv, y0, z0, xv, y0 - ty, z0);
      pushLine(xv, y0, z0, xv, y0, z0 - tz);
    }
  }
  if (axes.y.visible) {
    for (const yv of plan.yTicks) {
      pushLine(x0, yv, z0, x0 - tx, yv, z0);
      pushLine(x0, yv, z0, x0, yv, z0 - tz);
    }
  }
  if (axes.z.visible) {
    for (const zv of plan.zTicks) {
      pushLine(x0, y0, zv, x0 - tx, y0, zv);
      pushLine(x0, y0, zv, x0, y0 - ty, zv);
    }
  }

  return new Float32Array(parts);
}

export function planAxes3DTicks(aabb: AABB, axes: ResolvedAxes3D): Axes3DTickPlan {
  const xDomain = resolveAxisDomain3D(axes.x.min, axes.x.max, aabb.min[0], aabb.max[0]);
  const yDomain = resolveAxisDomain3D(axes.y.min, axes.y.max, aabb.min[1], aabb.max[1]);
  const zDomain = resolveAxisDomain3D(axes.z.min, axes.z.max, aabb.min[2], aabb.max[2]);
  return {
    xTicks: axes.x.visible ? generateNiceAxisTicks3D(xDomain.min, xDomain.max, axes.x.tickCount) : [],
    yTicks: axes.y.visible ? generateNiceAxisTicks3D(yDomain.min, yDomain.max, axes.y.tickCount) : [],
    zTicks: axes.z.visible ? generateNiceAxisTicks3D(zDomain.min, zDomain.max, axes.z.tickCount) : [],
    xDomain,
    yDomain,
    zDomain,
  };
}

export function createAxisBox3DRenderer(device: GPUDevice, options?: AxisBox3DRendererOptions): AxisBox3DRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? 'bgra8unorm';
  const sampleCount = options?.sampleCount === 4 ? 4 : 1;
  const pipelineCache = options?.pipelineCache;

  const vsUniformBuffer = createUniformBuffer(device, VS_UNIFORM_SIZE, { label: 'axisBox3d/vsUniforms' });
  const vsUniformF32 = new Float32Array(VS_UNIFORM_SIZE / 4);

  let vertexBuffer: GPUBuffer | null = null;
  let vertexCapacity = 0;
  let vertexCount = 0; // number of float3 vertices (line-list)
  let hasPrepared = false;

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'axisBox3d/bgl',
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'axisBox3d/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: axisBoxWgsl,
        label: 'axisBox3d/shader',
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: {
        code: axisBoxWgsl,
        formats: targetFormat,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      },
      primitive: { topology: 'line-list' },
      depthStencil,
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  let bindGroup: GPUBindGroup | null = null;

  const ensureCapacity = (floatCount: number): void => {
    const bytes = Math.max(4, Math.ceil((floatCount * 4) / 4) * 4);
    if (vertexBuffer && vertexCapacity >= bytes) return;
    vertexBuffer?.destroy();
    // Geometric growth
    let cap = Math.max(bytes, 1024);
    while (cap < bytes) cap = Math.ceil(cap * 1.5);
    vertexBuffer = device.createBuffer({
      label: 'axisBox3d/vbo',
      size: cap,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    vertexCapacity = cap;
  };

  return {
    prepare(aabb, viewProj, colorRgba, axes, gridColorRgba) {
      if (disposed) {
        return planAxes3DTicks(aabb, axes);
      }
      const plan = planAxes3DTicks(aabb, axes);
      const drawAxes = axes.showBox || axes.showGrid || axes.x.visible || axes.y.visible || axes.z.visible;
      if (!drawAxes) {
        hasPrepared = false;
        vertexCount = 0;
        return plan;
      }

      const vertices = buildAxes3DLines(aabb, axes, plan);
      vertexCount = Math.floor(vertices.length / 3);
      if (vertexCount === 0) {
        hasPrepared = false;
        return plan;
      }
      ensureCapacity(vertices.length);
      device.queue.writeBuffer(vertexBuffer!, 0, vertices.buffer, vertices.byteOffset, vertices.byteLength);

      // Single line-list draw: box, grids, and ticks share one color.
      // When both box and grid are on, blend edge + grid colors (two-pass later if needed).
      const c = gridColorRgba ?? colorRgba;
      const mix =
        axes.showGrid && axes.showBox
          ? ([
              (colorRgba[0] + c[0]) * 0.5,
              (colorRgba[1] + c[1]) * 0.5,
              (colorRgba[2] + c[2]) * 0.5,
              Math.min(1, (colorRgba[3] + c[3]) * 0.5 + 0.15),
            ] as const)
          : colorRgba;

      vsUniformF32.set(viewProj, 0);
      vsUniformF32[16] = mix[0];
      vsUniformF32[17] = mix[1];
      vsUniformF32[18] = mix[2];
      vsUniformF32[19] = mix[3];
      writeUniformBuffer(device, vsUniformBuffer, vsUniformF32);

      if (!bindGroup) {
        bindGroup = device.createBindGroup({
          layout: bindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
        });
      }
      hasPrepared = true;
      return plan;
    },
    render(pass) {
      if (disposed || !hasPrepared || !bindGroup || !vertexBuffer || vertexCount < 2) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.draw(vertexCount);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      vertexBuffer?.destroy();
      vsUniformBuffer.destroy();
      vertexBuffer = null;
      bindGroup = null;
    },
  };
}
