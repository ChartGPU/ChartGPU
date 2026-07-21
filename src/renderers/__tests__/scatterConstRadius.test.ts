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
import { createRenderPipeline } from '../rendererUtils';

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
  kind: 'linear' as const,
  scale: (v: number) => v,
  invert: (v: number) => v,
  getDomain: () => ({ min: 0, max: 1 }),
  getRange: () => ({ min: 0, max: 1 }),
  domain: () => identityScale,
  range: () => identityScale,
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

describe('scatter F32 column zero-copy path', () => {
  it('hits zero-copy writeBuffer for dense {x: Float32Array, y: Float32Array}', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 50;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i;
      y[i] = i * 0.5;
    }
    const data = { x, y };
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);

    // Two channel uploads sourced from column ArrayBuffers (byteOffset/byteLength form).
    const colWrites = writeBuffer.mock.calls.filter((c) => c[2] === x.buffer || c[2] === y.buffer);
    expect(colWrites.length).toBe(2);
    expect(colWrites.some((c) => c[2] === x.buffer && c[4] === n * 4)).toBe(true);
    expect(colWrites.some((c) => c[2] === y.buffer && c[4] === n * 4)).toBe(true);
  });

  it('misses zero-copy for number[] columns (pack path)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 20;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = Array.from({ length: n }, (_, i) => i * 0.5);
    const data = { x, y };
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);

    // Packed staging uses ArrayBuffer views that are NOT the number[] itself.
    const sourcedFromNumberArray = writeBuffer.mock.calls.some((c) => c[2] === x || c[2] === y);
    expect(sourcedFromNumberArray).toBe(false);
    // Still uploads N*4 channel bytes (from CPU staging).
    const channelBytes = writeBuffer.mock.calls.filter((c) => c[4] === n * 4);
    expect(channelBytes.length).toBeGreaterThanOrEqual(2);
  });

  it('misses zero-copy for staging-ring alias markers', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 10;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const data = { x, y, __stagingRing: true };
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, gridArea);
    const colWrites = writeBuffer.mock.calls.filter((c) => c[2] === x.buffer || c[2] === y.buffer);
    // Staging-ring flag forces pack path — must not zero-copy column buffers.
    expect(colWrites.length).toBe(0);
  });

  it('misses zero-copy when F32 columns contain non-finite values', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const n = 8;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i;
      y[i] = i;
    }
    y[3] = Number.NaN;
    writeBuffer.mockClear();
    renderer.prepare(baseSeries(5), { x, y } as unknown as never, identityScale, identityScale, gridArea);
    const colWrites = writeBuffer.mock.calls.filter((c) => c[2] === x.buffer || c[2] === y.buffer);
    expect(colWrites.length).toBe(0);
  });
});

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
      kind: 'linear' as const,
      scale: (v: number) => v * 2,
      invert: (v: number) => v / 2,
      getDomain: () => ({ min: 0, max: 1 }),
      getRange: () => ({ min: 0, max: 2 }),
      domain: () => zoomedScale,
      range: () => zoomedScale,
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

describe('scatter denseCompact sampleCount:1 deferral (group 2)', () => {
  const denseGrid = {
    ...gridArea,
    // Small plot so even modest N exceeds density LO; point-count floor is 250k.
    canvasWidth: 200,
    canvasHeight: 100,
    plotWidth: 200,
    plotHeight: 100,
  } as unknown as GridArea;

  const suiteGrid = {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    canvasWidth: 1412,
    canvasHeight: 1064,
    devicePixelRatio: 1,
    plotWidth: 1412,
    plotHeight: 1064,
  } as unknown as GridArea;

  const mockPass = () =>
    ({
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
      setScissorRect: vi.fn(),
    }) as unknown as GPURenderPassEncoder & {
      setPipeline: ReturnType<typeof vi.fn>;
      draw: ReturnType<typeof vi.fn>;
    };

  it('sampleCount 4 + N≥250k defers main render to renderDense (isDenseDeferred)', () => {
    const device = createMockDevice();
    const createPipe = createRenderPipeline as ReturnType<typeof vi.fn>;
    createPipe.mockClear();
    const renderer = createScatterRenderer(device, { sampleCount: 4 });
    // Main const-radius (sampleCount 4) + dense SS1 (sampleCount 1) both created.
    const pipelineDescs = createPipe.mock.calls.map((c) => c[1] as { label?: string; multisample?: { count: number } });
    const densePipe = pipelineDescs.find((d) => d?.label === 'scatterRenderer/pipelineConstRadiusDenseSS1');
    const mainConst = pipelineDescs.find((d) => d?.label === 'scatterRenderer/pipelineConstRadiusSplit');
    expect(densePipe?.multisample?.count).toBe(1);
    expect(mainConst?.multisample?.count).toBe(4);

    const n = 250_000;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i * 0.001;
      y[i] = i * 0.0005;
    }
    renderer.prepare(baseSeries(5), { x, y } as unknown as never, identityScale, identityScale, denseGrid);
    expect(renderer.isDenseDeferred()).toBe(true);

    const pass = mockPass();
    renderer.render(pass);
    expect(pass.draw).not.toHaveBeenCalled();

    renderer.renderDense(pass);
    expect(pass.draw).toHaveBeenCalledWith(6, n);
    // Dense path binds the SS1 pipeline object returned for dense label.
    expect(pass.setPipeline).toHaveBeenCalled();
    renderer.dispose();
  });

  it('sampleCount 1 never creates SS1 pipeline and never defers', () => {
    const device = createMockDevice();
    const createPipe = createRenderPipeline as ReturnType<typeof vi.fn>;
    createPipe.mockClear();
    const renderer = createScatterRenderer(device, { sampleCount: 1 });
    const labels = createPipe.mock.calls.map((c) => (c[1] as { label?: string })?.label);
    expect(labels).not.toContain('scatterRenderer/pipelineConstRadiusDenseSS1');

    const n = 250_000;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    renderer.prepare(baseSeries(5), { x, y } as unknown as never, identityScale, identityScale, denseGrid);
    expect(renderer.isDenseDeferred()).toBe(false);

    const pass = mockPass();
    renderer.render(pass);
    expect(pass.draw).toHaveBeenCalledWith(6, n);
    renderer.renderDense(pass);
    expect(pass.draw).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('partial-blend density (suite 200k) does not defer — main draws with reduced radius', () => {
    const device = createMockDevice();
    const renderer = createScatterRenderer(device, { sampleCount: 4 });
    const n = 200_000; // density blend on suite plot; fullyCompact false
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    renderer.prepare(baseSeries(5), { x, y } as unknown as never, identityScale, identityScale, suiteGrid);
    expect(renderer.isDenseDeferred()).toBe(false);
    const pass = mockPass();
    renderer.render(pass);
    expect(pass.draw).toHaveBeenCalledWith(6, n);
    renderer.renderDense(pass);
    expect(pass.draw).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('density-driven fullyCompact (N < 250k floor, density ≥ HI) defers at sampleCount 4', () => {
    // 100×100 device plot → area 10k; HI 0.30 → need ≥3000 pts for full compact,
    // well under DENSE_SCATTER_POINT_COUNT_FULL_COMPACT (250k).
    const densityGrid = {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      canvasWidth: 100,
      canvasHeight: 100,
      devicePixelRatio: 1,
      plotWidth: 100,
      plotHeight: 100,
    } as unknown as GridArea;
    const n = 3_500; // density 0.35 ≥ HI 0.30; N ≪ 250k
    expect(n).toBeLessThan(250_000);
    expect(n / (100 * 100)).toBeGreaterThanOrEqual(0.3);

    const device = createMockDevice();
    const renderer = createScatterRenderer(device, { sampleCount: 4 });
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i * 0.01;
      y[i] = i * 0.005;
    }
    renderer.prepare(baseSeries(5), { x, y } as unknown as never, identityScale, identityScale, densityGrid);
    expect(renderer.isDenseDeferred()).toBe(true);

    const pass = mockPass();
    renderer.render(pass);
    expect(pass.draw).not.toHaveBeenCalled();
    renderer.renderDense(pass);
    expect(pass.draw).toHaveBeenCalledWith(6, n);
    renderer.dispose();
  });

  it('allowPostResolveDense false keeps fully-compact on main (line-chart z-order)', () => {
    const device = createMockDevice();
    const renderer = createScatterRenderer(device, { sampleCount: 4 });
    const n = 500_000;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    renderer.prepare(
      baseSeries(5),
      { x, y } as unknown as never,
      identityScale,
      identityScale,
      denseGrid,
      false,
      false // allowPostResolveDense
    );
    expect(renderer.isDenseDeferred()).toBe(false);
    const pass = mockPass();
    renderer.render(pass);
    expect(pass.draw).toHaveBeenCalledWith(6, n);
    renderer.dispose();
  });

  it('low N (≤100k suite protection) stays standard — main render draws', () => {
    const device = createMockDevice();
    const renderer = createScatterRenderer(device, { sampleCount: 4 });
    const n = 100_000;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    renderer.prepare(baseSeries(5), { x, y } as unknown as never, identityScale, identityScale, suiteGrid);
    expect(renderer.isDenseDeferred()).toBe(false);

    const pass = mockPass();
    renderer.render(pass);
    expect(pass.draw).toHaveBeenCalledWith(6, n);
    renderer.dispose();
  });

  it('forceStandardDraw disables deferral and draws on main; renderDense no-op', () => {
    const device = createMockDevice();
    const renderer = createScatterRenderer(device, { sampleCount: 4 });
    const n = 500_000;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    renderer.prepare(
      baseSeries(5),
      { x, y } as unknown as never,
      identityScale,
      identityScale,
      denseGrid,
      true // forceStandardDraw
    );
    expect(renderer.isDenseDeferred()).toBe(false);
    const pass = mockPass();
    renderer.render(pass);
    expect(pass.draw).toHaveBeenCalledWith(6, n);
    renderer.renderDense(pass);
    expect(pass.draw).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('variable-radius path never defers even with sampleCount 4', () => {
    const device = createMockDevice();
    const renderer = createScatterRenderer(device, { sampleCount: 4 });
    // Per-point size → variable-radius interleaved path (policy constRadius false)
    const data = Array.from({ length: 500 }, (_, i) => [i, i * 0.5, 5] as const);
    renderer.prepare(baseSeries(5), data as unknown as never, identityScale, identityScale, denseGrid);
    expect(renderer.isDenseDeferred()).toBe(false);
    const pass = mockPass();
    renderer.render(pass);
    expect(pass.draw).toHaveBeenCalledWith(6, 500);
    renderer.renderDense(pass);
    expect(pass.draw).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });
});
