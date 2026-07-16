/**
 * Bar geometry identity cache: pack instances in domain space; skip instance
 * writeBuffer when data ref + domain layout are stable (axes-only y-range ticks).
 * Rebuild on new ref, baseline flip, px width x-scale change, or invalidateGeometry.
 */

/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedBarSeriesConfig } from '../../config/OptionResolver';
import type { DataPoint } from '../../config/types';
import type { GridArea } from '../createGridRenderer';
import type { DataStore } from '../../data/createDataStore';

beforeAll(() => {
  // @ts-ignore
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  // @ts-ignore
  globalThis.GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
});

import { createBarRenderer } from '../createBarRenderer';
import { writeUniformBuffer } from '../rendererUtils';

vi.mock('../rendererUtils', () => ({
  createRenderPipeline: vi.fn(() => ({})),
  createUniformBuffer: vi.fn(() => ({ destroy: vi.fn() })),
  writeUniformBuffer: vi.fn(),
}));

const writeUniformBufferMock = writeUniformBuffer as ReturnType<typeof vi.fn>;

function createMockDevice(limits?: Partial<GPUSupportedLimits>) {
  const device = {
    label: 'mockDevice',
    limits: {
      maxUniformBufferBindingSize: 65536,
      minUniformBufferOffsetAlignment: 256,
      maxBufferSize: 256 * 1024 * 1024,
      ...limits,
    },
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
    createBuffer: vi.fn((desc?: GPUBufferDescriptor) => ({
      destroy: vi.fn(),
      size: desc?.size ?? 256 * 1024,
      label: desc?.label ?? '',
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
  } as unknown as GPUDevice;
  return device;
}

function barConfig(
  data: ReadonlyArray<DataPoint>,
  extra: Partial<ResolvedBarSeriesConfig> = {}
): ResolvedBarSeriesConfig {
  return {
    type: 'bar',
    name: 'b',
    data,
    rawData: data,
    color: '#0af',
    sampling: 'none',
    samplingThreshold: 5000,
    yAxis: 'y',
    visible: true,
    ...extra,
  } as ResolvedBarSeriesConfig;
}

function gridArea(overrides: Partial<GridArea> = {}): GridArea {
  return {
    left: 40,
    right: 20,
    top: 20,
    bottom: 40,
    canvasWidth: 800,
    canvasHeight: 600,
    devicePixelRatio: 1,
    ...overrides,
  };
}

/** Plot clip-space edges for `gridArea()` — scale.range must match so invert(plot) = domain. */
function plotClipFor(ga: GridArea): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const plotLeft = ga.left * ga.devicePixelRatio;
  const plotRight = ga.canvasWidth - ga.right * ga.devicePixelRatio;
  const plotTop = ga.top * ga.devicePixelRatio;
  const plotBottom = ga.canvasHeight - ga.bottom * ga.devicePixelRatio;
  return {
    left: (plotLeft / ga.canvasWidth) * 2 - 1,
    right: (plotRight / ga.canvasWidth) * 2 - 1,
    top: 1 - (plotTop / ga.canvasHeight) * 2,
    bottom: 1 - (plotBottom / ga.canvasHeight) * 2,
  };
}

/** Read packed instance floats from the last queue.writeBuffer call. */
function lastInstanceFloats(writeBuffer: ReturnType<typeof vi.fn>): Float32Array {
  const call = writeBuffer.mock.calls[writeBuffer.mock.calls.length - 1];
  expect(call).toBeTruthy();
  const staging = call[2] as ArrayBuffer;
  const byteOffset = (call[3] as number) ?? 0;
  const byteLength = call[4] as number;
  return new Float32Array(staging, byteOffset, byteLength / 4);
}

const emptyDataStore = {} as DataStore;
const INSTANCE_STRIDE_BYTES = 32;

beforeEach(() => {
  writeUniformBufferMock.mockClear();
});

describe('createBarRenderer uniform dirty-skip (issue 2.5)', () => {
  it('skips uniform writes on second prepare with identical inputs; scale change writes', () => {
    const device = createMockDevice();
    writeUniformBufferMock.mockClear();
    const renderer = createBarRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 0],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScale = createLinearScale().domain(0, 2).range(clip.left, clip.right);
    const yScale = createLinearScale().domain(0, 2).range(clip.bottom, clip.top);
    const cfg = barConfig(data);

    renderer.prepare([cfg], emptyDataStore, xScale, yScale, ga);
    const afterFirst = writeUniformBufferMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    writeUniformBufferMock.mockClear();
    renderer.prepare([cfg], emptyDataStore, xScale, yScale, ga);
    expect(writeUniformBufferMock).not.toHaveBeenCalled();

    writeUniformBufferMock.mockClear();
    const y2 = createLinearScale().domain(-1, 3).range(clip.bottom, clip.top);
    renderer.prepare([cfg], emptyDataStore, xScale, y2, ga);
    expect(writeUniformBufferMock.mock.calls.length).toBeGreaterThan(0);
    renderer.dispose();
  });
});

describe('createBarRenderer geometry cache', () => {
  it('skips instance writeBuffer on second prepare with same data ref (axes-only y domain)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 0],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    // Scale ranges match plot clip so baseline uses true y domain (both include 0).
    const xScale = createLinearScale().domain(0, 2).range(clip.left, clip.right);
    const yScaleA = createLinearScale().domain(0, 2).range(clip.bottom, clip.top);
    const yScaleB = createLinearScale().domain(-1, 3).range(clip.bottom, clip.top);
    const cfg = barConfig(data);

    renderer.prepare([cfg], emptyDataStore, xScale, yScaleA, ga);
    // Uniforms go through mocked writeUniformBuffer; queue.writeBuffer is instance-only.
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(writeBuffer.mock.calls[0][4]).toBe(3 * INSTANCE_STRIDE_BYTES);
    const uniformsAfterFirst = writeUniformBufferMock.mock.calls.length;
    expect(uniformsAfterFirst).toBeGreaterThanOrEqual(1);

    // Axes-only: new y scale (still includes 0 → same baselineDomain), same data identity.
    renderer.prepare([cfg], emptyDataStore, xScale, yScaleB, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    // Uniforms must still refresh on the cache hit.
    expect(writeUniformBufferMock.mock.calls.length).toBeGreaterThan(uniformsAfterFirst);

    renderer.dispose();
  });

  it('re-uploads instances when data reference changes', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const data1: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 0],
    ];
    const data2: DataPoint[] = [
      [0, 9],
      [1, 8],
      [2, 7],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScale = createLinearScale().domain(0, 2).range(clip.left, clip.right);
    const yScale = createLinearScale().domain(0, 10).range(clip.bottom, clip.top);

    renderer.prepare([barConfig(data1)], emptyDataStore, xScale, yScale, ga);
    renderer.prepare([barConfig(data2)], emptyDataStore, xScale, yScale, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    expect(writeBuffer.mock.calls[1][4]).toBe(3 * INSTANCE_STRIDE_BYTES);
    renderer.dispose();
  });

  it('re-uploads after invalidateGeometry even with same data ref', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScale = createLinearScale().domain(0, 2).range(clip.left, clip.right);
    const yScale = createLinearScale().domain(0, 3).range(clip.bottom, clip.top);
    const cfg = barConfig(data);

    renderer.prepare([cfg], emptyDataStore, xScale, yScale, ga);
    // Mutate under stable ref (interpolation contract).
    (data[1] as [number, number])[1] = 99;
    renderer.invalidateGeometry();
    renderer.prepare([cfg], emptyDataStore, xScale, yScale, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('re-uploads when baselineDomain flips (0 leaves visible y range)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const data: DataPoint[] = [
      [0, 2],
      [1, 3],
      [2, 4],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScale = createLinearScale().domain(0, 2).range(clip.left, clip.right);
    // 0 in range → baseline 0; then all-positive range → baseline = yMin (1).
    const yScaleWithZero = createLinearScale().domain(0, 5).range(clip.bottom, clip.top);
    const yScaleAboveZero = createLinearScale().domain(1, 5).range(clip.bottom, clip.top);
    const cfg = barConfig(data);

    renderer.prepare([cfg], emptyDataStore, xScale, yScaleWithZero, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    renderer.prepare([cfg], emptyDataStore, xScale, yScaleAboveZero, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('CSS-px barWidth: re-packs on x-scale change, skips on y-only change', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScaleA = createLinearScale().domain(0, 2).range(clip.left, clip.right);
    const xScaleB = createLinearScale().domain(0, 4).range(clip.left, clip.right);
    const yScaleA = createLinearScale().domain(0, 5).range(clip.bottom, clip.top);
    const yScaleB = createLinearScale().domain(-1, 6).range(clip.bottom, clip.top);
    const cfg = barConfig(data, { barWidth: 20 });

    renderer.prepare([cfg], emptyDataStore, xScaleA, yScaleA, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);

    // Pure y change: px domain width independent of y → skip.
    renderer.prepare([cfg], emptyDataStore, xScaleA, yScaleB, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);

    // X domain change: px→domain conversion depends on ax → re-upload.
    renderer.prepare([cfg], emptyDataStore, xScaleB, yScaleB, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('x-scale-only with auto and percent widths stays uniform-only', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 1],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScaleA = createLinearScale().domain(0, 2).range(clip.left, clip.right);
    const xScaleB = createLinearScale().domain(-1, 3).range(clip.left, clip.right);
    const yScale = createLinearScale().domain(0, 3).range(clip.bottom, clip.top);

    const autoCfg = barConfig(data);
    renderer.prepare([autoCfg], emptyDataStore, xScaleA, yScale, ga);
    renderer.prepare([autoCfg], emptyDataStore, xScaleB, yScale, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);

    writeBuffer.mockClear();
    renderer.invalidateGeometry();
    const pctCfg = barConfig(data, { barWidth: '50%' });
    renderer.prepare([pctCfg], emptyDataStore, xScaleA, yScale, ga);
    renderer.prepare([pctCfg], emptyDataStore, xScaleB, yScale, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('clustered multi-series: axes-only skip and distinct left offsets', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const dataA: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const dataB: DataPoint[] = [
      [0, 3],
      [1, 1],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScale = createLinearScale().domain(0, 1).range(clip.left, clip.right);
    const yScaleA = createLinearScale().domain(0, 5).range(clip.bottom, clip.top);
    const yScaleB = createLinearScale().domain(-1, 6).range(clip.bottom, clip.top);
    const series = [barConfig(dataA, { color: '#f00' }), barConfig(dataB, { color: '#0f0' })];

    renderer.prepare(series, emptyDataStore, xScale, yScaleA, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(writeBuffer.mock.calls[0][4]).toBe(4 * INSTANCE_STRIDE_BYTES);

    const f32 = lastInstanceFloats(writeBuffer);
    // Instances: seriesA@0, seriesA@1, seriesB@0, seriesB@1 — left at float[0] and float[16].
    const leftA0 = f32[0];
    const leftB0 = f32[2 * 8]; // third instance = series B first point
    expect(leftA0).not.toBe(leftB0);

    renderer.prepare(series, emptyDataStore, xScale, yScaleB, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('packs stacked series domain heights correctly and skips re-upload on y-scale change', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const dataA: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const dataB: DataPoint[] = [
      [0, 3],
      [1, 1],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScale = createLinearScale().domain(0, 1).range(clip.left, clip.right);
    const yScaleA = createLinearScale().domain(0, 5).range(clip.bottom, clip.top);
    const yScaleB = createLinearScale().domain(-2, 8).range(clip.bottom, clip.top);
    const series = [barConfig(dataA, { stack: 's1', color: '#f00' }), barConfig(dataB, { stack: 's1', color: '#0f0' })];

    renderer.prepare(series, emptyDataStore, xScale, yScaleA, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(writeBuffer.mock.calls[0][4]).toBe(4 * INSTANCE_STRIDE_BYTES);

    const f32 = lastInstanceFloats(writeBuffer);
    // Stride 8 floats: [left, base, width, height, r, g, b, a]
    // Series A x=0: base=0, height=1
    expect(f32[1]).toBe(0);
    expect(f32[3]).toBe(1);
    // Series A x=1: base=0, height=2
    expect(f32[8 + 1]).toBe(0);
    expect(f32[8 + 3]).toBe(2);
    // Series B x=0 stacked on A: base=1, height=3
    expect(f32[16 + 1]).toBe(1);
    expect(f32[16 + 3]).toBe(3);
    // Series B x=1 stacked on A: base=2, height=1
    expect(f32[24 + 1]).toBe(2);
    expect(f32[24 + 3]).toBe(1);

    renderer.prepare(series, emptyDataStore, xScale, yScaleB, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('reverse-x single-series bar stays centered on domain x', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    // Reversed x range: ax < 0
    const xScale = createLinearScale().domain(0, 2).range(clip.right, clip.left);
    const yScale = createLinearScale().domain(0, 5).range(clip.bottom, clip.top);
    const cfg = barConfig(data);

    renderer.prepare([cfg], emptyDataStore, xScale, yScale, ga);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    const f32 = lastInstanceFloats(writeBuffer);
    // Each instance: left + width/2 === domain x (center, independent of ax).
    for (let i = 0; i < 3; i++) {
      const left = f32[i * 8 + 0];
      const width = f32[i * 8 + 2];
      const domainX = data[i][0] as number;
      expect(left + width / 2).toBeCloseTo(domainX, 5);
    }
    renderer.dispose();
  });

  it('reverse-x multi-series: cluster centered on x; series 0 left in clip', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);
    const dataA: DataPoint[] = [[1, 2]];
    const dataB: DataPoint[] = [[1, 4]];
    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScale = createLinearScale().domain(0, 2).range(clip.right, clip.left); // ax < 0
    const yScale = createLinearScale().domain(0, 5).range(clip.bottom, clip.top);
    const series = [barConfig(dataA, { color: '#f00' }), barConfig(dataB, { color: '#0f0' })];

    renderer.prepare(series, emptyDataStore, xScale, yScale, ga);
    const f32 = lastInstanceFloats(writeBuffer);
    // Two instances at same category x=1: series A then B.
    const leftA = f32[0];
    const widthA = f32[2];
    const leftB = f32[8];
    const widthB = f32[10];
    const centerA = leftA + widthA / 2;
    const centerB = leftB + widthB / 2;
    // Overall cluster midpoint stays on domain x=1.
    expect((centerA + centerB) / 2).toBeCloseTo(1, 5);

    // Clip order: series 0 left of series 1 under reversed x.
    // clipX = ax * domain + bx with ax < 0 → higher domain center → lower clip.
    // So series 0 left in clip ⇒ series 0 has higher domain center than series 1.
    expect(centerA).toBeGreaterThan(centerB);

    // Forward x for contrast: series 0 should have lower domain center.
    writeBuffer.mockClear();
    renderer.invalidateGeometry();
    const xForward = createLinearScale().domain(0, 2).range(clip.left, clip.right);
    renderer.prepare(series, emptyDataStore, xForward, yScale, ga);
    const f32fwd = lastInstanceFloats(writeBuffer);
    const centerAf = f32fwd[0] + f32fwd[2] / 2;
    const centerBf = f32fwd[8] + f32fwd[10] / 2;
    expect(centerAf).toBeLessThan(centerBf);
    expect((centerAf + centerBf) / 2).toBeCloseTo(1, 5);
    renderer.dispose();
  });

  it('clamps instance buffer to maxBufferSize and density-strides oversized series (10M column fix)', () => {
    // 32 B/instance × 10M would be 320MB; nextPow2 → 512MB > typical 256MB maxBufferSize.
    // With a tiny cap, packing must stride and createBuffer size must stay ≤ limit.
    const tinyCap = 32 * 1024; // 32 KiB → max 1024 instances
    const device = createMockDevice({ maxBufferSize: tinyCap });
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const createBuffer = device.createBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);

    const n = 5000; // needs densityStride = ceil(5000/1024) = 5
    const data: DataPoint[] = new Array(n);
    for (let i = 0; i < n; i++) data[i] = [i, i % 7];

    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScale = createLinearScale().domain(0, n - 1).range(clip.left, clip.right);
    const yScale = createLinearScale().domain(0, 10).range(clip.bottom, clip.top);

    renderer.prepare([barConfig(data)], emptyDataStore, xScale, yScale, ga);

    expect(createBuffer).toHaveBeenCalled();
    for (const call of createBuffer.mock.calls) {
      const desc = call[0] as GPUBufferDescriptor | undefined;
      if (desc?.label === 'barRenderer/instanceBuffer') {
        expect(desc.size).toBeLessThanOrEqual(tinyCap);
      }
    }

    expect(writeBuffer).toHaveBeenCalledTimes(1);
    const byteLength = writeBuffer.mock.calls[0][4] as number;
    const maxInstances = Math.floor(tinyCap / INSTANCE_STRIDE_BYTES);
    expect(byteLength).toBeLessThanOrEqual(maxInstances * INSTANCE_STRIDE_BYTES);
    expect(byteLength % INSTANCE_STRIDE_BYTES).toBe(0);
    // Density stride keeps full x span: last packed left edge near the end of domain.
    const f32 = lastInstanceFloats(writeBuffer);
    const packed = byteLength / INSTANCE_STRIDE_BYTES;
    expect(packed).toBeGreaterThan(0);
    expect(packed).toBeLessThanOrEqual(maxInstances);
    const lastLeft = f32[(packed - 1) * 8]!;
    // With stride 5, last sample is near n-1; left ≈ x - width/2 should be high in domain.
    expect(lastLeft).toBeGreaterThan((n - 1) * 0.8);

    renderer.dispose();
  });

  it('multi-series density packing does not starve trailing series (per-series budget)', () => {
    // Shared global packCap + sequential fill used to drop series 1 when series 0
    // alone filled maxInstances after density stride (e.g. 10k+1 with stride 10).
    // Fair per-series caps keep every series represented in the packed buffer.
    const tinyCap = 32 * 1024; // 32 KiB → max 1024 instances
    const device = createMockDevice({ maxBufferSize: tinyCap });
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createBarRenderer(device);

    const maxInstances = Math.floor(tinyCap / INSTANCE_STRIDE_BYTES);
    // N just above maxInstances so density engages; two series would overfill a shared cap.
    const n = maxInstances + 200; // 1224 each → total 2448 > 1024
    const dataA: DataPoint[] = new Array(n);
    const dataB: DataPoint[] = new Array(n);
    for (let i = 0; i < n; i++) {
      dataA[i] = [i, 1];
      dataB[i] = [i, 2];
    }

    const ga = gridArea();
    const clip = plotClipFor(ga);
    const xScale = createLinearScale().domain(0, n - 1).range(clip.left, clip.right);
    const yScale = createLinearScale().domain(0, 3).range(clip.bottom, clip.top);

    const colorA = '#ff0000';
    const colorB = '#0000ff';
    renderer.prepare(
      [barConfig(dataA, { color: colorA }), barConfig(dataB, { color: colorB })],
      emptyDataStore,
      xScale,
      yScale,
      ga
    );

    expect(writeBuffer).toHaveBeenCalledTimes(1);
    const byteLength = writeBuffer.mock.calls[0][4] as number;
    expect(byteLength).toBeLessThanOrEqual(maxInstances * INSTANCE_STRIDE_BYTES);
    expect(byteLength % INSTANCE_STRIDE_BYTES).toBe(0);

    const f32 = lastInstanceFloats(writeBuffer);
    const packed = byteLength / INSTANCE_STRIDE_BYTES;
    expect(packed).toBeGreaterThan(0);
    expect(packed).toBeLessThanOrEqual(maxInstances);

    // RGBA slots at +4..+7 — both series colors must appear (trailing series not dropped).
    let sawRed = false;
    let sawBlue = false;
    let redCount = 0;
    let blueCount = 0;
    for (let i = 0; i < packed; i++) {
      const base = i * 8;
      const r = f32[base + 4]!;
      const g = f32[base + 5]!;
      const b = f32[base + 6]!;
      // #ff0000 → (1,0,0), #0000ff → (0,0,1)
      if (r > 0.9 && g < 0.1 && b < 0.1) {
        sawRed = true;
        redCount++;
      } else if (r < 0.1 && g < 0.1 && b > 0.9) {
        sawBlue = true;
        blueCount++;
      }
    }
    expect(sawRed).toBe(true);
    expect(sawBlue).toBe(true);
    // Fair share: each series gets floor(maxInstances/2) budget; both should pack many samples.
    const perSeriesCap = Math.floor(maxInstances / 2);
    expect(redCount).toBeGreaterThan(0);
    expect(blueCount).toBeGreaterThan(0);
    expect(redCount).toBeLessThanOrEqual(perSeriesCap);
    expect(blueCount).toBeLessThanOrEqual(perSeriesCap);
    // Combined still within buffer; neither series monopolizes all slots.
    expect(redCount + blueCount).toBe(packed);
    expect(redCount).toBeGreaterThanOrEqual(Math.min(n, perSeriesCap) / 4);
    expect(blueCount).toBeGreaterThanOrEqual(Math.min(n, perSeriesCap) / 4);

    renderer.dispose();
  });
});
