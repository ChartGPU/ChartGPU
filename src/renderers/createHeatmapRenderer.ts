/**
 * Uniform heatmap / spectrogram GPU renderer.
 *
 * Data-space grid uploaded as an `r32float` texture + 256-entry colormap LUT,
 * drawn as a single quad with the same log/linear clip affine as other series.
 * Does **not** use DataStore XY packing.
 *
 * Dirty gates:
 * - z texture: size change, z array ref change, or content stamp change on setOption
 * - LUT: colormap key change
 * - uniforms only: zoom/pan, opacity (incl. opacityOverride), zMin/zMax, nullHandling
 *
 * In-place z mutation under a **stable** series config identity is not detected
 * (same as cartesian content-hash contract). Streaming must either replace the
 * z array reference or pass a new resolved series object via setOption (stamp scan).
 */

import heatmapWgsl from '../shaders/heatmap.wgsl?raw';
import type { ResolvedHeatmapSeriesConfig } from '../config/OptionResolver';
import type { ContinuousScale } from '../utils/scales';
import type { GridArea } from './createGridRenderer';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { PipelineCache } from '../core/PipelineCache';
import {
  computeClipAffineFromContinuousScale,
  computeClipAffineFromScale,
  resolveLogProjection,
} from './packedXAffine';
import { buildColormapLut, colormapKey } from '../utils/colormap';
import { heatmapGridBounds, heatmapGridPlacement, heatmapZContentStamp } from '../utils/heatmapLayout';

export interface HeatmapPrepareOptions {
  /**
   * Multiplies series opacity for intro animation without changing series
   * config identity (avoids z re-upload thrash).
   */
  readonly opacityOverride?: number;
}

export interface HeatmapRenderer {
  prepare(
    seriesConfig: ResolvedHeatmapSeriesConfig,
    xScale: ContinuousScale,
    yScale: ContinuousScale,
    gridArea: GridArea,
    options?: HeatmapPrepareOptions
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
  /** Test: z-texture uploads since create. */
  getZUploadCount(): number;
  /** Test: LUT writeTexture calls since create. */
  getLutUploadCount(): number;
  hasZTexture(): boolean;
}

export interface HeatmapRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
}

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const TEXTURE_BYTES_PER_ROW_ALIGNMENT = 256;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const writeTransformMat4F32 = (out: Float32Array, ax: number, bx: number, ay: number, by: number): void => {
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

const nullHandlingToU32 = (n: ResolvedHeatmapSeriesConfig['nullHandling']): number => {
  if (n === 'lowest') return 1;
  if (n === 'highest') return 2;
  return 0;
};

/** Pack z with row padding (bytesPerRow multiple of 256). Exported for tests. */
export function packZTextureData(
  z: Float32Array | ReadonlyArray<number>,
  columns: number,
  rows: number,
  paddedColumns: number
): Float32Array<ArrayBuffer> {
  // Always allocate a plain ArrayBuffer-backed Float32Array for writeTexture typings.
  const out: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(paddedColumns * rows * 4));
  const srcLen = z.length;
  for (let j = 0; j < rows; j++) {
    const srcRow = j * columns;
    const dstRow = j * paddedColumns;
    for (let i = 0; i < columns; i++) {
      const idx = srcRow + i;
      out[dstRow + i] = idx < srcLen ? Number(z[idx]) : Number.NaN;
    }
  }
  return out;
}

export function paddedFloatColumns(columns: number): number {
  const bytes = columns * 4;
  const aligned = Math.ceil(bytes / TEXTURE_BYTES_PER_ROW_ALIGNMENT) * TEXTURE_BYTES_PER_ROW_ALIGNMENT;
  return Math.max(columns, aligned / 4);
}

export function createHeatmapRenderer(device: GPUDevice, options?: HeatmapRendererOptions): HeatmapRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw) ? Math.max(1, Math.floor(sampleCountRaw)) : 1;
  const pipelineCache = options?.pipelineCache;

  const vsUniformBuffer = createUniformBuffer(device, 96, { label: 'heatmap/vsUniforms' });
  const vsUniformF32 = new Float32Array(24);
  const vsUniformU32 = new Uint32Array(vsUniformF32.buffer);

  const fsUniformBuffer = createUniformBuffer(device, 32, { label: 'heatmap/fsUniforms' });
  const fsUniformF32 = new Float32Array(8);
  const fsUniformU32 = new Uint32Array(fsUniformF32.buffer);

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'heatmap/bindGroupLayout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
    ],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'heatmap/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: { code: heatmapWgsl, label: 'heatmap.wgsl' },
      fragment: {
        code: heatmapWgsl,
        label: 'heatmap.wgsl',
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

  let zTexture: GPUTexture | null = null;
  let zView: GPUTextureView | null = null;
  let lutTexture: GPUTexture | null = null;
  let lutView: GPUTextureView | null = null;
  let bindGroup: GPUBindGroup | null = null;

  let lastColumns = 0;
  let lastRows = 0;
  let lastPaddedColumns = 0;
  let lastZRef: Float32Array | ReadonlyArray<number> | null = null;
  let lastZStamp = 0;
  let lastSeriesConfig: ResolvedHeatmapSeriesConfig | null = null;
  let zUploadCount = 0;
  let lutUploadCount = 0;
  let lastColormapKey = '';
  let hasPrepared = false;
  let canDraw = false;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('HeatmapRenderer is disposed.');
  };

  const destroyZTexture = (): void => {
    if (zTexture) {
      try {
        zTexture.destroy();
      } catch {
        // best-effort
      }
    }
    zTexture = null;
    zView = null;
    bindGroup = null;
    lastColumns = 0;
    lastRows = 0;
    lastPaddedColumns = 0;
  };

  const ensureLut = (seriesConfig: ResolvedHeatmapSeriesConfig): void => {
    const key = colormapKey(seriesConfig.colormap);
    if (!lutTexture) {
      lutTexture = device.createTexture({
        label: 'heatmap/lutTexture',
        size: { width: 256, height: 1, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      lutView = lutTexture.createView();
      lastColormapKey = '';
    }
    if (key === lastColormapKey) return;
    const data = buildColormapLut(seriesConfig.colormap);
    device.queue.writeTexture(
      { texture: lutTexture },
      data,
      { bytesPerRow: 256 * 4, rowsPerImage: 1 },
      { width: 256, height: 1, depthOrArrayLayers: 1 }
    );
    lastColormapKey = key;
    lutUploadCount += 1;
  };

  /** @returns true if texture was (re)created */
  const ensureZTexture = (columns: number, rows: number): boolean => {
    if (zTexture && lastColumns === columns && lastRows === rows) return false;
    destroyZTexture();
    const padded = paddedFloatColumns(columns);
    zTexture = device.createTexture({
      label: 'heatmap/zTexture',
      size: { width: columns, height: rows, depthOrArrayLayers: 1 },
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    zView = zTexture.createView();
    lastColumns = columns;
    lastRows = rows;
    lastPaddedColumns = padded;
    lastZRef = null;
    lastZStamp = 0;
    bindGroup = null;
    return true;
  };

  const uploadZ = (z: Float32Array | ReadonlyArray<number>, columns: number, rows: number, stamp: number): void => {
    if (!zTexture) return;
    const padded = lastPaddedColumns > 0 ? lastPaddedColumns : paddedFloatColumns(columns);
    const packed = packZTextureData(z, columns, rows, padded);
    device.queue.writeTexture(
      { texture: zTexture },
      packed,
      { bytesPerRow: padded * 4, rowsPerImage: rows },
      { width: columns, height: rows, depthOrArrayLayers: 1 }
    );
    zUploadCount += 1;
    lastZRef = z;
    lastZStamp = stamp;
  };

  const ensureBindGroup = (): void => {
    if (!zView || !lutView || bindGroup) return;
    bindGroup = device.createBindGroup({
      label: 'heatmap/bindGroup',
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: vsUniformBuffer } },
        { binding: 1, resource: { buffer: fsUniformBuffer } },
        { binding: 2, resource: zView },
        { binding: 3, resource: lutView },
      ],
    });
  };

  const prepare: HeatmapRenderer['prepare'] = (seriesConfig, xScale, yScale, gridArea, prepareOpts) => {
    assertNotDisposed();
    hasPrepared = true;
    canDraw = false;

    if (!seriesConfig.drawable || seriesConfig.visible === false) {
      lastSeriesConfig = seriesConfig;
      return;
    }

    const { data } = seriesConfig;
    const columns = data.columns | 0;
    const rows = data.rows | 0;
    if (columns < 1 || rows < 1) {
      lastSeriesConfig = seriesConfig;
      return;
    }

    ensureLut(seriesConfig);
    const sizeRecreated = ensureZTexture(columns, rows);

    const zRef = data.z;
    const expectedCells = columns * rows;
    const seriesIdentityChanged = lastSeriesConfig !== seriesConfig;

    // Z upload: size | zRef | (setOption identity + content stamp change)
    // Visual-only setOption (opacity/zMin/colormap) keeps stamp → no z upload.
    let shouldUploadZ = sizeRecreated || lastZRef !== zRef;
    if (!shouldUploadZ && seriesIdentityChanged) {
      const stamp = heatmapZContentStamp(zRef, expectedCells);
      if (stamp !== lastZStamp) {
        uploadZ(zRef, columns, rows, stamp);
      } else {
        lastZStamp = stamp;
      }
    } else if (shouldUploadZ) {
      uploadZ(zRef, columns, rows, heatmapZContentStamp(zRef, expectedCells));
    }

    lastSeriesConfig = seriesConfig;

    const bounds = seriesConfig.rawBounds ?? heatmapGridBounds(data, seriesConfig.cellAnchor);
    const placement = heatmapGridPlacement(data, seriesConfig.cellAnchor);

    const { a: ax, b: bx } =
      xScale.kind === 'log'
        ? computeClipAffineFromContinuousScale(xScale)
        : computeClipAffineFromScale(xScale, bounds.xMin, bounds.xMax);
    const { a: ay, b: by } =
      yScale.kind === 'log'
        ? computeClipAffineFromContinuousScale(yScale)
        : computeClipAffineFromScale(yScale, bounds.yMin, bounds.yMax);
    const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);

    writeTransformMat4F32(vsUniformF32, ax, bx, ay, by);
    // Signed origin + extent so UV (0,0) = cell (0,0) even with negative steps.
    vsUniformF32[16] = placement.x0;
    vsUniformF32[17] = placement.y0;
    vsUniformF32[18] = placement.xExtent;
    vsUniformF32[19] = placement.yExtent;
    vsUniformF32[20] = logBaseX;
    vsUniformF32[21] = logBaseY;
    vsUniformU32[22] = logFlags >>> 0;
    vsUniformU32[23] = 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformF32);

    const baseOpacity = clamp01(seriesConfig.opacity);
    const opacity =
      prepareOpts?.opacityOverride !== undefined ? clamp01(baseOpacity * prepareOpts.opacityOverride) : baseOpacity;

    fsUniformF32[0] = seriesConfig.zMin;
    fsUniformF32[1] = seriesConfig.zMax;
    fsUniformF32[2] = opacity;
    fsUniformU32[3] = seriesConfig.zScale === 'log' ? 1 : 0;
    fsUniformU32[4] = nullHandlingToU32(seriesConfig.nullHandling);
    fsUniformU32[5] = columns >>> 0;
    fsUniformU32[6] = rows >>> 0;
    const plotW = Math.max(
      1,
      gridArea.canvasWidth / Math.max(1e-6, gridArea.devicePixelRatio) - gridArea.left - gridArea.right
    );
    const gapTexels =
      seriesConfig.cellGapPx > 0 && plotW > 0 ? Math.min(0.4, (seriesConfig.cellGapPx / plotW) * columns) : 0;
    fsUniformF32[7] = gapTexels;
    writeUniformBuffer(device, fsUniformBuffer, fsUniformF32);

    ensureBindGroup();
    canDraw = bindGroup != null;
  };

  const render: HeatmapRenderer['render'] = (passEncoder) => {
    if (disposed || !hasPrepared || !canDraw || !bindGroup) return;
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(6, 1, 0, 0);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    destroyZTexture();
    if (lutTexture) {
      try {
        lutTexture.destroy();
      } catch {
        // best-effort
      }
      lutTexture = null;
      lutView = null;
    }
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
    bindGroup = null;
  };

  return {
    prepare,
    render,
    dispose,
    getZUploadCount: () => zUploadCount,
    getLutUploadCount: () => lutUploadCount,
    hasZTexture: () => zTexture != null,
  };
}
