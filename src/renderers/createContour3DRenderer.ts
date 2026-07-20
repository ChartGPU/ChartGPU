/**
 * Depth-tested line-list renderer for surface3d isolines (marching-squares output).
 */

import axisBoxWgsl from '../shaders/axisBox3d.wgsl?raw';
import type { Mat4 } from '../core/3d/mat4';
import type { PipelineCache } from '../core/PipelineCache';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { generateSurface3DContours, resolveContourLevels, contourVertexCount } from '../data/surface3dContours';
import type { ResolvedSurface3DSeriesConfig } from '../config/OptionResolver';
import { parseCssColorToRgba01 } from '../utils/colors';

export interface Contour3DRenderer {
  prepare(seriesConfig: ResolvedSurface3DSeriesConfig, viewProj: Mat4): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
  /** Invalidate cached contour geometry (call after surface stream / data change). */
  invalidate(): void;
}

export interface Contour3DRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
}

const VS_UNIFORM_SIZE = 80;

const depthStencil: GPUDepthStencilState = {
  format: 'depth24plus',
  depthWriteEnabled: true,
  depthCompare: 'less-equal',
};

export function createContour3DRenderer(device: GPUDevice, options?: Contour3DRendererOptions): Contour3DRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? 'bgra8unorm';
  const sampleCount = options?.sampleCount === 4 ? 4 : 1;
  const pipelineCache = options?.pipelineCache;

  const vsUniformBuffer = createUniformBuffer(device, VS_UNIFORM_SIZE, { label: 'contour3d/vsUniforms' });
  const vsUniformF32 = new Float32Array(VS_UNIFORM_SIZE / 4);

  let vertexBuffer: GPUBuffer | null = null;
  let vertexCapacity = 0;
  let vertexCount = 0;
  let hasPrepared = false;

  let lastDataRef: unknown = null;
  let lastYRef: unknown = null;
  let lastLevelsKey = '';
  let lastYMin = NaN;
  let lastYMax = NaN;
  let lastShow = false;

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'contour3d/bgl',
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'contour3d/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: axisBoxWgsl,
        label: 'contour3d/shader',
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

  const levelsKey = (levels: number | readonly number[]): string =>
    Array.isArray(levels) ? levels.join(',') : String(levels);

  return {
    prepare(seriesConfig, viewProj) {
      if (disposed) return;
      const cont = seriesConfig.contours;
      if (!seriesConfig.drawable || !cont.show) {
        hasPrepared = false;
        vertexCount = 0;
        lastShow = false;
        return;
      }

      const dataRef = seriesConfig.data;
      const yRef = dataRef?.y;
      const lk = levelsKey(cont.levels);
      const needGeom =
        !lastShow ||
        dataRef !== lastDataRef ||
        yRef !== lastYRef ||
        lk !== lastLevelsKey ||
        seriesConfig.yMin !== lastYMin ||
        seriesConfig.yMax !== lastYMax;

      if (needGeom) {
        const resolved = resolveContourLevels(cont.levels, seriesConfig.yMin, seriesConfig.yMax);
        const positions = generateSurface3DContours(
          {
            xStart: dataRef.xStart,
            xStep: dataRef.xStep,
            zStart: dataRef.zStart,
            zStep: dataRef.zStep,
            columns: dataRef.columns,
            rows: dataRef.rows,
            y: dataRef.y,
          },
          resolved
        );
        vertexCount = contourVertexCount(positions);
        if (vertexCount >= 2) {
          const bytes = positions.byteLength;
          if (!vertexBuffer || vertexCapacity < bytes) {
            vertexBuffer?.destroy();
            const cap = Math.max(bytes, 1024);
            vertexBuffer = device.createBuffer({
              label: 'contour3d/vbo',
              size: cap,
              usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            vertexCapacity = cap;
          }
          device.queue.writeBuffer(vertexBuffer, 0, positions.buffer, positions.byteOffset, bytes);
        }
        lastDataRef = dataRef;
        lastYRef = yRef;
        lastLevelsKey = lk;
        lastYMin = seriesConfig.yMin;
        lastYMax = seriesConfig.yMax;
        lastShow = true;
      }

      if (vertexCount < 2 || !vertexBuffer) {
        hasPrepared = false;
        return;
      }

      const rgba = parseCssColorToRgba01(cont.color) ?? ([0.89, 0.91, 0.94, cont.opacity] as const);
      const a = Math.min(1, Math.max(0, cont.opacity)) * (rgba[3] ?? 1);
      // `width` is visual weight (alpha boost), not CSS px or multi-pass thickness —
      // isolines are a single world-space hairline (spike: world hairline + relative weight).
      const a2 = Math.min(1, a * (0.75 + 0.15 * Math.min(4, cont.width)));

      vsUniformF32.set(viewProj, 0);
      vsUniformF32[16] = rgba[0];
      vsUniformF32[17] = rgba[1];
      vsUniformF32[18] = rgba[2];
      vsUniformF32[19] = a2;
      writeUniformBuffer(device, vsUniformBuffer, vsUniformF32);

      if (!bindGroup) {
        bindGroup = device.createBindGroup({
          layout: bindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
        });
      }
      hasPrepared = true;
    },
    render(pass) {
      if (disposed || !hasPrepared || !bindGroup || !vertexBuffer || vertexCount < 2) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.draw(vertexCount);
    },
    invalidate() {
      lastDataRef = null;
      lastYRef = null;
      lastLevelsKey = '';
      lastShow = false;
      hasPrepared = false;
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
