import crosshairWgsl from '../shaders/crosshair.wgsl?raw';
import { createStreamBuffer } from '../data/createStreamBuffer';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { GridArea } from './createGridRenderer';

export interface CrosshairRenderOptions {
  /** Whether to render the vertical crosshair line. */
  readonly showX: boolean;
  /** Whether to render the horizontal crosshair line. */
  readonly showY: boolean;
  /** CSS color string for the crosshair lines. */
  readonly color: string;
  /**
   * Desired line width in CSS pixels.
   *
   * Note: WebGPU wide lines are not reliably supported; the renderer emulates thickness by
   * drawing multiple 1px lines in device-pixel offsets (best-effort, deterministic).
   */
  readonly lineWidth: number;
}

export interface CrosshairRenderer {
  /**
   * Positions the crosshair for rendering.
   *
   * Coordinate contract:
   * - `x`, `y` are CANVAS-LOCAL CSS pixels (e.g. eventManager payload x/y)
   * - `gridArea` margins are CSS pixels; `gridArea.canvasWidth/Height` are device pixels
   */
  prepare(x: number, y: number, gridArea: GridArea, options: CrosshairRenderOptions): void;
  /** Draws the crosshair (if visible) clipped to the plot rect. */
  render(passEncoder: GPURenderPassEncoder): void;
  /** Shows/hides the crosshair without destroying GPU resources. */
  setVisible(visible: boolean): void;
  /** Cleans up GPU resources (best-effort). */
  dispose(): void;
}

export interface CrosshairRendererOptions {
  /**
   * Must match the canvas context format used for the render pass color attachment.
   * Usually this is `gpuContext.preferredFormat`.
   *
   * Defaults to `'bgra8unorm'` for backward compatibility.
   */
  readonly targetFormat?: GPUTextureFormat;
}

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_CROSSHAIR_RGBA: readonly [number, number, number, number] = [1, 1, 1, 0.8];

const MAX_THICKNESS_DEVICE_PX = 8;
const DASH_ON_DEVICE_PX = 6;
const DASH_OFF_DEVICE_PX = 4;

// Hard cap to keep CPU-side dash segmentation inexpensive/deterministic.
const MAX_VERTICES = 8192; // vec2<f32> vertices, i.e. floats/2.

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

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

const computeThicknessOffsetsDevicePx = (lineWidthCssPx: number, dpr: number): readonly number[] => {
  if (!Number.isFinite(lineWidthCssPx) || lineWidthCssPx < 0) {
    throw new Error('CrosshairRenderer.prepare: lineWidth must be a finite non-negative number.');
  }
  if (lineWidthCssPx === 0) return [];

  // Convert to device px, then clamp to a small deterministic maximum.
  const widthDevicePx = lineWidthCssPx * dpr;
  const thickness = Math.max(1, Math.min(MAX_THICKNESS_DEVICE_PX, Math.round(widthDevicePx)));

  // Symmetric offsets around center (even thickness yields ±0.5 style offsets).
  const mid = (thickness - 1) / 2;
  const out: number[] = [];
  for (let i = 0; i < thickness; i++) out.push(i - mid);
  return out;
};

const devicePxToClipX = (xDevicePx: number, canvasWidthDevicePx: number): number =>
  (xDevicePx / canvasWidthDevicePx) * 2.0 - 1.0;
const devicePxToClipY = (yDevicePx: number, canvasHeightDevicePx: number): number =>
  1.0 - (yDevicePx / canvasHeightDevicePx) * 2.0;

type Segment2D = readonly [x0: number, y0: number, x1: number, y1: number];

const appendSegmentVerticesClip = (out: number[], seg: Segment2D): void => {
  out.push(seg[0], seg[1], seg[2], seg[3]);
};

const generateDashedSegmentsAxisAligned = (start: number, end: number): readonly [number, number][] => {
  // Returns a list of [a,b] segments in *device* space along a single axis.
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

  const a0 = Math.min(start, end);
  const a1 = Math.max(start, end);
  if (a1 <= a0) return [];

  const on = DASH_ON_DEVICE_PX;
  const off = DASH_OFF_DEVICE_PX;
  const period = on + off;
  if (period <= 0 || !Number.isFinite(period)) return [];

  // Conservative cap: if this many segments would exceed MAX_VERTICES after thickness expansion,
  // the caller will fall back to a single solid segment.
  const approxSegments = Math.ceil((a1 - a0) / period);
  if (!Number.isFinite(approxSegments) || approxSegments <= 0) return [];

  const segments: Array<[number, number]> = [];
  let t = a0;
  while (t < a1) {
    const s0 = t;
    const s1 = Math.min(t + on, a1);
    if (s1 > s0) segments.push([s0, s1]);
    t += period;
  }
  return segments;
};

const generateCrosshairVertices = (
  xCssPx: number,
  yCssPx: number,
  gridArea: GridArea,
  options: CrosshairRenderOptions
): {
  readonly vertices: Float32Array;
  readonly scissor: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
} => {
  if (!Number.isFinite(xCssPx) || !Number.isFinite(yCssPx)) {
    throw new Error('CrosshairRenderer.prepare: x and y must be finite numbers.');
  }
  if (!isFiniteGridArea(gridArea)) {
    throw new Error('CrosshairRenderer.prepare: gridArea dimensions must be finite numbers.');
  }
  if (gridArea.canvasWidth <= 0 || gridArea.canvasHeight <= 0) {
    throw new Error('CrosshairRenderer.prepare: canvas dimensions must be positive.');
  }
  if (gridArea.left < 0 || gridArea.right < 0 || gridArea.top < 0 || gridArea.bottom < 0) {
    throw new Error('CrosshairRenderer.prepare: gridArea margins must be non-negative.');
  }

  const { canvasWidth, canvasHeight } = gridArea;
  const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;

  const plotLeftDevice = gridArea.left * dpr;
  const plotRightDevice = canvasWidth - gridArea.right * dpr;
  const plotTopDevice = gridArea.top * dpr;
  const plotBottomDevice = canvasHeight - gridArea.bottom * dpr;

  const scissorX = clampInt(Math.floor(plotLeftDevice), 0, Math.max(0, canvasWidth));
  const scissorY = clampInt(Math.floor(plotTopDevice), 0, Math.max(0, canvasHeight));
  const scissorR = clampInt(Math.ceil(plotRightDevice), 0, Math.max(0, canvasWidth));
  const scissorB = clampInt(Math.ceil(plotBottomDevice), 0, Math.max(0, canvasHeight));
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  // Convert the requested position from CSS px (canvas-local) to device px.
  const xDevice = xCssPx * dpr;
  const yDevice = yCssPx * dpr;

  const thicknessOffsets = computeThicknessOffsetsDevicePx(options.lineWidth, dpr);
  if (thicknessOffsets.length === 0 || (!options.showX && !options.showY)) {
    return {
      vertices: new Float32Array(0),
      scissor: { x: scissorX, y: scissorY, w: scissorW, h: scissorH },
    };
  }

  const floats: number[] = [];

  // Compute how many dashed segments we *might* generate and fall back to solid if too many.
  const dashSegmentsY = options.showX ? generateDashedSegmentsAxisAligned(plotTopDevice, plotBottomDevice) : [];
  const dashSegmentsX = options.showY ? generateDashedSegmentsAxisAligned(plotLeftDevice, plotRightDevice) : [];

  const segmentsPerThickness =
    (options.showX ? dashSegmentsY.length : 0) + (options.showY ? dashSegmentsX.length : 0);
  const projectedVertexCount = segmentsPerThickness * thicknessOffsets.length * 2; // 2 vertices per segment

  const useDashed = projectedVertexCount > 0 && projectedVertexCount <= MAX_VERTICES;

  const addVerticalSolid = (xDevicePx: number): void => {
    const xClip = devicePxToClipX(xDevicePx, canvasWidth);
    const y0 = devicePxToClipY(plotTopDevice, canvasHeight);
    const y1 = devicePxToClipY(plotBottomDevice, canvasHeight);
    appendSegmentVerticesClip(floats, [xClip, y0, xClip, y1]);
  };

  const addHorizontalSolid = (yDevicePx: number): void => {
    const yClip = devicePxToClipY(yDevicePx, canvasHeight);
    const x0 = devicePxToClipX(plotLeftDevice, canvasWidth);
    const x1 = devicePxToClipX(plotRightDevice, canvasWidth);
    appendSegmentVerticesClip(floats, [x0, yClip, x1, yClip]);
  };

  if (options.showX) {
    for (let i = 0; i < thicknessOffsets.length; i++) {
      const xd = xDevice + thicknessOffsets[i];
      if (!useDashed) {
        addVerticalSolid(xd);
        continue;
      }

      const xClip = devicePxToClipX(xd, canvasWidth);
      for (let s = 0; s < dashSegmentsY.length; s++) {
        const [ya, yb] = dashSegmentsY[s];
        const y0 = devicePxToClipY(ya, canvasHeight);
        const y1 = devicePxToClipY(yb, canvasHeight);
        appendSegmentVerticesClip(floats, [xClip, y0, xClip, y1]);
      }
    }
  }

  if (options.showY) {
    for (let i = 0; i < thicknessOffsets.length; i++) {
      const yd = yDevice + thicknessOffsets[i];
      if (!useDashed) {
        addHorizontalSolid(yd);
        continue;
      }

      const yClip = devicePxToClipY(yd, canvasHeight);
      for (let s = 0; s < dashSegmentsX.length; s++) {
        const [xa, xb] = dashSegmentsX[s];
        const x0 = devicePxToClipX(xa, canvasWidth);
        const x1 = devicePxToClipX(xb, canvasWidth);
        appendSegmentVerticesClip(floats, [x0, yClip, x1, yClip]);
      }
    }
  }

  const vertices = new Float32Array(floats);
  return { vertices, scissor: { x: scissorX, y: scissorY, w: scissorW, h: scissorH } };
};

export function createCrosshairRenderer(device: GPUDevice, options?: CrosshairRendererOptions): CrosshairRenderer {
  let disposed = false;
  let visible = true;

  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const vsUniformBuffer = createUniformBuffer(device, 64, { label: 'crosshairRenderer/vsUniforms' });
  const fsUniformBuffer = createUniformBuffer(device, 16, { label: 'crosshairRenderer/fsUniforms' });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBuffer } },
    ],
  });

  const pipeline = createRenderPipeline(device, {
    label: 'crosshairRenderer/pipeline',
    bindGroupLayouts: [bindGroupLayout],
    vertex: {
      code: crosshairWgsl,
      label: 'crosshair.wgsl',
      buffers: [
        {
          arrayStride: 8,
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, format: 'float32x2', offset: 0 }],
        },
      ],
    },
    fragment: {
      code: crosshairWgsl,
      label: 'crosshair.wgsl',
      formats: targetFormat,
      blend: {
        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    },
    primitive: { topology: 'line-list', cullMode: 'none' },
    multisample: { count: 1 },
  });

  const stream = createStreamBuffer(device, MAX_VERTICES * 8);
  let vertexCount = 0;
  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let lastScissor = { x: 0, y: 0, w: 0, h: 0 };

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('CrosshairRenderer is disposed.');
  };

  const prepare: CrosshairRenderer['prepare'] = (x, y, gridArea, renderOptions) => {
    assertNotDisposed();

    // Validate options up-front for deterministic behavior.
    if (typeof renderOptions.showX !== 'boolean' || typeof renderOptions.showY !== 'boolean') {
      throw new Error('CrosshairRenderer.prepare: showX/showY must be boolean.');
    }
    if (typeof renderOptions.color !== 'string') {
      throw new Error('CrosshairRenderer.prepare: color must be a string.');
    }
    if (!Number.isFinite(renderOptions.lineWidth) || renderOptions.lineWidth < 0) {
      throw new Error('CrosshairRenderer.prepare: lineWidth must be a finite non-negative number.');
    }

    const { vertices, scissor } = generateCrosshairVertices(x, y, gridArea, renderOptions);
    if (vertices.byteLength === 0) {
      vertexCount = 0;
    } else {
      stream.write(vertices);
      vertexCount = stream.getVertexCount();
    }

    // Identity transform (vertices are already in clip-space).
    writeUniformBuffer(device, vsUniformBuffer, createIdentityMat4Buffer());

    // Color.
    const rgba = parseCssColorToRgba01(renderOptions.color) ?? DEFAULT_CROSSHAIR_RGBA;
    const colorBuffer = new ArrayBuffer(4 * 4);
    new Float32Array(colorBuffer).set([rgba[0], rgba[1], rgba[2], rgba[3]]);
    writeUniformBuffer(device, fsUniformBuffer, colorBuffer);

    lastCanvasWidth = gridArea.canvasWidth;
    lastCanvasHeight = gridArea.canvasHeight;
    lastScissor = scissor;
  };

  const render: CrosshairRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (!visible) return;
    if (vertexCount === 0) return;
    if (lastCanvasWidth <= 0 || lastCanvasHeight <= 0) return;

    // Clip to plot area (device pixels).
    passEncoder.setScissorRect(lastScissor.x, lastScissor.y, lastScissor.w, lastScissor.h);

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, stream.getBuffer());
    passEncoder.draw(vertexCount);

    // Reset scissor to full canvas (avoid affecting subsequent renderers).
    passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
  };

  const setVisible: CrosshairRenderer['setVisible'] = (v) => {
    assertNotDisposed();
    visible = Boolean(v);
  };

  const dispose: CrosshairRenderer['dispose'] = () => {
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
    stream.dispose();

    vertexCount = 0;
    lastCanvasWidth = 0;
    lastCanvasHeight = 0;
    lastScissor = { x: 0, y: 0, w: 0, h: 0 };
  };

  return { prepare, render, setVisible, dispose };
}

