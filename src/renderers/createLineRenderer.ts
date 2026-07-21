import lineWgsl from '../shaders/line.wgsl?raw';
import type { ResolvedLineSeriesConfig } from '../config/OptionResolver';
import type { ContinuousScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { getPointCount, getX, getY, isStagingRingView, isRingXYColumns } from '../data/cartesianData';
import type { CartesianSeriesData } from '../config/types';
import type { PipelineCache } from '../core/PipelineCache';
import { resolveLineDrawPolicy, type LineDrawPolicy } from './lineDrawPolicy';
import { resolveDenseDrawStride } from './denseDrawLod';
import {
  computeClipAffineFromContinuousScale,
  computePackedXAffineFromScale,
  resolveLogProjection,
} from './packedXAffine';

export interface LineRenderer {
  /**
   * Prepare uniforms + bind groups for the next frame's draw.
   *
   * @param pointCountOverride - Optional explicit point count. When supplied,
   *   overrides the count derived from `seriesConfig.data`. Used by the GPU
   *   compute-decimation path where the bound `dataBuffer` holds decimated
   *   output whose length is not reflected in `seriesConfig.data`.
   */
  prepare(
    seriesConfig: ResolvedLineSeriesConfig,
    dataBuffer: GPUBuffer,
    xScale: ContinuousScale,
    yScale: ContinuousScale,
    xOffset?: number,
    devicePixelRatio?: number,
    canvasWidthDevicePx?: number,
    canvasHeightDevicePx?: number,
    pointCountOverride?: number,
    /**
     * Visible line series count for multi-series hairline budget
     * ({@link resolveLineDrawPolicy} / group 1).
     */
    lineSeriesCount?: number,
    /**
     * Modular ring layout when `dataBuffer` is DataStore raw storage after FIFO
     * wrap. Logical instance `i` maps to physical `(ringStart + i) % ringCapacity`
     * in `line.wgsl` (matches decimation). Omit or pass `ringCapacity: 0` for
     * linear / decimated chronological buffers.
     */
    ringLayout?: Readonly<{ start: number; capacity: number }>,
    /**
     * Force standard AA quads (honor configured line width) when true — used by
     * `performance.lod: 'strict'`. When false/omitted, dense hairline policy applies.
     */
    forceStandardDraw?: boolean,
    /**
     * Plot width in device pixels for dense multi-M hairline segment budget.
     * When omitted, falls back to canvas width (slightly more segments).
     * Share with area fill LOD so mountain stroke/fill stride stay aligned.
     */
    plotWidthDevicePx?: number
  ): void;
  /**
   * Drop identity-cached dense compact geometry so the next prepare re-packs.
   * Required when update animation mutates series values under a stable data ref
   * (same contract as area / scatter `invalidateGeometry`).
   */
  invalidateGeometry(): void;
  /**
   * Draw into the **main** MSAA pass. Dense hairline series are deferred
   * ({@link isDenseHairline}) and must be drawn with {@link renderHairline}
   * into a sampleCount:1 load-pass on the resolved main texture.
   */
  render(passEncoder: GPURenderPassEncoder): void;
  /**
   * True when the last prepare selected dense hairline (line-list @ 1 device px).
   * Main-pass `render` is a no-op for these; draw via {@link renderHairline}.
   */
  isDenseHairline(): boolean;
  /**
   * Draw dense hairline into a **single-sample** pass (sampleCount 1) on the
   * resolved main color. No-op when the last prepare was standard AA quads.
   *
   * @param options.skipSetPipeline - When true, assumes the hairline pipeline
   *   is already bound (multi-series batch: set once, then N draw calls).
   */
  renderHairline(passEncoder: GPURenderPassEncoder, options?: Readonly<{ skipSetPipeline?: boolean }>): void;
  /**
   * Bind the dense-hairline pipeline (for multi-series batching).
   * Safe to call even when this instance is not hairline this frame.
   */
  bindHairlinePipeline(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface LineRendererOptions {
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
   * Opt-in only: if omitted, behavior is identical to the uncached path.
   */
  readonly pipelineCache?: PipelineCache;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_LINE_WIDTH_CSS_PX = 2;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const parseSeriesColorToRgba01 = (color: string): Rgba => parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const writeTransformMat4F32 = (out: Float32Array, ax: number, bx: number, ay: number, by: number): void => {
  // Column-major mat4x4 for: clip = M * vec4(x, y, 0, 1)
  out[0] = ax;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0; // col0
  out[4] = 0;
  out[5] = ay;
  out[6] = 0;
  out[7] = 0; // col1
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0; // col2
  out[12] = bx;
  out[13] = by;
  out[14] = 0;
  out[15] = 1; // col3
};

/** Shared bind-group layouts per device — avoid N layouts for N multi-series lines (group 1). */
const lineBindGroupLayoutByDevice = new WeakMap<GPUDevice, GPUBindGroupLayout>();

function getLineBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  let layout = lineBindGroupLayoutByDevice.get(device);
  if (layout) return layout;
  layout = device.createBindGroupLayout({
    label: 'lineRenderer/bindGroupLayout',
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
  lineBindGroupLayoutByDevice.set(device, layout);
  return layout;
}

/**
 * Line renderers use a **private** VS uniform buffer with dirty-skip.
 * Device-global shared VS was removed: multi-chart deferred submit made shared
 * buffers unsafe across charts on one GPUDevice.
 */

export function createLineRenderer(device: GPUDevice, options?: LineRendererOptions): LineRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw) ? Math.max(1, Math.floor(sampleCountRaw)) : 1;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = getLineBindGroupLayout(device);

  // VS uniforms: mat4x4 (64) + canvasSize (8) + dpr (4) + lineWidthCssPx (4)
  // + ringStart/ringCapacity (8) + logBaseX/logBaseY (8) + logFlags (4)
  // + lodStride/lastPointIndex/pad (12) = 112.
  const vsUniformBuffer = createUniformBuffer(device, 112, {
    label: 'lineRenderer/vsUniforms',
  });
  const fsUniformBuffer = createUniformBuffer(device, 16, {
    label: 'lineRenderer/fsUniforms',
  });

  // Reused CPU-side staging for uniform writes (avoid per-frame allocations).
  const vsUniformScratchBuffer = new ArrayBuffer(112);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);
  const vsUniformScratchU32 = new Uint32Array(vsUniformScratchBuffer);
  const fsUniformScratchF32 = new Float32Array(4);

  // Bind group is cached by the current `dataBuffer` reference. A new bind group is created only
  // when the buffer identity changes (e.g. DataStore reallocates on growth). `queue.writeBuffer`
  // updates to the same buffer reuse the existing bind group — no per-frame createBindGroup churn.
  let currentBindGroup: GPUBindGroup | null = null;
  let boundDataBuffer: GPUBuffer | null = null;

  // Issue 2.5: skip uniform writes when affine/color/width/signature unchanged.
  let lastFsR = Number.NaN;
  let lastFsG = Number.NaN;
  let lastFsB = Number.NaN;
  let lastFsA = Number.NaN;
  let lastColorKey: string | null = null;
  let lastBaseR = Number.NaN;
  let lastBaseG = Number.NaN;
  let lastBaseB = Number.NaN;
  let lastBaseA = Number.NaN;
  let lastAx = Number.NaN;
  let lastBx = Number.NaN;
  let lastAy = Number.NaN;
  let lastBy = Number.NaN;
  let lastCanvasW = Number.NaN;
  let lastCanvasH = Number.NaN;
  let lastDpr = Number.NaN;
  let lastLineWidth = Number.NaN;
  let lastRingStart = 0;
  let lastRingCapacity = 0;
  let lastLogFlags = 0;
  let lastLogBaseX = Number.NaN;
  let lastLogBaseY = Number.NaN;
  let lastLodStride = -1;
  let lastLastPointIndex = -1;
  /** Which VS buffer is currently referenced by currentBindGroup. */
  let boundVsBuffer: GPUBuffer = vsUniformBuffer;

  const blendState: GPUBlendState = {
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
  };

  // Standard path: screen-space AA quads (6 verts/segment).
  const pipeline = createRenderPipeline(
    device,
    {
      label: 'lineRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: lineWgsl,
        label: 'line.wgsl',
        buffers: [], // No vertex buffers — points are read from storage buffer.
      },
      fragment: {
        code: lineWgsl,
        label: 'line.wgsl',
        formats: targetFormat,
        // Enable standard alpha blending so per-series `lineStyle.opacity` and AA transparency work.
        blend: blendState,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  // Dense hairline: native line-list (2 verts/segment, 1 device px). Group 3 ≥25k cliff.
  // Always sampleCount **1** — drawn in a post-resolve single-sample pass so 50k
  // segments do not pay 4× MSAA overdraw (main AA-quad path stays at `sampleCount`).
  const hairlinePipeline = createRenderPipeline(
    device,
    {
      label: 'lineRenderer/hairlinePipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: lineWgsl,
        label: 'line.wgsl',
        entryPoint: 'vsMainHairline',
        buffers: [],
      },
      fragment: {
        code: lineWgsl,
        label: 'line.wgsl',
        entryPoint: 'fsMainHairline',
        formats: targetFormat,
        blend: blendState,
      },
      primitive: { topology: 'line-list', cullMode: 'none' },
      multisample: { count: 1 },
    },
    pipelineCache
  );

  let currentPointCount = 0;
  let currentDrawPolicy: LineDrawPolicy = 'standard';
  /** Drawn segment instances (may be ≪ N−1 under dense hairline LOD). */
  let currentDrawSegmentCount = 0;
  let currentLodStride = 1;
  let currentLastPointIndex = 0;

  // Compact draw buffer for multi-M dense hairline (bind ~plot-width points, not full N).
  let lodPrivateBuffer: GPUBuffer | null = null;
  let lodCpuStaging = new Float32Array(0);
  let lodCompactPointCount = 0;
  let lodCompactStride = 0;
  let lodCompactDataRef: unknown = null;
  let lodCompactSourceN = 0;
  let lodCompactXOffset = Number.NaN;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('LineRenderer is disposed.');
  };

  const ensureLodStaging = (floats: number): void => {
    if (floats <= lodCpuStaging.length) return;
    let n = 8;
    while (n < floats) n *= 2;
    lodCpuStaging = new Float32Array(n);
  };

  const ensureLodBuffer = (bytes: number): void => {
    const need = Math.max(4, bytes);
    if (lodPrivateBuffer && lodPrivateBuffer.size >= need) return;
    if (lodPrivateBuffer) {
      try {
        lodPrivateBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    let grown = 256;
    while (grown < need) grown *= 2;
    lodPrivateBuffer = device.createBuffer({
      label: 'lineRenderer/lodCompactPoints',
      size: grown,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  };

  /**
   * Pack dense-hairline subsample into a compact private buffer and bind it.
   * Returns the buffer to use for draw (compact or original).
   */
  const tryCompactHairlineLod = (
    seriesData: CartesianSeriesData | undefined,
    fullBuffer: GPUBuffer,
    n: number,
    stride: number,
    xOffset: number
  ): GPUBuffer => {
    if (stride <= 1 || n < 2 || seriesData == null) return fullBuffer;
    // Ring/staging mutates under stable identity — keep full buffer + VS stride
    // (mirrors area `tryBindCompactLod`; chronological pack would be stale).
    if (isStagingRingView(seriesData) || isRingXYColumns(seriesData)) return fullBuffer;
    const cacheHit =
      lodCompactDataRef === seriesData &&
      lodCompactSourceN === n &&
      lodCompactStride === stride &&
      lodCompactXOffset === xOffset &&
      lodCompactPointCount >= 2 &&
      lodPrivateBuffer != null;
    if (!cacheHit) {
      const last = n - 1;
      const maxPts = Math.ceil(last / stride) + 1;
      ensureLodStaging(maxPts * 2);
      let o = 0;
      for (let i = 0; i < last; i += stride) {
        const x = getX(seriesData, i);
        const y = getY(seriesData, i);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          lodCpuStaging[o * 2] = Number.NaN;
          lodCpuStaging[o * 2 + 1] = Number.NaN;
        } else {
          lodCpuStaging[o * 2] = xOffset !== 0 ? x - xOffset : x;
          lodCpuStaging[o * 2 + 1] = y;
        }
        o++;
      }
      const xL = getX(seriesData, last);
      const yL = getY(seriesData, last);
      if (!Number.isFinite(xL) || !Number.isFinite(yL)) {
        lodCpuStaging[o * 2] = Number.NaN;
        lodCpuStaging[o * 2 + 1] = Number.NaN;
      } else {
        lodCpuStaging[o * 2] = xOffset !== 0 ? xL - xOffset : xL;
        lodCpuStaging[o * 2 + 1] = yL;
      }
      o++;
      ensureLodBuffer(o * 8);
      if (lodPrivateBuffer && o > 0) {
        device.queue.writeBuffer(lodPrivateBuffer, 0, lodCpuStaging.buffer, lodCpuStaging.byteOffset, o * 8);
      }
      lodCompactPointCount = o;
      lodCompactStride = stride;
      lodCompactDataRef = seriesData;
      lodCompactSourceN = n;
      lodCompactXOffset = xOffset;
    }
    if (!lodPrivateBuffer || lodCompactPointCount < 2) return fullBuffer;
    // Compact is chronological unit-stride; clear ring remap for this draw.
    currentLodStride = 1;
    currentLastPointIndex = lodCompactPointCount - 1;
    currentDrawSegmentCount = lodCompactPointCount - 1;
    return lodPrivateBuffer;
  };

  const prepare: LineRenderer['prepare'] = (
    seriesConfig,
    dataBuffer,
    xScale,
    yScale,
    xOffset = 0,
    devicePixelRatio = 1,
    canvasWidthDevicePx = 1,
    canvasHeightDevicePx = 1,
    pointCountOverride,
    lineSeriesCount,
    ringLayout,
    forceStandardDraw,
    plotWidthDevicePx
  ) => {
    assertNotDisposed();

    currentPointCount =
      typeof pointCountOverride === 'number' && Number.isFinite(pointCountOverride) && pointCountOverride >= 0
        ? Math.floor(pointCountOverride)
        : getPointCount(seriesConfig.data);

    // X: packed-origin affine (stable for epoch-ms time axes; log X uses log-space affine).
    // Y: linear samples (0,1); log Y solves affine in log space (never sample raw 0,1 on log).
    const { a: ax, b: bxPacked } = computePackedXAffineFromScale(xScale, xOffset);
    const { a: ay, b: by } = computeClipAffineFromContinuousScale(yScale);
    const { logFlags, logBaseX, logBaseY } = resolveLogProjection(xScale, yScale);

    // Write VS uniforms: mat4x4 (16 floats) + canvasSize (2 floats) + dpr (1 float)
    // + lineWidth (1 float) + ringStart/ringCapacity + logBaseX/Y + logFlags + lod.
    writeTransformMat4F32(vsUniformScratchF32, ax, bxPacked, ay, by);
    const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const canvasW = Number.isFinite(canvasWidthDevicePx) && canvasWidthDevicePx > 0 ? canvasWidthDevicePx : 1;
    const canvasH = Number.isFinite(canvasHeightDevicePx) && canvasHeightDevicePx > 0 ? canvasHeightDevicePx : 1;
    const nominalLineWidthCss =
      Number.isFinite(seriesConfig.lineStyle.width) && seriesConfig.lineStyle.width > 0
        ? seriesConfig.lineStyle.width
        : DEFAULT_LINE_WIDTH_CSS_PX;
    // Dense full-rewrite (group 3) + multi-series fill cliff (group 1): switch to
    // line-list hairline only when main MSAA is 4× (see lineDrawPolicy).
    // `forceStandardDraw` (performance.lod: 'strict') always honors configured width.
    const drawPolicy = resolveLineDrawPolicy({
      pointCount: currentPointCount,
      lineWidthCssPx: nominalLineWidthCss,
      lineSeriesCount,
      msaaSampleCount: sampleCount,
      forceStandard: forceStandardDraw === true,
    });
    currentDrawPolicy = drawPolicy.policy;
    const lineWidthCss = drawPolicy.effectiveLineWidthCssPx;

    // Multi-M hairline (mountain stroke / unsorted): cap drawn segments toward a
    // plot-width budget under lod:auto (shared with area fill). Canvas width is
    // the fallback when plot width is omitted (slightly more segments).
    const plotWForLod =
      Number.isFinite(plotWidthDevicePx) && (plotWidthDevicePx as number) > 0
        ? Math.floor(plotWidthDevicePx as number)
        : canvasW;
    const denseStride = resolveDenseDrawStride({
      pointCount: currentPointCount,
      plotWidthDevicePx: plotWForLod,
      // Only stride when already on the dense hairline path (or forceStandard).
      forceStandard: forceStandardDraw === true || drawPolicy.policy !== 'denseHairline',
    });
    currentLodStride = denseStride.stride;
    currentDrawSegmentCount = denseStride.drawSegmentCount;
    currentLastPointIndex = denseStride.lastPointIndex;

    // Modular ring: remap when capacity > 0. start may be 0 during pre-wrap fill
    // (identity map) or after wrap (oldest physical index). Match getSeriesRingLayout:
    // capacity 0 → linear; capacity > 0 → floor(start) with start >= 0.
    let ringCapacity =
      ringLayout && Number.isFinite(ringLayout.capacity) && ringLayout.capacity > 0
        ? Math.floor(ringLayout.capacity)
        : 0;
    let ringStart =
      ringCapacity > 0 && ringLayout && Number.isFinite(ringLayout.start) && ringLayout.start >= 0
        ? Math.floor(ringLayout.start)
        : 0;

    // Dense multi-M hairline: compact private buffer (unit stride, no ring) so the
    // stroke path does not keep multi-M storage hot (group 8 mountain).
    let drawDataBuffer = dataBuffer;
    if (drawPolicy.policy === 'denseHairline' && denseStride.stride > 1 && ringCapacity === 0) {
      drawDataBuffer = tryCompactHairlineLod(
        seriesConfig.data as CartesianSeriesData | undefined,
        dataBuffer,
        currentPointCount,
        denseStride.stride,
        xOffset
      );
      if (drawDataBuffer !== dataBuffer) {
        // Compact buffer is linear chronological — disable ring remap.
        ringCapacity = 0;
        ringStart = 0;
      }
    }

    vsUniformScratchF32[16] = canvasW;
    vsUniformScratchF32[17] = canvasH;
    vsUniformScratchF32[18] = dpr;
    vsUniformScratchF32[19] = lineWidthCss;
    // u32 ring fields at byte offset 80 (float index 20); log bases + flags + lod follow.
    vsUniformScratchU32[20] = ringStart >>> 0;
    vsUniformScratchU32[21] = ringCapacity >>> 0;
    vsUniformScratchF32[22] = logBaseX;
    vsUniformScratchF32[23] = logBaseY;
    vsUniformScratchU32[24] = logFlags >>> 0;
    vsUniformScratchU32[25] = currentLodStride >>> 0;
    vsUniformScratchU32[26] = currentLastPointIndex >>> 0;
    vsUniformScratchU32[27] = 0;

    // Private VS only (multi-chart deferred-submit safe). Dirty-skip when affine /
    // size / width / ring layout / log projection / lod unchanged (issue 2.5) — covers
    // axes-only ticks without a device-global shared buffer that multi-chart slots would clobber.
    let vsBufferForBind: GPUBuffer = vsUniformBuffer;
    {
      const vsDirty =
        lastAx !== ax ||
        lastBx !== bxPacked ||
        lastAy !== ay ||
        lastBy !== by ||
        lastCanvasW !== canvasW ||
        lastCanvasH !== canvasH ||
        lastDpr !== dpr ||
        lastLineWidth !== lineWidthCss ||
        lastRingStart !== ringStart ||
        lastRingCapacity !== ringCapacity ||
        lastLogFlags !== logFlags ||
        lastLogBaseX !== logBaseX ||
        lastLogBaseY !== logBaseY ||
        lastLodStride !== currentLodStride ||
        lastLastPointIndex !== currentLastPointIndex;
      if (vsDirty) {
        writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
        lastAx = ax;
        lastBx = bxPacked;
        lastAy = ay;
        lastBy = by;
        lastCanvasW = canvasW;
        lastCanvasH = canvasH;
        lastDpr = dpr;
        lastLineWidth = lineWidthCss;
        lastRingStart = ringStart;
        lastRingCapacity = ringCapacity;
        lastLogFlags = logFlags;
        lastLogBaseX = logBaseX;
        lastLogBaseY = logBaseY;
        lastLodStride = currentLodStride;
        lastLastPointIndex = currentLastPointIndex;
      }
    }

    // Color parse is relatively expensive (CSS string); cache base RGBA by color key.
    const colorKey = seriesConfig.color;
    const opacity = clamp01(seriesConfig.lineStyle.opacity);
    if (lastColorKey !== colorKey) {
      const [pr, pg, pb, pa] = parseSeriesColorToRgba01(colorKey);
      lastBaseR = pr;
      lastBaseG = pg;
      lastBaseB = pb;
      lastBaseA = pa;
      lastColorKey = colorKey;
    }
    const r = lastBaseR;
    const g = lastBaseG;
    const b = lastBaseB;
    const fa = clamp01(lastBaseA * opacity);
    // `fa` already folds opacity; no separate lastOpacity key.
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

    // Rebuild bind group when data buffer or VS buffer (shared vs private) changes.
    if (currentBindGroup === null || boundDataBuffer !== drawDataBuffer || boundVsBuffer !== vsBufferForBind) {
      currentBindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: vsBufferForBind } },
          { binding: 1, resource: { buffer: fsUniformBuffer } },
          { binding: 2, resource: { buffer: drawDataBuffer } },
        ],
      });
      boundDataBuffer = drawDataBuffer;
      boundVsBuffer = vsBufferForBind;
    }
  };

  const isDenseHairlinePolicy = (): boolean => currentDrawPolicy === 'denseHairline';

  const invalidateGeometry: LineRenderer['invalidateGeometry'] = () => {
    // Drop compact LOD identity cache so in-place mutation (animation) re-packs.
    lodCompactPointCount = 0;
    lodCompactDataRef = null;
    lodCompactSourceN = 0;
    lodCompactStride = 0;
    lodCompactXOffset = Number.NaN;
  };

  const render: LineRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    // Need at least 2 points to form 1 segment.
    if (!currentBindGroup || currentPointCount < 2 || currentDrawSegmentCount < 1) return;
    // Dense hairline is deferred to the single-sample post-resolve pass.
    if (isDenseHairlinePolicy()) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, currentBindGroup);
    // 6 vertices per instance (quad); standard path keeps stride 1 → N−1 segments.
    passEncoder.draw(6, currentDrawSegmentCount);
  };

  const isDenseHairline: LineRenderer['isDenseHairline'] = () => {
    assertNotDisposed();
    return isDenseHairlinePolicy() && currentPointCount >= 2 && currentBindGroup != null;
  };

  const bindHairlinePipeline: LineRenderer['bindHairlinePipeline'] = (passEncoder) => {
    assertNotDisposed();
    passEncoder.setPipeline(hairlinePipeline);
  };

  const renderHairline: LineRenderer['renderHairline'] = (passEncoder, options) => {
    assertNotDisposed();
    if (!isDenseHairlinePolicy() || !currentBindGroup || currentPointCount < 2 || currentDrawSegmentCount < 1) {
      return;
    }
    if (!options?.skipSetPipeline) {
      passEncoder.setPipeline(hairlinePipeline);
    }
    passEncoder.setBindGroup(0, currentBindGroup);
    // Native 1 device-px stroke: 2 verts/instance (line-list), sampleCount 1 pass.
    // Multi-M dense LOD may draw ≪ N−1 instances (pixel-budget stride).
    passEncoder.draw(2, currentDrawSegmentCount);
  };

  const dispose: LineRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    currentBindGroup = null;
    boundDataBuffer = null;
    currentPointCount = 0;
    currentDrawSegmentCount = 0;
    currentLodStride = 1;
    currentLastPointIndex = 0;
    currentDrawPolicy = 'standard';
    lodCompactPointCount = 0;
    lodCompactDataRef = null;
    lodCompactSourceN = 0;
    lodCompactStride = 0;
    lodCompactXOffset = Number.NaN;
    lodCpuStaging = new Float32Array(0);
    if (lodPrivateBuffer) {
      try {
        lodPrivateBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    lodPrivateBuffer = null;

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

  return { prepare, invalidateGeometry, render, isDenseHairline, renderHairline, bindHairlinePipeline, dispose };
}
