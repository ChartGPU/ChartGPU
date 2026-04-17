import candlestickWgsl from "../shaders/candlestick.wgsl?raw";
import type { ResolvedCandlestickSeriesConfig } from "../config/OptionResolver";
import type { OHLCDataPoint, OHLCDataPointTuple } from "../config/types";
import type { LinearScale } from "../utils/scales";
import type { GridArea } from "./createGridRenderer";
import { parseCssColorToRgba01 } from "../utils/colors";
import { createRenderPipeline } from "./rendererUtils";
import type { PipelineCache } from "../core/PipelineCache";

export interface CandlestickRenderer {
  prepare(
    series: ResolvedCandlestickSeriesConfig,
    data: ResolvedCandlestickSeriesConfig["data"],
    xScale: LinearScale,
    yScale: LinearScale,
    gridArea: GridArea,
    backgroundColor?: string,
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface CandlestickRendererOptions {
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

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = "bgra8unorm";
const DEFAULT_WICK_WIDTH_CSS_PX = 1;

/**
 * Per-candle storage: [xClip, openClip, closeClip, lowClip, highClip] =
 * 5 floats = 20 bytes. Positions are pre-computed on the CPU in f64 and
 * written as f32 clip-space values in the [-1, 1] range. Storing raw domain
 * values (e.g. epoch-ms timestamps ~1.7e12) is not viable because f32 cannot
 * represent 1-second increments at that magnitude: the ulp at 1.776e12 is
 * 262144, collapsing adjacent timestamps to the same f32 and producing
 * catastrophic cancellation when computing `a * t + b` in-shader.
 */
const OHLC_STRIDE_FLOATS = 5;
const OHLC_STRIDE_BYTES = OHLC_STRIDE_FLOATS * 4;

/**
 * Uniform buffer layout (112 bytes, 16-byte aligned):
 *   0: xScaleA     f32  (identity: 1.0 — kept for shader struct compatibility)
 *   4: xScaleB     f32  (identity: 0.0)
 *   8: yScaleA     f32  (identity: 1.0)
 *  12: yScaleB     f32  (identity: 0.0)
 *  16: bodyWidthClip  f32
 *  20: wickWidthClip  f32
 *  24: borderWidthClip f32
 *  28: hollowMode  u32
 *  32: upColor     vec4<f32>
 *  48: downColor   vec4<f32>
 *  64: upBorderColor vec4<f32>
 *  80: downBorderColor vec4<f32>
 *  96: bgColor     vec4<f32>
 * Total: 112 bytes
 *
 * The buffer holds TWO consecutive records (each padded to
 * `device.limits.minUniformBufferOffsetAlignment`) so we can switch the
 * `hollowMode` value between two `draw()` calls in the same render pass via a
 * dynamic-offset bind group. Record 0 is the "primary" pass (mode=0 or mode=1);
 * record 1 is the hollow punch-out pass (mode=2). `queue.writeBuffer` cannot
 * be used to mutate uniforms mid-pass because writes are queue-timeline
 * operations, not command-buffer operations — they all collapse to the final
 * value before the command buffer executes.
 *
 * The xScaleA/xScaleB/yScaleA/yScaleB fields are retained at identity so the
 * WGSL `Uniforms` struct layout stays unchanged; the true affine transform is
 * applied on the CPU when packing the storage buffer.
 */
const UNIFORM_SIZE_BYTES = 112;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v | 0));

const parseSeriesColorToRgba01 = (color: string): Rgba =>
  parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

const parsePercent = (value: string): number | null => {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
  if (!m) return null;
  const p = Number(m[1]) / 100;
  return Number.isFinite(p) ? p : null;
};

const isTupleDataPoint = (p: OHLCDataPoint): p is OHLCDataPointTuple =>
  Array.isArray(p);

const getOHLC = (
  p: OHLCDataPoint,
): {
  readonly timestamp: number;
  readonly open: number;
  readonly close: number;
  readonly low: number;
  readonly high: number;
} => {
  if (isTupleDataPoint(p)) {
    return { timestamp: p[0], open: p[1], close: p[2], low: p[3], high: p[4] };
  }
  return {
    timestamp: p.timestamp,
    open: p.open,
    close: p.close,
    low: p.low,
    high: p.high,
  };
};

const computePlotSizeCssPx = (
  gridArea: GridArea,
): { readonly plotWidthCss: number; readonly plotHeightCss: number } | null => {
  const dpr = gridArea.devicePixelRatio;
  if (!(dpr > 0)) return null;
  const canvasCssWidth = gridArea.canvasWidth / dpr;
  const canvasCssHeight = gridArea.canvasHeight / dpr;
  const plotWidthCss = canvasCssWidth - gridArea.left - gridArea.right;
  const plotHeightCss = canvasCssHeight - gridArea.top - gridArea.bottom;
  if (!(plotWidthCss > 0) || !(plotHeightCss > 0)) return null;
  return { plotWidthCss, plotHeightCss };
};

const computePlotClipRect = (
  gridArea: GridArea,
): {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
} => {
  const {
    left,
    right,
    top,
    bottom,
    canvasWidth,
    canvasHeight,
    devicePixelRatio,
  } = gridArea;

  const plotLeft = left * devicePixelRatio;
  const plotRight = canvasWidth - right * devicePixelRatio;
  const plotTop = top * devicePixelRatio;
  const plotBottom = canvasHeight - bottom * devicePixelRatio;

  const plotLeftClip = (plotLeft / canvasWidth) * 2.0 - 1.0;
  const plotRightClip = (plotRight / canvasWidth) * 2.0 - 1.0;
  const plotTopClip = 1.0 - (plotTop / canvasHeight) * 2.0; // flip Y
  const plotBottomClip = 1.0 - (plotBottom / canvasHeight) * 2.0; // flip Y

  return {
    left: plotLeftClip,
    right: plotRightClip,
    top: plotTopClip,
    bottom: plotBottomClip,
    width: plotRightClip - plotLeftClip,
    height: plotTopClip - plotBottomClip,
  };
};

const computePlotScissorDevicePx = (
  gridArea: GridArea,
): {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
} => {
  const { canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeftDevice = gridArea.left * devicePixelRatio;
  const plotRightDevice = canvasWidth - gridArea.right * devicePixelRatio;
  const plotTopDevice = gridArea.top * devicePixelRatio;
  const plotBottomDevice = canvasHeight - gridArea.bottom * devicePixelRatio;

  const scissorX = clampInt(
    Math.floor(plotLeftDevice),
    0,
    Math.max(0, canvasWidth),
  );
  const scissorY = clampInt(
    Math.floor(plotTopDevice),
    0,
    Math.max(0, canvasHeight),
  );
  const scissorR = clampInt(
    Math.ceil(plotRightDevice),
    0,
    Math.max(0, canvasWidth),
  );
  const scissorB = clampInt(
    Math.ceil(plotBottomDevice),
    0,
    Math.max(0, canvasHeight),
  );
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
};

const computeCategoryStep = (data: ReadonlyArray<OHLCDataPoint>): number => {
  const timestamps: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const { timestamp } = getOHLC(data[i]);
    if (Number.isFinite(timestamp)) timestamps.push(timestamp);
  }

  if (timestamps.length < 2) return 1;
  timestamps.sort((a, b) => a - b);

  let minStep = Number.POSITIVE_INFINITY;
  for (let i = 1; i < timestamps.length; i++) {
    const d = timestamps[i] - timestamps[i - 1];
    if (d > 0 && d < minStep) minStep = d;
  }
  return Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
};

const computeCategoryWidthClip = (
  xScale: LinearScale,
  categoryStep: number,
  plotClipRect: Readonly<{ width: number }>,
  fallbackCategoryCount: number,
): number => {
  if (Number.isFinite(categoryStep) && categoryStep > 0) {
    const x0 = 0;
    const p0 = xScale.scale(x0);
    const p1 = xScale.scale(x0 + categoryStep);
    const w = Math.abs(p1 - p0);
    if (Number.isFinite(w) && w > 0) return w;
  }

  const clipWidth = Math.abs(plotClipRect.width);
  if (!(clipWidth > 0)) return 0;
  const n = Math.max(1, Math.floor(fallbackCategoryCount));
  return clipWidth / n;
};

/**
 * Compute affine transform coefficients from a LinearScale.
 *
 * For a LinearScale mapping domain [dMin, dMax] → range [rMin, rMax]:
 *   scale(v) = a * v + b
 * where a = (rMax - rMin) / (dMax - dMin), b = rMin - a * dMin.
 *
 * We sample two domain values to extract a and b.
 */
const computeClipAffineFromScale = (
  scale: LinearScale,
  v0: number,
  v1: number,
): { readonly a: number; readonly b: number } => {
  const p0 = scale.scale(v0);
  const p1 = scale.scale(v1);

  if (
    !Number.isFinite(v0) ||
    !Number.isFinite(v1) ||
    v0 === v1 ||
    !Number.isFinite(p0) ||
    !Number.isFinite(p1)
  ) {
    return { a: 0, b: Number.isFinite(p0) ? p0 : 0 };
  }

  const a = (p1 - p0) / (v1 - v0);
  const b = p0 - a * v0;
  return { a: Number.isFinite(a) ? a : 0, b: Number.isFinite(b) ? b : 0 };
};

export function createCandlestickRenderer(
  device: GPUDevice,
  options?: CandlestickRendererOptions,
): CandlestickRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw)
    ? Math.max(1, Math.floor(sampleCountRaw))
    : 1;
  const pipelineCache = options?.pipelineCache;

  // Pad the uniform record to the device's minimum dynamic-offset alignment
  // (typically 256). Two records are stored back-to-back in a single buffer so
  // that `render()` can switch `hollowMode` between draws via a dynamic offset
  // on the bind group instead of mutating the uniform mid-pass.
  const minUniformOffsetAlignment =
    device.limits.minUniformBufferOffsetAlignment;
  const alignedRecordSize =
    Math.ceil(UNIFORM_SIZE_BYTES / minUniformOffsetAlignment) *
    minUniformOffsetAlignment;
  const HOLLOW_FILL_OFFSET = 0;
  const HOLLOW_PUNCH_OFFSET = alignedRecordSize;
  const uniformBufferSize = alignedRecordSize * 2;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });

  const uniformBuffer = device.createBuffer({
    label: "candlestickRenderer/uniforms",
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const uniformScratchBuffer = new ArrayBuffer(UNIFORM_SIZE_BYTES);
  const uniformScratchF32 = new Float32Array(uniformScratchBuffer);
  const uniformScratchU32 = new Uint32Array(uniformScratchBuffer);

  const pipeline = createRenderPipeline(
    device,
    {
      label: "candlestickRenderer/pipeline",
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: candlestickWgsl,
        label: "candlestick.wgsl",
        buffers: [], // No vertex buffers; data comes from storage buffer
      },
      fragment: {
        code: candlestickWgsl,
        label: "candlestick.wgsl",
        formats: targetFormat,
        blend: {
          color: {
            operation: "add",
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
          },
          alpha: {
            operation: "add",
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
          },
        },
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      multisample: { count: sampleCount },
    },
    pipelineCache,
  );

  // OHLC storage buffer state
  let ohlcStorageBuffer: GPUBuffer | null = null;
  let lastDataRef: ResolvedCandlestickSeriesConfig["data"] | null = null;
  let lastDataLength = 0;
  // Cheap O(1) fingerprint of the last OHLC element. Detects in-place
  // mutation of the trailing candle (common for live tick streams) when the
  // array reference and length are unchanged.
  let lastDataFingerprint = 0;
  let candleCount = 0;
  // Track last applied scale coefficients. The storage buffer contains
  // clip-space positions (pre-baked affine), so any scale change (pan/zoom)
  // requires re-packing and re-uploading.
  let lastXA = Number.NaN;
  let lastXB = Number.NaN;
  let lastYA = Number.NaN;
  let lastYB = Number.NaN;

  // Bind group (recreated when storage buffer changes)
  let bindGroup: GPUBindGroup | null = null;

  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let lastScissor: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  } | null = null;

  // Hollow mode state
  let hollowMode = false;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error("CandlestickRenderer is disposed.");
  };

  /**
   * Cheap O(1) fingerprint of the last OHLC point.
   *
   * Used as a fallback check when the array reference and length are unchanged
   * to catch real-time callers that mutate the tail in place (e.g. updating
   * the currently-forming candle on every tick). Combines all five OHLC fields
   * with distinct multiplicative constants so any single-field change
   * effectively always yields a different value; collisions would only delay
   * the upload by one frame which is not a correctness issue beyond what the
   * existing reference/length fast path already permits.
   */
  const computeTailFingerprint = (
    data: ResolvedCandlestickSeriesConfig["data"],
  ): number => {
    if (data.length === 0) return 0;
    const { timestamp, open, close, low, high } = getOHLC(data[data.length - 1]);
    return (
      timestamp * 1.0000001 +
      open * 0.97 +
      close * 1.13 +
      low * 1.31 +
      high * 1.71
    );
  };

  /**
   * Ensure the OHLC storage buffer has enough capacity.
   * Returns true if the buffer was recreated (bind group must be rebuilt).
   */
  const ensureOhlcStorageBuffer = (requiredCandles: number): boolean => {
    const requiredBytes = Math.max(20, requiredCandles * OHLC_STRIDE_BYTES);
    if (ohlcStorageBuffer && ohlcStorageBuffer.size >= requiredBytes) {
      return false;
    }

    const grownBytes = Math.max(
      Math.max(20, nextPow2(requiredBytes)),
      ohlcStorageBuffer ? ohlcStorageBuffer.size : 0,
    );

    if (ohlcStorageBuffer) {
      try {
        ohlcStorageBuffer.destroy();
      } catch {
        // best-effort
      }
    }

    ohlcStorageBuffer = device.createBuffer({
      label: "candlestickRenderer/ohlcStorageBuffer",
      size: grownBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    return true;
  };

  const rebuildBindGroup = (): void => {
    if (!ohlcStorageBuffer) return;
    bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: uniformBuffer,
            offset: 0,
            // Binding size must be the per-record size when using a dynamic
            // offset; the offset is applied on top of this base in render().
            size: UNIFORM_SIZE_BYTES,
          },
        },
        { binding: 1, resource: { buffer: ohlcStorageBuffer } },
      ],
    });
  };

  const writeUniformsForMode = (
    bufferOffset: number,
    xA: number,
    xB: number,
    yA: number,
    yB: number,
    bodyWidthClip: number,
    wickWidthClip: number,
    borderWidthClip: number,
    mode: number,
    upColor: Rgba,
    downColor: Rgba,
    upBorderColor: Rgba,
    downBorderColor: Rgba,
    bgColor: Rgba,
  ): void => {
    // Scalars (offsets in f32 units)
    uniformScratchF32[0] = xA;
    uniformScratchF32[1] = xB;
    uniformScratchF32[2] = yA;
    uniformScratchF32[3] = yB;
    uniformScratchF32[4] = bodyWidthClip;
    uniformScratchF32[5] = wickWidthClip;
    uniformScratchF32[6] = borderWidthClip;
    // hollowMode is a u32 — write via Uint32Array view at the same byte offset
    uniformScratchU32[7] = mode;
    // upColor (vec4 at byte 32 = f32 index 8)
    uniformScratchF32[8] = upColor[0];
    uniformScratchF32[9] = upColor[1];
    uniformScratchF32[10] = upColor[2];
    uniformScratchF32[11] = upColor[3];
    // downColor (vec4 at byte 48 = f32 index 12)
    uniformScratchF32[12] = downColor[0];
    uniformScratchF32[13] = downColor[1];
    uniformScratchF32[14] = downColor[2];
    uniformScratchF32[15] = downColor[3];
    // upBorderColor (vec4 at byte 64 = f32 index 16)
    uniformScratchF32[16] = upBorderColor[0];
    uniformScratchF32[17] = upBorderColor[1];
    uniformScratchF32[18] = upBorderColor[2];
    uniformScratchF32[19] = upBorderColor[3];
    // downBorderColor (vec4 at byte 80 = f32 index 20)
    uniformScratchF32[20] = downBorderColor[0];
    uniformScratchF32[21] = downBorderColor[1];
    uniformScratchF32[22] = downBorderColor[2];
    uniformScratchF32[23] = downBorderColor[3];
    // bgColor (vec4 at byte 96 = f32 index 24)
    uniformScratchF32[24] = bgColor[0];
    uniformScratchF32[25] = bgColor[1];
    uniformScratchF32[26] = bgColor[2];
    uniformScratchF32[27] = bgColor[3];

    device.queue.writeBuffer(
      uniformBuffer,
      bufferOffset,
      uniformScratchBuffer,
      0,
      UNIFORM_SIZE_BYTES,
    );
  };

  const prepare: CandlestickRenderer["prepare"] = (
    series,
    data,
    xScale,
    yScale,
    gridArea,
    backgroundColor,
  ) => {
    assertNotDisposed();

    if (data.length === 0) {
      candleCount = 0;
      return;
    }

    const plotSize = computePlotSizeCssPx(gridArea);
    if (!plotSize) {
      candleCount = 0;
      return;
    }

    const plotClipRect = computePlotClipRect(gridArea);
    const clipPerCssX =
      plotSize.plotWidthCss > 0
        ? plotClipRect.width / plotSize.plotWidthCss
        : 0;

    lastCanvasWidth = gridArea.canvasWidth;
    lastCanvasHeight = gridArea.canvasHeight;
    lastScissor = computePlotScissorDevicePx(gridArea);

    // ---- Compute affine scale transforms ----
    // Sample two well-separated domain values to extract linear coefficients.
    // NOTE: These are only used for the dirty-check (to detect when the
    // scale's range/domain has shifted). The actual clip-space packing below
    // calls `scale.scale(value)` directly, which computes
    // `(value - domainMin) / span` first — numerically stable even for
    // epoch-ms timestamps (~1.776e12). Using the extracted affine form
    // `a * t + b` here would suffer catastrophic cancellation: a tiny ~0.01%
    // relative error in `a` gets amplified by ~1e12× when multiplied by the
    // timestamp, producing clip values that are thousands of units off.
    const { a: xA, b: xB } = computeClipAffineFromScale(xScale, 0, 1);
    const { a: yA, b: yB } = computeClipAffineFromScale(yScale, 0, 1);

    // ---- Upload clip-space data to storage buffer (on data OR scale change) ----
    // Fast path: reference + length + scale coefficients all match. Only when
    // the fast path would skip do we compute an O(1) fingerprint of the
    // trailing element to catch in-place mutation (live tick updates).
    let needsUpload =
      data !== lastDataRef ||
      data.length !== lastDataLength ||
      xA !== lastXA ||
      xB !== lastXB ||
      yA !== lastYA ||
      yB !== lastYB;
    if (!needsUpload) {
      const tailFingerprint = computeTailFingerprint(data);
      if (tailFingerprint !== lastDataFingerprint) {
        needsUpload = true;
      }
    }

    if (needsUpload) {
      // Pack pre-computed clip-space positions into Float32Array.
      // We call `xScale.scale(t)` / `yScale.scale(v)` directly (not the
      // extracted affine) because those perform `(value - domainMin) / span`
      // first — numerically stable against large-magnitude domain values.
      const packedF32 = new Float32Array(data.length * OHLC_STRIDE_FLOATS);
      let validCount = 0;

      for (let i = 0; i < data.length; i++) {
        const { timestamp, open, close, low, high } = getOHLC(data[i]);
        if (
          !Number.isFinite(timestamp) ||
          !Number.isFinite(open) ||
          !Number.isFinite(close) ||
          !Number.isFinite(low) ||
          !Number.isFinite(high)
        ) {
          continue;
        }

        const xClip = xScale.scale(timestamp);
        const openClip = yScale.scale(open);
        const closeClip = yScale.scale(close);
        const lowClip = yScale.scale(low);
        const highClip = yScale.scale(high);

        if (
          !Number.isFinite(xClip) ||
          !Number.isFinite(openClip) ||
          !Number.isFinite(closeClip) ||
          !Number.isFinite(lowClip) ||
          !Number.isFinite(highClip)
        ) {
          continue;
        }

        const off = validCount * OHLC_STRIDE_FLOATS;
        packedF32[off + 0] = xClip;
        packedF32[off + 1] = openClip;
        packedF32[off + 2] = closeClip;
        packedF32[off + 3] = lowClip;
        packedF32[off + 4] = highClip;
        validCount++;
      }

      candleCount = validCount;

      if (validCount > 0) {
        const bufferRecreated = ensureOhlcStorageBuffer(validCount);
        device.queue.writeBuffer(
          ohlcStorageBuffer!,
          0,
          packedF32.buffer,
          0,
          validCount * OHLC_STRIDE_BYTES,
        );
        if (bufferRecreated) {
          rebuildBindGroup();
        }
      }

      lastDataRef = data;
      lastDataLength = data.length;
      lastDataFingerprint = computeTailFingerprint(data);
      lastXA = xA;
      lastXB = xB;
      lastYA = yA;
      lastYB = yB;
    }

    if (candleCount === 0) return;

    // Ensure bind group exists (first call)
    if (!bindGroup) {
      rebuildBindGroup();
    }

    // ---- Compute body and wick widths in clip space ----
    const categoryStep = computeCategoryStep(data);
    const categoryWidthClip = computeCategoryWidthClip(
      xScale,
      categoryStep,
      plotClipRect,
      data.length,
    );

    let bodyWidthClip = 0;
    const rawBarWidth = series.barWidth;
    if (typeof rawBarWidth === "number") {
      bodyWidthClip = Math.max(0, rawBarWidth) * clipPerCssX;
    } else if (typeof rawBarWidth === "string") {
      const p = parsePercent(rawBarWidth);
      bodyWidthClip = p == null ? 0 : categoryWidthClip * clamp01(p);
    }

    // Apply min/max width constraints (CSS pixels converted to clip space)
    const minWidthClip = series.barMinWidth * clipPerCssX;
    const maxWidthClip = series.barMaxWidth * clipPerCssX;
    bodyWidthClip = Math.min(
      Math.max(bodyWidthClip, minWidthClip),
      maxWidthClip,
    );

    // Compute wick width in clip space (default 1px CSS)
    const wickWidthCssPx =
      series.itemStyle.borderWidth ?? DEFAULT_WICK_WIDTH_CSS_PX;
    const wickWidthClip = Math.max(0, wickWidthCssPx) * clipPerCssX;

    // Border width for hollow mode
    const borderWidthClip = series.itemStyle.borderWidth * clipPerCssX;

    // Parse colors
    const upColor = parseSeriesColorToRgba01(series.itemStyle.upColor);
    const downColor = parseSeriesColorToRgba01(series.itemStyle.downColor);
    const upBorderColor = parseSeriesColorToRgba01(
      series.itemStyle.upBorderColor,
    );
    const downBorderColor = parseSeriesColorToRgba01(
      series.itemStyle.downBorderColor,
    );
    const bgColor = backgroundColor
      ? parseSeriesColorToRgba01(backgroundColor)
      : ([0, 0, 0, 1] as const);

    hollowMode = series.style === "hollow";

    // The shader's affine-transform uniforms are held at identity because the
    // clip-space positions are pre-computed on the CPU and written directly
    // into the storage buffer. See UNIFORM_SIZE_BYTES docblock.
    const IDENTITY_SCALE_A = 1;
    const IDENTITY_SCALE_B = 0;

    // Write record 0 (primary pass): mode=0 for classic, mode=1 for hollow
    // border pass.
    const primaryMode = hollowMode ? 1 : 0;
    writeUniformsForMode(
      HOLLOW_FILL_OFFSET,
      IDENTITY_SCALE_A,
      IDENTITY_SCALE_B,
      IDENTITY_SCALE_A,
      IDENTITY_SCALE_B,
      bodyWidthClip,
      wickWidthClip,
      borderWidthClip,
      primaryMode,
      upColor,
      downColor,
      upBorderColor,
      downBorderColor,
      bgColor,
    );

    // Write record 1 (hollow punch-out pass): mode=2. Always write so that
    // toggling between classic and hollow doesn't leave stale values around;
    // when not in hollow mode this record is simply never bound.
    writeUniformsForMode(
      HOLLOW_PUNCH_OFFSET,
      IDENTITY_SCALE_A,
      IDENTITY_SCALE_B,
      IDENTITY_SCALE_A,
      IDENTITY_SCALE_B,
      bodyWidthClip,
      wickWidthClip,
      borderWidthClip,
      2,
      upColor,
      downColor,
      upBorderColor,
      downBorderColor,
      bgColor,
    );
  };

  const render: CandlestickRenderer["render"] = (passEncoder) => {
    assertNotDisposed();

    if (!bindGroup || candleCount === 0) return;

    // Apply scissor rect to clip to plot area
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(
        lastScissor.x,
        lastScissor.y,
        lastScissor.w,
        lastScissor.h,
      );
    }

    passEncoder.setPipeline(pipeline);

    // Pass 1: Draw all candles (18 vertices per instance — body + wicks).
    // Bind record 0 (primary mode: classic 0 or hollow border 1).
    passEncoder.setBindGroup(0, bindGroup, [HOLLOW_FILL_OFFSET]);
    passEncoder.draw(18, candleCount);

    // Pass 2 (hollow only): bind record 1 (mode=2) and punch the body inset
    // with the background color. The shader collapses DOWN candles to zero
    // area in mode=2 so only UP candles get hollowed out.
    //
    // Note: We MUST switch records via dynamic offset rather than mutating the
    // uniform buffer mid-pass. `queue.writeBuffer` is a queue-timeline op, so
    // mid-pass writes do not actually take effect between draws — both draws
    // would see the same final uniform value.
    if (hollowMode) {
      passEncoder.setBindGroup(0, bindGroup, [HOLLOW_PUNCH_OFFSET]);
      passEncoder.draw(6, candleCount);
    }

    // Reset scissor to full canvas
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    }
  };

  const dispose: CandlestickRenderer["dispose"] = () => {
    if (disposed) return;
    disposed = true;

    if (ohlcStorageBuffer) {
      try {
        ohlcStorageBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    ohlcStorageBuffer = null;
    candleCount = 0;

    try {
      uniformBuffer.destroy();
    } catch {
      // best-effort
    }

    bindGroup = null;
    lastDataRef = null;
    lastDataLength = 0;
    lastDataFingerprint = 0;
    lastXA = Number.NaN;
    lastXB = Number.NaN;
    lastYA = Number.NaN;
    lastYB = Number.NaN;
    lastCanvasWidth = 0;
    lastCanvasHeight = 0;
    lastScissor = null;
  };

  return { prepare, render, dispose };
}
