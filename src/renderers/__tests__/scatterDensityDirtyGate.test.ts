/**
 * Scatter density dirty gate: must re-bin on scale affine / content version
 * changes even when buffer identity, point count, and visible range are stable.
 * Pure hover (unchanged scale + content) must not re-dispatch compute.
 */

/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { ResolvedScatterSeriesConfig } from '../../config/OptionResolver';
import type { LinearScale } from '../../utils/scales';
import { createLinearScale } from '../../utils/scales';
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
  // @ts-ignore
  globalThis.GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
});

vi.mock('../rendererUtils', () => ({
  createRenderPipeline: vi.fn(() => ({})),
  createComputePipeline: vi.fn(() => ({})),
  createShaderModule: vi.fn(() => ({})),
  createUniformBuffer: vi.fn(() => ({ destroy: vi.fn() })),
  writeUniformBuffer: vi.fn(),
}));

import { createScatterDensityRenderer } from '../createScatterDensityRenderer';

function createMockDevice() {
  return {
    label: 'mockDevice',
    queue: {
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
      submit: vi.fn(),
    },
    createBuffer: vi.fn((desc: { size: number }) => ({
      destroy: vi.fn(),
      size: desc.size,
    })),
    createTexture: vi.fn(() => ({
      destroy: vi.fn(),
      createView: vi.fn(() => ({})),
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})),
  } as unknown as GPUDevice;
}

function mockPointBuffer(id = 1): GPUBuffer {
  return { __id: id, size: 1024 } as unknown as GPUBuffer;
}

function mockEncoder(): GPUCommandEncoder {
  const pass = {
    setBindGroup: vi.fn(),
    setPipeline: vi.fn(),
    dispatchWorkgroups: vi.fn(),
    end: vi.fn(),
  };
  return {
    beginComputePass: vi.fn(() => pass),
  } as unknown as GPUCommandEncoder;
}

const gridArea: GridArea = {
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

const baseSeries = {
  type: 'scatter',
  name: 'd',
  data: [],
  rawData: [],
  color: '#0f0',
  symbolSize: 4,
  mode: 'density',
  binSize: 4,
  densityColormap: 'viridis',
  densityNormalization: 'log',
  sampling: 'none',
  samplingThreshold: 5000,
  yAxis: 'y',
  visible: true,
} as unknown as ResolvedScatterSeriesConfig;

const rawBounds = { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };

function prepareOnce(
  renderer: ReturnType<typeof createScatterDensityRenderer>,
  opts: {
    xDomain?: [number, number];
    yDomain?: [number, number];
    contentVersion?: number;
    pointBuffer?: GPUBuffer;
    pointCount?: number;
  } = {}
): void {
  const [x0, x1] = opts.xDomain ?? [0, 100];
  const [y0, y1] = opts.yDomain ?? [0, 100];
  const xScale = createLinearScale().domain(x0, x1).range(-1, 1) as LinearScale;
  const yScale = createLinearScale().domain(y0, y1).range(-1, 1) as LinearScale;
  renderer.prepare(
    baseSeries,
    opts.pointBuffer ?? mockPointBuffer(),
    opts.pointCount ?? 100,
    0,
    100,
    xScale,
    yScale,
    gridArea,
    rawBounds,
    opts.contentVersion
  );
}

/** Count clear+bin dispatches via bins writeBuffer (clear path in encodeCompute). */
function encodeAndCountBinClears(device: GPUDevice, renderer: ReturnType<typeof createScatterDensityRenderer>): number {
  const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
  const before = writeBuffer.mock.calls.length;
  renderer.encodeCompute(mockEncoder());
  return writeBuffer.mock.calls.length - before;
}

describe('scatter density dirty gate (issue 0.1)', () => {
  it('re-dispatches compute when x-scale domain changes with stable buffer + visible range', () => {
    const device = createMockDevice();
    const renderer = createScatterDensityRenderer(device, { sampleCount: 1 });
    const buf = mockPointBuffer();

    prepareOnce(renderer, {
      xDomain: [0, 100],
      contentVersion: 1,
      pointBuffer: buf,
    });
    expect(encodeAndCountBinClears(device, renderer)).toBeGreaterThan(0);

    prepareOnce(renderer, {
      xDomain: [20, 80],
      contentVersion: 1,
      pointBuffer: buf,
    });
    expect(encodeAndCountBinClears(device, renderer)).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('re-dispatches compute when y-scale domain changes with stable buffer + visible range', () => {
    const device = createMockDevice();
    const renderer = createScatterDensityRenderer(device, { sampleCount: 1 });
    const buf = mockPointBuffer();

    prepareOnce(renderer, {
      yDomain: [0, 100],
      contentVersion: 1,
      pointBuffer: buf,
    });
    const first = encodeAndCountBinClears(device, renderer);
    expect(first).toBeGreaterThan(0);

    // Same buffer, point count, visible range; only y domain (scale affine) changes.
    prepareOnce(renderer, {
      yDomain: [0, 50],
      contentVersion: 1,
      pointBuffer: buf,
    });
    const second = encodeAndCountBinClears(device, renderer);
    expect(second).toBeGreaterThan(0);

    renderer.dispose();
  });

  it('re-bins on equal-N content rewrite at same buffer identity', () => {
    const device = createMockDevice();
    const renderer = createScatterDensityRenderer(device, { sampleCount: 1 });
    const buf = mockPointBuffer();

    prepareOnce(renderer, {
      contentVersion: 0x1111,
      pointBuffer: buf,
      pointCount: 50,
    });
    encodeAndCountBinClears(device, renderer);

    // Same buffer identity + N; content hash changed (equal-N rewrite).
    prepareOnce(renderer, {
      contentVersion: 0x2222,
      pointBuffer: buf,
      pointCount: 50,
    });
    const rebin = encodeAndCountBinClears(device, renderer);
    expect(rebin).toBeGreaterThan(0);

    renderer.dispose();
  });

  it('empty pointCount zeros bins and skips density render (M5)', () => {
    const device = createMockDevice();
    const renderer = createScatterDensityRenderer(device, { sampleCount: 1 });
    const buf = mockPointBuffer();

    // Populate density field first.
    prepareOnce(renderer, {
      contentVersion: 1,
      pointBuffer: buf,
      pointCount: 100,
    });
    expect(encodeAndCountBinClears(device, renderer)).toBeGreaterThan(0);

    // Clear / empty series: must re-encode zeros (not leave prior field dirty-cleared).
    prepareOnce(renderer, {
      contentVersion: 2,
      pointBuffer: buf,
      pointCount: 0,
    });
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const before = writeBuffer.mock.calls.length;
    renderer.encodeCompute(mockEncoder());
    const emptyCalls = writeBuffer.mock.calls.slice(before);
    // Must zero both bins buffer and max buffer (not just "≥2 writes").
    expect(emptyCalls.length).toBeGreaterThanOrEqual(2);
    const destBuffers = emptyCalls.map((c) => c[0]);
    // Two distinct destinations (bins + max) — both cleared.
    expect(new Set(destBuffers).size).toBeGreaterThanOrEqual(2);

    // Second encode with still-empty + clean dirty must not re-write.
    const before2 = writeBuffer.mock.calls.length;
    renderer.encodeCompute(mockEncoder());
    expect(writeBuffer.mock.calls.length - before2).toBe(0);

    // render must no-op when empty (no draw of prior density).
    const pass = {
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    };
    renderer.render(pass as any);
    expect(pass.draw).not.toHaveBeenCalled();

    renderer.dispose();
  });

  it('skips bin pass on pure hover (unchanged scale + content)', () => {
    const device = createMockDevice();
    const renderer = createScatterDensityRenderer(device, { sampleCount: 1 });
    const buf = mockPointBuffer();

    prepareOnce(renderer, {
      contentVersion: 42,
      pointBuffer: buf,
    });
    expect(encodeAndCountBinClears(device, renderer)).toBeGreaterThan(0);

    // Identical inputs — uniforms may rewrite but compute must stay clean.
    prepareOnce(renderer, {
      contentVersion: 42,
      pointBuffer: buf,
    });
    expect(encodeAndCountBinClears(device, renderer)).toBe(0);

    prepareOnce(renderer, {
      contentVersion: 42,
      pointBuffer: buf,
    });
    expect(encodeAndCountBinClears(device, renderer)).toBe(0);

    renderer.dispose();
  });
});
