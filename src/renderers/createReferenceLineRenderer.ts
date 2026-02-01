import referenceLineWgsl from '../shaders/referenceLine.wgsl?raw';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { GridArea } from './createGridRenderer';

/**
 * Maximum dash entries supported per line instance.
 *
 * WGSL requires fixed-size arrays/varyings; we cap and truncate for deterministic perf.
 * If you need more, increase this (and update the shader accordingly).
 */
const MAX_DASH_VALUES = 8;

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

export type ReferenceLineAxis = 'vertical' | 'horizontal';

export interface ReferenceLineInstance {
  /**
   * Axis alignment.
   * - `'vertical'`: a line spanning the plot height at a fixed X position
   * - `'horizontal'`: a line spanning the plot width at a fixed Y position
   */
  readonly axis: ReferenceLineAxis;

  /**
   * Position in **CANVAS-LOCAL CSS pixels**.
   *
   * This is the same coordinate space as pointer event payloads:
   * - For vertical lines: canvas-local X in CSS px
   * - For horizontal lines: canvas-local Y in CSS px
   *
   * The shader converts CSS px → device px using DPR and relies on analytic AA for stable
   * strokes during zoom (no integer device-pixel snapping).
   */
  readonly positionCssPx: number;

  /**
   * Desired line width in **CSS pixels**.
   *
   * The renderer emulates thickness using a quad (two triangles) and converts CSS px to
   * device px using `gridArea.devicePixelRatio`.
   */
  readonly lineWidth: number;

  /**
   * Dash pattern in **CSS pixels**, matching the semantics of Canvas2D/SVG:
   * `[dash, gap, dash, gap, ...]`, repeating, starting with an "on" dash.
   *
   * - `undefined` / `[]` renders a solid line.
   * - Non-finite / non-positive entries are ignored.
   * - If the list length is odd, it is duplicated (CSS behavior) before truncation.
   * - The pattern is truncated to `MAX_DASH_VALUES`.
   */
  readonly lineDash?: ReadonlyArray<number>;

  /**
   * Line color as RGBA in 0..1.
   *
   * `rgba[3]` is the final opacity (i.e. you can pre-multiply any "opacity" control into alpha).
   */
  readonly rgba: readonly [number, number, number, number];
}

export interface ReferenceLineRendererOptions {
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
}

export interface ReferenceLineRenderer {
  /**
   * Prepares GPU buffers and uniforms for drawing.
   *
   * Coordinate contract:
   * - Line positions are CANVAS-LOCAL CSS pixels.
   * - `gridArea` margins are CSS pixels; `gridArea.canvasWidth/Height` are device pixels.
   */
  prepare(gridArea: GridArea, lines: ReadonlyArray<ReferenceLineInstance>): void;
  /**
   * Draws all prepared reference lines.
   *
   * Important: This renderer does NOT set scissor state. The render coordinator is expected
   * to set a scissor rect for the plot area before calling `render()`.
   */
  render(passEncoder: GPURenderPassEncoder, firstInstance?: number, instanceCount?: number): void;
  /** Cleans up GPU resources (best-effort). */
  dispose(): void;
}

const isFiniteGridArea = (gridArea: GridArea): boolean =>
  Number.isFinite(gridArea.left) &&
  Number.isFinite(gridArea.right) &&
  Number.isFinite(gridArea.top) &&
  Number.isFinite(gridArea.bottom) &&
  Number.isFinite(gridArea.canvasWidth) &&
  Number.isFinite(gridArea.canvasHeight);

type PackedDash = {
  readonly dashCount: number;
  readonly dashTotal: number;
  readonly values: readonly number[]; // length MAX_DASH_VALUES
};

const normalizeDash = (lineDash?: ReadonlyArray<number>): PackedDash => {
  if (!lineDash || lineDash.length === 0) {
    return { dashCount: 0, dashTotal: 0, values: new Array<number>(MAX_DASH_VALUES).fill(0) };
  }

  const cleaned: number[] = [];
  for (let i = 0; i < lineDash.length; i++) {
    const v = lineDash[i];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) cleaned.push(v);
  }

  if (cleaned.length === 0) {
    return { dashCount: 0, dashTotal: 0, values: new Array<number>(MAX_DASH_VALUES).fill(0) };
  }

  // CSS behavior: odd-length dash arrays are repeated to make even length.
  const normalized = cleaned.length % 2 === 1 ? cleaned.concat(cleaned) : cleaned;

  const dashCount = Math.min(MAX_DASH_VALUES, normalized.length);
  const values = new Array<number>(MAX_DASH_VALUES).fill(0);
  let dashTotal = 0;
  for (let i = 0; i < dashCount; i++) {
    values[i] = normalized[i];
    dashTotal += normalized[i];
  }

  if (!Number.isFinite(dashTotal) || dashTotal <= 0) {
    return { dashCount: 0, dashTotal: 0, values: new Array<number>(MAX_DASH_VALUES).fill(0) };
  }

  return { dashCount, dashTotal, values };
};

export function createReferenceLineRenderer(device: GPUDevice, options?: ReferenceLineRendererOptions): ReferenceLineRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw) ? Math.max(1, Math.floor(sampleCountRaw)) : 1;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  });

  // VSUniforms:
  // - canvasSize (vec2f)
  // - plotOrigin (vec2f)
  // - plotSize (vec2f)
  // - devicePixelRatio (f32)
  // - pad (f32)
  const vsUniformBuffer = createUniformBuffer(device, 32, { label: 'referenceLineRenderer/vsUniforms' });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
  });

  const INSTANCE_STRIDE_BYTES = 72;
  const INSTANCE_STRIDE_FLOATS = INSTANCE_STRIDE_BYTES / 4;

  const pipeline = createRenderPipeline(device, {
    label: 'referenceLineRenderer/pipeline',
    bindGroupLayouts: [bindGroupLayout],
    vertex: {
      code: referenceLineWgsl,
      label: 'referenceLine.wgsl',
      buffers: [
        {
          arrayStride: INSTANCE_STRIDE_BYTES,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, format: 'float32x2', offset: 0 },  // axisPos
            { shaderLocation: 1, format: 'float32x2', offset: 8 },  // widthDashCount
            { shaderLocation: 2, format: 'float32x2', offset: 16 }, // dashMeta
            { shaderLocation: 3, format: 'float32x4', offset: 24 }, // dash0_3
            { shaderLocation: 4, format: 'float32x4', offset: 40 }, // dash4_7
            { shaderLocation: 5, format: 'float32x4', offset: 56 }, // color
          ],
        },
      ],
    },
    fragment: {
      code: referenceLineWgsl,
      label: 'referenceLine.wgsl',
      formats: targetFormat,
      blend: {
        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: sampleCount },
  });

  let instanceBuffer: GPUBuffer | null = null;
  let instanceCapacity = 0;
  let instanceCount = 0;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('ReferenceLineRenderer is disposed.');
  };

  const prepare: ReferenceLineRenderer['prepare'] = (gridArea, lines) => {
    assertNotDisposed();

    if (!Array.isArray(lines)) {
      throw new Error('ReferenceLineRenderer.prepare: lines must be an array.');
    }
    if (!isFiniteGridArea(gridArea)) {
      throw new Error('ReferenceLineRenderer.prepare: gridArea dimensions must be finite numbers.');
    }
    if (gridArea.canvasWidth <= 0 || gridArea.canvasHeight <= 0) {
      throw new Error('ReferenceLineRenderer.prepare: canvas dimensions must be positive.');
    }
    if (gridArea.left < 0 || gridArea.right < 0 || gridArea.top < 0 || gridArea.bottom < 0) {
      throw new Error('ReferenceLineRenderer.prepare: gridArea margins must be non-negative.');
    }

    // Be resilient: older call sites may omit/incorrectly pass DPR. Defaulting avoids hard crashes.
    const dpr =
      Number.isFinite(gridArea.devicePixelRatio) && gridArea.devicePixelRatio > 0 ? gridArea.devicePixelRatio : 1;

    const plotLeftDevice = gridArea.left * dpr;
    const plotTopDevice = gridArea.top * dpr;
    const plotRightDevice = gridArea.canvasWidth - gridArea.right * dpr;
    const plotBottomDevice = gridArea.canvasHeight - gridArea.bottom * dpr;
    const plotWidthDevice = plotRightDevice - plotLeftDevice;
    const plotHeightDevice = plotBottomDevice - plotTopDevice;

    if (!(plotWidthDevice > 0) || !(plotHeightDevice > 0)) {
      instanceCount = 0;
      return;
    }

    // Write uniforms.
    const uniforms = new Float32Array(8);
    uniforms[0] = gridArea.canvasWidth;
    uniforms[1] = gridArea.canvasHeight;
    uniforms[2] = plotLeftDevice;
    uniforms[3] = plotTopDevice;
    uniforms[4] = plotWidthDevice;
    uniforms[5] = plotHeightDevice;
    uniforms[6] = dpr;
    uniforms[7] = 0;
    writeUniformBuffer(device, vsUniformBuffer, uniforms);

    // Early out: no instances.
    if (lines.length === 0) {
      instanceCount = 0;
      return;
    }

    // Ensure instance buffer capacity.
    if (!instanceBuffer || instanceCapacity < lines.length) {
      const nextCapacity = Math.max(1, Math.ceil(lines.length * 1.5));
      const size = Math.max(4, nextCapacity * INSTANCE_STRIDE_BYTES);

      if (instanceBuffer) {
        try {
          instanceBuffer.destroy();
        } catch {
          // best-effort
        }
      }

      instanceBuffer = device.createBuffer({
        label: 'referenceLineRenderer/instanceBuffer',
        size,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      instanceCapacity = nextCapacity;
    }

    const data = new Float32Array(lines.length * INSTANCE_STRIDE_FLOATS);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const base = i * INSTANCE_STRIDE_FLOATS;

      if (line.axis !== 'vertical' && line.axis !== 'horizontal') {
        throw new Error("ReferenceLineRenderer.prepare: line.axis must be 'vertical' or 'horizontal'.");
      }
      if (!Number.isFinite(line.positionCssPx)) {
        throw new Error('ReferenceLineRenderer.prepare: line.positionCssPx must be a finite number.');
      }
      if (!Number.isFinite(line.lineWidth) || line.lineWidth < 0) {
        throw new Error('ReferenceLineRenderer.prepare: line.lineWidth must be a finite non-negative number.');
      }

      const rgba = line.rgba;
      if (!Array.isArray(rgba) || rgba.length !== 4) {
        throw new Error('ReferenceLineRenderer.prepare: line.rgba must be a tuple [r,g,b,a].');
      }

      const dash = normalizeDash(line.lineDash);

      // axisPos
      data[base + 0] = line.axis === 'vertical' ? 0 : 1;
      data[base + 1] = line.positionCssPx;

      // widthDashCount
      data[base + 2] = line.lineWidth;
      data[base + 3] = dash.dashCount;

      // dashMeta
      data[base + 4] = dash.dashTotal;
      data[base + 5] = 0;

      // dash0_3 + dash4_7
      for (let d = 0; d < MAX_DASH_VALUES; d++) {
        data[base + 6 + d] = dash.values[d];
      }

      // color
      data[base + 14] = rgba[0];
      data[base + 15] = rgba[1];
      data[base + 16] = rgba[2];
      data[base + 17] = rgba[3];
    }

    device.queue.writeBuffer(instanceBuffer, 0, data.buffer, data.byteOffset, data.byteLength);
    instanceCount = lines.length;
  };

  const render: ReferenceLineRenderer['render'] = (passEncoder, firstInstance = 0, requestedCount) => {
    assertNotDisposed();
    if (instanceCount === 0 || !instanceBuffer) return;

    const first = Number.isFinite(firstInstance) ? Math.max(0, Math.floor(firstInstance)) : 0;
    const available = Math.max(0, instanceCount - first);
    const count =
      requestedCount == null
        ? available
        : Number.isFinite(requestedCount)
          ? Math.max(0, Math.min(available, Math.floor(requestedCount)))
          : available;
    if (count === 0) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, instanceBuffer);
    passEncoder.draw(6, count, 0, first);
  };

  const dispose: ReferenceLineRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    try {
      vsUniformBuffer.destroy();
    } catch {
      // best-effort
    }
    if (instanceBuffer) {
      try {
        instanceBuffer.destroy();
      } catch {
        // best-effort
      }
    }

    instanceBuffer = null;
    instanceCapacity = 0;
    instanceCount = 0;
  };

  return { prepare, render, dispose };
}

