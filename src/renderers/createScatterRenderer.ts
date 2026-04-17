import scatterWgsl from "../shaders/scatter.wgsl?raw";
import type { ResolvedScatterSeriesConfig } from "../config/OptionResolver";
import type { ScatterPointTuple } from "../config/types";
import type { LinearScale } from "../utils/scales";
import { parseCssColorToRgba01 } from "../utils/colors";
import { getPointCount, getSize, getX, getY } from "../data/cartesianData";
import type { GridArea } from "./createGridRenderer";
import {
  createRenderPipeline,
  createUniformBuffer,
  writeUniformBuffer,
} from "./rendererUtils";
import type { PipelineCache } from "../core/PipelineCache";

export interface ScatterRenderer {
  prepare(
    seriesConfig: ResolvedScatterSeriesConfig,
    dataBuffer: GPUBuffer,
    pointCount: number,
    xScale: LinearScale,
    yScale: LinearScale,
    gridArea?: GridArea,
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface ScatterRendererOptions {
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
const DEFAULT_SCATTER_RADIUS_CSS_PX = 4;
const SIZES_BUFFER_MIN_BYTES = 16; // 4 f32 slots — WebGPU storage buffers must be >0, keep a small floor.

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v | 0));

const parseSeriesColorToRgba01 = (color: string): Rgba =>
  parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const computeClipAffineFromScale = (
  scale: LinearScale,
  v0: number,
  v1: number,
): { readonly a: number; readonly b: number } => {
  const p0 = scale.scale(v0);
  const p1 = scale.scale(v1);

  // If the domain sample is degenerate or non-finite, fall back to constant output.
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

const writeTransformMat4F32 = (
  out: Float32Array,
  ax: number,
  bx: number,
  ay: number,
  by: number,
): void => {
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

export function createScatterRenderer(
  device: GPUDevice,
  options?: ScatterRendererOptions,
): ScatterRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw)
    ? Math.max(1, Math.floor(sampleCountRaw))
    : 1;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });

  // VSUniforms: mat4x4 (64) + viewportPx vec2 (8) + symbolSizePx f32 (4) + pad f32 (4) = 80 bytes.
  const vsUniformBuffer = createUniformBuffer(device, 80, {
    label: "scatterRenderer/vsUniforms",
  });
  const fsUniformBuffer = createUniformBuffer(device, 16, {
    label: "scatterRenderer/fsUniforms",
  });

  // Reused CPU-side staging for uniform writes (avoid per-frame allocations).
  const vsUniformScratchBuffer = new ArrayBuffer(80);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);
  const fsUniformScratchF32 = new Float32Array(4);

  // Per-point size storage buffer (binding 3). Grows geometrically to amortize reallocation costs.
  let sizesStorageBuffer: GPUBuffer | null = null;
  let sizesCapacityBytes = 0;
  // Reusable CPU-side staging array for size uploads. Grown lazily alongside the GPU buffer.
  let sizesStaging: Float32Array = new Float32Array(0);
  // Warning-once guard for function-based symbolSize evaluation failures.
  let warnedFunctionSymbolSize = false;

  // Dirty-tracking for per-point size uploads. We re-fill+upload only when one of the
  // inputs (symbolSize value/function ref, dpr, point count, sizes-buffer identity, and —
  // for function-based sizing — the source data reference) actually changes. Without this,
  // even constant `symbolSize` would trigger a full pointCount*4 byte writeBuffer every frame.
  let lastSymbolSize: ResolvedScatterSeriesConfig["symbolSize"] | undefined =
    undefined;
  let lastSymbolSizeDataRef: ResolvedScatterSeriesConfig["data"] | null = null;
  let lastSymbolSizePointCount = -1;
  let lastSymbolSizeDpr = -1;
  let lastSymbolSizeBuffer: GPUBuffer | null = null;

  // Bind group is cached by the current `(dataBuffer, sizesStorageBuffer)` pair. A new bind group
  // is built only when either buffer identity changes (e.g. DataStore reallocation, or sizes
  // buffer geometric growth in `ensureSizesStorageBuffer`). Per-frame `queue.writeBuffer` updates
  // to the same buffer references reuse the existing bind group.
  let currentBindGroup: GPUBindGroup | null = null;
  let boundDataBuffer: GPUBuffer | null = null;
  let boundSizesBuffer: GPUBuffer | null = null;

  const pipeline = createRenderPipeline(
    device,
    {
      label: "scatterRenderer/pipeline",
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: scatterWgsl,
        label: "scatter.wgsl",
        buffers: [], // No vertex buffers — points are read from storage buffer.
      },
      fragment: {
        code: scatterWgsl,
        label: "scatter.wgsl",
        formats: targetFormat,
        // Standard alpha blending (circle AA uses alpha, and series color may be translucent).
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

  let currentPointCount = 0;

  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let lastViewportPx: readonly [number, number] = [1, 1];
  let lastScissor: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  } | null = null;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error("ScatterRenderer is disposed.");
  };

  /**
   * Ensure the per-instance sizes storage buffer has capacity for `pointCount` f32 entries.
   * Grow-only geometric growth mirroring DataStore/candlestick-renderer conventions.
   *
   * Bind-group invalidation is detected separately by reference comparison
   * (`boundSizesBuffer !== sizesStorageBuffer`) in `prepare()`, so this function does not
   * need to return a "did it grow?" signal.
   */
  const ensureSizesStorageBuffer = (pointCount: number): void => {
    // WebGPU requires buffer sizes to be a multiple of 4 and > 0. A single f32 already is.
    const requiredBytes = Math.max(
      SIZES_BUFFER_MIN_BYTES,
      Math.max(1, pointCount) * 4,
    );
    if (sizesStorageBuffer && sizesCapacityBytes >= requiredBytes) return;

    const grownBytes = Math.max(
      Math.max(SIZES_BUFFER_MIN_BYTES, nextPow2(requiredBytes)),
      sizesCapacityBytes,
    );

    if (sizesStorageBuffer) {
      try {
        sizesStorageBuffer.destroy();
      } catch {
        // best-effort
      }
    }

    sizesStorageBuffer = device.createBuffer({
      label: "scatterRenderer/sizesStorageBuffer",
      size: grownBytes,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    sizesCapacityBytes = grownBytes;

    if (sizesStaging.length * 4 < grownBytes) {
      sizesStaging = new Float32Array(grownBytes / 4);
    }
  };

  const safeCallSymbolSize = (
    fn: (value: ScatterPointTuple) => number,
    value: ScatterPointTuple,
  ): number | null => {
    try {
      const v = fn(value);
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };

  /**
   * Populate `sizesStaging[0..pointCount)` with per-instance device-pixel radii, then upload
   * the populated range to the sizes storage buffer.
   *
   * Size resolution order (mirrors existing hit-testing semantics in findNearestPoint.ts):
   *   1. Function-based `symbolSize(tuple)` (when provided)
   *   2. Numeric `symbolSize`
   *   3. DEFAULT_SCATTER_RADIUS_CSS_PX
   * The final value is then scaled by `dpr` to convert CSS px to device px.
   */
  const writeSizesForSeries = (
    seriesConfig: ResolvedScatterSeriesConfig,
    pointCount: number,
    dpr: number,
  ): void => {
    if (!sizesStorageBuffer || pointCount <= 0) return;

    const effectiveDpr = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
    const seriesSymbolSize = seriesConfig.symbolSize;

    // Skip the upload when nothing affecting per-point sizes has changed since the last frame.
    // The sizes-buffer identity is part of the cache key because a freshly grown buffer is
    // zero-initialized — we MUST refill it, even if all other inputs match.
    // For function-based sizing, the source data reference is also part of the key because
    // the function's output depends on it; for constant sizing, data ref is irrelevant.
    const isFunctionSize = typeof seriesSymbolSize === "function";
    if (
      sizesStorageBuffer === lastSymbolSizeBuffer &&
      seriesSymbolSize === lastSymbolSize &&
      pointCount === lastSymbolSizePointCount &&
      effectiveDpr === lastSymbolSizeDpr &&
      (!isFunctionSize || seriesConfig.data === lastSymbolSizeDataRef)
    ) {
      return;
    }

    const defaultSizePx = DEFAULT_SCATTER_RADIUS_CSS_PX * effectiveDpr;

    const scratch = sizesStaging;

    if (typeof seriesSymbolSize === "function") {
      // Function-based per-point sizing. Evaluate once per point against the resolved series data.
      const data = seriesConfig.data;
      const dataPointCount = getPointCount(data);

      for (let i = 0; i < pointCount; i++) {
        if (i >= dataPointCount) {
          scratch[i] = defaultSizePx;
          continue;
        }
        const x = getX(data, i);
        const y = getY(data, i);
        const s = getSize(data, i);
        const tuple: ScatterPointTuple =
          typeof s === "number" ? [x, y, s] : [x, y];
        const resolved = safeCallSymbolSize(seriesSymbolSize, tuple);
        if (resolved == null) {
          if (!warnedFunctionSymbolSize) {
            warnedFunctionSymbolSize = true;
            // One-time warning; subsequent failures silently fall back to the default size.
            console.warn(
              "[ChartGPU] scatter.symbolSize function returned a non-finite value or threw; falling back to default size.",
            );
          }
          scratch[i] = defaultSizePx;
        } else {
          scratch[i] = Math.max(0, resolved) * effectiveDpr;
        }
      }
    } else if (
      typeof seriesSymbolSize === "number" &&
      Number.isFinite(seriesSymbolSize)
    ) {
      const sizePx = Math.max(0, seriesSymbolSize) * effectiveDpr;
      scratch.fill(sizePx, 0, pointCount);
    } else {
      scratch.fill(defaultSizePx, 0, pointCount);
    }

    const byteLength = pointCount * 4;
    device.queue.writeBuffer(
      sizesStorageBuffer,
      0,
      scratch.buffer,
      scratch.byteOffset,
      byteLength,
    );

    lastSymbolSize = seriesSymbolSize;
    lastSymbolSizeDataRef = isFunctionSize ? seriesConfig.data : null;
    lastSymbolSizePointCount = pointCount;
    lastSymbolSizeDpr = effectiveDpr;
    lastSymbolSizeBuffer = sizesStorageBuffer;
  };

  const writeVsUniforms = (
    ax: number,
    bx: number,
    ay: number,
    by: number,
    viewportW: number,
    viewportH: number,
    symbolSizePx: number,
  ): void => {
    const w = Number.isFinite(viewportW) && viewportW > 0 ? viewportW : 1;
    const h = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : 1;

    writeTransformMat4F32(vsUniformScratchF32, ax, bx, ay, by);
    vsUniformScratchF32[16] = w;
    vsUniformScratchF32[17] = h;
    vsUniformScratchF32[18] = symbolSizePx;
    vsUniformScratchF32[19] = 0; // pad
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);

    lastViewportPx = [w, h];
  };

  const prepare: ScatterRenderer["prepare"] = (
    seriesConfig,
    dataBuffer,
    pointCount,
    xScale,
    yScale,
    gridArea,
  ) => {
    assertNotDisposed();

    // Compute affine transform from scales.
    // Any two distinct sample values produce the same affine (the scale is linear).
    const { a: ax, b: bx } = computeClipAffineFromScale(xScale, 0, 1);
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, 0, 1);

    // Resolve device-pixel ratio for per-point size conversion.
    const dpr = gridArea?.devicePixelRatio ?? 1;

    // symbolSizePx in the uniform struct is retained for layout stability but is no longer
    // consumed by the shader — per-instance sizes are sourced from the sizes storage buffer.
    const unusedSymbolSizePx = 0;

    if (gridArea) {
      lastCanvasWidth = gridArea.canvasWidth;
      lastCanvasHeight = gridArea.canvasHeight;
      writeVsUniforms(
        ax,
        bx,
        ay,
        by,
        gridArea.canvasWidth,
        gridArea.canvasHeight,
        unusedSymbolSizePx,
      );
      lastScissor = computePlotScissorDevicePx(gridArea);
    } else {
      // Backward-compatible: keep rendering with the last known viewport (or safe default).
      writeVsUniforms(
        ax,
        bx,
        ay,
        by,
        lastViewportPx[0],
        lastViewportPx[1],
        unusedSymbolSizePx,
      );
      lastScissor = null;
    }

    const [r, g, b, a] = parseSeriesColorToRgba01(seriesConfig.color);
    fsUniformScratchF32[0] = r;
    fsUniformScratchF32[1] = g;
    fsUniformScratchF32[2] = b;
    fsUniformScratchF32[3] = clamp01(a);
    writeUniformBuffer(device, fsUniformBuffer, fsUniformScratchF32);

    currentPointCount = pointCount;

    // Ensure the sizes storage buffer is large enough, then upload per-point sizes.
    ensureSizesStorageBuffer(pointCount);
    writeSizesForSeries(seriesConfig, pointCount, dpr);

    // Rebuild the bind group only when either the dataBuffer or the internal sizes buffer
    // identity changed. Both are cheap to compare by reference and the uniform buffers are
    // stable for the lifetime of the renderer.
    const sizesBuffer = sizesStorageBuffer!;
    if (
      currentBindGroup === null ||
      boundDataBuffer !== dataBuffer ||
      boundSizesBuffer !== sizesBuffer
    ) {
      currentBindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: vsUniformBuffer } },
          { binding: 1, resource: { buffer: fsUniformBuffer } },
          { binding: 2, resource: { buffer: dataBuffer } },
          { binding: 3, resource: { buffer: sizesBuffer } },
        ],
      });
      boundDataBuffer = dataBuffer;
      boundSizesBuffer = sizesBuffer;
    }
  };

  const render: ScatterRenderer["render"] = (passEncoder) => {
    assertNotDisposed();
    if (!currentBindGroup || currentPointCount === 0) return;

    // Clip to plot area when available.
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(
        lastScissor.x,
        lastScissor.y,
        lastScissor.w,
        lastScissor.h,
      );
    }

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, currentBindGroup);
    passEncoder.draw(6, currentPointCount);

    // Reset scissor to full canvas to avoid impacting later renderers.
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    }
  };

  const dispose: ScatterRenderer["dispose"] = () => {
    if (disposed) return;
    disposed = true;

    currentBindGroup = null;
    boundDataBuffer = null;
    boundSizesBuffer = null;
    currentPointCount = 0;

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
    if (sizesStorageBuffer) {
      try {
        sizesStorageBuffer.destroy();
      } catch {
        // best-effort
      }
      sizesStorageBuffer = null;
      sizesCapacityBytes = 0;
    }

    lastSymbolSize = undefined;
    lastSymbolSizeDataRef = null;
    lastSymbolSizePointCount = -1;
    lastSymbolSizeDpr = -1;
    lastSymbolSizeBuffer = null;

    lastCanvasWidth = 0;
    lastCanvasHeight = 0;
    lastViewportPx = [1, 1];
    lastScissor = null;
  };

  return { prepare, render, dispose };
}
