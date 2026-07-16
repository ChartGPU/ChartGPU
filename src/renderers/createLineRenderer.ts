import lineWgsl from '../shaders/line.wgsl?raw';
import type { ResolvedLineSeriesConfig } from '../config/OptionResolver';
import type { LinearScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { getPointCount } from '../data/cartesianData';
import type { PipelineCache } from '../core/PipelineCache';
import { resolveLineDrawPolicy, type LineDrawPolicy } from './lineDrawPolicy';

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
    xScale: LinearScale,
    yScale: LinearScale,
    xOffset?: number,
    devicePixelRatio?: number,
    canvasWidthDevicePx?: number,
    canvasHeightDevicePx?: number,
    pointCountOverride?: number,
    /**
     * Visible line series count for multi-series hairline budget
     * ({@link resolveLineDrawPolicy} / group 1).
     */
    lineSeriesCount?: number
  ): void;
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
  renderHairline(
    passEncoder: GPURenderPassEncoder,
    options?: Readonly<{ skipSetPipeline?: boolean }>
  ): void;
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

const computeClipAffineFromScale = (
  scale: LinearScale,
  v0: number,
  v1: number
): { readonly a: number; readonly b: number } => {
  const p0 = scale.scale(v0);
  const p1 = scale.scale(v1);

  // If the domain sample is degenerate or non-finite, fall back to constant output.
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
 * Frame epoch for line prepare (group 1 multi-series bookkeeping).
 *
 * Historically a single **device-global shared VS uniform buffer** was claimed by
 * the first series each frame so equal-N multi-series could skip N−1 writeBuffers.
 * Multi-chart harnesses share one GPUDevice and defer `queue.submit` via
 * {@link enqueueDeviceSubmit}: chart B's prepare overwrote the shared buffer
 * while chart A's encoded CB still bound it → wrong/off-screen/faint strokes.
 *
 * Line renderers now always use their **private** VS buffer with dirty-skip
 * (issue 2.5). {@link beginLineSharedVsFrame} remains as a no-op epoch bump for
 * call-site compatibility and future per-command-buffer sharing if needed.
 */
let lineSharedVsFrameId = 0;

/**
 * Call once before preparing any line series in a frame.
 * Retained for API/call-site compatibility; VS sharing is disabled (see above).
 */
export function beginLineSharedVsFrame(_shareKey?: number): void {
  lineSharedVsFrameId++;
  void lineSharedVsFrameId;
}

export function createLineRenderer(device: GPUDevice, options?: LineRendererOptions): LineRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw) ? Math.max(1, Math.floor(sampleCountRaw)) : 1;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = getLineBindGroupLayout(device);

  // VS uniforms: mat4x4 (64) + canvasSize (8) + dpr (4) + lineWidthCssPx (4) = 80 bytes.
  const vsUniformBuffer = createUniformBuffer(device, 80, {
    label: 'lineRenderer/vsUniforms',
  });
  const fsUniformBuffer = createUniformBuffer(device, 16, {
    label: 'lineRenderer/fsUniforms',
  });

  // Reused CPU-side staging for uniform writes (avoid per-frame allocations).
  const vsUniformScratchBuffer = new ArrayBuffer(80);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);
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

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('LineRenderer is disposed.');
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
    lineSeriesCount
  ) => {
    assertNotDisposed();

    currentPointCount =
      typeof pointCountOverride === 'number' && Number.isFinite(pointCountOverride) && pointCountOverride >= 0
        ? Math.floor(pointCountOverride)
        : getPointCount(seriesConfig.data);

    // Linear scales: sample affine at (0, 1) instead of O(n) bounds scan.
    // Matches scatter / area / candlestick and is correct for any linear scale.
    const { a: ax, b: bx } = computeClipAffineFromScale(xScale, 0, 1);
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, 0, 1);

    // When the vertex buffer packs x as (x - xOffset) (to preserve Float32 precision for large
    // domains like epoch-ms), fold the offset back into the affine's intercept in f64 on CPU:
    // clipX = ax * (x - xOffset) + (bx + ax * xOffset)
    const bxAdjusted = bx + ax * xOffset;

    // Write VS uniforms: mat4x4 (16 floats) + canvasSize (2 floats) + dpr (1 float) + lineWidth (1 float).
    writeTransformMat4F32(vsUniformScratchF32, ax, bxAdjusted, ay, by);
    const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const canvasW = Number.isFinite(canvasWidthDevicePx) && canvasWidthDevicePx > 0 ? canvasWidthDevicePx : 1;
    const canvasH = Number.isFinite(canvasHeightDevicePx) && canvasHeightDevicePx > 0 ? canvasHeightDevicePx : 1;
    const nominalLineWidthCss =
      Number.isFinite(seriesConfig.lineStyle.width) && seriesConfig.lineStyle.width > 0
        ? seriesConfig.lineStyle.width
        : DEFAULT_LINE_WIDTH_CSS_PX;
    // Dense full-rewrite (group 3) + multi-series fill cliff (group 1): switch to
    // line-list hairline only when main MSAA is 4× (see lineDrawPolicy).
    const drawPolicy = resolveLineDrawPolicy({
      pointCount: currentPointCount,
      lineWidthCssPx: nominalLineWidthCss,
      lineSeriesCount,
      msaaSampleCount: sampleCount,
    });
    currentDrawPolicy = drawPolicy.policy;
    const lineWidthCss = drawPolicy.effectiveLineWidthCssPx;

    vsUniformScratchF32[16] = canvasW;
    vsUniformScratchF32[17] = canvasH;
    vsUniformScratchF32[18] = dpr;
    vsUniformScratchF32[19] = lineWidthCss;

    // Private VS only (multi-chart deferred-submit safe). Dirty-skip when affine /
    // size / width unchanged (issue 2.5) — covers axes-only ticks without a
    // device-global shared buffer that multi-chart slots would clobber.
    let vsBufferForBind: GPUBuffer = vsUniformBuffer;
    {
      const vsDirty =
        lastAx !== ax ||
        lastBx !== bxAdjusted ||
        lastAy !== ay ||
        lastBy !== by ||
        lastCanvasW !== canvasW ||
        lastCanvasH !== canvasH ||
        lastDpr !== dpr ||
        lastLineWidth !== lineWidthCss;
      if (vsDirty) {
        writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
        lastAx = ax;
        lastBx = bxAdjusted;
        lastAy = ay;
        lastBy = by;
        lastCanvasW = canvasW;
        lastCanvasH = canvasH;
        lastDpr = dpr;
        lastLineWidth = lineWidthCss;
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
    if (currentBindGroup === null || boundDataBuffer !== dataBuffer || boundVsBuffer !== vsBufferForBind) {
      currentBindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: vsBufferForBind } },
          { binding: 1, resource: { buffer: fsUniformBuffer } },
          { binding: 2, resource: { buffer: dataBuffer } },
        ],
      });
      boundDataBuffer = dataBuffer;
      boundVsBuffer = vsBufferForBind;
    }
  };

  const isDenseHairlinePolicy = (): boolean => currentDrawPolicy === 'denseHairline';

  const render: LineRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    // Need at least 2 points to form 1 segment.
    if (!currentBindGroup || currentPointCount < 2) return;
    // Dense hairline is deferred to the single-sample post-resolve pass.
    if (isDenseHairlinePolicy()) return;

    const segments = currentPointCount - 1;
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, currentBindGroup);
    // 6 vertices per instance (quad), (pointCount - 1) instances (segments).
    passEncoder.draw(6, segments);
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
    if (!isDenseHairlinePolicy() || !currentBindGroup || currentPointCount < 2) return;
    const segments = currentPointCount - 1;
    if (!options?.skipSetPipeline) {
      passEncoder.setPipeline(hairlinePipeline);
    }
    passEncoder.setBindGroup(0, currentBindGroup);
    // Native 1 device-px stroke: 2 verts/instance (line-list), sampleCount 1 pass.
    passEncoder.draw(2, segments);
  };

  const dispose: LineRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    currentBindGroup = null;
    boundDataBuffer = null;
    currentPointCount = 0;
    currentDrawPolicy = 'standard';

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

  return { prepare, render, isDenseHairline, renderHairline, bindHairlinePipeline, dispose };
}
