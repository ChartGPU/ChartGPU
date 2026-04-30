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
  readonly horizontal?: number | number[]; // Default: 5. If array, normalized [0..1] positions.
  readonly vertical?: number | number[]; // Default: 6. If array, normalized [0..1] positions.
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

const createIdentityMat4Buffer = (): ArrayBuffer => {
  // Column-major identity mat4x4
  const buffer = new ArrayBuffer(16 * 4);
  new Float32Array(buffer).set([
    1,
    0,
    0,
    0, // col0
    0,
    1,
    0,
    0, // col1
    0,
    0,
    1,
    0, // col2
    0,
    0,
    0,
    1, // col3
  ]);
  return buffer;
};

const generateGridVertices = (
  gridArea: GridArea,
  horizontal: number | number[],
  vertical: number | number[],
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

  const horizontalPositions = Array.isArray(horizontal)
    ? horizontal
    : Array.from({ length: horizontal }, (_, i) => horizontal === 1 ? 0.5 : i / (horizontal - 1));

  const verticalPositions = Array.isArray(vertical)
    ? vertical
    : Array.from({ length: vertical }, (_, i) => vertical === 1 ? 0.5 : i / (vertical - 1));

  const totalLines = horizontalPositions.length + verticalPositions.length;
  const vertices = new Float32Array(totalLines * 2 * 2); // 2 vertices * 2 floats per vertex

  let idx = 0;

  // Generate horizontal lines (constant Y, varying X)
  for (const t of horizontalPositions) {
    const yDevice = plotTop + t * plotHeight;

    // Convert to clip space
    const xClipLeft = (plotLeft / canvasWidth) * 2.0 - 1.0;
    const xClipRight = (plotRight / canvasWidth) * 2.0 - 1.0;
    const yClip = 1.0 - (yDevice / canvasHeight) * 2.0; // Flip Y-axis

    // First vertex (left edge)
    vertices[idx++] = xClipLeft;
    vertices[idx++] = yClip;

    // Second vertex (right edge)
    vertices[idx++] = xClipRight;
    vertices[idx++] = yClip;
  }

  // Generate vertical lines (constant X, varying Y)
  for (const t of verticalPositions) {
    const xDevice = plotLeft + t * plotWidth;

    // Convert to clip space
    const xClip = (xDevice / canvasWidth) * 2.0 - 1.0;
    const yClipTop = 1.0 - (plotTop / canvasHeight) * 2.0; // Flip Y-axis
    const yClipBottom = 1.0 - (plotBottom / canvasHeight) * 2.0; // Flip Y-axis

    // First vertex (top edge)
    vertices[idx++] = xClip;
    vertices[idx++] = yClipTop;

    // Second vertex (bottom edge)
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
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 64, {
    label: "gridRenderer/vsUniforms",
  });
  const fsUniformBuffer = createUniformBuffer(device, 16, {
    label: "gridRenderer/fsUniforms",
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBuffer } },
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
        // Enable standard alpha blending so `fsUniforms.color.a` behaves as expected
        // (blends into the cleared background instead of making the canvas pixels transparent).
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

  let vertexBuffer: GPUBuffer | null = null;
  let combinedVertices: Float32Array | null = null;
  let batches: Array<{
    readonly vertexOffsetBytes: number;
    readonly vertexCount: number;
    readonly rgba: readonly [number, number, number, number];
  }> = [];

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error("GridRenderer is disposed.");
  };

  const prepare: GridRenderer["prepare"] = (gridArea, lineCountOrOptions) => {
    assertNotDisposed();

    const isOptionsObject =
      lineCountOrOptions != null &&
      typeof lineCountOrOptions === "object" &&
      ("lineCount" in lineCountOrOptions ||
        "color" in lineCountOrOptions ||
        "append" in lineCountOrOptions);

    const options: GridPrepareOptions | undefined = isOptionsObject
      ? (lineCountOrOptions as GridPrepareOptions)
      : undefined;

    const lineCount: GridLineCount | undefined = isOptionsObject
      ? options?.lineCount
      : (lineCountOrOptions as GridLineCount | undefined);

    const horizontal = lineCount?.horizontal ?? DEFAULT_HORIZONTAL_LINES;
    const vertical = lineCount?.vertical ?? DEFAULT_VERTICAL_LINES;
    const colorString = options?.color ?? DEFAULT_GRID_COLOR;
    const append = options?.append === true;

    const horizontalCount = Array.isArray(horizontal) ? horizontal.length : horizontal;
    const verticalCount = Array.isArray(vertical) ? vertical.length : vertical;

    // Validate inputs
    if (horizontalCount < 0 || verticalCount < 0) {
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

    // Early return if no lines to draw. If we're not appending, also clear any
    // previously prepared geometry so subsequent renders draw nothing.
    if (horizontalCount === 0 && verticalCount === 0) {
      if (!append) {
        combinedVertices = null;
        batches = [];
      }
      return;
    }

    // Generate vertices for this batch
    const vertices = generateGridVertices(gridArea, horizontal, vertical);
    const newBatchVertexCount = (horizontalCount + verticalCount) * 2;

    // Parse color for this batch (fallbacks to internal default)
    const rgba = parseCssColorToRgba01(colorString) ?? DEFAULT_GRID_RGBA;

    // Append or replace prepared geometry
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
        { vertexOffsetBytes, vertexCount: newBatchVertexCount, rgba },
      ]);
    } else {
      combinedVertices = vertices;
      batches = [
        { vertexOffsetBytes: 0, vertexCount: newBatchVertexCount, rgba },
      ];
    }

    const requiredSize = combinedVertices.byteLength;
    // Ensure minimum buffer size of 4 bytes
    const bufferSize = Math.max(4, requiredSize);

    // Create or recreate vertex buffer if needed
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

    // Write combined vertex data
    device.queue.writeBuffer(
      vertexBuffer,
      0,
      combinedVertices.buffer,
      0,
      combinedVertices.byteLength,
    );

    // Write uniforms
    // VS uniform: identity transform (vertices already in clip space)
    const transformBuffer = createIdentityMat4Buffer();
    writeUniformBuffer(device, vsUniformBuffer, transformBuffer);
  };

  const render: GridRenderer["render"] = (passEncoder) => {
    assertNotDisposed();
    if (batches.length === 0 || !vertexBuffer) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);

    for (const batch of batches) {
      // FS uniform: per-batch color
      const colorBuffer = new ArrayBuffer(4 * 4);
      new Float32Array(colorBuffer).set([
        batch.rgba[0],
        batch.rgba[1],
        batch.rgba[2],
        batch.rgba[3],
      ]);
      writeUniformBuffer(device, fsUniformBuffer, colorBuffer);

      passEncoder.setVertexBuffer(0, vertexBuffer, batch.vertexOffsetBytes);
      passEncoder.draw(batch.vertexCount);
    }
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
  };

  return { prepare, render, dispose };
}
