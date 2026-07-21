/**
 * Area geometry identity cache: skip vertex writeBuffer when data ref is stable;
 * rebuild on new ref or after invalidateGeometry (animation interpolation).
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

const writeUniformBufferMock = writeUniformBuffer as ReturnType<typeof vi.fn>;

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
      size: 256 * 1024,
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
  } as unknown as GPUDevice;
}

function areaConfig(
  data: ReadonlyArray<DataPoint>,
  extra: Partial<ResolvedAreaSeriesConfig> = {}
): ResolvedAreaSeriesConfig {
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
    ...extra,
  } as ResolvedAreaSeriesConfig;
}

describe('createAreaRenderer geometry cache', () => {
  it('skips vertex writeBuffer on second prepare with same data ref (axes-only)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 0],
    ];
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScaleA = createLinearScale().domain(0, 2).range(100, 0);
    const yScaleB = createLinearScale().domain(-1, 3).range(100, 0);
    const cfg = areaConfig(data);

    renderer.prepare(cfg, data, xScale, yScaleA, 0);
    // Uniforms go through mocked writeUniformBuffer; queue.writeBuffer is vertex-only.
    expect(writeBuffer).toHaveBeenCalledTimes(1);

    // Axes-only: new y scale, same data identity — no second vertex upload.
    renderer.prepare(cfg, data, xScale, yScaleB, 0);
    expect(writeBuffer).toHaveBeenCalledTimes(1);

    renderer.dispose();
  });

  it('re-uploads vertices when data reference changes', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    const data1: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 0],
    ];
    const data2: DataPoint[] = [
      [0, 9],
      [1, 8],
      [2, 7],
    ];
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScale = createLinearScale().domain(0, 10).range(100, 0);

    renderer.prepare(areaConfig(data1), data1, xScale, yScale, 0);
    renderer.prepare(areaConfig(data2), data2, xScale, yScale, 0);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('re-uploads after invalidateGeometry even with same data ref', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScale = createLinearScale().domain(0, 3).range(100, 0);
    const cfg = areaConfig(data);

    renderer.prepare(cfg, data, xScale, yScale, 0);
    // Mutate under stable ref (interpolation contract).
    (data[1] as [number, number])[1] = 99;
    renderer.invalidateGeometry();
    renderer.prepare(cfg, data, xScale, yScale, 0);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('re-uploads when length grows under stable column ref (streaming append)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    // Owned XY columns — same object identity across appends, growing length.
    const cols = { x: [0, 1], y: [1, 2] };
    const xScale = createLinearScale().domain(0, 10).range(0, 100);
    const yScale = createLinearScale().domain(0, 10).range(100, 0);
    const cfg = areaConfig(cols as any);

    renderer.prepare(cfg, cols as any, xScale, yScale, 0);
    expect(writeBuffer).toHaveBeenCalledTimes(1);

    cols.x.push(2);
    cols.y.push(3);
    renderer.prepare(cfg, cols as any, xScale, yScale, 0);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('packs N*8 bytes (not N*16 strip expansion) into private storage (1.4)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    const n = 10;
    const data: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i]);
    const xScale = createLinearScale().domain(0, n).range(0, 100);
    const yScale = createLinearScale().domain(0, n).range(100, 0);

    renderer.prepare(areaConfig(data), data, xScale, yScale, 0);
    const sizes = writeBuffer.mock.calls.map((c) => c[4]).filter((s): s is number => typeof s === 'number');
    expect(sizes).toContain(n * 8);
    expect(sizes).not.toContain(n * 16);
    renderer.dispose();
  });

  it('skips private writeBuffer when binding external storage buffer', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScale = createLinearScale().domain(0, 3).range(100, 0);
    const external = { size: 1024, destroy: vi.fn() } as unknown as GPUBuffer;

    renderer.prepare(areaConfig(data), data, xScale, yScale, 0, external, 3, 0);
    expect(writeBuffer).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('throws when storageBuffer is set without pointCountOverride', () => {
    const device = createMockDevice();
    const renderer = createAreaRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScale = createLinearScale().domain(0, 3).range(100, 0);
    const external = { size: 1024, destroy: vi.fn() } as unknown as GPUBuffer;
    expect(() => renderer.prepare(areaConfig(data), data, xScale, yScale, 0, external)).toThrow(/pointCountOverride/);
    renderer.dispose();
  });

  it('skips uniform writes on second prepare with identical inputs (issue 2.5)', () => {
    const device = createMockDevice();
    writeUniformBufferMock.mockClear();
    const renderer = createAreaRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 0],
    ];
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScale = createLinearScale().domain(0, 2).range(100, 0);
    const cfg = areaConfig(data);

    renderer.prepare(cfg, data, xScale, yScale, 0);
    const afterFirst = writeUniformBufferMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    writeUniformBufferMock.mockClear();
    renderer.prepare(cfg, data, xScale, yScale, 0);
    expect(writeUniformBufferMock).not.toHaveBeenCalled();

    // Scale change → VS uniform write.
    writeUniformBufferMock.mockClear();
    const y2 = createLinearScale().domain(-1, 3).range(100, 0);
    renderer.prepare(cfg, data, xScale, y2, 0);
    expect(writeUniformBufferMock.mock.calls.length).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('places packed time-axis origin on-screen via external storage (no bx+ax*xOffset cancellation)', () => {
    const device = createMockDevice();
    writeUniformBufferMock.mockClear();
    const renderer = createAreaRenderer(device);
    const origin = 1_704_067_200_000; // 2024-01-01T00:00:00Z
    const span = 899 * 60_000;
    const data: DataPoint[] = [
      [origin, 0],
      [origin + span, 1],
    ];
    const plotLeft = -0.8676748582230625;
    const plotRight = 0.9546313799621928;
    const xScale = createLinearScale()
      .domain(origin, origin + span)
      .range(plotLeft, plotRight);
    const yScale = createLinearScale().domain(-0.2, 1).range(-0.9, 0.9);
    const external = { size: 1024, destroy: vi.fn() } as unknown as GPUBuffer;

    // External storage path uses packing-origin X affine (same as LineRenderer).
    renderer.prepare(areaConfig(data), data, xScale, yScale, 0, external, 2, origin);

    // Area VS uniforms: mat4 + baseline/log (80 bytes).
    const vsWrites = writeUniformBufferMock.mock.calls.filter((c) => {
      const dataArg = c[2];
      return dataArg instanceof ArrayBuffer && dataArg.byteLength === 96;
    });
    expect(vsWrites.length).toBeGreaterThan(0);
    const f32 = new Float32Array(vsWrites[0]![2] as ArrayBuffer);
    // mat4: ax at [0], bx at [12] (column-major translation x)
    const ax = f32[0]!;
    const bx = f32[12]!;
    // Packed x=0 maps to scale(origin) ≈ plotLeft; packed end maps near plotRight.
    expect(bx).toBeCloseTo(plotLeft, 5);
    expect(ax * span + bx).toBeCloseTo(plotRight, 5);
    // Regression: old bx+ax*origin path yielded ~-3.7 (off-screen left).
    expect(bx).toBeGreaterThan(-1.5);
    expect(bx).toBeLessThan(1.5);

    renderer.dispose();
  });

  it('render uses instanced trapezoid draw(6, segments) not continuous strip (issue #153)', () => {
    const device = createMockDevice();
    const renderer = createAreaRenderer(device);
    // Issue #153 repro shape: three finite runs separated by nulls.
    const data: Array<DataPoint | null> = [
      [0, 0.75],
      [0.25, 0.75],
      null,
      [0.75, 0.75],
      [1.0, 0.75],
      null,
      [1.5, 0.75],
      [2, 0.75],
    ];
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScale = createLinearScale().domain(0, 1).range(100, 0);
    const cfg = areaConfig(data as DataPoint[]);

    renderer.prepare(cfg, data as DataPoint[], xScale, yScale, 0.5);

    const draws: Array<{ v: number; i: number }> = [];
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((v: number, i: number) => {
        draws.push({ v, i });
      }),
    } as unknown as GPURenderPassEncoder;

    renderer.render(pass);
    // 8 points → 7 segments; 6 verts/instance (not legacy strip draw(N*2)).
    expect(draws).toEqual([{ v: 6, i: 7 }]);
    renderer.dispose();
  });

  it('external storage path draws draw(6, pointCountOverride-1) without private writeBuffer', () => {
    // Line+areaStyle / pure-area DataStore path: shared buffer + override count.
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    // data.length deliberately differs from override to prove draw uses override.
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
    ];
    const overrideN = 5;
    const xScale = createLinearScale().domain(0, 4).range(0, 100);
    const yScale = createLinearScale().domain(0, 4).range(100, 0);
    const external = { size: 1024, destroy: vi.fn() } as unknown as GPUBuffer;

    renderer.prepare(areaConfig(data), data, xScale, yScale, 0, external, overrideN, 0);
    expect(writeBuffer).not.toHaveBeenCalled();

    const draws: Array<{ v: number; i: number }> = [];
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((v: number, i: number) => {
        draws.push({ v, i });
      }),
    } as unknown as GPURenderPassEncoder;
    renderer.render(pass);
    expect(draws).toEqual([{ v: 6, i: overrideN - 1 }]);
    renderer.dispose();
  });

  it('external storage with pointCountOverride < 2 skips draw', () => {
    const device = createMockDevice();
    const renderer = createAreaRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScale = createLinearScale().domain(0, 3).range(100, 0);
    const external = { size: 1024, destroy: vi.fn() } as unknown as GPUBuffer;

    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;

    renderer.prepare(areaConfig(data), data, xScale, yScale, 0, external, 0, 0);
    renderer.render(pass);
    expect(pass.draw).not.toHaveBeenCalled();

    (pass.draw as ReturnType<typeof vi.fn>).mockClear();
    renderer.prepare(areaConfig(data), data, xScale, yScale, 0, external, 1, 0);
    renderer.render(pass);
    expect(pass.draw).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('skips draw when fewer than 2 points (private pack, single and empty)', () => {
    const device = createMockDevice();
    const renderer = createAreaRenderer(device);
    const xScale = createLinearScale().domain(0, 1).range(0, 100);
    const yScale = createLinearScale().domain(0, 1).range(100, 0);

    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;

    const single: DataPoint[] = [[0, 1]];
    renderer.prepare(areaConfig(single), single, xScale, yScale, 0);
    renderer.render(pass);
    expect(pass.draw).not.toHaveBeenCalled();

    (pass.draw as ReturnType<typeof vi.fn>).mockClear();
    const empty: DataPoint[] = [];
    renderer.prepare(areaConfig(empty), empty, xScale, yScale, 0);
    renderer.render(pass);
    expect(pass.draw).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('packs NaN for null gap entries so VS dual-endpoint discard can fire (issue #153)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    // Minimal repro from issue #153.
    const data: Array<DataPoint | null> = [
      [0, 0.75],
      [0.25, 0.75],
      null,
      [0.75, 0.75],
      [1.0, 0.75],
      null,
      [1.5, 0.75],
      [2, 0.75],
    ];
    const xScale = createLinearScale().domain(0, 2).range(0, 100);
    const yScale = createLinearScale().domain(0, 1).range(100, 0);

    renderer.prepare(areaConfig(data as DataPoint[]), data as DataPoint[], xScale, yScale, 0.5);

    expect(writeBuffer).toHaveBeenCalledTimes(1);
    const ab = writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const byteOffset = writeBuffer.mock.calls[0]![3] as number;
    const byteLength = writeBuffer.mock.calls[0]![4] as number;
    const packed = new Float32Array(ab, byteOffset, byteLength / 4);
    // Index 2 and 5 are null → NaN pairs at floats [4,5] and [10,11].
    expect(Number.isNaN(packed[4])).toBe(true);
    expect(Number.isNaN(packed[5])).toBe(true);
    expect(Number.isNaN(packed[10])).toBe(true);
    expect(Number.isNaN(packed[11])).toBe(true);
    // Finite neighbors stay finite (no silent NaN bleed).
    expect(packed[0]).toBe(0);
    expect(packed[1]).toBe(0.75);
    expect(packed[6]).toBe(0.75);
    expect(packed[7]).toBe(0.75);
    expect(packed[14]).toBe(2);
    expect(packed[15]).toBe(0.75);
    renderer.dispose();
  });

  it('packs leading nulls as NaN without shifting subsequent points', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    const data: Array<DataPoint | null> = [null, [1, 2], [3, 4]];
    const xScale = createLinearScale().domain(0, 3).range(0, 100);
    const yScale = createLinearScale().domain(0, 4).range(100, 0);

    renderer.prepare(areaConfig(data as DataPoint[]), data as DataPoint[], xScale, yScale, 0);

    const ab = writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const byteOffset = writeBuffer.mock.calls[0]![3] as number;
    const byteLength = writeBuffer.mock.calls[0]![4] as number;
    const packed = new Float32Array(ab, byteOffset, byteLength / 4);
    expect(Number.isNaN(packed[0])).toBe(true);
    expect(Number.isNaN(packed[1])).toBe(true);
    expect(packed[2]).toBe(1);
    expect(packed[3]).toBe(2);
    expect(packed[4]).toBe(3);
    expect(packed[5]).toBe(4);
    renderer.dispose();
  });

  it('packs consecutive and trailing nulls as NaN pairs; draw still uses N-1 segments', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    // Indices 1,2 consecutive nulls; index 4 trailing null.
    const data: Array<DataPoint | null> = [[0, 1], null, null, [3, 4], null];
    const xScale = createLinearScale().domain(0, 3).range(0, 100);
    const yScale = createLinearScale().domain(0, 4).range(100, 0);

    renderer.prepare(areaConfig(data as DataPoint[]), data as DataPoint[], xScale, yScale, 0);

    const ab = writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const byteOffset = writeBuffer.mock.calls[0]![3] as number;
    const byteLength = writeBuffer.mock.calls[0]![4] as number;
    const packed = new Float32Array(ab, byteOffset, byteLength / 4);
    expect(packed.length).toBe(10); // 5 points × 2
    expect(packed[0]).toBe(0);
    expect(packed[1]).toBe(1);
    expect(Number.isNaN(packed[2])).toBe(true);
    expect(Number.isNaN(packed[3])).toBe(true);
    expect(Number.isNaN(packed[4])).toBe(true);
    expect(Number.isNaN(packed[5])).toBe(true);
    expect(packed[6]).toBe(3);
    expect(packed[7]).toBe(4);
    expect(Number.isNaN(packed[8])).toBe(true);
    expect(Number.isNaN(packed[9])).toBe(true);

    const draws: Array<{ v: number; i: number }> = [];
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((v: number, i: number) => {
        draws.push({ v, i });
      }),
    } as unknown as GPURenderPassEncoder;
    renderer.render(pass);
    // 5 points → 4 segment instances (gap discard is GPU-side).
    expect(draws).toEqual([{ v: 6, i: 4 }]);
    renderer.dispose();
  });

  it('connectNulls-modeled continuous input packs all-finite and draws draw(6, N-1)', () => {
    // Models coordinator connectNulls path: filterGaps strips nulls before prepare,
    // so the area renderer only ever sees continuous finite points.
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createAreaRenderer(device);
    // filterGaps([[0,1], null, [2,3], null, [4,5]]) → these 3 points.
    const bridged: DataPoint[] = [
      [0, 1],
      [2, 3],
      [4, 5],
    ];
    const xScale = createLinearScale().domain(0, 4).range(0, 100);
    const yScale = createLinearScale().domain(0, 5).range(100, 0);

    renderer.prepare(areaConfig(bridged, { connectNulls: true }), bridged, xScale, yScale, 0);

    const ab = writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const byteOffset = writeBuffer.mock.calls[0]![3] as number;
    const byteLength = writeBuffer.mock.calls[0]![4] as number;
    const packed = new Float32Array(ab, byteOffset, byteLength / 4);
    expect(packed.length).toBe(6);
    for (let i = 0; i < packed.length; i++) {
      expect(Number.isFinite(packed[i]!)).toBe(true);
    }
    expect(Array.from(packed)).toEqual([0, 1, 2, 3, 4, 5]);

    const draws: Array<{ v: number; i: number }> = [];
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((v: number, i: number) => {
        draws.push({ v, i });
      }),
    } as unknown as GPURenderPassEncoder;
    renderer.render(pass);
    expect(draws).toEqual([{ v: 6, i: 2 }]);
    renderer.dispose();
  });
});

describe('area.wgsl gap contract (issue #153)', () => {
  it('vsMain dual-endpoint NaN-checks both segment ends (not single-point strip collapse)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../shaders/area.wgsl'), 'utf8');
    const vsStart = src.indexOf('fn vsMain');
    expect(vsStart).toBeGreaterThan(-1);
    const vsBody = src.slice(vsStart, src.indexOf('fn fsMain'));
    // Per-segment endpoints (instanced), not vertex_index/2 continuous strip.
    // Dense LOD: points[i0]/points[i1] (stride 1 ≡ instanceIndex / +1).
    expect(vsBody).toMatch(/points\[i0\]|points\[instanceIndex\]/);
    expect(vsBody).toMatch(/points\[i1\]|points\[instanceIndex \+ 1u\]/);
    expect(vsBody).toMatch(/pA\.x != pA\.x/);
    expect(vsBody).toMatch(/pA\.y != pA\.y/);
    expect(vsBody).toMatch(/pB\.x != pB\.x/);
    expect(vsBody).toMatch(/pB\.y != pB\.y/);
    // Gap collapse must zero clip position (rasterizer discard), not leave a spur.
    expect(vsBody).toMatch(/clipPosition\s*=\s*vec4<f32>\(\s*0\.0\s*,\s*0\.0\s*,\s*0\.0\s*,\s*0\.0\s*\)/);
    // Must not claim strip collapse "breaks" gaps (stale contract).
    expect(src).not.toMatch(/zero-area strip breaks/i);
  });

  it('uses triangle-list instanced topology (6 verts × segments), not continuous strip', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const shader = fs.readFileSync(path.resolve(__dirname, '../../shaders/area.wgsl'), 'utf8');
    const rendererSrc = fs.readFileSync(path.resolve(__dirname, '../createAreaRenderer.ts'), 'utf8');
    // Shader contract: instancing + dual-endpoint (topology is enforced on the TS pipeline).
    expect(shader).toMatch(/instance_index/);
    expect(shader).toMatch(/pA\.x != pA\.x/);
    expect(shader).toMatch(/pB\.x != pB\.x/);
    expect(rendererSrc).toMatch(/topology:\s*['"]triangle-list['"]/);
    expect(rendererSrc).toMatch(/draw\(6,\s*drawSegmentCount\)|draw\(6,\s*segments\)/);
    // Legacy continuous strip path must stay gone.
    expect(rendererSrc).not.toMatch(/draw\(pointCount \* 2\)/);
  });
});
