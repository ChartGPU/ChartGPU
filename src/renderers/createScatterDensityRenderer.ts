import scatterDensityBinningWgsl from '../shaders/scatterDensityBinning.wgsl?raw';
import scatterDensityColormapWgsl from '../shaders/scatterDensityColormap.wgsl?raw';
import type { RawBounds, ResolvedScatterSeriesConfig } from '../config/OptionResolver';
import type { LinearScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import type { GridArea } from './createGridRenderer';
import { createRenderPipeline, createShaderModule, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { PipelineCache } from '../core/PipelineCache';

export interface ScatterDensityRenderer {
  prepare(
    seriesConfig: ResolvedScatterSeriesConfig,
    pointBuffer: GPUBuffer,
    pointCount: number,
    visibleStartIndex: number,
    visibleEndIndex: number,
    xScale: LinearScale,
    yScale: LinearScale,
    gridArea: GridArea,
    rawBounds?: RawBounds
  ): void;
  encodeCompute(encoder: GPUCommandEncoder): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface ScatterDensityRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  /**
   * Optional shared cache for shader modules + render pipelines.
   */
  readonly pipelineCache?: PipelineCache;
}

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

const computeClipAffineFromScale = (
  scale: LinearScale,
  v0: number,
  v1: number
): { readonly a: number; readonly b: number } => {
  const p0 = scale.scale(v0);
  const p1 = scale.scale(v1);

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
  out[3] = 0;
  out[4] = 0;
  out[5] = ay;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;
  out[12] = bx;
  out[13] = by;
  out[14] = 0;
  out[15] = 1;
};

const computePlotScissorDevicePx = (
  gridArea: GridArea
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } => {
  const { canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeftDevice = gridArea.left * devicePixelRatio;
  const plotRightDevice = canvasWidth - gridArea.right * devicePixelRatio;
  const plotTopDevice = gridArea.top * devicePixelRatio;
  const plotBottomDevice = canvasHeight - gridArea.bottom * devicePixelRatio;

  const scissorX = clampInt(Math.floor(plotLeftDevice), 0, Math.max(0, canvasWidth));
  const scissorY = clampInt(Math.floor(plotTopDevice), 0, Math.max(0, canvasHeight));
  const scissorR = clampInt(Math.ceil(plotRightDevice), 0, Math.max(0, canvasWidth));
  const scissorB = clampInt(Math.ceil(plotBottomDevice), 0, Math.max(0, canvasHeight));
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
};

type Rgba01 = readonly [r: number, g: number, b: number, a: number];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpRgba = (a: Rgba01, b: Rgba01, t: number): Rgba01 =>
  [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)] as const;

const parseColorStop = (css: string): Rgba01 => parseCssColorToRgba01(css) ?? ([0, 0, 0, 1] as const);

const getNamedStops = (name: 'viridis' | 'plasma' | 'inferno'): readonly string[] => {
  // Compact stop lists (interpolated to 256 entries). These are standard-ish anchors.
  if (name === 'plasma') {
    return ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'] as const;
  }
  if (name === 'inferno') {
    return ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'] as const;
  }
  // viridis
  return ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] as const;
};

const buildLutRGBA8 = (colormap: ResolvedScatterSeriesConfig['densityColormap']): Uint8Array<ArrayBuffer> => {
  const stopsCss =
    typeof colormap === 'string'
      ? getNamedStops(colormap)
      : Array.isArray(colormap) && colormap.length > 0
        ? colormap
        : (getNamedStops('viridis') as readonly string[]);

  const stops = stopsCss.map(parseColorStop);
  const n = Math.max(2, stops.length);

  // Ensure the underlying buffer is a plain ArrayBuffer (not SharedArrayBuffer) for WebGPU typings.
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(256 * 4));
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const x = t * (n - 1);
    const seg = Math.min(n - 2, Math.max(0, Math.floor(x)));
    const localT = x - seg;
    const c = lerpRgba(stops[seg]!, stops[seg + 1]!, localT);

    out[i * 4 + 0] = clampInt(Math.round(clamp01(c[0]) * 255), 0, 255);
    out[i * 4 + 1] = clampInt(Math.round(clamp01(c[1]) * 255), 0, 255);
    out[i * 4 + 2] = clampInt(Math.round(clamp01(c[2]) * 255), 0, 255);
    out[i * 4 + 3] = clampInt(Math.round(clamp01(c[3]) * 255), 0, 255);
  }
  return out;
};

const colormapKey = (colormap: ResolvedScatterSeriesConfig['densityColormap']): string => {
  if (typeof colormap === 'string') return colormap;
  try {
    return JSON.stringify(colormap);
  } catch {
    return 'custom';
  }
};

const normalizationToU32 = (n: ResolvedScatterSeriesConfig['densityNormalization']): number => {
  // Must match shader:
  // 0: linear, 1: sqrt, 2: log
  if (n === 'sqrt') return 1;
  if (n === 'log') return 2;
  return 0;
};

export function createScatterDensityRenderer(
  device: GPUDevice,
  options?: ScatterDensityRendererOptions
): ScatterDensityRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const pipelineCache = options?.pipelineCache;

  const computeBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });

  const renderBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      // `scatterDensityColormap.wgsl` declares these as `var<storage, read>`, so they must be read-only-storage.
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ],
  });

  // Compute uniforms:
  // transform(64) + viewportPx(8)+pad(8)=80
  // plotOriginPx u32x2(8) + plotSizePx u32x2(8) = 16 => 96
  // binSize/binCountX/binCountY/start/end/norm u32*6 (24) + pad u32x2 (8) => 128
  const computeUniformBuffer = createUniformBuffer(device, 128, { label: 'scatterDensity/computeUniforms' });
  const computeUniformScratch = new ArrayBuffer(128);
  const computeUniformF32 = new Float32Array(computeUniformScratch, 0, 20); // first 80 bytes (20 f32)
  const computeUniformU32 = new Uint32Array(computeUniformScratch);

  // Render uniforms: plotOriginPx(8)+plotSizePx(8)=16; u32*4 (16) + padding to 48.
  const renderUniformBuffer = createUniformBuffer(device, 48, { label: 'scatterDensity/renderUniforms' });
  const renderUniformScratch = new ArrayBuffer(48);
  const renderUniformU32 = new Uint32Array(renderUniformScratch);

  const binningModule = createShaderModule(
    device,
    scatterDensityBinningWgsl,
    'scatterDensityBinning.wgsl',
    pipelineCache
  );
  const binPointsPipeline = device.createComputePipeline({
    label: 'scatterDensity/binPointsPipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [computeBindGroupLayout] }),
    compute: { module: binningModule, entryPoint: 'binPoints' },
  });
  const reduceMaxPipeline = device.createComputePipeline({
    label: 'scatterDensity/reduceMaxPipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [computeBindGroupLayout] }),
    compute: { module: binningModule, entryPoint: 'reduceMax' },
  });

  const renderPipeline = createRenderPipeline(
    device,
    {
      label: 'scatterDensity/renderPipeline',
      bindGroupLayouts: [renderBindGroupLayout],
      vertex: { code: scatterDensityColormapWgsl, label: 'scatterDensityColormap.wgsl' },
      fragment: {
        code: scatterDensityColormapWgsl,
        label: 'scatterDensityColormap.wgsl',
        formats: targetFormat,
        blend: undefined,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: 1 },
    },
    pipelineCache
  );

  let binsBuffer: GPUBuffer | null = null;
  let maxBuffer: GPUBuffer | null = null;
  let binsCapacityU32 = 0;

  let lutTexture: GPUTexture | null = null;
  let lutView: GPUTextureView | null = null;
  let lastColormapKey = '';

  let computeBindGroup: GPUBindGroup | null = null;
  let renderBindGroup: GPUBindGroup | null = null;

  // Cached state to decide when to recompute.
  let lastPointBuffer: GPUBuffer | null = null;
  let lastPointCount = -1;
  let lastVisibleStart = 0;
  let lastVisibleEnd = 0;
  let lastBinSizePx = 0;
  let lastBinCountX = 0;
  let lastBinCountY = 0;
  let lastPlotScissor: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null = null;
  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let lastNormalizationU32 = 2; // default 'log'

  let computeDirty = true;
  let hasPrepared = false;

  // Zero staging for fast clear (reallocated to match bins size).
  let zeroBinsStaging = new Uint32Array(0);

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('ScatterDensityRenderer is disposed.');
  };

  const ensureLut = (seriesConfig: ResolvedScatterSeriesConfig): void => {
    const key = colormapKey(seriesConfig.densityColormap);
    if (!lutTexture) {
      lutTexture = device.createTexture({
        label: 'scatterDensity/lutTexture',
        size: { width: 256, height: 1, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      lutView = lutTexture.createView();
      lastColormapKey = '';
    }
    if (key === lastColormapKey) return;

    const data = buildLutRGBA8(seriesConfig.densityColormap);
    device.queue.writeTexture(
      { texture: lutTexture! },
      data,
      { bytesPerRow: 256 * 4, rowsPerImage: 1 },
      { width: 256, height: 1, depthOrArrayLayers: 1 }
    );
    lastColormapKey = key;
  };

  const ensureBins = (binCountX: number, binCountY: number): void => {
    const n = Math.max(1, binCountX | 0) * Math.max(1, binCountY | 0);
    if (binsBuffer && maxBuffer && n <= binsCapacityU32) return;

    const requiredU32 = Math.max(1, n);
    const grownU32 = Math.max(256, nextPow2(requiredU32));
    binsCapacityU32 = grownU32;

    if (binsBuffer) {
      try {
        binsBuffer.destroy();
      } catch {
        // best-effort
      }
      binsBuffer = null;
    }
    if (maxBuffer) {
      try {
        maxBuffer.destroy();
      } catch {
        // best-effort
      }
      maxBuffer = null;
    }

    binsBuffer = device.createBuffer({
      label: 'scatterDensity/binsBuffer',
      size: binsCapacityU32 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    maxBuffer = device.createBuffer({
      label: 'scatterDensity/maxBuffer',
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Refresh clear staging.
    zeroBinsStaging = new Uint32Array(binsCapacityU32);

    // Bind groups depend on buffers, so force re-create.
    computeBindGroup = null;
    renderBindGroup = null;
    computeDirty = true;
  };

  const ensureBindGroups = (): void => {
    if (!binsBuffer || !maxBuffer || !lutView || !lastPointBuffer) return;
    if (!computeBindGroup) {
      computeBindGroup = device.createBindGroup({
        label: 'scatterDensity/computeBindGroup',
        layout: computeBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: computeUniformBuffer } },
          { binding: 1, resource: { buffer: lastPointBuffer } },
          { binding: 2, resource: { buffer: binsBuffer } },
          { binding: 3, resource: { buffer: maxBuffer } },
        ],
      });
    }
    if (!renderBindGroup) {
      renderBindGroup = device.createBindGroup({
        label: 'scatterDensity/renderBindGroup',
        layout: renderBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: renderUniformBuffer } },
          { binding: 1, resource: { buffer: binsBuffer } },
          { binding: 2, resource: { buffer: maxBuffer } },
          { binding: 3, resource: lutView },
        ],
      });
    }
  };

  const prepare: ScatterDensityRenderer['prepare'] = (
    seriesConfig,
    pointBuffer,
    pointCount,
    visibleStartIndex,
    visibleEndIndex,
    xScale,
    yScale,
    gridArea,
    rawBounds
  ) => {
    assertNotDisposed();
    hasPrepared = true;

    const plotScissor = computePlotScissorDevicePx(gridArea);
    const dpr = gridArea.devicePixelRatio;
    const binSizeCss = Number.isFinite(seriesConfig.binSize) ? Math.max(1e-6, seriesConfig.binSize) : 2;
    const binSizePx = Math.max(1, Math.round(binSizeCss * (Number.isFinite(dpr) && dpr > 0 ? dpr : 1)));

    const binCountX = Math.max(1, Math.ceil(plotScissor.w / binSizePx));
    const binCountY = Math.max(1, Math.ceil(plotScissor.h / binSizePx));

    ensureBins(binCountX, binCountY);
    ensureLut(seriesConfig);

    const normU32 = normalizationToU32(seriesConfig.densityNormalization);

    // Dirty detection.
    if (lastPointBuffer !== pointBuffer) {
      lastPointBuffer = pointBuffer;
      computeBindGroup = null;
      renderBindGroup = null;
      computeDirty = true;
    }
    if (lastPointCount !== pointCount) {
      lastPointCount = pointCount;
      computeDirty = true;
    }
    if (lastVisibleStart !== visibleStartIndex || lastVisibleEnd !== visibleEndIndex) {
      lastVisibleStart = visibleStartIndex;
      lastVisibleEnd = visibleEndIndex;
      computeDirty = true;
    }
    if (lastBinSizePx !== binSizePx || lastBinCountX !== binCountX || lastBinCountY !== binCountY) {
      lastBinSizePx = binSizePx;
      lastBinCountX = binCountX;
      lastBinCountY = binCountY;
      computeDirty = true;
    }
    if (
      !lastPlotScissor ||
      lastPlotScissor.x !== plotScissor.x ||
      lastPlotScissor.y !== plotScissor.y ||
      lastPlotScissor.w !== plotScissor.w ||
      lastPlotScissor.h !== plotScissor.h
    ) {
      lastPlotScissor = plotScissor;
      computeDirty = true;
    }
    if (lastCanvasWidth !== gridArea.canvasWidth || lastCanvasHeight !== gridArea.canvasHeight) {
      lastCanvasWidth = gridArea.canvasWidth;
      lastCanvasHeight = gridArea.canvasHeight;
      computeDirty = true;
    }
    if (lastNormalizationU32 !== normU32) {
      lastNormalizationU32 = normU32;
      computeDirty = true;
    }

    // Write uniforms.
    const rb = rawBounds;
    const xMin = rb?.xMin ?? 0;
    const xMax = rb?.xMax ?? 1;
    const yMin = rb?.yMin ?? 0;
    const yMax = rb?.yMax ?? 1;

    const { a: ax, b: bx } = computeClipAffineFromScale(xScale, xMin, xMax);
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, yMin, yMax);

    writeTransformMat4F32(computeUniformF32, ax, bx, ay, by);
    computeUniformF32[16] = gridArea.canvasWidth > 0 ? gridArea.canvasWidth : 1;
    computeUniformF32[17] = gridArea.canvasHeight > 0 ? gridArea.canvasHeight : 1;
    computeUniformF32[18] = 0;
    computeUniformF32[19] = 0;

    computeUniformU32[20] = plotScissor.x >>> 0;
    computeUniformU32[21] = plotScissor.y >>> 0;
    computeUniformU32[22] = plotScissor.w >>> 0;
    computeUniformU32[23] = plotScissor.h >>> 0;
    computeUniformU32[24] = binSizePx >>> 0;
    computeUniformU32[25] = binCountX >>> 0;
    computeUniformU32[26] = binCountY >>> 0;
    computeUniformU32[27] = (Math.max(0, visibleStartIndex) | 0) >>> 0;
    computeUniformU32[28] = (Math.max(0, visibleEndIndex) | 0) >>> 0;
    computeUniformU32[29] = normU32 >>> 0;

    writeUniformBuffer(device, computeUniformBuffer, computeUniformScratch);

    renderUniformU32[0] = plotScissor.x >>> 0;
    renderUniformU32[1] = plotScissor.y >>> 0;
    renderUniformU32[2] = plotScissor.w >>> 0;
    renderUniformU32[3] = plotScissor.h >>> 0;
    renderUniformU32[4] = binSizePx >>> 0;
    renderUniformU32[5] = binCountX >>> 0;
    renderUniformU32[6] = binCountY >>> 0;
    renderUniformU32[7] = normU32 >>> 0;
    writeUniformBuffer(device, renderUniformBuffer, renderUniformScratch);

    ensureBindGroups();
  };

  const encodeCompute: ScatterDensityRenderer['encodeCompute'] = (encoder) => {
    assertNotDisposed();
    if (!hasPrepared) return;
    if (!computeDirty) return;
    if (!binsBuffer || !maxBuffer || !computeBindGroup || lastPointCount <= 0) {
      computeDirty = false;
      return;
    }
    if (!lastPlotScissor || lastPlotScissor.w <= 0 || lastPlotScissor.h <= 0) {
      computeDirty = false;
      return;
    }

    // Clear bins + max.
    device.queue.writeBuffer(binsBuffer, 0, zeroBinsStaging.buffer, 0, binsCapacityU32 * 4);
    device.queue.writeBuffer(maxBuffer, 0, new Uint32Array([0]).buffer);

    const binTotal = (lastBinCountX * lastBinCountY) | 0;
    const visibleCount = Math.max(0, (lastVisibleEnd - lastVisibleStart) | 0);

    const pass = encoder.beginComputePass({ label: 'scatterDensity/computePass' });
    pass.setBindGroup(0, computeBindGroup);

    pass.setPipeline(binPointsPipeline);
    const wg = 256;
    const groupsPoints = Math.ceil(visibleCount / wg);
    if (groupsPoints > 0) pass.dispatchWorkgroups(groupsPoints);

    pass.setPipeline(reduceMaxPipeline);
    const groupsBins = Math.ceil(binTotal / wg);
    if (groupsBins > 0) pass.dispatchWorkgroups(groupsBins);

    pass.end();
    computeDirty = false;
  };

  const render: ScatterDensityRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (!hasPrepared) return;
    if (!renderBindGroup || !lastPlotScissor || !lutView) return;
    if (lastPlotScissor.w <= 0 || lastPlotScissor.h <= 0) return;

    passEncoder.setScissorRect(lastPlotScissor.x, lastPlotScissor.y, lastPlotScissor.w, lastPlotScissor.h);
    passEncoder.setPipeline(renderPipeline);
    passEncoder.setBindGroup(0, renderBindGroup);
    passEncoder.draw(3);

    if (lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    }
  };

  const dispose: ScatterDensityRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    try {
      computeUniformBuffer.destroy();
    } catch {
      // best-effort
    }
    try {
      renderUniformBuffer.destroy();
    } catch {
      // best-effort
    }

    if (binsBuffer) {
      try {
        binsBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    if (maxBuffer) {
      try {
        maxBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    binsBuffer = null;
    maxBuffer = null;
    binsCapacityU32 = 0;

    if (lutTexture) {
      try {
        lutTexture.destroy();
      } catch {
        // best-effort
      }
    }
    lutTexture = null;
    lutView = null;

    computeBindGroup = null;
    renderBindGroup = null;
    lastPointBuffer = null;
  };

  return { prepare, encodeCompute, render, dispose };
}

