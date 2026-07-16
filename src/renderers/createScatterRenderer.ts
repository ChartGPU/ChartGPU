import scatterWgsl from '../shaders/scatter.wgsl?raw';
import type { ResolvedScatterSeriesConfig } from '../config/OptionResolver';
import type { CartesianSeriesData } from '../config/types';
import type { LinearScale } from '../utils/scales';
import { parseCssColorToRgba01 } from '../utils/colors';
import type { GridArea } from './createGridRenderer';
import { createRenderPipeline, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import { getPointCount, getX, getY, getSize, hasAnyPerPointSize } from '../data/cartesianData';
import type { PipelineCache } from '../core/PipelineCache';
import { resolveUploadPolicy } from '../data/seriesResidency';
import {
  isYOnlyRewriteAgainstXStaging,
  packYOnlyChannel,
} from '../data/seriesRewriteDetect';

export interface ScatterRenderer {
  prepare(
    seriesConfig: ResolvedScatterSeriesConfig,
    data: CartesianSeriesData,
    xScale: LinearScale,
    yScale: LinearScale,
    gridArea?: GridArea
  ): void;
  /**
   * Drop cached instance geometry so the next `prepare` re-packs.
   * Required when values mutate under a stable data array reference
   * (update-transition interpolation — same rule as bar/area).
   */
  invalidateGeometry(): void;
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
type DataPointLike = { readonly x: number; readonly y: number };

const DEFAULT_TARGET_FORMAT: GPUTextureFormat = 'bgra8unorm';
const DEFAULT_SCATTER_RADIUS_CSS_PX = 4;
/** Per-instance radius layout: center.xy, radiusPx, pad */
const INSTANCE_STRIDE_BYTES = 16;
const INSTANCE_STRIDE_FLOATS = INSTANCE_STRIDE_BYTES / 4;
/** Constant-radius dual-buffer: separate x and y channels (radius in VS uniform) */
const CONST_CHANNEL_STRIDE_BYTES = 4;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

const parseSeriesColorToRgba01 = (color: string): Rgba => parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

const computeClipAffineFromScale = (
  scale: LinearScale,
  v0: number,
  v1: number
): { readonly a: number; readonly b: number } => {
  const p0 = scale.scale(v0);
  const p1 = scale.scale(v1);

  // If the domain sample is degenerate or non-finite, fall back to constant output.
  if (!Number.isFinite(v0) || !Number.isFinite(v1) || v0 === v1 || !Number.isFinite(p0) || !Number.isFinite(p1)) {
    return { a: 0, b: Number.isFinite(p0) ? p0 : 0 };
  }

  const a = (p1 - p0) / (v1 - v0);
  const b = p0 - a * v0;
  return { a: Number.isFinite(a) ? a : 0, b: Number.isFinite(b) ? b : 0 };
};

const writeTransformMat4F32 = (out: Float32Array, ax: number, bx: number, ay: number, by: number): void => {
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
  gridArea: GridArea
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

  const scissorX = clampInt(Math.floor(plotLeftDevice), 0, Math.max(0, canvasWidth));
  const scissorY = clampInt(Math.floor(plotTopDevice), 0, Math.max(0, canvasHeight));
  const scissorR = clampInt(Math.ceil(plotRightDevice), 0, Math.max(0, canvasWidth));
  const scissorB = clampInt(Math.ceil(plotBottomDevice), 0, Math.max(0, canvasHeight));
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
};

export function createScatterRenderer(device: GPUDevice, options?: ScatterRendererOptions): ScatterRenderer {
  let disposed = false;
  const targetFormat = options?.targetFormat ?? DEFAULT_TARGET_FORMAT;
  // Be resilient: coerce invalid values to 1 (no MSAA).
  const sampleCountRaw = options?.sampleCount ?? 1;
  const sampleCount = Number.isFinite(sampleCountRaw) ? Math.max(1, Math.floor(sampleCountRaw)) : 1;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  });

  // VSUniforms: mat4x4 (64) + viewportPx vec2 (8) + radiusPx f32 (4) + pad (4) = 80 bytes.
  const vsUniformBuffer = createUniformBuffer(device, 80, {
    label: 'scatterRenderer/vsUniforms',
  });
  const fsUniformBuffer = createUniformBuffer(device, 16, {
    label: 'scatterRenderer/fsUniforms',
  });

  // Reused CPU-side staging for uniform writes (avoid per-frame allocations).
  const vsUniformScratchBuffer = new ArrayBuffer(80);
  const vsUniformScratchF32 = new Float32Array(vsUniformScratchBuffer);
  const fsUniformScratchF32 = new Float32Array(4);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vsUniformBuffer } },
      { binding: 1, resource: { buffer: fsUniformBuffer } },
    ],
  });

  const blendState = {
    color: {
      operation: 'add' as const,
      srcFactor: 'src-alpha' as const,
      dstFactor: 'one-minus-src-alpha' as const,
    },
    alpha: {
      operation: 'add' as const,
      srcFactor: 'one' as const,
      dstFactor: 'one-minus-src-alpha' as const,
    },
  };

  // Per-instance radius (variable symbolSize / per-point size).
  const pipeline = createRenderPipeline(
    device,
    {
      label: 'scatterRenderer/pipeline',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: scatterWgsl,
        label: 'scatter.wgsl',
        entryPoint: 'vsMain',
        buffers: [
          {
            arrayStride: INSTANCE_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, format: 'float32x2', offset: 0 },
              { shaderLocation: 1, format: 'float32', offset: 8 },
            ],
          },
        ],
      },
      fragment: {
        code: scatterWgsl,
        label: 'scatter.wgsl',
        formats: targetFormat,
        blend: blendState,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  // Constant radius dual-buffer: x and y in separate instance streams so equal-N
  // y-only rewrites upload only N×4 y bytes (Option A).
  const pipelineConstRadius = createRenderPipeline(
    device,
    {
      label: 'scatterRenderer/pipelineConstRadiusSplit',
      bindGroupLayouts: [bindGroupLayout],
      vertex: {
        code: scatterWgsl,
        label: 'scatter.wgsl',
        entryPoint: 'vsMainConstRadiusSplit',
        buffers: [
          {
            arrayStride: CONST_CHANNEL_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 0, format: 'float32', offset: 0 }],
          },
          {
            arrayStride: CONST_CHANNEL_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 1, format: 'float32', offset: 0 }],
          },
        ],
      },
      fragment: {
        code: scatterWgsl,
        label: 'scatter.wgsl',
        formats: targetFormat,
        blend: blendState,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: sampleCount },
    },
    pipelineCache
  );

  /** Variable-radius interleaved instance buffer (x,y,r,pad). */
  let instanceBuffer: GPUBuffer | null = null;
  /** Const-radius dual buffers. */
  let xInstanceBuffer: GPUBuffer | null = null;
  let yInstanceBuffer: GPUBuffer | null = null;
  let instanceCount = 0;
  /** True when the last prepare used the constant-radius (dual-buffer) path. */
  let useConstRadiusPipeline = false;
  let lastConstRadiusDevicePx = 0;
  let cpuInstanceStagingBuffer = new ArrayBuffer(0);
  let cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  let cpuXStagingBuffer = new ArrayBuffer(0);
  let cpuXStagingF32 = new Float32Array(cpuXStagingBuffer);
  let cpuYStagingBuffer = new ArrayBuffer(0);
  let cpuYStagingF32 = new Float32Array(cpuYStagingBuffer);

  // Geometry identity cache (issue 1.2): domain-space instances + size mode.
  // Pure pan/zoom only updates VS/FS uniforms; skip instance writeBuffer.
  let boundDataRef: CartesianSeriesData | null = null;
  let boundSizeMode: 'const' | 'variable' | null = null;
  /** Const-radius CSS size (layout signature). */
  let boundConstRadiusCss: number | null = null;
  /** DPR for variable-radius path (radius packed in device px). */
  let boundDpr = Number.NaN;
  /** Last const-radius dense point count (for y-only equal-N gate). */
  let boundConstPointCount = 0;

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
    if (disposed) throw new Error('ScatterRenderer is disposed.');
  };

  const ensureCpuInstanceCapacityFloats = (requiredFloats: number): void => {
    if (requiredFloats <= cpuInstanceStagingF32.length) return;
    const nextFloats = Math.max(8, nextPow2(requiredFloats));
    cpuInstanceStagingBuffer = new ArrayBuffer(nextFloats * 4);
    cpuInstanceStagingF32 = new Float32Array(cpuInstanceStagingBuffer);
  };

  const ensureCpuChannelCapacity = (requiredFloats: number): void => {
    if (requiredFloats > cpuXStagingF32.length) {
      const nextFloats = Math.max(8, nextPow2(requiredFloats));
      cpuXStagingBuffer = new ArrayBuffer(nextFloats * 4);
      cpuXStagingF32 = new Float32Array(cpuXStagingBuffer);
    }
    if (requiredFloats > cpuYStagingF32.length) {
      const nextFloats = Math.max(8, nextPow2(requiredFloats));
      cpuYStagingBuffer = new ArrayBuffer(nextFloats * 4);
      cpuYStagingF32 = new Float32Array(cpuYStagingBuffer);
    }
  };

  const ensureGpuChannelBuffers = (requiredBytes: number): void => {
    const grownBytes = Math.max(Math.max(4, nextPow2(requiredBytes)), xInstanceBuffer ? xInstanceBuffer.size : 0);
    if (!xInstanceBuffer || xInstanceBuffer.size < requiredBytes) {
      if (xInstanceBuffer) {
        try {
          xInstanceBuffer.destroy();
        } catch {
          // best-effort
        }
      }
      xInstanceBuffer = device.createBuffer({
        label: 'scatterRenderer/xInstanceBuffer',
        size: grownBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (!yInstanceBuffer || yInstanceBuffer.size < requiredBytes) {
      const yGrown = Math.max(Math.max(4, nextPow2(requiredBytes)), yInstanceBuffer ? yInstanceBuffer.size : 0);
      if (yInstanceBuffer) {
        try {
          yInstanceBuffer.destroy();
        } catch {
          // best-effort
        }
      }
      yInstanceBuffer = device.createBuffer({
        label: 'scatterRenderer/yInstanceBuffer',
        size: yGrown,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
  };

  const writeVsUniforms = (
    ax: number,
    bx: number,
    ay: number,
    by: number,
    viewportW: number,
    viewportH: number,
    radiusDevicePx: number
  ): void => {
    const w = Number.isFinite(viewportW) && viewportW > 0 ? viewportW : 1;
    const h = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : 1;

    writeTransformMat4F32(vsUniformScratchF32, ax, bx, ay, by);
    vsUniformScratchF32[16] = w;
    vsUniformScratchF32[17] = h;
    vsUniformScratchF32[18] = radiusDevicePx;
    vsUniformScratchF32[19] = 0;
    writeUniformBuffer(device, vsUniformBuffer, vsUniformScratchBuffer);

    lastViewportPx = [w, h];
  };

  const prepare: ScatterRenderer['prepare'] = (seriesConfig, data, xScale, yScale, gridArea) => {
    assertNotDisposed();

    // Linear scales: affine is independent of data bounds — sample at 0 and 1
    // (same pattern as overlay memo / bar domain pack). Avoids O(n) bounds scan
    // every full rewrite frame.
    const { a: ax, b: bx } = computeClipAffineFromScale(xScale, 0, 1);
    const { a: ay, b: by } = computeClipAffineFromScale(yScale, 0, 1);

    const dpr = gridArea?.devicePixelRatio ?? 1;
    const hasValidDpr = dpr > 0 && Number.isFinite(dpr);

    const seriesSymbolSize = seriesConfig.symbolSize;
    // Scratch tuple for symbolSize function: reuse to avoid per-point allocations
    const scratchTuple: [number, number, number | undefined] = [0, 0, undefined];

    const constantSymbolSizeCss =
      typeof seriesSymbolSize === 'number' && Number.isFinite(seriesSymbolSize)
        ? seriesSymbolSize
        : typeof seriesSymbolSize === 'function'
          ? null
          : DEFAULT_SCATTER_RADIUS_CSS_PX;

    const getSeriesSizeCssPx =
      typeof seriesSymbolSize === 'function'
        ? (x: number, y: number, size: number | undefined): number => {
            scratchTuple[0] = x;
            scratchTuple[1] = y;
            scratchTuple[2] = size;
            const v = seriesSymbolSize(scratchTuple);
            return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_SCATTER_RADIUS_CSS_PX;
          }
        : constantSymbolSizeCss != null
          ? (_x: number, _y: number, _size: number | undefined): number => constantSymbolSizeCss
          : (_x: number, _y: number, _size: number | undefined): number => DEFAULT_SCATTER_RADIUS_CSS_PX;

    const count = getPointCount(data);

    // Constant series.symbolSize and no per-point size channel → xy-only instances
    // (radius in VS uniform). Halves upload bandwidth for SciChart groups 2/4.
    // Size detection matches getSize semantics: tuples [x,y,size], object.size,
    // XYArraysData.size, and sparse size on later points (not only data[0]).
    const constantRadiusDevicePx =
      constantSymbolSizeCss != null ? (hasValidDpr ? constantSymbolSizeCss * dpr : constantSymbolSizeCss) : null;
    const useConstRadius = constantRadiusDevicePx != null && constantRadiusDevicePx > 0 && !hasAnyPerPointSize(data);

    useConstRadiusPipeline = useConstRadius;
    lastConstRadiusDevicePx = useConstRadius ? constantRadiusDevicePx! : 0;

    const viewportW = gridArea?.canvasWidth ?? lastViewportPx[0];
    const viewportH = gridArea?.canvasHeight ?? lastViewportPx[1];
    if (gridArea) {
      lastCanvasWidth = gridArea.canvasWidth;
      lastCanvasHeight = gridArea.canvasHeight;
      lastScissor = computePlotScissorDevicePx(gridArea);
    } else {
      lastScissor = null;
    }
    writeVsUniforms(ax, bx, ay, by, viewportW, viewportH, lastConstRadiusDevicePx);

    const [r, g, b, a] = parseSeriesColorToRgba01(seriesConfig.color);
    fsUniformScratchF32[0] = r;
    fsUniformScratchF32[1] = g;
    fsUniformScratchF32[2] = b;
    fsUniformScratchF32[3] = clamp01(a);
    writeUniformBuffer(device, fsUniformBuffer, fsUniformScratchF32);

    // Geometry identity skip: same data ref + size layout → uniforms only.
    // Policy verb shared with line/DataStore via seriesResidency (issue 3.4 / 2.2).
    const sizeMode: 'const' | 'variable' = useConstRadius ? 'const' : 'variable';
    const hasGeometryBuffers = useConstRadius
      ? xInstanceBuffer != null && yInstanceBuffer != null
      : instanceBuffer != null;
    const geometryHit =
      boundDataRef === data &&
      boundSizeMode === sizeMode &&
      hasGeometryBuffers &&
      (useConstRadius ? boundConstRadiusCss === constantSymbolSizeCss : boundDpr === dpr);

    // Equal-N y-only: dense const-radius pack where x matches prior staging.
    // Brownian (x moves) fails isYOnlyRewriteAgainstXStaging → fullRewrite.
    const yOnlyCandidate =
      useConstRadius &&
      boundSizeMode === 'const' &&
      hasGeometryBuffers &&
      boundConstPointCount > 0 &&
      count === boundConstPointCount &&
      count === instanceCount &&
      isYOnlyRewriteAgainstXStaging(data, cpuXStagingF32, boundConstPointCount);

    const policy = resolveUploadPolicy({
      residency: {
        kind: 'privateInstance',
        gpuBuffer: useConstRadius ? yInstanceBuffer : instanceBuffer,
        pointCount: instanceCount,
        contentVersion: 0,
        lastRef: boundDataRef,
      },
      dataRef: data,
      geometryCacheHit: geometryHit,
      appendedThisFrame: false,
      needsGrowth: false,
      yOnlyRewrite: yOnlyCandidate,
    });
    if (policy === 'skip') {
      return;
    }

    if (policy === 'yOnlyRewrite' && useConstRadius) {
      // Option A: pack + write only y channel (N×4 bytes). X GPU buffer stays put.
      // Non-finite y → fall through to full pack (sparse path; match full-rewrite
      // gap semantics instead of drawing NaN clip centers).
      ensureCpuChannelCapacity(count);
      const yChanged = packYOnlyChannel(cpuYStagingF32, data, count);
      if (yChanged !== null) {
        if (yChanged && yInstanceBuffer && count > 0) {
          device.queue.writeBuffer(yInstanceBuffer, 0, cpuYStagingBuffer, 0, count * CONST_CHANNEL_STRIDE_BYTES);
        }
        boundDataRef = data;
        boundSizeMode = sizeMode;
        boundConstRadiusCss = constantSymbolSizeCss;
        boundDpr = dpr;
        boundConstPointCount = count;
        return;
      }
      // yChanged === null: non-finite y present — full dual-buffer rewrite below.
    }

    if (useConstRadius) {
      // Full dual-buffer pack: dense when all points finite (enables y-only next
      // frame); sparse/gapped packs only finite pairs and clears boundConstPointCount
      // so y-only stays disabled until a dense full rewrite.
      ensureCpuChannelCapacity(count);
      const xs = cpuXStagingF32;
      const ys = cpuYStagingF32;
      let dense = true;
      if (Array.isArray(data)) {
        const arr = data as ReadonlyArray<readonly [number, number] | DataPointLike | null>;
        for (let i = 0; i < count; i++) {
          const p = arr[i];
          if (p == null || typeof p !== 'object') {
            dense = false;
            break;
          }
          let x: number;
          let y: number;
          if (Array.isArray(p)) {
            x = p[0] as number;
            y = p[1] as number;
          } else {
            x = (p as DataPointLike).x;
            y = (p as DataPointLike).y;
          }
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            dense = false;
            break;
          }
          xs[i] = x;
          ys[i] = y;
        }
      } else if (data instanceof Float32Array) {
        const n = Math.floor(data.length / 2);
        if (n !== count) dense = false;
        for (let i = 0; i < count && dense; i++) {
          const x = data[i * 2]!;
          const y = data[i * 2 + 1]!;
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            dense = false;
            break;
          }
          xs[i] = x;
          ys[i] = y;
        }
      } else {
        for (let i = 0; i < count; i++) {
          const x = getX(data, i);
          const y = getY(data, i);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            dense = false;
            break;
          }
          xs[i] = x;
          ys[i] = y;
        }
      }

      if (!dense) {
        // Sparse / gapped: pack only finite pairs (y-only path disabled next frame).
        let out = 0;
        for (let i = 0; i < count; i++) {
          const x = getX(data, i);
          const y = getY(data, i);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          xs[out] = x;
          ys[out] = y;
          out++;
        }
        instanceCount = out;
        boundConstPointCount = 0; // disable y-only until a dense full rewrite
      } else {
        instanceCount = count;
        boundConstPointCount = count;
      }

      const requiredBytes = Math.max(4, instanceCount * CONST_CHANNEL_STRIDE_BYTES);
      ensureGpuChannelBuffers(requiredBytes);
      if (xInstanceBuffer && yInstanceBuffer && instanceCount > 0) {
        const byteLen = instanceCount * CONST_CHANNEL_STRIDE_BYTES;
        device.queue.writeBuffer(xInstanceBuffer, 0, cpuXStagingBuffer, 0, byteLen);
        device.queue.writeBuffer(yInstanceBuffer, 0, cpuYStagingBuffer, 0, byteLen);
      }
    } else {
      ensureCpuInstanceCapacityFloats(count * INSTANCE_STRIDE_FLOATS);
      const f32 = cpuInstanceStagingF32;
      let outFloats = 0;
      for (let i = 0; i < count; i++) {
        const x = getX(data, i);
        const y = getY(data, i);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

        // Per-point size from data overrides series.symbolSize
        const pointSize = getSize(data, i);
        const sizeCss = pointSize ?? getSeriesSizeCssPx(x, y, pointSize);
        const radiusCss = Number.isFinite(sizeCss) ? Math.max(0, sizeCss) : DEFAULT_SCATTER_RADIUS_CSS_PX;
        const radiusDevicePx = hasValidDpr ? radiusCss * dpr : radiusCss;
        if (!(radiusDevicePx > 0)) continue;

        f32[outFloats + 0] = x;
        f32[outFloats + 1] = y;
        f32[outFloats + 2] = radiusDevicePx;
        f32[outFloats + 3] = 0; // pad
        outFloats += INSTANCE_STRIDE_FLOATS;
      }
      instanceCount = outFloats / INSTANCE_STRIDE_FLOATS;
      boundConstPointCount = 0;

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
          label: 'scatterRenderer/instanceBuffer',
          size: grownBytes,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }

      if (instanceBuffer && instanceCount > 0) {
        device.queue.writeBuffer(instanceBuffer, 0, cpuInstanceStagingBuffer, 0, instanceCount * INSTANCE_STRIDE_BYTES);
      }
    }

    boundDataRef = data;
    boundSizeMode = sizeMode;
    boundConstRadiusCss = useConstRadius ? constantSymbolSizeCss : null;
    boundDpr = dpr;
  };

  const invalidateGeometry: ScatterRenderer['invalidateGeometry'] = () => {
    boundDataRef = null;
    boundSizeMode = null;
    boundConstRadiusCss = null;
    boundDpr = Number.NaN;
    boundConstPointCount = 0;
  };

  const render: ScatterRenderer['render'] = (passEncoder) => {
    assertNotDisposed();
    if (instanceCount === 0) return;

    // Clip to plot area when available.
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(lastScissor.x, lastScissor.y, lastScissor.w, lastScissor.h);
    }

    if (useConstRadiusPipeline) {
      if (!xInstanceBuffer || !yInstanceBuffer) return;
      passEncoder.setPipeline(pipelineConstRadius);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.setVertexBuffer(0, xInstanceBuffer);
      passEncoder.setVertexBuffer(1, yInstanceBuffer);
    } else {
      if (!instanceBuffer) return;
      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.setVertexBuffer(0, instanceBuffer);
    }
    passEncoder.draw(6, instanceCount);

    // Reset scissor to full canvas to avoid impacting later renderers.
    if (lastScissor && lastCanvasWidth > 0 && lastCanvasHeight > 0) {
      passEncoder.setScissorRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    }
  };

  const dispose: ScatterRenderer['dispose'] = () => {
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
    if (xInstanceBuffer) {
      try {
        xInstanceBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    xInstanceBuffer = null;
    if (yInstanceBuffer) {
      try {
        yInstanceBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    yInstanceBuffer = null;
    instanceCount = 0;

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
    boundDataRef = null;
    boundSizeMode = null;
    boundConstRadiusCss = null;
    boundDpr = Number.NaN;
    boundConstPointCount = 0;
  };

  return { prepare, invalidateGeometry, render, dispose };
}
