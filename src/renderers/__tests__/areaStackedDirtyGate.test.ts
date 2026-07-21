/**
 * Area stacked geometry dirty gate: 16 bytes/point pack, identity reuse, unstacked isolation.
 */
/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedAreaSeriesConfig } from '../../config/OptionResolver';
import type { DataPoint } from '../../config/types';

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

import { createAreaRenderer } from '../createAreaRenderer';
import { writeUniformBuffer } from '../rendererUtils';

vi.mock('../rendererUtils', () => ({
  createRenderPipeline: vi.fn(() => ({})),
  createUniformBuffer: vi.fn(() => ({ destroy: vi.fn() })),
  writeUniformBuffer: vi.fn(),
}));

function createMockDevice() {
  return {
    label: 'mockDevice',
    limits: {
      maxUniformBufferBindingSize: 65536,
      minUniformBufferOffsetAlignment: 256,
    },
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

function areaConfig(data: ReadonlyArray<DataPoint>): ResolvedAreaSeriesConfig {
  return {
    type: 'area',
    name: 'a',
    data,
    rawData: data,
    color: '#0af',
    areaStyle: { opacity: 0.3, color: '#0af' },
    sampling: 'none',
    samplingThreshold: 5000,
    connectNulls: false,
    yAxis: 'y',
    visible: true,
    stack: 's',
  } as ResolvedAreaSeriesConfig;
}

describe('area stacked dirty gate', () => {
  it('packs 16 bytes per point and skips rewrite when stack refs stable', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const yBottom = new Float64Array([0, 0, 0]);
    const yTop = new Float64Array([1, 2, 3]);
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScale = createLinearScale().domain(0, 4).range(100, 0);
    const cfg = areaConfig(data);

    renderer.prepare(cfg, data, xScale, yScale, 0, undefined, undefined, 0, { yBottom, yTop });
    const writesAfterFirst = writeBuffer.mock.calls.length;
    expect(writesAfterFirst).toBeGreaterThan(0);
    // Stacked pack: hard assert N×16 bytes (AreaPoint {x,yTop,yBottom,pad})
    const sizes = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number');
    expect(sizes).toContain(3 * 16);
    expect(sizes).not.toContain(3 * 8);

    writeBuffer.mockClear();
    (writeUniformBuffer as ReturnType<typeof vi.fn>).mockClear();
    // Same data + same stack arrays → no geometry rewrite
    renderer.prepare(cfg, data, xScale, yScale, 0, undefined, undefined, 0, { yBottom, yTop });
    const geomWrites = writeBuffer.mock.calls.length;
    expect(geomWrites).toBe(0);

    // Peer stack mutation (new yTop ref) re-packs
    const yTop2 = new Float64Array([2, 3, 4]);
    renderer.prepare(cfg, data, xScale, yScale, 0, undefined, undefined, 0, { yBottom, yTop: yTop2 });
    expect(writeBuffer.mock.calls.length).toBeGreaterThan(0);
    const sizesAfterMut = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number');
    expect(sizesAfterMut).toContain(3 * 16);

    renderer.dispose();
  });

  it('unstacked path still packs 8 bytes/point without stackGeometry', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const n = data.length;
    const xScale = createLinearScale().domain(0, 1).range(0, 100);
    const yScale = createLinearScale().domain(0, 2).range(100, 0);
    const cfg = { ...areaConfig(data), stack: undefined } as ResolvedAreaSeriesConfig;
    renderer.prepare(cfg, data, xScale, yScale, 0);
    expect(writeBuffer.mock.calls.length).toBeGreaterThan(0);
    const sizes = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number');
    expect(sizes).toContain(n * 8);
    expect(sizes).not.toContain(n * 16);
    renderer.dispose();
  });
});
