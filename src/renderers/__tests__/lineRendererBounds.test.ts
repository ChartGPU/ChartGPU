/**
 * P2-5: Line prepare must not O(n)-scan series data for bounds.
 * X affine samples near packing origin (epoch-ms safe); Y uses scale(0)/scale(1).
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

import { createLineRenderer } from '../createLineRenderer';

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

  it('samples scale affine only near packing origin / y (0,1) (not per-point)', () => {
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
    const xOffset = 0;

    renderer.prepare(series, dataBuffer, xScale, yScale, xOffset, 2, 1280, 720);

    // X: packing origin + unit probe; Y: (0,1). Four scale() calls total — not O(n).
    expect(xScaleSpy.mock.calls.map((c) => c[0])).toEqual([xOffset, xOffset + 1]);
    expect(yScaleSpy.mock.calls.map((c) => c[0])).toEqual([0, 1]);
    expect(xScaleSpy).toHaveBeenCalledTimes(2);
    expect(yScaleSpy).toHaveBeenCalledTimes(2);

    xScaleSpy.mockRestore();
    yScaleSpy.mockRestore();
    renderer.dispose();
  });

  it('places packed time-axis origin on-screen (no bx+ax*xOffset cancellation)', () => {
    const device = createMockDevice();
    const writeUniform = writeUniformBuffer as ReturnType<typeof vi.fn>;
    writeUniform.mockClear();
    const renderer = createLineRenderer(device);
    const origin = 1_704_067_200_000; // 2024-01-01T00:00:00Z
    const span = 899 * 60_000;
    const data: DataPoint[] = [
      [origin, 0],
      [origin + span, 1],
    ];
    const series = {
      type: 'line',
      data,
      rawData: data,
      color: '#4a9eff',
      lineStyle: { width: 2, opacity: 1, color: '#4a9eff' },
      sampling: 'none',
      samplingThreshold: 5000,
      connectNulls: false,
      yAxis: 'y',
      visible: true,
    } as ResolvedLineSeriesConfig;

    const plotLeft = -0.8676748582230625;
    const plotRight = 0.9546313799621928;
    const xScale = createLinearScale()
      .domain(origin, origin + span)
      .range(plotLeft, plotRight);
    const yScale = createLinearScale().domain(-0.2, 1).range(-0.9, 0.9);
    const dataBuffer = { label: 'data' } as GPUBuffer;

    renderer.prepare(series, dataBuffer, xScale, yScale, origin, 2, 2116, 1079);

    const vsWrites = writeUniform.mock.calls.filter((c) => {
      const dataArg = c[2];
      return dataArg instanceof ArrayBuffer && dataArg.byteLength === 112;
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

  it('structurally does not import bounds scan into prepare path', async () => {
    // Source-level regression: prepare path must stay on packed-origin X affine + y (0,1).
    // X samples near packing origin (epoch-ms safe); never fold bx+ax*xOffset from (0,1).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../createLineRenderer.ts'), 'utf8');
    expect(src).not.toMatch(/computeRawBoundsFromCartesianData/);
    expect(src).toMatch(/computePackedXAffineFromScale\(xScale, xOffset\)/);
    expect(src).toMatch(/computeClipAffineFromContinuousScale\(yScale\)/);
    expect(src).not.toMatch(/bx \+ ax \* xOffset/);
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
      return dataArg instanceof ArrayBuffer && dataArg.byteLength === 112;
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
    const configs = createPipe.mock.calls.map(
      (c) =>
        c[1] as {
          label?: string;
          primitive?: { topology?: string };
          multisample?: { count?: number };
          vertex?: { entryPoint?: string };
        }
    );
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
        return dataArg instanceof ArrayBuffer && dataArg.byteLength === 112;
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
        return dataArg instanceof ArrayBuffer && dataArg.byteLength === 112;
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
      return dataArg instanceof ArrayBuffer && dataArg.byteLength === 112;
    });
    const f32 = new Float32Array(vsWrites[vsWrites.length - 1]![2] as ArrayBuffer);
    expect(f32[19]).toBe(2);
    renderer.dispose();
  });
});

describe('createLineRenderer dense compact LOD (mountain multi-M)', () => {
  const makeXyCols = (n: number): { x: Float64Array; y: Float64Array } => {
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i;
      y[i] = (i % 7) + 1;
    }
    return { x, y };
  };

  it('forceStandardDraw keeps full N−1 (strict lod) — no dense stride compact', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const n = 300_000;
    const cols = makeXyCols(n);
    const series = makeSeries(cols as any);
    const xScale = createLinearScale()
      .domain(0, n - 1)
      .range(-1, 1);
    const yScale = createLinearScale().domain(0, 10).range(1, -1);
    const dataBuffer = { label: 'data', size: n * 8 } as GPUBuffer;

    // forceStandardDraw = true → standard AA, full segments; no compact pack.
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 1400, 800, n, 1, undefined, true, 1400);
    expect(renderer.isDenseHairline()).toBe(false);
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
    expect(draws).toEqual([{ v: 6, i: n - 1 }]);
    renderer.dispose();
  });

  it('refuses compact pack for RingXYColumns (keeps full buffer; no writeBuffer)', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const n = 300_000;
    const cols = makeXyCols(n);
    const ring = {
      __ring: true as const,
      x: cols.x,
      y: cols.y,
      start: 0,
      count: n,
      capacity: n,
    };
    const series = makeSeries(ring as any);
    const xScale = createLinearScale()
      .domain(0, n - 1)
      .range(-1, 1);
    const yScale = createLinearScale().domain(0, 10).range(1, -1);
    const dataBuffer = { label: 'data', size: n * 8 } as GPUBuffer;

    // ringLayout capacity 0 so prepare still attempts compact when data is ring columns.
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 1400, 800, n, 1, { start: 0, capacity: 0 }, false, 1400);
    expect(renderer.isDenseHairline()).toBe(true);
    // Ring/staging refuse: compact path must not pack a private buffer.
    expect(writeBuffer).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('refuses compact pack for StagingRingView', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const n = 300_000;
    const staging = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      staging[i * 2] = i;
      staging[i * 2 + 1] = 1;
    }
    const view = {
      __stagingRing: true as const,
      staging,
      start: 0,
      count: n,
      capacity: 0,
      xOffset: 0,
    };
    const series = makeSeries(view as any);
    const xScale = createLinearScale()
      .domain(0, n - 1)
      .range(-1, 1);
    const yScale = createLinearScale().domain(0, 10).range(1, -1);
    const dataBuffer = { label: 'data', size: n * 8 } as GPUBuffer;

    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 1400, 800, n, 1, undefined, false, 1400);
    expect(renderer.isDenseHairline()).toBe(true);
    expect(writeBuffer).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('re-packs compact LOD after invalidateGeometry under stable data ref', () => {
    const device = createMockDevice();
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const n = 300_000;
    const cols = makeXyCols(n);
    const series = makeSeries(cols as any);
    const xScale = createLinearScale()
      .domain(0, n - 1)
      .range(-1, 1);
    const yScale = createLinearScale().domain(0, 10).range(1, -1);
    const dataBuffer = { label: 'data', size: n * 8 } as GPUBuffer;

    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 1400, 800, n, 1, undefined, false, 1400);
    expect(renderer.isDenseHairline()).toBe(true);
    expect(writeBuffer).toHaveBeenCalledTimes(1);

    // Axes-only / identity-stable: second prepare must not re-pack compact.
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 1400, 800, n, 1, undefined, false, 1400);
    expect(writeBuffer).toHaveBeenCalledTimes(1);

    // In-place mutation (animation contract): invalidate forces re-pack.
    cols.y[0] = 99;
    renderer.invalidateGeometry();
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, 1400, 800, n, 1, undefined, false, 1400);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it('uses plotWidthDevicePx for dense stride budget (not full canvas width alone)', () => {
    const device = createMockDevice();
    const renderer = createLineRenderer(device, { sampleCount: 4 });
    const n = 300_000;
    const cols = makeXyCols(n);
    const series = makeSeries(cols as any);
    const xScale = createLinearScale()
      .domain(0, n - 1)
      .range(-1, 1);
    const yScale = createLinearScale().domain(0, 10).range(1, -1);
    const dataBuffer = { label: 'data', size: n * 8 } as GPUBuffer;

    // Narrow plot width vs wide canvas: budget uses plot width (floor max(2048, plotW)).
    const canvasW = 4000;
    const plotW = 1000;
    renderer.prepare(series, dataBuffer, xScale, yScale, 0, 1, canvasW, 800, n, 1, undefined, false, plotW);
    expect(renderer.isDenseHairline()).toBe(true);

    const hairDraws: number[] = [];
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((_v: number, i: number) => {
        hairDraws.push(i);
      }),
    } as unknown as GPURenderPassEncoder;
    renderer.renderHairline(pass);
    // Budget = max(2048, plotW)=2048 when plotW < min floor; not canvasW=4000.
    expect(hairDraws[0]).toBeLessThanOrEqual(2048 + 64);
    expect(hairDraws[0]).toBeGreaterThan(0);
    expect(hairDraws[0]).toBeLessThan(n - 1);
    // Wider plot alone would still be ≪ full N; verify plot budget wins over canvas.
    const renderer2 = createLineRenderer(device, { sampleCount: 4 });
    renderer2.prepare(series, dataBuffer, xScale, yScale, 0, 1, canvasW, 800, n, 1, undefined, false, 3500);
    const hairDrawsWide: number[] = [];
    const pass2 = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn((_v: number, i: number) => {
        hairDrawsWide.push(i);
      }),
    } as unknown as GPURenderPassEncoder;
    renderer2.renderHairline(pass2);
    expect(hairDrawsWide[0]).toBeGreaterThan(hairDraws[0]!);
    expect(hairDrawsWide[0]).toBeLessThanOrEqual(3500 + 64);
    renderer2.dispose();
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
    // Dense LOD: pointAt(i0)/pointAt(i1) with i0 = iid * stride (stride 1 ≡ iid/iid+1).
    expect(hairBody).toMatch(/pointAt\(i0\)|pointAt\(iid\)|points\[iid\]/);
    expect(hairBody).toMatch(/pointAt\(i1\)|pointAt\(iid \+ 1u\)|points\[iid \+ 1u\]/);
    // Endpoints may be named pA/pB or pA_raw/pB_raw (log-projection path).
    expect(hairBody).toMatch(/pA(_raw)?\.x != pA(_raw)?\.x/);
    expect(hairBody).toMatch(/pB(_raw)?\.x != pB(_raw)?\.x/);
  });
});
