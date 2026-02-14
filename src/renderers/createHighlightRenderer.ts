import highlightWgsl from '../shaders/highlight.wgsl?raw';
import { parseCssColorToRgba01 } from '../utils/colors';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import type { PipelineCache } from '../core/PipelineCache';

export type HighlightPoint = Readonly<{
  /** Center in *device pixels* (same coordinate space as fragment `@builtin(position)`). */
  centerDeviceX: number;
  centerDeviceY: number;

  /** Device pixel ratio used for CSS→device conversion. */
  devicePixelRatio: number;

  /** Canvas dimensions in *device pixels* (used to reset scissor). */
  canvasWidth: number;
  canvasHeight: number;

  /** Plot scissor rect in *device pixels*. */
  scissor: Readonly<{ x: number; y: number; w: number; h: number }>;
}>;

export interface HighlightRenderer {
  /**
   * Prepares the highlight ring.
   *
   * Coordinate contract:
   * - `point.centerDeviceX/Y` are device pixels in the same space as fragment `@builtin(position)`.
   * - `size` is specified in CSS pixels; the renderer will scale it by `point.devicePixelRatio`.
   */
  prepare(point: HighlightPoint, color: string, size: number): void;
  render(passEncoder: GPURenderPassEncoder): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface HighlightRendererOptions {
  /**
   * Must match the canvas context format used for the render pass color attachment.
   * Usually this is `gpuContext.preferredFormat`.
   *
   * Defaults to `'bgra8unorm'` for backward compatibility.
   */
  readonly targetFormat?: GPUTextureFormat;
  /**
   * Optional shared cache for shader modules + render pipelines.
   */
  readonly pipelineCache?: PipelineCache;
}

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_RGBA: readonly [number, number, number, number] = [1, 1, 1, 1];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

const isFiniteScissor = (s: HighlightPoint['scissor']): boolean =>
  Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.w) && Number.isFinite(s.h);

const brighten = (rgba: readonly [number, number, number, number], factor: number): readonly [number, number, number, number] => {
  const f = Number.isFinite(factor) ? factor : 1;
  return [clamp01(rgba[0] * f), clamp01(rgba[1] * f), clamp01(rgba[2] * f), clamp01(rgba[3])] as const;
};

const luminance = (rgba: readonly [number, number, number, number]): number =>
  0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2];

export function createHighlightRenderer(device: GPUDevice, options?: HighlightRendererOptions): HighlightRenderer {
  let disposed = false;
  let visible = true;

  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });

  // Uniform layout (WGSL):
  // center.xy, radius, thickness, color.rgba, outlineColor.rgba
  // = 12 floats = 48 bytes
  const uniformBuffer = createUniformBuffer(device, 48, { label: 'highlightRenderer/uniforms' });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  const pipeline = createRenderPipeline(
    device,
    {
      label: 'highlightRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: { code: highlightWgsl, label: 'highlight.wgsl' },
      fragment: {
        code: highlightWgsl,
        label: 'highlight.wgsl',
        formats: targetFormat,
        blend: {
          color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: 1 },
    },
    pipelineCache
  );

  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let lastScissor = { x: 0, y: 0, w: 0, h: 0 };
  let hasPrepared = false;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('HighlightRenderer is disposed.');
  };

  const prepare: HighlightRenderer['prepare'] = (point, cssColor, sizeCssPx) => {
    assertNotDisposed();

    if (!Number.isFinite(point.centerDeviceX) || !Number.isFinite(point.centerDeviceY)) {
      throw new Error('HighlightRenderer.prepare: point center must be finite.');
    }
    if (!Number.isFinite(point.canvasWidth) || !Number.isFinite(point.canvasHeight) || point.canvasWidth <= 0 || point.canvasHeight <= 0) {
      throw new Error('HighlightRenderer.prepare: canvasWidth/canvasHeight must be positive finite numbers.');
    }
    if (!isFiniteScissor(point.scissor)) {
      throw new Error('HighlightRenderer.prepare: scissor must be finite.');
    }
    if (!Number.isFinite(sizeCssPx) || sizeCssPx < 0) {
      throw new Error('HighlightRenderer.prepare: size must be a finite non-negative number.');
    }

    const dprRaw = point.devicePixelRatio;
    const dpr = Number.isFinite(dprRaw) && dprRaw > 0 ? dprRaw : 1;
    const baseRadiusDevicePx = sizeCssPx * dpr;

    // Slightly larger than the implied "normal" point size.
    const radius = Math.max(1, baseRadiusDevicePx * 1.5);
    const thickness = Math.max(1, Math.round(Math.max(2, radius * 0.25)));

    const seriesRgba = parseCssColorToRgba01(cssColor) ?? DEFAULT_RGBA;
    const ringRgba = brighten(seriesRgba, 1.25);
    const useDarkOutline = luminance(seriesRgba) > 0.7;
    const outlineRgba: readonly [number, number, number, number] = useDarkOutline ? [0, 0, 0, 0.9] : [1, 1, 1, 0.9];

    const buf = new ArrayBuffer(12 * 4);
    new Float32Array(buf).set([
      point.centerDeviceX,
      point.centerDeviceY,
      radius,
      thickness,
      ringRgba[0],
      ringRgba[1],
      ringRgba[2],
      1.0,
      outlineRgba[0],
      outlineRgba[1],
      outlineRgba[2],
      outlineRgba[3],
    ]);
    writeUniformBuffer(device, uniformBuffer, buf);

    lastCanvasWidth = point.canvasWidth;
    lastCanvasHeight = point.canvasHeight;

    // Clamp scissor to valid canvas bounds (defensive).
    const x0 = clampInt(Math.floor(point.scissor.x), 0, Math.max(0, point.canvasWidth));
    const y0 = clampInt(Math.floor(point.scissor.y), 0, Math.max(0, point.canvasHeight));
    const x1 = clampInt(Math.ceil(point.scissor.x + point.scissor.w), 0, Math.max(0, point.canvasWidth));
    const y1 = clampInt(Math.ceil(point.scissor.y + point.scissor.h), 0, Math.max(0, point.canvasHeight));
    lastScissor = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };

    hasPrepared = true;
  };

  const render: HighlightRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (!visible) return;
    if (!hasPrepared) return;
    if (lastCanvasWidth <= 0 || lastCanvasHeight <= 0) return;
    if (lastScissor.w === 0 || lastScissor.h === 0) return;

    passEncoder.setScissorRect(lastScissor.x, lastScissor.y, lastScissor.w, lastScissor.h);
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3);
    passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
  };

  const setVisible: HighlightRenderer['setVisible'] = (v) => {
    assertNotDisposed();
    visible = Boolean(v);
  };

  const dispose: HighlightRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    try {
      uniformBuffer.destroy();
    } catch {
      // best-effort
    }

    lastCanvasWidth = 0;
    lastCanvasHeight = 0;
    lastScissor = { x: 0, y: 0, w: 0, h: 0 };
    hasPrepared = false;
  };

  return { prepare, render, setVisible, dispose };
}

