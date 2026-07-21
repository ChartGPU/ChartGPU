/**
 * WebGPU 3D axis tick numbers + titles via glyph atlas billboard quads.
 * Camera-only frames update viewProj (+ color) uniforms — no atlas rebuild.
 */

import axes3dGpuLabelsWgsl from '../shaders/axes3dGpuLabels.wgsl?raw';
import type { Mat4 } from '../core/3d/mat4';
import type { AABB } from '../core/3d/aabb';
import {
  axes3DLabelPlanSignature,
  buildAxes3DGpuLabelInstances,
  buildAxes3DLabelItems,
  formatAxes3DMissingGlyphsWarning,
  shouldRebuildAxes3DGpuLabelInstances,
  AXES3D_GPU_LABEL_INSTANCE_BYTES,
  type BuildAxes3DGpuLabelInstancesResult,
} from '../core/3d/axes3dLabelItems';
import { bakeGlyphAtlas, type GlyphAtlas } from '../core/3d/glyphAtlas';
import type { Axes3DTickPlan } from './createAxisBox3DRenderer';
import type { ResolvedAxes3D } from '../config/OptionResolver';
import type { PipelineCache } from '../core/PipelineCache';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { Rgba01 } from '../utils/colors';

export interface Axes3DGpuLabelsRenderer {
  /** True when atlas + pipeline resources are ready. */
  readonly ready: boolean;
  /**
   * Prepare labels for the current tick plan / camera.
   * Rebuilds instance buffer only when plan/AABB/names/viewport scale changes.
   */
  prepare(
    aabb: AABB,
    plan: Axes3DTickPlan,
    axes: ResolvedAxes3D,
    viewProj: Mat4,
    viewportCssW: number,
    viewportCssH: number,
    textColorRgba: Rgba01
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
  /** Test/debug: last instance count. */
  getInstanceCount(): number;
  /** Test/debug: number of instance rebuilds (not camera-only). */
  getInstanceRebuildCount(): number;
}

export interface Axes3DGpuLabelsRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
  /** Optional pre-baked atlas (tests / shared devices). */
  readonly atlas?: GlyphAtlas | null;
  readonly tickCssPx?: number;
  readonly titleCssPx?: number;
  readonly maxGlyphs?: number;
}

// viewProj(64) + viewport(16) + color(16) = 96
const VS_UNIFORM_SIZE = 96;
/** Pull labels slightly toward camera in clip-z (× w). */
const DEPTH_BIAS = -0.0008;

const premulBlend: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const depthStencil: GPUDepthStencilState = {
  format: 'depth24plus',
  depthWriteEnabled: false,
  depthCompare: 'less-equal',
  depthBias: -2,
  depthBiasSlopeScale: -1,
  depthBiasClamp: 0,
};

function bytesPerRowRgba(width: number): number {
  // WebGPU copyTexture: bytesPerRow multiple of 256
  return Math.ceil((width * 4) / 256) * 256;
}

function uploadAtlasTexture(device: GPUDevice, atlas: GlyphAtlas): { texture: GPUTexture; view: GPUTextureView } {
  const texture = device.createTexture({
    label: 'axes3dGpuLabels/atlas',
    size: { width: atlas.width, height: atlas.height },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  try {
    const bpr = bytesPerRowRgba(atlas.width);
    // Copy into a plain Uint8Array so writeTexture accepts ArrayBufferView (not SharedArrayBuffer-backed).
    const srcRow = atlas.width * 4;
    const padded = new Uint8Array(bpr * atlas.height);
    for (let y = 0; y < atlas.height; y++) {
      padded.set(atlas.pixels.subarray(y * srcRow, y * srcRow + srcRow), y * bpr);
    }
    device.queue.writeTexture(
      { texture },
      padded,
      { bytesPerRow: bpr, rowsPerImage: atlas.height },
      { width: atlas.width, height: atlas.height }
    );
    return { texture, view: texture.createView() };
  } catch (err) {
    texture.destroy();
    throw err;
  }
}

/**
 * Create GPU axis label renderer. Returns `ready: false` (no-op prepare/render)
 * when atlas bake fails — caller should fall back to DOM.
 */
export function createAxes3DGpuLabelsRenderer(
  device: GPUDevice,
  options?: Axes3DGpuLabelsRendererOptions
): Axes3DGpuLabelsRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? 'bgra8unorm';
  const sampleCount = options?.sampleCount === 4 ? 4 : 1;
  const pipelineCache = options?.pipelineCache;
  const tickCssPx = options?.tickCssPx ?? 10;
  const titleCssPx = options?.titleCssPx ?? 12;
  const maxGlyphs = options?.maxGlyphs ?? 4096;

  // Explicit `atlas: null` forces failure/fallback; omit `atlas` to bake at create time.
  let atlas: GlyphAtlas | null;
  if (options && Object.prototype.hasOwnProperty.call(options, 'atlas')) {
    atlas = options.atlas ?? null;
  } else {
    try {
      atlas = bakeGlyphAtlas({
        fontSizePx: 16,
        pixelScale: 2,
        maxAtlasSize: 512,
        // Titles slightly heavier via second bake is overkill; one atlas is enough.
        fontWeight: '500',
      });
    } catch {
      atlas = null;
    }
  }

  const notReady = (): Axes3DGpuLabelsRenderer => ({
    ready: false,
    prepare() {},
    render() {},
    dispose() {
      disposed = true;
    },
    getInstanceCount: () => 0,
    getInstanceRebuildCount: () => 0,
  });

  if (!atlas || atlas.glyphs.size === 0) {
    return notReady();
  }

  const atlasOwned = atlas;
  let atlasTexture: GPUTexture | null = null;
  let atlasView: GPUTextureView | null = null;
  try {
    const up = uploadAtlasTexture(device, atlasOwned);
    atlasTexture = up.texture;
    atlasView = up.view;
  } catch {
    return notReady();
  }

  const sampler = device.createSampler({
    label: 'axes3dGpuLabels/sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  const vsUniformBuffer = createUniformBuffer(device, VS_UNIFORM_SIZE, { label: 'axes3dGpuLabels/vsUniforms' });
  const vsUniformF32 = new Float32Array(VS_UNIFORM_SIZE / 4);

  let storageBuffer: GPUBuffer | null = null;
  let storageCapacityBytes = 0;
  let instanceCount = 0;
  let hasPrepared = false;
  let lastSignature = '';
  let instanceRebuildCount = 0;
  let missingWarned = false;
  let bindGroup: GPUBindGroup | null = null;

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'axes3dGpuLabels/bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'axes3dGpuLabels/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: { code: axes3dGpuLabelsWgsl, label: 'axes3dGpuLabels/shader' },
      fragment: {
        code: axes3dGpuLabelsWgsl,
        label: 'axes3dGpuLabels/shader',
        formats: targetFormat,
        blend: premulBlend,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  const ensureStorage = (byteLength: number): GPUBuffer => {
    const need = Math.max(AXES3D_GPU_LABEL_INSTANCE_BYTES, byteLength);
    if (storageBuffer && storageCapacityBytes >= need) return storageBuffer;
    storageBuffer?.destroy();
    let cap = storageCapacityBytes > 0 ? storageCapacityBytes : AXES3D_GPU_LABEL_INSTANCE_BYTES * 64;
    while (cap < need) cap = Math.ceil(cap * 1.5);
    // Align capacity to 4 bytes
    cap = Math.ceil(cap / 4) * 4;
    storageBuffer = device.createBuffer({
      label: 'axes3dGpuLabels/instances',
      size: cap,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    storageCapacityBytes = cap;
    bindGroup = null;
    return storageBuffer;
  };

  // Placeholder 1-instance buffer so bind group is always valid before first real prepare
  ensureStorage(AXES3D_GPU_LABEL_INSTANCE_BYTES);
  const zero = new Float32Array(12);
  device.queue.writeBuffer(storageBuffer!, 0, zero.buffer, zero.byteOffset, zero.byteLength);

  const rebuildBindGroup = (): void => {
    if (!storageBuffer || !atlasView) return;
    bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: vsUniformBuffer } },
        { binding: 1, resource: { buffer: storageBuffer } },
        { binding: 2, resource: atlasView },
        { binding: 3, resource: sampler },
      ],
    });
  };
  rebuildBindGroup();

  const writeUniforms = (viewProj: Mat4, viewportCssW: number, viewportCssH: number, color: Rgba01): void => {
    vsUniformF32.set(viewProj, 0);
    vsUniformF32[16] = viewportCssW;
    vsUniformF32[17] = viewportCssH;
    vsUniformF32[18] = DEPTH_BIAS;
    vsUniformF32[19] = 0;
    vsUniformF32[20] = color[0];
    vsUniformF32[21] = color[1];
    vsUniformF32[22] = color[2];
    vsUniformF32[23] = color[3];
    writeUniformBuffer(device, vsUniformBuffer, vsUniformF32);
  };

  const uploadInstances = (built: BuildAxes3DGpuLabelInstancesResult): void => {
    instanceCount = built.instanceCount;
    // Mark prepared even when empty so camera-only frames keep the signature sticky.
    hasPrepared = true;
    if (instanceCount <= 0) return;
    const bytes = built.instances.byteLength;
    // writeBuffer size must be multiple of 4 (already is for Float32)
    const buf = ensureStorage(bytes);
    device.queue.writeBuffer(buf, 0, built.instances.buffer, built.instances.byteOffset, bytes);
    if (!bindGroup) rebuildBindGroup();
  };

  return {
    ready: true,
    prepare(aabb, plan, axes, viewProj, viewportCssW, viewportCssH, textColorRgba) {
      if (disposed) return;
      writeUniforms(viewProj, viewportCssW, viewportCssH, textColorRgba);

      const sig = axes3DLabelPlanSignature(aabb, plan, axes, viewportCssW, viewportCssH, tickCssPx, titleCssPx);
      if (!shouldRebuildAxes3DGpuLabelInstances(lastSignature, sig, hasPrepared)) {
        // Camera-only: uniforms already updated; instance geometry kept
        return;
      }
      lastSignature = sig;
      instanceRebuildCount++;

      const items = buildAxes3DLabelItems(aabb, plan, axes);
      const built = buildAxes3DGpuLabelInstances(items, {
        atlas: atlasOwned,
        viewProj,
        viewportCssW,
        viewportCssH,
        tickCssPx,
        titleCssPx,
        maxGlyphs,
        trackMissing: !missingWarned,
      });
      if (built.missingChars.length > 0 && !missingWarned) {
        missingWarned = true;
        console.warn(formatAxes3DMissingGlyphsWarning(built.missingChars));
      }
      uploadInstances(built);
    },
    render(pass) {
      if (disposed || !hasPrepared || !bindGroup || !storageBuffer || instanceCount <= 0) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6, instanceCount);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      storageBuffer?.destroy();
      atlasTexture?.destroy();
      vsUniformBuffer.destroy();
      storageBuffer = null;
      atlasTexture = null;
      atlasView = null;
      bindGroup = null;
    },
    getInstanceCount: () => instanceCount,
    getInstanceRebuildCount: () => instanceRebuildCount,
  };
}
