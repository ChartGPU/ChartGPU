import pieWgsl from '../shaders/pie.wgsl?raw';
import type { ResolvedPieSeriesConfig } from '../config/OptionResolver';
import type { PieCenter, PieRadius } from '../config/types';
import { parseCssColorToRgba01 } from '../utils/colors';
import type { GridArea } from './createGridRenderer';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';

export interface PieRenderer {
  prepare(seriesConfig: ResolvedPieSeriesConfig, gridArea: GridArea): void;
  render(passEncoder: GPURenderPassEncoder): void;
  dispose(): void;
}

export interface PieRendererOptions {
  /**
   * Must match the canvas context format used for the render pass color attachment.
   * Usually this is `gpuContext.preferredFormat`.
   *
   * Defaults to `'bgra8unorm'` for backward compatibility.
   */
  readonly targetFormat?: GPUTextureFormat;
}

type Rgba = readonly [r: number, g: number, b: number, a: number];

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';

// Instance layout (must match `pie.wgsl` locations):
// @location(0) center: vec2<f32>
// @location(1) startAngleRad: f32
// @location(2) endAngleRad: f32
// @location(3) radiiPx: vec2<f32> (innerPx, outerPx) in device pixels
// @location(4) color: vec4<f32>
const INSTANCE_STRIDE_BYTES = 40;
const INSTANCE_STRIDE_FLOATS = INSTANCE_STRIDE_BYTES / 4;

const TAU = Math.PI * 2;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

const wrapToTau = (thetaRad: number): number => {
  if (!Number.isFinite(thetaRad)) return 0;
  const t = thetaRad % TAU;
  return t < 0 ? t + TAU : t;
};

const parseColor = (cssColor: string, fallbackCssColor: string): Rgba => {
  const parsed = parseCssColorToRgba01(cssColor);
  if (parsed) return [parsed[0], parsed[1], parsed[2], clamp01(parsed[3])] as const;

  const fb = parseCssColorToRgba01(fallbackCssColor);
  if (fb) return [fb[0], fb[1], fb[2], clamp01(fb[3])] as const;

  return [0, 0, 0, 1] as const;
};

const parseNumberOrPercent = (value: number | string, basis: number): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const s = value.trim();
  if (s.length === 0) return null;

  if (s.endsWith('%')) {
    const pct = Number.parseFloat(s.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return (pct / 100) * basis;
  }

  // Be permissive: allow numeric strings like "120" even though the public type primarily documents percent strings.
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const resolveCenterPlotCss = (
  center: PieCenter | undefined,
  plotWidthCss: number,
  plotHeightCss: number
): { readonly x: number; readonly y: number } => {
  const xRaw = center?.[0] ?? '50%';
  const yRaw = center?.[1] ?? '50%';

  const x = parseNumberOrPercent(xRaw, plotWidthCss);
  const y = parseNumberOrPercent(yRaw, plotHeightCss);

  return {
    x: Number.isFinite(x) ? x! : plotWidthCss * 0.5,
    y: Number.isFinite(y) ? y! : plotHeightCss * 0.5,
  };
};

const isRadiusTuple = (
  radius: PieRadius
): radius is readonly [inner: number | string, outer: number | string] => Array.isArray(radius);

const resolveRadiiCss = (
  radius: PieRadius | undefined,
  maxRadiusCss: number
): { readonly inner: number; readonly outer: number } => {
  // Default similar to common chart libs.
  if (radius == null) return { inner: 0, outer: maxRadiusCss * 0.7 };

  if (isRadiusTuple(radius)) {
    const inner = parseNumberOrPercent(radius[0], maxRadiusCss);
    const outer = parseNumberOrPercent(radius[1], maxRadiusCss);
    const innerCss = Math.max(0, Number.isFinite(inner) ? inner! : 0);
    const outerCss = Math.max(innerCss, Number.isFinite(outer) ? outer! : maxRadiusCss * 0.7);
    return { inner: innerCss, outer: Math.min(maxRadiusCss, outerCss) };
  }

  const outer = parseNumberOrPercent(radius, maxRadiusCss);
  const outerCss = Math.max(0, Number.isFinite(outer) ? outer! : maxRadiusCss * 0.7);
  return { inner: 0, outer: Math.min(maxRadiusCss, outerCss) };
};

const computePlotScissorDevicePx = (
  gridArea: GridArea
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } => {
  const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  const { canvasWidth, canvasHeight } = gridArea;

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

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
};

const IDENTITY_MAT4_F32 = new Float32Array([
  1, 0, 0, 0, // col0
  0, 1, 0, 0, // col1
  0, 0, 1, 0, // col2
  0, 0, 0, 1, // col3
]);

export function createPieRenderer(device: GPUDevice, options?: PieRendererOptions): PieRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  });

  // VSUniforms in `pie.wgsl`: mat4x4 (64) + viewportPx vec2 (8) + pad vec2 (8) = 80 bytes.
  const vsUniformBuffer = createUniformBuffer(device, 80, { label: 'pieRenderer/vsUniforms' });

  // Reused CPU-side staging for uniform writes (avoid per-frame allocations).
  const vsUniformScratchBuffer = new ArrayBuffer(80);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: vsUniformBuffer } }],
  });

  const pipeline = createRenderPipeline(device, {
    label: 'pieRenderer/pipeline',
    bindGroupLayouts: [bindGroupLayout],
    vertex: {
      code: pieWgsl,
      label: 'pie.wgsl',
      buffers: [
        {
          arrayStride: INSTANCE_STRIDE_BYTES,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, format: 'float32x2', offset: 0 }, // center
            { shaderLocation: 1, format: 'float32', offset: 8 }, // startAngleRad
            { shaderLocation: 2, format: 'float32', offset: 12 }, // endAngleRad
            { shaderLocation: 3, format: 'float32x2', offset: 16 }, // radiiPx
            { shaderLocation: 4, format: 'float32x4', offset: 24 }, // color
          ],
        },
      ],
    },
    fragment: {
      code: pieWgsl,
      label: 'pie.wgsl',
      formats: targetFormat,
      // Standard alpha blending for AA edges and translucent slice colors.
      blend: {
        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: 1 },
  });

  let instanceBuffer: GPUBuffer | null = null;
  let instanceCount = 0;
  let cpuInstanceStagingBuffer = new ArrayBuffer(0);
  let cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);

  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let lastScissor: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null = null;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('PieRenderer is disposed.');
  };

  const ensureCpuInstanceCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuInstanceStagingF32.length) return;
    const nextFloats = Math.max(8, nextPow2(requiredFloats));
    cpuInstanceStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  };

  const writeVsUniforms = (viewportWDevicePx: number, viewportHDevicePx: number): void => {
    const w = Number.isFinite(viewportWDevicePx) && viewportWDevicePx > 0 ? viewportWDevicePx : 1;
    const h = Number.isFinite(viewportHDevicePx) && viewportHDevicePx > 0 ? viewportHDevicePx : 1;

    vsUniformScratchF32.set(IDENTITY_MAT4_F32, 0);
    vsUniformScratchF32[16] = w;
    vsUniformScratchF32[17] = h;
    vsUniformScratchF32[18] = 0;
    vsUniformScratchF32[19] = 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);
  };

  const prepare: PieRenderer['prepare'] = (seriesConfig, gridArea) => {
    assertNotDisposed();

    const dprRaw = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const dpr = dprRaw > 0 && Number.isFinite(dprRaw) ? dprRaw : 1;

    lastCanvasWidth = gridArea.canvasWidth;
    lastCanvasHeight = gridArea.canvasHeight;
    writeVsUniforms(gridArea.canvasWidth, gridArea.canvasHeight);
    lastScissor = computePlotScissorDevicePx(gridArea);

    const canvasCssWidth = gridArea.canvasWidth / dpr;
    const canvasCssHeight = gridArea.canvasHeight / dpr;
    if (!(canvasCssWidth > 0) || !(canvasCssHeight > 0)) {
      instanceCount = 0;
      return;
    }

    const plotWidthCss = canvasCssWidth - gridArea.left - gridArea.right;
    const plotHeightCss = canvasCssHeight - gridArea.top - gridArea.bottom;
    if (!(plotWidthCss > 0) || !(plotHeightCss > 0)) {
      instanceCount = 0;
      return;
    }

    const maxRadiusCss = 0.5 * Math.min(plotWidthCss, plotHeightCss);
    if (!(maxRadiusCss > 0)) {
      instanceCount = 0;
      return;
    }

    // Center specified in plot-local CSS px (or %), then shifted by GridArea CSS margins.
    const centerPlotCss = resolveCenterPlotCss(seriesConfig.center, plotWidthCss, plotHeightCss);
    const centerCanvasCssX = gridArea.left + centerPlotCss.x;
    const centerCanvasCssY = gridArea.top + centerPlotCss.y;

    // Instance center is in clip space; VS transform is identity.
    const centerClipX = (centerCanvasCssX / canvasCssWidth) * 2 - 1;
    const centerClipY = 1 - (centerCanvasCssY / canvasCssHeight) * 2;
    if (!Number.isFinite(centerClipX) || !Number.isFinite(centerClipY)) {
      instanceCount = 0;
      return;
    }

    // Radii specified in CSS px (or % of max radius), converted to device px for the shader.
    const radiiCss = resolveRadiiCss(seriesConfig.radius, maxRadiusCss);
    const innerCss = Math.max(0, Math.min(radiiCss.inner, radiiCss.outer));
    const outerCss = Math.max(innerCss, radiiCss.outer);
    const innerPx = innerCss * dpr;
    const outerPx = outerCss * dpr;
    if (!(outerPx > 0)) {
      instanceCount = 0;
      return;
    }

    // Total positive value for angle allocation.
    let total = 0;
    let validCount = 0;
    for (let i = 0; i < seriesConfig.data.length; i++) {
      const v = seriesConfig.data[i]?.value;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        total += v;
        validCount++;
      }
    }
    if (!(total > 0) || validCount === 0) {
      instanceCount = 0;
      return;
    }

    ensureCpuInstanceCapacityFloats(validCount * INSTANCE_STRIDE_FLOATS);
    const f32 = cpuInstanceStagingF32;

    // IMPORTANT: shader assumes start/end are already wrapped to [0, 2π) (it only adds TAU once).
    const startDeg =
      typeof seriesConfig.startAngle === 'number' && Number.isFinite(seriesConfig.startAngle) ? seriesConfig.startAngle : 90;
    let current = wrapToTau((startDeg * Math.PI) / 180);

    // Make the last slice close the circle (reduces float drift).
    let accumulated = 0;
    let outFloats = 0;
    let emitted = 0;

    for (let i = 0; i < seriesConfig.data.length; i++) {
      const item = seriesConfig.data[i];
      const v = item?.value;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;

      emitted++;
      const isLast = emitted === validCount;

      const frac = v / total;
      let span = frac * TAU;
      if (isLast) {
        span = Math.max(0, TAU - accumulated);
      } else {
        // Keep accumulated stable and avoid pathological spans from weird inputs.
        span = Math.max(0, Math.min(TAU, span));
      }
      accumulated += span;
      if (!(span > 0)) continue;

      const startRad = current;
      const endRad = wrapToTau(current + span);
      current = endRad;

      const [r, g, b, a] = parseColor(item.color, seriesConfig.color);

      f32[outFloats + 0] = centerClipX;
      f32[outFloats + 1] = centerClipY;
      f32[outFloats + 2] = startRad;
      f32[outFloats + 3] = endRad;
      f32[outFloats + 4] = innerPx;
      f32[outFloats + 5] = outerPx;
      f32[outFloats + 6] = r;
      f32[outFloats + 7] = g;
      f32[outFloats + 8] = b;
      f32[outFloats + 9] = a;
      outFloats += INSTANCE_STRIDE_FLOATS;
    }

    instanceCount = outFloats / INSTANCE_STRIDE_FLOATS;
    const requiredBytes = Math.max(4, instanceCount * INSTANCE_STRIDE_BYTES);

    if (!instanceBuffer || instanceBuffer.size < requiredBytes) {
      const grownBytes = Math.max(Math.max(4, nextPow2(requiredBytes)), instanceBuffer ? instanceBuffer.size : 0);
      if (instanceBuffer) {
        try {
          instanceBuffer.destroy();
        } catch {
          // best-effort
        }
      }
      instanceBuffer = device.createBuffer({
        label: 'pieRenderer/instanceBuffer',
        size: grownBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    if (instanceBuffer && instanceCount > 0) {
      device.queue.writeBuffer(instanceBuffer, 0, cpuInstanceStagingBuffer, 0, instanceCount * INSTANCE_STRIDE_BYTES);
    }
  };

  const render: PieRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (!instanceBuffer || instanceCount === 0) return;

    // Clip to plot area (scissor is in device pixels).
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(lastScissor.x, lastScissor.y, lastScissor.w, lastScissor.h);
    }

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, instanceBuffer);
    passEncoder.draw(6, instanceCount);

    // Reset scissor to full canvas to avoid impacting later renderers.
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    }
  };

  const dispose: PieRenderer['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    if (instanceBuffer) {
      try {
        instanceBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    instanceBuffer = null;
    instanceCount = 0;

    try {
      vsUniformBuffer.destroy();
    } catch {
      // best-effort
    }

    lastCanvasWidth = 0;
    lastCanvasHeight = 0;
    lastScissor = null;
  };

  return { prepare, render, dispose };
}

