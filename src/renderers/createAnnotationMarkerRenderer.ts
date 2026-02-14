import annotationMarkerWgsl from '../shaders/annotationMarker.wgsl?raw';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { PipelineCache } from '../core/PipelineCache';

export type AnnotationMarkerInstance = Readonly<{
  /**
   * Center in CANVAS-LOCAL CSS pixels.
   * (0,0) is the canvas top-left in CSS pixel coordinates.
   */
  xCssPx: number;
  yCssPx: number;

  /** Marker diameter in CSS pixels. */
  sizeCssPx: number;

  /** Fill color RGBA in 0..1 (straight alpha). */
  fillRgba: readonly [r: number, g: number, b: number, a: number];

  /** Optional stroke width in CSS pixels (0 disables stroke). */
  strokeWidthCssPx?: number;

  /** Optional stroke color RGBA in 0..1 (straight alpha). */
  strokeRgba?: readonly [r: number, g: number, b: number, a: number];
}>;

export interface AnnotationMarkerRenderer {
  /**
   * Uploads marker instances and prepares uniforms for rendering.
   *
   * Coordinate contract:
   * - `instances[*].xCssPx/yCssPx` are CANVAS-LOCAL CSS pixels.
   * - `canvasWidth/canvasHeight` are in *device pixels* (same as render target size).
   * - `devicePixelRatio` is used to convert CSS px to device px inside the shader.
   *
   * Scissor contract:
   * - This renderer intentionally does NOT set or reset scissor state.
   *   The caller must set scissor for plot clipping before invoking `render()`.
   */
  prepare(params: Readonly<{
    canvasWidth: number;
    canvasHeight: number;
    devicePixelRatio: number;
    instances: readonly AnnotationMarkerInstance[];
  }>): void;

  /** Draws all prepared instances (if any). */
  render(passEncoder: GPURenderPassEncoder, firstInstance?: number, instanceCount?: number): void;

  /** Cleans up GPU resources (best-effort). */
  dispose(): void;
}

export interface AnnotationMarkerRendererOptions {
  /**
   * Must match the canvas context format used for the render pass color attachment.
   * Usually this is `gpuContext.preferredFormat`.
   *
   * Defaults to `'bgra8unorm'` for backward compatibility.
   */
  readonly targetFormat?: GPUTextureFormat;

  /**
   * Multisample count for the render pipeline.
   *
   * Must match the render pass color attachment sampleCount.
   * Defaults to 1 (no MSAA).
   */
  readonly sampleCount?: number;
  /**
   * Optional shared cache for shader modules + render pipelines.
   */
  readonly pipelineCache?: PipelineCache;
}

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

// Instance layout (WGSL VSIn):
// centerCssPx.xy, sizeCssPx, strokeWidthCssPx, fillRgba.rgba, strokeRgba.rgba
const INSTANCE_STRIDE_FLOATS = 12;
const INSTANCE_STRIDE_BYTES = INSTANCE_STRIDE_FLOATS * 4;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

export function createAnnotationMarkerRenderer(device: GPUDevice, options?: AnnotationMarkerRendererOptions): AnnotationMarkerRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw) ? Math.max(1, Math.floor(sampleCountRaw)) : 1;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  });

  // VSUniforms (WGSL):
  // viewportPx vec2 + dpr f32 + pad f32 = 16 bytes
  const vsUniformBuffer = createUniformBuffer(device, 16, { label: 'annotationMarkerRenderer/vsUniforms' });
  const vsUniformScratchF32 = new Float32Array(4);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'annotationMarkerRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: annotationMarkerWgsl,
        label: 'annotationMarker.wgsl',
        buffers: [
          {
            arrayStride: INSTANCE_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, format: 'float32x2', offset: 0 }, // centerCssPx
              { shaderLocation: 1, format: 'float32', offset: 8 }, // sizeCssPx
              { shaderLocation: 2, format: 'float32', offset: 12 }, // strokeWidthCssPx
              { shaderLocation: 3, format: 'float32x4', offset: 16 }, // fillRgba
              { shaderLocation: 4, format: 'float32x4', offset: 32 }, // strokeRgba
            ],
          },
        ],
      },
      fragment: {
        code: annotationMarkerWgsl,
        label: 'annotationMarker.wgsl',
        formats: targetFormat,
        blend: {
          color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
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

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('AnnotationMarkerRenderer is disposed.');
  };

  const ensureCpuInstanceCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuInstanceStagingF32.length) return;
    const nextFloats = Math.max(32, nextPow2(requiredFloats));
    cpuInstanceStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  };

  const writeVsUniforms = (canvasWidthDevicePx: number, canvasHeightDevicePx: number, devicePixelRatio: number): void => {
    const w = Number.isFinite(canvasWidthDevicePx) && canvasWidthDevicePx > 0 ? canvasWidthDevicePx : 1;
    const h = Number.isFinite(canvasHeightDevicePx) && canvasHeightDevicePx > 0 ? canvasHeightDevicePx : 1;
    const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;

    vsUniformScratchF32[0] = w;
    vsUniformScratchF32[1] = h;
    vsUniformScratchF32[2] = dpr;
    vsUniformScratchF32[3] = 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchF32);
  };

  const prepare: AnnotationMarkerRenderer['prepare'] = ({ canvasWidth, canvasHeight, devicePixelRatio, instances }) => {
    assertNotDisposed();

    if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) {
      throw new Error('AnnotationMarkerRenderer.prepare: canvasWidth/canvasHeight must be positive finite numbers.');
    }
    if (!Array.isArray(instances)) {
      throw new Error('AnnotationMarkerRenderer.prepare: instances must be an array.');
    }

    writeVsUniforms(canvasWidth, canvasHeight, devicePixelRatio);

    ensureCpuInstanceCapacityFloats(instances.length * INSTANCE_STRIDE_FLOATS);
    const f32 = cpuInstanceStagingF32;
    let outFloats = 0;

    for (let i = 0; i < instances.length; i++) {
      const m = instances[i];
      if (!Number.isFinite(m.xCssPx) || !Number.isFinite(m.yCssPx)) continue;
      if (!Number.isFinite(m.sizeCssPx) || m.sizeCssPx <= 0) continue;

      const strokeWidthCss = m.strokeWidthCssPx ?? 0;
      const strokeRgba = m.strokeRgba ?? ([0, 0, 0, 0] as const);

      // Clamp colors to [0,1] for deterministic output.
      const fr = clamp01(m.fillRgba[0]);
      const fg = clamp01(m.fillRgba[1]);
      const fb = clamp01(m.fillRgba[2]);
      const fa = clamp01(m.fillRgba[3]);

      const sr = clamp01(strokeRgba[0]);
      const sg = clamp01(strokeRgba[1]);
      const sb = clamp01(strokeRgba[2]);
      const sa = clamp01(strokeRgba[3]);

      f32[outFloats + 0] = m.xCssPx;
      f32[outFloats + 1] = m.yCssPx;
      f32[outFloats + 2] = m.sizeCssPx;
      f32[outFloats + 3] = Number.isFinite(strokeWidthCss) ? Math.max(0, strokeWidthCss) : 0;

      f32[outFloats + 4] = fr;
      f32[outFloats + 5] = fg;
      f32[outFloats + 6] = fb;
      f32[outFloats + 7] = fa;

      f32[outFloats + 8] = sr;
      f32[outFloats + 9] = sg;
      f32[outFloats + 10] = sb;
      f32[outFloats + 11] = sa;

      outFloats += INSTANCE_STRIDE_FLOATS;
    }

    instanceCount = outFloats / INSTANCE_STRIDE_FLOATS;

    // PERFORMANCE: Early exit if no valid instances (skip buffer allocation/write)
    if (instanceCount === 0) {
      return;
    }

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
        label: 'annotationMarkerRenderer/instanceBuffer',
        size: grownBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    // PERFORMANCE: Only write buffer when we have instances (instanceCount > 0 already checked above)
    device.queue.writeBuffer(instanceBuffer, 0, cpuInstanceStagingBuffer, 0, instanceCount * INSTANCE_STRIDE_BYTES);
  };

  const render: AnnotationMarkerRenderer['render'] = (passEncoder, firstInstance = 0, requestedCount) => {
    assertNotDisposed();
    if (!instanceBuffer || instanceCount === 0) return;

    const first = Number.isFinite(firstInstance) ? Math.max(0, Math.floor(firstInstance)) : 0;
    const available = Math.max(0, instanceCount - first);
    const count =
      requestedCount == null
        ? available
        : Number.isFinite(requestedCount)
          ? Math.max(0, Math.min(available, Math.floor(requestedCount)))
          : available;
    if (count === 0) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, instanceBuffer);
    passEncoder.draw(6, count, 0, first);
  };

  const dispose: AnnotationMarkerRenderer['dispose'] = () => {
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
  };

  return { prepare, render, dispose };
}

