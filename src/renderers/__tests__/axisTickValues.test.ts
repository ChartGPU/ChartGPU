/**
 * GPU axis marks must use explicit tick domain values when provided (#161).
 * Captures vertex writeBuffer to assert mark positions match scale.scale(value).
 */

/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, vi } from 'vitest';
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
});

import { createAxisRenderer } from '../createAxisRenderer';

function createMockDevice() {
  const writeBuffer = vi.fn();
  return {
    label: 'mockDevice',
    limits: {
      maxUniformBufferBindingSize: 65536,
      minUniformBufferOffsetAlignment: 256,
    },
    queue: {
      writeBuffer,
      submit: vi.fn(),
    },
    createBuffer: vi.fn(() => ({
      destroy: vi.fn(),
      size: 4096,
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    writeBuffer,
  } as unknown as GPUDevice & { writeBuffer: ReturnType<typeof vi.fn> };
}

vi.mock('../rendererUtils', () => ({
  createRenderPipeline: vi.fn(() => ({})),
  createUniformBuffer: vi.fn(() => ({ destroy: vi.fn() })),
  writeUniformBuffer: vi.fn(),
}));

function makeGridArea(): GridArea {
  return {
    left: 40,
    right: 20,
    top: 20,
    bottom: 40,
    canvasWidth: 800,
    canvasHeight: 400,
    devicePixelRatio: 1,
  };
}

function readVertexFloats(device: ReturnType<typeof createMockDevice>): Float32Array {
  // First writeBuffer call is the vertex buffer upload (identity/color uniforms go through writeUniformBuffer mock).
  const calls = device.queue.writeBuffer.mock.calls as unknown as Array<[unknown, number, ArrayBuffer, number, number]>;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const [, , data, offset, byteLength] = calls[0]!;
  return new Float32Array(data, offset ?? 0, (byteLength ?? data.byteLength) / 4);
}

describe('AxisRenderer explicit tick values (#161)', () => {
  it('places x-axis marks at scale.scale(tickValues[i]), not linear domain splits', () => {
    const device = createMockDevice();
    const renderer = createAxisRenderer(device);
    const domainMin = Date.UTC(2026, 4, 13, 4, 42, 0);
    const domainMax = domainMin + 24 * 3_600_000;
    // Nice 3h-aligned values (not endpoints).
    const tickValues = [
      Date.UTC(2026, 4, 13, 6, 0, 0),
      Date.UTC(2026, 4, 13, 9, 0, 0),
      Date.UTC(2026, 4, 13, 12, 0, 0),
      Date.UTC(2026, 4, 13, 15, 0, 0),
      Date.UTC(2026, 4, 13, 18, 0, 0),
      Date.UTC(2026, 4, 13, 21, 0, 0),
    ];

    // Clip-space range matching generateAxisVertices plot rect for this gridArea.
    // plotLeftClip / plotRightClip with left=40, right=20, width=800, dpr=1:
    // plotLeft=40 → clip = 40/800*2-1 = -0.9
    // plotRight=780 → clip = 780/800*2-1 = 0.95
    const plotLeftClip = -0.9;
    const plotRightClip = 0.95;
    const scale = createLinearScale().domain(domainMin, domainMax).range(plotLeftClip, plotRightClip);

    renderer.prepare(
      { type: 'time', min: domainMin, max: domainMax },
      scale,
      'x',
      makeGridArea(),
      '#fff',
      '#fff',
      tickValues.length,
      tickValues
    );

    const verts = readVertexFloats(device);
    // Layout: baseline 4 floats (2 verts), then per tick 4 floats (2 verts with same x).
    expect(verts.length).toBe(4 + tickValues.length * 4);

    for (let i = 0; i < tickValues.length; i++) {
      const expectedX = scale.scale(tickValues[i]!);
      const tickBase = 4 + i * 4;
      expect(verts[tickBase]).toBeCloseTo(expectedX, 5);
      expect(verts[tickBase + 2]).toBeCloseTo(expectedX, 5);
    }

    // Must NOT match linear first tick at domainMin (awkward 04:42).
    const linearFirstX = scale.scale(domainMin);
    expect(verts[4]).not.toBeCloseTo(linearFirstX, 5);

    renderer.dispose();
  });

  it('falls back to linear domain splits when tickValues omitted', () => {
    const device = createMockDevice();
    const renderer = createAxisRenderer(device);
    const domainMin = 0;
    const domainMax = 100;
    const plotLeftClip = -0.9;
    const plotRightClip = 0.95;
    const scale = createLinearScale().domain(domainMin, domainMax).range(plotLeftClip, plotRightClip);
    const tickCount = 5;

    renderer.prepare(
      { type: 'value', min: domainMin, max: domainMax },
      scale,
      'x',
      makeGridArea(),
      '#fff',
      '#fff',
      tickCount
    );

    const verts = readVertexFloats(device);
    for (let i = 0; i < tickCount; i++) {
      const t = i / (tickCount - 1);
      const expectedX = scale.scale(domainMin + t * (domainMax - domainMin));
      const tickBase = 4 + i * 4;
      expect(verts[tickBase]).toBeCloseTo(expectedX, 5);
    }

    renderer.dispose();
  });
});
