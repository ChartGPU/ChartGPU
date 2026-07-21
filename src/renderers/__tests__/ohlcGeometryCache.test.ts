/**
 * OHLC domain-space pack + geometry cache.
 * Same data ref + axes-only domain change → skip instance writeBuffer.
 */

/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedOhlcSeriesConfig } from '../../config/OptionResolver';
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

import { createOhlcRenderer } from '../createOhlcRenderer';

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

function ohlcSeries(data: ResolvedOhlcSeriesConfig['data']): ResolvedOhlcSeriesConfig {
  return {
    type: 'ohlc',
    name: 'bars',
    data,
    rawData: data,
    color: '#0f0',
    barWidth: '60%',
    barMinWidth: 1,
    barMaxWidth: 50,
    stemWidth: 1,
    tickLength: '45%',
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
  } as unknown as ResolvedOhlcSeriesConfig;
}

const sampleData = [
  [0, 10, 12, 9, 13],
  [1, 12, 11, 10, 13],
  [2, 11, 14, 10, 15],
] as const;

describe('createOhlcRenderer geometry cache', () => {
  let device: GPUDevice;

  beforeEach(() => {
    device = createMockDevice();
    writeUniformBufferMock.mockClear();
    (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
  });

  it('skips writeBuffer on axes-only prepare with stable data identity', () => {
    const renderer = createOhlcRenderer(device);
    const data = sampleData.map((row) => [...row]) as ResolvedOhlcSeriesConfig['data'];
    const series = ohlcSeries(data);
    const x0 = createLinearScale({ domain: { min: 0, max: 3 }, range: { min: 0, max: 1 } });
    const y0 = createLinearScale({ domain: { min: 0, max: 20 }, range: { min: 0, max: 1 } });
    const x1 = createLinearScale({ domain: { min: 0.5, max: 2.5 }, range: { min: 0, max: 1 } });
    const y1 = createLinearScale({ domain: { min: 5, max: 18 }, range: { min: 0, max: 1 } });

    renderer.prepare(series, data, x0, y0, gridArea());
    const writesAfterFirst = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writesAfterFirst).toBeGreaterThan(0);

    renderer.prepare(series, data, x1, y1, gridArea());
    const writesAfterSecond = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writesAfterSecond).toBe(writesAfterFirst);
    // Uniforms still update for zoom
    expect(writeUniformBufferMock.mock.calls.length).toBeGreaterThan(1);

    renderer.dispose();
  });

  it('re-packs when last bar mutates under stable array ref (equal-N)', () => {
    const renderer = createOhlcRenderer(device);
    const data = sampleData.map((row) => [...row]) as Array<[number, number, number, number, number]>;
    const series = ohlcSeries(data);
    const x = createLinearScale({ domain: { min: 0, max: 3 }, range: { min: 0, max: 1 } });
    const y = createLinearScale({ domain: { min: 0, max: 20 }, range: { min: 0, max: 1 } });

    renderer.prepare(series, data, x, y, gridArea());
    const writesAfterFirst = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;

    // Mutate last bar close in place
    data[data.length - 1]![2] = 99;
    renderer.prepare(series, data, x, y, gridArea());
    const writesAfterMutate = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writesAfterMutate).toBeGreaterThan(writesAfterFirst);

    renderer.dispose();
  });

  it('re-packs when array length grows (append under stable ref)', () => {
    const renderer = createOhlcRenderer(device);
    const data = sampleData.map((row) => [...row]) as Array<[number, number, number, number, number]>;
    const series = ohlcSeries(data);
    const x = createLinearScale({ domain: { min: 0, max: 10 }, range: { min: 0, max: 1 } });
    const y = createLinearScale({ domain: { min: 0, max: 20 }, range: { min: 0, max: 1 } });

    renderer.prepare(series, data, x, y, gridArea());
    const writesAfterFirst = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;

    data.push([3, 14, 15, 13, 16]);
    renderer.prepare(series, data, x, y, gridArea());
    const writesAfterAppend = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writesAfterAppend).toBeGreaterThan(writesAfterFirst);

    renderer.dispose();
  });

  it('invalidateGeometry forces re-pack on next prepare', () => {
    const renderer = createOhlcRenderer(device);
    const data = sampleData.map((row) => [...row]) as ResolvedOhlcSeriesConfig['data'];
    const series = ohlcSeries(data);
    const x = createLinearScale({ domain: { min: 0, max: 3 }, range: { min: 0, max: 1 } });
    const y = createLinearScale({ domain: { min: 0, max: 20 }, range: { min: 0, max: 1 } });

    renderer.prepare(series, data, x, y, gridArea());
    const writesAfterFirst = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    renderer.invalidateGeometry();
    renderer.prepare(series, data, x, y, gridArea());
    expect((device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(writesAfterFirst);

    renderer.dispose();
  });

  it('does not re-pack middle-bar in-place mutate under stable ref (last-bar fingerprint contract; candle parity)', () => {
    const renderer = createOhlcRenderer(device);
    const data = sampleData.map((row) => [...row]) as Array<[number, number, number, number, number]>;
    const series = ohlcSeries(data);
    const x = createLinearScale({ domain: { min: 0, max: 3 }, range: { min: 0, max: 1 } });
    const y = createLinearScale({ domain: { min: 0, max: 20 }, range: { min: 0, max: 1 } });

    renderer.prepare(series, data, x, y, gridArea());
    const writesAfterFirst = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;

    // Mutate middle bar only — last fingerprint unchanged → skip (documented out of contract).
    data[1]![2] = 99;
    renderer.prepare(series, data, x, y, gridArea());
    expect((device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writesAfterFirst);

    // invalidateGeometry recovers (animation / explicit invalidation path).
    renderer.invalidateGeometry();
    renderer.prepare(series, data, x, y, gridArea());
    expect((device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(writesAfterFirst);

    renderer.dispose();
  });
});
