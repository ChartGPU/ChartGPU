/**
 * Const-radius scatter dual-buffer: N×4 × 2 channels (x,y) vs variable N×16.
 */

/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { ResolvedScatterSeriesConfig } from '../../config/OptionResolver';
import type { LinearScale } from '../../utils/scales';
import type { GridArea } from '../createGridRenderer';

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

import { createScatterRenderer } from '../createScatterRenderer';

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

const identityScale = {
  scale: (v: number) => v,
  invert: (v: number) => v,
} as unknown as LinearScale;

const gridArea = {
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  canvasWidth: 800,
  canvasHeight: 600,
  devicePixelRatio: 1,
  plotWidth: 800,
  plotHeight: 600,
} as unknown as GridArea;

const baseSeries = (symbolSize: number): ResolvedScatterSeriesConfig =>
  ({
    type: 'scatter',
    name: 's',
    data: [],
    rawData: [],
    color: '#0f0',
    symbolSize,
    mode: 'points',
    binSize: 2,
    densityColormap: 'viridis',
    densityNormalization: 'log',
    sampling: 'none',
    samplingThreshold: 5000,
    yAxis: 'y',
    visible: true,
  }) as ResolvedScatterSeriesConfig;

describe('scatter const-radius instance stride', () => {
  it('uploads dual N*4 channels for constant symbolSize dense tuples', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 100;
    const data = Array.from({ length: n }, (_, i) => [i, i * 0.5] as const);
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);

    const sizes = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number');
    // Option A dual-buffer: x and y each N*4 (not interleaved N*8, not variable N*16).
    expect(sizes.filter((s) => s === n * 4)).toHaveLength(2);
    expect(sizes).not.toContain(n * 8);
    expect(sizes).not.toContain(n * 16);
    renderer.dispose();
  });

  it('uses N*16 when tuple carries per-point size', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const data = [
      [0, 1, 3],
      [1, 2, 6],
      [2, 3, 9],
    ] as const;
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);
    const sizes = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number');
    expect(sizes).toContain(3 * 16);
    renderer.dispose();
  });

  it('uses N*16 when size appears only on a later point (sparse)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const data = [
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 3, size: 12 },
    ];
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);
    const sizes = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number');
    expect(sizes).toContain(3 * 16);
    renderer.dispose();
  });
});

describe('scatter geometry identity cache (issue 1.2)', () => {
  it('skips instance writeBuffer on second prepare with same data ref', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const data = Array.from({ length: 50 }, (_, i) => [i, i * 0.5] as const);

    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);
    const afterFirst = writeBuffer.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Axes-only / pan: same data ref — uniforms may rewrite; instances must not.
    writeBuffer.mockClear();
    const zoomedScale = {
      scale: (v: number) => v * 2,
      invert: (v: number) => v / 2,
    } as unknown as LinearScale;
    renderer.prepare(baseSeries(5), data as unknown as never, zoomedScale, identityScale, gridArea);
    // No instance writeBuffer (byteLength payload via 5th arg); uniforms use writeUniformBuffer mock.
    const instanceWrites = writeBuffer.mock.calls.filter((c) => typeof c[4] === 'number' && (c[4] as number) > 0);
    expect(instanceWrites).toHaveLength(0);
    renderer.dispose();
  });

  it('re-uploads when data ref changes (equal-N y-only → single N×4)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const dataA = [
      [0, 1],
      [1, 2],
    ] as const;
    const dataB = [
      [0, 3],
      [1, 4],
    ] as const;

    renderer.prepare(baseSeries(5), dataA as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), dataB as unknown as never, identityScale, identityScale, gridArea);
    // y-only equal-N: single N*4 y write (x stable at 0,1).
    const sizes = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number' && s > 0);
    expect(sizes).toEqual([2 * 4]);
    renderer.dispose();
  });

  it('re-uploads when size mode changes (const → per-point)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const dataConst = [
      [0, 1],
      [1, 2],
    ] as const;
    const dataSized = [
      [0, 1, 3],
      [1, 2, 6],
    ] as const;

    renderer.prepare(baseSeries(5), dataConst as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), dataSized as unknown as never, identityScale, identityScale, gridArea);
    const sizes = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number');
    expect(sizes).toContain(2 * 16);
    renderer.dispose();
  });

  it('re-uploads after invalidateGeometry with same data ref', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const data = [
      [0, 1],
      [1, 2],
    ] as const;

    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.invalidateGeometry();
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);
    // Full dual-buffer rewrite after invalidate: 2 × N*4.
    const sizes = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number');
    expect(sizes.filter((s) => s === 2 * 4)).toHaveLength(2);
    renderer.dispose();
  });
});
