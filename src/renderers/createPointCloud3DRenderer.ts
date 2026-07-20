/**
 * 3D point cloud billboard renderer (WebGPU, depth-enabled).
 * Storage buffer of xyzv; draw(6, N) camera-facing quads.
 */

import pointCloudWgsl from '../shaders/pointCloud3d.wgsl?raw';
import type { ResolvedPointCloud3DSeriesConfig } from '../config/OptionResolver';
import { buildColormapLut, colormapKey } from '../utils/colormap';
import { parseCssColorToRgba01 } from '../utils/colors';
import type { PipelineCache } from '../core/PipelineCache';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { packPointCloud3D, type PackedPointCloud3D } from '../data/pointCloud3dData';
import type { Mat4 } from '../core/3d/mat4';

export interface PointCloud3DPrepareOptions {
  readonly viewProj: Mat4;
  /** CSS viewport width/height. */
  readonly viewportCssW: number;
  readonly viewportCssH: number;
  readonly opacityOverride?: number;
}

export interface PointCloud3DRenderer {
  prepare(seriesConfig: ResolvedPointCloud3DSeriesConfig, options: PointCloud3DPrepareOptions): void;
  /**
   * Replace packed data without full series resolve (append path).
   * Pass same series config for style; packed buffer is authoritative for geometry.
   */
  preparePacked(
    seriesConfig: ResolvedPointCloud3DSeriesConfig,
    packed: PackedPointCloud3D,
    options: PointCloud3DPrepareOptions
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
  getPointCount(): number;
  getUploadCount(): number;
  /** CPU-side packed xyzv for picking (may be a subarray). */
  getPackedForPick(): Float32Array | null;
}

export interface PointCloud3DRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
}

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const POINT_STRIDE_BYTES = 16;
// VSUniforms: viewProj(64) + viewport(16) + colorParams(16) + solidColor(16) = 112 → align 16
const VS_UNIFORM_SIZE = 112;

const premulBlend: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

// Depth write stays on for all opacities in v1 — semi-transparent billboards can
// occlude farther points (order-dependent). Prefer opacity near 1 for dense clouds.
const depthStencil: GPUDepthStencilState = {
  format: 'depth24plus',
  depthWriteEnabled: true,
  depthCompare: 'less',
};

export function createPointCloud3DRenderer(
  device: GPUDevice,
  options?: PointCloud3DRendererOptions
): PointCloud3DRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const sampleCount = options?.sampleCount === 4 ? 4 : 1;
  const pipelineCache = options?.pipelineCache;

  const vsUniformBuffer = createUniformBuffer(device, VS_UNIFORM_SIZE, { label: 'pointCloud3d/vsUniforms' });
  const vsUniformF32 = new Float32Array(VS_UNIFORM_SIZE / 4);

  let storageBuffer: GPUBuffer | null = null;
  let storageCapacityBytes = 0;
  let boundPointCount = 0;
  let packedCpu: Float32Array | null = null;
  let lastDataRef: unknown = null;
  let lastPackedIdentity: Float32Array | null = null;
  let uploadCount = 0;

  let lutTexture: GPUTexture | null = null;
  let lutView: GPUTextureView | null = null;
  let lastLutKey = '';

  const ensureLut = (key: string, colormap: import('../utils/colormap').ColormapSpec): GPUTextureView => {
    if (lutView && lastLutKey === key) return lutView;
    const lut = buildColormapLut(colormap);
    if (!lutTexture) {
      lutTexture = device.createTexture({
        label: 'pointCloud3d/colormapLut',
        size: { width: 256, height: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      lutView = lutTexture.createView();
    }
    device.queue.writeTexture({ texture: lutTexture }, lut, { bytesPerRow: 256 * 4 }, { width: 256, height: 1 });
    lastLutKey = key;
    return lutView!;
  };

  // Placeholder 1x1 white lut for solid color path so bind group is always valid
  const ensureSolidLut = (): GPUTextureView => ensureLut('__solid__', ['#ffffff', '#ffffff']);

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'pointCloud3d/bindGroupLayout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
    ],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'pointCloud3d/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: { code: pointCloudWgsl, label: 'pointCloud3d/shader' },
      fragment: {
        code: pointCloudWgsl,
        label: 'pointCloud3d/shader',
        formats: targetFormat,
        blend: premulBlend,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  let bindGroup: GPUBindGroup | null = null;
  let hasPrepared = false;

  const ensureStorage = (byteLength: number): GPUBuffer => {
    const need = Math.max(POINT_STRIDE_BYTES, byteLength);
    if (storageBuffer && storageCapacityBytes >= need) return storageBuffer;
    storageBuffer?.destroy();
    let cap = storageCapacityBytes > 0 ? storageCapacityBytes : POINT_STRIDE_BYTES * 64;
    while (cap < need) cap = Math.ceil(cap * 1.5);
    // Align capacity to 16
    cap = Math.ceil(cap / 16) * 16;
    storageBuffer = device.createBuffer({
      label: 'pointCloud3d/points',
      size: cap,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    storageCapacityBytes = cap;
    bindGroup = null;
    return storageBuffer;
  };

  const uploadPacked = (packed: Float32Array, count: number): void => {
    const bytes = count * POINT_STRIDE_BYTES;
    const buf = ensureStorage(Math.max(bytes, POINT_STRIDE_BYTES));
    if (count > 0) {
      // writeBuffer size must be multiple of 4 (always true for float32)
      device.queue.writeBuffer(buf, 0, packed.buffer, packed.byteOffset, bytes);
    }
    boundPointCount = count;
    packedCpu = count > 0 ? packed.subarray(0, count * 4) : null;
    uploadCount++;
    bindGroup = null;
  };

  const writeUniforms = (
    series: ResolvedPointCloud3DSeriesConfig,
    options: PointCloud3DPrepareOptions,
    packedMeta: { valueMin: number; valueMax: number; hasValue: boolean }
  ): void => {
    const vp = options.viewProj;
    vsUniformF32.set(vp, 0);
    vsUniformF32[16] = options.viewportCssW;
    vsUniformF32[17] = options.viewportCssH;
    vsUniformF32[18] = series.pointStyle.size;
    vsUniformF32[19] = 1;

    const useColormap = series.colorBy != null && (packedMeta.hasValue || series.colorBy.values != null);
    const vMin =
      series.colorBy?.min != null && Number.isFinite(series.colorBy.min) ? series.colorBy.min : packedMeta.valueMin;
    const vMax =
      series.colorBy?.max != null && Number.isFinite(series.colorBy.max) ? series.colorBy.max : packedMeta.valueMax;

    vsUniformF32[20] = vMin;
    vsUniformF32[21] = vMax > vMin ? vMax : vMin + 1;
    vsUniformF32[22] = useColormap ? 1 : 0;
    const opacity = clamp01((options.opacityOverride ?? 1) * series.pointStyle.opacity);
    vsUniformF32[23] = opacity;

    const rgba = parseCssColorToRgba01(series.pointStyle.color) ?? ([0.22, 0.74, 0.97, 1] as const);
    vsUniformF32[24] = rgba[0];
    vsUniformF32[25] = rgba[1];
    vsUniformF32[26] = rgba[2];
    vsUniformF32[27] = rgba[3];

    writeUniformBuffer(device, vsUniformBuffer, vsUniformF32);

    const lutViewLocal = useColormap
      ? ensureLut(colormapKey(series.colorBy!.colormap), series.colorBy!.colormap)
      : ensureSolidLut();

    if (!storageBuffer) ensureStorage(POINT_STRIDE_BYTES);
    bindGroup = device.createBindGroup({
      label: 'pointCloud3d/bindGroup',
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: vsUniformBuffer } },
        { binding: 1, resource: { buffer: storageBuffer! } },
        { binding: 2, resource: lutViewLocal },
      ],
    });
    hasPrepared = true;
  };

  const preparePacked = (
    seriesConfig: ResolvedPointCloud3DSeriesConfig,
    packed: PackedPointCloud3D,
    options: PointCloud3DPrepareOptions
  ): void => {
    if (disposed) return;
    if (lastPackedIdentity !== packed.packed || boundPointCount !== packed.count) {
      uploadPacked(packed.packed, packed.count);
      lastPackedIdentity = packed.packed;
      lastDataRef = null;
    }
    writeUniforms(seriesConfig, options, packed);
  };

  const prepare = (seriesConfig: ResolvedPointCloud3DSeriesConfig, options: PointCloud3DPrepareOptions): void => {
    if (disposed) return;
    const dataRef = seriesConfig.data;
    if (dataRef !== lastDataRef) {
      const valueOverride = seriesConfig.colorBy?.values;
      const packed = packPointCloud3D(dataRef, { valueOverride });
      uploadPacked(packed.packed, packed.count);
      lastDataRef = dataRef;
      lastPackedIdentity = packed.packed;
      writeUniforms(seriesConfig, options, packed);
    } else {
      writeUniforms(seriesConfig, options, {
        valueMin: seriesConfig.colorBy?.min ?? 0,
        valueMax: seriesConfig.colorBy?.max ?? 1,
        hasValue: seriesConfig.colorBy != null,
      });
    }
  };

  return {
    prepare,
    preparePacked,
    render(passEncoder) {
      if (disposed || !hasPrepared || !bindGroup || boundPointCount <= 0) return;
      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.draw(6, boundPointCount, 0, 0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      storageBuffer?.destroy();
      storageBuffer = null;
      vsUniformBuffer.destroy();
      lutTexture?.destroy();
      lutTexture = null;
      lutView = null;
      bindGroup = null;
      packedCpu = null;
    },
    getPointCount: () => boundPointCount,
    getUploadCount: () => uploadCount,
    getPackedForPick: () => packedCpu,
  };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
