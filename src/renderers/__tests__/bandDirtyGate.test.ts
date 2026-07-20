/**
 * Band renderer dirty-gate: zoom-only should not rewrite points;
 * data ref change should rewrite; style-only should not repack when data ref stable.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

beforeAll(() => {
  // @ts-expect-error mock
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  // @ts-expect-error mock
  globalThis.GPUBufferUsage = {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
  };
});

vi.mock('../rendererUtils', () => {
  const buffers: Array<{ size: number; destroyed: boolean }> = [];
  return {
    createRenderPipeline: vi.fn(() => ({ label: 'mockPipeline' })),
    createUniformBuffer: vi.fn((_device: unknown, size: number) => {
      const b = {
        size,
        destroyed: false,
        destroy: () => {
          b.destroyed = true;
        },
      };
      buffers.push(b);
      return b;
    }),
    writeUniformBuffer: vi.fn(),
  };
});

vi.mock('../createLineRenderer', () => ({
  createLineRenderer: vi.fn(() => ({
    prepare: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    isDenseHairline: () => false,
    renderHairline: vi.fn(),
    bindHairlinePipeline: vi.fn(),
  })),
}));

import { createBandRenderer } from '../createBandRenderer';
import type { ResolvedBandSeriesConfig } from '../../config/OptionResolver';
import { createLinearScale } from '../../utils/scales';

function makeDevice(): GPUDevice {
  const writeBuffer = vi.fn();
  return {
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn(({ size }: { size: number }) => ({
      size,
      destroy: vi.fn(),
    })),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    queue: { writeBuffer },
  } as unknown as GPUDevice;
}

function makeSeries(overrides?: Partial<ResolvedBandSeriesConfig>): ResolvedBandSeriesConfig {
  return {
    type: 'band',
    color: '#38bdf8',
    connectNulls: false,
    sampling: 'none',
    samplingThreshold: 5000,
    yAxis: 'y',
    rawData: { x: [0, 1], y: [0, 0], y1: [1, 1] },
    data: { x: [0, 1], y: [0, 0], y1: [1, 1] },
    areaStyle: { color: '#38bdf8', opacity: 0.25 },
    lineStyle: { width: 1, opacity: 1, color: '#38bdf8' },
    ...overrides,
  };
}

describe('band dirty gate', () => {
  it('rewrites points on first prepare and data ref change; skips on zoom-only', () => {
    const device = makeDevice();
    const r = createBandRenderer(device, { sampleCount: 4 });
    const xScale = createLinearScale().domain(0, 1).range(0, 100);
    const yScale = createLinearScale().domain(0, 1).range(100, 0);
    const dataA = { x: [0, 1, 2], y: [0, 0, 0], y1: [1, 1, 1] };
    const series = makeSeries({ data: dataA, rawData: dataA });

    r.prepare(series, dataA, xScale, yScale);
    expect(r.didRewritePointsLastPrepare()).toBe(true);

    // Zoom-only: new scales, same data ref — must not re-pack points.
    const xScale2 = createLinearScale().domain(0.2, 0.8).range(0, 100);
    r.prepare(series, dataA, xScale2, yScale);
    expect(r.didRewritePointsLastPrepare()).toBe(false);

    // Style-only: same data, different color
    const styled = makeSeries({
      data: dataA,
      rawData: dataA,
      areaStyle: { color: '#f00', opacity: 0.5 },
    });
    r.prepare(styled, dataA, xScale2, yScale);
    expect(r.didRewritePointsLastPrepare()).toBe(false);

    // Data ref change
    const dataB = { x: [0, 1, 2], y: [0, 1, 0], y1: [2, 2, 2] };
    r.prepare(makeSeries({ data: dataB, rawData: dataB }), dataB, xScale2, yScale);
    expect(r.didRewritePointsLastPrepare()).toBe(true);

    r.dispose();
  });

  it('invalidateGeometry forces re-pack under stable data ref', () => {
    const device = makeDevice();
    const r = createBandRenderer(device, { sampleCount: 4 });
    const xScale = createLinearScale().domain(0, 1).range(0, 100);
    const yScale = createLinearScale().domain(0, 1).range(100, 0);
    const data = { x: [0, 1], y: [0, 0], y1: [1, 1] };
    const series = makeSeries({ data, rawData: data });
    r.prepare(series, data, xScale, yScale);
    expect(r.didRewritePointsLastPrepare()).toBe(true);
    r.prepare(series, data, xScale, yScale);
    expect(r.didRewritePointsLastPrepare()).toBe(false);
    r.invalidateGeometry();
    r.prepare(series, data, xScale, yScale);
    expect(r.didRewritePointsLastPrepare()).toBe(true);
    r.dispose();
  });

  it('first-enable stroke packs XY buffer without requiring data ref change', () => {
    const device = makeDevice();
    const r = createBandRenderer(device, { sampleCount: 4 });
    const xScale = createLinearScale().domain(0, 1).range(0, 100);
    const yScale = createLinearScale().domain(0, 1).range(100, 0);
    const data = { x: [0, 1, 2], y: [0, 0, 0], y1: [1, 1, 1] };
    // Fill-only first (no lineStyle)
    const fillOnly = makeSeries({ data, rawData: data, lineStyle: undefined });
    r.prepare(fillOnly, data, xScale, yScale);
    expect(r.didRewritePointsLastPrepare()).toBe(true);
    const writesAfterFill = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;

    // Enable y stroke with same data ref — stroke buffer must upload even though fill identity stable.
    const withStroke = makeSeries({
      data,
      rawData: data,
      lineStyle: { width: 1.5, opacity: 1, color: '#38bdf8' },
    });
    r.prepare(withStroke, data, xScale, yScale);
    expect(r.didRewritePointsLastPrepare()).toBe(false); // fill not rewritten
    const writesAfterStroke = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writesAfterStroke).toBeGreaterThan(writesAfterFill); // stroke pack wrote

    r.dispose();
  });
});
