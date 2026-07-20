/**
 * Uniform grid surface mesh renderer (Y-up, XZ grid) with height colormap + simple lighting.
 */

import surfaceWgsl from '../shaders/surface3d.wgsl?raw';
import type { ResolvedSurface3DSeriesConfig } from '../config/OptionResolver';
import { buildColormapLut, colormapKey } from '../utils/colormap';
import type { PipelineCache } from '../core/PipelineCache';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { packSurface3D, packSurface3DWireframeIndices, type PackedSurface3D } from '../data/surface3dData';
import type { Mat4 } from '../core/3d/mat4';

export interface Surface3DPrepareOptions {
  readonly viewProj: Mat4;
}

export interface Surface3DRenderer {
  prepare(seriesConfig: ResolvedSurface3DSeriesConfig, options: Surface3DPrepareOptions): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
  getUploadCount(): number;
  hasGeometry(): boolean;
}

export interface Surface3DRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
}

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const VERTEX_STRIDE = 32; // 8 floats
// viewProj(64) + light(16) + colorParams(16) + ambient(16) = 112
const VS_UNIFORM_SIZE = 112;

const premulBlend: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const depthStencilWrite: GPUDepthStencilState = {
  format: 'depth24plus',
  depthWriteEnabled: true,
  depthCompare: 'less',
};

export function createSurface3DRenderer(device: GPUDevice, options?: Surface3DRendererOptions): Surface3DRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const sampleCount = options?.sampleCount === 4 ? 4 : 1;
  const pipelineCache = options?.pipelineCache;

  const vsUniformBuffer = createUniformBuffer(device, VS_UNIFORM_SIZE, { label: 'surface3d/vsUniforms' });
  const vsUniformF32 = new Float32Array(VS_UNIFORM_SIZE / 4);

  let vertexBuffer: GPUBuffer | null = null;
  let indexBuffer: GPUBuffer | null = null;
  let wireIndexBuffer: GPUBuffer | null = null;
  let indexCount = 0;
  let wireIndexCount = 0;
  let lastDataRef: unknown = null;
  /** Track data.y identity so y replace under a new array ref invalidates geometry. */
  let lastYRef: unknown = null;
  let lastWire = false;
  let lastColumns = -1;
  let lastRows = -1;
  let uploadCount = 0;
  let hasGeom = false;
  /** Reused CPU pack target — avoids allocating columns×rows×8 floats every strip tick. */
  let packVertexScratch: Float32Array | null = null;

  let lutTexture: GPUTexture | null = null;
  let lutView: GPUTextureView | null = null;
  let lastLutKey = '';

  const ensureLut = (key: string, colormap: import('../utils/colormap').ColormapSpec): GPUTextureView => {
    if (lutView && lastLutKey === key) return lutView;
    const lut = buildColormapLut(colormap);
    if (!lutTexture) {
      lutTexture = device.createTexture({
        label: 'surface3d/colormapLut',
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

  const vertexBuffers: GPUVertexBufferLayout[] = [
    {
      arrayStride: VERTEX_STRIDE,
      stepMode: 'vertex',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
        { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
        { shaderLocation: 2, offset: 24, format: 'float32' }, // height
      ],
    },
  ];

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'surface3d/bindGroupLayout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
    ],
  });

  const solidPipeline = createRenderPipeline(
    device,
    {
      label: 'surface3d/solid',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: surfaceWgsl,
        label: 'surface3d/shader',
        entryPoint: 'vsMain',
        buffers: vertexBuffers,
      },
      fragment: {
        code: surfaceWgsl,
        label: 'surface3d/shader',
        entryPoint: 'fsMain',
        formats: targetFormat,
        blend: premulBlend,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: depthStencilWrite,
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  const wirePipeline = createRenderPipeline(
    device,
    {
      label: 'surface3d/wire',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: surfaceWgsl,
        label: 'surface3d/shader',
        entryPoint: 'vsMainWire',
        buffers: vertexBuffers,
      },
      fragment: {
        code: surfaceWgsl,
        label: 'surface3d/shader',
        entryPoint: 'fsMainWire',
        formats: targetFormat,
        blend: premulBlend,
      },
      primitive: { topology: 'line-list', cullMode: 'none' },
      depthStencil: depthStencilWrite,
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  let bindGroup: GPUBindGroup | null = null;
  let lastBindLutKey = '';
  let hasPrepared = false;
  let drawWire = false;
  let packedMeta: PackedSurface3D | null = null;

  const uploadGeometry = (packed: PackedSurface3D, wireframe: boolean): void => {
    const dimsStable =
      packed.columns === lastColumns && packed.rows === lastRows && vertexBuffer != null && indexBuffer != null;

    // Vertices always re-upload when heights change.
    const vBytes = packed.vertices.byteLength;
    const vSize = Math.ceil(vBytes / 4) * 4;
    if (!dimsStable || !vertexBuffer || vertexBuffer.size < vSize) {
      vertexBuffer?.destroy();
      vertexBuffer = device.createBuffer({
        label: 'surface3d/vertices',
        size: Math.max(vSize, 4),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(vertexBuffer, 0, packed.vertices.buffer, packed.vertices.byteOffset, vBytes);

    // Index topology is stable when columns×rows unchanged — retain index buffers (D6).
    // skipIndices packs report indexCount 0; keep previous indexCount when dimsStable.
    if (!dimsStable && packed.indexCount > 0) {
      indexBuffer?.destroy();
      wireIndexBuffer?.destroy();
      const iBytes = packed.indices.byteLength;
      const iSize = Math.ceil(iBytes / 4) * 4;
      indexBuffer = device.createBuffer({
        label: 'surface3d/indices',
        size: Math.max(iSize, 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(indexBuffer, 0, packed.indices.buffer, packed.indices.byteOffset, iBytes);
      indexCount = packed.indexCount;

      if (wireframe) {
        const wIdx = packSurface3DWireframeIndices(packed.columns, packed.rows);
        const wBytes = wIdx.byteLength;
        const wSize = Math.ceil(wBytes / 4) * 4;
        wireIndexBuffer = device.createBuffer({
          label: 'surface3d/wireIndices',
          size: Math.max(wSize, 4),
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(wireIndexBuffer, 0, wIdx.buffer, wIdx.byteOffset, wBytes);
        wireIndexCount = wIdx.length;
      } else {
        wireIndexBuffer = null;
        wireIndexCount = 0;
      }
      lastColumns = packed.columns;
      lastRows = packed.rows;
    } else if (wireframe && !wireIndexBuffer) {
      // Wire mode toggled on with stable dims
      const wIdx = packSurface3DWireframeIndices(packed.columns, packed.rows);
      const wBytes = wIdx.byteLength;
      const wSize = Math.ceil(wBytes / 4) * 4;
      wireIndexBuffer = device.createBuffer({
        label: 'surface3d/wireIndices',
        size: Math.max(wSize, 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(wireIndexBuffer, 0, wIdx.buffer, wIdx.byteOffset, wBytes);
      wireIndexCount = wIdx.length;
    } else if (!wireframe) {
      wireIndexBuffer?.destroy();
      wireIndexBuffer = null;
      wireIndexCount = 0;
    }

    uploadCount++;
    // skipIndices packs leave indexCount 0 while GPU retains prior index buffer.
    hasGeom = packed.vertexCount > 0 && (packed.indexCount > 0 || indexCount > 0);
    packedMeta = packed;
  };

  const prepare = (seriesConfig: ResolvedSurface3DSeriesConfig, options: Surface3DPrepareOptions): void => {
    if (disposed) return;
    if (!seriesConfig.drawable) {
      // Do not clear hasGeom / GPU buffers — style-only frames may flip drawable
      // transiently; sticky hasGeom=false permanently hides the mesh after recovery.
      hasPrepared = false;
      return;
    }

    const dataRef = seriesConfig.data;
    const yRef = dataRef?.y;
    const wire = seriesConfig.wireframe;
    // Geometry upload when data / y channel / wire mode changes.
    // Colormap domain (yMin/yMax) is uniform-only — does not rebuild mesh.
    // In-place mutation of y values under a stable array reference is not detected
    // (same contract as heatmap z) — replace `data` or `data.y` reference via setOption.
    if (dataRef !== lastDataRef || yRef !== lastYRef || wire !== lastWire) {
      // Streaming strip keeps columns×rows fixed — skip index rebuild (retained on GPU).
      const dimsKnown = lastColumns === dataRef.columns && lastRows === dataRef.rows && indexBuffer != null;
      const floats = Math.max(0, (dataRef?.columns ?? 0) * (dataRef?.rows ?? 0) * 8);
      if (!packVertexScratch || packVertexScratch.length < floats) {
        packVertexScratch = new Float32Array(Math.max(floats, 64));
      }
      const packed = packSurface3D(dataRef, {
        yMin: seriesConfig.yMin,
        yMax: seriesConfig.yMax,
        skipIndices: dimsKnown,
        // Coordinator owns scene AABB; skip duplicate bounds walk in pack.
        skipAabb: true,
        targetVertices: packVertexScratch,
      });
      if (!packed) {
        hasGeom = false;
        hasPrepared = false;
        // Do not latch lastDataRef on failed pack — allow retry when data becomes valid.
        return;
      }
      uploadGeometry(packed, wire);
      lastDataRef = dataRef;
      lastYRef = yRef;
      lastWire = wire;
    } else if (!hasGeom && vertexBuffer != null && indexBuffer != null && indexCount > 0) {
      // Recover from a prior failed/skip frame without re-packing the same refs.
      hasGeom = true;
    }

    const meta = packedMeta;
    if (!meta) {
      hasPrepared = false;
      return;
    }

    const lutKey = colormapKey(seriesConfig.colormap);
    const lut = ensureLut(lutKey, seriesConfig.colormap);
    vsUniformF32.set(options.viewProj, 0);
    // Light from upper-left-front
    vsUniformF32[16] = 0.4;
    vsUniformF32[17] = 0.85;
    vsUniformF32[18] = 0.35;
    vsUniformF32[19] = seriesConfig.lighting;
    vsUniformF32[20] = seriesConfig.yMin;
    vsUniformF32[21] = seriesConfig.yMax > seriesConfig.yMin ? seriesConfig.yMax : seriesConfig.yMin + 1;
    vsUniformF32[22] = seriesConfig.opacity;
    vsUniformF32[23] = 0;
    vsUniformF32[24] = 0.35;
    vsUniformF32[25] = 0.35;
    vsUniformF32[26] = 0.4;
    vsUniformF32[27] = 1;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformF32);

    // Rebuild bind group only when LUT texture view identity changes.
    if (!bindGroup || lastBindLutKey !== lutKey) {
      bindGroup = device.createBindGroup({
        label: 'surface3d/bindGroup',
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: vsUniformBuffer } },
          { binding: 1, resource: lut },
        ],
      });
      lastBindLutKey = lutKey;
    }
    drawWire = wire;
    hasPrepared = true;
  };

  return {
    prepare,
    render(passEncoder) {
      if (disposed || !hasPrepared || !hasGeom || !bindGroup || !vertexBuffer || !indexBuffer) return;
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      if (drawWire && wireIndexBuffer && wireIndexCount > 0) {
        // Solid first then wire for dual-mode when wireframe flag is pure wire — goal allows solid+wire.
        // When wireframe:true we draw line-list only; when false solid only.
        // Dual: if wireframe, still draw solid faintly then wire — keep simple: wire replaces solid.
        passEncoder.setPipeline(wirePipeline);
        passEncoder.setIndexBuffer(wireIndexBuffer, 'uint32');
        passEncoder.drawIndexed(wireIndexCount);
      } else {
        passEncoder.setPipeline(solidPipeline);
        passEncoder.setIndexBuffer(indexBuffer, 'uint32');
        passEncoder.drawIndexed(indexCount);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      vertexBuffer?.destroy();
      indexBuffer?.destroy();
      wireIndexBuffer?.destroy();
      vsUniformBuffer.destroy();
      lutTexture?.destroy();
      vertexBuffer = null;
      indexBuffer = null;
      wireIndexBuffer = null;
      lutTexture = null;
      lutView = null;
      bindGroup = null;
    },
    getUploadCount: () => uploadCount,
    hasGeometry: () => hasGeom,
  };
}
