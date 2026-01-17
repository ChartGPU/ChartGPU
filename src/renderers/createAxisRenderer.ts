import gridWgsl from '../shaders/grid.wgsl?raw';
import type { AxisConfig } from '../config/types';
import type { LinearScale } from '../utils/scales';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { GridArea } from './createGridRenderer';

export interface AxisRenderer {
  prepare(axisConfig: AxisConfig, scale: LinearScale, orientation: 'x' | 'y', gridArea: GridArea): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_TICK_COUNT = 5;
const DEFAULT_TICK_LENGTH_CSS_PX = 6;

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

const generateAxisVertices = (
  axisConfig: AxisConfig,
  scale: LinearScale,
  orientation: 'x' | 'y',
  gridArea: GridArea
): Float32Array => {
  const { left, right, top, bottom, canvasWidth, canvasHeight } = gridArea;

  if (!isFiniteGridArea(gridArea)) {
    throw new Error('AxisRenderer.prepare: gridArea dimensions must be finite numbers.');
  }
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new Error('AxisRenderer.prepare: canvas dimensions must be positive.');
  }

  const dpr = window.devicePixelRatio || 1;
  const plotLeft = left * dpr;
  const plotRight = canvasWidth - right * dpr;
  const plotTop = top * dpr;
  const plotBottom = canvasHeight - bottom * dpr;

  const plotLeftClip = (plotLeft / canvasWidth) * 2.0 - 1.0;
  const plotRightClip = (plotRight / canvasWidth) * 2.0 - 1.0;
  const plotTopClip = 1.0 - (plotTop / canvasHeight) * 2.0; // flip Y
  const plotBottomClip = 1.0 - (plotBottom / canvasHeight) * 2.0; // flip Y

  const tickLengthCssPx = axisConfig.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
  if (!Number.isFinite(tickLengthCssPx) || tickLengthCssPx < 0) {
    throw new Error('AxisRenderer.prepare: tickLength must be a finite non-negative number.');
  }

  const tickCount: number = DEFAULT_TICK_COUNT;
  const tickLengthDevicePx = tickLengthCssPx * dpr;
  const tickDeltaClipX = (tickLengthDevicePx / canvasWidth) * 2.0;
  const tickDeltaClipY = (tickLengthDevicePx / canvasHeight) * 2.0;

  const domainMin =
    axisConfig.min ??
    (orientation === 'x' ? scale.invert(plotLeftClip) : scale.invert(plotBottomClip));
  const domainMax =
    axisConfig.max ??
    (orientation === 'x' ? scale.invert(plotRightClip) : scale.invert(plotTopClip));

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

export function createAxisRenderer(device: GPUDevice): AxisRenderer {
  let disposed = false;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 64, { label: 'axisRenderer/vsUniforms' });
  const fsUniformBuffer = createUniformBuffer(device, 16, { label: 'axisRenderer/fsUniforms' });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBuffer } },
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
      formats: DEFAULT_TARGET_FORMAT,
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

  const prepare: AxisRenderer['prepare'] = (axisConfig, scale, orientation, gridArea) => {
    assertNotDisposed();

    if (orientation !== 'x' && orientation !== 'y') {
      throw new Error("AxisRenderer.prepare: orientation must be 'x' or 'y'.");
    }

    const vertices = generateAxisVertices(axisConfig, scale, orientation, gridArea);
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

    // Slightly brighter than grid.
    const colorBuffer = new ArrayBuffer(4 * 4);
    new Float32Array(colorBuffer).set([1.0, 1.0, 1.0, 0.8]);
    writeUniformBuffer(device, fsUniformBuffer, colorBuffer);
  };

  const render: AxisRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (vertexCount === 0 || !vertexBuffer) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, vertexBuffer);
    passEncoder.draw(vertexCount);
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
    vertexCount = 0;
  };

  return { prepare, render, dispose };
}

