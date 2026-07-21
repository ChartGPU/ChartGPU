/**
 * Error-bar dirty-gate: zoom-only / style-only should skip instance writeBuffer;
 * data ref / color / direction change should rewrite.
 */
/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedErrorBarSeriesConfig } from '../../config/OptionResolver';
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

import { createErrorBarRenderer } from '../createErrorBarRenderer';

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

function ebSeries(
  data: ResolvedErrorBarSeriesConfig['data'],
  overrides?: Partial<ResolvedErrorBarSeriesConfig>
): ResolvedErrorBarSeriesConfig {
  return {
    type: 'errorBar',
    name: 'eb',
    data,
    rawData: data,
    color: '#38bdf8',
    itemStyle: { color: '#38bdf8', borderWidth: 2, opacity: 1 },
    capWidth: '40%',
    errorMode: 'both',
    direction: 'vertical',
    drawWhiskers: true,
    drawConnector: true,
    showCenter: false,
    symbolSize: 6,
    sampling: 'none',
    yAxis: 'y',
    visible: true,
    ...overrides,
  } as ResolvedErrorBarSeriesConfig;
}

const sampleHlc = {
  x: [0, 1, 2],
  y: [10, 12, 11],
  high: [12, 14, 13],
  low: [8, 10, 9],
};

describe('createErrorBarRenderer dirty gate', () => {
  let device: GPUDevice;

  beforeEach(() => {
    device = createMockDevice();
    writeUniformBufferMock.mockClear();
    (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
  });

  it('skips writeBuffer on axes-only prepare with stable data identity', () => {
    const renderer = createErrorBarRenderer(device) as ReturnType<typeof createErrorBarRenderer> & {
      didRewritePointsLastPrepare(): boolean;
    };
    const data = { ...sampleHlc };
    const series = ebSeries(data);
    const ga = gridArea();
    const x1 = createLinearScale().domain(0, 2).range(0, 1);
    const y1 = createLinearScale().domain(0, 20).range(1, 0);

    renderer.prepare(series, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(true);
    const writesAfterFirst = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writesAfterFirst).toBeGreaterThan(0);

    // Zoom-only: new domain, same data ref
    const x2 = createLinearScale().domain(0.5, 1.5).range(0, 1);
    const y2 = createLinearScale().domain(5, 15).range(1, 0);
    renderer.prepare(series, data, x2, y2, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(false);
    // Uniforms still written
    expect(writeUniformBufferMock.mock.calls.length).toBeGreaterThan(0);
    // No additional instance writeBuffer
    expect((device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writesAfterFirst);

    renderer.dispose();
  });

  it('rewrites on color / style change; skips pure CSS-px capWidth zoom conversion', () => {
    const renderer = createErrorBarRenderer(device) as ReturnType<typeof createErrorBarRenderer> & {
      didRewritePointsLastPrepare(): boolean;
    };
    const data = { ...sampleHlc };
    // CSS-px capWidth would have forced re-upload every zoom if keyed on domain length (Issue 10).
    const series = ebSeries(data, { capWidth: 12 });
    const ga = gridArea();
    const x1 = createLinearScale().domain(0, 2).range(0, 1);
    const y1 = createLinearScale().domain(0, 20).range(1, 0);

    renderer.prepare(series, data, x1, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(true);
    const writesAfterFirst = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;

    const x2 = createLinearScale().domain(0.2, 1.8).range(0, 1);
    renderer.prepare(series, data, x2, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(false);
    expect((device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writesAfterFirst);

    // Color change → rewrite (color is packed per instance)
    const styled = ebSeries(data, { capWidth: 12, itemStyle: { color: '#ff0000', borderWidth: 2, opacity: 1 } });
    renderer.prepare(styled, data, x2, y1, ga);
    expect(renderer.didRewritePointsLastPrepare()).toBe(true);

    renderer.dispose();
  });

  it('packs horizontal high/low relative to packingOrigin', () => {
    const renderer = createErrorBarRenderer(device);
    // Large absolute X so packingOrigin ≠ 0
    const data = {
      x: [1000, 1010, 1020],
      y: [1, 2, 3],
      high: [1005, 1015, 1025],
      low: [995, 1005, 1015],
    };
    const series = ebSeries(data, { direction: 'horizontal' });
    const ga = gridArea();
    const xScale = createLinearScale().domain(990, 1030).range(0, 1);
    const yScale = createLinearScale().domain(0, 4).range(1, 0);

    renderer.prepare(series, data, xScale, yScale, ga);

    const writeBuf = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    expect(writeBuf).toHaveBeenCalled();
    // First writeBuffer args: buffer, offset, ArrayBuffer, srcOffset, size
    const call = writeBuf.mock.calls[0]!;
    const ab = call[2] as ArrayBuffer;
    const f32 = new Float32Array(ab);
    // packingOrigin = first finite x = 1000
    // instance 0: xPacked=0, high=5, low=-5
    expect(f32[0]).toBeCloseTo(0);
    expect(f32[1]).toBeCloseTo(1);
    expect(f32[2]).toBeCloseTo(5); // 1005 - 1000
    expect(f32[3]).toBeCloseTo(-5); // 995 - 1000

    renderer.dispose();
  });
});
