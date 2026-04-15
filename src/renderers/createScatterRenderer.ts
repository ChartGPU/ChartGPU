import scatterWgsl from "../shaders/scatter.wgsl?raw";
import type { ResolvedScatterSeriesConfig } from "../config/OptionResolver";
import type { LinearScale } from "../utils/scales";
import { parseCssColorToRgba01 } from "../utils/colors";
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

  // Bind group is recreated per-frame because the storage buffer (data buffer) changes per series.
  let currentBindGroup: GPUBindGroup | null = null;

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

    // Resolve symbol size to device pixels.
    const dpr = gridArea?.devicePixelRatio ?? 1;
    const hasValidDpr = dpr > 0 && Number.isFinite(dpr);

    const seriesSymbolSize = seriesConfig.symbolSize;
    // TODO: Function-based per-point symbolSize would need a separate GPU size buffer.
    // For now, resolve to a constant: use the numeric value, or the default.
    const sizeCss =
      typeof seriesSymbolSize === "number" && Number.isFinite(seriesSymbolSize)
        ? seriesSymbolSize
        : DEFAULT_SCATTER_RADIUS_CSS_PX;
    const symbolSizePx = hasValidDpr
      ? Math.max(0, sizeCss) * dpr
      : Math.max(0, sizeCss);

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
        symbolSizePx,
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
        symbolSizePx,
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

    // Recreate bind group with the current data buffer.
    currentBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: vsUniformBuffer } },
        { binding: 1, resource: { buffer: fsUniformBuffer } },
        { binding: 2, resource: { buffer: dataBuffer } },
      ],
    });
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

    lastCanvasWidth = 0;
    lastCanvasHeight = 0;
    lastViewportPx = [1, 1];
    lastScissor = null;
  };

  return { prepare, render, dispose };
}
