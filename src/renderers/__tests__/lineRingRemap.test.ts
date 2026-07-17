/**
 * Issue 0.1: modular ring raw-line ordering — LineRenderer must pass ring
 * layout into VS uniforms so line.wgsl remaps logical → physical indices.
 */

/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedLineSeriesConfig } from '../../config/OptionResolver';
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

import { createLineRenderer } from '../createLineRenderer';
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
    createBuffer: vi.fn(() => ({
      destroy: vi.fn(),
      size: 256,
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
  } as unknown as GPUDevice;
}

function makeSeries(data: DataPoint[]): ResolvedLineSeriesConfig {
  return {
    type: 'line',
    data,
    rawData: data,
    color: '#0af',
    lineStyle: { width: 2, opacity: 1, color: '#0af' },
    sampling: 'none',
    samplingThreshold: 5000,
    connectNulls: false,
    yAxis: 'y',
    visible: true,
  } as ResolvedLineSeriesConfig;
}

describe('LineRenderer modular ring remap (issue 0.1)', () => {
  it('writes ringStart/ringCapacity into VS uniforms when layout is modular', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const data = makeSeries([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
    const dataBuffer = { label: 'raw' } as GPUBuffer;
    const xScale = createLinearScale({ domain: [0, 10], range: [0, 1] });
    const yScale = createLinearScale({ domain: [0, 10], range: [0, 1] });

    vi.mocked(writeUniformBuffer).mockClear();
    renderer.prepare(
      data,
      dataBuffer,
      xScale,
      yScale,
      0,
      1,
      800,
      600,
      4,
      1,
      { start: 1, capacity: 4 } // writes ring layout uniforms; segment order is shader pointAt contract
    );

    // First writeUniformBuffer call is VS (96-byte buffer with ring u32s).
    const vsCall = vi.mocked(writeUniformBuffer).mock.calls.find((c) => {
      const payload = c[2];
      return payload instanceof ArrayBuffer && payload.byteLength === 96;
    });
    expect(vsCall).toBeDefined();
    const u32 = new Uint32Array(vsCall![2] as ArrayBuffer);
    // ringStart @ float index 20 → u32 index 20; ringCapacity @ 21
    expect(u32[20]).toBe(1);
    expect(u32[21]).toBe(4);
    renderer.dispose();
  });

  it('writes ringCapacity 0 for linear layout', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const data = makeSeries([
      [1, 1],
      [2, 2],
    ]);
    const dataBuffer = { label: 'raw' } as GPUBuffer;
    const xScale = createLinearScale({ domain: [0, 10], range: [0, 1] });
    const yScale = createLinearScale({ domain: [0, 10], range: [0, 1] });

    vi.mocked(writeUniformBuffer).mockClear();
    renderer.prepare(data, dataBuffer, xScale, yScale, 0, 1, 800, 600, 2, 1, {
      start: 0,
      capacity: 0,
    });

    const vsCall = vi.mocked(writeUniformBuffer).mock.calls.find((c) => {
      const payload = c[2];
      return payload instanceof ArrayBuffer && payload.byteLength === 96;
    });
    expect(vsCall).toBeDefined();
    const u32 = new Uint32Array(vsCall![2] as ArrayBuffer);
    expect(u32[20]).toBe(0);
    expect(u32[21]).toBe(0);
    renderer.dispose();
  });
});
