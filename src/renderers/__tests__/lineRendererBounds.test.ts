/**
 * P2-5: Line prepare must not O(n)-scan series data for bounds.
 * Affine is derived from scale.scale(0)/scale.scale(1) only.
 */

/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, vi, type Mock } from 'vitest';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedLineSeriesConfig } from '../../config/OptionResolver';
import type { DataPoint } from '../../config/types';
import * as cartesianData from '../../data/cartesianData';

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

import { createLineRenderer, beginLineSharedVsFrame } from '../createLineRenderer';

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

vi.mock('../rendererUtils', () => ({
  createRenderPipeline: vi.fn(() => ({})),
  createUniformBuffer: vi.fn(() => ({ destroy: vi.fn() })),
  writeUniformBuffer: vi.fn(),
}));

import { createRenderPipeline, writeUniformBuffer } from '../rendererUtils';

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

describe('createLineRenderer uniform dirty-skip (issue 2.5)', () => {
  it('skips uniform writes on second prepare with identical inputs', () => {
    const device = createMockDevice();
    const writeUniform = writeUniformBuffer as ReturnType<typeof vi.fn>;
    writeUniform.mockClear();
    const renderer = createLineRenderer(device);
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const series = {
      type: 'line',
      name: 's',
      data,
      rawData: data,
      color: '#0af',
      lineStyle: { width: 2, opacity: 1 },
      sampling: 'none',
      samplingThreshold: 5000,
      connectNulls: false,
      yAxis: 'y',
      visible: true,
    } as unknown as ResolvedLineSeriesConfig;
    const buf = { size: 64 } as unknown as GPUBuffer;
    const x = createLinearScale().domain(0, 2).range(-1, 1);
    const y = createLinearScale().domain(0, 3).range(-1, 1);

    renderer.prepare(series, buf, x, y, 0, 1, 800, 600);
    const afterFirst = writeUniform.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    writeUniform.mockClear();
    renderer.prepare(series, buf, x, y, 0, 1, 800, 600);
    expect(writeUniform).not.toHaveBeenCalled();

    // Scale change → VS uniform write.
    writeUniform.mockClear();
    const y2 = createLinearScale().domain(0, 10).range(-1, 1);
    renderer.prepare(series, buf, x, y2, 0, 1, 800, 600);
    expect(writeUniform.mock.calls.length).toBeGreaterThan(0);
    renderer.dispose();
  });
});

describe('createLineRenderer bounds (P2-5)', () => {
  it('does not call computeRawBoundsFromCartesianData during prepare', () => {
    const boundsSpy = vi.spyOn(cartesianData, 'computeRawBoundsFromCartesianData');
    const device = createMockDevice();
    const renderer = createLineRenderer(device);
    const data: DataPoint[] = Array.from({ length: 50_000 }, (_, i) => [i, Math.sin(i * 0.01)]);
    const series = {
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

    const xScale = createLinearScale().domain(0, 50_000).range(-1, 1);
    const yScale = createLinearScale().domain(-1, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;

    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 2, 1280, 720);

    expect(boundsSpy).not.toHaveBeenCalled();
    boundsSpy.mockRestore();
    renderer.dispose();
  });

  it('samples scale affine only at 0 and 1 (not per-point)', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device);
    const data: DataPoint[] = Array.from({ length: 10_000 }, (_, i) => [i, i]);
    const series = {
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

    const xScale = createLinearScale().domain(0, 10_000).range(-1, 1);
    const yScale = createLinearScale().domain(0, 10_000).range(1, -1);
    const xScaleSpy = vi.spyOn(xScale, 'scale');
    const yScaleSpy = vi.spyOn(yScale, 'scale');
    const dataBuffer = { label: 'data' } as GPUBuffer;

    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 2, 1280, 720);

    // Affine from (0,1) only — four scale() calls total across both axes.
    expect(xScaleSpy.mock.calls.map((c) => c[0])).toEqual([0, 1]);
    expect(yScaleSpy.mock.calls.map((c) => c[0])).toEqual([0, 1]);
    // Must not scale each data point (would be O(n)).
    expect(xScaleSpy).toHaveBeenCalledTimes(2);
    expect(yScaleSpy).toHaveBeenCalledTimes(2);

    xScaleSpy.mockRestore();
    yScaleSpy.mockRestore();
    renderer.dispose();
  });

  it('structurally does not import bounds scan into prepare path', async () => {
    // Source-level regression: prepare path must stay on affine (0,1).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../createLineRenderer.ts'), 'utf8');
    expect(src).not.toMatch(/computeRawBoundsFromCartesianData/);
    expect(src).toMatch(/computeClipAffineFromScale\(xScale, 0, 1\)/);
    expect(src).toMatch(/computeClipAffineFromScale\(yScale, 0, 1\)/);
  });

  it('denseHairline prepare writes floor line width into VS uniform at high N', () => {
    const device = createMockDevice();
    const writeUniform = writeUniformBuffer as ReturnType<typeof vi.fn>;
    writeUniform.mockClear();
    // Hairline only when main MSAA is 4× (multi-chart antialias:false stays AA quads).
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    // pointCountOverride drives policy; ≥25k → hairline floor 1 CSS px
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;

    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600, 50_000);

    const vsWrites = writeUniform.mock.calls.filter((c) => {
      const dataArg = c[2];
      return dataArg instanceof ArrayBuffer && dataArg.byteLength === 80;
    });
    expect(vsWrites.length).toBeGreaterThan(0);
    const f32 = new Float32Array(vsWrites[vsWrites.length - 1]![2] as ArrayBuffer);
    // lineWidthCssPx at float index 19 (bookkeeping; hairline pipeline ignores expansion)
    expect(f32[19]).toBe(1);
    renderer.dispose();
  });

  it('hairline pipeline is line-list with sampleCount 1 (never 2)', () => {
    const device = createMockDevice();
    const createPipe = createRenderPipeline as ReturnType<typeof vi.fn>;
    createPipe.mockClear();
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    // Two pipelines: standard (main MSAA) + hairline (always sampleCount 1)
    expect(createPipe).toHaveBeenCalledTimes(2);
    const configs = createPipe.mock.calls.map((c) => c[1] as {
      label?: string;
      primitive?: { topology?: string };
      multisample?: { count?: number };
      vertex?: { entryPoint?: string };
    });
    const hairline = configs.find(
      (c) => c.label === 'lineRenderer/hairlinePipeline' || c.vertex?.entryPoint === 'vsMainHairline'
    );
    const standard = configs.find((c) => c.label === 'lineRenderer/pipeline');
    expect(hairline).toBeDefined();
    expect(hairline!.primitive?.topology).toBe('line-list');
    expect(hairline!.multisample?.count).toBe(1);
    expect(hairline!.multisample?.count).not.toBe(2);
    expect(standard?.primitive?.topology).toBe('triangle-list');
    expect(standard?.multisample?.count).toBe(4);
    renderer.dispose();
  });

  it('multi-series budget: prepare with lineSeriesCount=1000, pointCount=1000 → denseHairline', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600, 1000, 1000);
    expect(renderer.isDenseHairline()).toBe(true);
    renderer.dispose();
  });

  it('sampleCount 1 never selects denseHairline (multi-chart antialias:false)', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device, { sampleCount: 1 });
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600, 50_000, 1000);
    expect(renderer.isDenseHairline()).toBe(false);
    const draws: Array<{ v: number; i: number }> = [];
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((v: number, i: number) => {
        draws.push({ v, i });
      }),
    } as unknown as GPURenderPassEncoder;
    // Must draw AA quads in main pass (not deferred no-op).
    renderer.render(pass);
    expect(draws).toEqual([{ v: 6, i: 49_999 }]);
    renderer.dispose();
  });

  it('multi-series budget: same 1000 points with lineSeriesCount=1 stays standard', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device);
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600, 1000, 1);
    expect(renderer.isDenseHairline()).toBe(false);
    renderer.dispose();
  });

  it('private VS: each renderer writes its own buffer (multi-chart deferred-submit safe)', () => {
    // Shared device-global VS was removed: multi-chart deferred submit clobbered
    // chart A's transform when chart B prepared. Each renderer keeps a private buffer.
    const device = createMockDevice();
    const writeUniform = writeUniformBuffer as ReturnType<typeof vi.fn>;
    writeUniform.mockClear();
    beginLineSharedVsFrame();
    const a = createLineRenderer(device);
    const b = createLineRenderer(device);
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const bufA = { label: 'dataA' } as GPUBuffer;
    const bufB = { label: 'dataB' } as GPUBuffer;

    const vsWrites = () =>
      writeUniform.mock.calls.filter((c) => {
        const dataArg = c[2];
        return dataArg instanceof ArrayBuffer && dataArg.byteLength === 80;
      }).length;

    a.prepare(series, bufA, xScale, yScale, 0, 1, 800, 600, 10);
    const afterFirst = vsWrites();
    expect(afterFirst).toBeGreaterThan(0);
    b.prepare(series, bufB, xScale, yScale, 0, 1, 800, 600, 10);
    // Second renderer has its own last* state → second VS write.
    expect(vsWrites()).toBeGreaterThan(afterFirst);
    // Same renderer re-prepare unchanged → dirty-skip (no extra write).
    const afterSecond = vsWrites();
    a.prepare(series, bufA, xScale, yScale, 0, 1, 800, 600, 10);
    expect(vsWrites()).toBe(afterSecond);

    a.dispose();
    b.dispose();
  });

  it('private VS: divergent line width writes on second renderer', () => {
    const device = createMockDevice();
    const writeUniform = writeUniformBuffer as ReturnType<typeof vi.fn>;
    writeUniform.mockClear();
    beginLineSharedVsFrame();
    const a = createLineRenderer(device);
    const b = createLineRenderer(device);
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const thin = makeSeries(data);
    const thick = {
      ...makeSeries(data),
      lineStyle: { width: 5, opacity: 1, color: '#0af' },
    };
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const bufA = { label: 'dataA' } as GPUBuffer;
    const bufB = { label: 'dataB' } as GPUBuffer;

    const vsCount = () =>
      writeUniform.mock.calls.filter((c) => {
        const dataArg = c[2];
        return dataArg instanceof ArrayBuffer && dataArg.byteLength === 80;
      }).length;

    a.prepare(thin, bufA, xScale, yScale, 0, 1, 800, 600, 10);
    const afterFirst = vsCount();
    b.prepare(thick as typeof thin, bufB, xScale, yScale, 0, 1, 800, 600, 10);
    expect(vsCount()).toBeGreaterThan(afterFirst);

    a.dispose();
    b.dispose();
  });

  it('renderHairline skipSetPipeline true does not call setPipeline', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600, 50_000);
    expect(renderer.isDenseHairline()).toBe(true);

    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    renderer.renderHairline(pass, { skipSetPipeline: true });
    expect(pass.setPipeline).not.toHaveBeenCalled();
    expect(pass.setBindGroup).toHaveBeenCalled();
    expect(pass.draw).toHaveBeenCalled();

    (pass.setPipeline as ReturnType<typeof vi.fn>).mockClear();
    renderer.renderHairline(pass);
    expect(pass.setPipeline).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('pointCountOverride below threshold stays standard (false-positive miss)', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device);
    // Tiny data array but policy uses override (e.g. GPU decimation / low displayed N).
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;
    // 10k displayed — below hairline threshold (FIFO-like after decimation)
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600, 10_000);
    expect(renderer.isDenseHairline()).toBe(false);

    const draws: Array<{ v: number; i: number }> = [];
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((v: number, i: number) => {
        draws.push({ v, i });
      }),
    } as unknown as GPURenderPassEncoder;
    renderer.render(pass);
    expect(draws).toEqual([{ v: 6, i: 9_999 }]);
    renderer.renderHairline(pass);
    expect(draws).toEqual([{ v: 6, i: 9_999 }]); // hairline no-op when standard
    renderer.dispose();
  });

  it('pointCountOverride high forces hairline even when data array is short', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600, 50_000);
    expect(renderer.isDenseHairline()).toBe(true);
    renderer.dispose();
  });

  it('denseHairline defers main render; renderHairline uses line-list draw(2, segments)', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
      [2, 0],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 2).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600, 50_000);

    expect(renderer.isDenseHairline()).toBe(true);

    const mainDraws: Array<{ v: number; i: number }> = [];
    const mainPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((v: number, i: number) => {
        mainDraws.push({ v, i });
      }),
    } as unknown as GPURenderPassEncoder;
    renderer.render(mainPass);
    expect(mainDraws).toEqual([]); // deferred out of MSAA main pass

    const hairDraws: Array<{ v: number; i: number }> = [];
    const hairPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((v: number, i: number) => {
        hairDraws.push({ v, i });
      }),
    } as unknown as GPURenderPassEncoder;
    renderer.renderHairline(hairPass);
    expect(hairDraws).toEqual([{ v: 2, i: 49_999 }]);
    renderer.dispose();
  });

  it('standard render uses AA-quad draw(6, segments) at low N', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device);
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
      [2, 0],
    ];
    const series = makeSeries(data);
    const xScale = createLinearScale().domain(0, 2).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;
    // 3 points from data length (no override) → standard policy
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600);

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

  it('low-N prepare keeps nominal line width in VS uniform', () => {
    const device = createMockDevice();
    const writeUniform = writeUniformBuffer as ReturnType<typeof vi.fn>;
    writeUniform.mockClear();
    const renderer = createLineRenderer(device);
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
      [2, 0],
    ];
    const series = {
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
    const xScale = createLinearScale().domain(0, 2).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(1, -1);
    const dataBuffer = { label: 'data' } as GPUBuffer;

    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 800, 600);

    const vsWrites = writeUniform.mock.calls.filter((c) => {
      const dataArg = c[2];
      return dataArg instanceof ArrayBuffer && dataArg.byteLength === 80;
    });
    const f32 = new Float32Array(vsWrites[vsWrites.length - 1]![2] as ArrayBuffer);
    expect(f32[19]).toBe(2);
    renderer.dispose();
  });
});

describe('line.wgsl hairline gap contract (Issue 1 review)', () => {
  it('vsMainHairline dual-endpoint NaN-checks both segment ends', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../shaders/line.wgsl'), 'utf8');
    const hairStart = src.indexOf('fn vsMainHairline');
    expect(hairStart).toBeGreaterThan(-1);
    const hairBody = src.slice(hairStart, src.indexOf('fn fsMainHairline'));
    // Must read both endpoints and reject if either is NaN (not only points[iid+vid]).
    expect(hairBody).toMatch(/points\[iid\]/);
    expect(hairBody).toMatch(/points\[iid \+ 1u\]/);
    expect(hairBody).toMatch(/pA\.x != pA\.x/);
    expect(hairBody).toMatch(/pB\.x != pB\.x/);
  });
});
