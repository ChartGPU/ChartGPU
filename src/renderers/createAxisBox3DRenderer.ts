/**
 * Minimal AABB axis box (12 edges) for 3D charts.
 */

import axisBoxWgsl from '../shaders/axisBox3d.wgsl?raw';
import type { AABB } from '../core/3d/aabb';
import type { Mat4 } from '../core/3d/mat4';
import type { PipelineCache } from '../core/PipelineCache';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';

export interface AxisBox3DRenderer {
  prepare(aabb: AABB, viewProj: Mat4, colorRgba: readonly [number, number, number, number]): void;
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

/** 8 corners of AABB as float3, then 12 edges × 2 indices. */
function buildBoxLines(aabb: AABB): { vertices: Float32Array; indices: Uint16Array } {
  const [x0, y0, z0] = aabb.min;
  const [x1, y1, z1] = aabb.max;
  const corners = [
    x0,
    y0,
    z0, // 0
    x1,
    y0,
    z0, // 1
    x1,
    y1,
    z0, // 2
    x0,
    y1,
    z0, // 3
    x0,
    y0,
    z1, // 4
    x1,
    y0,
    z1, // 5
    x1,
    y1,
    z1, // 6
    x0,
    y1,
    z1, // 7
  ];
  const edges = [
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    0, // bottom/top z0
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    4, // z1
    0,
    4,
    1,
    5,
    2,
    6,
    3,
    7, // pillars
  ];
  return {
    vertices: new Float32Array(corners),
    indices: new Uint16Array(edges),
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
  let indexBuffer: GPUBuffer | null = null;
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

  return {
    prepare(aabb, viewProj, colorRgba) {
      if (disposed) return;
      const { vertices, indices } = buildBoxLines(aabb);
      if (!vertexBuffer) {
        vertexBuffer = device.createBuffer({
          label: 'axisBox3d/vbo',
          size: 8 * 12,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }
      if (!indexBuffer) {
        indexBuffer = device.createBuffer({
          label: 'axisBox3d/ibo',
          size: 24 * 2,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
      }
      device.queue.writeBuffer(vertexBuffer, 0, vertices.buffer, vertices.byteOffset, vertices.byteLength);
      device.queue.writeBuffer(indexBuffer, 0, indices.buffer, indices.byteOffset, indices.byteLength);

      vsUniformF32.set(viewProj, 0);
      vsUniformF32[16] = colorRgba[0];
      vsUniformF32[17] = colorRgba[1];
      vsUniformF32[18] = colorRgba[2];
      vsUniformF32[19] = colorRgba[3];
      writeUniformBuffer(device, vsUniformBuffer, vsUniformF32);

      // Bind group is stable (only buffer identity); create once.
      if (!bindGroup) {
        bindGroup = device.createBindGroup({
          layout: bindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
        });
      }
      hasPrepared = true;
    },
    render(pass) {
      if (disposed || !hasPrepared || !bindGroup || !vertexBuffer || !indexBuffer) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.setIndexBuffer(indexBuffer, 'uint16');
      pass.drawIndexed(24);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      vertexBuffer?.destroy();
      indexBuffer?.destroy();
      vsUniformBuffer.destroy();
      vertexBuffer = null;
      indexBuffer = null;
      bindGroup = null;
    },
  };
}
