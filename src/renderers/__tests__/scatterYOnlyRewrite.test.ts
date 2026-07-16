/**
 * Scatter equal-N y-only dual-buffer path (plan issue 1.2 Option A).
 * Const-radius: full rewrite writes x+y channels (N×4 each); y-only writes only y (N×4).
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
import { writeUniformBuffer } from '../rendererUtils';

function createMockDevice() {
  return {
    label: 'mockDevice',
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
    createBuffer: vi.fn((desc: { size: number; label?: string }) => ({
      destroy: vi.fn(),
      size: desc.size,
      label: desc.label,
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

/** Instance writeBuffer calls: 5th arg is byte length when present. */
function instanceWriteSizes(writeBuffer: ReturnType<typeof vi.fn>): number[] {
  return writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number' && s > 0);
}

function instanceWrites(writeBuffer: ReturnType<typeof vi.fn>) {
  return writeBuffer.mock.calls.filter((c) => typeof c[4] === 'number' && (c[4] as number) > 0);
}

describe('scatter equal-N y-only dual-buffer (issue 1.2 Option A)', () => {
  it('full prepare writes both x and y channels (N×4 each)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 100;
    const data = Array.from({ length: n }, (_, i) => [i, i * 0.5] as const);
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);

    const sizes = instanceWriteSizes(writeBuffer);
    expect(sizes.filter((s) => s === n * 4)).toHaveLength(2);
    expect(sizes).not.toContain(n * 8);
    expect(sizes).not.toContain(n * 16);
    renderer.dispose();
  });

  it('equal-N y-only prepare writes only y channel buffer (not x)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const createBuffer = device.createBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 80;
    const dataA = Array.from({ length: n }, (_, i) => [i, i * 0.5] as const);
    const dataB = Array.from({ length: n }, (_, i) => [i, i * 0.5 + 1] as const);

    renderer.prepare(baseSeries(5), dataA as unknown as never, identityScale, identityScale, gridArea);
    const xBuf = createBuffer.mock.results.find(
      (r) => (r.value as { label?: string }).label === 'scatterRenderer/xInstanceBuffer'
    )?.value;
    const yBuf = createBuffer.mock.results.find(
      (r) => (r.value as { label?: string }).label === 'scatterRenderer/yInstanceBuffer'
    )?.value;
    expect(xBuf).toBeDefined();
    expect(yBuf).toBeDefined();

    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), dataB as unknown as never, identityScale, identityScale, gridArea);
    const writes = instanceWrites(writeBuffer);
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe(yBuf);
    expect(writes[0]![0]).not.toBe(xBuf);
    expect(writes[0]![4]).toBe(n * 4);
    renderer.dispose();
  });

  it('Brownian xy change takes full dual rewrite (not y-only)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 40;
    const dataA = Array.from({ length: n }, (_, i) => [i * 0.1, i * 0.2] as const);
    const dataB = Array.from({ length: n }, (_, i) => [i * 0.1 + 0.5, i * 0.2 + 0.3] as const);

    renderer.prepare(baseSeries(5), dataA as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), dataB as unknown as never, identityScale, identityScale, gridArea);

    const sizes = instanceWriteSizes(writeBuffer);
    expect(sizes.filter((s) => s === n * 4)).toHaveLength(2);
    renderer.dispose();
  });

  it('second prepare with same data ref still identity-skips instance writes', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const data = Array.from({ length: 50 }, (_, i) => [i, i * 0.5] as const);

    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    const zoomedScale = {
      scale: (v: number) => v * 2,
      invert: (v: number) => v / 2,
    } as unknown as LinearScale;
    renderer.prepare(baseSeries(5), data as unknown as never, zoomedScale, identityScale, gridArea);
    expect(instanceWriteSizes(writeBuffer)).toHaveLength(0);
    renderer.dispose();
  });

  it('identity-skips after y-only rewrite with same ref', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 30;
    const dataA = Array.from({ length: n }, (_, i) => [i, i] as const);
    const dataB = Array.from({ length: n }, (_, i) => [i, i + 1] as const);

    renderer.prepare(baseSeries(5), dataA as unknown as never, identityScale, identityScale, gridArea);
    renderer.prepare(baseSeries(5), dataB as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    const zoomedScale = {
      scale: (v: number) => v * 2,
      invert: (v: number) => v / 2,
    } as unknown as LinearScale;
    renderer.prepare(baseSeries(5), dataB as unknown as never, zoomedScale, identityScale, gridArea);
    expect(instanceWriteSizes(writeBuffer)).toHaveLength(0);
    renderer.dispose();
  });

  it('equal-N identical y values skips GPU instance write', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 25;
    const dataA = Array.from({ length: n }, (_, i) => [i, i * 2] as const);
    const dataB = Array.from({ length: n }, (_, i) => [i, i * 2] as const);

    renderer.prepare(baseSeries(5), dataA as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), dataB as unknown as never, identityScale, identityScale, gridArea);
    expect(instanceWriteSizes(writeBuffer)).toHaveLength(0);
    renderer.dispose();
  });

  it('length change forces full rewrite not y-only', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const dataA = Array.from({ length: 10 }, (_, i) => [i, i] as const);
    const dataB = Array.from({ length: 12 }, (_, i) => [i, i] as const);

    renderer.prepare(baseSeries(5), dataA as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), dataB as unknown as never, identityScale, identityScale, gridArea);
    const sizes = instanceWriteSizes(writeBuffer);
    expect(sizes.filter((s) => s === 12 * 4)).toHaveLength(2);
    renderer.dispose();
  });

  it('same symbolSize equal-N y-only still writes single N×4', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 20;
    const dataA = Array.from({ length: n }, (_, i) => [i, i] as const);
    const dataB = Array.from({ length: n }, (_, i) => [i, i + 1] as const);

    renderer.prepare(baseSeries(5), dataA as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), dataB as unknown as never, identityScale, identityScale, gridArea);
    expect(instanceWriteSizes(writeBuffer)).toEqual([n * 4]);
    renderer.dispose();
  });

  it('variable-radius equal-N y change writes N×16 not dual N×4', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const dataA = [
      [0, 1, 3],
      [1, 2, 4],
      [2, 3, 5],
    ] as const;
    const dataB = [
      [0, 9, 3],
      [1, 8, 4],
      [2, 7, 5],
    ] as const;

    renderer.prepare(baseSeries(5), dataA as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), dataB as unknown as never, identityScale, identityScale, gridArea);
    const sizes = instanceWriteSizes(writeBuffer);
    expect(sizes).toContain(3 * 16);
    expect(sizes.filter((s) => s === 3 * 4)).toHaveLength(0);
    renderer.dispose();
  });

  it('non-finite y on y-only candidate falls through to full dual rewrite', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 10;
    const dataA = Array.from({ length: n }, (_, i) => [i, i] as const);
    // Same x, one NaN y — dense y-only would draw wrong; must full sparse pack.
    const dataB = Array.from({ length: n }, (_, i) => [i, i === 3 ? Number.NaN : i + 1] as const);

    renderer.prepare(baseSeries(5), dataA as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), dataB as unknown as never, identityScale, identityScale, gridArea);
    // Sparse pack: 9 finite points × 4 bytes × 2 channels
    const sizes = instanceWriteSizes(writeBuffer);
    expect(sizes.filter((s) => s === 9 * 4)).toHaveLength(2);
    renderer.dispose();
  });

  it('denseCompact prepare writes min radius (1 device px) into VS uniform at high density', () => {
    const device = createMockDevice();
    const writeUniform = writeUniformBuffer as ReturnType<typeof vi.fn>;
    writeUniform.mockClear();
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    // Small plot + 1M points → density ≫ HI → fully compact radius = 1.0
    // (gridArea scissor uses full canvas when margins 0 → use tiny canvas).
    const tinyGrid = {
      ...gridArea,
      canvasWidth: 100,
      canvasHeight: 100,
      plotWidth: 100,
      plotHeight: 100,
    } as unknown as GridArea;
    const n = 1_000_000;
    const data = Array.from({ length: n }, (_, i) => [i * 0.0001, i * 0.0001] as const);
    // symbolSize 5 × dpr 1 = 5 device px nominal
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, tinyGrid);

    // writeUniformBuffer(device, buffer, data) — VS uniform is ArrayBuffer 80 bytes
    const vsWrites = writeUniform.mock.calls.filter((c) => {
      const data = c[2];
      return data instanceof ArrayBuffer && data.byteLength === 80;
    });
    expect(vsWrites.length).toBeGreaterThan(0);
    const f32 = new Float32Array(vsWrites[vsWrites.length - 1]![2] as ArrayBuffer);
    // radius at float index 18
    expect(f32[18]).toBe(1);
    renderer.dispose();
  });

  it('low-density prepare keeps full symbolSize radius in VS uniform', () => {
    const device = createMockDevice();
    const writeUniform = writeUniformBuffer as ReturnType<typeof vi.fn>;
    writeUniform.mockClear();
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 1000; // density ≪ 0.5 on 800×400
    const data = Array.from({ length: n }, (_, i) => [i, i] as const);
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);
    const vsWrites = writeUniform.mock.calls.filter((c) => {
      const data = c[2];
      return data instanceof ArrayBuffer && data.byteLength === 80;
    });
    const f32 = new Float32Array(vsWrites[vsWrites.length - 1]![2] as ArrayBuffer);
    expect(f32[18]).toBe(5); // symbolSize 5 × dpr 1
    renderer.dispose();
  });

  it('dense → sparse disables y-only; re-dense equal-N does full dual then can y-only', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const denseA = [
      [0, 1],
      [1, 2],
      [2, 3],
    ] as const;
    const sparse = [
      [0, 1],
      [1, Number.NaN],
      [2, 3],
    ] as const;
    const denseB = [
      [0, 10],
      [1, 20],
      [2, 30],
    ] as const;
    const denseC = [
      [0, 11],
      [1, 21],
      [2, 31],
    ] as const;

    renderer.prepare(baseSeries(5), denseA as unknown as never, identityScale, identityScale, gridArea);
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), sparse as unknown as never, identityScale, identityScale, gridArea);
    // sparse dual of 2 points
    expect(instanceWriteSizes(writeBuffer).filter((s) => s === 2 * 4)).toHaveLength(2);

    writeBuffer.mockClear();
    // After sparse, boundConstPointCount=0 → full dual on denseB (not y-only)
    renderer.prepare(baseSeries(5), denseB as unknown as never, identityScale, identityScale, gridArea);
    expect(instanceWriteSizes(writeBuffer).filter((s) => s === 3 * 4)).toHaveLength(2);

    writeBuffer.mockClear();
    // Now dense again → y-only on denseC
    renderer.prepare(baseSeries(5), denseC as unknown as never, identityScale, identityScale, gridArea);
    expect(instanceWriteSizes(writeBuffer)).toEqual([3 * 4]);
    renderer.dispose();
  });
});
