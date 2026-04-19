import gridWgsl from "../shaders/grid.wgsl?raw";
import {
  createRenderPipeline,
  createUniformBuffer,
  writeUniformBuffer,
} from "./rendererUtils";
import { parseCssColorToRgba01 } from "../utils/colors";
import type { PipelineCache } from "../core/PipelineCache";

export interface GridRenderer {
  /**
   * Backward compatible:
   * - `prepare(gridArea, lineCount)` where `lineCount` is `{ horizontal?, vertical? }`
   *
   * Preferred:
   * - `prepare(gridArea, { lineCount, color })`
   */
  prepare(
    gridArea: GridArea,
    lineCountOrOptions?: GridLineCount | GridPrepareOptions,
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface GridArea {
  readonly left: number; // Left margin in CSS pixels
  readonly right: number; // Right margin in CSS pixels
  readonly top: number; // Top margin in CSS pixels
  readonly bottom: number; // Bottom margin in CSS pixels
  readonly canvasWidth: number; // Canvas width in device pixels (canvas.width)
  readonly canvasHeight: number; // Canvas height in device pixels (canvas.height)
  readonly devicePixelRatio: number; // Device pixel ratio for CSS-to-device conversion
}

export interface GridLineCount {
  readonly horizontal?: number; // Default: 5
  readonly vertical?: number; // Default: 6
}

export interface GridPrepareOptions {
  readonly lineCount?: GridLineCount;
  /**
   * CSS color string used for grid lines.
   *
   * Expected formats: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`, `rgba(r,g,b,a)`.
   */
  readonly color?: string;
  /**
   * When true, appends additional grid line geometry to the existing prepared
   * batch instead of replacing it. This enables rendering multiple grid batches
   * (e.g. different colors for horizontal vs vertical lines).
   *
   * Backward compatible: call sites that don't use `append` continue to replace
   * the prepared geometry each frame.
   */
  readonly append?: boolean;
}

export interface GridRendererOptions {
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

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = "bgra8unorm";
const DEFAULT_HORIZONTAL_LINES = 5;
const DEFAULT_VERTICAL_LINES = 6;
const DEFAULT_GRID_COLOR = "rgba(255,255,255,0.15)";
const DEFAULT_GRID_RGBA: readonly [number, number, number, number] = [
  1, 1, 1, 0.15,
];

// Initial capacity for per-batch color slots. Grows on demand.
const INITIAL_BATCH_SLOTS = 4;

const createIdentityMat4Buffer = (): ArrayBuffer => {
  // Column-major identity mat4x4
  const buffer = new ArrayBuffer(16 * 4);
  new Float32Array(buffer).set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  return buffer;
};

const generateGridVertices = (
  gridArea: GridArea,
  horizontal: number,
  vertical: number,
): Float32Array => {
  const { left, right, top, bottom, canvasWidth, canvasHeight } = gridArea;
  // Be resilient: older call sites may omit/incorrectly pass DPR. Defaulting avoids hard crashes.
  const devicePixelRatio =
    Number.isFinite(gridArea.devicePixelRatio) && gridArea.devicePixelRatio > 0
      ? gridArea.devicePixelRatio
      : 1;

  // Calculate plot area in device pixels using explicit DPR
  const plotLeft = left * devicePixelRatio;
  const plotRight = canvasWidth - right * devicePixelRatio;
  const plotTop = top * devicePixelRatio;
  const plotBottom = canvasHeight - bottom * devicePixelRatio;

  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  // Total vertices: (horizontal + vertical) * 2 vertices per line
  const totalLines = horizontal + vertical;
  const vertices = new Float32Array(totalLines * 2 * 2); // 2 vertices * 2 floats per vertex

  let idx = 0;

  // Generate horizontal lines (constant Y, varying X)
  for (let i = 0; i < horizontal; i++) {
    const t = horizontal === 1 ? 0.5 : i / (horizontal - 1);
    const yDevice = plotTop + t * plotHeight;

    const xClipLeft = (plotLeft / canvasWidth) * 2.0 - 1.0;
    const xClipRight = (plotRight / canvasWidth) * 2.0 - 1.0;
    const yClip = 1.0 - (yDevice / canvasHeight) * 2.0; // Flip Y-axis

    vertices[idx++] = xClipLeft;
    vertices[idx++] = yClip;
    vertices[idx++] = xClipRight;
    vertices[idx++] = yClip;
  }

  // Generate vertical lines (constant X, varying Y)
  for (let i = 0; i < vertical; i++) {
    const t = vertical === 1 ? 0.5 : i / (vertical - 1);
    const xDevice = plotLeft + t * plotWidth;

    const xClip = (xDevice / canvasWidth) * 2.0 - 1.0;
    const yClipTop = 1.0 - (plotTop / canvasHeight) * 2.0;
    const yClipBottom = 1.0 - (plotBottom / canvasHeight) * 2.0;

    vertices[idx++] = xClip;
    vertices[idx++] = yClipTop;
    vertices[idx++] = xClip;
    vertices[idx++] = yClipBottom;
  }

  return vertices;
};

export function createGridRenderer(
  device: GPUDevice,
  options?: GridRendererOptions,
): GridRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw)
    ? Math.max(1, Math.floor(sampleCountRaw))
    : 1;
  const pipelineCache = options?.pipelineCache;

  // Dynamic-offset alignment for uniform buffers. The device's advertised
  // `minUniformBufferOffsetAlignment` is guaranteed by the spec to be sufficient
  // for any dynamic offset; the default limit is 256 but many devices advertise
  // smaller values (e.g. 64), which lets us pack slots tighter.
  const dynamicOffsetAlignment = device.limits.minUniformBufferOffsetAlignment;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
      {
        // Phase 4a: per-batch color via dynamic offset so a single bind group
        // can serve multiple grid batches (horizontal vs vertical colors) and
        // be baked into a reusable render bundle.
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true },
      },
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 64, {
    label: "gridRenderer/vsUniforms",
  });

  // Single FS uniform buffer with slots for multiple batches. Grows geometrically on demand.
  let fsUniformSlotCount = INITIAL_BATCH_SLOTS;
  let fsUniformBuffer: GPUBuffer = device.createBuffer({
    label: "gridRenderer/fsUniforms",
    size: fsUniformSlotCount * dynamicOffsetAlignment,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // bindGroup holds references to the uniform buffers. Rebuilt when the fs uniform
  // buffer is reallocated (on batch-slot growth).
  let bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      {
        binding: 1,
        resource: {
          buffer: fsUniformBuffer,
          offset: 0,
          // Only cover one slot's worth — dynamic offsets index into the full buffer.
          size: 16,
        },
      },
    ],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: "gridRenderer/pipeline",
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: gridWgsl,
        label: "grid.wgsl",
        buffers: [
          {
            arrayStride: 8, // vec2<f32> = 2 * 4 bytes
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, format: "float32x2", offset: 0 }],
          },
        ],
      },
      fragment: {
        code: gridWgsl,
        label: "grid.wgsl",
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
      primitive: { topology: "line-list", cullMode: "none" },
      multisample: { count: sampleCount },
    },
    pipelineCache,
  );

  interface Batch {
    readonly vertexOffsetBytes: number;
    readonly vertexCount: number;
    readonly fsDynamicOffset: number;
  }

  let vertexBuffer: GPUBuffer | null = null;
  let combinedVertices: Float32Array | null = null;
  let batches: Batch[] = [];

  // Cached render bundle — rebuilt lazily on first render() after any prepare() change.
  let bundle: GPURenderBundle | null = null;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error("GridRenderer is disposed.");
  };

  const ensureFsUniformCapacity = (requiredSlots: number): void => {
    if (requiredSlots <= fsUniformSlotCount) return;

    // Invalidate the cached bundle *before* destroying the old fs uniform buffer
    // or rebuilding the bind group. Any cached bundle captured the previous
    // bindGroup / buffer identities; executing it after this point would be UB.
    bundle = null;

    // Geometric growth to amortize reallocation cost.
    let nextCount = fsUniformSlotCount;
    while (nextCount < requiredSlots) nextCount *= 2;

    try {
      fsUniformBuffer.destroy();
    } catch {
      // best-effort
    }

    fsUniformSlotCount = nextCount;
    fsUniformBuffer = device.createBuffer({
      label: "gridRenderer/fsUniforms",
      size: fsUniformSlotCount * dynamicOffsetAlignment,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: vsUniformBuffer } },
        {
          binding: 1,
          resource: { buffer: fsUniformBuffer, offset: 0, size: 16 },
        },
      ],
    });
  };

  const writeBatchColor = (
    slotIndex: number,
    rgba: readonly [number, number, number, number],
  ): void => {
    const offset = slotIndex * dynamicOffsetAlignment;
    // queue.writeBuffer requires a 4-byte-aligned byte length; 16-byte color satisfies that.
    const colorBuffer = new Float32Array([rgba[0], rgba[1], rgba[2], rgba[3]]);
    device.queue.writeBuffer(
      fsUniformBuffer,
      offset,
      colorBuffer.buffer,
      0,
      colorBuffer.byteLength,
    );
  };

  const prepare: GridRenderer["prepare"] = (gridArea, lineCountOrOptions) => {
    assertNotDisposed();

    const isOptionsObject =
      lineCountOrOptions != null &&
      typeof lineCountOrOptions === "object" &&
      ("lineCount" in lineCountOrOptions ||
        "color" in lineCountOrOptions ||
        "append" in lineCountOrOptions);

    const optionsArg: GridPrepareOptions | undefined = isOptionsObject
      ? (lineCountOrOptions as GridPrepareOptions)
      : undefined;

    const lineCount: GridLineCount | undefined = isOptionsObject
      ? optionsArg?.lineCount
      : (lineCountOrOptions as GridLineCount | undefined);

    const horizontal = lineCount?.horizontal ?? DEFAULT_HORIZONTAL_LINES;
    const vertical = lineCount?.vertical ?? DEFAULT_VERTICAL_LINES;
    const colorString = optionsArg?.color ?? DEFAULT_GRID_COLOR;
    const append = optionsArg?.append === true;

    if (horizontal < 0 || vertical < 0) {
      throw new Error(
        "GridRenderer.prepare: line counts must be non-negative.",
      );
    }
    if (
      !Number.isFinite(gridArea.left) ||
      !Number.isFinite(gridArea.right) ||
      !Number.isFinite(gridArea.top) ||
      !Number.isFinite(gridArea.bottom) ||
      !Number.isFinite(gridArea.canvasWidth) ||
      !Number.isFinite(gridArea.canvasHeight)
    ) {
      throw new Error(
        "GridRenderer.prepare: gridArea dimensions must be finite numbers.",
      );
    }
    if (gridArea.canvasWidth <= 0 || gridArea.canvasHeight <= 0) {
      throw new Error(
        "GridRenderer.prepare: canvas dimensions must be positive.",
      );
    }

    // Any prepare() call invalidates the cached bundle — geometry, color, or batch count
    // may have changed and the bundle encodes those in-place.
    bundle = null;

    // Early return if no lines to draw. If we're not appending, also clear any
    // previously prepared geometry so subsequent renders draw nothing.
    if (horizontal === 0 && vertical === 0) {
      if (!append) {
        combinedVertices = null;
        batches = [];
      }
      return;
    }

    const vertices = generateGridVertices(gridArea, horizontal, vertical);
    const newBatchVertexCount = (horizontal + vertical) * 2;

    const rgba = parseCssColorToRgba01(colorString) ?? DEFAULT_GRID_RGBA;

    const nextBatchIndex =
      append && combinedVertices && batches.length > 0 ? batches.length : 0;

    ensureFsUniformCapacity(nextBatchIndex + 1);
    writeBatchColor(nextBatchIndex, rgba);

    let vertexOffsetBytes = 0;
    if (
      append &&
      combinedVertices &&
      combinedVertices.byteLength > 0 &&
      batches.length > 0
    ) {
      vertexOffsetBytes = combinedVertices.byteLength;
      const combined = new Float32Array(
        combinedVertices.length + vertices.length,
      );
      combined.set(combinedVertices, 0);
      combined.set(vertices, combinedVertices.length);
      combinedVertices = combined;
      batches = batches.concat([
        {
          vertexOffsetBytes,
          vertexCount: newBatchVertexCount,
          fsDynamicOffset: nextBatchIndex * dynamicOffsetAlignment,
        },
      ]);
    } else {
      combinedVertices = vertices;
      batches = [
        {
          vertexOffsetBytes: 0,
          vertexCount: newBatchVertexCount,
          fsDynamicOffset: 0,
        },
      ];
    }

    const requiredSize = combinedVertices.byteLength;
    const bufferSize = Math.max(4, requiredSize);

    if (!vertexBuffer || vertexBuffer.size < bufferSize) {
      if (vertexBuffer) {
        try {
          vertexBuffer.destroy();
        } catch {
          // best-effort
        }
      }

      vertexBuffer = device.createBuffer({
        label: "gridRenderer/vertexBuffer",
        size: bufferSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    device.queue.writeBuffer(
      vertexBuffer,
      0,
      combinedVertices.buffer,
      0,
      combinedVertices.byteLength,
    );

    // VS uniform: identity transform (vertices already in clip space)
    writeUniformBuffer(device, vsUniformBuffer, createIdentityMat4Buffer());
  };

  const encodeDraws = (
    encoder: GPURenderPassEncoder | GPURenderBundleEncoder,
  ): void => {
    encoder.setPipeline(pipeline);
    for (const batch of batches) {
      encoder.setBindGroup(0, bindGroup, [batch.fsDynamicOffset]);
      encoder.setVertexBuffer(0, vertexBuffer!, batch.vertexOffsetBytes);
      encoder.draw(batch.vertexCount);
    }
  };

  const render: GridRenderer["render"] = (passEncoder) => {
    assertNotDisposed();
    if (batches.length === 0 || !vertexBuffer) return;

    // Phase 4a: lazily build a reusable render bundle. The bundle is invalidated by prepare().
    // Subsequent frames with unchanged inputs (see prepareOverlays memoization) reuse the
    // bundle, eliminating per-frame JS encoding overhead for grid draws.
    if (!bundle) {
      const bundleEncoder = device.createRenderBundleEncoder({
        label: "gridRenderer/bundle",
        colorFormats: [targetFormat],
        sampleCount,
      });
      encodeDraws(bundleEncoder);
      bundle = bundleEncoder.finish({ label: "gridRenderer/bundle" });
    }

    passEncoder.executeBundles([bundle]);
  };

  const dispose: GridRenderer["dispose"] = () => {
    if (disposed) return;
    disposed = true;

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
    if (vertexBuffer) {
      try {
        vertexBuffer.destroy();
      } catch {
        // best-effort
      }
    }

    vertexBuffer = null;
    combinedVertices = null;
    batches = [];
    bundle = null;
  };

  return { prepare, render, dispose };
}
