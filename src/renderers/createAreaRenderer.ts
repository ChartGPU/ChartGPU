import areaWgsl from '../shaders/area.wgsl?raw';
import type { ResolvedAreaSeriesConfig } from '../config/OptionResolver';
import type { CartesianSeriesData } from '../config/types';
import type { ContinuousScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import {
  getPointCount,
  getX,
  getY,
  computeRawBoundsFromCartesianData,
  isStagingRingView,
  isRingXYColumns,
} from '../data/cartesianData';
import type { PipelineCache } from '../core/PipelineCache';
import {
  computeClipAffineFromContinuousScale,
  computeClipAffineFromScale,
  computePackedXAffineFromScale,
  resolveLogProjection,
} from './packedXAffine';

export interface AreaRenderer {
  prepare(
    seriesConfig: ResolvedAreaSeriesConfig,
    data: CartesianSeriesData,
    xScale: ContinuousScale,
    yScale: ContinuousScale,
    baseline?: number,
    /**
     * Optional shared storage buffer (line / GPU decimation output). When set,
     * skips private pack+upload and binds this buffer (issue 1.4 step 3).
     */
    storageBuffer?: GPUBuffer,
    /**
     * Point count for `storageBuffer` (required when buffer is external /
     * decimated — length is not reflected in `data`).
     */
    pointCountOverride?: number,
    /**
     * X-origin subtracted during packing (time-axis Float32). Clip affine
     * samples near this origin: clipX = ax * x' + scale(xOffset).
     */
    xOffset?: number
  ): void;
  /**
   * Drop cached domain-space geometry so the next `prepare` re-packs vertices.
   *
   * Required when values mutate under a stable data array reference (update-transition
   * interpolation reuses one array and mutates in place — same rule as
   * `lastSetSeriesCache.clear()` in the coordinator).
   */
  invalidateGeometry(): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface AreaRendererOptions {
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

/**
 * Pack N domain points into staging (not expanded geometry). Shader expands
 * each segment `i → i+1` into a baseline trapezoid via instance_index + vertex_index
 * (issue 1.4 storage layout; issue #153 per-segment gap discard).
 * Null / non-finite points are written as NaN so the VS dual-endpoint check can
 * collapse only gap-spanning segments (matches packXYInto / line.wgsl).
 */
function packAreaPointsInto(out: Float32Array, data: CartesianSeriesData, pointCount: number): void {
  for (let i = 0; i < pointCount; i++) {
    const x = getX(data, i);
    const y = getY(data, i);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      out[i * 2] = Number.NaN;
      out[i * 2 + 1] = Number.NaN;
    } else {
      out[i * 2] = x;
      out[i * 2 + 1] = y;
    }
  }
}

export function createAreaRenderer(device: GPUDevice, options?: AreaRendererOptions): AreaRenderer {
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

  // VSUniforms: mat4 (64) + baseline/logBaseX/logBaseY/logFlags (16) = 80.
  const vsUniformBuffer = createUniformBuffer(device, 80, {
    label: 'areaRenderer/vsUniforms',
  });
  const fsUniformBuffer = createUniformBuffer(device, 16, {
    label: 'areaRenderer/fsUniforms',
  });

  const vsUniformScratchBuffer = new ArrayBuffer(80);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);
  const fsUniformScratchF32 = new Float32Array(4);

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'areaRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: areaWgsl,
        label: 'area.wgsl',
        // No vertex buffers — points come from storage (binding 2).
      },
      fragment: {
        code: areaWgsl,
        label: 'area.wgsl',
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
      // Instanced triangle-list: 6 verts × (N-1) segments (matches line AA path).
      // Per-segment topology allows dual-endpoint NaN discard without strip fans (#153).
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  /** Private storage buffer for pure-area series (not shared with line). */
  let privateBuffer: GPUBuffer | null = null;
  /** Bound storage for draw (private or external). */
  let boundDataBuffer: GPUBuffer | null = null;
  let currentBindGroup: GPUBindGroup | null = null;
  /** Logical point count (draw uses N-1 segment instances). */
  let pointCount = 0;
  // Geometry identity: reuse private pack when data ref stable (axes-only).
  let boundDataRef: CartesianSeriesData | null = null;
  let cachedBounds: {
    readonly xMin: number;
    readonly xMax: number;
    readonly yMin: number;
    readonly yMax: number;
  } | null = null;

  // Reusable CPU staging + geometric GPU capacity (issue 1.4 steps 1–2).
  let cpuStaging = new Float32Array(0);

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('AreaRenderer is disposed.');
  };

  const ensureCpuStaging = (requiredFloats: number): void => {
    if (requiredFloats <= cpuStaging.length) return;
    const next = Math.max(8, nextPow2(requiredFloats));
    cpuStaging = new Float32Array(next);
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
      label: 'areaRenderer/privatePoints',
      size: grown,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
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

  // Issue 2.5: skip uniform writes when affine/color/baseline/log unchanged.
  let lastAx = Number.NaN;
  let lastBx = Number.NaN;
  let lastAy = Number.NaN;
  let lastBy = Number.NaN;
  let lastBaseline = Number.NaN;
  let lastLogFlags = 0;
  let lastLogBaseX = Number.NaN;
  let lastLogBaseY = Number.NaN;
  let lastFsR = Number.NaN;
  let lastFsG = Number.NaN;
  let lastFsB = Number.NaN;
  let lastFsA = Number.NaN;
  const vsUniformScratchU32 = new Uint32Array(vsUniformScratchBuffer);

  const writeVsUniforms = (
    ax: number,
    bx: number,
    ay: number,
    by: number,
    baseline: number,
    logFlags: number,
    logBaseX: number,
    logBaseY: number
  ): void => {
    const dirty =
      lastAx !== ax ||
      lastBx !== bx ||
      lastAy !== ay ||
      lastBy !== by ||
      lastBaseline !== baseline ||
      lastLogFlags !== logFlags ||
      lastLogBaseX !== logBaseX ||
      lastLogBaseY !== logBaseY;
    if (!dirty) return;
    writeTransformMat4F32(vsUniformScratchF32, ax, bx, ay, by);
    vsUniformScratchF32[16] = baseline;
    vsUniformScratchF32[17] = logBaseX;
    vsUniformScratchF32[18] = logBaseY;
    vsUniformScratchU32[19] = logFlags >>> 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
    lastAx = ax;
    lastBx = bx;
    lastAy = ay;
    lastBy = by;
    lastBaseline = baseline;
    lastLogFlags = logFlags;
    lastLogBaseX = logBaseX;
    lastLogBaseY = logBaseY;
  };

  const prepare: AreaRenderer['prepare'] = (
    seriesConfig,
    data,
    xScale,
    yScale,
    baseline,
    storageBuffer,
    pointCountOverride,
    xOffset = 0
  ) => {
    assertNotDisposed();

    if (storageBuffer) {
      // Shared line / decimation path — no private pack (issue 1.4 step 3).
      // Require explicit point count: drawing raw N from a shorter decimation
      // buffer is undefined (review issue 8).
      if (typeof pointCountOverride !== 'number' || !Number.isFinite(pointCountOverride) || pointCountOverride < 0) {
        throw new Error(
          'AreaRenderer.prepare(storageBuffer): pointCountOverride must be a finite non-negative number.'
        );
      }
      pointCount = Math.floor(pointCountOverride);
      boundDataRef = null; // external ownership
      bindStorage(storageBuffer);

      // Packed-origin X affine (stable for epoch-ms); Y continuous (log-aware).
      const { a: ax, b: bxPacked } = computePackedXAffineFromScale(xScale, xOffset);
      const { a: ay, b: by } = computeClipAffineFromContinuousScale(yScale);
      const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);
      // Log Y: default baseline is domain min (positive), not 0.
      // Non-positive caller baselines are treated as unset on log (fill-to-zero invalid).
      const defaultBaseline = yScale.kind === 'log' ? yScale.getDomain().min : 0;
      const baselineValue =
        yScale.kind === 'log'
          ? Number.isFinite(baseline ?? Number.NaN) && (baseline as number) > 0
            ? (baseline as number)
            : defaultBaseline
          : Number.isFinite(baseline ?? Number.NaN)
            ? (baseline as number)
            : defaultBaseline;
      writeVsUniforms(ax, bxPacked, ay, by, baselineValue, logFlags, logBaseX, logBaseY);
    } else {
      // Private pack path with identity cache + pow2 growth.
      // Also re-pack when length changes under a stable ref (streaming append grows
      // owned XY columns in place; modular-ring fallback path uses this branch).
      // Staging/ring views reuse object identity with constant count while
      // start/staging floats mutate — always re-pack those (FIFO after wrap).
      const n = getPointCount(data);
      const ringOrStaging = isStagingRingView(data) || isRingXYColumns(data);
      if (boundDataRef !== data || n !== pointCount || ringOrStaging) {
        ensureCpuStaging(n * 2);
        packAreaPointsInto(cpuStaging, data, n);
        const requiredBytes = Math.max(4, n * 8);
        ensurePrivateBuffer(requiredBytes);
        if (n > 0 && privateBuffer) {
          device.queue.writeBuffer(privateBuffer, 0, cpuStaging.buffer, cpuStaging.byteOffset, n * 8);
        }
        pointCount = n;
        boundDataRef = data;

        const fromSeries = (seriesConfig as { readonly rawBounds?: typeof cachedBounds }).rawBounds;
        cachedBounds = fromSeries ?? computeRawBoundsFromCartesianData(data) ?? null;
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
      // Log axes: affine in transformed space. Linear: sample domain endpoints (parity).
      const { a: ax, b: bx } =
        xScale.kind === 'log'
          ? computeClipAffineFromContinuousScale(xScale)
          : computeClipAffineFromScale(xScale, xMin, xMax);
      const { a: ay, b: by } =
        yScale.kind === 'log'
          ? computeClipAffineFromContinuousScale(yScale)
          : computeClipAffineFromScale(yScale, yMin, yMax);
      const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);
      const fallbackBaseline = yScale.kind === 'log' ? yScale.getDomain().min : Number.isFinite(yMin) ? yMin : 0;
      // Log Y: non-positive baseline is unset (same guard as storageBuffer path).
      const baselineValue =
        yScale.kind === 'log'
          ? Number.isFinite(baseline ?? Number.NaN) && (baseline as number) > 0
            ? (baseline as number)
            : fallbackBaseline
          : Number.isFinite(baseline ?? Number.NaN)
            ? (baseline as number)
            : fallbackBaseline;
      writeVsUniforms(ax, bx, ay, by, baselineValue, logFlags, logBaseX, logBaseY);
    }

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
  };

  const invalidateGeometry: AreaRenderer['invalidateGeometry'] = () => {
    boundDataRef = null;
    cachedBounds = null;
  };

  const render: AreaRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    // Need ≥2 points → ≥1 segment instance for a non-empty fill.
    if (!currentBindGroup || pointCount < 2) return;

    const segments = pointCount - 1;
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, currentBindGroup);
    // 6 vertices per instance (trapezoid), (pointCount - 1) instances (segments).
    passEncoder.draw(6, segments);
  };

  const dispose: AreaRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;
    boundDataRef = null;
    cachedBounds = null;
    currentBindGroup = null;
    boundDataBuffer = null;
    pointCount = 0;
    cpuStaging = new Float32Array(0);

    if (privateBuffer) {
      try {
        privateBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    privateBuffer = null;

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
  };

  return { prepare, invalidateGeometry, render, dispose };
}
