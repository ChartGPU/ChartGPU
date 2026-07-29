/**
 * Uniform grid surface mesh renderer (Y-up, XZ grid) with height colormap + simple lighting.
 *
 * Steady-state path: upload height-only storage (4 B/cell); VS reconstructs position + normals.
 * Index + wire-index buffers retained when columns×rows are stable.
 */

import surfaceWgsl from '../shaders/surface3d.wgsl?raw';
import type { ResolvedSurface3DSeriesConfig } from '../config/OptionResolver';
import { buildColormapLut, colormapKey } from '../utils/colormap';
import type { PipelineCache } from '../core/PipelineCache';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { packSurface3DWireframeIndices, sanitizeSurface3DGrid } from '../data/surface3dData';
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
// viewProj(64) + light(16) + colorParams(16) + ambient(16) + grid(16) + gridDims(16) = 144
const VS_UNIFORM_SIZE = 144;

const premulBlend: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const depthStencilWrite: GPUDepthStencilState = {
  format: 'depth24plus',
  depthWriteEnabled: true,
  depthCompare: 'less',
};

/** Build solid triangle indices (two tris per cell). */
function packSolidIndices(columns: number, rows: number): Uint32Array {
  const cellCount = (columns - 1) * (rows - 1);
  const indices = new Uint32Array(cellCount * 6);
  let ii = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < columns - 1; i++) {
      const a = j * columns + i;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }
  return indices;
}

/**
 * Copy ArrayLike heights into a tightly packed Float32Array for queue.writeBuffer.
 * Non-finite → NaN (shader maps to 0); missing → NaN.
 */
function copyHeightsToF32(src: ArrayLike<number>, n: number, target: Float32Array): Float32Array {
  const out = target.length >= n ? (target.length === n ? target : target.subarray(0, n)) : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i < src.length) {
      const v = Number(src[i]);
      out[i] = Number.isFinite(v) ? v : Number.NaN;
    } else {
      out[i] = Number.NaN;
    }
  }
  return out;
}

export function createSurface3DRenderer(device: GPUDevice, options?: Surface3DRendererOptions): Surface3DRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const sampleCount = options?.sampleCount === 4 ? 4 : 1;
  const pipelineCache = options?.pipelineCache;

  const vsUniformBuffer = createUniformBuffer(device, VS_UNIFORM_SIZE, { label: 'surface3d/vsUniforms' });
  const vsUniformF32 = new Float32Array(VS_UNIFORM_SIZE / 4);

  let heightBuffer: GPUBuffer | null = null;
  let heightCapacityBytes = 0;
  let indexBuffer: GPUBuffer | null = null;
  let wireIndexBuffer: GPUBuffer | null = null;
  let indexCount = 0;
  let wireIndexCount = 0;
  let lastDataRef: unknown = null;
  /** Track data.y identity so y replace under a new array ref invalidates heights. */
  let lastYRef: unknown = null;
  let lastWire = false;
  let lastColumns = -1;
  let lastRows = -1;
  let lastXStart = NaN;
  let lastXStep = NaN;
  let lastZStart = NaN;
  let lastZStep = NaN;
  let uploadCount = 0;
  let hasGeom = false;
  /** Soft-fail when N²×4 exceeds device storage bind limit. */
  let heightLimitWarned = false;
  /** CPU scratch when heights are not a ready Float32Array of length n. */
  let heightCpuScratch: Float32Array | null = null;

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

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'surface3d/bindGroupLayout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      },
    ],
  });

  // No vertex buffers — geometry from @builtin(vertex_index) + heights storage.
  const solidPipeline = createRenderPipeline(
    device,
    {
      label: 'surface3d/solid',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: surfaceWgsl,
        label: 'surface3d/shader',
        entryPoint: 'vsMain',
        buffers: [],
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
        buffers: [],
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
  let lastBindHeightBuffer: GPUBuffer | null = null;
  let hasPrepared = false;
  let drawWire = false;
  let geomColumns = 0;
  let geomRows = 0;

  const maxHeightBytes = (): number => {
    const maxBind = device.limits?.maxStorageBufferBindingSize ?? Number.POSITIVE_INFINITY;
    const maxBuf = device.limits?.maxBufferSize ?? Number.POSITIVE_INFINITY;
    return Math.min(maxBind, maxBuf);
  };

  const ensureHeightBuffer = (bytes: number): GPUBuffer | null => {
    const size = Math.max(Math.ceil(bytes / 4) * 4, 4);
    const hardCap = maxHeightBytes();
    if (size > hardCap) {
      if (!heightLimitWarned) {
        heightLimitWarned = true;
        console.warn(
          `ChartGPU surface3d: height field (${size} bytes) exceeds device storage limit ` +
            `(min(maxStorageBufferBindingSize, maxBufferSize)=${hardCap}). Skipping mesh draw.`
        );
      }
      return null;
    }
    if (!heightBuffer || heightCapacityBytes < size) {
      heightBuffer?.destroy();
      // Geometric growth to absorb modest dim growth without thrash; never exceed hardCap.
      const grown = heightBuffer ? Math.max(size, heightCapacityBytes * 2) : size;
      const alloc = Math.min(grown, hardCap);
      if (alloc < size) {
        return null;
      }
      heightBuffer = device.createBuffer({
        label: 'surface3d/heights',
        size: alloc,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      heightCapacityBytes = alloc;
      bindGroup = null;
      lastBindHeightBuffer = null;
    }
    return heightBuffer;
  };

  /** @returns false when field exceeds device storage limit (skip draw). */
  const uploadHeights = (y: ArrayLike<number>, n: number): boolean => {
    const bytes = n * 4;
    const buf = ensureHeightBuffer(bytes);
    if (!buf) return false;
    if (y instanceof Float32Array && y.length >= n) {
      const view = y.length === n ? y : y.subarray(0, n);
      // byteOffset must be multiple of 4 (Float32Array guarantee when from f32 buffer).
      device.queue.writeBuffer(buf, 0, view.buffer, view.byteOffset, bytes);
    } else {
      if (!heightCpuScratch || heightCpuScratch.length < n) {
        heightCpuScratch = new Float32Array(n);
      }
      const packed = copyHeightsToF32(y, n, heightCpuScratch);
      if (packed !== heightCpuScratch && packed.length >= n) {
        heightCpuScratch = packed;
      }
      device.queue.writeBuffer(buf, 0, packed.buffer, packed.byteOffset, bytes);
    }
    uploadCount++;
    return true;
  };

  const ensureIndices = (columns: number, rows: number, wireframe: boolean): void => {
    const dimsStable = columns === lastColumns && rows === lastRows && indexBuffer != null;
    if (!dimsStable) {
      indexBuffer?.destroy();
      wireIndexBuffer?.destroy();
      const solid = packSolidIndices(columns, rows);
      const iBytes = solid.byteLength;
      const iSize = Math.ceil(iBytes / 4) * 4;
      indexBuffer = device.createBuffer({
        label: 'surface3d/indices',
        size: Math.max(iSize, 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(indexBuffer, 0, solid.buffer, solid.byteOffset, iBytes);
      indexCount = solid.length;

      if (wireframe) {
        const wIdx = packSurface3DWireframeIndices(columns, rows);
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
      lastColumns = columns;
      lastRows = rows;
    } else if (wireframe && !wireIndexBuffer) {
      const wIdx = packSurface3DWireframeIndices(columns, rows);
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
    const grid = sanitizeSurface3DGrid(dataRef);
    if (!grid) {
      hasGeom = false;
      hasPrepared = false;
      return;
    }

    const yRef = dataRef?.y;
    const wire = seriesConfig.wireframe;
    const metaChanged =
      grid.xStart !== lastXStart ||
      grid.xStep !== lastXStep ||
      grid.zStart !== lastZStart ||
      grid.zStep !== lastZStep;
    // Heights upload when data / y / grid meta change. Wireframe-only toggles only
    // rebuild index topology — do not re-write the full height storage.
    // Colormap domain (yMin/yMax) is uniform-only — does not rebuild heights.
    // In-place mutation of y values under a stable array reference is not detected
    // (same contract as heatmap z) — replace `data` or `data.y` reference via setOption
    // or use updateSurface3D (new data wrapper each call; y may be zero-copy identity).
    const heightsChanged = dataRef !== lastDataRef || yRef !== lastYRef || metaChanged;
    const wireChanged = wire !== lastWire;
    if (heightsChanged || wireChanged) {
      const n = grid.columns * grid.rows;
      if (heightsChanged) {
        const ok = uploadHeights(grid.y, n);
        if (!ok) {
          hasGeom = false;
          hasPrepared = false;
          // Do not latch lastDataRef — allow retry if limits improve (rare) or data shrinks.
          return;
        }
      }
      ensureIndices(grid.columns, grid.rows, wire);
      lastDataRef = dataRef;
      lastYRef = yRef;
      lastWire = wire;
      lastXStart = grid.xStart;
      lastXStep = grid.xStep;
      lastZStart = grid.zStart;
      lastZStep = grid.zStep;
      geomColumns = grid.columns;
      geomRows = grid.rows;
      hasGeom = n > 0 && heightBuffer != null && indexCount > 0;
    } else if (!hasGeom && heightBuffer != null && indexBuffer != null && indexCount > 0) {
      hasGeom = true;
    }

    if (!hasGeom || !heightBuffer || geomColumns < 2 || geomRows < 2) {
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
    // grid: xStart, xStep, zStart, zStep
    vsUniformF32[28] = grid.xStart;
    vsUniformF32[29] = grid.xStep;
    vsUniformF32[30] = grid.zStart;
    vsUniformF32[31] = grid.zStep;
    // gridDims: columns, rows
    vsUniformF32[32] = geomColumns;
    vsUniformF32[33] = geomRows;
    vsUniformF32[34] = 0;
    vsUniformF32[35] = 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformF32);

    // Rebuild bind group when LUT or height buffer identity changes.
    if (!bindGroup || lastBindLutKey !== lutKey || lastBindHeightBuffer !== heightBuffer) {
      bindGroup = device.createBindGroup({
        label: 'surface3d/bindGroup',
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: vsUniformBuffer } },
          { binding: 1, resource: lut },
          { binding: 2, resource: { buffer: heightBuffer } },
        ],
      });
      lastBindLutKey = lutKey;
      lastBindHeightBuffer = heightBuffer;
    }
    drawWire = wire;
    hasPrepared = true;
  };

  return {
    prepare,
    render(passEncoder) {
      if (disposed || !hasPrepared || !hasGeom || !bindGroup || !heightBuffer || !indexBuffer) return;
      passEncoder.setBindGroup(0, bindGroup);
      if (drawWire && wireIndexBuffer && wireIndexCount > 0) {
        // wireframe:true → line-list only (product exclusive mode).
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
      heightBuffer?.destroy();
      indexBuffer?.destroy();
      wireIndexBuffer?.destroy();
      vsUniformBuffer.destroy();
      lutTexture?.destroy();
      heightBuffer = null;
      indexBuffer = null;
      wireIndexBuffer = null;
      lutTexture = null;
      lutView = null;
      bindGroup = null;
      heightCpuScratch = null;
    },
    getUploadCount: () => uploadCount,
    hasGeometry: () => hasGeom,
  };
}
