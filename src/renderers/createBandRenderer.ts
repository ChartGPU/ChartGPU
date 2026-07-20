/**
 * Band / range series renderer — GPU trapezoid fill between y and y1 curves,
 * with optional dual edge strokes via private LineRenderer instances.
 *
 * Data residency: **renderer-private** storage buffer (packed BandPoint stride-4).
 * Not GPU-decimation eligible. Zoom-only frames rewrite VS uniforms only.
 */

import bandWgsl from '../shaders/band.wgsl?raw';
import type { ResolvedBandSeriesConfig, ResolvedLineSeriesConfig } from '../config/OptionResolver';
import type { BandSeriesData } from '../config/types';
import type { ContinuousScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { packBandPoints, packBandStrokeXY, getBandLength, bandBounds, filterBandGaps } from '../data/bandData';
import type { PipelineCache } from '../core/PipelineCache';
import {
  computeClipAffineFromContinuousScale,
  computeClipAffineFromScale,
  resolveLogProjection,
} from './packedXAffine';
import { createLineRenderer, type LineRenderer } from './createLineRenderer';

export interface BandRenderer {
  prepare(
    seriesConfig: ResolvedBandSeriesConfig,
    data: BandSeriesData,
    xScale: ContinuousScale,
    yScale: ContinuousScale,
    devicePixelRatio?: number,
    canvasWidthDevicePx?: number,
    canvasHeightDevicePx?: number
  ): void;
  /**
   * Drop cached domain-space geometry so the next `prepare` re-packs vertices.
   * Required when values mutate under a stable data array reference.
   */
  invalidateGeometry(): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
  /** Test/instrumentation: true when the last prepare rewrote the points buffer. */
  didRewritePointsLastPrepare(): boolean;
}

export interface BandRendererOptions {
  readonly targetFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly pipelineCache?: PipelineCache;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const parseSeriesColorToRgba01 = (color: string): Rgba => parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

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

function strokeEnabled(style: { width: number; opacity: number } | undefined | null): boolean {
  if (!style) return false;
  return style.width > 0 && style.opacity > 0;
}

export function createBandRenderer(device: GPUDevice, options?: BandRendererOptions): BandRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw) ? Math.max(1, Math.floor(sampleCountRaw)) : 1;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      },
    ],
  });

  // VSUniforms: mat4 (64) + pad/logBaseX/logBaseY/logFlags (16) = 80.
  const vsUniformBuffer = createUniformBuffer(device, 80, {
    label: 'bandRenderer/vsUniforms',
  });
  const fsUniformBuffer = createUniformBuffer(device, 16, {
    label: 'bandRenderer/fsUniforms',
  });

  const vsUniformScratchBuffer = new ArrayBuffer(80);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);
  const vsUniformScratchU32 = new Uint32Array(vsUniformScratchBuffer);
  const fsUniformScratchF32 = new Float32Array(4);

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'bandRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: bandWgsl,
        label: 'band.wgsl',
      },
      fragment: {
        code: bandWgsl,
        label: 'band.wgsl',
        formats: targetFormat,
        blend: {
          color: {
            operation: 'add',
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
          },
          alpha: {
            operation: 'add',
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha',
          },
        },
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  let privateBuffer: GPUBuffer | null = null;
  let boundDataBuffer: GPUBuffer | null = null;
  let currentBindGroup: GPUBindGroup | null = null;
  let pointCount = 0;
  let boundDataRef: BandSeriesData | null = null;
  let cachedBounds: {
    readonly xMin: number;
    readonly xMax: number;
    readonly yMin: number;
    readonly yMax: number;
  } | null = null;
  let cpuStaging = new Float32Array(0);
  let lastRewrotePoints = false;

  // Optional dual strokes — lazy LineRenderers (fill-only series skip allocation).
  let strokeYRenderer: LineRenderer | null = null;
  let strokeY1Renderer: LineRenderer | null = null;
  let strokeYBuffer: GPUBuffer | null = null;
  let strokeY1Buffer: GPUBuffer | null = null;
  let strokeStaging = new Float32Array(0);
  let drawStrokeY = false;
  let drawStrokeY1 = false;

  const ensureStrokeYRenderer = (): LineRenderer => {
    if (!strokeYRenderer) {
      strokeYRenderer = createLineRenderer(device, { targetFormat, pipelineCache, sampleCount });
    }
    return strokeYRenderer;
  };
  const ensureStrokeY1Renderer = (): LineRenderer => {
    if (!strokeY1Renderer) {
      strokeY1Renderer = createLineRenderer(device, { targetFormat, pipelineCache, sampleCount });
    }
    return strokeY1Renderer;
  };

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('BandRenderer is disposed.');
  };

  const ensureCpuStaging = (requiredFloats: number): void => {
    if (requiredFloats <= cpuStaging.length) return;
    cpuStaging = new Float32Array(Math.max(8, nextPow2(requiredFloats)));
  };

  const ensureStrokeStaging = (requiredFloats: number): void => {
    if (requiredFloats <= strokeStaging.length) return;
    strokeStaging = new Float32Array(Math.max(8, nextPow2(requiredFloats)));
  };

  const ensurePrivateBuffer = (requiredBytes: number): void => {
    const need = Math.max(4, requiredBytes);
    if (privateBuffer && privateBuffer.size >= need) return;
    const grown = Math.max(Math.max(4, nextPow2(need)), privateBuffer ? privateBuffer.size : 0);
    if (privateBuffer) {
      try {
        privateBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    privateBuffer = device.createBuffer({
      label: 'bandRenderer/privatePoints',
      size: grown,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  };

  const ensureStrokeBuffer = (which: 'y' | 'y1', requiredBytes: number): GPUBuffer => {
    const need = Math.max(4, requiredBytes);
    const current = which === 'y' ? strokeYBuffer : strokeY1Buffer;
    if (current && current.size >= need) return current;
    const grown = Math.max(Math.max(4, nextPow2(need)), current ? current.size : 0);
    if (current) {
      try {
        current.destroy();
      } catch {
        // best-effort
      }
    }
    const buf = device.createBuffer({
      label: which === 'y' ? 'bandRenderer/strokeY' : 'bandRenderer/strokeY1',
      size: grown,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
    });
    if (which === 'y') strokeYBuffer = buf;
    else strokeY1Buffer = buf;
    return buf;
  };

  const bindStorage = (buffer: GPUBuffer): void => {
    if (currentBindGroup && boundDataBuffer === buffer) return;
    currentBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: vsUniformBuffer } },
        { binding: 1, resource: { buffer: fsUniformBuffer } },
        { binding: 2, resource: { buffer } },
      ],
    });
    boundDataBuffer = buffer;
  };

  let lastAx = Number.NaN;
  let lastBx = Number.NaN;
  let lastAy = Number.NaN;
  let lastBy = Number.NaN;
  let lastLogFlags = 0;
  let lastLogBaseX = Number.NaN;
  let lastLogBaseY = Number.NaN;
  let lastFsR = Number.NaN;
  let lastFsG = Number.NaN;
  let lastFsB = Number.NaN;
  let lastFsA = Number.NaN;

  const writeVsUniforms = (
    ax: number,
    bx: number,
    ay: number,
    by: number,
    logFlags: number,
    logBaseX: number,
    logBaseY: number
  ): void => {
    const dirty =
      lastAx !== ax ||
      lastBx !== bx ||
      lastAy !== ay ||
      lastBy !== by ||
      lastLogFlags !== logFlags ||
      lastLogBaseX !== logBaseX ||
      lastLogBaseY !== logBaseY;
    if (!dirty) return;
    writeTransformMat4F32(vsUniformScratchF32, ax, bx, ay, by);
    vsUniformScratchF32[16] = 0; // pad (was baseline on area)
    vsUniformScratchF32[17] = logBaseX;
    vsUniformScratchF32[18] = logBaseY;
    vsUniformScratchU32[19] = logFlags >>> 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
    lastAx = ax;
    lastBx = bx;
    lastAy = ay;
    lastBy = by;
    lastLogFlags = logFlags;
    lastLogBaseX = logBaseX;
    lastLogBaseY = logBaseY;
  };

  const makeStrokeLineConfig = (
    seriesConfig: ResolvedBandSeriesConfig,
    which: 'y' | 'y1'
  ): ResolvedLineSeriesConfig => {
    const style = (which === 'y' ? seriesConfig.lineStyle : seriesConfig.lineStyleY1)!;
    return {
      type: 'line',
      name: seriesConfig.name,
      color: style.color,
      lineStyle: style,
      sampling: 'none',
      samplingThreshold: seriesConfig.samplingThreshold,
      connectNulls: seriesConfig.connectNulls,
      data: [],
      rawData: [],
      yAxis: seriesConfig.yAxis,
      visible: seriesConfig.visible,
    };
  };

  const prepare: BandRenderer['prepare'] = (
    seriesConfig,
    data,
    xScale,
    yScale,
    devicePixelRatio = 1,
    canvasWidthDevicePx,
    canvasHeightDevicePx
  ) => {
    assertNotDisposed();
    lastRewrotePoints = false;

    const source = seriesConfig.connectNulls ? filterBandGaps(data) : data;
    const n = getBandLength(source);

    const wantStrokeY = strokeEnabled(seriesConfig.lineStyle);
    const wantStrokeY1 = strokeEnabled(seriesConfig.lineStyleY1);

    // Identity cache: re-pack when data ref or length changes.
    if (boundDataRef !== data || n !== pointCount) {
      ensureCpuStaging(n * 4);
      packBandPoints(source, cpuStaging, n);
      const requiredBytes = Math.max(4, n * 16);
      ensurePrivateBuffer(requiredBytes);
      if (n > 0 && privateBuffer) {
        device.queue.writeBuffer(privateBuffer, 0, cpuStaging.buffer, cpuStaging.byteOffset, n * 16);
      }
      pointCount = n;
      boundDataRef = data;
      lastRewrotePoints = true;

      const fromSeries = seriesConfig.rawBounds;
      cachedBounds = fromSeries ?? bandBounds(source) ?? null;
    }

    drawStrokeY = wantStrokeY;
    drawStrokeY1 = wantStrokeY1;
    // Pack stroke buffers when enabled and missing (data change or first enable).
    if ((drawStrokeY || drawStrokeY1) && n > 0) {
      const needY = drawStrokeY && (!strokeYBuffer || lastRewrotePoints);
      const needY1 = drawStrokeY1 && (!strokeY1Buffer || lastRewrotePoints);
      if (needY || needY1) {
        ensureStrokeStaging(n * 2);
        if (needY) {
          packBandStrokeXY(source, strokeStaging, 0, n);
          const buf = ensureStrokeBuffer('y', n * 8);
          device.queue.writeBuffer(buf, 0, strokeStaging.buffer, strokeStaging.byteOffset, n * 8);
        }
        if (needY1) {
          packBandStrokeXY(source, strokeStaging, 1, n);
          const buf = ensureStrokeBuffer('y1', n * 8);
          device.queue.writeBuffer(buf, 0, strokeStaging.buffer, strokeStaging.byteOffset, n * 8);
        }
      }
    }

    if (privateBuffer) {
      bindStorage(privateBuffer);
    }

    const { xMin, xMax, yMin, yMax } = cachedBounds ?? {
      xMin: 0,
      xMax: 1,
      yMin: 0,
      yMax: 1,
    };
    const { a: ax, b: bx } =
      xScale.kind === 'log'
        ? computeClipAffineFromContinuousScale(xScale)
        : computeClipAffineFromScale(xScale, xMin, xMax);
    const { a: ay, b: by } =
      yScale.kind === 'log'
        ? computeClipAffineFromContinuousScale(yScale)
        : computeClipAffineFromScale(yScale, yMin, yMax);
    const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);
    writeVsUniforms(ax, bx, ay, by, logFlags, logBaseX, logBaseY);

    const [r, g, b, a] = parseSeriesColorToRgba01(seriesConfig.areaStyle.color);
    const opacity = clamp01(seriesConfig.areaStyle.opacity);
    const fa = clamp01(a * opacity);
    if (lastFsR !== r || lastFsG !== g || lastFsB !== b || lastFsA !== fa) {
      fsUniformScratchF32[0] = r;
      fsUniformScratchF32[1] = g;
      fsUniformScratchF32[2] = b;
      fsUniformScratchF32[3] = fa;
      writeUniformBuffer(device, fsUniformBuffer, fsUniformScratchF32);
      lastFsR = r;
      lastFsG = g;
      lastFsB = b;
      lastFsA = fa;
    }

    // Prepare strokes every frame (uniforms follow zoom).
    if (drawStrokeY && strokeYBuffer && pointCount >= 2) {
      ensureStrokeYRenderer().prepare(
        makeStrokeLineConfig(seriesConfig, 'y'),
        strokeYBuffer,
        xScale,
        yScale,
        0,
        devicePixelRatio,
        canvasWidthDevicePx,
        canvasHeightDevicePx,
        pointCount,
        1,
        { start: 0, capacity: 0 },
        true
      );
    }
    if (drawStrokeY1 && strokeY1Buffer && pointCount >= 2) {
      ensureStrokeY1Renderer().prepare(
        makeStrokeLineConfig(seriesConfig, 'y1'),
        strokeY1Buffer,
        xScale,
        yScale,
        0,
        devicePixelRatio,
        canvasWidthDevicePx,
        canvasHeightDevicePx,
        pointCount,
        1,
        { start: 0, capacity: 0 },
        true
      );
    }
  };

  const invalidateGeometry: BandRenderer['invalidateGeometry'] = () => {
    boundDataRef = null;
    cachedBounds = null;
  };

  const render: BandRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (currentBindGroup && pointCount >= 2) {
      const segments = pointCount - 1;
      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, currentBindGroup);
      passEncoder.draw(6, segments);
    }
    // Strokes after fill (same series).
    if (drawStrokeY && pointCount >= 2 && strokeYRenderer) {
      strokeYRenderer.render(passEncoder);
    }
    if (drawStrokeY1 && pointCount >= 2 && strokeY1Renderer) {
      strokeY1Renderer.render(passEncoder);
    }
  };

  const dispose: BandRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;
    boundDataRef = null;
    cachedBounds = null;
    currentBindGroup = null;
    boundDataBuffer = null;
    pointCount = 0;
    cpuStaging = new Float32Array(0);
    strokeStaging = new Float32Array(0);

    strokeYRenderer?.dispose();
    strokeY1Renderer?.dispose();
    strokeYRenderer = null;
    strokeY1Renderer = null;

    for (const buf of [privateBuffer, strokeYBuffer, strokeY1Buffer, vsUniformBuffer, fsUniformBuffer]) {
      if (!buf) continue;
      try {
        buf.destroy();
      } catch {
        // best-effort
      }
    }
    privateBuffer = null;
    strokeYBuffer = null;
    strokeY1Buffer = null;
  };

  const didRewritePointsLastPrepare: BandRenderer['didRewritePointsLastPrepare'] = () => lastRewrotePoints;

  return { prepare, invalidateGeometry, render, dispose, didRewritePointsLastPrepare };
}
