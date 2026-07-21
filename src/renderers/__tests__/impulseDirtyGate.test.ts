/**
 * Impulse dirty-gate: zoom-only skips instance writeBuffer; style/data rewrites.
 * Geometry fingerprint is last-sample only (errorBar parity) — see invalidateGeometry.
 */
/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedImpulseSeriesConfig } from '../../config/OptionResolver';
import type { GridArea } from '../createGridRenderer';
import { writeUniformBuffer } from '../rendererUtils';
import { impulseDrawFlags } from '../createImpulseRenderer';

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

import { createImpulseRenderer } from '../createImpulseRenderer';

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

function impSeries(
  data: ResolvedImpulseSeriesConfig['data'],
  overrides?: Partial<ResolvedImpulseSeriesConfig>
): ResolvedImpulseSeriesConfig {
  return {
    type: 'impulse',
    name: 'imp',
    data,
    rawData: data,
    color: '#a78bfa',
    baseline: 0,
    lineStyle: { color: '#a78bfa', width: 2, opacity: 1 },
    showMarker: true,
    symbolSize: 6,
    sampling: 'none',
    samplingThreshold: 5000,
    yAxis: 'y',
    visible: true,
    ...overrides,
  } as ResolvedImpulseSeriesConfig;
}

const sample = {
  x: [0, 1, 2],
  y: [10, 12, 11],
};

describe('impulseDrawFlags', () => {
  it('connector-only vs connector+marker (whisker-free)', () => {
    expect(impulseDrawFlags(false)).toBe(8);
    expect(impulseDrawFlags(true)).toBe(24);
  });
});

describe('createImpulseRenderer dirty gate', () => {
  let device: GPUDevice;

  beforeEach(() => {
    device = createMockDevice();
    writeUniformBufferMock.mockClear();
    (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
  });

  it('skips writeBuffer on axes-only prepare with stable data identity', () => {
    const renderer = createImpulseRenderer(device) as ReturnType<typeof createImpulseRenderer> & {
      didRewritePointsLastPrepare(): boolean;
    };
    const data = { ...sample };
    const series = impSeries(data);
    const ga = gridArea();
    const x1 = createLinearScale().domain(0, 2).range(0, 1);
    const y1 = createLinearScale().domain(0, 20).range(1, 0);

    renderer.prepare(series, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(true);
    const writesAfterFirst = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writesAfterFirst).toBeGreaterThan(0);

    const x2 = createLinearScale().domain(0.5, 1.5).range(0, 1);
    const y2 = createLinearScale().domain(5, 15).range(1, 0);
    renderer.prepare(series, data, x2, y2, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(false);
    expect((device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writesAfterFirst);

    renderer.dispose();
  });

  it('rewrites on color / baseline / showMarker change; invalidateGeometry forces rewrite', () => {
    const renderer = createImpulseRenderer(device) as ReturnType<typeof createImpulseRenderer> & {
      didRewritePointsLastPrepare(): boolean;
    };
    const data = { ...sample };
    const series = impSeries(data);
    const ga = gridArea();
    const x1 = createLinearScale().domain(0, 2).range(0, 1);
    const y1 = createLinearScale().domain(0, 20).range(1, 0);

    renderer.prepare(series, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(true);
    const writesAfterFirst = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;

    renderer.prepare(series, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(false);

    const restyled = impSeries(data, {
      lineStyle: { color: '#ff0000', width: 2, opacity: 1 },
    });
    renderer.prepare(restyled, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(true);

    const writesAfterColor = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    const baseShift = impSeries(data, {
      lineStyle: { color: '#ff0000', width: 2, opacity: 1 },
      baseline: -2,
    });
    renderer.prepare(baseShift, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(true);

    const noMarker = impSeries(data, {
      lineStyle: { color: '#ff0000', width: 2, opacity: 1 },
      baseline: -2,
      showMarker: false,
    });
    renderer.prepare(noMarker, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(true);

    const afterMarker = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    renderer.prepare(noMarker, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(false);

    renderer.invalidateGeometry();
    renderer.prepare(noMarker, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(true);
    expect((device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(afterMarker);
    expect(writesAfterFirst).toBeLessThan(writesAfterColor);

    renderer.dispose();
  });
});
