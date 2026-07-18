/**
 * Candlestick domain-space pack + geometry cache (issue 1.3).
 * Same data ref + axes-only domain change → skip instance writeBuffer.
 */

/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedCandlestickSeriesConfig } from '../../config/OptionResolver';
import type { GridArea } from '../createGridRenderer';
import { writeUniformBuffer } from '../rendererUtils';

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

vi.mock('../rendererUtils', () => ({
  createRenderPipeline: vi.fn(() => ({})),
  createUniformBuffer: vi.fn(() => ({ destroy: vi.fn() })),
  writeUniformBuffer: vi.fn(),
}));

import { createCandlestickRenderer } from '../createCandlestickRenderer';

const writeUniformBufferMock = writeUniformBuffer as ReturnType<typeof vi.fn>;

function createMockDevice() {
  return {
    label: 'mockDevice',
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
    createBuffer: vi.fn((desc: { size: number }) => ({
      destroy: vi.fn(),
      size: desc.size,
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
  } as unknown as GPUDevice;
}

function gridArea(): GridArea {
  return {
    left: 40,
    right: 20,
    top: 20,
    bottom: 40,
    canvasWidth: 800,
    canvasHeight: 600,
    devicePixelRatio: 1,
    plotWidth: 740,
    plotHeight: 540,
  } as unknown as GridArea;
}

function candleSeries(data: ResolvedCandlestickSeriesConfig['data']): ResolvedCandlestickSeriesConfig {
  return {
    type: 'candlestick',
    name: 'ohlc',
    data,
    rawData: data,
    color: '#0f0',
    style: 'classic',
    barWidth: '60%',
    barMinWidth: 1,
    barMaxWidth: 50,
    itemStyle: {
      upColor: '#0f0',
      downColor: '#f00',
      upBorderColor: '#0a0',
      downBorderColor: '#a00',
      borderWidth: 1,
    },
    sampling: 'none',
    samplingThreshold: 5000,
    yAxis: 'y',
    visible: true,
  } as unknown as ResolvedCandlestickSeriesConfig;
}

const sampleData = [
  [0, 10, 12, 9, 13],
  [1, 12, 11, 10, 14],
  [2, 11, 15, 10, 16],
] as ResolvedCandlestickSeriesConfig['data'];

beforeEach(() => {
  writeUniformBufferMock.mockClear();
});

describe('candlestick geometry cache (issue 1.3)', () => {
  it('skips instance writeBuffer on axes-only domain change with same data ref', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createCandlestickRenderer(device, { sampleCount: 1 });
    const ga = gridArea();
    const series = candleSeries(sampleData);

    const x1 = createLinearScale().domain(0, 2).range(-1, 1);
    const y1 = createLinearScale().domain(0, 20).range(-1, 1);
    renderer.prepare(series, sampleData, x1, y1, ga);
    expect(writeBuffer.mock.calls.length).toBeGreaterThan(0);

    writeBuffer.mockClear();
    writeUniformBufferMock.mockClear();

    // Zoom y domain only — percent barWidth is domain-invariant.
    const y2 = createLinearScale().domain(5, 18).range(-1, 1);
    renderer.prepare(series, sampleData, x1, y2, ga);

    expect(writeBuffer.mock.calls).toHaveLength(0);
    // Uniforms still update for affine / wick.
    expect(writeUniformBufferMock.mock.calls.length).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('re-uploads when data ref changes', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createCandlestickRenderer(device, { sampleCount: 1 });
    const ga = gridArea();
    const x = createLinearScale().domain(0, 2).range(-1, 1);
    const y = createLinearScale().domain(0, 20).range(-1, 1);

    const dataA = sampleData;
    const dataB = [
      [0, 10, 11, 9, 12],
      [1, 11, 10, 9, 13],
    ] as ResolvedCandlestickSeriesConfig['data'];

    renderer.prepare(candleSeries(dataA), dataA, x, y, ga);
    writeBuffer.mockClear();
    renderer.prepare(candleSeries(dataB), dataB, x, y, ga);
    expect(writeBuffer.mock.calls.length).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('re-uploads when same data ref grows in length (streaming append)', () => {
    // appendData mutates the coordinator-owned OHLC array in place; identity skip
    // must miss when length changes or new candles never reach the GPU buffer.
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createCandlestickRenderer(device, { sampleCount: 1 });
    const ga = gridArea();
    const x = createLinearScale().domain(0, 5).range(-1, 1);
    const y = createLinearScale().domain(0, 20).range(-1, 1);

    const growing = [
      [0, 10, 12, 9, 13],
      [1, 12, 11, 10, 14],
    ] as Array<[number, number, number, number, number]>;

    renderer.prepare(candleSeries(growing as never), growing as never, x, y, ga);
    writeBuffer.mockClear();

    growing.push([2, 11, 15, 10, 16]);
    renderer.prepare(candleSeries(growing as never), growing as never, x, y, ga);
    expect(writeBuffer.mock.calls.length).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('re-uploads when last candle mutates under same data ref (forming candle)', () => {
    // Streaming examples update the open candle via setOption with a stable array
    // and an in-place last-element replace — must not hit axes-only identity skip.
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createCandlestickRenderer(device, { sampleCount: 1 });
    const ga = gridArea();
    const x = createLinearScale().domain(0, 2).range(-1, 1);
    const y = createLinearScale().domain(0, 20).range(-1, 1);

    const forming = [
      [0, 10, 12, 9, 13],
      [1, 12, 11, 10, 14],
    ] as Array<[number, number, number, number, number]>;

    renderer.prepare(candleSeries(forming as never), forming as never, x, y, ga);
    writeBuffer.mockClear();

    forming[1] = [1, 12, 16, 10, 17]; // close/high moved
    renderer.prepare(candleSeries(forming as never), forming as never, x, y, ga);
    expect(writeBuffer.mock.calls.length).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('re-uploads after invalidateGeometry with same data ref', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createCandlestickRenderer(device, { sampleCount: 1 });
    const ga = gridArea();
    const series = candleSeries(sampleData);
    const x = createLinearScale().domain(0, 2).range(-1, 1);
    const y = createLinearScale().domain(0, 20).range(-1, 1);

    renderer.prepare(series, sampleData, x, y, ga);
    writeBuffer.mockClear();
    renderer.invalidateGeometry();
    renderer.prepare(series, sampleData, x, y, ga);
    expect(writeBuffer.mock.calls.length).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('re-uploads when CSS-px barWidth domain width changes with x-scale zoom', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createCandlestickRenderer(device, { sampleCount: 1 });
    const ga = gridArea();
    const series = {
      ...candleSeries(sampleData),
      barWidth: 10, // CSS px — domain body width tracks x-scale
    } as ResolvedCandlestickSeriesConfig;
    const y = createLinearScale().domain(0, 20).range(-1, 1);
    const x1 = createLinearScale().domain(0, 2).range(-1, 1);
    renderer.prepare(series, sampleData, x1, y, ga);
    writeBuffer.mockClear();
    // Zoom x (narrower domain → larger domain-per-css body width).
    const x2 = createLinearScale().domain(0, 1).range(-1, 1);
    renderer.prepare(series, sampleData, x2, y, ga);
    expect(writeBuffer.mock.calls.length).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('packs domain OHLC (not clip) into instance buffer', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createCandlestickRenderer(device, { sampleCount: 1 });
    const ga = gridArea();
    const series = candleSeries(sampleData);
    // Non-identity scale so clip != domain.
    const x = createLinearScale().domain(0, 2).range(-0.5, 0.5);
    const y = createLinearScale().domain(0, 20).range(-0.8, 0.8);

    renderer.prepare(series, sampleData, x, y, ga);
    const call = writeBuffer.mock.calls.find((c) => typeof c[4] === 'number' && (c[4] as number) >= 40);
    expect(call).toBeTruthy();
    const staging = call![2] as ArrayBuffer;
    const byteOffset = (call![3] as number) ?? 0;
    const floats = new Float32Array(staging, byteOffset, 10);
    // First candle domain-relative x: timestamp=0 → packingOrigin=0 → xPacked=0
    expect(floats[0]).toBe(0);
    expect(floats[1]).toBe(10);
    expect(floats[2]).toBe(12);
    expect(floats[3]).toBe(9);
    expect(floats[4]).toBe(13);
    renderer.dispose();
  });

  it('packs large epoch timestamps relative to packingOrigin (f32-safe)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createCandlestickRenderer(device, { sampleCount: 1 });
    const ga = gridArea();
    // Real streaming axes use Date.now()-scale ms; absolute f32 collapses spacing.
    const origin = 1_700_000_000_000;
    const step = 1_000;
    const timeData = [
      [origin, 10, 12, 9, 13],
      [origin + step, 12, 11, 10, 14],
      [origin + 2 * step, 11, 15, 10, 16],
    ] as ResolvedCandlestickSeriesConfig['data'];
    const series = candleSeries(timeData);
    const x = createLinearScale()
      .domain(origin, origin + 2 * step)
      .range(-1, 1);
    const y = createLinearScale().domain(0, 20).range(-1, 1);

    renderer.prepare(series, timeData, x, y, ga);
    const call = writeBuffer.mock.calls.find((c) => typeof c[4] === 'number' && (c[4] as number) >= 40);
    expect(call).toBeTruthy();
    const staging = call![2] as ArrayBuffer;
    const byteOffset = (call![3] as number) ?? 0;
    const floats = new Float32Array(staging, byteOffset, 20);
    // Relative x keeps 1s spacing as exact f32.
    expect(floats[0]).toBe(0);
    expect(floats[10]).toBe(step);
    // Affine sampled at packingOrigin (not 0/1) so clip matches scale.scale(origin).
    const expectedAx = (x.scale(origin + step) - x.scale(origin)) / step;
    const expectedBx = x.scale(origin);
    expect(writeUniformBufferMock.mock.calls.length).toBeGreaterThan(0);
    const uniformBuf = writeUniformBufferMock.mock.calls[0][2] as ArrayBuffer;
    const u = new Float32Array(uniformBuf);
    expect(u[0]).toBeCloseTo(expectedAx, 5); // ax
    expect(u[12]).toBeCloseTo(expectedBx, 5); // bx = scale(origin) — not bx+ax*origin
    // First candle at x_packed=0 maps to left of domain.
    expect(u[0] * 0 + u[12]).toBeCloseTo(x.scale(origin), 5);
    renderer.dispose();
  });
});
