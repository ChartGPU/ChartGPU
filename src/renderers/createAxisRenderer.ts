import gridWgsl from '../shaders/grid.wgsl?raw';
import type { AxisConfig } from '../config/types';
import type { LinearScale } from '../utils/scales';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { GridArea } from './createGridRenderer';
import { parseCssColorToRgba01 } from '../utils/colors';

export interface AxisRenderer {
  prepare(
    axisConfig: AxisConfig,
    scale: LinearScale,
    orientation: 'x' | 'y',
    gridArea: GridArea,
    axisLineColor?: string,
    axisTickColor?: string,
    tickCount?: number
  ): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface AxisRendererOptions {
  /**
   * Must match the canvas context format used for the render pass color attachment.
   * Usually this is `gpuContext.preferredFormat`.
   *
   * Defaults to `'bgra8unorm'` for backward compatibility.
   */
  readonly targetFormat?: GPUTextureFormat;
}

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_TICK_COUNT = 5;
const DEFAULT_TICK_LENGTH_CSS_PX = 6;
const DEFAULT_AXIS_RGBA: readonly [number, number, number, number] = [1, 1, 1, 0.8];

const createIdentityMat4Buffer = (): ArrayBuffer => {
  // Column-major identity mat4x4
  const buffer = new ArrayBuffer(16 * 4);
  new Float32Array(buffer).set([
    1, 0, 0, 0, // col0
    0, 1, 0, 0, // col1
    0, 0, 1, 0, // col2
    0, 0, 0, 1, // col3
  ]);
  return buffer;
};

const isFiniteGridArea = (gridArea: GridArea): boolean =>
  Number.isFinite(gridArea.left) &&
  Number.isFinite(gridArea.right) &&
  Number.isFinite(gridArea.top) &&
  Number.isFinite(gridArea.bottom) &&
  Number.isFinite(gridArea.canvasWidth) &&
  Number.isFinite(gridArea.canvasHeight);

const finiteOrUndefined = (v: number | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const normalizeDomain = (minCandidate: number, maxCandidate: number): { readonly min: number; readonly max: number } => {
  let min = minCandidate;
  let max = maxCandidate;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }

  if (min === max) {
    max = min + 1;
  } else if (min > max) {
    const t = min;
    min = max;
    max = t;
  }

  return { min, max };
};

const generateAxisVertices = (
  axisConfig: AxisConfig,
  scale: LinearScale,
  orientation: 'x' | 'y',
  gridArea: GridArea,
  tickCountOverride?: number
): Float32Array => {
  const { left, right, top, bottom, canvasWidth, canvasHeight } = gridArea;
  // Be resilient: older call sites may omit/incorrectly pass DPR. Defaulting avoids hard crashes.
  const devicePixelRatio =
    Number.isFinite(gridArea.devicePixelRatio) && gridArea.devicePixelRatio > 0 ? gridArea.devicePixelRatio : 1;

  if (!isFiniteGridArea(gridArea)) {
    throw new Error('AxisRenderer.prepare: gridArea dimensions must be finite numbers.');
  }
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new Error('AxisRenderer.prepare: canvas dimensions must be positive.');
  }
  if (left < 0 || right < 0 || top < 0 || bottom < 0) {
    throw new Error('AxisRenderer.prepare: gridArea margins must be non-negative.');
  }

  const plotLeft = left * devicePixelRatio;
  const plotRight = canvasWidth - right * devicePixelRatio;
  const plotTop = top * devicePixelRatio;
  const plotBottom = canvasHeight - bottom * devicePixelRatio;

  const plotLeftClip = (plotLeft / canvasWidth) * 2.0 - 1.0;
  const plotRightClip = (plotRight / canvasWidth) * 2.0 - 1.0;
  const plotTopClip = 1.0 - (plotTop / canvasHeight) * 2.0; // flip Y
  const plotBottomClip = 1.0 - (plotBottom / canvasHeight) * 2.0; // flip Y

  const tickLengthCssPx = axisConfig.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
  if (!Number.isFinite(tickLengthCssPx) || tickLengthCssPx < 0) {
    throw new Error('AxisRenderer.prepare: tickLength must be a finite non-negative number.');
  }

  const tickCountRaw = tickCountOverride ?? DEFAULT_TICK_COUNT;
  const tickCount = Math.max(1, Math.floor(tickCountRaw));
  if (!Number.isFinite(tickCountRaw) || tickCount < 1) {
    throw new Error('AxisRenderer.prepare: tickCount must be a finite number >= 1.');
  }
  const tickLengthDevicePx = tickLengthCssPx * devicePixelRatio;
  const tickDeltaClipX = (tickLengthDevicePx / canvasWidth) * 2.0;
  const tickDeltaClipY = (tickLengthDevicePx / canvasHeight) * 2.0;

  // IMPORTANT: ignore non-finite overrides to keep GPU ticks consistent with the render coordinator
  // (which also treats min/max as “unset” when non-finite).
  const domainMinRaw =
    finiteOrUndefined(axisConfig.min) ??
    (orientation === 'x' ? scale.invert(plotLeftClip) : scale.invert(plotBottomClip));
  const domainMaxRaw =
    finiteOrUndefined(axisConfig.max) ??
    (orientation === 'x' ? scale.invert(plotRightClip) : scale.invert(plotTopClip));
  const domain = normalizeDomain(domainMinRaw, domainMaxRaw);
  const domainMin = domain.min;
  const domainMax = domain.max;

  // Line-list segments:
  // - 1 baseline segment
  // - tickCount tick segments
  const totalSegments = 1 + tickCount;
  const vertices = new Float32Array(totalSegments * 2 * 2); // segments * 2 vertices * vec2<f32>

  let idx = 0;

  if (orientation === 'x') {
    // Baseline along bottom edge of plot rect.
    vertices[idx++] = plotLeftClip;
    vertices[idx++] = plotBottomClip;
    vertices[idx++] = plotRightClip;
    vertices[idx++] = plotBottomClip;

    // Ticks extend downward (outside plot).
    const y0 = plotBottomClip;
    const y1 = y0 - tickDeltaClipY;

    for (let i = 0; i < tickCount; i++) {
      const t = tickCount === 1 ? 0.5 : i / (tickCount - 1);
      const v = domainMin + t * (domainMax - domainMin);
      const x = scale.scale(v);

      vertices[idx++] = x;
      vertices[idx++] = y0;
      vertices[idx++] = x;
      vertices[idx++] = y1;
    }
  } else {
    // Baseline along left edge of plot rect.
    vertices[idx++] = plotLeftClip;
    vertices[idx++] = plotBottomClip;
    vertices[idx++] = plotLeftClip;
    vertices[idx++] = plotTopClip;

    // Ticks extend left (outside plot).
    const x0 = plotLeftClip;
    const x1 = x0 - tickDeltaClipX;

    for (let i = 0; i < tickCount; i++) {
      const t = tickCount === 1 ? 0.5 : i / (tickCount - 1);
      const v = domainMin + t * (domainMax - domainMin);
      const y = scale.scale(v);

      vertices[idx++] = x0;
      vertices[idx++] = y;
      vertices[idx++] = x1;
      vertices[idx++] = y;
    }
  }

  return vertices;
};

export function createAxisRenderer(device: GPUDevice, options?: AxisRendererOptions): AxisRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 64, { label: 'axisRenderer/vsUniforms' });
  const fsUniformBufferLine = createUniformBuffer(device, 16, { label: 'axisRenderer/fsUniformsLine' });
  const fsUniformBufferTick = createUniformBuffer(device, 16, { label: 'axisRenderer/fsUniformsTick' });

  const bindGroupLine = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBufferLine } },
    ],
  });

  const bindGroupTick = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBufferTick } },
    ],
  });

  const pipeline = createRenderPipeline(device, {
    label: 'axisRenderer/pipeline',
    bindGroupLayouts: [bindGroupLayout],
    vertex: {
      code: gridWgsl,
      label: 'grid.wgsl',
      buffers: [
        {
          arrayStride: 8,
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, format: 'float32x2', offset: 0 }],
        },
      ],
    },
    fragment: {
      code: gridWgsl,
      label: 'grid.wgsl',
      formats: targetFormat,
      blend: {
        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    },
    primitive: { topology: 'line-list', cullMode: 'none' },
    multisample: { count: 1 },
  });

  let vertexBuffer: GPUBuffer | null = null;
  let vertexCount = 0;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('AxisRenderer is disposed.');
  };

  const prepare: AxisRenderer['prepare'] = (
    axisConfig,
    scale,
    orientation,
    gridArea,
    axisLineColor,
    axisTickColor,
    tickCount
  ) => {
    assertNotDisposed();

    if (orientation !== 'x' && orientation !== 'y') {
      throw new Error("AxisRenderer.prepare: orientation must be 'x' or 'y'.");
    }

    const vertices = generateAxisVertices(axisConfig, scale, orientation, gridArea, tickCount);
    const requiredSize = vertices.byteLength;
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
        label: 'axisRenderer/vertexBuffer',
        size: bufferSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    device.queue.writeBuffer(vertexBuffer, 0, vertices.buffer, 0, vertices.byteLength);
    vertexCount = vertices.length / 2;

    // Identity transform (vertices already in clip-space).
    writeUniformBuffer(device, vsUniformBuffer, createIdentityMat4Buffer());

    // Separate colors for baseline vs ticks.
    // Gracefully fall back to legacy (slightly brighter than grid) when parsing fails.
    const axisLineColorString = axisLineColor ?? 'rgba(255,255,255,0.8)';
    const axisTickColorString = axisTickColor ?? axisLineColorString;

    const axisLineRgba = parseCssColorToRgba01(axisLineColorString) ?? DEFAULT_AXIS_RGBA;
    const axisTickRgba = parseCssColorToRgba01(axisTickColorString) ?? axisLineRgba;

    const lineColorBuffer = new ArrayBuffer(4 * 4);
    new Float32Array(lineColorBuffer).set([
      axisLineRgba[0],
      axisLineRgba[1],
      axisLineRgba[2],
      axisLineRgba[3],
    ]);
    writeUniformBuffer(device, fsUniformBufferLine, lineColorBuffer);

    const tickColorBuffer = new ArrayBuffer(4 * 4);
    new Float32Array(tickColorBuffer).set([
      axisTickRgba[0],
      axisTickRgba[1],
      axisTickRgba[2],
      axisTickRgba[3],
    ]);
    writeUniformBuffer(device, fsUniformBufferTick, tickColorBuffer);
  };

  const render: AxisRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (vertexCount === 0 || !vertexBuffer) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setVertexBuffer(0, vertexBuffer);

    // Baseline: first 2 vertices.
    passEncoder.setBindGroup(0, bindGroupLine);
    passEncoder.draw(Math.min(2, vertexCount));

    // Ticks: remaining vertices.
    if (vertexCount > 2) {
      passEncoder.setBindGroup(0, bindGroupTick);
      passEncoder.draw(vertexCount - 2, 1, 2, 0);
    }
  };

  const dispose: AxisRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    try {
      vsUniformBuffer.destroy();
    } catch {
      // best-effort
    }
    try {
      fsUniformBufferLine.destroy();
    } catch {
      // best-effort
    }
    try {
      fsUniformBufferTick.destroy();
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
    vertexCount = 0;
  };

  return { prepare, render, dispose };
}

